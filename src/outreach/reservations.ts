import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { istDateKey, istDayStart, istHourOfDay } from '@/lib/time'

/**
 * Claiming one unit of a daily allowance, atomically.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * The per-recipient cap was `count today's messages, compare to the limit, then send`.
 * Two runs both count, both compare, both send. CLAUDE.md records this exact shape
 * biting twice in one day — `sendNow`'s idempotency ("a double click cannot double
 * send", under which it could) and the first version of the slot lock — and the fix both
 * times was to put the condition in the WRITE.
 *
 * A reservation does that. To send the Nth message to a recipient today you must first
 * `create` the row `(day, 'target', targetId, N)`; the unique index means exactly one
 * caller wins, however many are racing. There is no window between the test and the set,
 * because they are one statement.
 *
 * ── WHY THIS EXISTS BEFORE ROTATION ───────────────────────────────────────
 *
 * `cooldownDays` is per PAIR. 63 senders rotating through one category can message a
 * recipient every single day while every individual pair sits comfortably inside its
 * 7-day cooldown — no rule broken anywhere, nine messages into one inbox. Rotation solves
 * SENDER risk and does nothing for RECIPIENT risk, and a recipient's spam report is what
 * gets accounts banned. This is the only thing that closes it.
 *
 * ── RELEASING, AND WHY IT IS NOT SYMMETRIC ────────────────────────────────
 *
 * A reservation taken for a send that definitely did not happen must be given back, or a
 * cap on MESSAGES RECEIVED quietly becomes a cap on ATTEMPTS MADE and a run of transport
 * failures locks a recipient out for the day.
 *
 * But `not-in-thread` is NOT released. The composer cleared and the message never
 * appeared, which means the recipient may well have it — releasing would let a second
 * message follow a first that probably landed. Keeping a reservation we might not have
 * needed costs one deferred message; releasing one we did need costs a duplicate DM. The
 * asymmetry is the point.
 */

export type ReservationScope = 'target' | 'sender' | 'pair' | 'fleet'

/**
 * The two fleet buckets, as subject ids under `scope: 'fleet'`.
 *
 * ── WHY THE HOUR IS IN THE SUBJECT AND NOT IN THE DAY ─────────────────────
 *
 * `day` stays a plain IST date key everywhere, so "everything reserved today" remains one
 * exact query and the `[day, scope, subjectId]` index keeps working. Putting
 * "2026-08-04T17" in `day` would have made every existing day query a `LIKE`, and
 * `istDateKey` would no longer describe the column.
 *
 * This is deliberately NOT a second mechanism. Same table, same unique key, same
 * `create`-is-the-test-and-set, same release path — a fleet claim is just another
 * subject, which is why `scope: 'fleet'` was put in the schema in Phase 2 and left
 * unused until now.
 */
export const FLEET_DAY_SUBJECT = 'fleet'

/** `fleet:h17` — the IST hour, so the hour bucket cannot collide with the day bucket. */
export function fleetHourSubject(now: Date = new Date()): string {
  return `fleet:h${String(istHourOfDay(now)).padStart(2, '0')}`
}

export interface Reservation {
  id: string
  seq: number
}

export type ReserveResult =
  | { ok: true; reservation: Reservation | null }
  | { ok: false; reason: 'cap-reached'; used: number; limit: number }
  /**
   * `used` is BELOW `floor(limit)` here, always: a give-up whose final count reached the cap is
   * `cap-reached` (see the end of `reserveDaily`). That is what lets the contended sentence say
   * the cap is not reached.
   */
  | { ok: false; reason: 'contended'; used: number; limit: number }

/**
 * How many times we will lose the race before giving up.
 *
 * Losing means another claimer took the position we tried, which means it is sending — so
 * re-reading and trying the next free position is correct. Without releases each retry tries a
 * strictly HIGHER position (the set of held positions only grows), so a caller can lose at most
 * floor(limit) times (the cap: positions run 1..cap), and its NEXT read sees the cap as reached —
 * if it has a next read. With a cap of 12 or more it may not: a claimer that loses 12 times has
 * spent every iteration before the 13th read (at exactly 12 too — the 12th loss is the last
 * iteration, not the one before it). With releases interleaving, a claimer can lose 12 times at
 * ANY limit. Either way the give-up path re-counts and reports a reached cap as `cap-reached`;
 * only a count below the cap is `contended`, and neither is ever permission.
 */
const MAX_CLAIM_ATTEMPTS = 12

/**
 * The lowest POSITION in 1..limit nobody holds, or null when every position is taken.
 *
 * PURE, and the whole of the cap's arithmetic. A held seq above `floor(limit)` occupies no
 * position — a row written before this rule (the old `highest + 1 + i` walk reached seq 15 for a
 * cap of 5, measured), or under a higher limit earlier today — so it cannot block a slot; the
 * COUNT still binds it, which is `reserveDaily`'s first check. A fractional limit is floored:
 * 2.5 allows positions 1 and 2 and never a third.
 */
export function lowestFreeSeq(heldSeqs: readonly number[], limit: number): number | null {
  const top = Math.floor(limit)
  const held = new Set(heldSeqs)
  for (let seq = 1; seq <= top; seq++) if (!held.has(seq)) return seq
  return null
}

/**
 * Claim one unit of today's allowance for one subject.
 *
 * `limit` may be `Infinity`, which is what an "unlimited" setting resolves to. In that
 * case there is no cap to enforce and no row is written — the caller gets
 * `{ ok: true, reservation: null }`. Writing a row nobody will ever read back would be
 * bookkeeping pretending to be a guard.
 *
 * ── A SEQ IS A POSITION IN 1..limit, AND THAT IS WHAT ENFORCES THE CAP (2026-10-16) ──
 *
 * The unique key is `(day, scope, subjectId, seq)`. It makes each SEQ unique and says nothing
 * about how MANY rows exist. The previous version counted the held rows, compared with the
 * limit, then created `seq = highest + 1 + i` — so two claimers holding the same stale count
 * both passed `used >= limit` and inserted DIFFERENT seqs (the `+ i` walk guaranteed they
 * differed), and the cap overshot by one per concurrent claimer. Reproduced deterministically
 * in `tests/reservation-no-overshoot.test.ts`: one claimer whose read predates a concurrent
 * claimer's create wrote a THIRD row against a cap of two. A daily cap is the one ceiling here
 * nobody may cross, and a count-then-compare is passed by two callers at once — the shape this
 * module's own docblock says it exists to remove, surviving inside it.
 *
 * Now a claimer may only create a seq in 1..floor(limit). While every held row sits in that
 * range, at most `limit` distinct positions exist, so the unique index refuses the (limit+1)th
 * row however stale anybody's read was: the read only CHOOSES which position to try, and
 * `create` on the unique key is the test-and-set.
 *
 * ── ROWS OUTSIDE 1..limit, AND WHY THE COUNT IS LOAD-BEARING THERE ──────────
 *
 * A row outside 1..limit occupies no position, so the index alone would admit `limit` in-range
 * rows BESIDE it. Two real sources: rows written today under the old rule (cap 5: claim 1-4,
 * release 1, claim, claim → {2,3,4,5,6}, no race needed), and a limit lowered mid-day. There the
 * COUNT is what holds the cap. What it guarantees under concurrency depends on whether every
 * claimer in flight passed the SAME limit, so the two are stated separately — the first version
 * of this docblock claimed the first for both.
 *
 * ONE LIMIT FOR EVERY CONCURRENT CLAIMER: no claim takes the total past floor(limit) = cap.
 *
 *   - Every new row sits at a position ≤ cap, so no claim writes a row outside 1..cap.
 *   - Take the HIGHEST position q* any claim created. Its creator's snapshot held positions
 *     1..q*-1 (that is why `lowestFreeSeq` chose q*) and fewer than cap rows in all (that is why
 *     `used < cap` let it through). No claim created anything above q*, so every row now above q*
 *     was there before the claims began and still exists — and so was in that snapshot too: a
 *     stale read can miss a NEW row, never an old one.
 *   - So the rows at or below q* number at most q*, the rows above it at most (snapshot − (q*−1)),
 *     and the total is at most snapshot + 1 ≤ cap. The index makes the new positions distinct.
 *
 * A LIMIT CHANGED WHILE CLAIMS ARE IN FLIGHT: bounded by the LARGEST limit in play, not the new
 * one. Claimer H reads limit 5, sees {1,2,3}, picks 4; a release frees 3; claimer B reads the
 * lowered limit 3, sees {1,2}, picks 3; both create → 4 rows against a cap of 3, every one at a
 * position ≤ 5 (`tests/reservation-no-overshoot.test.ts` → "a limit changed while claims are in
 * flight" drives exactly this interleaving). The argument above still bounds the total by the cap
 * of whoever created q* (here H's 5), so no claim takes the total past the largest limit any
 * claimer in flight passed. A lowered limit binds every claim whose CALLER READ SETTINGS AFTER
 * THE CHANGE — none is admitted while its own view shows the new cap reached. That is not every
 * claim made after the change: the Send button (`sendNow`) reads settings inside the lock, so its
 * claim carries the current limit, but a dispatch tick (`dispatchTick`) reads them once, before
 * the lock, and hands that snapshot down — so the claims remaining in that tick carry the old
 * limit until the tick ends. A post-create recount is deliberately NOT added: it would close only
 * one ordering (B creating and recounting before H creates leaves H's recount, under its own
 * limit of 5, keeping its row), so it would read as a fix and be half of one.
 *
 * IN PRODUCTION CLAIMS DO NOT OVERLAP. `claimForAttempt` has one caller, `deliverOne`, and both of
 * its callers hold `withSendLock` — the fleet-wide lock, a row in the shared database — for the
 * whole call: `dispatchTick`'s withSendLock(`dispatch:…`) → `deliverWaiting` → `deliverOne`, and
 * `sendNow`'s withSendLock(`operator:…`) → `deliverOne`. The lock is held twice only through its
 * own takeover of a holder it judges gone. `decideSendLock` takes the lock over in exactly these
 * cases: the row is unreadable; the row names THIS process's own pid (a row left behind, by this
 * process or by a dead one whose pid it now has — `withSendLock` refuses to nest, so never a live
 * hold of its own); the row names this Mac and its pid is dead, or it was written before this Mac
 * last booted (`writtenBeforeBoot`, whatever the pid now answers); or the row names another Mac
 * (or no Mac at all — an agent older than the field) and the lock is stale AND that Mac has
 * stopped beating. So everything above about concurrent claimers is defence in
 * depth: it is what holds if one of those judgements is wrong or a future caller claims outside
 * the lock, not what keeps today's claims apart.
 *
 * On deploy day the guarantee therefore rests on the count AND the position together, and the
 * count must not be read as redundant just because, in steady state, it is.
 * `tests/reservation-no-overshoot.test.ts` → "rows outside 1..limit" pins it sequentially,
 * concurrently and with a stale read.
 *
 * ── THE RELEASED-SEQ CASE, AND WHY THE COUNT AND THE POSITION ARE STILL TWO NUMBERS ──
 *
 *   `used` — how many claims are held. Measured against the cap first, so a row outside
 *            1..limit (written under the old rule, or a higher limit) still counts.
 *   `seq`  — the lowest position nobody holds.
 *
 * The first version used `used + 1` for both. Release a reservation and they diverge: with
 * seq 1 released and seq 2 still held, `used` is 1, so it retried seq 2 twelve times and
 * reported "contended" against a cap with a free slot — caught by running it against the real
 * database, not by the unit test, which had reimplemented the same arithmetic and so reproduced
 * the bug faithfully. The `highest + 1 + i` fix that replaced it cured the livelock by leaving
 * gaps and stepping OVER the cap, which is the overshoot above. The lowest free position cures
 * both: seq 1 released, seq 2 held → position 1 is free → taken, first try.
 */
export async function reserveDaily(args: {
  scope: ReservationScope
  subjectId: string
  limit: number
  /** Injected so both directions are testable without waiting for midnight. */
  now?: Date
}): Promise<ReserveResult> {
  const { scope, subjectId, limit, now = new Date() } = args
  const day = istDateKey(now)

  // No ceiling means nothing to claim. Deliberate: see the docblock.
  if (!Number.isFinite(limit)) return { ok: true, reservation: null }
  /**
   * The cap is a whole number of messages: what `lowestFreeSeq` floors, the count floors too.
   * Settings are whole by construction (`readNumericSetting` refuses a fraction), so this only
   * binds a direct caller — but the two checks must agree on what the cap IS, or a fractional
   * limit with rows outside 1..limit admits floor(limit)+1: {4,7} against 2.5 has used 2 < 2.5
   * and a free position 1.
   */
  const cap = Math.floor(limit)
  if (cap < 1) return { ok: false, reason: 'cap-reached', used: 0, limit }

  let lastError: unknown = null
  for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
    // ONE read: the held positions. Its length is the count; its contents choose the position.
    const rows = await prisma.dailyReservation.findMany({ where: { day, scope, subjectId }, select: { seq: true } })
    const used = rows.length
    /**
     * LOAD-BEARING, NOT REDUNDANT — do not "simplify" it away because `lowestFreeSeq` also
     * returns null at a full cap. That is only true while every held row sits in 1..cap. A row
     * OUTSIDE 1..cap occupies no position, so the unique index alone would admit `cap` in-range
     * rows BESIDE it, and this count is the only thing that refuses them. Such rows are not
     * hypothetical: the old `highest + 1 + i` rule wrote them with no race at all (cap 5: claim
     * 1-4, release 1, claim, claim → {2,3,4,5,6}), and lowering a limit mid-day strands them.
     * Delete this line and `tests/reservation-no-overshoot.test.ts` → "rows outside 1..limit"
     * writes a 6th row against a cap of 5.
     */
    if (used >= cap) return { ok: false, reason: 'cap-reached', used, limit }
    const seq = lowestFreeSeq(
      rows.map((r) => r.seq),
      cap,
    )
    // Fewer rows than the cap and yet no free position: impossible while the count above holds
    // (cap - used >= 1 positions must be free — pigeonhole), so this is a defence, not a path.
    // If it ever fires, the cap has no position left to give, and that is a reached cap.
    if (seq === null) return { ok: false, reason: 'cap-reached', used, limit }

    /**
     * `create` on the unique key IS the test-and-set, and `seq <= limit` is what makes it the
     * cap. If another claimer took this position since our read, the create throws, and we
     * re-read and take the next free one — the correct response, because that claimer is
     * sending. The read is allowed to be stale; it is not the guard.
     */
    try {
      const row = await prisma.dailyReservation.create({ data: { day, scope, subjectId, seq } })
      return { ok: true, reservation: { id: row.id, seq: row.seq } }
    } catch (e) {
      // Lost the race for this position. Kept for the give-up line below: a create that fails
      // for a reason OTHER than a collision would otherwise read as contention with no evidence.
      lastError = e
    }
  }

  /**
   * ── OUT OF ATTEMPTS IS NOT THE SAME AS CONTENDED (2026-10-16, review of 01576f4) ──
   *
   * Losing every race usually means the cap FILLED while we tried. Limit 12, thirteen claimers
   * at once (`Promise.all` on SQLite moves them in lockstep: round k reads k-1 rows, one wins):
   * the losers spend all twelve iterations with twelve rows held and never reach the read that
   * would have said so. This used to return `contended` from there regardless, and the hold read
   * "12 of 12 used, so the cap is NOT reached" — a false sentence about the one ceiling a person
   * must be able to trust, and the opposite of what the draft is waiting for.
   *
   * So the final count is measured against the SAME `cap` the loop uses: at or past it is a
   * reached cap; only a count BELOW it is contention. `tests/reservation-no-overshoot.test.ts` →
   * "out of attempts with the cap full" goes red without this line.
   */
  const used = await prisma.dailyReservation.count({ where: { day, scope, subjectId } })
  if (used >= cap) return { ok: false, reason: 'cap-reached', used, limit }
  log.warn('gave up claiming a daily reservation under contention', {
    scope,
    subjectId,
    used,
    limit,
    lastError: lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError),
  })
  return { ok: false, reason: 'contended', used, limit }
}

/** Attach the attempt to a reservation, so a retry can find and reuse it. */
export async function stampReservation(reservationId: string, attemptId: string): Promise<void> {
  await prisma.dailyReservation
    .update({ where: { id: reservationId }, data: { attemptId } })
    .catch((e) => log.warn('could not stamp a reservation', { reservationId, error: String(e) }))
}

/**
 * A reservation this attempt already holds today, if any.
 *
 * Without this, an attempt that fails and is retried tomorrow-but-one consumes a second
 * unit of the recipient's allowance for the same single message. The cap is on messages
 * a person receives, not on how many times we tried.
 */
export async function existingReservation(args: {
  scope: ReservationScope
  subjectId: string
  attemptId: string
  now?: Date
}): Promise<Reservation | null> {
  const day = istDateKey(args.now ?? new Date())
  const row = await prisma.dailyReservation.findFirst({
    where: { day, scope: args.scope, subjectId: args.subjectId, attemptId: args.attemptId },
    select: { id: true, seq: true },
  })
  return row
}

/**
 * Give a reservation back after a send that definitely did not reach anyone.
 *
 * NEVER call this for `not-in-thread`. See the docblock: that failure means the message
 * may have been delivered, and releasing it would permit a second one on top.
 */
export async function releaseReservation(reservationId: string): Promise<void> {
  await prisma.dailyReservation
    .delete({ where: { id: reservationId } })
    .catch((e) => log.warn('could not release a reservation', { reservationId, error: String(e) }))
}

/**
 * Failure codes after which the reservation is given back.
 *
 * A CLOSED list, and the default is to KEEP. An unfamiliar failure code must not release
 * a reservation, because the question it answers is "are we certain nothing was
 * delivered?" and the honest answer for something unrecognised is no.
 */
const DEFINITELY_NOT_DELIVERED = new Set([
  'still-staged', // Enter did nothing; the text is visibly still in the composer.
  'composer-mismatch', // We refused before pressing Enter. This is the guard working.
  'no-composer', // The thread never opened a message box.
  'no-message-button', // We never even reached a composer.
  'profile-gone', // The page does not exist; no composer was ever reached.
  // Refused at the inbox route's door, before the request Accept, the interstitial or the
  // composer: nothing was typed, so nothing can have reached anyone (audit C1).
  'recipient-unconfirmed',
])

/** Is it certain that nothing reached the recipient? Unknown codes answer NO. */
export function shouldReleaseOnFailure(failureCode: string | null | undefined): boolean {
  if (!failureCode) return false
  return DEFINITELY_NOT_DELIVERED.has(failureCode)
}

/** How much of today's allowance a subject has used. For the dashboard. */
export async function usedToday(scope: ReservationScope, subjectId: string, now?: Date): Promise<number> {
  return prisma.dailyReservation.count({
    where: { day: istDateKey(now ?? new Date()), scope, subjectId },
  })
}

/**
 * The first words of a CONTENDED refusal's detail. The dispatcher's hold tape and the Send
 * button both show `detail` and nothing else, so this is what tells a person the conversation
 * had ROOM and the claim lost races — not that today's messages were used up.
 */
export const CLAIM_CONTENDED_PREFIX = 'contended:'

export type ClaimResult =
  | { ok: true; held: Reservation[] }
  | {
      ok: false
      /**
       * The BUCKET that refused, for both a reached cap and a contended claim. Kept that way so
       * `deliverOne`'s routing does not move (a fleet bucket ends the tick, a pair bucket holds
       * one draft), and so `'pair-daily-cap'` stays exactly the gate's `PAIR_DAILY_CAP` stop
       * for a REACHED cap. `contended` is what separates the two.
       */
      reason: 'pair-daily-cap' | 'fleet-hourly-pace' | 'fleet-daily-cap'
      detail: string
      /**
       * True when the claim gave up after losing every race, with the cap NOT reached.
       *
       * Its own field (2026-10-16): until then a contended claim was reported under the same
       * reason as a spent cap and only the prose differed — a hold wearing the cap's sentence,
       * which sends a person looking at today's volume when nothing was sent. REQUIRED rather
       * than optional, so every construction site states which it is.
       */
      contended: boolean
    }

/**
 * The sentence for a claim that lost every race. It names the ROOM that was left, because the
 * whole difference from a reached cap is that there was some: nothing was sent, and the draft
 * waits for the next tick.
 *
 * "NOT reached" is said only when the numbers in the same sentence show it. From `reserveDaily`
 * that is always — a `contended` result carries a count below `floor(limit)` by construction —
 * but the sentence is the one place a person reads the claim, and it once printed "12 of 12 used,
 * so the cap is NOT reached" (the give-up path did not re-ask the cap). So it asks again here.
 *
 * What this guard covers is the SENTENCE, and only that: it keeps the detail's words consistent
 * with the count printed beside them. It does not reach the `contended` flag `claimForAttempt`
 * returns, nor `deliverOne`'s "the cap is not reached" log line, which reads that flag and not this
 * sentence. Those are honest because of the `ReserveResult` invariant — `used < floor(limit)` for
 * every `contended` result, which `reserveDaily`'s give-up recount enforces — and a builder that
 * broke it would get a truthful detail beside an untruthful flag.
 * Exported for that test alone; nothing outside this module builds a detail.
 */
export function contendedDetail(where: string, r: { used: number; limit: number }): string {
  const roomLeft = r.used < Math.floor(r.limit)
  const state = roomLeft ? `${r.used} of ${r.limit} used, so the cap is NOT reached` : `${r.used} of ${r.limit} used`
  return `${CLAIM_CONTENDED_PREFIX} too many sends are being claimed ${where} at once (${state}) — nothing was sent; deferring`
}

/**
 * Claim the recipient's AND the sender's daily allowance for one attempt, or neither.
 *
 * ONE function, called, through `deliverOne`, by `deliverWaiting` and by `sendNow`. Those two
 * drifted once before — the button silently lacked five of the eight checks the slot ran, including
 * *they replied* — and the fix was `gate.ts`. This is the same lesson applied to the
 * thing `gate.ts` cannot do: the gate DECIDES, this one CLAIMS, and a decision without
 * an atomic claim is what lets two runs both pass it.
 *
 * All-or-nothing. If the sender's cap is spent, the recipient's claim is given straight
 * back — otherwise a sender that is out of allowance would burn a recipient's slot for
 * every pair it holds, and the recipient would be locked out by a message nobody sent.
 *
 * Idempotent per attempt: a retry finds the reservation it already holds and reuses it.
 * The cap is on messages a person RECEIVES, not on how many times we tried to send one.
 */
export async function claimForAttempt(args: {
  attemptId: string
  /**
   * The pair (sender→target) this attempt belongs to. Since 2026-08-18 the ONE volume
   * rule is per pair — at most `maxPerPairPerDay` (5) from one account to one recipient
   * per IST day, Tabish's instruction — so the atomic claim is per pair too. The old
   * per-target and per-sender daily claims were removed with the caps they enforced.
   */
  pairId: string
  maxPerPairPerDay: number
  /**
   * Fleet-wide pacing, Phase 5. Both default to no ceiling so an omitted argument can
   * never be MORE permissive than an explicit one — the caller that forgets these gets
   * exactly today's behaviour rather than a silently unpaced send.
   */
  fleetMaxPerHour?: number
  fleetMaxPerDay?: number
  /**
   * True when a person is present and pressing Send.
   *
   * The HOUR bucket is skipped for them, and only that one. It exists to stop UNATTENDED
   * sends clustering; a human sending one message is not a cluster, and refusing them
   * would make the on-demand button unreliable for the case it was built for ("I know
   * something the agent does not"). The DAY bucket still binds, because that is a volume
   * ceiling and the project's rule is that daily caps are not crossable — crossing
   * cooldown sends one extra message to one person, crossing a daily cap has no bound.
   */
  attended?: boolean
  now?: Date
}): Promise<ClaimResult> {
  const {
    attemptId,
    pairId,
    maxPerPairPerDay,
    fleetMaxPerHour = Number.POSITIVE_INFINITY,
    fleetMaxPerDay = Number.POSITIVE_INFINITY,
    attended = false,
    now,
  } = args
  const held: Reservation[] = []

  const claim = async (
    scope: ReservationScope,
    subjectId: string,
    limit: number,
  ): Promise<ReserveResult> => {
    const existing = await existingReservation({ scope, subjectId, attemptId, now })
    if (existing) return { ok: true, reservation: existing }
    const result = await reserveDaily({ scope, subjectId, limit, now })
    if (result.ok && result.reservation) await stampReservation(result.reservation.id, attemptId)
    return result
  }

  /** Hand back everything claimed so far. All-or-nothing, at every step. */
  const abandon = async (): Promise<void> => {
    for (const r of held) await releaseReservation(r.id)
  }

  const pair = await claim('pair', pairId, maxPerPairPerDay)
  if (!pair.ok) {
    return {
      ok: false,
      reason: 'pair-daily-cap',
      contended: pair.reason === 'contended',
      detail:
        pair.reason === 'cap-reached'
          ? `this account has already sent this recipient ${pair.used} message(s) today (limit ${pair.limit})`
          : contendedDetail('for this conversation', pair),
    }
  }
  if (pair.reservation) held.push(pair.reservation)

  /**
   * ── THE FLEET BUCKETS ─────────────────────────────────────────────────
   *
   * Claimed LAST, and given back on refusal exactly like the sender's, because the same
   * asymmetry applies: a recipient's allowance must not be consumed by a message the
   * fleet's pacing then declined to send.
   *
   * The DAY bucket is checked before the HOUR bucket. A day cap being spent is a fact
   * about the whole day and reporting it as "wait for the next hour" would be wrong —
   * the next hour will not help.
   */
  const fleetDay = await claim('fleet', FLEET_DAY_SUBJECT, fleetMaxPerDay)
  if (!fleetDay.ok) {
    await abandon()
    return {
      ok: false,
      reason: 'fleet-daily-cap',
      contended: fleetDay.reason === 'contended',
      detail:
        fleetDay.reason === 'cap-reached'
          ? `the fleet has already sent ${fleetDay.used} message(s) today (limit ${fleetDay.limit})`
          : contendedDetail('across the fleet today', fleetDay),
    }
  }
  if (fleetDay.reservation) held.push(fleetDay.reservation)

  if (!attended) {
    const fleetHour = await claim('fleet', fleetHourSubject(now ?? new Date()), fleetMaxPerHour)
    if (!fleetHour.ok) {
      await abandon()
      return {
        ok: false,
        reason: 'fleet-hourly-pace',
        contended: fleetHour.reason === 'contended',
        detail:
          fleetHour.reason === 'cap-reached'
            ? `${fleetHour.used} message(s) have already gone out this hour (pace ${fleetHour.limit}/hour) — ` +
              `this one waits for the next one`
            : contendedDetail('this hour', fleetHour),
      }
    }
    if (fleetHour.reservation) held.push(fleetHour.reservation)
  }

  return { ok: true, held }
}

/**
 * How many messages the fleet has sent this IST hour, and today. For the dashboard.
 *
 * Counted from `OutreachAttempt` since 2026-08-18. It used to read the reservation rows
 * the claim writes — the right source while the fleet buckets were finite — but with the
 * buckets unlimited, `Infinity` deliberately writes no bookkeeping row, so a reservation
 * count would read 0 forever while messages went out: a number that quietly stops meaning
 * what its label says.
 */
export async function fleetUsage(now: Date = new Date()): Promise<{ thisHour: number; today: number }> {
  /**
   * Counted from OutreachAttempt since 2026-08-18, not from reservation rows. With the
   * fleet buckets unlimited (`Infinity` writes no bookkeeping row, by design), a count of
   * reservation rows would read 0 forever while messages went out — a number that quietly
   * stops meaning what its label says. DELIVERED_STATUSES, so a reply cannot lower it.
   */
  // The IST hour boundary, derived from the IST helpers rather than the host's own
  // clock: the Linode does not run in IST, and a machine-local setMinutes(0,0,0) would
  // floor to a boundary 30 minutes off (IST is +05:30).
  const dayStart = istDayStart(now)
  const hourStart = new Date(dayStart.getTime() + istHourOfDay(now) * 3_600_000)
  const delivered = { in: ['SENT', 'REPLIED'] }
  const [thisHour, today] = await Promise.all([
    prisma.outreachAttempt.count({ where: { status: delivered, sentAt: { gte: hourStart, lte: now } } }),
    prisma.outreachAttempt.count({ where: { status: delivered, sentAt: { gte: dayStart, lte: now } } }),
  ])
  return { thisHour, today }
}

/**
 * After the send: keep the claims, or give them back.
 *
 * Kept on success, obviously — and kept on ANY failure that is not certainly a
 * non-delivery, which is the asymmetry the module docblock argues for. `not-in-thread`
 * is the case that matters: releasing it would allow a second message on top of one that
 * probably landed.
 */
export async function settleClaims(
  held: readonly Reservation[],
  outcome: {
    delivered: boolean
    failureCode?: string | null
    /**
     * `false` means NO BROWSER WAS DRIVEN — the send never began, so delivery is not
     * merely "ruled out", it never started. Released unconditionally.
     *
     * Its own field rather than a borrowed failure code. The alternative was passing
     * `'still-staged'` (which does release) to describe a send that was never attempted,
     * and a settle path that lies about what happened is exactly how a future reader
     * concludes the wrong thing about which failures are safe to release.
     */
    attempted?: boolean
  },
): Promise<void> {
  if (outcome.delivered) return
  if (outcome.attempted === false) {
    for (const r of held) await releaseReservation(r.id)
    return
  }
  if (!shouldReleaseOnFailure(outcome.failureCode)) {
    log.step('keeping the daily reservation — delivery could not be ruled out', {
      failureCode: outcome.failureCode ?? 'none',
    })
    return
  }
  for (const r of held) await releaseReservation(r.id)
}
