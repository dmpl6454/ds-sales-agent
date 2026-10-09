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
 *   inter-page-gap — a DIFFERENT page delivered within `crossPageGapHours`.
 *                    **THIS IS ZERO — DISABLED — SINCE 2026-08-20**, on Tabish's second
 *                    explicit instruction: *"Remove this 24-hour inter-page gap … 7 day
 *                    constraint only no other limitation."* It shipped at 24 the night
 *                    before and became the binding constraint within hours (23 of 23
 *                    drafts held by it alone, while ring-complete held nobody). The
 *                    mechanism is deliberately KEPT at 0 rather than deleted — the same
 *                    shape as the 0-0 active-hours window — so one number restores it,
 *                    and the tests below still drive it with an explicit non-zero value.
 *                    With it off, all five pages may reach one recipient within minutes;
 *                    the ban-pattern risk was stated and is recorded as his call.
 *
 * WHO COUNTS AS "ALL" — the pages that can write to THIS recipient (M12, rule 45). The
 * eligible set arrives fleet-wide (every page able to send today) and is narrowed HERE,
 * through `fleetMembersFor` — the same filter rotation elects through — to the recipient's
 * own fleet. Until 2026-10-09 it was not narrowed: @madaboutmarketingg sends for
 * `marketing` only, can never deliver to a bollywood recipient, and so "every page has
 * written" was unsatisfiable for every bollywood recipient — the rest never fired on the
 * fleet that sends most. The recipient's handle and the memberships are REQUIRED inputs,
 * not an optional filter defaulting to "everybody", so the compiler names every caller
 * and none can pass the unfiltered fleet by leaving a field out.
 *
 * A sender's OWN delivery never holds via the INTER-PAGE GAP: one page re-messaging its own
 * recipient is governed by NO_NEW_MATERIAL and PAIR_DAILY_CAP (the 2026-08-18 decision),
 * and a self-window there would silently reinstate the 7-day pair cooldown Tabish deleted
 * that day. `tests/cross-account-spacing.test.ts` pins this in the source.
 *
 * ONE EXCEPTION, AND IT IS THE LITERAL READING RATHER THAN A SLIP: a ring of ONE page
 * self-holds for `windowDays` once that page has written. "Contacted by all" with one page
 * able to write is satisfied by that page alone — the n=1 case of `every`. It was
 * unreachable for the bollywood fleet while the marketing page padded every set; with the
 * set narrowed it fires whenever three of the four bollywood pages are signed out, proved
 * dead or paused (the 13 Aug state). Kept because it is the conservative direction and the
 * behaviour the code already had whenever only one page in the WHOLE fleet could send;
 * pinned by a test in
 * `tests/cross-spacing.test.ts` pending Tabish's call — a `ring.length > 1` guard is the
 * one-line way to loosen it if he decides otherwise.
 *
 * ONE implementation, FOUR callers — gate.ts (delivery), plan.ts→governor (drafting),
 * messages-page.ts (the screen's Up next) and rest-tally.ts (the screen's "why resting").
 * A rule fixed on one path and not the others is this codebase's most repeated defect, so
 * the same test discovers every call site.
 */

import { fleetMembersFor, type CategoryMemberships } from './senderCategories'

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
  /**
   * Every fleet page able to send today — machine-independent facts only, NOT yet narrowed
   * to this recipient's fleet (`eligibleFleetSenders`). The narrowing happens below, so no
   * caller can forget it.
   */
  eligibleSenders: readonly { id: string; handle: string }[]
  /** The recipient's handle — which fleet it belongs to decides who counts as "all". */
  targetHandle: string
  /** Who belongs to which fleet (`readCategoryMemberships`). */
  memberships: CategoryMemberships
  /** senderId → that sender's most recent delivery to this recipient (any age). */
  lastDeliveryBySender: Map<string, { sentAt: Date; handle: string }>
}): CrossSpacingVerdict {
  const { now, windowDays, crossPageGapHours, thisSenderId, lastDeliveryBySender } = input
  const windowFloor = now.getTime() - windowDays * MS_PER_DAY

  /* "All our pages" means the pages that can write to THIS recipient — its own fleet. A
     page of the other fleet can never deliver here, so counting it makes the rest
     unreachable (M12). The same filter rotation elects through (rule 45). */
  const ring = fleetMembersFor(input.eligibleSenders, input.targetHandle, input.memberships).map((s) => s.id)

  const inWindow = new Map([...lastDeliveryBySender].filter(([, d]) => d.sentAt.getTime() >= windowFloor))

  // Ring-complete: every page that writes to this recipient has written recently → the
  // 7-day rest. `every`, never `some` — `some` is the deleted rule wearing the new one's
  // name. And never on an empty ring: a vacuous "all" must not fire.
  if (ring.length > 0 && ring.every((id) => inWindow.has(id))) {
    const oldest = Math.min(...ring.map((id) => inWindow.get(id)!.sentAt.getTime()))
    return {
      held: true,
      kind: 'ring-complete',
      senderCount: ring.length,
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
  return `all ${v.senderCount} pages that write to this recipient have written to them in the last week — resting until ${when(v.resumesAt)} IST`
}
