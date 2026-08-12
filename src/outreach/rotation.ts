/**
 * Whose turn is it to write to this recipient?
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Senders and targets belong to CATEGORIES. Per target, each successive paid post is
 * pitched by the NEXT sender in that category's ring. Never the same sender twice in a
 * row. Wraps forever.
 *
 * ── DERIVED, NEVER STORED ─────────────────────────────────────────────────
 *
 * The ring position comes from `OutreachAttempt` history — *who sent the most recent
 * message to this target, and who comes after them in the category order* — and NOT from
 * a cursor column.
 *
 * A cursor is a second source of truth. It can be advanced by a send that then failed, or
 * missed by a send that succeeded, and once it disagrees with the history nothing
 * reconciles them: rotation would insist it is @a's turn while the recipient's inbox
 * plainly shows @a wrote last. This codebase has been bitten by precisely that shape —
 * `repliedAt` was read in six places and written in none, so its guard had never once
 * fired and looked healthy the whole time. Derived state cannot disagree with reality,
 * because it is reality read back.
 *
 * The cost is a query per target per slot. That is the correct thing to spend.
 *
 * ── PURE ──────────────────────────────────────────────────────────────────
 *
 * Every rule here is a function of its arguments: no database, no clock, no env. The
 * plan named seven cases that must be covered — a sender added mid-cycle, removed
 * mid-cycle, CHALLENGED, not logged in, the sender that is also the target, two
 * concurrent slots, and a failed send — and none of them are testable if this reaches
 * for the world. `governor.ts` and `gate.ts` are pure for the same reason.
 */

export interface RingMember {
  senderId: string
  handle: string
  /** The ring order. Stable across renames, unlike ordering by handle. */
  position: number
  /** Membership switched off — suspended, not removed. Skipped, but the past is intact. */
  enabled: boolean
}

export interface RotationInput {
  /** Every sender in the category, in any order — this function sorts them. */
  ring: readonly RingMember[]
  /**
   * The sender of the most recent DELIVERED message to this target, or null when nobody
   * has written yet. Derived from send history; never a stored cursor.
   */
  lastSenderId: string | null
  /**
   * Senders that cannot send right now, with a reason. CHALLENGED, not logged in,
   * paused, out of daily allowance, already used in this run — the caller decides what
   * belongs here, this decides whose turn it is among those that remain.
   */
  unavailable?: ReadonlyMap<string, string>
  /** The recipient, so a sender that is also this target is never chosen. */
  targetId?: string | null
}

export type RotationChoice =
  | { ok: true; senderId: string; handle: string; position: number }
  | { ok: false; reason: 'empty-ring' | 'all-unavailable'; detail: string }

/** Enabled members in ring order. Ties on `position` break on handle, so it is total. */
export function ringOrder(ring: readonly RingMember[]): RingMember[] {
  return ring
    .filter((m) => m.enabled)
    .slice()
    .sort((a, b) => (a.position === b.position ? a.handle.localeCompare(b.handle) : a.position - b.position))
}

/**
 * The next sender for this target.
 *
 * The ring is walked starting AFTER whoever wrote last, so the first available sender in
 * that order wins. Skipping an unavailable sender does NOT hold its place: the next
 * eligible one goes, and when the skipped account comes back it simply rejoins at its
 * position. Holding a place would mean a single CHALLENGED account stalls a whole
 * category, which is a worse failure than a slightly uneven distribution.
 *
 * Returns a REFUSAL rather than falling back to "anyone", because "we could not work out
 * whose turn it is" and "it is @a's turn" are different answers and only one of them
 * should send a message.
 */
export function nextSender(input: RotationInput): RotationChoice {
  const { lastSenderId, unavailable = new Map(), targetId = null } = input
  const order = ringOrder(input.ring)

  if (order.length === 0) {
    return { ok: false, reason: 'empty-ring', detail: 'no enabled senders in this category' }
  }

  /**
   * Where to start walking.
   *
   * `lastSenderId` may name a sender that has since left the ring — removed mid-cycle,
   * or disabled. `indexOf` then returns -1 and the walk starts at 0, which is the right
   * answer: with no known predecessor still present, the front of the ring is as fair a
   * starting point as any, and it is deterministic.
   */
  const lastIndex = lastSenderId === null ? -1 : order.findIndex((m) => m.senderId === lastSenderId)
  const start = lastIndex === -1 ? 0 : (lastIndex + 1) % order.length

  const blocked: string[] = []
  for (let step = 0; step < order.length; step++) {
    const member = order[(start + step) % order.length]!

    /**
     * An account never messages itself. `@bollywoodchronicle` and `@bollywoodsocietyy`
     * are both senders AND rehearsal targets, deliberately kept that way so the send
     * path can be exercised without touching a prospect — so this is a live case, not a
     * theoretical one.
     */
    if (targetId !== null && member.senderId === targetId) {
      blocked.push(`${member.handle}: is the recipient`)
      continue
    }

    const why = unavailable.get(member.senderId)
    if (why !== undefined) {
      blocked.push(`${member.handle}: ${why}`)
      continue
    }

    return { ok: true, senderId: member.senderId, handle: member.handle, position: member.position }
  }

  return {
    ok: false,
    reason: 'all-unavailable',
    detail: `every sender in this category is unavailable — ${blocked.join('; ')}`,
  }
}

/**
 * Would this choice repeat the previous sender?
 *
 * Separate from `nextSender` on purpose. `nextSender` starts after the last sender so it
 * cannot normally repeat — but with a ring of ONE it must, and the caller has to be able
 * to tell "the rotation worked" from "there is only one account, so this recipient hears
 * from the same page every time". The second is a business fact worth surfacing, not a
 * bug to hide.
 */
export function repeatsPreviousSender(choice: RotationChoice, lastSenderId: string | null): boolean {
  return choice.ok && lastSenderId !== null && choice.senderId === lastSenderId
}
