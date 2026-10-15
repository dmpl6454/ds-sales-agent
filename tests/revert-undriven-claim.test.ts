import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * `revertUndrivenClaim` — the opposite of `recordDelivered`'s rule, and it must be exactly as
 * careful about which rows it touches.
 *
 * `recordDelivered` may never put a row back to READY, because delivery cannot be ruled out.
 * This may ONLY put a row back when it is still SENDING and the drive never began. The condition
 * lives in the write itself, so a row that reached SENT (or was parked FAILED by the probe) in the
 * meantime can never be handed back to the queue. And the revert is retried, because the error
 * that brought us here is usually the database being briefly unreachable.
 */

const updateMany = vi.fn()
const settleClaims = vi.fn()
vi.mock('@/lib/db', () => ({ prisma: { outreachAttempt: { updateMany: (...a: unknown[]) => updateMany(...a) } } }))
vi.mock('@/outreach/reservations', () => ({ settleClaims: (...a: unknown[]) => settleClaims(...a) }))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
  describeError: (e: unknown) => String(e),
}))

const { revertUndrivenClaim } = await import('@/outreach/recordSend')

beforeEach(() => {
  vi.useRealTimers()
  updateMany.mockReset().mockResolvedValue({ count: 1 })
  settleClaims.mockReset().mockResolvedValue(undefined)
})

describe('revertUndrivenClaim', () => {
  it('puts a SENDING row back to READY, conditioned on SENDING in the write itself', async () => {
    expect(await revertUndrivenClaim('att_1', [], new Error('x'))).toBe(true)
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'att_1', status: 'SENDING' }, data: { status: 'READY' } })
  })

  it('releases what was reserved as NOT ATTEMPTED — nothing was driven', async () => {
    const held = [{ id: 'res_1', seq: 1 }]
    await revertUndrivenClaim('att_1', held as never, new Error('x'))
    expect(settleClaims).toHaveBeenCalledWith(held, { delivered: false, attempted: false })
  })

  it('retries the revert through a brief outage', async () => {
    vi.useFakeTimers()
    updateMany.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValue({ count: 1 })
    const p = revertUndrivenClaim('att_1', [], new Error('x'))
    await vi.runAllTimersAsync()
    expect(await p).toBe(true)
    expect(updateMany).toHaveBeenCalledTimes(3)
  })

  it('gives up loudly, leaving the row for the orphan sweep, when the database never answers', async () => {
    vi.useFakeTimers()
    updateMany.mockRejectedValue(new Error('down'))
    const p = revertUndrivenClaim('att_1', [], new Error('x'))
    await vi.runAllTimersAsync()
    expect(await p).toBe(false)
  })

  it('a failed release does not stop the status revert', async () => {
    settleClaims.mockRejectedValue(new Error('down'))
    expect(await revertUndrivenClaim('att_1', [{ id: 'r' }] as never, new Error('x'))).toBe(true)
    expect(updateMany).toHaveBeenCalledOnce()
  })
})

/**
 * ── THE WINDOW IS GUARDED ONCE, IN THE FUNCTION BOTH CALLERS RUN (Stage 1.3) ───────────────
 *
 * This used to pin `sendNow`'s two guarded windows by source shape — the claim block, and the
 * lock acquisition — because the Send button had no behavioural harness and claimed BEFORE it
 * asked for the lock. Both callers claim INSIDE the lock now, through `deliverOne`, so there is
 * ONE window (claim → drive), guarded by one `revertUndrivenClaim`, and the Send button's
 * second window (a throw while TAKING the lock) has nothing to give back: nothing is claimed
 * until the lock is held. What is pinned here is therefore the shape of that one window and
 * the absence of the other.
 *
 * Behaviour is driven in tests/deliver-challenged.test.ts ('a database error after the claim
 * puts the draft back, and drives nothing') for the dispatcher and in
 * tests/send-now-claims-under-lock.test.ts for the button.
 */
describe('the undriven window is guarded once, inside deliverOne', () => {
  const src = readFileSync('src/outreach/deliverOne.ts', 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  it('reverts a claim whose drive never began — exactly once, in the catch around claim → drive', () => {
    expect(code.split('revertUndrivenClaim(').length - 1).toBe(1)
    const claim = code.indexOf("data: { status: 'SENDING' }")
    const tryAt = code.indexOf('try {', claim)
    const catchAt = code.indexOf('} catch (err) {', tryAt)
    const revert = code.indexOf('revertUndrivenClaim(', catchAt)
    expect(claim).toBeGreaterThan(-1)
    expect(tryAt, 'the guarded window must open right after the claim').toBeGreaterThan(claim)
    expect(catchAt).toBeGreaterThan(tryAt)
    expect(revert, 'the revert belongs to that catch').toBeGreaterThan(catchAt)
    // Between a SUCCESSFUL claim and the try, nothing can throw out unguarded: the only await in
    // that stretch is the lost-claim branch's status re-read (for a sentence), and a lost claim
    // has nothing to give back.
    const lost = code.indexOf('claimed.count === 0', claim)
    expect(lost, 'the lost-claim branch moved').toBeGreaterThan(claim)
    expect(code.slice(code.indexOf('let claimHeld', lost), tryAt)).not.toMatch(/await /)
  })

  it('and the drive sits AFTER the window — a throw out of the send is never reverted', () => {
    const catchAt = code.indexOf('} catch (err) {')
    const drive = code.indexOf('browserSender.send(')
    expect(drive, 'the send must come after the guarded window closes').toBeGreaterThan(catchAt)
    expect(code.slice(code.indexOf('try {'), catchAt)).not.toMatch(/browserSender\.send\(/)
  })
})

describe('sendNow claims nothing of its own, so a refused lock leaves the draft as it was', () => {
  const src = readFileSync('src/app/actions.ts', 'utf8')
  const start = src.indexOf('export async function sendNow(')
  const body = src
    .slice(start, src.indexOf('export async function', start + 10))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  it('holds no claim, no reservation and no revert — they are deliverOne\'s, under the lock', () => {
    expect(body).not.toMatch(/SENDING/)
    expect(body).not.toMatch(/updateMany|claimForAttempt|settleClaims|revertUndrivenClaim/)
  })

  it('reverts nothing when taking the lock throws, and lets a throw from deliverOne propagate', () => {
    const lock = body.indexOf('await withSendLock(')
    expect(lock).toBeGreaterThan(-1)
    // `entered` is set only once deliverOne is about to run, so a throw from acquiring the lock
    // answers with the database sentence, and one from inside deliverOne (after a drive may have
    // started) rethrows exactly as the old `driveStarted` guard did.
    expect(body.indexOf('entered = true', lock)).toBeGreaterThan(lock)
    expect(body.indexOf('if (entered) throw err')).toBeGreaterThan(lock)
  })
})
