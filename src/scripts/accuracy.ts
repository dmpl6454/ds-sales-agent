/**
 *   pnpm ig:accuracy
 *
 * Measures the classifier against every label this system holds, PER CHANNEL.
 *
 * ── WHAT IT USED TO MEASURE, AND WHY THAT WAS THE PROBLEM ───────────────────
 *
 * It scored ONE channel and ONE source: @madovermarketing_mom's `#Collaboration`
 * disclosures, with `verdictSource: 'rules'` in the query. That is a real held-out test —
 * the publisher discloses, so the verdict is a LABEL rather than an opinion, and the
 * hashtags are stripped before the caption reaches the model.
 *
 * It was also measuring the one channel where the classifier NEVER RUNS. M.O.M's detector
 * is `mom`, a deterministic hashtag rule, and `verdictSource` is `'rules'` on every one of
 * its posts going back to March. Meanwhile @viralbhayani runs the model on every post,
 * supplies most of the paid posts there are, and had nothing to score against at all. So
 * the number was measured where it is not used and used where it is not measured — and
 * human answers, the only possible ground truth for a placement that lives in the footage,
 * were excluded by that same `verdictSource` filter.
 *
 * Now it reads `src/detection/labels.ts`: three sources, provenance on every row, and a
 * block per channel that says **unmeasured** rather than borrowing another channel's number.
 *
 * ── WHAT HAS NOT CHANGED, DELIBERATELY ──────────────────────────────────────
 *
 * The scoring itself, the production ordering (caption alone, then footage, then
 * `applyFrameSignal`), and the definition of `pred`. Those had to stay byte-for-byte
 * comparable with every figure recorded in CLAUDE.md, or this change would silently
 * reset the baseline it exists to protect.
 *
 * RECALL IS THE ONE TO PROTECT. A missed paid post is invisible and unappealable; a false
 * alarm surfaces as a draft a human reads before anything is sent. Never trade recall for
 * precision here, and never on ANY channel — a per-channel report exists so a gain on one
 * cannot hide a loss on another.
 *
 * Costs a few tenths of a cent per run.
 */
import { prisma } from '@/lib/db'
import { modelVerdictToStored, classifyCaption } from '@/detection/detectors/semantic'
import { readFrameText } from '@/detection/ocr'
import { tagsForPrompt } from '@/detection/tagEvidence'
import { applyFrameSignal, type FrameEvidence } from '@/detection/frameSignal'
import { readLabelledSet, LABEL_SOURCES, DISCLOSURE_PATTERN, type LabelRow } from '@/detection/labels'
import type { Verdict } from '@/lib/constants'

/**
 * `--no-frames` measures the CAPTION ALONE, which is what this harness did before the
 * footage was read at all. Keep both numbers when you change either input: the gate is
 * "did adding frame text move recall or precision", and that question needs a before.
 */
const useFrames = !process.argv.includes('--no-frames')

/**
 * `--tags` measures WITH the post's tags and co-authors.
 *
 * OFF BY DEFAULT, because production is off: `tagsAsEvidence` defaults false after this
 * harness measured precision falling 90% to 83% with the input on (recall held at 100%).
 * A harness whose default disagrees with production measures a pipeline that does not
 * exist. Flip both together, or the number stops describing anything.
 */
const useTags = process.argv.includes('--tags')

/**
 * `--include-bulk` scores the 21 labels a script wrote in one second on 8 August.
 *
 * OFF BY DEFAULT and it is the Phase 7 gate, not a preference. Those labels all say "not
 * paid" and two of them are the founding cases of the footage feature. Including them by
 * default would have this harness score the two posts the capability exists to catch as
 * correct misses, and then report that as accuracy. The flag exists so the effect can be
 * SEEN rather than argued about — nothing here ever changes a label.
 */
const includeBulk = process.argv.includes('--include-bulk')

/**
 * ── `--repeat N` — BECAUSE ONE RUN IS ONE SAMPLE ──────────────────────────────────────
 *
 * MEASURED 2026-08-13, three identical runs of this harness against an unchanged corpus,
 * an unchanged prompt and unchanged code:
 *
 *     recall 95%  ·  recall 100%  ·  recall 95%
 *
 * The classifier is not deterministic. One @madovermarketing_mom post sits on the boundary
 * and its verdict flips between runs, and at 22 paid posts a single flip is 4.5% of recall.
 *
 * That matters more than it looks. Every accuracy figure recorded in CLAUDE.md is a SINGLE
 * RUN quoted to the percentage point, and the rule this whole project protects — *revert
 * rather than tune if recall moves off 100%* — would fire on that noise, reverting a change
 * that did nothing. It would also do the opposite: a real regression of one post is
 * indistinguishable from a lucky run.
 *
 * So a single run now says so, and `--repeat N` reports the RANGE and names the posts that
 * are not stable. Those posts are the interesting ones anyway: a caption the classifier
 * cannot decide twice running is the prompt's own uncertainty, made visible.
 */
const repeatArg = process.argv.find((a) => a.startsWith('--repeat'))
const REPEATS = Math.max(1, Number(repeatArg?.split('=')[1] ?? (repeatArg ? process.argv[process.argv.indexOf(repeatArg) + 1] : 1)) || 1)

/** Forgiving reads of the two places tag evidence is stored. See `tagEvidence.ts`. */
function readStoredArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function readStoredCollabs(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const v = (parsed as Record<string, unknown>).collabHandles
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const labelled = await readLabelledSet({ includeBulk })

const posts = labelled.rows.length
  ? await prisma.detectedCampaign.findMany({
      where: { shortcode: { in: labelled.rows.map((r) => r.shortcode) } },
      /**
       * `taggedAccounts` and `rawPayload` come back too, because THE HARNESS MUST RUN THE
       * PRODUCTION PATH. Scoring calls that lack an input the real detector has would
       * measure a pipeline that does not exist.
       */
      select: { caption: true, shortcode: true, taggedAccounts: true, rawPayload: true },
    })
  : []
const postBy = new Map(posts.map((p) => [p.shortcode, p]))

/** Everything scored for one channel. One of these per channel, never merged. */
interface Block {
  channel: string
  tp: number
  tn: number
  fp: number
  fn: number
  skipped: number
  withFrameText: number
  postsWithTags: number
  rescued: number
  extraReview: number
  sources: Map<string, number>
  errors: string[]
  frameMoves: string[]
}

/** shortcode -> the `pred` each run produced, so an unstable post can be named. */
const predsByPost = new Map<string, boolean[]>()

function makeBlocks() {
  return new Map<string, Block>()
}
let blocks = makeBlocks()
function blockFor(channel: string): Block {
  const b = blocks.get(channel)
  if (b) return b
  const fresh: Block = {
    channel,
    tp: 0, tn: 0, fp: 0, fn: 0,
    skipped: 0, withFrameText: 0, postsWithTags: 0, rescued: 0, extraReview: 0,
    sources: new Map(),
    errors: [],
    frameMoves: [],
  }
  blocks.set(channel, fresh)
  return fresh
}

async function scoreOnce(): Promise<Map<string, Block>> {
  blocks = makeBlocks()
  for (const label of labelled.rows) {
  const p = postBy.get(label.shortcode)
  if (!p) continue
  const b = blockFor(label.channel)
  b.sources.set(label.source, (b.sources.get(label.source) ?? 0) + 1)

  /**
   * Strip the disclosure tags so the model cannot simply read the answer.
   *
   * Applied to EVERY post, not only disclosure-labelled ones. A human-labelled post has no
   * disclosure to remove so the strip is a no-op there — and making it conditional would
   * mean two channels' captions reached the model through different preparation, which is
   * the one thing a comparison across channels must not do.
   */
  const blind = p.caption.replace(new RegExp(DISCLOSURE_PATTERN.source, 'gi'), '')

  /**
   * The post's tags, built ONCE and given to BOTH calls — exactly as the detector does.
   * Passing them to only one would let a tag-driven disagreement be scored as a
   * frame-driven one, which is a number this harness reports separately.
   */
  const tagText = useTags
    ? tagsForPrompt(
        {
          taggedAccounts: readStoredArray(p.taggedAccounts),
          collabHandles: readStoredCollabs(p.rawPayload),
          isPaidPartnership: false,
        },
        p.shortcode.slice(0, 6),
      )
    : null
  if (tagText) b.postsWithTags++

  /**
   * THIS HARNESS RUNS THE PRODUCTION PATH, in the production ORDER.
   *
   * Caption first, alone. Then — only if that verdict is ORGANIC or REVIEW — the frame
   * text, then `applyFrameSignal`. Anything else measures a pipeline that does not exist:
   * calling once WITH frame text would let the footage produce a CAMPAIGN, which the real
   * detector forbids, and would report a false-alarm rate for verdicts it cannot reach.
   */
  const captionCall = await classifyCaption(blind, undefined, null, tagText)
  if (!captionCall) { b.skipped++; continue }
  const captionOnly: Verdict = modelVerdictToStored(captionCall.verdict)

  let withFrame: Verdict = captionOnly
  let evidence: FrameEvidence = { kind: 'read', hadText: false }
  if (useFrames && captionOnly === 'ORGANIC') {
    const frame = await readFrameText(p.shortcode)
    evidence = frame.evidence
    if (frame.prompt) {
      b.withFrameText++
      const frameCall = await classifyCaption(blind, undefined, frame.prompt, tagText)
      if (frameCall) withFrame = modelVerdictToStored(frameCall.verdict)
    }
  }

  const final = applyFrameSignal(captionOnly, withFrame, evidence).verdict
  const truth = label.paid

  /**
   * ── `pred` IS NOW SIMPLY "THE PIPELINE SAYS PAID" (2026-08-17) ───────────
   *
   * It used to read `final === 'CAMPAIGN' && captionCall.confidence >= 70`, and a
   * frame-driven move landed in REVIEW, which scored here exactly as ORGANIC — deliberately,
   * because a review request was not a claim that the post was paid.
   *
   * Both halves of that are gone. There is no REVIEW state, the confidence floor no longer
   * downgrades, and the footage now MINTS a CAMPAIGN. So the honest prediction is the
   * verdict the pipeline would actually store, and nothing else.
   *
   * **The headline numbers will move, and that is the harness becoming correct rather than
   * a regression.** Frame-driven escalations now count as positive predictions: they can
   * RAISE recall (a paid post the caption missed is now caught) and LOWER precision (a
   * frame false alarm is now a false alarm rather than a review request). Do not compare a
   * run after this change against a figure recorded in CLAUDE.md before it — they measure
   * different pipelines, which is the exact mistake this file exists to prevent.
   */
  const pred = final === 'CAMPAIGN'
  if (final === 'CAMPAIGN' && captionOnly === 'ORGANIC') {
    if (truth) { b.rescued++; b.frameMoves.push(`RESCUED  ${p.shortcode} :: ${p.caption.replace(/\s+/g,' ').slice(0,70)}`) }
    else { b.extraReview++; b.frameMoves.push(`to review ${p.shortcode} :: ${p.caption.replace(/\s+/g,' ').slice(0,70)}`) }
  }

  predsByPost.set(label.shortcode, [...(predsByPost.get(label.shortcode) ?? []), pred])

  if (truth && pred) b.tp++
  else if (!truth && !pred) b.tn++
  else if (!truth && pred) { b.fp++; b.errors.push(`FP [${captionCall.confidence}%] ${captionCall.reason} :: ${p.caption.replace(/\s+/g,' ').slice(0,90)}`) }
  else { b.fn++; b.errors.push(`FN [${final} ${captionCall.confidence}%] ${captionCall.reason} :: ${p.caption.replace(/\s+/g,' ').slice(0,90)}`) }
  }
  return blocks
}

/** Every run's blocks, so the report can show a RANGE rather than the last sample. */
const runs: Array<Map<string, Block>> = []
for (let i = 0; i < REPEATS; i++) runs.push(await scoreOnce())


// ── the report ─────────────────────────────────────────────────────────────

const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : 'n/a')

/**
 * A figure across every run. One run prints a number; several print a RANGE, because the
 * classifier is not deterministic and a single sample quoted to the point is what let
 * "recall is 100%" be believed when the honest answer was "95-100% over three runs".
 */
function spread(values: number[], fmt: (v: number) => string): string {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}  (${values.length} runs, and it MOVED)`
}

function printBlocks(all: Block[], indent = '  ') {
  const first = all[0]!
  const n = first.tp + first.tn + first.fp + first.fn
  const mix = [...first.sources].map(([s, c]) => `${c} ${s}`).join(', ')
  console.log(`${indent}labels    : ${n}${first.skipped ? ` (+${first.skipped} skipped: the call failed)` : ''}  [${mix}]`)
  if (n === 0) {
    console.log(`${indent}UNMEASURED — no label survived to be scored here.`)
    return
  }
  const pctOf = (f: (b: Block) => [number, number]) =>
    spread(all.map((b) => { const [a, c] = f(b); return c ? (a / c) * 100 : -1 }), (v) => (v < 0 ? 'n/a' : `${Math.round(v)}%`))

  console.log(`${indent}correct   : ${pctOf((b) => [b.tp + b.tn, b.tp + b.tn + b.fp + b.fn])}`)
  console.log(`${indent}caught    : ${pctOf((b) => [b.tp, b.tp + b.fn])} recall  (${first.tp}/${first.tp + first.fn} paid posts on the first run)`)
  console.log(`${indent}precision : ${pctOf((b) => [b.tp, b.tp + b.fp])}`)
  console.log(`${indent}confusion : ${all.map((b) => `TP=${b.tp} TN=${b.tn} FP=${b.fp} FN=${b.fn}`).join('  |  ')}`)
  if (first.rescued || first.extraReview) {
    console.log(`${indent}footage   : ${first.rescued} paid post(s) rescued to review, ${first.extraReview} organic raised — the cost, in attention`)
  }
}

console.log(`\nGround truth = every label this system holds.`)
console.log(`  disclosure  the publisher's own #Collaboration tag (stripped before the model sees it)`)
console.log(`  human       a person answered the review queue. The only ground truth for a paid`)
console.log(`              placement that lives in the footage, and a JUDGEMENT rather than a fact`)
console.log(`  known-paid  the list Tabish supplied, from outside this system`)
console.log(`input: caption${useFrames ? ' first, then cover-frame text where the caption said ordinary' : ' ONLY (--no-frames)'}`)
console.log(
  `tags : ${useTags ? 'ON (--tags)' : 'OFF, as in production (`tagsAsEvidence` is false; pass --tags to measure it on)'}`,
)

/**
 * ── THE POISONED SET, NAMED ON EVERY RUN ────────────────────────────────────
 *
 * Not a footnote. These 21 labels are the reason this harness could not simply be pointed
 * at human answers, and a reader who does not know they exist would read the human-source
 * count below as 24 considered judgements.
 */
if (labelled.bulkGroups.length) {
  console.log(`\n  ${includeBulk ? 'INCLUDED (--include-bulk)' : 'EXCLUDED'}: labels written in bulk, which are not answers about a post`)
  for (const g of labelled.bulkGroups) {
    console.log(`    ${g.count} labels share the byte-identical timestamp ${g.at.toISOString()}`)
  }
  if (!includeBulk) {
    console.log(`    Two of them are the founding cases of reading the footage — the Thane bus`)
    console.log(`    (SWITCH on the bumper) and the Sony game show. Both currently say "not paid".`)
    console.log(`    Settle them on /paid-posts -> "Answers you have given". Nothing here changes them.`)
  }
}

if (labelled.knownPaidNotInCorpus.length) {
  console.log(`\n  ${labelled.knownPaidNotInCorpus.length} known-paid shortcode(s) are NOT in the corpus, so cannot be scored.`)
  console.log(`    Their captions cannot be fetched anonymously; they need a deeper feed backfill.`)
}

// Per channel, and every classifying channel is listed even when it has nothing.
const channels = await prisma.targetAccount.findMany({
  where: { kind: 'CHANNEL' },
  select: { handle: true, detectorKey: true, _count: { select: { campaigns: true } } },
  orderBy: { handle: 'asc' },
})
const storedBy = new Map(channels.map((c) => [c.handle, c._count.campaigns]))

console.log(`\n── per channel ──────────────────────────────────────────────`)
for (const c of channels) {
  const perRun = runs.map((r) => r.get(c.handle)).filter((b): b is Block => b !== undefined)
  const b = perRun[0]
  const stored = storedBy.get(c.handle) ?? 0
  const scored = b ? b.tp + b.tn + b.fp + b.fn : 0
  console.log(`\n@${c.handle}  (detector: ${c.detectorKey})`)
  /**
   * COVERAGE FIRST, BEFORE ANY PERCENTAGE. @viralbhayani has 1,005 stored posts and 4
   * labels; a recall figure printed without that ratio reads as a statement about the
   * channel, and it is a statement about four posts. Same reason the metrics row carries
   * "counted from 1 of 5 channels" — a number that silently describes a fraction of the
   * data is unreadable rather than merely incomplete.
   */
  console.log(`  coverage  : ${scored} of ${stored} stored posts carry a label (${stored ? Math.round((scored / stored) * 100) : 0}%)`)
  if (!b) {
    /**
     * THE POINT OF THE WHOLE PER-CHANNEL REPORT. A channel with no labels is UNMEASURED,
     * and saying so is the difference between an honest gap and a number borrowed from
     * somewhere else. @viralbhayani supplies most of the paid posts this system finds.
     */
    console.log(`  UNMEASURED — no labels exist for this channel, so nothing here is scored.`)
    console.log(`  Its accuracy is not the figure below; it is unknown.`)
    continue
  }
  printBlocks(perRun)
}

// Overall, printed LAST so a per-channel loss cannot be read past on the way to it.
function totalFor(r: Map<string, Block>): Block {
  const t: Block = {
    channel: 'all', tp: 0, tn: 0, fp: 0, fn: 0, skipped: 0, withFrameText: 0, postsWithTags: 0,
    rescued: 0, extraReview: 0, sources: new Map(), errors: [], frameMoves: [],
  }
  for (const b of r.values()) {
    t.tp += b.tp; t.tn += b.tn; t.fp += b.fp; t.fn += b.fn
    t.skipped += b.skipped; t.rescued += b.rescued; t.extraReview += b.extraReview
    for (const [k, c] of b.sources) t.sources.set(k, (t.sources.get(k) ?? 0) + c)
    t.errors.push(...b.errors)
    t.frameMoves.push(...b.frameMoves)
  }
  return t
}
const totals = runs.map(totalFor)
const all = totals[0]!
console.log(`\n── every channel together ───────────────────────────────────`)
printBlocks(totals)

/**
 * ── POSTS THE CLASSIFIER CANNOT DECIDE TWICE RUNNING ─────────────────────────────────
 *
 * Only reachable with `--repeat`. These are the prompt's own uncertainty made visible, and
 * they are the reason a single run's recall must not be quoted to the point: at 22 paid
 * posts one flipping post is 4.5% of recall.
 */
if (REPEATS > 1) {
  const unstable = [...predsByPost].filter(([, preds]) => new Set(preds).size > 1)
  console.log(`\n  stability over ${REPEATS} runs: ${unstable.length} of ${predsByPost.size} posts changed verdict between identical runs`)
  for (const [shortcode, preds] of unstable) {
    console.log(`    ${shortcode}  ${preds.map((p) => (p ? 'paid' : 'not')).join(' -> ')}`)
  }
  if (unstable.length === 0) console.log(`    none — every verdict held across all ${REPEATS} runs`)
}

if (all.frameMoves.length) {
  console.log(`\n  what the FOOTAGE changed (invisible to the four figures above):`)
  for (const m of all.frameMoves) console.log(`    ${m}`)
}
if (all.errors.length) {
  console.log('\n  mistakes:')
  for (const e of all.errors) console.log('   ' + e)
}

/**
 * ── EVERY RUN IS STORED, SO ACCURACY HAS A TREND RATHER THAN A SNAPSHOT (plan 6.7) ────
 *
 * "It feels better" is what this project has repeatedly found to be wrong, and a single
 * figure cannot show whether the loop is working. Two prompt edits are already recorded as
 * having moved the numbers the wrong way — one dropped recall to 87%, one cratered
 * precision 85% to 71% — and both were only visible because someone had a BEFORE.
 *
 * Kept in a `Setting` row rather than a new table, deliberately: this machine cannot deploy
 * a migration to the server, and a schema change applied to a live database from a host
 * that cannot ship the code using it is a split-brain window for no gain. `Setting` already
 * carries `dispatchState` and `devicePresence` — small, append-only, operational state is
 * exactly what it is for.
 *
 * BOUNDED at 30 runs. An unbounded JSON blob in a settings row is a slow leak, and thirty
 * runs is more history than anyone reads while still spanning weeks at this cadence.
 */
const HISTORY_KEY = 'accuracyHistory'
const HISTORY_MAX = 30

interface HistoryEntry {
  at: string
  repeats: number
  frames: boolean
  tags: boolean
  /** Per channel, so a gain on one can never hide a loss on another in the record either. */
  channels: Record<string, { labels: number; correct: number; recall: number; precision: number }>
}

const entry: HistoryEntry = {
  at: new Date().toISOString(),
  repeats: REPEATS,
  frames: useFrames,
  tags: useTags,
  channels: {},
}
for (const c of channels) {
  const perRun = runs.map((r) => r.get(c.handle)).filter((b): b is Block => b !== undefined)
  if (!perRun.length) continue
  const n = perRun.map((b) => b.tp + b.tn + b.fp + b.fn)
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  entry.channels[c.handle] = {
    labels: n[0]!,
    correct: Math.round(mean(perRun.map((b) => ((b.tp + b.tn) / Math.max(1, b.tp + b.tn + b.fp + b.fn)) * 100))),
    recall: Math.round(mean(perRun.map((b) => (b.tp + b.fn ? (b.tp / (b.tp + b.fn)) * 100 : -1)))),
    precision: Math.round(mean(perRun.map((b) => (b.tp + b.fp ? (b.tp / (b.tp + b.fp)) * 100 : -1)))),
  }
}

const prior = await prisma.setting.findUnique({ where: { key: HISTORY_KEY } })
let history: HistoryEntry[] = []
try {
  const parsed: unknown = prior ? JSON.parse(prior.value) : []
  if (Array.isArray(parsed)) history = parsed as HistoryEntry[]
} catch {
  // A corrupt row must not stop the harness reporting. It is a log, not a ledger.
}
history.push(entry)
history = history.slice(-HISTORY_MAX)
await prisma.setting.upsert({
  where: { key: HISTORY_KEY },
  update: { value: JSON.stringify(history) },
  create: { key: HISTORY_KEY, value: JSON.stringify(history) },
})

if (history.length > 1) {
  console.log(`\n── recall over the last ${Math.min(history.length, 8)} runs ───────────────────`)
  const recent = history.slice(-8)
  const names = [...new Set(recent.flatMap((h) => Object.keys(h.channels)))]
  for (const name of names) {
    const series = recent.map((h) => {
      const v = h.channels[name]
      return v ? (v.recall < 0 ? ' n/a' : `${String(v.recall).padStart(3)}%`) : '   -'
    })
    console.log(`  @${name.padEnd(24)} ${series.join(' ')}`)
  }
  console.log(`  (oldest on the left. A single run is a sample - see --repeat.)`)
}

/**
 * WHAT THIS NUMBER STILL DOES NOT MEAN, said here so it cannot be quoted without it.
 *
 * Most of these labels are #Collaboration disclosures — CAPTION-derived. So this mostly
 * measures caption classification, and whether adding frame text HARMS it. A post whose
 * label came from its caption cannot be evidence about a post whose caption says nothing.
 * The only labels that CAN speak to the video-only class are human answers, and there are
 * very few of them.
 */
console.log(`\nThis measures CAPTION classification, and whether frame text harms it.`)
console.log(`Recall on placements that live only in the footage can only come from human`)
console.log(`answers on flagged posts, and there are ${all.sources.get(LABEL_SOURCES.HUMAN) ?? 0} of those in scope.`)
console.log(`Never quote any figure above as coverage.`)

await prisma.$disconnect()

export type { LabelRow }
