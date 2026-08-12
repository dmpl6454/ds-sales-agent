import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 2 — the per-recipient envelope, proven against a REAL database.
 *
 * Mocks cannot test this. The whole claim is that a unique index makes two concurrent
 * callers resolve to one winner, and a mocked `create` that never enforces uniqueness
 * would pass every assertion below while the real thing flooded an inbox. So this runs
 * against a real SQLite file with the real index.
 *
 * The property under test is the one rotation depends on: `cooldownDays` is PER PAIR, so
 * 63 senders rotating through one category can message a recipient every single day
 * without any pair breaking its 7-day spacing. This table is the only thing that stops it.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-res-'))
const dbPath = join(dir, 'res.db')
const db = new Database(dbPath)

db.exec(`
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
`)

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The claim, reimplemented over the real table with the real unique index.
 *
 * Deliberately mirrors `reserveDaily` rather than importing it: importing would drag in
 * the Prisma client and the app's own database. What is being tested is the CONCURRENCY
 * PROPERTY of the index, and this exercises exactly the statement that provides it.
 */
function claim(day: string, scope: string, subjectId: string, limit: number): number | null {
  for (let i = 0; i < 12; i++) {
    /**
     * TWO DIFFERENT NUMBERS, mirroring `reserveDaily`. Conflating them was a real bug:
     * `used` measures the CAP, `highest + 1` picks a free SEQ. With seq 1 released and
     * seq 2 still held they diverge, and using `used + 1` for both retried an occupied
     * seq until it gave up — reporting "contended" against a cap with a free slot.
     */
    const used = (
      db
        .prepare('SELECT count(*) AS n FROM DailyReservation WHERE day=? AND scope=? AND subjectId=?')
        .get(day, scope, subjectId) as { n: number }
    ).n
    const highest = (
      db
        .prepare('SELECT max(seq) AS m FROM DailyReservation WHERE day=? AND scope=? AND subjectId=?')
        .get(day, scope, subjectId) as { m: number | null }
    ).m
    if (used >= limit) return null
    const seq = (highest ?? 0) + 1 + i
    try {
      db.prepare('INSERT INTO DailyReservation (id, day, scope, subjectId, seq) VALUES (?,?,?,?,?)').run(
        `r${Math.floor(Math.random() * 1e12)}_${i}`,
        day,
        scope,
        subjectId,
        seq,
      )
      return seq
    } catch {
      // Lost the race for this seq — the winner is sending. Walk past it.
    }
  }
  return null
}

beforeEach(() => db.exec('DELETE FROM DailyReservation'))

describe('the unique index is what makes the claim atomic', () => {
  it('lets exactly one caller take a given seq', () => {
    const insert = () =>
      db
        .prepare('INSERT INTO DailyReservation (id, day, scope, subjectId, seq) VALUES (?,?,?,?,1)')
        .run(`id${Math.random()}`, '2026-08-04', 'target', 'viralbhayani')

    expect(() => insert()).not.toThrow()
    // THE POINT. A second caller computing the same seq from the same stale count is
    // refused by the database, not by a comparison it also passed.
    expect(() => insert()).toThrow()
  })

  it('scopes the claim per day, per scope and per subject', () => {
    expect(claim('2026-08-04', 'target', 'a', 1)).toBe(1)
    expect(claim('2026-08-04', 'target', 'a', 1)).toBeNull() // same subject, same day: full
    expect(claim('2026-08-05', 'target', 'a', 1)).toBe(1) // next day: free again
    expect(claim('2026-08-04', 'target', 'b', 1)).toBe(1) // different subject: free
    expect(claim('2026-08-04', 'sender', 'a', 1)).toBe(1) // different scope: free
  })
})

describe('a cap of N admits exactly N', () => {
  it.each([1, 2, 5])('admits %i and then refuses', (limit) => {
    const got: (number | null)[] = []
    for (let i = 0; i < limit + 3; i++) got.push(claim('2026-08-04', 'target', 'viralbhayani', limit))
    expect(got.filter((g) => g !== null)).toHaveLength(limit)
    expect(got.slice(limit)).toEqual(Array(3).fill(null))
  })

  /**
   * THE FLEET SCENARIO, and the reason this phase precedes rotation.
   *
   * 63 different senders, each perfectly within its own 7-day per-pair cooldown, each
   * targeting the same inbox on the same day. Without this table all 63 pass every
   * existing rule. Measured volume on @viralbhayani is 11-14 paid posts a day, so this
   * is not a thought experiment.
   */
  it('holds one recipient to its cap against 63 different senders in one day', () => {
    const results = Array.from({ length: 63 }, () => claim('2026-08-04', 'target', 'viralbhayani', 2))
    expect(results.filter((r) => r !== null)).toHaveLength(2)
    expect(results.filter((r) => r === null)).toHaveLength(61)
  })

  /** ...and the other direction, or "safe" would just mean "nothing ever sends". */
  it('lets all 63 through when the cap is raised to match', () => {
    const results = Array.from({ length: 63 }, () => claim('2026-08-04', 'target', 'viralbhayani', 63))
    expect(results.filter((r) => r !== null)).toHaveLength(63)
    expect(new Set(results)).toHaveLength(63) // every seq distinct — no double-claim
  })
})

describe('releasing', () => {
  const release = (seq: number) =>
    db
      .prepare('DELETE FROM DailyReservation WHERE day=? AND scope=? AND subjectId=? AND seq=?')
      .run('2026-08-04', 'target', 'a', seq)

  it('gives the slot back so a failed send does not lock a recipient out for the day', () => {
    expect(claim('2026-08-04', 'target', 'a', 1)).toBe(1)
    expect(claim('2026-08-04', 'target', 'a', 1)).toBeNull()
    release(1)
    expect(claim('2026-08-04', 'target', 'a', 1)).toBe(1)
  })

  /**
   * THE CASE THAT CAUGHT A REAL BUG, and only when run against a real database.
   *
   * Release the FIRST of two claims and the count (1) no longer matches the highest seq
   * (2). Deriving the next seq from the count then retries an occupied number until it
   * gives up, and reports "too contended" about a cap that has a slot free. Verified
   * against the live Prisma client — `reserveDaily` returned `contended` where it should
   * have returned a reservation.
   *
   * The unit test could not have found it on its own: this helper originally
   * reimplemented the same arithmetic, so it reproduced the bug faithfully.
   */
  it('reclaims a released slot when a LATER seq is still held', () => {
    expect(claim('2026-08-04', 'target', 'a', 2)).toBe(1)
    expect(claim('2026-08-04', 'target', 'a', 2)).toBe(2)
    expect(claim('2026-08-04', 'target', 'a', 2)).toBeNull() // full

    release(1) // the gap: count is 1, highest seq is 2

    const again = claim('2026-08-04', 'target', 'a', 2)
    expect(again).not.toBeNull()
    expect(again).toBeGreaterThan(2) // a fresh seq, not the recycled 1
    expect(claim('2026-08-04', 'target', 'a', 2)).toBeNull() // and full again
  })
})
