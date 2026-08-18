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

/**
 * THE RING WHEN A RECIPIENT IS IN NO GROUP: the fleet itself, in a stable order. PURE.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Until 2026-08-13 "no group" meant NO ROTATION: `whoseTurn` returned null and both call
 * sites read `if (turn && …)`, so every enabled pair was considered independently. That was
 * written when `Category` being empty was a temporary state. It never stopped being empty —
 * MEASURED on the live database: `Category` 0 rows, `CategorySender` 0, `CategoryTarget` 0,
 * and 0 of 72 targets in a group, from the day the table was created.
 *
 * So the documented behaviour ("a target in NO category behaves exactly as before") was the
 * ONLY behaviour, and its consequence was measured too: 8 recipients holding a draft from
 * more than one sender, 7 of them from all three, the bodies near-identical and carrying the
 * same phone number and email. That is precisely the cross-account fingerprint decision 3b
 * exists to prevent — arriving as the default rather than as anyone's choice.
 *
 * The mechanism was never wrong. `nextSender` starts after whoever wrote last and skips
 * whoever cannot write, which is exactly the intended behaviour; nothing fed it a ring.
 * This is the ring, and it needs no configuration: a recipient in no group is rotated
 * through the fleet, and a recipient in a group keeps using that group.
 *
 * ── THE ORDER ─────────────────────────────────────────────────────────────
 *
 * `cohort` first, then handle. Cohort is the onboarding ladder (Phase 9) and putting it
 * first means the proven baseline accounts sit at the front of the ring while accounts
 * added later join the back — the same staging the ladder already expresses, rather than a
 * second opinion about it. Handle breaks the tie because it is total and stable.
 *
 * A rename reshuffles the fleet ring, and that is harmless by construction: the walk starts
 * from `lastSenderId`, so a reshuffle changes who comes NEXT and can never change how many
 * senders write — which is the property that matters.
 *
 * Every member is `enabled: true`. Since 2026-08-08 there is no per-route switch — a pair
 * row IS a live route — so "may this account write at all right now" is not a property of
 * the ring; it is the caller's `unavailable` map, and it is re-asked at delivery by
 * `gate.ts`.
 */
export function fleetRingOrder(
  senders: readonly { id: string; handle: string; cohort: number }[],
): RingMember[] {
  return senders
    .slice()
    .sort((a, b) => (a.cohort === b.cohort ? a.handle.localeCompare(b.handle) : a.cohort - b.cohort))
    .map((s, i) => ({ senderId: s.id, handle: s.handle, position: i, enabled: true }))
}

/**
 * A stable, PURE index into a ring for a recipient with no send history — FNV-1a over the
 * id, modulo the ring size. Not cryptographic and not meant to be: the property needed is
 * that the same recipient always maps to the same ring position on every host, so the
 * fleet's first touches spread across accounts instead of all electing the ring front.
 */
export function stableIndex(id: string, ringSize: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ringSize <= 0 ? 0 : Math.abs(h) % ringSize
}

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
   * A recipient with history starts AFTER whoever wrote last, as always. A NEVER-MESSAGED
   * recipient used to start at the ring front — which, fleet-wide, elected the SAME
   * account for every fresh recipient: MEASURED 2026-08-18, all 72 waiting drafts
   * belonged to @bollywoodchronicle while five other signed-in accounts held zero, so
   * "hundreds a day" would have been hundreds a day FROM ONE ACCOUNT — the per-account
   * ban pattern wearing rotation's clothes. Fresh recipients now start at a stable hash
   * of the recipient's id, which spreads first touches evenly across the whole fleet
   * while staying deterministic (the same recipient always maps to the same account, so
   * two concurrent planners cannot disagree).
   *
   * `lastSenderId` may also name a sender that has since left the ring — removed
   * mid-cycle, or disabled. `indexOf` then returns -1 and the same hash start applies:
   * with no known predecessor still present, a deterministic spread beats the front.
   */
  const spreadStart = targetId === null ? 0 : stableIndex(targetId, order.length)
  const lastIndex = lastSenderId === null ? -1 : order.findIndex((m) => m.senderId === lastSenderId)
  const start = lastIndex === -1 ? spreadStart : (lastIndex + 1) % order.length

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
