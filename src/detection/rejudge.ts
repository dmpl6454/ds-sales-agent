import { prisma } from '@/lib/db'
import { detectionCutoff } from '@/lib/cutoff'
import { judgeWithFrame } from './judge'
import { tagsForStoredPost } from './tagEvidence'
import { getDetector } from './detectors'
import { log } from '@/lib/logger'

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
 * ── WHAT THIS PASS MAY NOT DO ─────────────────────────────────────────────────────────
 *
 * It goes through `judgeWithFrame`, which is the ONE judging path, so every rule still
 * applies: the footage may only raise a caption ORGANIC to REVIEW, it can never mint a
 * CAMPAIGN, and **a human answer is refused before any other branch is reached**
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
}

export async function rejudgeUnusedEvidence(opts: RejudgeOptions = {}): Promise<RejudgeSummary> {
  const cutoff = detectionCutoff()
  const limit = opts.limit ?? REJUDGE_PER_PASS
  const dryRun = opts.dryRun ?? false

  /**
   * `verdict: 'ORGANIC'` in the query, not because this pass decides the rule, but because
   * `applyFrameSignal` can only move an ORGANIC caption and calling the model for anything
   * else is spending money to be told no. `judgeWithFrame` remains the authority and would
   * refuse it anyway; this only avoids asking.
   *
   * `humanLabel: null` for the same reason `judgeWithFrame` checks it — belt and braces on
   * the one thing in this system that must never be overwritten by a model.
   */
  const where = {
    postedAt: { gte: cutoff },
    verdict: 'ORGANIC',
    humanLabel: null,
    signals: { contains: 'frame:call-failed' },
  } as const

  const candidates = await prisma.detectedCampaign.findMany({
    where,
    orderBy: { postedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shortcode: true,
      caption: true,
      verdict: true,
      signals: true,
      taggedAccounts: true,
      rawPayload: true,
      target: { select: { handle: true, optedOut: true, detectorKey: true, displayName: true } },
    },
  })

  let changed = 0
  let skippedNoEvidence = 0
  let skippedCallFailed = 0
  const proposals: RejudgeSummary['proposals'] = []
  for (const p of candidates) {
    const detector = getDetector(p.target.detectorKey)
    const judged = await judgeWithFrame(
      {
        shortcode: p.shortcode,
        caption: p.caption,
        optedOut: p.target.optedOut,
        publisher: { handle: p.target.handle, displayName: p.target.displayName },
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
      { humanLabelled: false },
    )

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
       * TWO COUNTERS, because they have different remedies. `frame:call-failed` coming back
       * means the frame WAS read here and the classifier did not answer — look at the model.
       * Anything else means this host cannot see the frame — run it where the frames are.
       */
      if (judged.signals.includes('frame:call-failed')) skippedCallFailed++
      else skippedNoEvidence++
      continue
    }

    /**
     * The signal is REWRITTEN once the frame really was read. A post left carrying
     * `frame:call-failed` after a successful re-judge would be picked up by every later
     * pass forever — the livelock `resolveBrand`'s module-level latch produced, where one
     * throttled handle held the whole per-pass budget while making no request at all.
     */
    const signals = (p.signals ?? '').replace(/frame:call-failed/g, judged.signals.join(' '))

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
      await prisma.detectedCampaign.update({
        where: { id: p.id },
        data: {
          verdict: judged.verdict,
          signals,
          frameText: judged.frameText ?? undefined,
        },
      })
      if (judged.verdict !== p.verdict) {
        changed++
        log.step('re-judged on evidence that was read but never applied', {
          shortcode: p.shortcode,
          from: p.verdict,
          to: judged.verdict,
        })
      }
    }
  }

  const remaining = await prisma.detectedCampaign.count({ where })
  return { examined: candidates.length, changed, remaining, skippedNoEvidence, skippedCallFailed, proposals }
}
