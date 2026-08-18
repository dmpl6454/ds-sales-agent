import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 5 — fleet pacing, driven through THE REAL `claimForAttempt`.
 *
 * ── WHY THIS DOES NOT MIRROR THE IMPLEMENTATION ───────────────────────────
 *
 * `tests/reservations.test.ts` deliberately reimplements the claim over a real table,
 * because what it tests is the CONCURRENCY PROPERTY of the unique index. That is a
 * defensible choice for that question and a dangerous one for this one: the Phase 2 test
 * copied the implementation's arithmetic and so reproduced the very livelock it was written
 * to catch — the bug was found by running the real Prisma client, not by the unit test.
 *
 * So this points the real client at a real (temporary) SQLite file and calls the real
 * exported function. What is under test is the ORDER of the three claims and the
 * all-or-nothing release, and a mirror of that logic would agree with itself no matter
 * which way round it had the buckets.
 *
 * ── 2026-08-18: THE CLAIM IS PER PAIR NOW ─────────────────────────────────
 *
 * The per-target and per-sender daily claims went with the caps they enforced ("Remove
 * all caps", Tabish). The one volume rule left is per PAIR — at most `maxPerPairPerDay`
 * from one account to one recipient per IST day — so the atomic claim is per pair too:
 * pair first, then the fleet day, then the fleet hour.
 *
 * DATABASE_URL is set before any import that reads it. `src/lib/env.ts` parses at module
 * scope and `dotenv` does not overwrite variables already present, so this wins.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-fleet-'))
const dbPath = join(dir, 'fleet.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "DailyReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "attemptId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "DailyReservation_day_scope_subjectId_seq_key"
    ON "DailyReservation"("day", "scope", "subjectId", "seq");
  CREATE INDEX "DailyReservation_day_scope_subjectId_idx"
    ON "DailyReservation"("day", "scope", "subjectId");

  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campaignId" TEXT,
    "variantId" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "hookLine" TEXT,
    "renderedBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "sentBy" TEXT,
    "threadUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "repliedAt" DATETIME,
    "replyText" TEXT,
    "replyCheckedAt" DATETIME,
    "replyHandledAt" DATETIME,
    "replyHandledBy" TEXT
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

const { claimForAttempt, fleetUsage, fleetHourSubject, FLEET_DAY_SUBJECT } = await import(
  '@/outreach/reservations'
)
const { prisma } = await import('@/lib/db')

/** A fixed instant so the IST hour bucket is deterministic: 15:00 IST. */
const NOW = new Date('2026-08-04T09:30:00.000Z')

const counts = () =>
  prisma.dailyReservation.groupBy({ by: ['scope', 'subjectId'], _count: { _all: true } })

async function rowsFor(scope: string, subjectId: string): Promise<number> {
  return prisma.dailyReservation.count({ where: { scope, subjectId } })
}

beforeEach(async () => {
  await prisma.dailyReservation.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  pairId: 'pair_alpha_to_viral',
  maxPerPairPerDay: 99,
  now: NOW,
}

describe('the fleet hourly allowance paces unattended sending', () => {
  it('permits up to the allowance and then defers', async () => {
    const first = await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerHour: 2 })
    const second = await claimForAttempt({ ...base, attemptId: 'a2', fleetMaxPerHour: 2 })
    const third = await claimForAttempt({ ...base, attemptId: 'a3', fleetMaxPerHour: 2 })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(third.ok).toBe(false)
    if (third.ok) throw new Error('unreachable')
    expect(third.reason).toBe('fleet-hourly-pace')
    // The wording has to say it WAITS, not that it was refused: nothing is dropped.
    expect(third.detail).toContain('waits for the next one')
  })

  it('writes the hour bucket under the IST hour, not the machine hour', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerHour: 2 })
    // 09:30 UTC is 15:00 IST.
    expect(fleetHourSubject(NOW)).toBe('fleet:h15')
    expect(await rowsFor('fleet', 'fleet:h15')).toBe(1)
  })

  it('an attended send skips the hourly bucket — a person is the pacing', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerHour: 1 })
    const attended = await claimForAttempt({
      ...base,
      attemptId: 'a2',
      fleetMaxPerHour: 1,
      attended: true,
    })
    expect(attended.ok).toBe(true)
    // ...and did not consume the hour's allowance either.
    expect(await rowsFor('fleet', fleetHourSubject(NOW))).toBe(1)
  })

  it('but an attended send still binds against the fleet DAY cap', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerDay: 1, attended: true })
    const second = await claimForAttempt({ ...base, attemptId: 'a2', fleetMaxPerDay: 1, attended: true })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    // A day cap is a volume ceiling and is not crossable — unlike hourly pacing.
    expect(second.reason).toBe('fleet-daily-cap')
  })
})

describe('the default is no fleet ceiling at all', () => {
  /**
   * Tabish decided: no system-wide cap. A caller that omits the fleet arguments must
   * therefore get exactly the pre-Phase-5 behaviour, not a silently applied number.
   */
  it('omitting the fleet limits claims nothing and refuses nothing', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await claimForAttempt({ ...base, attemptId: `a${i}` })
      expect(r.ok).toBe(true)
    }
    expect(await rowsFor('fleet', FLEET_DAY_SUBJECT)).toBe(0)
    expect(await rowsFor('fleet', fleetHourSubject(NOW))).toBe(0)
  })

  it('an unlimited ceiling writes no bookkeeping row', async () => {
    await claimForAttempt({
      ...base,
      attemptId: 'a1',
      maxPerPairPerDay: Number.POSITIVE_INFINITY,
      fleetMaxPerHour: Number.POSITIVE_INFINITY,
      fleetMaxPerDay: Number.POSITIVE_INFINITY,
    })
    expect(await rowsFor('fleet', FLEET_DAY_SUBJECT)).toBe(0)
    expect(await rowsFor('pair', base.pairId)).toBe(0)
  })
})

describe('all-or-nothing: a refused claim leaves NOTHING behind', () => {
  /**
   * THE PROPERTY THAT MATTERS MOST HERE.
   *
   * The pair's allowance is claimed first and the fleet's last. If a later bucket
   * refuses and the earlier one is not given back, the pair's daily allowance is
   * consumed by a message nobody sent — a cap on messages RECEIVED quietly becomes a cap
   * on ATTEMPTS MADE, and a paced fleet would lock every conversation out by lunchtime.
   * That failure is invisible: everything looks like the cap working.
   */
  it('gives the pair slot back when the fleet hour is spent', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerHour: 1 })
    const before = await rowsFor('pair', base.pairId)

    const refused = await claimForAttempt({ ...base, attemptId: 'a2', fleetMaxPerHour: 1 })
    expect(refused.ok).toBe(false)

    // Still exactly one pair claim — the refused attempt consumed none of it.
    expect(await rowsFor('pair', base.pairId)).toBe(before)
  })

  it('gives everything back when the fleet DAY cap is spent', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerDay: 1 })
    const refused = await claimForAttempt({ ...base, attemptId: 'a2', fleetMaxPerDay: 1 })
    expect(refused.ok).toBe(false)
    expect(await rowsFor('pair', base.pairId)).toBe(1)
    expect(await rowsFor('fleet', FLEET_DAY_SUBJECT)).toBe(1)
  })

  it('reports the DAY cap rather than the hour when both are spent', async () => {
    // The next hour cannot help with a day cap, so saying "wait for the next hour" is wrong.
    await claimForAttempt({ ...base, attemptId: 'a1', fleetMaxPerHour: 1, fleetMaxPerDay: 1 })
    const refused = await claimForAttempt({ ...base, attemptId: 'a2', fleetMaxPerHour: 1, fleetMaxPerDay: 1 })
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.reason).toBe('fleet-daily-cap')
  })

  it('does not consume a fleet slot when the PAIR cap refuses first', async () => {
    await claimForAttempt({ ...base, attemptId: 'a1', maxPerPairPerDay: 1, fleetMaxPerHour: 5 })
    const refused = await claimForAttempt({ ...base, attemptId: 'a2', maxPerPairPerDay: 1, fleetMaxPerHour: 5 })
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.reason).toBe('pair-daily-cap')
    // One send happened, so exactly one hour slot is used — not two.
    expect(await rowsFor('fleet', fleetHourSubject(NOW))).toBe(1)
  })
})

describe('a retry reuses its own reservations', () => {
  /**
   * The cap is on messages a person RECEIVES, not on how many times we tried to send one.
   * A tick that fails and is retried must not consume a second unit of anything — least of
   * all a second unit of the fleet's hourly pace, which would let a run of failures starve
   * the hour.
   */
  it('claiming twice for the same attempt is idempotent across every bucket', async () => {
    const first = await claimForAttempt({ ...base, attemptId: 'retry_me', fleetMaxPerHour: 1, fleetMaxPerDay: 5 })
    expect(first.ok).toBe(true)

    const again = await claimForAttempt({ ...base, attemptId: 'retry_me', fleetMaxPerHour: 1, fleetMaxPerDay: 5 })
    expect(again.ok).toBe(true)

    const grouped = await counts()
    expect(grouped.length).toBeGreaterThan(0)
    for (const g of grouped) {
      expect(g._count._all, `${g.scope}/${g.subjectId} should hold one row`).toBe(1)
    }
  })
})

describe('fleetUsage counts what was actually DELIVERED', () => {
  /**
   * Counted from `OutreachAttempt` since 2026-08-18, not from reservation rows. With the
   * fleet buckets unlimited by default, an unlimited cap writes NO bookkeeping row — by
   * design — so a count of reservation rows would read 0 forever while messages went out:
   * a number that quietly stops meaning what its label says, which is the exact
   * `MAX_TOTAL_SENDS` failure (a limit reported by a different rule than the one
   * enforcing it reads as headroom).
   */
  async function delivered(id: string, sentAt: Date, status = 'SENT') {
    await prisma.outreachAttempt.create({
      data: {
        id,
        pairId: base.pairId,
        senderId: 's_alpha',
        targetId: 't_viral',
        variantId: 'v_1',
        touchNumber: 1,
        renderedBody: 'body',
        status,
        sentAt,
      },
    })
  }

  /**
   * IST is UTC+05:30, so the hour boundary sits at :30 UTC. NOW (09:30:00Z) is EXACTLY
   * 15:00:00 IST — the very first instant of the hour — which is why usage is read a
   * quarter of an hour later: rows before 09:30Z belong to the PREVIOUS IST hour. (This
   * file pins TZ=Asia/Kolkata at the top; the hour floor is local time.)
   */
  const USAGE_NOW = new Date('2026-08-04T09:45:00.000Z') // 15:15 IST

  it('counts the hour and the day separately, and a reply cannot LOWER the count', async () => {
    await delivered('a1', new Date('2026-08-04T09:35:00.000Z'), 'SENT')
    await delivered('a2', new Date('2026-08-04T09:40:00.000Z'), 'REPLIED')
    const usage = await fleetUsage(USAGE_NOW)
    expect(usage.thisHour).toBe(2)
    expect(usage.today).toBe(2)
  })

  it('an earlier hour does not count toward this hour, but does toward today', async () => {
    await delivered('a1', new Date('2026-08-04T09:20:00.000Z')) // 14:50 IST — the hour before
    await delivered('a2', new Date('2026-08-04T09:40:00.000Z')) // 15:10 IST — this hour

    const usage = await fleetUsage(USAGE_NOW)
    expect(usage.thisHour).toBe(1)
    expect(usage.today).toBe(2)
  })

  /** Only what a recipient actually received counts — a parked failure is not a send. */
  it('does not count drafts or failures, whatever their timestamps say', async () => {
    await delivered('a1', new Date('2026-08-04T09:35:00.000Z'), 'FAILED')
    await delivered('a2', new Date('2026-08-04T09:40:00.000Z'), 'READY')
    const usage = await fleetUsage(USAGE_NOW)
    expect(usage.thisHour).toBe(0)
    expect(usage.today).toBe(0)
  })
})
