import Link from 'next/link'
import type { DetectionHealth } from './view-model'

/**
 * ── THE COVERAGE CAVEAT, IN ONE PLACE ───────────────────────────────────────
 *
 * "75 paid campaigns spotted" describes TWO of five channels. The other three store posts and
 * judge nothing, so they contribute a silent zero — and left unqualified the figure reads as
 * coverage, which is the most misleading thing this dashboard could imply. It is the same reason
 * a bare "0 paid campaigns" was never allowed on a channel card.
 *
 * So the caveat travels with the number wherever the number goes, which means two pages render
 * it — Today and Paid posts. ONE component, because a caveat that says slightly different things
 * in two places is how one of them ends up wrong.
 *
 * ── GROUPED BY REASON, AND THAT IS NOT COSMETIC ─────────────────────────────
 *
 * The first version listed each channel with its own reason appended, and with all three sharing
 * a reason it rendered:
 *
 *     Not yet judged: Bollywood Chronicle — Posts are recorded but never judged — this channel
 *     has no classifier set up.; Bollywood Society — Posts are recorded but never judged — this
 *     channel has no classifier set up.; Burner — Posts are recorded but never judged — this
 *     channel has no classifier set up..
 *
 * — the same sentence three times, punctuated `.;` and `..`. Found by reading the page.
 *
 * Grouping by REASON rather than collapsing to one sentence is the load-bearing part. CLAUDE.md
 * is explicit that "this channel has no classifier set up" and "the classifier has no API key"
 * are different problems with different fixes and must never render as one sentence. Channels
 * that share a reason are listed together; a channel with a different reason gets its own
 * clause. Nothing is merged that should not be.
 */
export function CoverageNote({
  detection,
  channelCount,
  showLink,
}: {
  detection: DetectionHealth
  channelCount: number
  /** Today links to the detail; Paid posts IS the detail. */
  showLink: boolean
}) {
  if (detection.unclassifiedChannels.length === 0) return null

  // Grouped by reason, insertion-ordered so the list is stable between renders.
  const byReason = new Map<string, string[]>()
  for (const c of detection.unclassifiedChannels) {
    byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), c.name])
  }

  return (
    <p className="coverage">
      Counted from{' '}
      <strong>
        {channelCount - detection.unclassifiedChannels.length} of {channelCount} channels
      </strong>
      .{' '}
      {[...byReason.entries()].map(([reason, names], i) => (
        <span key={reason}>
          {i > 0 ? ' ' : ''}
          Not judged for <strong>{listPhrase(names)}</strong>: {trimTrailingStop(reason)}.
        </span>
      ))}
      {showLink ? (
        <>
          {' '}
          <Link href="/paid-posts">See what detection found</Link>.
        </>
      ) : null}
    </p>
  )
}

/** "a, b and c" — an Oxford-comma-free list, because this renders mid-sentence. */
function listPhrase(names: string[]): string {
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The reason comes from the detector's own `readiness()` and may or may not end in a full stop.
 * Appending one unconditionally produced ".." on the live page; stripping first and adding one is
 * the only version that reads correctly for both shapes — and it changes no word of the reason.
 */
function trimTrailingStop(reason: string): string {
  return reason.replace(/\.\s*$/, '')
}
