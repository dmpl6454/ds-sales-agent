import { describe, it, expect } from 'vitest'
import { shouldReleaseOnFailure } from '@/outreach/reservations'
import { FAILURE_CODES } from '@/lib/constants'

/**
 * Phase 2 — whether a failed send gives its reservation back.
 *
 * Not symmetric, and the asymmetry is the whole point:
 *
 *   release   costs nothing when we are CERTAIN nothing was delivered, and prevents a
 *             run of transport failures from locking a recipient out for the day —
 *             which would turn a cap on MESSAGES RECEIVED into a cap on ATTEMPTS MADE.
 *   keep      costs one deferred message when we are not certain, and prevents a second
 *             message landing on top of one that probably already did.
 */

describe('shouldReleaseOnFailure', () => {
  it('releases only when nothing can have reached the recipient', () => {
    expect(shouldReleaseOnFailure('still-staged')).toBe(true)
    expect(shouldReleaseOnFailure('composer-mismatch')).toBe(true)
    expect(shouldReleaseOnFailure('no-composer')).toBe(true)
    expect(shouldReleaseOnFailure('no-message-button')).toBe(true)
  })

  /**
   * THE ONE THAT MATTERS. The composer cleared — Instagram accepted the keystroke — and
   * the message never appeared. The recipient may well have it. Releasing here permits a
   * second message on top of a first that probably landed.
   */
  it('NEVER releases not-in-thread', () => {
    expect(shouldReleaseOnFailure('not-in-thread')).toBe(false)
  })

  it('does not release an enforcement halt or a navigation failure', () => {
    // Enforcement: the account is being halted anyway, and we do not know what landed.
    expect(shouldReleaseOnFailure('enforcement')).toBe(false)
    expect(shouldReleaseOnFailure('navigation')).toBe(false)
  })

  /**
   * The default direction. An unrecognised code answers "are we certain nothing was
   * delivered?" with NO — because the honest answer for something unknown is no. A list
   * of codes to KEEP would fail the other way: a new failure mode added later would
   * release by default, silently.
   */
  it('keeps by default for anything unrecognised', () => {
    expect(shouldReleaseOnFailure('unknown')).toBe(false)
    expect(shouldReleaseOnFailure('some-new-code-added-in-2027')).toBe(false)
    expect(shouldReleaseOnFailure('')).toBe(false)
    expect(shouldReleaseOnFailure(null)).toBe(false)
    expect(shouldReleaseOnFailure(undefined)).toBe(false)
  })

  /** Every declared code has a decided answer — no code falls through unconsidered. */
  it('has an answer for every declared failure code', () => {
    for (const code of FAILURE_CODES) {
      expect(typeof shouldReleaseOnFailure(code), code).toBe('boolean')
    }
    // And the split is not degenerate in either direction.
    const released = FAILURE_CODES.filter((c) => shouldReleaseOnFailure(c))
    expect(released.length).toBeGreaterThan(0)
    expect(released.length).toBeLessThan(FAILURE_CODES.length)
  })
})
