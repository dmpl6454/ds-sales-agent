import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { mayPrunePair } from '@/outreach/prunePairs'

const ROOT = resolve(__dirname, '..')

/**
 * ── DELETING A ROUTE CAN DELETE SEND HISTORY, AND THAT IS THE WHOLE TEST ──────────────
 *
 * `OutreachAttempt.pairId` is `ON DELETE CASCADE`, so a pair delete takes every attempt on
 * it. Attempts are the record of what real people received, and spacing, the
 * unanswered-touch cap and the new-material rule are all derived from that record — so a
 * cascade does not merely lose history, it lets the system write to someone it has already
 * written to and never know.
 *
 * MEASURED: 0 of the burner's 72 pair rows carry an attempt, so the clean-up is safe today.
 * The refusal below is deliberately NOT a statement about today's data. "It happens to be
 * empty" is what a guard is for, not a substitute for one.
 */
describe('mayPrunePair — a route with history is never deleted', () => {
  it('prunes a route belonging to an account outside the rotation, with nothing recorded', () => {
    expect(mayPrunePair({ senderIsFleetMember: false, attemptCount: 0 })).toEqual({ prune: true })
  })

  it('REFUSES a route that carries even one recorded message', () => {
    const v = mayPrunePair({ senderIsFleetMember: false, attemptCount: 1 })
    expect(v.prune).toBe(false)
    if (!v.prune) expect(v.refusal).toBe('pair-carries-send-history')
  })

  /**
   * EVERY status counts, not just delivered ones. A `FAILED` attempt parked by
   * `not-in-thread` is precisely the row a person still has to settle — the recipient may
   * hold that message — and a `READY` draft is a message about to be sent. Counting only
   * `SENT`/`REPLIED` would read both as "no history" and cascade them away.
   */
  it('counts attempts of any status — the count is the whole question', () => {
    for (const n of [1, 2, 70]) {
      expect(mayPrunePair({ senderIsFleetMember: false, attemptCount: n }).prune, `${n} attempts`).toBe(false)
    }
  })

  it('refuses a FLEET account’s route, and says so rather than blaming history', () => {
    const v = mayPrunePair({ senderIsFleetMember: true, attemptCount: 0 })
    expect(v.prune).toBe(false)
    // Reported reason must be the actionable one: a fleet route is not a mistake to clean
    // up, it is recreated on the next pass, so "it has history" would send a person looking
    // at entirely the wrong thing.
    if (!v.prune) expect(v.refusal).toBe('sender-is-in-the-fleet')
  })

  it('the fleet check wins even when there is also history, so the advice is not misleading', () => {
    const v = mayPrunePair({ senderIsFleetMember: true, attemptCount: 5 })
    if (!v.prune) expect(v.refusal).toBe('sender-is-in-the-fleet')
  })

  it('every refusal explains itself in a sentence a person can read', () => {
    for (const q of [
      { senderIsFleetMember: false, attemptCount: 3 },
      { senderIsFleetMember: true, attemptCount: 0 },
    ]) {
      const v = mayPrunePair(q)
      expect(v.prune).toBe(false)
      if (!v.prune) {
        expect(v.detail.length).toBeGreaterThan(40)
        expect(v.detail).not.toMatch(/[a-z]_[a-z]|\bpairId\b|\bfleetMember\b/)
      }
    }
  })
})

/**
 * ── AND THE COMMAND MUST NOT RE-INTRODUCE THE CHECK-THEN-WRITE ────────────────────────
 *
 * The pure rule above is asked against a count read in a survey pass. That count is stale
 * by the time the delete runs, so the delete carries the condition ITSELF
 * (`attempts: { none: {} }` in the `where`), making check and write one statement. This
 * repo has produced the two-statement version three times — `sendNow`'s idempotency, the
 * first slot lock, and the per-target cap before `DailyReservation` — and each time it was
 * only found by running it.
 *
 * A source assertion because no unit test can fail for a race that needs two processes.
 */
describe('the prune command deletes conditionally, never after a separate check', () => {
  const src = readFileSync(join(ROOT, 'src/scripts/prune-pairs.ts'), 'utf8')

  it('scopes the delete on the absence of attempts in the same statement', () => {
    expect(src).toMatch(/deleteMany\(\{\s*where:\s*\{[^}]*attempts:\s*\{\s*none:\s*\{\}\s*\}/s)
  })

  it('never uses a bare delete that could reach a pair with history', () => {
    expect(src).not.toMatch(/outreachPair\.delete\s*\(/)
  })

  it('is a dry run unless --run is typed', () => {
    expect(src).toMatch(/const run = args\.includes\('--run'\)/)
  })

  it('audits every removal, because a row that is gone leaves no other trace', () => {
    expect(src).toMatch(/auditLog\.create/)
    expect(src).toMatch(/pair\.pruned/)
  })
})
