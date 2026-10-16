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

/**
 * The pass's cover-frame shrinks, or null when there is nothing to say — no shrink started, nothing
 * left over (16 Oct 2026, review). `DetectionSummary.frameShrinks` was set on every pass and printed by
 * nothing, so a backfill that left frames unshrunk said so only in the worker's log, which a person
 * running `pnpm ig:backfill --run` does not read. A pass with no over-size frame prints no line: a
 * "0 shrunk" on every routine pass is furniture.
 *
 * `started` counts shrinks STARTED, a failed one included — each failure is its own `frame not saved`
 * log line with the reason, so the line says where to look rather than claiming every one was saved.
 */
export function frameShrinkLine(s: Pick<DetectionSummary, 'frameShrinks'>): string | null {
  const f = s.frameShrinks
  if (!f || (f.started === 0 && f.deferred === 0 && f.coolingOff === 0)) return null
  const parts: string[] = []
  if (f.started > 0) {
    parts.push(
      `A shrink was started for ${f.started} cover frame${f.started === 1 ? '' : 's'} over the size cap (one that failed is logged as "frame not saved", with why).`,
    )
  }
  if (f.deferred > 0) {
    parts.push(
      `${f.deferred} more ${f.deferred === 1 ? 'was' : 'were'} left unshrunk — this pass's ${f.bound} shrinks were spent, on a channel's newest page, which the next pass re-reads and shrinks. ` +
        '`pnpm ig:frames --capture` (it refuses beside a running worker and prints the detached line that stops it — docs/DEPLOY.md) fetches any whose stored URL is still alive sooner.',
    )
  }
  if (f.coolingOff > 0) {
    parts.push(`${f.coolingOff} skipped without a request: their shrink failed in this process within the last 6 hours, and they are retried after that.`)
  }
  return parts.join(' ')
}
