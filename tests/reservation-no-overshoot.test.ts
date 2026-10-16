import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { openOutreachDb } from './helpers/outreach-db'

/**
 * THE DAILY RESERVATION CANNOT OVERSHOOT ITS CAP (Stage 1.5, 2026-10-16).
 *
 * `reserveDaily` used to COUNT the held rows, compare with the limit, then create
 * `seq = highest + 1 + i`. The unique key `(day, scope, subjectId, seq)` makes each SEQ unique
 * and says nothing about how MANY rows exist — so two claimers reading the same stale count
 * both passed `used >= limit` and both inserted DISTINCT seqs (the `+ i` walk guaranteed they
 * differed). The cap overshot by one per concurrent claimer, and a daily cap is the one thing
 * here nobody may cross ("crossing a daily cap has no bound").
 *
 * Now a seq is a POSITION in 1..limit, and the claimer takes the lowest free one. At most
 * `limit` distinct positions exist, so the unique key enforces the cap by construction: the
 * read only chooses which position to try, and the `create` is the test-and-set.
 *
 * ── DRIVEN THROUGH THE REAL CLIENT, ON A REAL FILE ───────────────────────────
 *
 * `tests/reservations.test.ts` mirrors the arithmetic, and a mirror reproduced the released-seq
 * livelock faithfully the first time. So this calls the REAL `claimForAttempt` and the REAL
 * `reserveDaily` against `openOutreachDb`'s file, whose DDL carries the unique index.
 *
 * ── DOES THE CONCURRENT CASE REPRODUCE THE OVERSHOOT AT HEAD? MEASURED: NO ──────
 *
 * Run against the pre-fix `reserveDaily` (`git stash` of the source change, this file kept),
 * `Promise.all` of N claimers LOCKSTEPS on SQLite: better-sqlite3 runs each statement
 * synchronously and the microtask order is fixed, so every claimer reads the same set, all try
 * the same seq, one wins per round, and the row COUNT stayed at the limit. What it did show is
 * the seq walking past the cap — positions [1, 3, 6] for a cap of 3 and up to 15 for a cap of 5
 * — so the concurrent cases go red at HEAD on the position bound, not on the count.
 *
 * The overshoot needs a claimer whose read PREDATES another claimer's create, at a different
 * retry index. That is driven deterministically below with the smallest seam that touches no
 * production code: the reads of `dailyReservation` are made blind to named rows (a read taken
 * before those rows were written), and the real `reserveDaily` runs against the real table. At
 * HEAD that wrote a THIRD row against a cap of two (the stale count passed, the collision walked
 * `+ i` to seq 3, and the create succeeded); now the stale read can only choose a position the
 * unique key already holds, so it loses every race and reports `contended`, and no row past the
 * cap exists. The seam is implementation-agnostic — whichever read method the claim uses, it is
 * filtered by `id`, a non-null column, so SQL's three-valued logic cannot widen it.
 *
 * MUTATIONS, each applied by hand once and seen red, then restored:
 *   - restore `seq = (highest ?? 0) + 1 + i`  → the stale-read cases write limit+1 rows, and the
 *                                               concurrent cases hold seqs past the limit
 *   - use `seq = used + 1`                     → the released-seq case livelocks to `contended`
 *                                               (seq 2 retried 12 times against a free slot 1)
 *   - drop `seq <= top` in `lowestFreeSeq`     → the helper's full/fractional cases go red
 *   - delete `if (used >= cap)` in `reserveDaily` → every "rows outside 1..limit" case but the
 *                                               stale one goes red: {2,3,4,5,6} gains a 6th row
 *                                               against a cap of 5, {4,7} ends [1,2,3,4,7]
 *                                               against 3 (sequentially AND concurrently), and
 *                                               a lowered limit hands out position 2. No case
 *                                               OUTSIDE that block fails — in steady state the
 *                                               count is redundant, which is why it needs these
 *   - compare `used >= limit` instead of `cap`  → the fractional-limit case writes a 3rd row
 *   - the review of 01576f4 added two blocks with their own mutations, recorded in their
 *     docblocks: "out of attempts with the cap full is a REACHED cap" (the give-up path) and
 *     "the fleet buckets say contended only when they were" (`contended` per bucket)
 *   - the review of the Stage 1.5 follow-up added the limit-12.5 thief case (its mutation is
 *     recorded on it) and "a limit changed while claims are in flight", which pins the bound
 *     `reserveDaily`'s docblock states for mixed limits rather than guarding any one line
 */

const db = await openOutreachDb('reservation-no-overshoot')
const { prisma } = await import('@/lib/db')
const reservations = await import('@/outreach/reservations')
const { istDateKey } = await import('@/lib/time')
const { claimForAttempt, reserveDaily, releaseReservation } = reservations

/** A fixed instant, so the IST day key is one value throughout. 15:00 IST. */
const NOW = new Date('2026-10-16T09:30:00.000Z')
const PAIR = 'p_bollywoodchronicle__amazondotin'

async function seqs(): Promise<number[]> {
  const rows = await prisma.dailyReservation.findMany({
    where: { scope: 'pair', subjectId: PAIR },
    select: { seq: true },
    orderBy: { seq: 'asc' },
  })
  return rows.map((r) => r.seq)
}

/** N distinct drafts for ONE pair, claimed at once — an on-demand draft beside a planner draft, many times over. */
async function claimConcurrently(n: number, limit: number) {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      claimForAttempt({
        attemptId: `att_${String(i).padStart(2, '0')}`,
        pairId: PAIR,
        maxPerPairPerDay: limit,
        fleetMaxPerHour: Number.POSITIVE_INFINITY,
        fleetMaxPerDay: Number.POSITIVE_INFINITY,
        now: NOW,
      }),
    ),
  )
}

beforeEach(async () => {
  await prisma.dailyReservation.deleteMany({})
})

afterAll(async () => {
  await db.close(prisma)
})

describe('concurrent claims for one pair never exceed the cap', () => {
  it.each([
    { n: 8, limit: 3 },
    { n: 20, limit: 5 },
  ])('$n claimers against a cap of $limit: exactly $limit win and exactly $limit rows exist', async ({ n, limit }) => {
    const results = await claimConcurrently(n, limit)

    const won = results.filter((r) => r.ok)
    const refused = results.filter((r) => !r.ok)
    const held = await seqs()

    // THE POINT. A 4th row with a cap of 3 is a message the cap promised would not go out.
    expect(held.length, `rows held: ${JSON.stringify(held)}`).toBe(limit)
    expect(won).toHaveLength(limit)
    expect(refused).toHaveLength(n - limit)

    // (d) a seq is a POSITION in 1..limit, and every position is taken exactly once.
    expect(Math.max(...held)).toBeLessThanOrEqual(limit)
    expect(held).toEqual(Array.from({ length: limit }, (_, i) => i + 1))

    // Every refusal is the pair's bucket — a reached cap or a contended claim, never permission.
    for (const r of refused) {
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('pair-daily-cap')
    }

    // Every winner holds exactly one reservation, stamped with its own attempt.
    const stamped = await prisma.dailyReservation.findMany({ where: { subjectId: PAIR }, select: { attemptId: true } })
    expect(new Set(stamped.map((s) => s.attemptId)).size).toBe(limit)
  })

  it('a second burst against a full cap writes nothing at all', async () => {
    await claimConcurrently(8, 3)
    const again = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimForAttempt({ attemptId: `late_${i}`, pairId: PAIR, maxPerPairPerDay: 3, now: NOW }),
      ),
    )
    expect(again.every((r) => !r.ok)).toBe(true)
    expect(await seqs()).toEqual([1, 2, 3])
  })
})

/**
 * Make every read of `dailyReservation` blind to `hidden` while `fn` runs: a read taken before
 * those rows were written. The create is untouched, so the unique index still sees everything —
 * which is the whole claim under test: a stale read may choose badly, and the write still holds
 * the cap.
 */
async function withStaleReads<T>(hidden: readonly string[], fn: () => Promise<T>): Promise<T> {
  const delegate = prisma.dailyReservation as unknown as Record<string, (args?: { where?: object }) => Promise<unknown>>
  const methods = ['count', 'findFirst', 'findMany', 'aggregate'] as const
  const real = Object.fromEntries(methods.map((m) => [m, delegate[m]!.bind(delegate)]))
  for (const m of methods) {
    delegate[m] = (args?: { where?: object }) =>
      real[m]!({ ...(args ?? {}), where: { AND: [args?.where ?? {}, { id: { notIn: [...hidden] } }] } })
  }
  try {
    return await fn()
  } finally {
    for (const m of methods) delegate[m] = real[m]!
  }
}

describe('a stale read cannot buy a row past the cap (the overshoot, deterministic)', () => {
  it.each([2, 5])('cap %i: positions 1..cap held, one invisible to the claimer — no row past the cap', async (limit) => {
    // limit - 1 claims this claimer can see, and the last position taken by a concurrent
    // claimer whose create landed after this claimer read.
    for (let i = 0; i < limit - 1; i++) {
      const r = await claimForAttempt({ attemptId: `seen_${i}`, pairId: PAIR, maxPerPairPerDay: limit, now: NOW })
      if (!r.ok) throw new Error('setup: should have been admitted')
    }
    const concurrent = await prisma.dailyReservation.create({
      data: { day: istDateKey(NOW), scope: 'pair', subjectId: PAIR, seq: limit, attemptId: 'concurrent' },
    })

    const stale = await withStaleReads([concurrent.id], () =>
      claimForAttempt({ attemptId: 'stale', pairId: PAIR, maxPerPairPerDay: limit, now: NOW }),
    )

    // THE POINT: `limit` rows, never `limit + 1`, however stale the claimer's count was.
    const held = await seqs()
    expect(held, `rows held: ${JSON.stringify(held)}`).toHaveLength(limit)
    expect(Math.max(...held)).toBeLessThanOrEqual(limit)
    // It did not get through, and it says it lost races rather than that the cap was spent —
    // from where it stood the cap was NOT spent, which is exactly what a stale read means.
    if (stale.ok) throw new Error(`a stale claimer was admitted past a full cap: ${JSON.stringify(stale.held)}`)
    expect(stale.reason).toBe('pair-daily-cap')
    expect(stale.contended).toBe(true)
  })

  it('a stale claimer with a slot genuinely free defers at worst, and the slot is taken once the read is fresh', async () => {
    // Cap 3: seq 1 seen, seq 2 taken concurrently and invisible, seq 3 really free. Blind to
    // seq 2 for its whole run, the claimer keeps choosing 2 and colliding, so it ends contended:
    // the cost of a stale read is one deferred draft, never a row past the cap. (A real read is
    // stale for one statement, not twelve — the next re-read sees seq 2 and takes 3.)
    await claimForAttempt({ attemptId: 'seen_0', pairId: PAIR, maxPerPairPerDay: 3, now: NOW })
    const concurrent = await prisma.dailyReservation.create({
      data: { day: istDateKey(NOW), scope: 'pair', subjectId: PAIR, seq: 2, attemptId: 'concurrent' },
    })
    await withStaleReads([concurrent.id], () =>
      claimForAttempt({ attemptId: 'stale', pairId: PAIR, maxPerPairPerDay: 3, now: NOW }),
    )
    const held = await seqs()
    expect(held.length).toBeLessThanOrEqual(3)
    expect(Math.max(...held)).toBeLessThanOrEqual(3)
    // And once the read is fresh again, the free slot is taken and the cap is exactly full.
    await claimForAttempt({ attemptId: 'fresh', pairId: PAIR, maxPerPairPerDay: 3, now: NOW })
    expect(await seqs()).toEqual([1, 2, 3])
  })
})

describe('a released position is taken again (the documented livelock stays fixed)', () => {
  /**
   * Seq 1 released, seq 2 held: `used` is 1. The first version derived the seq from `used + 1`,
   * retried the occupied seq 2 twelve times and reported "contended" against a cap with a free
   * slot — found by running the real client. The lowest free POSITION is 1, so it is reclaimed.
   */
  it('claims seq 1 back when seq 1 was released and seq 2 is still held', async () => {
    const first = await claimForAttempt({ attemptId: 'a1', pairId: PAIR, maxPerPairPerDay: 2, now: NOW })
    const second = await claimForAttempt({ attemptId: 'a2', pairId: PAIR, maxPerPairPerDay: 2, now: NOW })
    if (!first.ok || !second.ok) throw new Error('setup: both should have been admitted')
    expect(first.held.map((h) => h.seq)).toEqual([1])

    await releaseReservation(first.held[0]!.id)
    expect(await seqs()).toEqual([2])

    const again = await claimForAttempt({ attemptId: 'a3', pairId: PAIR, maxPerPairPerDay: 2, now: NOW })
    if (!again.ok) throw new Error(`expected a reservation, got ${again.reason}: ${again.detail}`)
    expect(again.held.map((h) => h.seq)).toEqual([1])
    expect(await seqs()).toEqual([1, 2])

    // ...and full again — the reclaimed slot is one slot, not a way past the cap.
    const fourth = await claimForAttempt({ attemptId: 'a4', pairId: PAIR, maxPerPairPerDay: 2, now: NOW })
    expect(fourth.ok).toBe(false)
  })
})

describe('a cap reached in sequence refuses by name', () => {
  it('admits 3 with a limit of 3, and the 4th is cap-reached with used=3', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 3, now: NOW })
      if (!r.ok) throw new Error(`claim ${i} refused: ${r.reason}`)
      expect(r.reservation?.seq).toBe(i)
    }
    const fourth = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 3, now: NOW })
    expect(fourth).toEqual({ ok: false, reason: 'cap-reached', used: 3, limit: 3 })
  })

  it('claimForAttempt reports a REACHED cap under the gate stop, NOT marked contended', async () => {
    for (let i = 0; i < 3; i++) {
      await claimForAttempt({ attemptId: `seq_${i}`, pairId: PAIR, maxPerPairPerDay: 3, now: NOW })
    }
    const refused = await claimForAttempt({ attemptId: 'seq_3', pairId: PAIR, maxPerPairPerDay: 3, now: NOW })
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.reason).toBe('pair-daily-cap')
    expect(refused.contended).toBe(false)
    expect(refused.detail).toContain('3 message(s) today (limit 3)')
  })

  it('Infinity writes no row and a limit below 1 admits nothing', async () => {
    expect(await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: Number.POSITIVE_INFINITY, now: NOW })).toEqual({
      ok: true,
      reservation: null,
    })
    expect(await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 0, now: NOW })).toEqual({
      ok: false,
      reason: 'cap-reached',
      used: 0,
      limit: 0,
    })
    expect(await seqs()).toEqual([])
  })
})

/**
 * Make every `create` of one bucket LOSE: the instant before the claimer's own create lands,
 * another claimer takes that very position (a real row, through the real client, so the unique
 * index refuses the claimer's create exactly as a lost race would). Parameterised by bucket; every
 * case that forces a lost race by stealing the position at create time uses it (the stale-read
 * cases lose theirs through `withStaleReads` instead) — the pair's contended case below once
 * inlined its own copy.
 *
 * `releaseUntil` makes the thief GIVE BACK its row after the claimer's create has failed, for its
 * first N thefts — a send that took a position and then failed in a way that releases it — so the
 * claimer's next read sees room again. The (N+1)th theft is kept.
 */
async function withThief<T>(
  bucket: { scope: string; subjectId: string },
  fn: () => Promise<T>,
  opts: { releaseUntil?: number } = {},
): Promise<{ result: T; thefts: number }> {
  const delegate = prisma.dailyReservation
  const realCreate = delegate.create.bind(delegate)
  let thefts = 0
  ;(delegate as unknown as { create: typeof delegate.create }).create = (async (args: Parameters<typeof delegate.create>[0]) => {
    const data = args.data as { day: string; scope: string; subjectId: string; seq: number }
    if (data.scope !== bucket.scope || data.subjectId !== bucket.subjectId) return realCreate(args)
    thefts += 1
    const stolen = await realCreate({
      data: { day: data.day, scope: data.scope, subjectId: data.subjectId, seq: data.seq, attemptId: `thief_${thefts}` },
    })
    try {
      return await realCreate(args)
    } catch (e) {
      if (thefts <= (opts.releaseUntil ?? 0)) await releaseReservation(stolen.id)
      throw e
    }
  }) as unknown as typeof delegate.create
  try {
    return { result: await fn(), thefts }
  } finally {
    ;(delegate as unknown as { create: typeof delegate.create }).create = realCreate
  }
}

describe('a contended claim does not wear the cap sentence', () => {
  /**
   * With every position free but every create losing, the claim exhausts its attempts. That is
   * NOT a reached cap — nothing was sent, the conversation had room — so the hold must say so:
   * `contended: true` and a detail the dispatcher's hold log shows as contention. The reason
   * stays the bucket's name so `deliverOne`'s routing (a fleet bucket ends the tick) is
   * unchanged. Forced deterministically by occupying each position the instant before the
   * claimer's own create lands, which is exactly what losing every race looks like.
   */
  it('reports contention with contended: true and the contention prefix', async () => {
    // Before each of the claimer's creates, another claimer takes that very position first.
    const { result: r } = await withThief({ scope: 'pair', subjectId: PAIR }, () =>
      claimForAttempt({ attemptId: 'loser', pairId: PAIR, maxPerPairPerDay: 50, now: NOW }),
    )
    if (r.ok) throw new Error('expected contention')
    expect(r.reason).toBe('pair-daily-cap')
    expect(r.contended).toBe(true)
    expect(r.detail.startsWith(reservations.CLAIM_CONTENDED_PREFIX)).toBe(true)
    expect(r.detail).not.toContain('already sent')
    // Every row is a thief's: the loser holds nothing, and nothing past the cap was written.
    const rows = await prisma.dailyReservation.findMany({ where: { subjectId: PAIR }, select: { attemptId: true, seq: true } })
    expect(rows.some((r) => r.attemptId === 'loser')).toBe(false)
    expect(Math.max(...rows.map((r) => r.seq))).toBeLessThanOrEqual(50)
  })
})

describe('out of attempts with the cap full is a REACHED cap, not contention (review of 01576f4)', () => {
  /**
   * `reserveDaily` gives up after MAX_CLAIM_ATTEMPTS (12) lost races, and its give-up path used to
   * return `contended` without asking whether the count it had just taken reached the cap. With a
   * limit of 12 or more a loser can spend all twelve iterations while the cap fills and never reach
   * the 13th read that would say so; with releases between its retries it can happen at any limit.
   * The hold then read "(12 of 12 used, so the cap is NOT reached)" — false, and about the one
   * ceiling nobody may cross.
   *
   * MUTATION, applied by hand once and seen red, then restored: delete the post-loop
   * `if (used >= cap) return { ok: false, reason: 'cap-reached', … }` → exactly the six cases
   * that end with the cap full go red, each reading `contended`: concurrent 13/12 and 20/12, the
   * thief at limit 12, the thief at limit 12.5 and the releasing thief at limit 1 (this block), and
   * "fleet day: twelve races lost while the day cap of 12 filled" (the next one). The limit-11
   * control, the keep-nothing control and the guard's unit case stay green, which is what they are
   * for. (Comparing `used >= limit` there instead of deleting it is a separate mutation, recorded on
   * the 12.5 case.)
   */
  it.each([
    { n: 13, limit: 12 },
    { n: 20, limit: 12 },
  ])('$n claimers at once against a cap of $limit: every loser is cap-reached with used $limit, none says "NOT reached"', async ({ n, limit }) => {
    /*
     * DETERMINISTIC ON SQLITE, MEASURED: `Promise.all` lockstep — round k, every live claimer reads
     * k-1 rows and tries seq k, one wins. With 13+ claimers the last round is the 12th, so every
     * loser exhausts its attempts with 12 rows held. At 01576f4, 10 runs each of 13, 14, 20 and 25
     * claimers against 12 gave the same answer every time: 12 rows, 12 winners, EVERY loser
     * `contended` with "(12 of 12 used, so the cap is NOT reached)". The control below is why the
     * docblock says "12 or more": at 11 the loser still has a 12th read and sees the cap.
     * That determinism is SQLite's scheduling, not the code's: the thief cases below, not these,
     * are the deterministic guard; these are the realistic shape.
     */
    const results = await claimConcurrently(n, limit)
    expect(await seqs()).toEqual(Array.from({ length: limit }, (_, i) => i + 1))
    const refused = results.filter((r) => !r.ok)
    expect(refused).toHaveLength(n - limit)
    for (const r of refused) {
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('pair-daily-cap')
      expect(r.contended, r.detail).toBe(false)
      expect(r.detail).toBe(`this account has already sent this recipient ${limit} message(s) today (limit ${limit})`)
      expect(r.detail).not.toContain('NOT reached')
    }
  })

  it('control: 13 claimers against 11 — the loser still had a 12th read and saw the cap in the loop', async () => {
    const results = await claimConcurrently(13, 11)
    const refused = results.filter((r) => !r.ok)
    expect(refused).toHaveLength(2)
    for (const r of refused) if (!r.ok) expect(r.contended).toBe(false)
  })

  it('every one of twelve races lost while the cap of 12 filled: cap-reached, used 12', async () => {
    // Deterministic by construction rather than by scheduling: each position is taken by a thief
    // the instant before the claimer's create, so after twelve losses positions 1..12 are all held.
    const { result, thefts } = await withThief({ scope: 'pair', subjectId: PAIR }, () =>
      reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 12, now: NOW }),
    )
    expect(thefts).toBe(12)
    expect(result).toEqual({ ok: false, reason: 'cap-reached', used: 12, limit: 12 })
    expect(await seqs()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('the same twelve losses at a fractional limit of 12.5: the cap is floor(limit), so cap-reached, used 12', async () => {
    /*
     * The give-up recount must measure against the SAME cap the loop does — floor(limit), 12 here —
     * or twelve held rows read as 12 < 12.5, room left, and the result is `contended` over a cap
     * with no position free: the flag `deliverOne` logs as "the cap is not reached". (`contendedDetail`
     * would still keep the SENTENCE honest; the flag is this recount's job alone.) Settings are whole
     * numbers, so only a direct caller can pass 12.5; the two checks must still agree on the cap.
     *
     * MUTATION, applied by hand once and seen red, then restored: the post-loop `used >= cap` →
     * `used >= limit` → this case goes red (it reads `contended`) and no other case does — at a
     * whole limit cap and limit are the same number.
     */
    const { result, thefts } = await withThief({ scope: 'pair', subjectId: PAIR }, () =>
      reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 12.5, now: NOW }),
    )
    expect(thefts).toBe(12)
    expect(result).toEqual({ ok: false, reason: 'cap-reached', used: 12, limit: 12.5 })
    expect(await seqs()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('with releases between the retries it happens at a limit of 1: cap-reached, used 1', async () => {
    // A thief takes position 1 and gives it back after each of the claimer's first eleven losses,
    // so every re-read sees room; the twelfth theft is kept. Out of attempts, the cap is full.
    const { result, thefts } = await withThief(
      { scope: 'pair', subjectId: PAIR },
      () => reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 1, now: NOW }),
      { releaseUntil: 11 },
    )
    expect(thefts).toBe(12)
    expect(result).toEqual({ ok: false, reason: 'cap-reached', used: 1, limit: 1 })
    expect(await seqs()).toEqual([1])
  })

  it('control: the same releasing thief that keeps NOTHING leaves room — that one is genuine contention', async () => {
    const { result } = await withThief(
      { scope: 'pair', subjectId: PAIR },
      () => reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 1, now: NOW }),
      { releaseUntil: 12 },
    )
    expect(result).toEqual({ ok: false, reason: 'contended', used: 0, limit: 1 })
    expect(await seqs()).toEqual([])
  })

  it('the contended sentence cannot contradict its own count (the guard in contendedDetail)', () => {
    /*
     * Unreachable from `reserveDaily` now (a contended result is below the cap by construction), so
     * driven directly. MUTATION: make `roomLeft` always true (the sentence before this change) →
     * this case goes red, on "12 of 12" not containing "NOT reached".
     */
    const { contendedDetail, CLAIM_CONTENDED_PREFIX } = reservations
    expect(contendedDetail('for this conversation', { used: 12, limit: 12 })).not.toContain('NOT reached')
    expect(contendedDetail('for this conversation', { used: 11, limit: 12 })).toContain('11 of 12 used, so the cap is NOT reached')
    // The floor the cap is measured by: 2 of 2.5 IS a full cap.
    expect(contendedDetail('for this conversation', { used: 2, limit: 2.5 })).not.toContain('NOT reached')
    for (const used of [0, 11, 12]) {
      expect(contendedDetail('x', { used, limit: 12 }).startsWith(CLAIM_CONTENDED_PREFIX)).toBe(true)
    }
  })
})

describe('the fleet buckets say contended only when they were (contended is per bucket)', () => {
  /**
   * `claimForAttempt` builds `contended` separately for each of the three buckets, and until this
   * block only the PAIR's was driven: hardcoding `contended: false` on either fleet bucket passed
   * every test in the suite. Each bucket here is driven both ways through the real claim and the
   * real table — a contended claim (every race lost, cap NOT full) and a reached cap — and the
   * detail must start with CLAIM_CONTENDED_PREFIX exactly when `contended` is true.
   *
   * MUTATIONS, applied by hand once and seen red, then restored:
   *   - `contended: false` on the fleet DAY's refusal  → "fleet day: a contended claim…" goes red
   *   - `contended: false` on the fleet HOUR's refusal → "fleet hour: a contended claim…" goes red
   *   - `contended: true` on the fleet DAY's refusal   → "fleet day: a reached cap is contended:
   *                                                      false…" and "fleet day: twelve races lost
   *                                                      while the day cap of 12 filled…" go red
   *   - `contended: true` on the fleet HOUR's refusal  → "fleet hour: a reached pace is contended:
   *                                                      false…" goes red
   */
  const { CLAIM_CONTENDED_PREFIX, FLEET_DAY_SUBJECT, fleetHourSubject } = reservations
  const rowsOf = (subjectId: string) => prisma.dailyReservation.count({ where: { scope: 'fleet', subjectId } })

  it('fleet day: a contended claim is contended: true, under the contention prefix, and gives the pair slot back', async () => {
    const { result: r } = await withThief({ scope: 'fleet', subjectId: FLEET_DAY_SUBJECT }, () =>
      claimForAttempt({ attemptId: 'loser', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerDay: 50, now: NOW }),
    )
    if (r.ok) throw new Error('expected contention')
    expect(r.reason).toBe('fleet-daily-cap')
    expect(r.contended).toBe(true)
    expect(r.detail.startsWith(CLAIM_CONTENDED_PREFIX), r.detail).toBe(true)
    expect(r.detail).toContain('12 of 50 used, so the cap is NOT reached')
    expect(await seqs(), 'the pair slot was not given back').toEqual([])
  })

  it('fleet day: a reached cap is contended: false, and its sentence is the cap\'s', async () => {
    await claimForAttempt({ attemptId: 'first', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerDay: 1, now: NOW })
    const r = await claimForAttempt({ attemptId: 'second', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerDay: 1, now: NOW })
    if (r.ok) throw new Error('expected a refusal')
    expect(r.reason).toBe('fleet-daily-cap')
    expect(r.contended).toBe(false)
    expect(r.detail.startsWith(CLAIM_CONTENDED_PREFIX), r.detail).toBe(false)
    expect(r.detail).toBe('the fleet has already sent 1 message(s) today (limit 1)')
  })

  it('fleet day: twelve races lost while the day cap of 12 filled is the CAP, not contention', async () => {
    const { result: r } = await withThief({ scope: 'fleet', subjectId: FLEET_DAY_SUBJECT }, () =>
      claimForAttempt({ attemptId: 'loser', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerDay: 12, now: NOW }),
    )
    if (r.ok) throw new Error('expected a refusal')
    expect(r.reason).toBe('fleet-daily-cap')
    expect(r.contended).toBe(false)
    expect(r.detail).toBe('the fleet has already sent 12 message(s) today (limit 12)')
    expect(await rowsOf(FLEET_DAY_SUBJECT)).toBe(12)
  })

  it('fleet hour: a contended claim is contended: true, under the contention prefix, and gives both earlier slots back', async () => {
    const hour = fleetHourSubject(NOW)
    const { result: r } = await withThief({ scope: 'fleet', subjectId: hour }, () =>
      claimForAttempt({ attemptId: 'loser', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerDay: 50, fleetMaxPerHour: 50, now: NOW }),
    )
    if (r.ok) throw new Error('expected contention')
    expect(r.reason).toBe('fleet-hourly-pace')
    expect(r.contended).toBe(true)
    expect(r.detail.startsWith(CLAIM_CONTENDED_PREFIX), r.detail).toBe(true)
    expect(r.detail).toContain('12 of 50 used, so the cap is NOT reached')
    expect(await seqs(), 'the pair slot was not given back').toEqual([])
    expect(await rowsOf(FLEET_DAY_SUBJECT), 'the fleet-day slot was not given back').toBe(0)
  })

  it('fleet hour: a reached pace is contended: false, and its sentence is the pace\'s', async () => {
    await claimForAttempt({ attemptId: 'first', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerHour: 1, now: NOW })
    const r = await claimForAttempt({ attemptId: 'second', pairId: PAIR, maxPerPairPerDay: 5, fleetMaxPerHour: 1, now: NOW })
    if (r.ok) throw new Error('expected a refusal')
    expect(r.reason).toBe('fleet-hourly-pace')
    expect(r.contended).toBe(false)
    expect(r.detail.startsWith(CLAIM_CONTENDED_PREFIX), r.detail).toBe(false)
    expect(r.detail).toContain('1 message(s) have already gone out this hour (pace 1/hour)')
  })
})

/** Seed held rows for the pair today, as an earlier rule or a higher limit left them. */
async function seed(held: readonly number[]): Promise<string[]> {
  const ids: string[] = []
  for (const seq of held) {
    const row = await prisma.dailyReservation.create({
      data: { day: istDateKey(NOW), scope: 'pair', subjectId: PAIR, seq, attemptId: `old_${seq}` },
    })
    ids.push(row.id)
  }
  return ids
}

describe('rows outside 1..limit: the COUNT holds the cap (deploy day, a lowered limit)', () => {
  /**
   * A row outside 1..limit occupies no position, so the unique index alone would admit `limit`
   * in-range rows BESIDE it. The count (`used >= cap`) is what refuses them, and in steady state
   * it reads as redundant — `lowestFreeSeq` returns null at a full in-range cap — so it is the
   * line most likely to be "simplified" away. Every case below goes red when it is deleted
   * (applied by hand, see the file docblock), and none of the cases above does.
   *
   * The seeds are REAL shapes, not contrivances. {2,3,4,5,6} is what the old `highest + 1 + i`
   * rule wrote with no race at all — cap 5: claim 1-4 → {1,2,3,4}, release 1 → {2,3,4}, claim →
   * 5, claim → 6 — and such rows sit in today's table on deploy day. A lowered limit strands
   * rows above the new cap the same way.
   */
  it('old-rule rows {2,3,4,5,6} against a cap of 5: refused, and no 6th row is written', async () => {
    await seed([2, 3, 4, 5, 6])
    const r = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 5, now: NOW })
    expect(r).toEqual({ ok: false, reason: 'cap-reached', used: 5, limit: 5 })
    expect(await seqs()).toEqual([2, 3, 4, 5, 6])
  })

  it('old-rule rows {2,3,4,6} against a cap of 5: exactly one more (position 1), then refused', async () => {
    await seed([2, 3, 4, 6])
    const first = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 5, now: NOW })
    if (!first.ok) throw new Error(`expected one admission, got ${first.reason}`)
    expect(first.reservation?.seq).toBe(1)
    const second = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 5, now: NOW })
    expect(second).toEqual({ ok: false, reason: 'cap-reached', used: 5, limit: 5 })
    expect(await seqs()).toEqual([1, 2, 3, 4, 6])
  })

  it('rows {4,7} against a cap of 3, claimed in sequence: one admission, then refused every time', async () => {
    await seed([4, 7])
    const results = []
    for (let i = 0; i < 5; i++) results.push(await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 3, now: NOW }))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    for (const r of results.slice(1)) expect(r).toEqual({ ok: false, reason: 'cap-reached', used: 3, limit: 3 })
    expect(await seqs()).toEqual([1, 4, 7])
  })

  it('a limit lowered after a release: {1,3,4,5} against a new cap of 3 is refused outright', async () => {
    // Claimed 1..5 under a cap of 5, seq 2 released, then the cap lowered to 3. Four messages
    // are already held against a cap of three; position 2 is free and must NOT be handed out.
    const taken = []
    for (let i = 0; i < 5; i++) {
      const r = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 5, now: NOW })
      if (!r.ok || !r.reservation) throw new Error('setup: should have been admitted')
      taken.push(r.reservation)
    }
    await releaseReservation(taken.find((t) => t.seq === 2)!.id)
    expect(await seqs()).toEqual([1, 3, 4, 5])
    const r = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 3, now: NOW })
    expect(r).toEqual({ ok: false, reason: 'cap-reached', used: 4, limit: 3 })
    expect(await seqs()).toEqual([1, 3, 4, 5])
  })

  it('rows {4,7}, 8 concurrent claimers against a cap of 3: exactly one wins', async () => {
    await seed([4, 7])
    const results = await claimConcurrently(8, 3)
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await seqs()).toEqual([1, 4, 7])
  })

  it('rows {4,7} with position 1 taken concurrently and invisible: the stale claimer writes nothing', async () => {
    // The concurrency argument in `reserveDaily`'s docblock: a stale read can miss a NEW in-range
    // row, never an old one, so the position it picks is one the index already holds.
    await seed([4, 7])
    const concurrent = await prisma.dailyReservation.create({
      data: { day: istDateKey(NOW), scope: 'pair', subjectId: PAIR, seq: 1, attemptId: 'concurrent' },
    })
    const stale = await withStaleReads([concurrent.id], () =>
      claimForAttempt({ attemptId: 'stale', pairId: PAIR, maxPerPairPerDay: 3, now: NOW }),
    )
    if (stale.ok) throw new Error(`a stale claimer was admitted past a full cap: ${JSON.stringify(stale.held)}`)
    expect(stale.contended).toBe(true)
    expect(await seqs()).toEqual([1, 4, 7])
  })

  it('a fractional limit is floored for the COUNT too: {4,7} against 2.5 is refused', async () => {
    // Settings are whole numbers, so only a direct caller can pass 2.5 — but the count and the
    // position must agree on what the cap is, or used 2 < 2.5 hands out position 1 (3 rows).
    await seed([4, 7])
    const r = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 2.5, now: NOW })
    expect(r).toEqual({ ok: false, reason: 'cap-reached', used: 2, limit: 2.5 })
    expect(await seqs()).toEqual([4, 7])
  })
})

describe('a limit changed while claims are in flight: bounded by the LARGEST limit in play', () => {
  /**
   * The worked example in `reserveDaily`'s docblock, driven rather than asserted. Two claimers
   * passed DIFFERENT limits — H a snapshot of the old 5 (a dispatch tick reads settings once, before
   * the lock), B the lowered 3 — and the bound the docblock commits to is the larger one, not the
   * new one: 4 rows against a cap of 3, every one at a position ≤ 5.
   *
   * The interleaving, in real time: H reads {1,2,3}; a release frees 3; B reads {1,2}; H creates 4;
   * B creates 3. Expressed with the stale-read seam and nothing else: H runs first (its read saw
   * {1,2,3}, and its create of 4 collides with nothing whenever it lands), then the release, then B
   * with its read blind to H's row — a read taken after the release and before H's create landed.
   *
   * This pins the documented LIMITATION as much as the bound: if a post-create recount is ever
   * added, B gives its row back and this goes red — read the docblock on why that recount is half
   * of a fix before changing the expectation.
   */
  it('H at limit 5 picks 4, B at limit 3 picks 3 after a release: 4 rows, all at seq ≤ 5', async () => {
    const ids = await seed([1, 2, 3])

    // H: its read saw {1,2,3} under the old limit 5, so it chose position 4.
    const h = await reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 5, now: NOW })
    if (!h.ok || !h.reservation) throw new Error(`setup: H should have been admitted, got ${JSON.stringify(h)}`)
    expect(h.reservation.seq).toBe(4)

    // A send holding position 3 failed in a way that releases it, after H read and before B did.
    await releaseReservation(ids[2]!)

    // B: its read under the lowered limit 3 came after the release and before H's create landed,
    // so it saw {1,2} — used 2 < 3 — and chose 3.
    const b = await withStaleReads([h.reservation.id], () =>
      reserveDaily({ scope: 'pair', subjectId: PAIR, limit: 3, now: NOW }),
    )
    if (!b.ok || !b.reservation) throw new Error(`setup: B should have been admitted, got ${JSON.stringify(b)}`)
    expect(b.reservation.seq).toBe(3)

    // Both created: 4 rows against the new cap of 3 — and every one at a position ≤ 5, H's cap.
    const held = await seqs()
    expect(held).toEqual([1, 2, 3, 4])
    expect(held).toHaveLength(4)
    expect(Math.max(...held)).toBeLessThanOrEqual(5)
  })
})

describe('lowestFreeSeq — the position rule, pure', () => {
  it('takes the lowest free position and never one past the limit', () => {
    const { lowestFreeSeq } = reservations
    expect(lowestFreeSeq([], 3)).toBe(1)
    expect(lowestFreeSeq([2], 3)).toBe(1)
    expect(lowestFreeSeq([1, 2], 3)).toBe(3)
    expect(lowestFreeSeq([1, 2, 3], 3)).toBeNull()
    // Rows past the limit (written before this rule, or under a higher limit earlier today)
    // occupy no position; the COUNT binds them, and "rows outside 1..limit" above drives that
    // through the real table — this pure case alone could never fail for the count's absence.
    expect(lowestFreeSeq([4, 7], 3)).toBe(1)
    // A fractional limit is floored: 2.5 allows positions 1 and 2, never a third.
    expect(lowestFreeSeq([1, 2], 2.5)).toBeNull()
  })
})
