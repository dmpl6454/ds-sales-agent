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
    expect(decideSendLock({ held: null, holderAlive: false, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: 0 })).toEqual({ action: 'take' })
  })

  it('takes over from a holder whose process is gone', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: false, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: 1000 })
    expect(v.action).toBe('take')
  })

  it('declines while another LIVE process holds it', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: true, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: 1000 })
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
    const v = decideSendLock({ held: holder(999_999, OLD), holderAlive: true, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: 10 * 3_600_000 })
    expect(v.action).toBe('decline')
    if (v.action !== 'decline') throw new Error('unreachable')
    expect(v.stalled).toBe(true)
  })

  it('a fresh live holder is declined WITHOUT the alarm', () => {
    const v = decideSendLock({ held: holder(999_999, NOW), holderAlive: true, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: 5_000 })
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
    const v = decideSendLock({ held: holder(process.pid, OLD), holderAlive: true, holderIsLocal: true, holderDeviceFresh: true, ourPid: process.pid, ageMs: 1 })
    expect(v.action).toBe('take')
  })

  it('replaces an unreadable row rather than deadlocking forever', () => {
    expect(decideSendLock({ held: null, holderAlive: true, holderIsLocal: true, holderDeviceFresh: true, ourPid: 1, ageMs: Infinity })).toEqual({ action: 'take' })
  })

  it('honours a caller-supplied staleness threshold', () => {
    const v = decideSendLock({
      held: holder(999_999, NOW),
      holderAlive: true,
      holderIsLocal: true,
      holderDeviceFresh: true,
      ourPid: 1,
      ageMs: 5_000,
      staleMs: 1_000,
    })
    if (v.action !== 'decline') throw new Error('expected a decline')
    expect(v.stalled).toBe(true)
  })
  /**
   * ── THE LOCK IS SHARED BETWEEN MACS, AND A PID IS A FACT ABOUT ONE OF THEM (2026-09-10) ──
   *
   * MEASURED the day a second Mac joined the fleet: this Mac's agent logged "taking over a
   * send lock left by a process that is gone deadPid=71169" seven times in forty minutes,
   * and 71169 was the OTHER Mac's live agent. `process.kill(pid, 0)` asks the local OS
   * about a pid that lives on another machine, so a foreign holder read as dead every
   * time and both dispatchers drove browsers at once. `holderAlive` is therefore only
   * evidence when the holder is LOCAL; a foreign holder is alive until the lock is stale
   * AND that Mac has stopped beating in `devicePresence`.
   */
  it('declines a lock held by ANOTHER Mac, whatever this machine says about that pid', () => {
    const v = decideSendLock({
      held: { ...holder(71_169, NOW), device: 'DMPLs Mac Studio' },
      holderAlive: false, // no such pid HERE — which says nothing about the other Mac
      holderIsLocal: false,
      holderDeviceFresh: true,
      ourPid: 1,
      ageMs: 20_000,
    })
    expect(v).toEqual({ action: 'decline', stalled: false })
  })

  it('a stale lock from another Mac that is still beating is declined WITH the alarm', () => {
    const v = decideSendLock({
      held: { ...holder(71_169, OLD), device: 'DMPLs Mac Studio' },
      holderAlive: false,
      holderIsLocal: false,
      holderDeviceFresh: true,
      ourPid: 1,
      ageMs: 10 * 60_000,
    })
    expect(v).toEqual({ action: 'decline', stalled: true })
  })

  it('takes over a stale lock from another Mac that has STOPPED beating', () => {
    const v = decideSendLock({
      held: { ...holder(71_169, OLD), device: 'DMPLs Mac Studio' },
      holderAlive: false,
      holderIsLocal: false,
      holderDeviceFresh: false,
      ourPid: 1,
      ageMs: 10 * 60_000,
    })
    expect(v).toEqual({ action: 'take' })
  })

  it('a fresh lock from a Mac that stopped beating is still waited for — a lid closes mid-send', () => {
    const v = decideSendLock({
      held: { ...holder(71_169, NOW), device: 'DMPLs Mac Studio' },
      holderAlive: false,
      holderIsLocal: false,
      holderDeviceFresh: false,
      ourPid: 1,
      ageMs: 30_000,
    })
    expect(v).toEqual({ action: 'decline', stalled: false })
  })

  it('a row naming no Mac (written by an agent older than this rule) is treated as another Mac', () => {
    // The caller cannot place it, so it passes holderIsLocal=false and holderDeviceFresh=false.
    const fresh = decideSendLock({ held: holder(1, NOW), holderAlive: false, holderIsLocal: false, holderDeviceFresh: false, ourPid: 1, ageMs: 1000 })
    expect(fresh).toEqual({ action: 'decline', stalled: false })
    const stale = decideSendLock({ held: holder(1, OLD), holderAlive: false, holderIsLocal: false, holderDeviceFresh: false, ourPid: 1, ageMs: 7 * 60_000 })
    expect(stale).toEqual({ action: 'take' })
  })
})
