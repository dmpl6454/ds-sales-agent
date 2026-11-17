/**
 * Whose turn is it to write to this recipient?
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Senders and targets belong to CATEGORIES. Per target, each successive paid post is
 * pitched by the NEXT sender in that category's ring. Never the same sender twice in a
 * row. Wraps forever.
 *
 * Except (17 Nov 2026): when the next sender has already written to them and has nothing new
 * to say, and every page that wrote has had its conversation read since, the turn passes to a
 * page in the ring that has never written to them. See `TurnPass`.
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
  /**
   * The facts the turn PASS reads (17 Nov 2026) — see `TurnPass`. Absent means no pass: the
   * walk behaves exactly as it always has. A caller that does not know whether there is
   * anything new to say must leave it out rather than guess.
   */
  pass?: TurnPass
}

/**
 * ── A PAGE WITH NOTHING NEW TO SAY HANDS THE TURN TO A PAGE THAT NEVER WROTE (17 Nov 2026) ──
 *
 * Asked, measured and decided the same morning. MEASURED on the live database, 17 Nov 07:12
 * IST: nothing had been delivered for 14.6 days, all 1,566 live recipients had been messaged at
 * least once, no recipient was resting, and the planner wrote NOTHING — 5,408 routes skipped
 * `no-new-material-to-reference` and 585 `not-this-senders-turn`. The walk starts after
 * whoever wrote last, so it elected a page that had ALREADY written to the recipient; that page
 * may only send a FOLLOW-UP, a follow-up needs a new paid post naming them, and none existed.
 * Meanwhile another page in the same ring had never written to them at all and could send the
 * standard introduction — which needs no new post (`isFollowUp` is false for it) — but the turn
 * only advances on a DELIVERY, so it never reached that page. 73 introductions were waiting
 * behind pages with nothing to say (@bollywoodpaparazzii 40, @totalfilmii 28,
 * @bollywoodsocietyy 5).
 *
 * Sudhanshu chose "build it, switched on" on 17 Nov, with the risk below put to them first:
 * CLAUDE.md had recorded this as Tabish's decision, so it is recorded as Sudhanshu's, and
 * Tabish can switch it off with one Setting row (`passTurnWhenNothingNew` = false). It is the
 * content of Tabish's ring rule of 20 August ("the 7 day constraint … only if target has been
 * contacted by all [our pages] or a reply has been detected") and of Tabish's 4 September
 * instruction to hand the turn "to the next page whose route is clear".
 *
 * THE EXPOSURE, STATED: a company that heard from one of our pages and did not answer will hear
 * the same standard introduction from a second page, then (after each 7-day allowance window)
 * a third — byte-identical copy from a different page name. It is bounded by everything that
 * already bounds a message: one per paid post per 7 days (`materialAllowance`, recipient-wide,
 * so a pass can never send two in one window), the ring rule, the reply halt, verified-only, no
 * people, the pair cap, the pace.
 *
 * THE RULE, in the order `nextSender` applies it after the ordinary walk has elected page E:
 *   1. The recipient ever replied to any page        → E. Every page's message is a follow-up
 *      then (`isFollowUp`), so no page has an introduction to offer, and an introduction to
 *      someone already talking to us is the H5 mistake. DATED OR NOT: `everReplied` counts
 *      `repliedAt` as well as `replyPostedAt`, stricter than `isFollowUp`, on purpose.
 *   2. E never delivered to them                     → E. E's message is already a first touch.
 *      This is the ORDINARY walk, untouched: if another never-wrote page already holds an
 *      introduction to them, E still drafts its own (`hasPendingAttempt` is per pair). That
 *      shape predates the pass, `tests/planner-golden.test.ts` pins it (`pending_draft`,
 *      `midsend`), and a recipient-level pending check is its own decision (17 Oct entry in
 *      CLAUDE.md). A review proposed checking the pin first; doing so changed the golden, so it
 *      was not shipped here.
 *   3. E holds a waiting draft for them              → E. Its message is in the queue.
 *   4. A page that never delivered to them holds an introduction that is still OUT — a waiting
 *      draft, or one parked `not-in-thread` (the composer cleared and the message never showed:
 *      the recipient MAY have it) → THAT page, if it is available; otherwise E, never a further
 *      page. The turn was passed on an earlier pass and stays passed until the draft is
 *      delivered or discarded, or the park is settled — otherwise each planning pass would hand
 *      it to yet another page while the first introduction is out (two first touches to one
 *      company, the fan-out this file exists to stop). Pinned even if new material has appeared
 *      since: the allowance lets only one of them through in the window anyway. Two things the
 *      first versions got wrong, both found by review, both pinned by tests: the holder is
 *      looked for BEFORE availability is asked (filtering first let a holder that went
 *      unavailable — signed out, flagged, its Mac gone — lose the pin, and the next pass wrote a
 *      second introduction); and a `not-in-thread` park counts as out (it is neither waiting nor
 *      delivered, so it was invisible, its route was blocked, and the next pass handed a
 *      byte-identical introduction to another page minutes later — to a company that may
 *      already hold the first).
 *   5. A page that wrote to them has not had its conversation with them READ since it last
 *      wrote → E. Rule 1 trusts our record of replies, and a record is only as good as the
 *      reading behind it: from at least 27 Oct to 16 Nov 2026 every sending profile's Chrome
 *      window was 500x232 and the reply sweep could read almost nothing, so "no reply recorded"
 *      for a message sent before then is ABSENCE OF DATA, not silence. A recipient who answered
 *      in that stretch and is introduced to by a second page is the H5 mistake — aimed at the
 *      one company that engaged. So a page's silence counts only when its thread was read and
 *      vouched for (`replyCheckedAt`, written only by a COMPLETE read that saw every message we
 *      sent) after it last wrote and after `REPLY_READS_TRUSTED_SINCE`. Every page that wrote,
 *      not only E: a reply sits in the thread of the page it answered. Retired or unheld pages
 *      included — a page nobody can read is a page whose replies nobody has seen. Switch:
 *      `passTurnOnlyAfterRead` (default ON).
 *   6. Nothing new to say (no fresh, unclaimed paid post naming them that a follow-up could
 *      describe) → the first page AFTER E in ring order that is available for this recipient,
 *      is not the recipient, and has never delivered to them. Walking from E keeps the spread
 *      deterministic: the same inputs elect the same page on every host and every pass.
 *   7. Otherwise, or when no such page exists        → E. Never a refusal: "every page has
 *      written and there is nothing new" is NO_NEW_MATERIAL, a rule with a clock, and must not
 *      become `all-unavailable`, which the screens file as rotation stuck — "needs a person".
 *
 * "Available" is the same `unavailable` map the ordinary walk reads — account facts plus the
 * routes this recipient's pages cannot use (parks, pair reply halts) — so a pass can never
 * elect a page with no online Mac, a flagged page, or a page whose earlier message to them is
 * parked as maybe-delivered.
 */
export interface TurnPass {
  /** Ring members that have EVER delivered a message to this recipient. */
  wroteBefore: ReadonlySet<string>
  /**
   * Ring members with a message to this recipient that is still OUT: a waiting draft (QUEUED,
   * READY or SENDING), or a park the recipient may have received (FAILED `not-in-thread`,
   * unsettled until a person confirms it either way). Rules 3 and 4.
   */
  holdsDraft: ReadonlySet<string>
  /** The recipient replied to any page, ever — `repliedAt` OR `replyPostedAt`, dated or not. */
  everReplied: boolean
  /**
   * No fresh, unclaimed paid post names them that a follow-up could describe — i.e. the elected
   * page, having written before, would be refused `no-new-material-to-reference` or
   * `no-post-we-can-describe`. Supplied by the caller, which is the one that holds the material.
   */
  nothingNewToSay: boolean
  /**
   * Handles of the pages that delivered to them whose conversation has NOT been read since they
   * last wrote (rule 5; `threadsUnreadSinceWrote`). Empty when every one has been, or when the
   * switch is off. Handles rather than ids because a page outside the ring (retired, or another
   * fleet's) counts too, and the sentence that explains a held pass must be able to name it.
   */
  unreadSinceWrote: readonly string[]
}

/**
 * When the reply sweep's reads became trustworthy again: 16 Nov 2026 18:05 IST, when the last
 * sending profile's Chrome window was restored to 1280 wide (`scripts/fix-chrome-window.ts`; the
 * 16 Nov entry in CLAUDE.md). Before it the window was 500x232, a thread's messages left the DOM
 * within two seconds, and ~200 reads a day failed. A read stamped before this moment is not
 * evidence of silence for the turn pass. It is a floor, not a schedule: from here on a page's
 * silence counts only from a read AFTER its own last message, which is the rule that outlasts
 * this outage.
 */
export const REPLY_READS_TRUSTED_SINCE = new Date('2026-11-16T12:35:00Z')

/**
 * PURE. The pages whose conversation with a recipient has not been read since they last wrote —
 * rule 5 of the turn pass. A page counts as read only when the newest vouched read of its thread
 * (`replyCheckedAt`) is at or after both its own newest delivery and `trustedSince`. A page with no
 * read, or whose delivery time is unknown and has no read after the floor, is unread: "we never
 * looked" must never become "they did not answer". Returned in handle order so the sentence that
 * names them is the same on every host.
 */
export function threadsUnreadSinceWrote(
  pages: ReadonlyArray<{ handle: string; lastWroteAt: Date | null; lastReadAt: Date | null }>,
  trustedSince: Date = REPLY_READS_TRUSTED_SINCE,
): string[] {
  const unread: string[] = []
  for (const p of pages) {
    const need = Math.max(p.lastWroteAt?.getTime() ?? 0, trustedSince.getTime())
    if (p.lastReadAt === null || p.lastReadAt.getTime() < need) unread.push(p.handle)
  }
  return unread.sort()
}

export type RotationChoice =
  | {
      ok: true
      senderId: string
      handle: string
      position: number
      /**
       * Set when the turn was PASSED: the page the ordinary walk elected, which has written to
       * this recipient before and has nothing new to say. Carried so a refusal or a screen can
       * say why a page that is not next after the last writer is writing.
       */
      passedFrom?: { senderId: string; handle: string }
      /**
       * Set when the turn WOULD have passed (rules 1-4 allow it, nothing new to say, a page that
       * never wrote is available) but rule 5 held it: the pages whose conversation has not been
       * read since they last wrote. Carried so the planner's log and /targets can say what the
       * recipient is waiting for — a held pass with no reason on any screen would read as the
       * feature not working.
       */
      passWaitsForRead?: readonly string[]
    }
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

    const elected = { ok: true as const, senderId: member.senderId, handle: member.handle, position: member.position }
    return input.pass ? passTurn(elected, order, (start + step) % order.length, input.pass, unavailable, targetId) : elected
  }

  return {
    ok: false,
    reason: 'all-unavailable',
    detail: `every sender in this category is unavailable — ${blocked.join('; ')}`,
  }
}

/**
 * PURE. The pass, applied to the page the ordinary walk elected. See `TurnPass` for the rule,
 * the measurement and whose decision it is. Never returns a refusal: when nothing qualifies, the
 * ordinary choice stands.
 */
function passTurn(
  elected: { ok: true; senderId: string; handle: string; position: number },
  order: readonly RingMember[],
  electedIndex: number,
  pass: TurnPass,
  unavailable: ReadonlyMap<string, string>,
  targetId: string | null,
): RotationChoice {
  if (pass.everReplied) return elected
  /* Rule 2: E never wrote — its message is already an introduction (the ordinary walk). */
  if (!pass.wroteBefore.has(elected.senderId)) return elected
  /* Rule 3: E's own message is in the queue. */
  if (pass.holdsDraft.has(elected.senderId)) return elected

  /* Pages that may introduce themselves, in ring order starting after the elected page —
     availability NOT yet asked, because rule 3 must see a holder that has become unavailable. */
  const neverWrote: RingMember[] = []
  for (let step = 1; step < order.length; step++) {
    const m = order[(electedIndex + step) % order.length]!
    if (targetId !== null && m.senderId === targetId) continue
    if (pass.wroteBefore.has(m.senderId)) continue
    neverWrote.push(m)
  }

  const from = { senderId: elected.senderId, handle: elected.handle }
  /* Rule 4: an introduction already out keeps the turn — on an available holder; an unavailable
     holder's draft still waits (and a park may already have arrived), so no further page writes. */
  const holders = neverWrote.filter((m) => pass.holdsDraft.has(m.senderId))
  const holder = holders.find((m) => !unavailable.has(m.senderId))
  if (holder) return { ok: true, senderId: holder.senderId, handle: holder.handle, position: holder.position, passedFrom: from }
  if (holders.length > 0) return elected

  const first = neverWrote.find((m) => !unavailable.has(m.senderId))
  if (!pass.nothingNewToSay || !first) return elected
  /* Rule 5: a page whose silence nobody has read since it wrote — wait for the read. */
  if (pass.unreadSinceWrote.length > 0) return { ...elected, passWaitsForRead: pass.unreadSinceWrote }
  /* Rule 6: nothing new to say, so the first available page that never wrote takes the turn. */
  return { ok: true, senderId: first.senderId, handle: first.handle, position: first.position, passedFrom: from }
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
