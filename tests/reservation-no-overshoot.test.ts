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
    const delegate = prisma.dailyReservation
    const realCreate = delegate.create.bind(delegate)
    let stolen = 0
    // Before each of the claimer's creates, another claimer takes that very position first.
    ;(delegate as unknown as { create: typeof delegate.create }).create = (async (args: Parameters<typeof delegate.create>[0]) => {
      const seq = (args.data as { seq: number }).seq
      stolen += 1
      await realCreate({ data: { day: (args.data as { day: string }).day, scope: 'pair', subjectId: PAIR, seq, attemptId: `thief_${stolen}` } })
      return realCreate(args)
    }) as unknown as typeof delegate.create
    try {
      const r = await claimForAttempt({ attemptId: 'loser', pairId: PAIR, maxPerPairPerDay: 50, now: NOW })
      if (r.ok) throw new Error('expected contention')
      expect(r.reason).toBe('pair-daily-cap')
      expect(r.contended).toBe(true)
      expect(r.detail.startsWith(reservations.CLAIM_CONTENDED_PREFIX)).toBe(true)
      expect(r.detail).not.toContain('already sent')
    } finally {
      ;(delegate as unknown as { create: typeof delegate.create }).create = realCreate
    }
    // Every row is a thief's: the loser holds nothing, and nothing past the cap was written.
    const rows = await prisma.dailyReservation.findMany({ where: { subjectId: PAIR }, select: { attemptId: true, seq: true } })
    expect(rows.some((r) => r.attemptId === 'loser')).toBe(false)
    expect(Math.max(...rows.map((r) => r.seq))).toBeLessThanOrEqual(50)
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
