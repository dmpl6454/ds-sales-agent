import { describe, expect, it } from 'vitest'
import { needsSessionRecord } from '@/agent/sessionRecord'

/**
 * The decision behind `reconcileSessionRecords`: may the device agent record a login the
 * Connect poll missed? The fixture values mirror the four live accounts as MEASURED on
 * 2026-08-17, when @madaboutmarketingg was the row this predicate exists for — session on
 * disk, `sessionPath` NULL, invisible to rotation while /senders called it healthy.
 */
describe('needsSessionRecord', () => {
  it('records the measured case: session on disk, no login ever recorded', () => {
    // @madaboutmarketingg, 2026-08-17 16:53 IST — signed in by hand, poll never saw it.
    expect(needsSessionRecord({ sessionPath: null, sessionInvalidAt: null }, true)).toBe(true)
  })

  it('leaves an already-recorded login alone', () => {
    // @bollywoodchronicle — recordConnected wrote sessionPath when the poll worked.
    expect(
      needsSessionRecord(
        { sessionPath: '/Users/x/.ds-sales-agent/chrome-profiles/bollywoodchronicle', sessionInvalidAt: null },
        true,
      ),
    ).toBe(false)
  })

  it('records nothing for a profile with no session on disk', () => {
    expect(needsSessionRecord({ sessionPath: null, sessionInvalidAt: null }, false)).toBe(false)
  })

  /**
   * THE DIRECTION THAT MUST FAIL CLOSED. A dead-session mark clears only on PROOF — an
   * identity-verified login or a delivered send (§3.5). A cookie surviving on disk is
   * exactly the evidence `sessionInvalidAt` exists to overrule: Instagram revokes
   * server-side and the file never hears about it. If this returns true, a reconcile
   * pass quietly resurrects every account the system has proven logged out.
   */
  it('NEVER records over a dead-session mark, session on disk or not', () => {
    const invalidAt = new Date('2026-08-06T09:58:00Z') // the real @tabishmukaddam1 false mark
    expect(needsSessionRecord({ sessionPath: null, sessionInvalidAt: invalidAt }, true)).toBe(false)
    expect(needsSessionRecord({ sessionPath: null, sessionInvalidAt: invalidAt }, false)).toBe(false)
  })

  it('a recorded login later proven dead stays dead', () => {
    expect(
      needsSessionRecord(
        {
          sessionPath: '/Users/x/.ds-sales-agent/chrome-profiles/bollywoodsocietyy',
          sessionInvalidAt: new Date('2026-08-06T09:58:00Z'),
        },
        true,
      ),
    ).toBe(false)
  })
})
