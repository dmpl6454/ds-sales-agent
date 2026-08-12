import { describe, it, expect } from 'vitest'
import { decideSendLock } from '@/outreach/dispatcher'

/**
 * The send-lock decision, in every direction.
 *
 * There is one OS clipboard and `sendDm` pastes the body from it, so two overlapping sends
 * can put message A into thread B. This is the decision that prevents it, and it is pure
 * for the same reason `decideSlotLock` is: the case that matters — a holder that is hung
 * but ALIVE — cannot be produced on demand against a real process.
 */

const holder = (pid: number, ageIso: string) => ({ pid, what: 'dispatch', at: ageIso })
const OLD = new Date(0).toISOString()
const NOW = new Date().toISOString()

describe('decideSendLock', () => {
  it('takes a free lock', () => {
    expect(decideSendLock({ held: null, holderAlive: false, ourPid: 1, ageMs: 0 })).toEqual({ action: 'take' })
  })

  it('takes over from a holder whose process is gone', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: false, ourPid: 1, ageMs: 1000 })
    expect(v.action).toBe('take')
  })

  it('declines while another LIVE process holds it', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: true, ourPid: 1, ageMs: 1000 })
    expect(v.action).toBe('decline')
  })

  /**
   * THE CASE THAT MATTERS, and the one `decideSlotLock` was fixed for in Phase 0.
   *
   * A hung-but-alive holder still owns the clipboard. Age must never overrule liveness:
   * stepping over it is how two browsers drive at once. Nothing sends, rather than
   * something sends into the wrong conversation — and `stalled` makes the wait an alarm
   * rather than a silence.
   */
  it('NEVER steps over a live holder, however stale the lock', () => {
    const v = decideSendLock({ held: holder(999_999, OLD), holderAlive: true, ourPid: 1, ageMs: 10 * 3_600_000 })
    expect(v.action).toBe('decline')
    if (v.action !== 'decline') throw new Error('unreachable')
    expect(v.stalled).toBe(true)
  })

  it('a fresh live holder is declined WITHOUT the alarm', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: true, ourPid: 1, ageMs: 5_000 })
    if (v.action !== 'decline') throw new Error('expected a decline')
    expect(v.stalled).toBe(false)
  })

  /**
   * Our own row is claimable, because a crash inside this process leaves one behind and
   * pids get reused. That is also exactly why `withSendLock` keeps a separate in-process
   * flag: this rule alone would let a NESTED call succeed and then release the outer
   * call's lock mid-send. Verified by running it — the nested path was granted, and the
   * inner `finally` deleted the row while a send was still in flight.
   */
  it('reclaims a row left by this same process', () => {
    const v = decideSendLock({ held: holder(process.pid, OLD), holderAlive: true, ourPid: process.pid, ageMs: 1 })
    expect(v.action).toBe('take')
  })

  it('replaces an unreadable row rather than deadlocking forever', () => {
    expect(decideSendLock({ held: null, holderAlive: true, ourPid: 1, ageMs: Infinity })).toEqual({ action: 'take' })
  })

  it('honours a caller-supplied staleness threshold', () => {
    const v = decideSendLock({
      held: holder(999_999, NOW),
      holderAlive: true,
      ourPid: 1,
      ageMs: 5_000,
      staleMs: 1_000,
    })
    if (v.action !== 'decline') throw new Error('expected a decline')
    expect(v.stalled).toBe(true)
  })
})
