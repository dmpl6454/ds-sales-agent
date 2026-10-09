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
 * The dashboard's Send button has no behavioural harness (it needs a session, the gate, the
 * sender and the browser all faked), so its two guarded windows are pinned by source shape:
 * the claim block, and the lock acquisition — where only a throw BEFORE the drive started may
 * put the draft back, because after it the recipient may already hold the message.
 */
describe('sendNow guards both undriven windows', () => {
  const src = readFileSync('src/app/actions.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function sendNow('), src.indexOf('export async function', src.indexOf('export async function sendNow(') + 10))

  it('reverts a claim whose drive never began, from both windows', () => {
    expect(body.split('revertUndrivenClaim(').length - 1).toBe(2)
  })

  it('reverts on a lock-acquisition throw only when the drive had not started', () => {
    const lock = body.indexOf('await withSendLock(')
    expect(lock).toBeGreaterThan(-1)
    expect(body.indexOf('driveStarted = true', lock)).toBeGreaterThan(lock)
    const guard = body.indexOf('if (driveStarted) throw err')
    expect(guard).toBeGreaterThan(lock)
    expect(body.indexOf('revertUndrivenClaim(', guard)).toBeGreaterThan(guard)
  })
})
