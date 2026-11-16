import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import { getSettings } from '@/lib/settings'
import { detectionCutoff } from '@/lib/cutoff'
import { postUrl } from '@/lib/urls'
import { readStringArray, writeStringArray } from '@/lib/json'
import { log } from '@/lib/logger'
import { judgeWithFrame } from './judge'
import { tagsForStoredPost } from './tagEvidence'
import { publisherForPrompt } from './publisherContext'
import { parseRawPayload } from './evidence'
import { semanticDetector, setChannelVocabulary } from './detectors/semantic'

/**
 * ── POSTS A CLASSIFIER OUTAGE LEFT UNJUDGED ARE JUDGED ON THE CLOCK (16 Nov 2026) ─────────────
 *
 * MEASURED on the live database, 16 Nov: DeepSeek refused every call with `HTTP 402` (the account
 * was out of credit) on 8-10 Nov and from 13 Nov 12:30 to 16 Nov 17:31 — 6,929 failed calls in 48 h.
 * Detection kept storing posts the whole time, and every one it could not judge was stored as
 * `UNCLASSIFIED` / `verdictSource: 'none'`, which is right: *a failed call is never recorded as a
 * verdict.* Then nothing ever asked again.
 *
 *     09 Nov 461 unjudged   10 Nov 516   13 Nov 487   14 Nov 646   15 Nov 521   16 Nov 423
 *
 * The pipeline judges a post once, on first sighting; `rejudgeUnusedEvidence` retries a failed
 * FRAME call (`frame:call-failed`), never a failed CAPTION call; and the only thing that selects
 * `verdictSource: 'none'` is `pnpm ig:classify --run`, which a person must type on the server. So
 * when the credit came back the ~3,000 posts of those days stayed unjudged for good — and a paid post
 * is the only thing that gives a page something new to say to a company it has already written to.
 * CLAUDE.md rule 60, one subsystem along: *a cleanup that only runs when someone types a command is
 * not running.*
 *
 * This pass is that command on the detection clock. It runs at the end of every PRIMARY detection
 * pass (pipeline.ts — never on a Mac's failover pass, whose frames and key are not the server's),
 * after the frame re-judge, and:
 *
 *   - takes at most `UNJUDGED_PER_PASS` posts, NEWEST FIRST, because the newest are the ones still
 *     inside the window a paid post funds a message in;
 *   - judges each exactly as the pipeline judges a fresh post: the SAME detector `classify` for the
 *     caption (too-short rule, brand merge, signals, cost booked under the shortcode), Instagram's own
 *     paid flag from the stored payload, then the ONE `judgeWithFrame` for the footage;
 *   - STOPS at the first post the classifier does not answer. An outage that is still going costs one
 *     failed call a pass, not thirty; and the post stays exactly as it was, to be asked next pass;
 *   - writes CONDITIONALLY IN THE STATEMENT (rule 50): only while the row is still unlabelled and
 *     still unjudged, so a person's answer on /paid-posts, or the pipeline re-judging the same post
 *     from a complete read, is never overwritten by this pass;
 *   - never fails a detection run (decision 5): the caller catches.
 *
 * Only semantic channels: a `passthrough` channel is unjudged BY DESIGN (it has no classifier), and
 * `mom` is a rule set that always answers.
 */

/**
 * How many unjudged posts one pass may judge. Each is one caption call, and for an ordinary caption
 * whose frame carries text one OCR read and one more call — a few seconds on the one-vCPU box. At 96
 * passes a day this clears ~2,900 posts a day, so the 16 Nov backlog drains in about a day, newest
 * first, and a pass stays a couple of minutes long rather than a burst against the endpoint
 * detection itself depends on.
 */
export const UNJUDGED_PER_PASS = 30

/** The signal every row this pass judged carries, so the work is countable afterwards. */
export const UNJUDGED_PASS_SIGNAL = 'backfill:unjudged-pass'

/** In-window posts on a classifying channel that nothing has judged, and no person has answered. */
export function unjudgedWhere(cutoff: Date) {
  return {
    postedAt: { gte: cutoff },
    verdictSource: 'none',
    humanLabel: null,
    target: { detectorKey: semanticDetector.key },
  } satisfies Prisma.DetectedCampaignWhereInput
}

export interface UnjudgedSummary {
  /** Posts offered to the classifier this pass (including the one that stopped it, if any). */
  examined: number
  /** Posts that now carry a verdict. */
  judged: number
  /** Of `judged`, how many are paid. */
  campaigns: number
  /**
   * Why the pass stopped before its bound, if it did. `classifier-did-not-answer`: the first post it
   * did not answer was left unjudged and the pass stopped (an outage still in progress costs one call
   * a pass). `classifier-not-configured`: no key on this host, so nothing was asked at all.
   */
  stoppedBecause: 'classifier-did-not-answer' | 'classifier-not-configured' | null
  /**
   * Judged, but not written because the row changed underneath: a person labelled it, the pipeline
   * judged it meanwhile, or it was deleted. Nothing is overwritten; there is nothing to retry.
   */
  skippedChangedMeanwhile: number
  /** Still unjudged after this pass — the backlog. */
  remaining: number
}

export function emptyUnjudgedSummary(): UnjudgedSummary {
  return { examined: 0, judged: 0, campaigns: 0, stoppedBecause: null, skippedChangedMeanwhile: 0, remaining: 0 }
}

/** Case- and prefix-insensitive dedupe, first spelling kept — the same rule the pipeline applies. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const k = v.toLowerCase().replace(/^[@#]/, '')
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

export async function judgeUnjudgedPosts(opts: { limit?: number } = {}): Promise<UnjudgedSummary> {
  const limit = opts.limit ?? UNJUDGED_PER_PASS
  const cutoff = detectionCutoff()
  const where = unjudgedWhere(cutoff)
  const summary = emptyUnjudgedSummary()

  const ready = semanticDetector.readiness?.() ?? { ready: true }
  if (!ready.ready) {
    summary.stoppedBecause = 'classifier-not-configured'
    summary.remaining = await prisma.detectedCampaign.count({ where })
    return summary
  }

  const rows = await prisma.detectedCampaign.findMany({
    where,
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      shortcode: true,
      caption: true,
      postedAt: true,
      brands: true,
      taggedAccounts: true,
      rawPayload: true,
      target: { select: { handle: true, displayName: true, optedOut: true } },
    },
  })

  if (rows.length > 0) {
    const settings = await getSettings()
    /**
     * The semantic detector keeps one channel's hashtag history in module state for its novelty
     * SCORE (no longer a veto). The pipeline clears it after each channel; it is cleared here too,
     * so a post can never be scored against another channel's vocabulary. Scores are signals only.
     */
    setChannelVocabulary(null)

    for (const row of rows) {
      summary.examined++
      const payload = parseRawPayload(row.rawPayload)
      const tagText = await tagsForStoredPost(row)
      const publisherText = settings.publisherAsContext
        ? publisherForPrompt(row.caption, { handle: row.target.handle, displayName: row.target.displayName })
        : null

      /**
       * The caption, through the DETECTOR — not `classifyCaption` called here — so this pass cannot
       * judge a stored post by a different rule than the pipeline judged a fresh one: the too-short
       * verdict, the brand merge and the signals all come from the one place they live.
       */
      const cls = await semanticDetector.classify(
        {
          shortcode: row.shortcode,
          permalink: postUrl(row.shortcode),
          ownerHandle: row.target.handle,
          caption: row.caption,
          likeCount: null,
          commentCount: null,
          postedAt: row.postedAt,
          gridIndex: 0,
          taggedAccounts: readStringArray(row.taggedAccounts),
          collabHandles: payload.collabHandles,
          ...(payload.isPaidPartnership !== null ? { isPaidPartnership: payload.isPaidPartnership } : {}),
        },
        { tagText, publisherText },
      )

      if (cls.verdictSource === 'none') {
        // The classifier did not answer. Leave the row exactly as it was and stop: the rest would
        // fail the same way, and the next pass asks again.
        summary.stoppedBecause = 'classifier-did-not-answer'
        break
      }

      // Instagram's own Paid Partnership label is a fact, as in the pipeline.
      const officiallyPaid = payload.isPaidPartnership === true
      const captionVerdict = officiallyPaid ? 'CAMPAIGN' : cls.verdict
      const judged = await judgeWithFrame(
        {
          shortcode: row.shortcode,
          caption: row.caption,
          optedOut: row.target.optedOut,
          publisher: { handle: row.target.handle, displayName: row.target.displayName },
          publisherAsContext: settings.publisherAsContext,
          detectorKey: semanticDetector.key,
          tagText,
          publisherText,
        },
        captionVerdict,
      )

      const signals = [
        ...cls.signals,
        ...(officiallyPaid ? ['official:is_paid_partnership'] : []),
        ...judged.signals,
        UNJUDGED_PASS_SIGNAL,
      ]
      // What the row already holds (the post's own @sponsor / @collab handles and caption hashtag
      // brands, written when it was stored) plus what the caption call named — the pipeline's merge.
      const brands = dedupe([...readStringArray(row.brands), ...cls.brands])

      const written = await prisma.detectedCampaign.updateMany({
        where: { id: row.id, humanLabel: null, verdictSource: 'none' },
        data: {
          verdict: judged.verdict,
          confidence: officiallyPaid ? 100 : cls.confidence,
          verdictSource: officiallyPaid ? 'rules' : cls.verdictSource,
          classifierModel: cls.classifierModel ?? null,
          classifierReason: cls.classifierReason ?? null,
          brands: writeStringArray(brands),
          signals: writeStringArray(signals),
          ...(judged.frameText ? { frameText: judged.frameText } : {}),
        },
      })
      if (written.count === 0) {
        summary.skippedChangedMeanwhile++
        log.step('an unjudged post changed while it was being judged — nothing written', { shortcode: row.shortcode })
        continue
      }
      summary.judged++
      if (judged.verdict === 'CAMPAIGN') summary.campaigns++
    }
  }

  summary.remaining = await prisma.detectedCampaign.count({ where })
  return summary
}

/** Log fields for the pipeline's line, each named for what it counts. */
export function unjudgedLogFields(s: UnjudgedSummary): Record<string, number | string> {
  return {
    examined: s.examined,
    judged: s.judged,
    paid: s.campaigns,
    changedMeanwhile: s.skippedChangedMeanwhile,
    stopped: s.stoppedBecause ?? 'no',
    remaining: s.remaining,
  }
}
