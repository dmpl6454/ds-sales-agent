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
  | { ok: false; reason: 'contended'; used: number; limit: number }

/**
 * How many times we will lose the race before giving up.
 *
 * Losing means another process claimed the seq we tried, which means it is sending —
 * so the used count has genuinely moved and retrying with the next seq is correct. The
 * bound exists so an unlimited cap under heavy contention cannot spin forever; hitting
 * it is reported as `contended`, never as permission.
 */
const MAX_CLAIM_ATTEMPTS = 12

/**
 * Claim the next free unit of today's allowance for one subject.
 *
 * `limit` may be `Infinity`, which is what an "unlimited" setting resolves to. In that
 * case there is no cap to enforce and no row is written — the caller gets
 * `{ ok: true, reservation: null }`. Writing a row nobody will ever read back would be
 * bookkeeping pretending to be a guard.
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
  if (limit < 1) return { ok: false, reason: 'cap-reached', used: 0, limit }

  for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
    /**
     * TWO DIFFERENT NUMBERS, and conflating them was a real bug.
     *
     *   `used` — how many claims are held. This is what the CAP is measured against.
     *   `next` — a seq nobody holds. This is only a uniqueness token.
     *
     * The first version used `used + 1` for both. Release a reservation and they
     * diverge: with seq 1 released and seq 2 still held, `used` is 1, so it retried
     * seq 2 twelve times and reported "contended" against a cap with a free slot. Caught
     * by running it against the real database, not by the unit test — which had
     * reimplemented the same arithmetic and so reproduced the bug faithfully.
     *
     * Gaps are fine. `seq` is never read as a position, only as something to collide on.
     */
    const [used, highest] = await Promise.all([
      prisma.dailyReservation.count({ where: { day, scope, subjectId } }),
      prisma.dailyReservation.findFirst({
        where: { day, scope, subjectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      }),
    ])
    if (used >= limit) return { ok: false, reason: 'cap-reached', used, limit }

    /**
     * `create` on the unique key IS the test-and-set. The reads above only choose which
     * seq to try; they are not the guard, and they are allowed to be stale. If another
     * process took this seq in between, the create throws and we try the next one —
     * which is the correct response, because that process is sending.
     */
    try {
      const row = await prisma.dailyReservation.create({
        data: { day, scope, subjectId, seq: (highest?.seq ?? 0) + 1 + i },
      })
      return { ok: true, reservation: { id: row.id, seq: row.seq } }
    } catch {
      // Lost the race for this seq. `+ i` walks past a contended run rather than
      // retrying the same number, which is what turned a race into a livelock.
    }
  }

  const used = await prisma.dailyReservation.count({ where: { day, scope, subjectId } })
  log.warn('gave up claiming a daily reservation under contention', { scope, subjectId, used, limit })
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

export type ClaimResult =
  | { ok: true; held: Reservation[] }
  | {
      ok: false
      reason: 'pair-daily-cap' | 'fleet-hourly-pace' | 'fleet-daily-cap'
      detail: string
    }

/**
 * Claim the recipient's AND the sender's daily allowance for one attempt, or neither.
 *
 * ONE function, called by `deliverWaiting` and by `sendNow`. Those two drifted once
 * before — the button silently lacked five of the eight checks the slot ran, including
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
      detail:
        pair.reason === 'cap-reached'
          ? `this account has already sent this recipient ${pair.used} message(s) today (limit ${pair.limit})`
          : `too many sends are being claimed for this conversation at once — deferring`,
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
      detail:
        fleetDay.reason === 'cap-reached'
          ? `the fleet has already sent ${fleetDay.used} message(s) today (limit ${fleetDay.limit})`
          : `too many sends are being claimed across the fleet at once — deferring`,
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
        detail:
          fleetHour.reason === 'cap-reached'
            ? `${fleetHour.used} message(s) have already gone out this hour (pace ${fleetHour.limit}/hour) — ` +
              `this one waits for the next one`
            : `too many sends are being claimed this hour — deferring`,
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
