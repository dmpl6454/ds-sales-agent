/**
 *   pnpm ig:ocr                       read every saved frame and show its text. FREE.
 *   pnpm ig:ocr --shortcode DbtNU9UzWYU        one post, with its caption verdict
 *   pnpm ig:ocr --reclassify          re-judge posts whose frame has text. SPENDS.
 *   pnpm ig:ocr --reclassify --limit 20        a bounded first pass
 *   pnpm ig:ocr --channel viralbhayani
 *
 * Reads the text off cover frames already on disk and, on request, re-runs the classifier
 * with that text included. This is the answer to CLAUDE.md's "THE CAPTION IS NOT THE
 * POST": `DbtNU9UzWYU` is a paid placement whose evidence was entirely in the footage,
 * and the decisive part of that footage was TEXT — a title card and "SWITCH" on a bumper.
 *
 * ── THE DEFAULT DOES REAL WORK, BECAUSE OCR IS FREE ─────────────────────────
 *
 * Every other dry run here reports what it WOULD do. This one actually reads the frames
 * and prints what they say, because Apple's Vision framework runs locally and costs
 * nothing — there is no reason to withhold the finding. What it does not do without
 * `--reclassify` is spend money re-judging captions, and it reports that cost first.
 *
 * ── AND OCR IS NOT A VERDICT ────────────────────────────────────────────────
 *
 * Reading text off a frame decides nothing. `--reclassify` hands the text to the SAME
 * measured classifier that reads captions, and `applyFrameSignal` bounds what the result
 * may do: a post the caption called ordinary can be raised to REVIEW for a person to
 * settle, and nothing else. A frame may never mint a CAMPAIGN nor clear one.
 */
import { prisma } from '@/lib/db'
import { detectionCutoff } from '@/lib/cutoff'
import { readStringArray, writeStringArray } from '@/lib/json'
import { getDetector } from '@/detection/detectors'
import { framePathFor } from '@/detection/media'
import { readImageText, describeFrameText, frameTextForPrompt } from '@/detection/ocr'
import { judgeWithFrame } from '@/detection/judge'
import { tagsForStoredPost } from '@/detection/tagEvidence'
import { classifyCaption, semanticReadiness } from '@/detection/detectors/semantic'
import { ocrEngineCommand } from '@/lib/platform'
import type { Verdict } from '@/lib/constants'

const argv = process.argv.slice(2)
const reclassify = argv.includes('--reclassify')
const limitArg = argv.indexOf('--limit')
const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : Infinity
const channelArg = argv.indexOf('--channel')
const channel = channelArg >= 0 ? argv[channelArg + 1] : null
const scArg = argv.indexOf('--shortcode')
const onlyShortcode = scArg >= 0 ? argv[scArg + 1] : null

const engine = ocrEngineCommand()
if (engine.engine === 'none') {
  console.log(`\nNo OCR engine available: ${engine.reason}`)
  process.exit(1)
}
console.log(`\nOCR engine: ${engine.engine} (local, offline, no API cost)`)

const targets = await prisma.targetAccount.findMany({ where: { kind: 'CHANNEL' } })
const byId = new Map(targets.map((t) => [t.id, t]))
const semanticIds = new Set(targets.filter((t) => getDetector(t.detectorKey).key === 'semantic').map((t) => t.id))
/**
 * RETIRED channels. Their frames are still saved and still READ for free — our own pages
 * are ground truth and reading them costs nothing — but a classifier CALL for a channel
 * we will never message is spend with no outcome attached. MEASURED: 64% of OCR runs were
 * against exactly these.
 */
const optedOutTargets = new Set(targets.filter((t) => t.optedOut).map((t) => t.id))
/** Whose post each row is — a publisher's own watermark is not evidence about it. */
const publisherById = new Map(targets.map((t) => [t.id, { handle: t.handle, displayName: t.displayName }]))

const rows = await prisma.detectedCampaign.findMany({
  where: {
    ...(onlyShortcode ? { shortcode: onlyShortcode } : { postedAt: { gte: detectionCutoff() } }),
    ...(channel ? { targetId: targets.find((t) => t.handle === channel)?.id ?? 'no-such-channel' } : {}),
  },
  orderBy: { postedAt: 'desc' },
})

interface Candidate {
  id: string
  shortcode: string
  caption: string
  verdict: string
  targetId: string
  signals: string[]
  prompt: string
  summary: string
  /** The post's tags, fenced exactly as the live pipeline fences them. */
  tagText: string | null
}

let noFrame = 0
let noText = 0
let failed = 0
const candidates: Candidate[] = []

for (const row of rows) {
  const path = framePathFor(row.shortcode)
  if (!path) {
    noFrame += 1
    continue
  }
  const outcome = await readImageText(path)
  if (outcome.kind === 'no-frame') {
    noFrame += 1
    continue
  }
  if (outcome.kind === 'failed' || outcome.kind === 'unavailable') {
    failed += 1
    continue
  }
  const text = describeFrameText(outcome)
  const prompt = frameTextForPrompt(text)
  if (!prompt || !text) {
    noText += 1
    continue
  }
  const parts: string[] = []
  if (text.overlay.length > 0) parts.push(`on screen: ${text.overlay.join(' | ')}`)
  if (text.smaller.length > 0) parts.push(`in shot: ${text.smaller.join(' | ')}`)
  candidates.push({
    id: row.id,
    shortcode: row.shortcode,
    caption: row.caption,
    verdict: row.verdict,
    targetId: row.targetId,
    signals: readStringArray(row.signals),
    prompt,
    summary: parts.join(' — '),
    tagText: await tagsForStoredPost(row),
  })
}

console.log(
  `${rows.length} posts examined: ${candidates.length} frames carry readable text, ` +
    `${noText} carry none, ${noFrame} have no frame saved, ${failed} could not be read.`,
)
if (noFrame > 0) {
  console.log(`Frames are saved at detection time; older posts never had one. They cannot be recovered once the CDN URL expires.`)
}

// ── The free part: show what the footage says ────────────────────────────────
const shown = candidates.slice(0, onlyShortcode ? 1 : 25)
console.log(`\nWhat the footage says (newest ${shown.length}):`)
for (const c of shown) {
  console.log(`\n  ${c.shortcode}  @${byId.get(c.targetId)?.handle}  caption verdict: ${c.verdict}`)
  console.log(`    ${c.summary}`)
}

/**
 * Only posts the caption called ORDINARY can be changed by their footage, so only those
 * are worth spending a call on. A caption CAMPAIGN is already found; `applyFrameSignal`
 * would refuse to move it either way.
 */
const worthJudging = candidates.filter(
  (c) => semanticIds.has(c.targetId) && (c.verdict === 'ORGANIC' || c.verdict === 'REVIEW'),
)

const ready = semanticReadiness()
if (!reclassify) {
  console.log(
    `\n${worthJudging.length} of them were called ordinary by their caption alone — those are the ones` +
      `\nwhose footage could change the answer. \`--reclassify\` re-judges them with the frame text` +
      `\nincluded, at roughly $0.00005 each (about $${(worthJudging.length * 0.00005).toFixed(4)} for all of them).`,
  )
  if (!ready.ready) console.log(`\nNote: ${ready.reason}`)
  process.exit(0)
}

if (!ready.ready) {
  console.log(`\nCannot reclassify: ${ready.reason}`)
  process.exit(1)
}

// ── The paid part: hand the frame's text to the measured classifier ──────────
let judged = 0
let flagged = 0
let agreed = 0
let failedCalls = 0
/** Deliberately not judged (retired target, unsupported detector, decisive caption). */
let skipped = 0

for (const c of worthJudging) {
  if (judged >= limit) break

  /**
   * The stored verdict IS the caption-only answer for every post in the corpus — it was
   * produced before frame text existed. So the backfill needs no second call to know
   * whether the footage changed the answer, which is the whole reason a pass over stored
   * posts is affordable at all.
   *
   * THE SEQUENCE ITSELF LIVES IN `judge.ts`, not here. This script used to own a private
   * copy of it — read the frame, call the model, compose with `applyFrameSignal` — while
   * `pipeline.ts` had no frame handling whatsoever and `classify.ts` had none either. That
   * is how 166 frames were saved in one day and never read. One implementation, three
   * callers, and `tests/one-judging-path.test.ts` asserts it rather than trusting a
   * comment: a comment claiming exactly this was already present and untrue in
   * `readThread.ts`.
   */
  const framed = await judgeWithFrame(
    {
      shortcode: c.shortcode,
      caption: c.caption,
      optedOut: optedOutTargets.has(c.targetId),
      publisher: publisherById.get(c.targetId) ?? { handle: '', displayName: null },
      // 'passthrough' for anything non-semantic ON PURPOSE: this command re-reads
      // FRAMES, and giving it 'mom' would spend a semantic call per rule-negative —
      // that is `pnpm ig:second-look`'s job, bounded and dry-run by default.
      detectorKey: semanticIds.has(c.targetId) ? 'semantic' : 'passthrough',
      // The same tags the pipeline would have given this post. Without them a re-judge
      // here would see less than the live path does and could disagree with it for a
      // reason that has nothing to do with the footage it is testing.
      tagText: c.tagText,
    },
    c.verdict as Verdict,
  )

  if (framed.reason !== 'judged') {
    // Retired target, unsupported detector, or a caption a frame cannot move. Not a
    // failure — a decision not to spend, and it is reported rather than silently skipped.
    skipped += 1
    continue
  }
  if (framed.signals.includes('frame:call-failed')) {
    failedCalls += 1
    continue
  }
  judged += 1

  if (framed.changedByFrame) {
    flagged += 1
    console.log(`\n  FLAGGED  ${c.shortcode} (@${byId.get(c.targetId)?.handle})  ${c.verdict} -> ${framed.verdict}`)
    console.log(`    footage: ${framed.frameSummary ?? c.summary}`)
  } else {
    agreed += 1
  }

  await prisma.detectedCampaign.update({
    where: { id: c.id },
    data: {
      verdict: framed.verdict,
      signals: writeStringArray([...c.signals, ...framed.signals]),
      frameText: (framed.frameText ?? c.summary).slice(0, 400),
    },
  })
}

console.log(
  `\nRe-judged ${judged} with their footage included: ${flagged} newly flagged for your review, ` +
    `${agreed} unchanged, ${failedCalls} calls failed (left exactly as they were).`,
)
if (skipped > 0) {
  // Named rather than silently absent: "no silent caps" — a number that quietly excludes
  // work reads as "everything was covered" when it was not.
  console.log(`${skipped} were deliberately not judged (retired channel, or a caption a frame cannot move).`)
}
if (flagged > 0) console.log(`Flagged posts are on /paid-posts as "borderline — worth a look", with the footage quoted.`)
process.exit(0)
