import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import { getSettings } from '@/lib/settings'
import { detectionCutoff } from '@/lib/cutoff'
import { judgeWithFrame } from './judge'
import { tagsForStoredPost } from './tagEvidence'
import { getDetector } from './detectors'
import { hasFrame } from './media'
import { FRAME_NOT_SAVED_SIGNAL } from './frameSignal'
import { log } from '@/lib/logger'
import { readStringArray, writeStringArray } from '@/lib/json'

/**
 * ── EVIDENCE THAT WAS READ AND NEVER REACHED A VERDICT ────────────────────────────────
 *
 * This is the same shape of bug as the 166 cover frames saved in a day and never read, one
 * step further along: the frame WAS read, the words WERE extracted, and then the classifier
 * call that would have folded them into the verdict failed. `applyFrameSignal` never ran, so
 * the post kept its caption-only answer and the footage evidence sat in the database.
 *
 * That is correct at the time — *a failed call is never recorded as a verdict* is one of the
 * oldest rules here — and it is wrong forever after, because nothing ever tries again.
 *
 * MEASURED on the live database, in-window posts by frame signal:
 *
 *     frame:read-agreed                 698
 *     frame:no-text                     216
 *     frame:not-needed-caption-decided  100
 *     frame:call-failed                  65   <- this pass
 *     frame:flagged-for-review           22
 *     frame:disagreed-lower               6
 *
 * Note what the measurement corrected: the obvious query — *frame text stored but no
 * `frame:` signal* — returns **0**, and so does *judged with no usable frame but a frame on
 * disk now*. Both were the wrong question. The population that exists is the one where the
 * CALL failed, and it is only visible if you count the signals rather than guess at them.
 *
 * ── AND A FRAME THAT ARRIVED AFTER THE POST WAS JUDGED (16 Oct 2026) ─────────────────
 *
 * The second population. A post judged with no frame on this host carries `frame:not-saved`
 * (`applyFrameSignal`, frameSignal.ts), and until now nothing ever looked at it again — correct
 * while a missing frame stayed missing. MEASURED IN PRODUCTION it stopped staying missing: with the
 * anonymous feed walled, every post arrived through the official API with a FULL-SIZE frame that
 * `saveFrame` refused (`bytes=1052612 / 748357 / 591056 …`), so the backfill stored post after post
 * judged on its caption alone. `saveFrame` now shrinks such a file, and the frame reaches disk
 * later — on the next pass that re-observes the post (pipeline.ts's known-post loop re-banks it) or
 * when a person runs `pnpm ig:frames --capture`. This pass is what then reads it — if the post is among
 * the newest `RECOVERY_SCAN_PER_PASS` such rows; an older one is read by `pnpm ig:rejudge --run`.
 *
 * Selected only where the frame IS ON THIS HOST NOW (`hasFrame`), because the frame store is per
 * machine — the paragraph on the guard below. A host without the frame never even offers the row
 * to the judge, so it can neither write a local absence nor spend a slot of the bound on it.
 *
 * ── WHAT THIS PASS MAY NOT DO ─────────────────────────────────────────────────────────
 *
 * It goes through `judgeWithFrame`, which is the ONE judging path, so every rule still
 * applies: the footage may only raise a caption ORGANIC to CAMPAIGN (to REVIEW until 17 Aug
 * 2026, when that state was removed), it can never clear or overturn one, and **a human answer is
 * refused before any other branch is reached**
 * (`opts.humanLabelled`). Re-judging a person's answer would destroy the only labels that
 * can ever measure recall on video-only placements.
 *
 * BOUNDED PER PASS, and the bound counts ATTEMPTS rather than changes — a pass that
 * re-judges ten posts and moves none spends exactly as much as one that moves ten. Same
 * reasoning as `autoResolveBrands`, whose bound counts lookups rather than brands.
 *
 * It NEVER fails a detection run. Decision 5 one layer along: a monitoring subsystem must
 * not be able to silence the thing it monitors, and a late re-judge is recoverable where a
 * post scrolling out of the feed window is not.
 */

/**
 * How many posts one pass may re-judge.
 *
 * At 96 passes a day this drains a 65-post backlog in under two hours and then finds
 * nothing, which is the intended steady state. Small because the work is a model call per
 * post and the backlog is a puddle, not a lake — a bound that empties it in one pass would
 * be a burst against the same endpoint detection depends on.
 */
export const REJUDGE_PER_PASS = 10

/**
 * How many `frame:not-saved` rows one pass may LOOK AT (a stat() each) to find those whose frame
 * is now on disk. Separate from the judging bound because the cost is different by orders of
 * magnitude — a stat is microseconds, a judgement is a model call — and because much of that
 * population can never be recovered: a carousel's official read carries no frame at all, and an
 * expired CDN URL is gone. The database cost is the same `contains` scan whatever this is (LIKE
 * cannot use an index); this bounds only the rows returned and the stats.
 *
 * Newest first, so a frame the pipeline re-banked on a recent pass — the official read re-observes
 * a post for hours after it is posted — is always inside the window. A recovered row loses the
 * mark, so the window does not fill with work already done.
 *
 * WHAT THE WINDOW DOES NOT REACH, STATED (review, 16 Oct 2026). The cutoff is a FIXED date
 * (lib/cutoff.ts, 1 Aug 2026), not a rolling window, and the unrecoverable rows — every carousel
 * (no frame URL at all), every post whose URL expired — keep the mark for good and are among the
 * newest. So the window can be full of them, and an OLDER post whose frame a person fetched with
 * `pnpm ig:frames --capture` may sit beyond it and never be reached by a pass. That post is reached
 * only by `pnpm ig:rejudge --run`, which scans the whole population and, through
 * `recoverableNotReached` and `recoveryScanComplete`, says how many it left behind. NOT MEASURED: how
 * fast that remainder grows on the box.
 */
export const RECOVERY_SCAN_PER_PASS = 1000

export interface RejudgeSummary {
  /** Posts this pass looked at. Bounded by `REJUDGE_PER_PASS`. */
  examined: number
  /** Posts whose verdict actually moved. Expected to be a small fraction. */
  changed: number
  /** Still carrying a failed frame call after this pass — the backlog. */
  remaining: number
  /**
   * Looked at, but the frame could not be READ on this machine, so the row was left alone.
   * A high number here on a host means its frame store is not the one that holds them —
   * which is information, not a failure, and it must not read as "nothing to do".
   */
  skippedNoEvidence: number
  /**
   * ── WHY THIS IS SEPARATE FROM `skippedNoEvidence` (2026-08-17) ────────────
   *
   * Both counters mean "left alone", and collapsing them cost a real diagnosis. The pass
   * was logging `noFrameHere=10 remaining=83` on the very host that HELD all 83 frames —
   * a number naming a cause ("the frames are elsewhere") that was false, while the actual
   * cause was that the classifier was never asked. Twenty minutes went into checking the
   * OCR engine, the frame directory and the API key, all of which were fine.
   *
   * That is `framesRead` collapsing five states into one, reappearing in the counter built
   * to avoid it. A skip because THIS MACHINE cannot see the frame and a skip because the
   * CALL did not answer have different remedies — move hosts, versus look at the model —
   * so they are two numbers.
   */
  skippedCallFailed: number
  /**
   * ── A RECOVERED ROW'S SKIP IS ITS OWN NUMBER (review, 16 Oct 2026) ─────────────────────────
   *
   * A row of the second population is selected BECAUSE `hasFrame` proved its frame is on this host.
   * When its re-judge then reads nothing — the OCR run died, the classifier did not answer — counting
   * it in `skippedNoEvidence` printed "the frame is not on THIS machine" (and `noFrameHere=` in the
   * pass's log) about a frame that is on this machine: the 17 Aug lesson above, one population over.
   * Counted here instead, and said as what it is: the frame is on disk here, the reading or the
   * classifier produced no verdict, and the row — left exactly as it was — is offered again next pass.
   */
  skippedFrameHereNoVerdict: number
  /**
   * ── A PERSON ANSWERED WHILE THIS PASS WAS JUDGING (review, 16 Oct 2026) ────────────────────
   *
   * The selection excludes a labelled row, but the judge takes seconds to minutes (an OCR read and
   * one or two model calls), and a person can label the post on /paid-posts in between. The write is
   * therefore conditional IN THE STATEMENT (`humanLabel: null` in the update's `where`); a row it no
   * longer matches is counted here and nothing is written — a human answer is never overwritten.
   */
  skippedHumanAnswered: number
  /**
   * ── `count: 0` IS NOT ALWAYS A PERSON (review, 16 Oct 2026) ─────────────────────────────────
   *
   * The conditional write matches nothing in two other cases, and calling them "a person answered this
   * post" would be a counter asserting a cause that is false. So on `count: 0` the row is read again,
   * once: a label on it → `skippedHumanAnswered`; the row gone (the post deleted — a channel removed,
   * its campaigns cascading — while it was being judged) → this; neither → `skippedWriteUnmatched`.
   */
  skippedRowRemoved: number
  /**
   * The write matched nothing, and on re-reading the row exists with no label — e.g. a label given and
   * withdrawn inside the judgement. Nothing was written; the row is offered again by the next pass.
   */
  skippedWriteUnmatched: number
  /**
   * Of `examined`, how many were posts judged with no frame whose frame is on this host now —
   * the second population (16 Oct 2026). The rest of `examined` are failed calls.
   */
  recoveredFrames: number
  /**
   * Posts judged with no frame whose frame IS on this host now, that this pass did NOT reach — the
   * bound stopped it. Counted over the scanned window only; `recoveryScanComplete` says whether that
   * window was the whole population. A person draining on purpose re-runs until this reads 0.
   */
  recoverableNotReached: number
  /**
   * True when the scan saw every `frame:not-saved` row in the window — fewer rows than the scan bound.
   * False means older rows exist beyond it, and `recoverableNotReached` is a floor.
   */
  recoveryScanComplete: boolean
  /** Dry-run detail: what each examined post WOULD become. Empty on a writing pass. */
  proposals: { shortcode: string; from: string; to: string; signals: string[]; frameText: string | null }[]
}

export interface RejudgeOptions {
  /**
   * Override `REJUDGE_PER_PASS`. The small bound exists so a DETECTION pass stays cheap;
   * a person draining a backlog on purpose is a different act, exactly as `ig:brands --run`
   * is a different act from the bounded automatic resolve pass.
   */
  limit?: number
  /** Decide and report, write nothing. The default for the CLI, never for the pipeline. */
  dryRun?: boolean
  /** Override `RECOVERY_SCAN_PER_PASS`, for the same reason `limit` is overridable. */
  recoveryScan?: number
}

/**
 * Every mark meaning "the frame did not reach a verdict here". Once a re-judge has READ the frame,
 * each is superseded by what the reading said — rewrite, never append, the same rule as
 * `STALE_FRAME_MARKS` in scripts/ocr.ts. A row left carrying one would be re-selected forever.
 */
const RETRYABLE_FRAME_MARKS = new Set(['frame:call-failed', 'frame:ocr-failed', FRAME_NOT_SAVED_SIGNAL])

/**
 * PURE: a stored signals cell with its retryable frame marks replaced by what the re-judge read.
 *
 * Parsed and written as the JSON array it is. The first version substituted the joined signals
 * into the STRING (`replace(/frame:(?:call|ocr)-failed/g, signals.join(' '))`), which left one
 * array element reading `"frame:read-agreed frame:engine-rapidocr"` — invisible to every reader
 * that matches a signal exactly. A cell that does not parse as an array keeps that old string
 * substitution rather than being emptied: losing a post's caption signals to a format surprise is
 * worse than a cosmetic join.
 */
export function rewriteFrameSignals(stored: string | null, judged: readonly string[]): string {
  const raw = stored ?? ''
  let isArray = false
  try {
    isArray = Array.isArray(JSON.parse(raw))
  } catch {
    isArray = false
  }
  if (!isArray) return raw.replace(/frame:(?:call-failed|ocr-failed|not-saved)/g, judged.join(' '))
  return writeStringArray([...readStringArray(raw).filter((sig) => !RETRYABLE_FRAME_MARKS.has(sig)), ...judged])
}

/**
 * The first population: the frame was read here or elsewhere, and nothing reached a verdict.
 *
 * `verdict: 'ORGANIC'` in the query, not because this pass decides the rule, but because
 * `applyFrameSignal` can only move an ORGANIC caption and calling the model for anything
 * else is spending money to be told no. `judgeWithFrame` remains the authority and would
 * refuse it anyway; this only avoids asking.
 *
 * `humanLabel: null` for the same reason `judgeWithFrame` checks it — belt and braces on
 * the one thing in this system that must never be overwritten by a model.
 */
function failedCallWhere(cutoff: Date) {
  return {
    postedAt: { gte: cutoff },
    verdict: 'ORGANIC',
    humanLabel: null,
    // Both are "the evidence exists and nothing reached a verdict": the classifier did not
    // answer, or (8 Sept 2026) the OCR run itself died under load. Neither is a fact about the
    // post, so both are retried; `frame:no-ocr-engine` is NOT, because a host with no engine
    // would re-record it every pass forever.
    OR: [{ signals: { contains: 'frame:call-failed' } }, { signals: { contains: 'frame:ocr-failed' } }],
  } satisfies Prisma.DetectedCampaignWhereInput
}

/**
 * THE SECOND POPULATION: judged with no frame here, and the frame is here now.
 *
 * The same guards as the first — ORGANIC (the only verdict a frame may move), no human label —
 * plus a channel we would still judge (a retired one gets no classifier call from
 * `judgeWithFrame`, so offering it would spend a slot every pass forever). MUTATION GUARD, applied
 * once and seen red in tests/frame-recovery.test.ts: dropping `humanLabel: null` here.
 */
function recoveryWhere(cutoff: Date) {
  return {
    postedAt: { gte: cutoff },
    verdict: 'ORGANIC',
    humanLabel: null,
    signals: { contains: FRAME_NOT_SAVED_SIGNAL },
    target: { optedOut: false },
  } satisfies Prisma.DetectedCampaignWhereInput
}

/**
 * The disk check over a bounded, newest-first window: one stat() per row (microseconds — every row
 * is checked, so the count of what was left behind is true), and only rows whose frame IS on this
 * host are returned. MUTATION GUARD, applied once and seen red in tests/frame-recovery.test.ts:
 * dropping the `hasFrame` filter.
 */
async function scanRecoverable(cutoff: Date, take: number): Promise<{ idsWithFrameHere: string[]; complete: boolean }> {
  const scanned = await prisma.detectedCampaign.findMany({
    where: recoveryWhere(cutoff),
    orderBy: { postedAt: 'desc' },
    take,
    select: { id: true, shortcode: true },
  })
  const idsWithFrameHere: string[] = []
  for (const row of scanned) if (await hasFrame(row.shortcode)) idsWithFrameHere.push(row.id)
  return { idsWithFrameHere, complete: scanned.length < take }
}

export interface RejudgeBacklog {
  /** Rows carrying `frame:call-failed` or `frame:ocr-failed` — what `remaining` counts. */
  failedCalls: number
  /** Rows judged with no frame whose frame is on THIS host now. */
  recoverableHere: number
  /** Whether the scan saw the whole `frame:not-saved` population (see `recoveryScanComplete`). */
  scanComplete: boolean
}

/**
 * What a re-judge would have to do, counted WITHOUT judging anything — no OCR child, no model call.
 * The same queries and the same disk check as the pass, so the numbers cannot disagree with it. For
 * `pnpm ig:rejudge` to say what is waiting while it refuses to judge beside a running worker.
 */
export async function rejudgeBacklog(opts: { recoveryScan?: number } = {}): Promise<RejudgeBacklog> {
  const cutoff = detectionCutoff()
  const scan = await scanRecoverable(cutoff, opts.recoveryScan ?? RECOVERY_SCAN_PER_PASS)
  return {
    failedCalls: await prisma.detectedCampaign.count({ where: failedCallWhere(cutoff) }),
    recoverableHere: scan.idsWithFrameHere.length,
    scanComplete: scan.complete,
  }
}

export async function rejudgeUnusedEvidence(opts: RejudgeOptions = {}): Promise<RejudgeSummary> {
  const cutoff = detectionCutoff()
  const limit = opts.limit ?? REJUDGE_PER_PASS
  const dryRun = opts.dryRun ?? false
  const recoveryScan = opts.recoveryScan ?? RECOVERY_SCAN_PER_PASS

  const where = failedCallWhere(cutoff)

  const select = {
    id: true,
    shortcode: true,
    caption: true,
    verdict: true,
    signals: true,
    postedAt: true,
    humanLabel: true,
    taggedAccounts: true,
    rawPayload: true,
    target: { select: { handle: true, optedOut: true, detectorKey: true, displayName: true } },
  } satisfies Prisma.DetectedCampaignSelect

  const failedCalls = await prisma.detectedCampaign.findMany({ where, orderBy: { postedAt: 'desc' }, take: limit, select })

  // The second population (see `recoveryWhere`): only rows whose frame is on this host are loaded and
  // offered to the judge, and at most `limit` of them — the rest are counted, not judged.
  const scan = await scanRecoverable(cutoff, recoveryScan)
  const withFrameHere = scan.idsWithFrameHere.slice(0, limit)
  const recoverable =
    withFrameHere.length > 0
      ? await prisma.detectedCampaign.findMany({ where: { ...recoveryWhere(cutoff), id: { in: withFrameHere } }, select })
      : []
  const recoverableIds = new Set(recoverable.map((r) => r.id))

  /**
   * ONE BOUND OVER BOTH, newest first. Neither population can starve the other for long: a stuck
   * failed call ages behind newer posts of either kind, and both shrink as they are answered.
   */
  const candidates = [...failedCalls, ...recoverable.filter((r) => !failedCalls.some((f) => f.id === r.id))]
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .slice(0, limit)

  let changed = 0
  let recoveredFrames = 0
  let skippedNoEvidence = 0
  let skippedCallFailed = 0
  let skippedFrameHereNoVerdict = 0
  let skippedHumanAnswered = 0
  let skippedRowRemoved = 0
  let skippedWriteUnmatched = 0
  const proposals: RejudgeSummary['proposals'] = []
  for (const p of candidates) {
    const detector = getDetector(p.target.detectorKey)
    const judged = await judgeWithFrame(
      {
        shortcode: p.shortcode,
        caption: p.caption,
        optedOut: p.target.optedOut,
        publisher: { handle: p.target.handle, displayName: p.target.displayName },
        publisherAsContext: (await getSettings()).publisherAsContext,
        /**
         * judge.ts owns what each detector's verdicts permit, keyed on the detector —
         * but READINESS is still asked of the detector itself ("no API key" must skip
         * cleanly rather than burn a failed call per pass), which is the shortcut
         * CLAUDE.md records rendering "Paid campaigns found: 0" for a whole channel.
         * A not-ready detector is passed as 'passthrough': unsupported, skipped, free.
         */
        detectorKey: (detector.readiness?.() ?? { ready: true }).ready ? detector.key : 'passthrough',
        tagText: await tagsForStoredPost({
          shortcode: p.shortcode,
          taggedAccounts: p.taggedAccounts,
          rawPayload: p.rawPayload,
        }),
      },
      p.verdict as 'ORGANIC',
      // Belt and braces: the query already excludes a labelled row; this would refuse one anyway.
      { humanLabelled: p.humanLabel !== null },
    )
    if (recoverableIds.has(p.id)) recoveredFrames++

    /**
     * ── THE FRAME STORE IS PER MACHINE, AND THIS PASS WRITES TO A SHARED DATABASE ──────
     *
     * FOUND BY RUNNING IT, and it is the `profileStatus` trap in a new place. Frames live
     * on the host that detected the post — CLAUDE.md measures the Mac holding 446 and the
     * server 1,057 — and the re-judge pass ran from the Mac against the SERVER's database.
     * `readFrameText` correctly reported "no frame saved" about posts whose frames sit on
     * the server, and the first version of this loop wrote that answer down: **4 posts
     * moved from `frame:call-failed` to `frame:not-saved`**, recording a fact about this
     * laptop as a fact about the post, and retiring them from the retry queue for good.
     *
     * So a re-judge may only ever record what it actually READ. Anything else — the frame
     * is not on this machine, no OCR engine here, the call failed again — leaves the row
     * exactly as it was, and the pass on the host that HAS the frame picks it up.
     *
     * The general rule is the one already in CLAUDE.md: a database shared between hosts
     * plus per-host filesystem state is not one system, and any writer that mixes them
     * writes a different answer depending on where it ran.
     */
    const readTheFrame = judged.signals.some((sig) => sig === 'frame:read-agreed' || sig.startsWith('frame:says-') || sig === 'frame:no-text' || sig.startsWith('frame:disagreed-'))
    if (!readTheFrame) {
      /**
       * THREE COUNTERS, because they have different remedies. A RECOVERED row was selected because
       * its frame is on this disk, so whatever came back it is never "not on this machine" — see
       * `skippedFrameHereNoVerdict`. MUTATION (applied once, seen red, restored): dropping this first
       * branch fails tests/frame-recovery.test.ts "a recovered row that reads nothing is counted as
       * frame-here-no-verdict…". Otherwise `frame:call-failed` coming back means the frame WAS read
       * here and the classifier did not answer — look at the model; anything else means this host
       * cannot see the frame — run it where the frames are.
       */
      if (recoverableIds.has(p.id)) skippedFrameHereNoVerdict++
      else if (judged.signals.includes('frame:call-failed') || judged.signals.includes('frame:ocr-failed')) skippedCallFailed++
      else skippedNoEvidence++
      continue
    }

    /**
     * The signal is REWRITTEN once the frame really was read. A post left carrying
     * `frame:call-failed` after a successful re-judge would be picked up by every later
     * pass forever — the livelock `resolveBrand`'s module-level latch produced, where one
     * throttled handle held the whole per-pass budget while making no request at all.
     */
    const signals = rewriteFrameSignals(p.signals, judged.signals)

    /**
     * The dry run DECIDES exactly as the writing pass does — same `judgeWithFrame`, same
     * guards — and only the write is withheld. A preview computed by a different route is
     * a preview of something else, which is how `ig:classify` once reported "27 reach the
     * model" and then classified zero.
     */
    if (dryRun) {
      proposals.push({
        shortcode: p.shortcode,
        from: p.verdict,
        to: judged.verdict,
        signals: judged.signals,
        frameText: judged.frameText ?? null,
      })
      if (judged.verdict !== p.verdict) changed++
      continue
    }

    if (judged.verdict !== p.verdict || signals !== p.signals) {
      /**
       * CONDITIONAL IN THE STATEMENT, not checked first (rule 50): a person may have labelled this
       * post on /paid-posts while it was being judged, and a read-then-write would overwrite their
       * answer. `count: 0` usually means exactly that — skipped and counted, never an error — and the row
       * is read once more to say which it was (below). MUTATION (applied
       * once, seen red, restored): `update({ where: { id: p.id } … })` again fails
       * tests/frame-recovery.test.ts "a person who labels the post while it is being judged keeps
       * their answer".
       */
      const written = await prisma.detectedCampaign.updateMany({
        where: { id: p.id, humanLabel: null },
        data: {
          verdict: judged.verdict,
          signals,
          frameText: judged.frameText ?? undefined,
        },
      })
      if (written.count === 0) {
        /**
         * WHICH of the three it was, read once (see `skippedRowRemoved`). MUTATION (applied once, seen
         * red, restored): counting every `count: 0` as `skippedHumanAnswered` again fails
         * tests/frame-recovery.test.ts "a post deleted while it is being judged…".
         */
        const now = await prisma.detectedCampaign.findUnique({ where: { id: p.id }, select: { humanLabel: true } })
        if (!now) {
          skippedRowRemoved++
          log.step('re-judge not written — the post was removed while it was being judged', { shortcode: p.shortcode })
        } else if (now.humanLabel !== null) {
          skippedHumanAnswered++
          log.step('re-judge not written — a person answered this post while it was being judged', { shortcode: p.shortcode })
        } else {
          skippedWriteUnmatched++
          log.step('re-judge not written — the write matched no row, and the post now reads unlabelled; offered again next pass', { shortcode: p.shortcode })
        }
        continue
      }
      if (judged.verdict !== p.verdict) {
        changed++
        log.step(recoverableIds.has(p.id) ? 're-judged with a frame that arrived after the post was judged' : 're-judged on evidence that was read but never applied', {
          shortcode: p.shortcode,
          from: p.verdict,
          to: judged.verdict,
        })
      }
    }
  }

  const remaining = await prisma.detectedCampaign.count({ where })
  return {
    examined: candidates.length,
    changed,
    remaining,
    skippedNoEvidence,
    skippedCallFailed,
    skippedFrameHereNoVerdict,
    skippedHumanAnswered,
    skippedRowRemoved,
    skippedWriteUnmatched,
    recoveredFrames,
    recoverableNotReached: scan.idsWithFrameHere.length - recoveredFrames,
    recoveryScanComplete: scan.complete,
    proposals,
  }
}

/** What a failed re-judge pass reports: nothing examined, nothing skipped. */
export function emptyRejudgeSummary(): RejudgeSummary {
  return {
    examined: 0,
    changed: 0,
    remaining: 0,
    skippedNoEvidence: 0,
    skippedCallFailed: 0,
    skippedFrameHereNoVerdict: 0,
    skippedHumanAnswered: 0,
    skippedRowRemoved: 0,
    skippedWriteUnmatched: 0,
    recoveredFrames: 0,
    recoverableNotReached: 0,
    recoveryScanComplete: true,
    proposals: [],
  }
}

/**
 * PURE: the detection pass's `re-judged evidence read earlier` log fields. Here rather than inline in
 * pipeline.ts so the NAMES are tested — a key that names a reason must be true about that reason.
 *
 * TWO SKIP NUMBERS BECAME FOUR, and each says what it is. `noFrameHere` used to print for BOTH skip
 * reasons, and on 2026-08-17 it read `noFrameHere=10 remaining=83` on the very host holding all 83
 * frames — a counter asserting a cause that was false, which sent a diagnosis through the OCR engine,
 * the frames directory and the API key before the real cause (the classifier was never asked) turned
 * up. And (16 Oct 2026) a recovered row — selected because its frame IS here — is never `noFrameHere`:
 * it is `frameHereNoVerdict`, retried next pass.
 */
export function rejudgeLogFields(r: RejudgeSummary): Record<string, number> {
  return {
    examined: r.examined,
    changed: r.changed,
    // "examined 10, changed 0" on a host with no frame store is a different fact from the same
    // numbers on the host that has them — so each reason a row was left alone is named.
    noFrameHere: r.skippedNoEvidence,
    callDidNotAnswer: r.skippedCallFailed,
    // Selected because the frame is on this disk; the reading or the classifier gave no verdict.
    frameHereNoVerdict: r.skippedFrameHereNoVerdict,
    // A person labelled the post while it was being judged; their answer stands, nothing written.
    personAnsweredMeanwhile: r.skippedHumanAnswered,
    // The post was deleted while it was being judged; nothing written (never "a person answered").
    postRemovedMeanwhile: r.skippedRowRemoved,
    // The conditional write matched nothing and the row now reads unlabelled; offered again next pass.
    writeMatchedNothing: r.skippedWriteUnmatched,
    // Of `examined`: posts judged with no frame whose frame has since reached this host's disk
    // (shrunk from an official-read file, or fetched by `ig:frames --capture`) — 16 Oct 2026.
    frameArrivedLater: r.recoveredFrames,
    // Frames on this host for posts the bound did not reach this pass — they wait for the next one.
    // Counted over the pass's newest-1,000 window only (RECOVERY_SCAN_PER_PASS); older ones are
    // reached by `pnpm ig:rejudge --run`.
    framesWaiting: r.recoverableNotReached,
    remaining: r.remaining,
  }
}
