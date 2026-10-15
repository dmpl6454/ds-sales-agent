import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * A FROZEN REPLY PASS DOES NOT BLOCK THE NEXT ONE.
 *
 * MEASURED 9 Sept 2026: the Mac slept mid-pass and every dark-wake tick read a boolean `running`
 * flag about a pass frozen for four hours (rule 27 — a "running" flag is a timestamp). Driven
 * here with fake timers: a flag older than PASS_STALE_MS is treated as stale rather than as a
 * pass, and inside the bound a second sweep correctly does not start beside a live one.
 *
 * THE LOCK-WAIT CASES MOVED. Until Stage 1.2 (2026-10-15) this file also drove the poll loop —
 * "polls for the lock while a send holds it" and "gives up only past the bounded wait" —
 * against `replyPass`, because the loop lived inline in the agent. The loop is now
 * `sweepUnderLock` in `src/outreach/replyCheck.ts`, shared by the slot and both CLIs, and both
 * cases live in `tests/reply-sweep-under-lock.test.ts` §(a) with every assertion they carried
 * (the call counts, the single run, and the `> 90_000` bound on the wait). What stays here is
 * the one property that is the AGENT's: its pass flag. The wrapper is mocked to never resolve,
 * which is what a pass frozen by sleep looks like from the flag's side.
 */
const getSettings = vi.fn()
const checkForReplies = vi.fn()
const sweepUnderLock = vi.fn()
vi.mock('@/lib/settings', () => ({ getSettings: (...a: unknown[]) => getSettings(...a) }))
vi.mock('@/outreach/replyCheck', () => ({
  checkForReplies: (...a: unknown[]) => checkForReplies(...a),
  sweepUnderLock: (...a: unknown[]) => sweepUnderLock(...a),
}))
vi.mock('@/outreach/dispatcher', () => ({ dispatchTick: vi.fn(), withSendLock: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { senderAccount: { findMany: vi.fn() }, setting: { findUnique: vi.fn(), upsert: vi.fn() } } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ hasSession: false, dir: '', initialised: false }) }))
vi.mock('@/agent/reconcile', () => ({ reconcileSessionRecords: vi.fn() }))
// This Mac is the selected sending Mac in these cases; the standby rule has its own test (tests/active-device.test.ts).
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true, selected: 'this-mac', thisDevice: 'this-mac' }) }))
vi.mock('@/detection/autoResolve', () => ({ autoResolveBrands: vi.fn() }))
vi.mock('@/detection/officialDiscovery', () => ({ discoverOfficialPages: vi.fn() }))

const { replyPass, PASS_STALE_MS } = await import('@/agent/index')

const summary = { checked: 4, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0 }

beforeEach(() => {
  vi.useFakeTimers()
  getSettings.mockReset().mockResolvedValue({ autopilotEnabled: true })
  checkForReplies.mockReset().mockResolvedValue(summary)
  sweepUnderLock.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('the reply sweep and its pass flag', () => {
  it('treats a pass flag older than PASS_STALE_MS as stale instead of skipping forever', async () => {
    // A pass frozen mid-lock (the Mac slept): the wrapper never resolves.
    sweepUnderLock.mockImplementation(() => new Promise(() => undefined))
    void replyPass()
    await vi.advanceTimersByTimeAsync(0)
    expect(sweepUnderLock).toHaveBeenCalledTimes(1)

    // Inside the bound the next tick correctly skips.
    await replyPass()
    expect(sweepUnderLock, 'a second sweep started beside a live one').toHaveBeenCalledTimes(1)

    // Past the bound the flag is stale, and the sweep runs again — through the wrapper, with
    // the sweep itself as the callback.
    sweepUnderLock.mockImplementation(async (_what: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }))
    await vi.advanceTimersByTimeAsync(PASS_STALE_MS + 60_000)
    await replyPass()
    expect(sweepUnderLock).toHaveBeenCalledTimes(2)
    expect(sweepUnderLock.mock.calls[1]![0]).toBe('reply-sweep')
    expect(checkForReplies, 'a four-hour-old flag kept the sweep from ever running again').toHaveBeenCalledTimes(1)
  })
})
