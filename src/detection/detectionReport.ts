/**
 * detectionReport.ts — the lines `pnpm ig:detect` prints about a pass, PURE, in one place
 * (16 Oct 2026), because `pnpm ig:backfill --run` prints the same summary of the same pass and two
 * copies of one format are two formats the day one of them is edited.
 *
 * Type-only imports: the backfill's dry run imports this module and must not import the pass.
 */
import type { ChannelOutcome, DetectionSummary } from './pipeline'

/** One channel's line, exactly as `ig:detect` has always printed it. */
export function channelSummaryLine(c: ChannelOutcome): string {
  return (
    `  @${c.handle}: ${c.fetched} fetched, ${c.stored} new (${c.campaigns} campaigns), ${c.alreadyKnown} known` +
    /*
     * Only when it happened. A post editing its own tags after publication is rare and
     * worth a word; a "0 refreshed" on every channel every pass is furniture, and this
     * dashboard has a rule about numbers that appear whether or not they mean anything.
     */
    (c.evidenceRefreshed > 0 ? `, ${c.evidenceRefreshed} changed their tags since we stored them` : '') +
    (c.error ? ` — ERROR: ${c.error}` : '')
  )
}

/** The pass's closing line. */
export function passSummaryLine(s: Pick<DetectionSummary, 'postsSeen' | 'newPosts' | 'detected'>): string {
  return `${s.postsSeen} posts seen, ${s.newPosts} new, ${s.detected} campaigns.`
}
