/**
 * Cross-page spacing, reshaped 2026-08-19 on Tabish's instruction:
 *
 *   "there is no limit except the 7 day constraint which should occur only if target
 *    has been contacted by all targets or a reply has been detected"
 *
 * The OLD rule (any other page delivered within 7 days → hold every other page) halted
 * the whole fleet the day after the 1-minute pace shipped — MEASURED 2026-08-19: 33 of
 * 33 waiting drafts held, first clear FIVE DAYS out, while 76 recipients had heard from
 * exactly ONE page. One page contacting a recipient locked the other four out for a
 * week, which is the opposite of the rotation's purpose. The NEW rule has two holds:
 *
 *   ring-complete  — hold only when EVERY eligible fleet sender has delivered to this
 *                    recipient within `windowDays`. Releases the moment the OLDEST
 *                    in-window delivery ages out of the window.
 *   inter-page-gap — a DIFFERENT page delivered within `crossPageGapHours` (Setting,
 *                    default 24; 0 disables). Without it the planner would walk the
 *                    whole ring through one inbox in a single afternoon — five
 *                    near-identical templates in five minutes is the recipient-side
 *                    ban pattern (the @absolutejk incident, 2026-08-18). The ban-pattern
 *                    risk of the ring rule itself was stated to Tabish and is recorded
 *                    as his call; this gap is the one mitigation, and it is HIS lever —
 *                    one Setting row to zero.
 *
 * A sender's OWN delivery never holds here: one page re-messaging its own recipient is
 * governed by NO_NEW_MATERIAL and PAIR_DAILY_CAP (the 2026-08-18 decision), and adding
 * a self-window would silently reinstate the 7-day pair cooldown Tabish deleted that
 * day. `tests/cross-account-spacing.test.ts` pins this in the source.
 *
 * ONE implementation, THREE callers — gate.ts (delivery), plan.ts→governor (drafting),
 * messages-page.ts (the screen). A rule fixed on one path and not the others is this
 * codebase's most repeated defect, so the same test greps all three call sites.
 */

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

export type CrossSpacingVerdict =
  | { held: false }
  | { held: true; kind: 'inter-page-gap'; otherHandle: string; hoursAgo: number; resumesAt: Date }
  | { held: true; kind: 'ring-complete'; senderCount: number; resumesAt: Date }

export function crossSpacingVerdict(input: {
  now: Date
  windowDays: number
  crossPageGapHours: number
  thisSenderId: string
  /** Every fleet sender rotation could elect today — machine-independent facts only. */
  eligibleSenderIds: string[]
  /** senderId → that sender's most recent delivery to this recipient (any age). */
  lastDeliveryBySender: Map<string, { sentAt: Date; handle: string }>
}): CrossSpacingVerdict {
  const { now, windowDays, crossPageGapHours, thisSenderId, eligibleSenderIds, lastDeliveryBySender } = input
  const windowFloor = now.getTime() - windowDays * MS_PER_DAY

  const inWindow = new Map([...lastDeliveryBySender].filter(([, d]) => d.sentAt.getTime() >= windowFloor))

  // Ring-complete: every one of our pages has written recently → the 7-day rest.
  // `every`, never `some` — `some` is the deleted rule wearing the new one's name.
  if (eligibleSenderIds.length > 0 && eligibleSenderIds.every((id) => inWindow.has(id))) {
    const oldest = Math.min(...eligibleSenderIds.map((id) => inWindow.get(id)!.sentAt.getTime()))
    return {
      held: true,
      kind: 'ring-complete',
      senderCount: eligibleSenderIds.length,
      resumesAt: new Date(oldest + windowDays * MS_PER_DAY),
    }
  }

  // Inter-page gap: a different page wrote very recently; this page waits its turn.
  if (crossPageGapHours > 0) {
    const gapFloor = now.getTime() - crossPageGapHours * MS_PER_HOUR
    let newest: { sentAt: Date; handle: string } | null = null
    for (const [senderId, d] of inWindow) {
      if (senderId === thisSenderId) continue
      if (d.sentAt.getTime() >= gapFloor && (newest === null || d.sentAt > newest.sentAt)) newest = d
    }
    if (newest !== null) {
      return {
        held: true,
        kind: 'inter-page-gap',
        otherHandle: newest.handle,
        hoursAgo: (now.getTime() - newest.sentAt.getTime()) / MS_PER_HOUR,
        resumesAt: new Date(newest.sentAt.getTime() + crossPageGapHours * MS_PER_HOUR),
      }
    }
  }

  return { held: false }
}

/**
 * The sentence a refusal shows, shared by the gate, the governor and the screen —
 * writer and probe share bytes, so the UI can never claim a hold the enforcers do
 * not enforce.
 */
export function crossSpacingDetail(v: CrossSpacingVerdict): string | null {
  if (!v.held) return null
  const when = (d: Date) =>
    d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  if (v.kind === 'inter-page-gap') {
    const h = Math.max(1, Math.round(v.hoursAgo))
    return `@${v.otherHandle} wrote to this recipient ${h}h ago — the next page's turn comes at ${when(v.resumesAt)} IST`
  }
  return `all ${v.senderCount} of our pages have written to this recipient in the last week — resting until ${when(v.resumesAt)} IST`
}
