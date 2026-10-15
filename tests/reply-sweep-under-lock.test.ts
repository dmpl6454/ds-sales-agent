import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openOutreachDb } from './helpers/outreach-db'
import type { DetectionSummary } from '@/detection/pipeline'
import type { DispatchTickResult } from '@/outreach/dispatcher'
import type { ReplyCheckSummary, UnderLockResult } from '@/outreach/replyCheck'

/**
 * ── EVERY REPLY SWEEP RUNS UNDER THE FLEET SEND LOCK, THROUGH ONE WRAPPER (Stage 1.2, 2026-10-15) ──
 *
 * THE DEFECT, VERIFIED AT HEAD (audit M26): the device agent's `replyPass` was the only sweep
 * caller that took the fleet send lock — and the only one that POLLED for it (a bare
 * `withSendLock` gives up on its first busy try; at the one-minute pace that loses three tries
 * in four, measured 9 Sept as nine blind hours). The slot's 11:00/20:00 sweep, `pnpm ig:replies`
 * and `pnpm ig:thread` took NO lock. A sweep drives the same Chrome profiles a send does, so on
 * a Mac running `DS_WATCH_MODE=scheduler`, or with an operator running either CLI beside the
 * agent, a profile was opened that the dispatcher could be mid-paste in — the one thing the
 * design forbids. `sweepUnderLock` (replyCheck.ts) is now the only path to the browser-driving
 * sweep: it pre-checks the three refusals `withSendLock` answers with a bare null (floor,
 * shutdown, role — in that order, the same order `withSendLock` asks them), then polls for a
 * busy lock, bounded.
 *
 * ── WHAT EACH SECTION PINS ───────────────────────────────────────────────────────────────────
 *
 *   (a) the wait loop, driven on `sweepUnderLock` directly with fake timers — the home of the
 *       behavioural loop tests that lived in `tests/reply-sweep-lock-wait.test.ts` against
 *       `replyPass` until this stage (every assertion moved; the PASS_STALE_MS case stays there);
 *   (b) the pre-checks: a refused host never touches the lock and never sleeps, and the order
 *       is the dispatcher's own;
 *   (c) THE SLOT: a real `runSlot('11:00')` on a temp database, with `withSendLock` returning
 *       null forever — the sweep is never reached, the refusal is RECORDED in the run's detail,
 *       and the run's status is UNTOUCHED (a verifier established that PARTIAL here would
 *       degrade two of the Linode's four daily slots forever and make /targets say "could not
 *       read every channel" about nothing);
 *   (d) the agent: `replyPass` reaches the sweep only through the wrapper, and only with the
 *       switch on;
 *   (e) the two CLIs — a source check, because no behavioural test can run a CLI's `main()`
 *       without a browser: both call `sweepUnderLock(`, and `ig:thread` launches its profile
 *       only inside the wrapper's callback;
 *   (f) totality: a FIFTH caller is how this defect arrives, so no file in `src` outside the
 *       wrapper's own module and its four callers may name `checkForReplies` at all, and the
 *       four may not call it directly.
 *
 * ── WHY THE MOCKS ARE PARTIAL AND SHARED ─────────────────────────────────────────────────────
 *
 * `vi.mock` is per file, and the sections need the SAME modules in different roles: the real
 * `sweepUnderLock` in (a)–(c), a mocked one in (d). So every mock delegates to a `vi.fn` the
 * sections re-point: `sweepUnderLock` delegates to the REAL implementation by default and (d)
 * swaps it; `withSendLock` is a `vi.fn` standing in for the fleet lock; the role, the shutdown
 * flag and `env.SEND_ENABLED` are each one switch. `importOriginal` keeps the rest real — the
 * slot's `holderIsSameMachine` among it — and the new `replyCheck → dispatcher` edge closes an
 * ESM cycle (`dispatcher → deliver → replyCheck`) that these partial mocks load cleanly.
 *
 * ── FAKE TIMERS AND A REAL DATABASE ──────────────────────────────────────────────────────────
 *
 * Only `setTimeout`, `clearTimeout` and `Date` are faked: the poll loop sleeps on the first and
 * bounds itself on the last, while Prisma's work lands through microtasks and `setImmediate`,
 * which stay real. `drain` alternates one poll of fake time with one real macrotask so the
 * slot's database writes between polls complete rather than being skipped over.
 *
 * ── MUTATIONS, EACH APPLIED BY HAND ONCE AND SEEN RED (2026-10-15), then restored ───────────
 *
 *   M1  the slot calls `checkForReplies()` directly instead of through the wrapper
 *       (`const under = { ok: true as const, value: await checkForReplies() }`)
 *       → 5 RED: all four (c) slot cases — the sweep ran under a lock that was never taken,
 *         `withSendLock` was never asked, the detail carried outcomes instead of the refusal —
 *         and (f), because a direct `checkForReplies(` call now sat in a caller.
 *   M2  the slot marks `status = 'PARTIAL'` on `!under.ok`
 *       → 3 RED: the lock-busy, standby and send-disabled slot cases in (c) read PARTIAL.
 *   M3  delete the `env.SEND_ENABLED` pre-check from `sweepUnderLock`
 *       → 4 RED: the (b) floor case polled the lock (`withSendLock` called) instead of refusing
 *         by name, the floor-before-shutdown order case fell through to 'shutdown', the source
 *         order check lost its floor, and the (c) send-disabled slot case fell to 'standby'.
 *   Each restore was verified by hash against the pre-mutation file.
 */

/** This machine, as the slot lock and the role see it. Set before anything reads the env. */
process.env.DS_DEVICE_NAME = 'tabish-mac'
process.env.DS_HOST_ID = 'host-tabish'
process.env.SEND_ENABLED = 'true'

const envState = { SEND_ENABLED: true }
const withSendLock = vi.fn()
const thisMacRole = vi.fn()
const shutdownRequested = vi.fn()
const checkForReplies = vi.fn()
const sweepUnderLockImpl = vi.fn()
const getSettings = vi.fn()
let realSweepUnderLock: typeof import('@/outreach/replyCheck')['sweepUnderLock']

vi.mock('@/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/env')>()
  const env = new Proxy(real.env, {
    get: (t, k, r) => (k === 'SEND_ENABLED' ? envState.SEND_ENABLED : Reflect.get(t, k, r)),
  })
  return { ...real, env }
})
vi.mock('@/outreach/activeDevice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/activeDevice')>()),
  thisMacRole: () => thisMacRole(),
}))
vi.mock('@/outreach/shutdown', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/shutdown')>()),
  browserShutdownRequested: () => shutdownRequested(),
}))
vi.mock('@/outreach/dispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/dispatcher')>()),
  withSendLock: (...a: unknown[]) => withSendLock(...a),
  dispatchTick: vi.fn(),
}))
vi.mock('@/outreach/replyCheck', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/outreach/replyCheck')>()
  realSweepUnderLock = real.sweepUnderLock
  return {
    ...real,
    checkForReplies: (...a: unknown[]) => checkForReplies(...a),
    sweepUnderLock: (...a: unknown[]) => sweepUnderLockImpl(...a),
  }
})
vi.mock('@/detection/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/pipeline')>()),
  runDetection: vi.fn(),
}))
vi.mock('@/outreach/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/plan')>()),
  runOutreach: vi.fn(),
}))
vi.mock('@/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/settings')>()),
  getSettings: () => getSettings(),
}))
// The agent imports these at module scope; none of them are exercised by `replyPass` or a slot.
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ hasSession: false, dir: '', initialised: false }) }))
vi.mock('@/agent/reconcile', () => ({ reconcileSessionRecords: vi.fn() }))
vi.mock('@/detection/autoResolve', () => ({ autoResolveBrands: vi.fn() }))
vi.mock('@/detection/officialDiscovery', () => ({ discoverOfficialPages: vi.fn() }))

const db = await openOutreachDb('reply-sweep-under-lock')
const { prisma } = await import('@/lib/db')
const replyCheck = await import('@/outreach/replyCheck')
const { sweepUnderLock, REPLY_LOCK_WAIT_MS, REPLY_LOCK_POLL_MS } = replyCheck
const { runSlot } = await import('@/worker/runSlot')
const { replyPass } = await import('@/agent/index')
const { runDetection } = await import('@/detection/pipeline')
const { dispatchTick } = await import('@/outreach/dispatcher')
const { runOutreach } = await import('@/outreach/plan')

afterAll(async () => {
  await db.close(prisma)
})

const ACTIVE = { active: true, selected: 'tabish-mac', thisDevice: 'tabish-mac' } as const
const STANDBY = {
  active: false,
  selected: 'DMPLs Mac Studio',
  thisDevice: 'tabish-mac',
  reason: 'another-mac',
  detail: 'DMPLs Mac Studio is the selected sending Mac',
} as const
const summary: ReplyCheckSummary = { checked: 4, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0, outcomes: [] }

/** The real wrapper returns null when the lock is held; `busyTimes` stands in for the sends. */
function lockBusyThenFree(busyTimes: number) {
  let calls = 0
  withSendLock.mockImplementation(async (_what: string, fn: () => Promise<unknown>) => {
    calls += 1
    return calls <= busyTimes ? null : fn()
  })
}

/**
 * Advance fake time one poll at a time until `p` settles, yielding a real macrotask between
 * polls so database work (which never touches a faked timer) lands. Bounded, like the loop.
 */
async function drain(p: Promise<unknown>, stepMs: number): Promise<void> {
  let settled = false
  p.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  for (let i = 0; i < 400 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(stepMs)
    await new Promise((r) => setImmediate(r))
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  envState.SEND_ENABLED = true
  withSendLock.mockReset()
  thisMacRole.mockReset().mockResolvedValue(ACTIVE)
  shutdownRequested.mockReset().mockReturnValue(false)
  checkForReplies.mockReset().mockResolvedValue(summary)
  sweepUnderLockImpl.mockReset().mockImplementation((...a: unknown[]) => (realSweepUnderLock as (...x: unknown[]) => unknown)(...a))
  getSettings.mockReset().mockResolvedValue({ autopilotEnabled: true })
})
afterEach(() => vi.useRealTimers())

// ── (a) the wait loop ──────────────────────────────────────────────────────────────────────

describe('(a) sweepUnderLock polls for the fleet lock, bounded', () => {
  it('polls while a send holds the lock and runs the sweep once it frees — ONE run, with its value', async () => {
    lockBusyThenFree(2)
    const fn = vi.fn(async () => summary)
    const p = sweepUnderLock('reply-sweep', fn)
    await drain(p, REPLY_LOCK_POLL_MS)
    expect(await p).toEqual({ ok: true, value: summary })
    expect(withSendLock).toHaveBeenCalledTimes(3)
    expect(withSendLock.mock.calls.every((c) => c[0] === 'reply-sweep'), 'the lock is taken under the caller\'s own name').toBe(true)
    expect(fn, 'the lock freed and the sweep still lost its turn, or ran twice').toHaveBeenCalledTimes(1)
  })

  it('gives up only past the bounded wait, so a wedged lock cannot hold a tick or a slot forever', async () => {
    lockBusyThenFree(Number.POSITIVE_INFINITY)
    const fn = vi.fn(async () => summary)
    const p = sweepUnderLock('reply-sweep', fn)
    await drain(p, REPLY_LOCK_POLL_MS)
    expect(await p).toEqual({ ok: false, why: 'lock-busy' })
    expect(fn).not.toHaveBeenCalled()
    // One try up front, then one per poll interval across the whole wait.
    expect(withSendLock.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(REPLY_LOCK_WAIT_MS / REPLY_LOCK_POLL_MS))
    expect(REPLY_LOCK_WAIT_MS, 'the wait must outlast a send plus the pace gap, or it is the old single try').toBeGreaterThan(90_000)
  })

  it('honours a caller\'s own bounds', async () => {
    lockBusyThenFree(Number.POSITIVE_INFINITY)
    const p = sweepUnderLock('thread-read', async () => undefined, { waitMs: 20_000, pollMs: 2_000 })
    await drain(p, 2_000)
    expect(await p).toEqual({ ok: false, why: 'lock-busy' })
    // 1 try up front + 10 polls, and not the default 37.
    expect(withSendLock).toHaveBeenCalledTimes(11)
  })

  it('a callback that resolves nothing is still a run — the box keeps `undefined` apart from "lock not taken"', async () => {
    lockBusyThenFree(0)
    expect(await sweepUnderLock('thread-read', async () => undefined)).toEqual({ ok: true, value: undefined })
    expect(await sweepUnderLock('thread-read', async () => null)).toEqual({ ok: true, value: null })
    expect(withSendLock).toHaveBeenCalledTimes(2)
  })

  it('a shutdown requested MID-WAIT ends the wait at once — an agent that is stopping does not spend its drain window polling', async () => {
    lockBusyThenFree(Number.POSITIVE_INFINITY)
    let polls = 0
    shutdownRequested.mockImplementation(() => polls++ >= 2)
    const p = sweepUnderLock('reply-sweep', async () => summary)
    await drain(p, REPLY_LOCK_POLL_MS)
    expect(await p).toEqual({ ok: false, why: 'shutdown' })
    expect(withSendLock.mock.calls.length).toBeLessThan(5)
  })

  it('keeps the three log sentences the agent printed, word for word — operators and tests grep for them', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src/outreach/replyCheck.ts'), 'utf8')
    for (const sentence of [
      'a send is in progress — the reply sweep is waiting for the lock',
      'the reply sweep got the lock',
      'a send is in progress — the reply sweep waits for the next pass',
    ]) {
      expect(src, `the sentence "${sentence}" is gone or reworded`).toContain(`'${sentence}'`)
    }
  })
})

// ── (b) the pre-checks ─────────────────────────────────────────────────────────────────────

describe('(b) the pre-checks: a refused host never touches the lock and never sleeps', () => {
  /**
   * Fake timers are ON here, so a wrapper that slept before refusing would never resolve and the
   * case would time out — "no sleep" is asserted by the promise settling at all, and by the
   * timer count.
   */
  it('SEND_ENABLED=false → send-disabled, withSendLock never asked, nothing slept', async () => {
    envState.SEND_ENABLED = false
    const fn = vi.fn(async () => summary)
    await expect(sweepUnderLock('reply-sweep', fn)).resolves.toEqual({ ok: false, why: 'send-disabled' })
    expect(withSendLock, 'the Linode\'s 11:00 slot would poll a lock it may never take, for three minutes').not.toHaveBeenCalled()
    expect(thisMacRole).not.toHaveBeenCalled()
    expect(fn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a standby Mac → standby, withSendLock never asked', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    await expect(sweepUnderLock('reply-sweep', async () => summary)).resolves.toEqual({ ok: false, why: 'standby' })
    expect(withSendLock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an unreadable role is standby too — "we could not ask" never authorises a browser', async () => {
    thisMacRole.mockResolvedValue({ active: false, selected: null, thisDevice: 'tabish-mac', reason: 'unreadable', detail: 'db down' })
    await expect(sweepUnderLock('reply-sweep', async () => summary)).resolves.toEqual({ ok: false, why: 'standby' })
    expect(withSendLock).not.toHaveBeenCalled()
  })

  it('a shutdown in progress → shutdown, withSendLock never asked', async () => {
    shutdownRequested.mockReturnValue(true)
    await expect(sweepUnderLock('reply-sweep', async () => summary)).resolves.toEqual({ ok: false, why: 'shutdown' })
    expect(withSendLock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the order is the dispatcher\'s own: floor, then shutdown, then role', async () => {
    envState.SEND_ENABLED = false
    shutdownRequested.mockReturnValue(true)
    thisMacRole.mockResolvedValue(STANDBY)
    await expect(sweepUnderLock('reply-sweep', async () => summary)).resolves.toEqual({ ok: false, why: 'send-disabled' })

    envState.SEND_ENABLED = true
    await expect(sweepUnderLock('reply-sweep', async () => summary)).resolves.toEqual({ ok: false, why: 'shutdown' })
    expect(thisMacRole, 'the role was read on a host that is stopping').not.toHaveBeenCalled()
  })

  it('the pre-check order in source matches withSendLock\'s: SEND_ENABLED, shutdown, thisMacRole, then the lock', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const src = strip(readFileSync(join(import.meta.dirname, '..', 'src/outreach/replyCheck.ts'), 'utf8'))
    const at = src.indexOf('export async function sweepUnderLock')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    const floor = body.indexOf('env.SEND_ENABLED')
    const shutdown = body.indexOf('browserShutdownRequested()')
    const role = body.indexOf('thisMacRole()')
    const lock = body.indexOf('withSendLock(')
    expect(floor).toBeGreaterThan(-1)
    expect(shutdown).toBeGreaterThan(floor)
    expect(role).toBeGreaterThan(shutdown)
    expect(lock).toBeGreaterThan(role)
    const dispatcher = strip(readFileSync(join(import.meta.dirname, '..', 'src/outreach/dispatcher.ts'), 'utf8'))
    const d = dispatcher.indexOf('export async function withSendLock')
    const dBody = dispatcher.slice(d, d + 1600)
    expect(dBody.indexOf('env.SEND_ENABLED')).toBeGreaterThan(-1)
    expect(dBody.indexOf('browserShutdownRequested()')).toBeGreaterThan(dBody.indexOf('env.SEND_ENABLED'))
    expect(dBody.indexOf('thisMacRole()')).toBeGreaterThan(dBody.indexOf('browserShutdownRequested()'))
  })
})

// ── (c) the slot ───────────────────────────────────────────────────────────────────────────

describe('(c) the slot\'s 11:00 sweep goes through the wrapper; a refusal is recorded and the status is untouched', () => {
  const detection = (): DetectionSummary =>
    ({
      channels: [],
      postsSeen: 3,
      newPosts: 0,
      detected: 0,
      hadParseFailure: false,
      hadError: false,
      throttledUntil: null,
      channelsUnread: 0,
      pagesFetched: 1,
    }) as unknown as DetectionSummary
  const latestRun = () => prisma.scrapeRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } })
  const detailOf = (run: { detail: string }) => JSON.parse(run.detail) as Record<string, unknown>

  beforeEach(async () => {
    for (const m of [runDetection, dispatchTick, runOutreach]) vi.mocked(m).mockReset()
    vi.mocked(runDetection).mockResolvedValue(detection())
    vi.mocked(dispatchTick).mockResolvedValue({
      verdict: { action: 'hold', reason: 'autopilot-off', detail: 'off' },
      at: new Date().toISOString(),
    } as unknown as DispatchTickResult)
    vi.mocked(runOutreach).mockResolvedValue({ outcomes: [], queued: 0, sent: 0, failed: 0, skipped: 0 })
    await prisma.scrapeRun.deleteMany()
    await prisma.setting.deleteMany()
  })

  it('a send holds the lock for the whole wait: the sweep is never reached, the run is OK and names the refusal', async () => {
    withSendLock.mockResolvedValue(null)
    const p = runSlot('11:00')
    await drain(p, REPLY_LOCK_POLL_MS)
    const result = await p
    expect(result.status).toBe('OK')
    expect(checkForReplies, 'the sweep ran under a lock that was never taken').not.toHaveBeenCalled()
    expect(withSendLock).toHaveBeenCalled()
    expect(withSendLock.mock.calls.every((c) => c[0] === 'reply-sweep'), 'the slot takes the lock under the sweep\'s name').toBe(true)
    // It polled for the bounded wait rather than giving up on the first busy try (rule 26).
    expect(withSendLock.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(REPLY_LOCK_WAIT_MS / REPLY_LOCK_POLL_MS))
    const run = await latestRun()
    expect(run.status).toBe('OK')
    expect(run.error).toBeNull()
    expect(detailOf(run).replyCheck).toEqual({ skipped: 'lock-busy' })
    // The stages after the sweep still ran: a refused sweep is not a stepped-over slot.
    expect(vi.mocked(dispatchTick)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runOutreach)).toHaveBeenCalledTimes(1)
  })

  it('on a standby Mac the slot never asks for the lock, records the refusal, and stays OK — no three-minute wait', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    const result = await runSlot('11:00')
    expect(result.status).toBe('OK')
    expect(withSendLock).not.toHaveBeenCalled()
    expect(checkForReplies).not.toHaveBeenCalled()
    const run = await latestRun()
    expect(run.status).toBe('OK')
    expect(detailOf(run).replyCheck).toEqual({ skipped: 'standby' })
  })

  it('on the Linode (SEND_ENABLED=false) likewise: send-disabled, status OK, nothing slept', async () => {
    envState.SEND_ENABLED = false
    const result = await runSlot('11:00')
    expect(result.status).toBe('OK')
    expect(withSendLock).not.toHaveBeenCalled()
    expect(detailOf(await latestRun()).replyCheck).toEqual({ skipped: 'send-disabled' })
  })

  it('control: with the lock free the sweep runs once, under the lock, and its outcomes are recorded as before', async () => {
    lockBusyThenFree(0)
    checkForReplies.mockResolvedValue({ ...summary, outcomes: [{ pairKey: 'a→b', status: 'no-reply' }] })
    const result = await runSlot('11:00')
    expect(result.status).toBe('OK')
    expect(checkForReplies).toHaveBeenCalledTimes(1)
    expect(withSendLock).toHaveBeenCalledTimes(1)
    expect(withSendLock.mock.calls[0]![0]).toBe('reply-sweep')
    expect(detailOf(await latestRun()).replyCheck).toEqual([{ pairKey: 'a→b', status: 'no-reply' }])
  })

  it('an unreadable thread still marks the run PARTIAL — the wrapper changed nothing about a sweep that ran', async () => {
    lockBusyThenFree(0)
    checkForReplies.mockResolvedValue({ ...summary, unreadable: 1 })
    const result = await runSlot('11:00')
    expect(result.status).toBe('PARTIAL')
    expect((await latestRun()).error).toMatch(/1 conversation\(s\) could not be read/)
  })
})

// ── (d) the agent ──────────────────────────────────────────────────────────────────────────

describe('(d) the agent\'s replyPass reaches the sweep only through the wrapper', () => {
  beforeEach(() => {
    sweepUnderLockImpl.mockReset().mockResolvedValue({ ok: true, value: summary } satisfies UnderLockResult<ReplyCheckSummary>)
  })

  it('with autopilot on and this Mac selected: sweepUnderLock("reply-sweep", checkForReplies), exactly once', async () => {
    await replyPass()
    expect(sweepUnderLockImpl).toHaveBeenCalledTimes(1)
    const [what, fn] = sweepUnderLockImpl.mock.calls[0]!
    expect(what).toBe('reply-sweep')
    expect(fn, 'the agent handed the wrapper something other than the sweep itself').toBe(replyCheck.checkForReplies)
    expect(checkForReplies, 'the agent called the sweep outside the wrapper').not.toHaveBeenCalled()
  })

  it('with autopilot off: never', async () => {
    getSettings.mockResolvedValue({ autopilotEnabled: false })
    await replyPass()
    expect(sweepUnderLockImpl).not.toHaveBeenCalled()
    expect(withSendLock).not.toHaveBeenCalled()
  })

  it('on a standby Mac: never — the agent asks the role itself before the wrapper does', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    await replyPass()
    expect(sweepUnderLockImpl).not.toHaveBeenCalled()
  })

  it('a refusal from the wrapper ends the pass cleanly, and the next pass runs again', async () => {
    sweepUnderLockImpl.mockResolvedValue({ ok: false, why: 'lock-busy' })
    await expect(replyPass()).resolves.toBeUndefined()
    await replyPass()
    expect(sweepUnderLockImpl, 'a refused pass left its running flag set').toHaveBeenCalledTimes(2)
  })
})

// ── (e) the two CLIs — a source check ──────────────────────────────────────────────────────

const root = join(import.meta.dirname, '..')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('(e) pnpm ig:replies and pnpm ig:thread go through the wrapper (a grep: a CLI\'s main() needs a browser)', () => {
  it('ig:replies calls sweepUnderLock( and never the sweep directly', () => {
    const src = strip(readFileSync(join(root, 'src/scripts/replies.ts'), 'utf8'))
    expect(src).toContain('sweepUnderLock(')
    expect(src).not.toContain('checkForReplies(')
  })

  it('ig:thread launches its profile only INSIDE the wrapper\'s callback', () => {
    const src = strip(readFileSync(join(root, 'src/scripts/thread.ts'), 'utf8'))
    const wrapper = src.indexOf('sweepUnderLock(')
    const launches = [...src.matchAll(/launchProfile\(/g)].map((m) => m.index!)
    expect(wrapper).toBeGreaterThan(-1)
    expect(launches, 'exactly one launch, so the position check below covers every browser').toHaveLength(1)
    expect(launches[0]!, 'the profile is launched before the lock is taken').toBeGreaterThan(wrapper)
    // The context is closed inside the callback, before the lock is released.
    const close = src.indexOf('context.close()')
    const callbackEnd = src.indexOf('\n  })\n', wrapper)
    expect(close).toBeGreaterThan(wrapper)
    expect(close).toBeLessThan(callbackEnd)
  })
})

// ── (f) totality ───────────────────────────────────────────────────────────────────────────

describe('(f) no fifth caller: outside the wrapper\'s module and its four callers, nothing in src names checkForReplies', () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? (n === 'generated' ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : []
    })
  const CALLERS = ['src/agent/index.ts', 'src/worker/runSlot.ts', 'src/scripts/replies.ts', 'src/scripts/thread.ts'].map((p) => join(root, p))
  const OWNER = join(root, 'src/outreach/replyCheck.ts')

  it('every file that names it is one of the four, and none of the four calls it directly', () => {
    const offenders: string[] = []
    let callers = 0
    for (const file of walk(join(root, 'src'))) {
      if (file === OWNER) continue
      const src = strip(readFileSync(file, 'utf8'))
      if (CALLERS.includes(file)) {
        if (src.includes('checkForReplies(')) offenders.push(`${file.replace(root, '')}: calls checkForReplies( directly`)
        if (src.includes('checkForReplies')) callers++
      } else if (src.includes('checkForReplies')) {
        offenders.push(`${file.replace(root, '')}: a fifth caller of the browser-driving sweep — route it through sweepUnderLock`)
      }
    }
    expect(offenders).toEqual([])
    // ig:thread reads a thread without the sweep; the other three hand the sweep to the wrapper.
    expect(callers, 'the scan is broken — the known callers were not found').toBe(3)
  })
})
