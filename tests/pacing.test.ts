import { describe, it, expect } from 'vitest'
import {
  assessBreaker,
  decideDispatch,
  withinActiveHours,
  ACTIVE_FROM_HOUR,
  ACTIVE_TO_HOUR,
  FLEET_MIN_GAP_MINUTES,
  NOT_IN_THREAD_MIN_COUNT,
  NOT_IN_THREAD_MIN_RATE,
  type BreakerVerdict,
} from '@/outreach/pacing'
import { describeTickOutcome } from '@/outreach/dispatcher'

/**
 * Every rule is asserted FIRING and PERMITTING.
 *
 * The reason that discipline is written at the top of this file rather than assumed: a
 * circuit breaker that cannot trip is indistinguishable from a healthy one, and this
 * codebase has found twelve guards that were only ever exercised in the direction that
 * passes. `repliedAt` was read in six places and written in none — the negative
 * direction worked perfectly, so nothing looked wrong.
 */

const quiet: BreakerVerdict = { tripped: false }

describe('assessBreaker — a checkpoint on any account halts the whole fleet', () => {
  it('does NOT trip when nothing has been flagged', () => {
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 0, deliveredInWindow: 10 })
    expect(v.tripped).toBe(false)
  })

  it('trips on a single challenged account', () => {
    const v = assessBreaker({ challengedInWindow: 1, notInThreadInWindow: 0, deliveredInWindow: 10 })
    expect(v.tripped).toBe(true)
    if (!v.tripped) throw new Error('unreachable')
    expect(v.reason).toBe('challenged')
    // The detail has to name the window, because the release is "wait it out or clear it".
    expect(v.detail).toContain('24h')
  })

  it('names how many accounts were flagged, not just that some were', () => {
    const v = assessBreaker({ challengedInWindow: 3, notInThreadInWindow: 0, deliveredInWindow: 0 })
    if (!v.tripped) throw new Error('expected a trip')
    expect(v.detail).toContain('3 account(s)')
  })

  it('respects a caller-supplied window in the message', () => {
    const v = assessBreaker({
      challengedInWindow: 1,
      challengeWindowHours: 6,
      notInThreadInWindow: 0,
      deliveredInWindow: 0,
    })
    if (!v.tripped) throw new Error('expected a trip')
    expect(v.detail).toContain('6h')
  })
})

describe('assessBreaker — not-in-thread needs BOTH a count and a rate', () => {
  it('one failure among many successes does not halt the fleet', () => {
    // Below the count threshold. A slow render must not stop 65 accounts.
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 1, deliveredInWindow: 20 })
    expect(v.tripped).toBe(false)
  })

  it('two failures among many successes does not halt the fleet either — the RATE is low', () => {
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 2, deliveredInWindow: 100 })
    expect(v.tripped).toBe(false)
  })

  it('trips when the count AND the rate are both reached', () => {
    // 2 of 4 = 50%, over both thresholds.
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 2, deliveredInWindow: 2 })
    expect(v.tripped).toBe(true)
    if (!v.tripped) throw new Error('unreachable')
    expect(v.reason).toBe('not-in-thread-rate')
    expect(v.detail).toContain('50%')
  })

  /**
   * LITERAL numbers, no arithmetic.
   *
   * The first version of this test computed the boundary from the two exported
   * thresholds — `round(count / rate) - count` — and so reimplemented the very formula
   * it was checking. It disagreed with the implementation by one send and failed, which
   * was luck: had the rounding gone the other way the test would have passed while
   * asserting nothing. A Phase 2 test made this exact mistake and reproduced the bug it
   * was written to catch.
   *
   * 3 of 10 is exactly 30%; 3 of 11 is 27%. Both are readable without a calculator.
   */
  it('trips at exactly the rate threshold', () => {
    expect(NOT_IN_THREAD_MIN_COUNT).toBe(2)
    expect(NOT_IN_THREAD_MIN_RATE).toBe(0.3)
    const at = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 3, deliveredInWindow: 7 })
    expect(at.tripped).toBe(true)
  })

  it('does not trip one send below the rate threshold', () => {
    const under = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 3, deliveredInWindow: 8 })
    expect(under.tripped).toBe(false)
  })

  it('does not trip one failure below the count threshold, however bad the rate', () => {
    // 1 of 1 = 100%, and it still must not halt 65 accounts.
    const under = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 1, deliveredInWindow: 0 })
    expect(under.tripped).toBe(false)
  })

  it('does not divide by zero when nothing has happened at all', () => {
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 0, deliveredInWindow: 0 })
    expect(v.tripped).toBe(false)
  })

  it('trips on failures with no successes at all — the worst case, not an exemption', () => {
    // 2 of 2 = 100%. A denominator of zero successes must not read as "no evidence".
    const v = assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 2, deliveredInWindow: 0 })
    expect(v.tripped).toBe(true)
  })
})

describe('assessBreaker — a person can stop it, and that outranks everything inferred', () => {
  it('trips on a manual pause even with a perfectly healthy fleet', () => {
    const v = assessBreaker({
      challengedInWindow: 0,
      notInThreadInWindow: 0,
      deliveredInWindow: 50,
      manualPause: { at: '2026-08-04T10:00:00.000Z', by: 'tabish@dashmani.com', reason: 'checking something' },
    })
    expect(v.tripped).toBe(true)
    if (!v.tripped) throw new Error('unreachable')
    expect(v.reason).toBe('manual')
    // Who and when, so the halt is never mysterious.
    expect(v.detail).toContain('tabish@dashmani.com')
    expect(v.detail).toContain('checking something')
  })

  it('a null pause is not a pause', () => {
    const v = assessBreaker({
      challengedInWindow: 0,
      notInThreadInWindow: 0,
      deliveredInWindow: 1,
      manualPause: null,
    })
    expect(v.tripped).toBe(false)
  })

  it('reports the manual reason ahead of a challenge, so the human cause is not masked', () => {
    const v = assessBreaker({
      challengedInWindow: 2,
      notInThreadInWindow: 0,
      deliveredInWindow: 0,
      manualPause: { at: 'x', by: 'y' },
    })
    if (!v.tripped) throw new Error('expected a trip')
    expect(v.reason).toBe('manual')
  })
})

describe('withinActiveHours', () => {
  it('is 24/7 in production since 2026-08-19 — every hour is allowed', () => {
    // Tabish removed the time window. The constants are a zero-width window, which the
    // function reads as "no restriction". This asserts the production default, not the
    // mechanism, so that a future change back to a real window is a deliberate edit here.
    expect(ACTIVE_FROM_HOUR).toBe(ACTIVE_TO_HOUR)
    for (let h = 0; h < 24; h++) expect(withinActiveHours(h)).toBe(true)
  })

  it('STILL ENFORCES a window when one is passed explicitly — the mechanism is intact', () => {
    // The branch is not dead: a caller (or a future re-enabled window) that passes real
    // hours must still be honoured, so the guard can be restored with two numbers.
    expect(withinActiveHours(15, 10, 21)).toBe(true)
    expect(withinActiveHours(3, 10, 21)).toBe(false)
    expect(withinActiveHours(21, 10, 21)).toBe(false)
    expect(withinActiveHours(23, 10, 21)).toBe(false)
  })

  it('handles a wrapping window rather than silently meaning "never"', () => {
    expect(withinActiveHours(23, 22, 6)).toBe(true)
    expect(withinActiveHours(2, 22, 6)).toBe(true)
    expect(withinActiveHours(12, 22, 6)).toBe(false)
  })

  it('treats a zero-width window as no restriction, not as a total stop', () => {
    expect(withinActiveHours(4, 10, 10)).toBe(true)
  })
})

describe('decideDispatch', () => {
  const ok = {
    autopilotEnabled: true,
    breaker: quiet,
    istHour: 15,
    minutesSinceLastSend: 60,
    waitingCount: 2,
  }

  it('sends when everything is in order', () => {
    expect(decideDispatch(ok)).toEqual({ action: 'send' })
  })

  it('sends when nothing has ever been sent — null is not "too soon"', () => {
    expect(decideDispatch({ ...ok, minutesSinceLastSend: null })).toEqual({ action: 'send' })
  })

  it('holds when the breaker is tripped, and reports which signal', () => {
    const v = decideDispatch({
      ...ok,
      breaker: { tripped: true, reason: 'challenged', detail: 'one account flagged' },
    })
    expect(v.action).toBe('hold')
    if (v.action !== 'hold') throw new Error('unreachable')
    expect(v.reason).toBe('breaker-challenged')
    expect(v.detail).toBe('one account flagged')
  })

  it('reports the breaker even when the queue is empty — a halt must not hide behind "nothing to do"', () => {
    const v = decideDispatch({
      ...ok,
      waitingCount: 0,
      breaker: { tripped: true, reason: 'manual', detail: 'paused' },
    })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('breaker-manual')
  })

  it('holds with autopilot off, and says drafts keep their button', () => {
    const v = decideDispatch({ ...ok, autopilotEnabled: false })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('autopilot-off')
    expect(v.detail).toContain('Send button')
  })

  it('holds — unremarkably — when there is nothing waiting', () => {
    const v = decideDispatch({ ...ok, waitingCount: 0 })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('nothing-waiting')
  })

  it('holds outside a window WHEN ONE IS SET — the mechanism, exercised with explicit hours', () => {
    // Production is 24/7 now (ACTIVE_*_HOUR are zero-width), so the branch is reached by
    // passing a real window, which is exactly how it would be re-enabled.
    const v = decideDispatch({ ...ok, istHour: 4, activeFromHour: 10, activeToHour: 21 })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('outside-active-hours')
    expect(v.detail).toContain('04:xx')
  })

  it('sends at 4am now, because there is no window in production', () => {
    expect(decideDispatch({ ...ok, istHour: 4 })).toEqual({ action: 'send' })
  })

  it('holds when the previous send was too recent', () => {
    const v = decideDispatch({ ...ok, minutesSinceLastSend: FLEET_MIN_GAP_MINUTES - 1 })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('too-soon')
  })

  it('permits exactly at the gap, not one minute later', () => {
    expect(decideDispatch({ ...ok, minutesSinceLastSend: FLEET_MIN_GAP_MINUTES })).toEqual({ action: 'send' })
  })

  it('reports the most absolute reason when several apply at once', () => {
    // Breaker tripped, autopilot off, 4am, nothing waiting, sent one minute ago.
    const v = decideDispatch({
      autopilotEnabled: false,
      breaker: { tripped: true, reason: 'not-in-thread-rate', detail: 'restricted?' },
      istHour: 4,
      minutesSinceLastSend: 1,
      waitingCount: 0,
    })
    if (v.action !== 'hold') throw new Error('expected a hold')
    expect(v.reason).toBe('breaker-not-in-thread-rate')
  })

  it('honours a caller-widened window rather than the constant', () => {
    expect(decideDispatch({ ...ok, istHour: 4, activeFromHour: 0, activeToHour: 24 })).toEqual({
      action: 'send',
    })
  })
})

/**
 * ── "nothing sent" must say WHY ────────────────────────────────────────────
 *
 * The dispatcher used to report `0 message(s) sent` whenever pacing CLEARED the fleet to send
 * and every individual message was then held — by an unreadable conversation, a persona
 * mismatch, a spent cap. It explained why the FLEET did not send and never why a MESSAGE did
 * not, which is the only question someone has when autopilot is on and nothing has moved.
 *
 * `recordDispatchState`'s own docblock says the mechanism exists so that question has an
 * answer, so it was one level short of its own claim. Found 2026-08-05 by asking what the
 * screen shows when the just-in-time conversation read holds a follow-up.
 */
describe('describeTickOutcome', () => {
  it('reports a send plainly', () => {
    expect(describeTickOutcome({ sent: 1, held: 0 })).toBe('1 message(s) sent')
  })

  /** An empty queue and a fully-held queue are different facts and must read differently. */
  it('distinguishes an empty queue from a held one', () => {
    expect(describeTickOutcome({ sent: 0, held: 0 })).toBe('nothing was waiting to send')
    expect(describeTickOutcome({ sent: 0, held: 1, firstHoldReason: 'x' })).toContain('was held')
  })

  it('names the reason when the one waiting message was held', () => {
    const out = describeTickOutcome({
      sent: 0,
      held: 1,
      firstHoldReason: '@a→@b — only part of the conversation was visible',
    })
    expect(out).toContain('the one waiting message was held')
    expect(out).toContain('only part of the conversation was visible')
    expect(out).not.toContain('0 message(s) sent')
  })

  it('says how many were held, and names the first', () => {
    const out = describeTickOutcome({ sent: 0, held: 4, firstHoldReason: '@a→@b — they replied' })
    expect(out).toContain('all 4 waiting messages were held')
    expect(out).toContain('they replied')
  })

  /** A send outranks a hold: something DID go out, and that is the headline. */
  it('reports the send even when other messages were held', () => {
    expect(describeTickOutcome({ sent: 1, held: 3, firstHoldReason: 'x' })).toBe('1 message(s) sent')
  })

  /**
   * The bug itself, as an executable record: a held queue must never read as a bare zero.
   */
  it('never reports a held queue as a bare count', () => {
    for (const held of [1, 2, 9]) {
      const out = describeTickOutcome({ sent: 0, held, firstHoldReason: 'a reason' })
      expect(out, `held=${held}`).not.toMatch(/^0 message/)
      expect(out, `held=${held}`).toContain('a reason')
    }
  })
})

/**
 * ── THE RATE BREAKER COULD NOT SELF-HEAL, MEASURED (2026-08-26) ───────────
 *
 * Its denominator is DELIVERIES in the window, which only grow by sending — which it
 * forbids. So once tripped the rate gets WORSE, because deliveries age out of the window
 * while the failures are still inside it. Projected with this very function over the real
 * data the day it shipped: 39% now, 45% at +6h, 47% at +12h, **79% at +18h**, releasing only
 * at +19h when the numerator expired completely. Nineteen hours for a fleet that was healthy
 * after the first two.
 *
 * *A hard stop with no release is a bug wearing a safety feature's clothes.* The `challenged`
 * arm has `clearChallenge`; this arm had nothing while its own message invited exactly what
 * it did not offer — "nothing else is sent until someone has looked".
 */
describe('a person can say they have looked, and only for what they looked at', () => {
  const tripped = { challengedInWindow: 0, notInThreadInWindow: 47, deliveredInWindow: 74 }

  it('trips without an acknowledgement — so the cases below are not vacuous', () => {
    expect(assessBreaker(tripped).tripped).toBe(true)
  })

  it('releases when the look came AFTER every counted failure', () => {
    const v = assessBreaker({
      ...tripped,
      newestFailureAt: '2026-08-26T12:56:00.000Z',
      acknowledgedAt: '2026-08-26T16:40:00.000Z',
    })
    expect(v.tripped).toBe(false)
  })

  /** THE LOAD-BEARING CASE: a failure after the look is not covered by it. */
  it('trips again on a failure NEWER than the acknowledgement', () => {
    const v = assessBreaker({
      ...tripped,
      acknowledgedAt: '2026-08-26T16:40:00.000Z',
      newestFailureAt: '2026-08-26T17:05:00.000Z',
    })
    expect(v.tripped).toBe(true)
    if (v.tripped) expect(v.reason).toBe('not-in-thread-rate')
  })

  it('an unparseable acknowledgement silences nothing', () => {
    for (const bad of ['', 'yes', 'later', 'null']) {
      expect(assessBreaker({ ...tripped, acknowledgedAt: bad, newestFailureAt: '2026-08-26T12:00:00.000Z' }).tripped).toBe(true)
    }
  })

  /**
   * The finite-date guard, pinned on its OWN. With a `newestFailureAt` present the date
   * comparison alone already refuses a garbage value, so the case above passes even when
   * `Number.isFinite` is broken — found by mutating it. This drives the branch where the
   * comparison cannot help, which is the only place that guard is load-bearing.
   */
  it('a garbage acknowledgement releases nothing even when the failure date is missing', () => {
    for (const bad of ['', 'yes', 'later', 'null', 'NaN']) {
      expect(
        assessBreaker({ ...tripped, acknowledgedAt: bad, newestFailureAt: null }).tripped,
        `"${bad}" was treated as somebody having looked`,
      ).toBe(true)
    }
  })

  /**
   * It acknowledges the RATE and nothing else. Instagram flagging an account is not
   * something a person can acknowledge away, and an explicit Pause outranks everything the
   * system inferred.
   */
  it('never releases a flagged account or a manual pause', () => {
    const ack = { acknowledgedAt: '2026-08-27T00:00:00.000Z', newestFailureAt: '2026-08-26T12:00:00.000Z' }
    const flagged = assessBreaker({ ...tripped, ...ack, challengedInWindow: 1 })
    expect(flagged.tripped).toBe(true)
    if (flagged.tripped) expect(flagged.reason).toBe('challenged')

    const paused = assessBreaker({ ...tripped, ...ack, manualPause: { at: 'x', by: 'tabish' } })
    expect(paused.tripped).toBe(true)
    if (paused.tripped) expect(paused.reason).toBe('manual')
  })

  it('an acknowledgement with no failures at all is harmless', () => {
    expect(
      assessBreaker({ challengedInWindow: 0, notInThreadInWindow: 0, deliveredInWindow: 10, acknowledgedAt: '2026-08-26T16:40:00.000Z', newestFailureAt: null }).tripped,
    ).toBe(false)
  })
})
