import { describe, it, expect } from 'vitest'
import { mayArmCohort, cohortForNewAccount, type CohortState } from '@/outreach/cohorts'

/**
 * Phase 9 is the only phase that actually changes exposure: 4 sending accounts become 65, all
 * driving one code path from one residential IP against overlapping recipients. The ladder is
 * the mechanism that stops that happening in one step, so every rung is asserted in BOTH
 * directions — blocking and permitting — and with LITERAL dates rather than arithmetic derived
 * from the exported constants.
 *
 * That last point is not pedantry. A Phase 2 test reproduced the bug it was meant to catch by
 * copying the implementation's arithmetic, and a Phase 5 test did it again with a boundary
 * computed from the exported thresholds. A test that recomputes the rule agrees with a wrong
 * rule.
 */

const NOW = new Date('2026-09-01T12:00:00Z')

function state(cohort: number, over: Partial<CohortState> = {}): CohortState {
  return {
    cohort,
    members: [],
    live: 1,
    everChallenged: 0,
    soakStartedAt: new Date('2026-08-01T12:00:00Z'), // 31 days before NOW
    soakDays: 31,
    ...over,
  }
}

describe('cohort 1 is the baseline', () => {
  /**
   * The four accounts that predate the ladder must not be retroactively disarmed. One of them
   * has done every send this project has ever made; a mechanism that switched them off would
   * be a gate nobody chose.
   */
  it('is always armable, even with nothing else in the system', () => {
    expect(mayArmCohort({ cohort: 1, states: [], soakDays: 14, now: NOW })).toEqual({
      ok: true,
      reason: 'baseline',
    })
  })

  it('is armable even when it has itself been flagged', () => {
    const r = mayArmCohort({ cohort: 1, states: [state(1, { everChallenged: 1 })], soakDays: 14, now: NOW })
    expect(r.ok).toBe(true)
  })
})

describe('a cohort waits for the one before it', () => {
  it('permits cohort 2 once cohort 1 has soaked long enough', () => {
    const r = mayArmCohort({ cohort: 2, states: [state(1)], soakDays: 14, now: NOW })
    expect(r).toEqual({ ok: true, reason: 'previous-cohort-cleared' })
  })

  /** A rung cannot be skipped by leaving it empty. */
  it('refuses cohort 3 when cohort 2 has nothing armed', () => {
    const r = mayArmCohort({ cohort: 3, states: [state(1), state(2, { live: 0 })], soakDays: 14, now: NOW })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-not-live' })
  })

  it('refuses when the previous cohort does not exist at all', () => {
    const r = mayArmCohort({ cohort: 3, states: [state(1)], soakDays: 14, now: NOW })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-not-live' })
  })

  /**
   * ARMED BUT NEVER SENT IS NOT OBSERVED. Without this, thirteen rungs could be climbed in a
   * fortnight by arming accounts that never delivered anything — the same "freshness is not
   * liveness" mistake as reading a heartbeat's age and calling it a running process.
   */
  it('refuses when the previous cohort is armed but has delivered nothing', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: null, soakDays: 0 })],
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-still-soaking' })
    if (!r.ok) expect(r.detail).toContain('has not sent anything yet')
  })
})

describe('the soak boundary', () => {
  // NOW is 2026-09-01T12:00:00Z. Literal dates, so the test cannot agree with wrong arithmetic.
  it('refuses at 13 days', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-08-19T12:00:00Z') })], // 13 days
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('13 of 14 days')
  })

  it('permits at exactly 14 days', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-08-18T12:00:00Z') })], // 14 days
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })

  it('refuses one hour before the boundary', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-08-18T13:00:00Z') })], // 13d 23h
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(false)
  })

  /** A soak of 0 means the ladder is off, and it must genuinely be off rather than nearly. */
  it('permits immediately when the soak is set to 0', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-09-01T11:59:00Z') })],
      soakDays: 0,
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })
})

/**
 * ── a checkpoint anywhere earlier stops the ladder ────────────────────────
 *
 * `everChallenged`, not "currently challenged". A checkpoint that was cleared still happened,
 * and all 65 accounts drive one code path from one IP, so it is evidence about the PATTERN
 * rather than about the account. Clearing a halt un-blocks that account's own sending; it must
 * not also buy permission to add five more.
 */
describe('a flagged account stops the ladder', () => {
  it('refuses when the immediately previous cohort was flagged', () => {
    const r = mayArmCohort({ cohort: 2, states: [state(1, { everChallenged: 1 })], soakDays: 14, now: NOW })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-flagged' })
  })

  /** Not just the previous one — ANY earlier cohort. */
  it('refuses cohort 4 when cohort 1 was flagged, even with 2 and 3 clean', () => {
    const r = mayArmCohort({
      cohort: 4,
      states: [state(1, { everChallenged: 1 }), state(2), state(3)],
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-flagged' })
  })

  it('does not care about a LATER cohort being flagged', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1), state(2), state(3, { everChallenged: 1 })],
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })

  /** The permitting direction, so the refusals above are not vacuous. */
  it('permits when nothing anywhere has been flagged', () => {
    const r = mayArmCohort({ cohort: 4, states: [state(1), state(2), state(3)], soakDays: 14, now: NOW })
    expect(r.ok).toBe(true)
  })

  /**
   * A flag outranks the soak, and it is checked FIRST so the message a person reads names the
   * real problem. Telling someone "3 more days to go" when an account has been challenged
   * would send them back in three days to the same refusal.
   */
  it('reports the flag rather than the soak when both apply', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { everChallenged: 1, soakStartedAt: new Date('2026-08-30T12:00:00Z') })],
      soakDays: 14,
      now: NOW,
    })
    expect(r).toMatchObject({ reason: 'previous-cohort-flagged' })
  })
})

/**
 * A cohort is FILLED before the next opens. Opening one per account would make the ladder
 * meaningless: 61 cohorts of one, each waiting 14 days, is 2.3 years.
 */
describe('cohortForNewAccount', () => {
  it('starts at 1 when there is nothing', () => {
    expect(cohortForNewAccount({ existingCounts: new Map(), cohortSize: 5 })).toBe(1)
  })

  it('opens cohort 2 when only the baseline exists', () => {
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 5]]), cohortSize: 5 })).toBe(2)
  })

  it('counts only the HIGHEST cohort, not the total', () => {
    // 1 is full, 2 has room. A total-based rule would open cohort 3 here.
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 5], [2, 2]]), cohortSize: 5 })).toBe(2)
  })

  it('opens a new cohort when the highest is over-full', () => {
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 5], [2, 7]]), cohortSize: 5 })).toBe(3)
  })

  it('handles a cohort size of 1 without stalling', () => {
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 1]]), cohortSize: 1 })).toBe(2)
  })

  /**
   * FOUND BY RUNNING IT against the live database, which reported "next new account joins
   * cohort 1". Cohort 1 had 4 of 5 places free — and cohort 1 is the BASELINE, exempt from the
   * soak. So the first account of a 61-account expansion would have been armable immediately,
   * bypassing the entire mechanism built to stage it. Room in the baseline is not room on the
   * ladder.
   */
  it('never puts a NEW account in the exempt baseline cohort, even with room', () => {
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 4]]), cohortSize: 5 })).toBe(2)
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 1]]), cohortSize: 5 })).toBe(2)
  })

  /** Only the very first account of an empty system is cohort 1. */
  it('still assigns cohort 1 to the first account in an empty system', () => {
    expect(cohortForNewAccount({ existingCounts: new Map(), cohortSize: 5 })).toBe(1)
  })

  /** And cohort 2 onwards fills normally. */
  it('fills cohort 2 before opening cohort 3', () => {
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 4], [2, 3]]), cohortSize: 5 })).toBe(2)
    expect(cohortForNewAccount({ existingCounts: new Map([[1, 4], [2, 5]]), cohortSize: 5 })).toBe(3)
  })
})

/**
 * Every operator-facing sentence says "group", matching the heading on /accounts/login.
 * "cohort" is internal vocabulary and CLAUDE.md's rule is that the dashboard is read by a CEO —
 * a warning the reader has to translate has not done its job.
 */
describe('the reasons are written for the person reading them', () => {
  const REFUSALS = [
    mayArmCohort({ cohort: 2, states: [state(1, { everChallenged: 1 })], soakDays: 14, now: NOW }),
    mayArmCohort({ cohort: 3, states: [state(1), state(2, { live: 0 })], soakDays: 14, now: NOW }),
    mayArmCohort({ cohort: 2, states: [state(1, { soakStartedAt: null })], soakDays: 14, now: NOW }),
    mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-08-25T12:00:00Z') })],
      soakDays: 14,
      now: NOW,
    }),
  ]

  it('produces a refusal for every rung, so none of these is vacuous', () => {
    expect(REFUSALS.every((r) => !r.ok)).toBe(true)
  })

  it('never says "cohort" to an operator', () => {
    for (const r of REFUSALS) {
      if (!r.ok) expect(r.detail.toLowerCase(), r.reason).not.toContain('cohort')
    }
  })

  it('says "group" instead', () => {
    for (const r of REFUSALS) {
      if (!r.ok) expect(r.detail.toLowerCase(), r.reason).toContain('group')
    }
  })
})

/**
 * The dashboard's own wrapper message must not reintroduce the word the ladder avoids.
 * It did: "@x is in a cohort that is not cleared yet: group 1 has been sending for..." —
 * half internal vocabulary, found by calling the action over HTTP and reading the reply.
 */
describe('the arming refusal reads as one sentence', () => {
  it('composes without the word "cohort"', () => {
    const r = mayArmCohort({
      cohort: 2,
      states: [state(1, { soakStartedAt: new Date('2026-08-25T12:00:00Z') })],
      soakDays: 14,
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Exactly what `setAccountAutopilot` builds.
      const shown = `@bollywoodsocietyy cannot be switched on yet — ${r.detail}`
      expect(shown.toLowerCase()).not.toContain('cohort')
      expect(shown).toContain('group 1')
      expect(shown).toMatch(/^@\S+ cannot be switched on yet — /)
    }
  })
})
