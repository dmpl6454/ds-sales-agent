import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * THE REPLY SWEEP WAITS FOR THE LOCK, AND A FROZEN PASS DOES NOT BLOCK THE NEXT ONE.
 *
 * MEASURED 9 Sept 2026 in the agent log: the sweep read conversations at 13:07 and 13:31 IST
 * and then twelve consecutive half-hourly ticks logged "a send is in progress — the reply
 * sweep waits for the next pass". At the one-minute pace a send holds the fleet lock ~47 s
 * of every ~60, so ONE try at a random instant loses about three times in four; nine hours
 * passed without a thread being read while the queue delivered all day. The same afternoon
 * the Mac slept mid-pass and every dark-wake tick read a boolean `running` flag about a pass
 * frozen for four hours.
 *
 * Both are driven here with fake timers: the sweep polls for the lock and reads once it
 * frees; it gives up only past the bounded wait; and a flag older than PASS_STALE_MS is
 * treated as stale rather than as a pass.
 */
const getSettings = vi.fn()
const checkForReplies = vi.fn()
const withSendLock = vi.fn()
vi.mock('@/lib/settings', () => ({ getSettings: (...a: unknown[]) => getSettings(...a) }))
vi.mock('@/outreach/replyCheck', () => ({ checkForReplies: (...a: unknown[]) => checkForReplies(...a) }))
vi.mock('@/outreach/dispatcher', () => ({
  dispatchTick: vi.fn(),
  withSendLock: (...a: unknown[]) => withSendLock(...a),
}))
vi.mock('@/lib/db', () => ({ prisma: { senderAccount: { findMany: vi.fn() }, setting: { findUnique: vi.fn(), upsert: vi.fn() } } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ hasSession: false, dir: '', initialised: false }) }))
vi.mock('@/agent/reconcile', () => ({ reconcileSessionRecords: vi.fn() }))
vi.mock('@/detection/autoResolve', () => ({ autoResolveBrands: vi.fn() }))
vi.mock('@/detection/officialDiscovery', () => ({ discoverOfficialPages: vi.fn() }))

const { replyPass, REPLY_LOCK_WAIT_MS, REPLY_LOCK_POLL_MS, PASS_STALE_MS } = await import('@/agent/index')

const summary = { checked: 4, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0 }

beforeEach(() => {
  vi.useFakeTimers()
  getSettings.mockReset().mockResolvedValue({ autopilotEnabled: true })
  checkForReplies.mockReset().mockResolvedValue(summary)
  withSendLock.mockReset()
})
afterEach(() => vi.useRealTimers())

/** The real wrapper returns null when the lock is held; `busyTimes` stands in for the sends. */
function lockBusyThenFree(busyTimes: number) {
  let calls = 0
  withSendLock.mockImplementation(async (_label: string, fn: () => Promise<unknown>) => {
    calls += 1
    return calls <= busyTimes ? null : fn()
  })
}

describe('the reply sweep and the fleet send lock', () => {
  it('polls for the lock while a send holds it and reads once it frees', async () => {
    lockBusyThenFree(2)
    const pass = replyPass()
    await vi.advanceTimersByTimeAsync(REPLY_LOCK_POLL_MS * 3)
    await pass
    expect(withSendLock).toHaveBeenCalledTimes(3)
    expect(checkForReplies, 'the lock freed and the sweep still lost its turn').toHaveBeenCalledTimes(1)
  })

  it('gives up only past the bounded wait, so a wedged lock cannot hold the tick forever', async () => {
    lockBusyThenFree(Number.POSITIVE_INFINITY)
    const pass = replyPass()
    await vi.advanceTimersByTimeAsync(REPLY_LOCK_WAIT_MS + REPLY_LOCK_POLL_MS * 2)
    await pass
    expect(checkForReplies).not.toHaveBeenCalled()
    // One try up front, then one per poll interval across the whole wait.
    expect(withSendLock.mock.calls.length).toBeGreaterThanOrEqual(1 + Math.floor(REPLY_LOCK_WAIT_MS / REPLY_LOCK_POLL_MS) - 1)
    expect(REPLY_LOCK_WAIT_MS, 'the wait must outlast a send plus the pace gap, or it is the old single try').toBeGreaterThan(90_000)
  })

  it('treats a pass flag older than PASS_STALE_MS as stale instead of skipping forever', async () => {
    // A pass frozen mid-lock (the Mac slept): the wrapper never resolves.
    withSendLock.mockImplementation(() => new Promise(() => undefined))
    void replyPass()
    await vi.advanceTimersByTimeAsync(0)
    expect(withSendLock).toHaveBeenCalledTimes(1)

    // Inside the bound the next tick correctly skips.
    await replyPass()
    expect(withSendLock, 'a second sweep started beside a live one').toHaveBeenCalledTimes(1)

    // Past the bound the flag is stale, and the sweep runs again.
    withSendLock.mockImplementation(async (_l: string, fn: () => Promise<unknown>) => fn())
    await vi.advanceTimersByTimeAsync(PASS_STALE_MS + 60_000)
    await replyPass()
    expect(withSendLock).toHaveBeenCalledTimes(2)
    expect(checkForReplies, 'a four-hour-old flag kept the sweep from ever running again').toHaveBeenCalledTimes(1)
  })
})
