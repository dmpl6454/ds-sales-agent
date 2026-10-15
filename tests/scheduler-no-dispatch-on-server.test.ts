import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openOutreachDb } from './helpers/outreach-db'
import type { DetectionSummary } from '@/detection/pipeline'
import type { DispatchTickResult } from '@/outreach/dispatcher'

/**
 * ── THE SERVER DOES NOT SCHEDULE A DISPATCHER IT CANNOT RUN, AND A DRY_RUN STANDBY WRITES NO
 *    dispatchState (Stage 1.4, 2026-10-15) ───────────────────────────────────────────────────────
 *
 * THE DEFECTS, VERIFIED AT HEAD:
 *
 *   1. `startScheduler` registered the `dispatch` cron whatever `env.SEND_ENABLED` said. On the
 *      Linode (`SEND_ENABLED=false` by design) every tick ran `dispatchTick('cron')`: two Setting
 *      reads, `thisMacRole()`, and a *"this Mac is not the selected sending Mac — holding
 *      everything"* line about a datacenter. `runSlot` stage 3 did the same four times a day.
 *   2. `dispatchTick` asked DRY_RUN FIRST, and that branch WROTE `dispatchState` (audit L6). Any
 *      DRY_RUN host that is not the sender — the `DS_WATCH_MODE=scheduler` install, a dev checkout
 *      whose `.env` has `DRY_RUN=1` (this repo's own does) — overwrote the SENDING Mac's "what the
 *      last tick did" row on every tick. CLAUDE.md 2026-09-10 says a standby never writes that
 *      row; it held for every host except one that was also DRY_RUN.
 *
 * ── WHAT EACH SECTION PINS ───────────────────────────────────────────────────────────────────────
 *
 *   (a) `startScheduler` with the REAL module and a recording `node-cron`: SEND_ENABLED=false
 *       registers the slots and `detect` and NO task named `dispatch`, says so in ONE line and
 *       does not claim to be delivering; SEND_ENABLED=true registers `dispatch` and the task is
 *       wired to `dispatchTick`;
 *   (b) `dispatchTick` on a SEND_ENABLED=false host, DRY_RUN on: reason `send-disabled`, the
 *       `dispatchState` row (seeded with a sentinel standing for the sending Mac's) is UNTOUCHED,
 *       and neither `thisMacRole` nor `getSettings` was asked — a refused host pays no reads;
 *   (c) a standby host (SEND_ENABLED=true, role inactive), DRY_RUN on: `not-the-selected-mac`, row
 *       untouched, and `getSettings` not read by the tick itself;
 *   (d) the selected Mac under DRY_RUN STILL writes its dry-run hold — today's behaviour kept —
 *       and a selected, non-DRY_RUN Mac still writes the verdict of the full path (the control
 *       that makes (b) and (c) mean "refused" rather than "the write path is dead");
 *   (e) `runSlot` stage 3 on a SEND_ENABLED=false host never calls `dispatchTick`, records
 *       `detail.dispatch = { skipped: 'send-disabled' }` and leaves the run `OK`; on a sender host
 *       it still dispatches.
 *   (f) the refusal is logged once per process, not once per tick.
 *
 * ── WHY THE WRITE IS OBSERVED ON A REAL ROW ──────────────────────────────────────────────────────
 *
 * `recordDispatchState` is module-private, so "never called" is checked where it matters: the
 * `dispatchState` Setting row in a real temporary database. A sentinel is seeded before every case
 * and a refusal must leave its bytes alone. Mocking the writer would have asserted the call graph
 * the fix is about to change; the row cannot lie about it.
 *
 * ── MUTATIONS, EACH APPLIED BY HAND ONCE AND SEEN RED (2026-10-15), then restored ───────────────
 *
 *   M1  restore the DRY_RUN branch ABOVE the floor and the role check (the pre-1.4 order)
 *       → 3 RED here: the DRY_RUN-on cases of (b) and (c) read reason `dry-run` instead of
 *         `send-disabled` / `not-the-selected-mac` (by then the write has already overwritten the
 *         sentinel — the row assertions sit behind the reason ones), and (e)'s control reads
 *         `dry-run` for the same reason. 3 RED in `tests/active-device.test.ts` too: the old
 *         "no recordDispatchState before the standby return" check (now sliced from the function
 *         head), the DRY_RUN-after-standby order check and the floor-first check.
 *         The DRY_RUN-off cases stay green under it, as they should: the order only matters when
 *         DRY_RUN is on.
 *   M2  schedule the dispatch cron unconditionally (`if (true)` for `if (env.SEND_ENABLED)`)
 *       → 2 RED: (a)'s SEND_ENABLED=false case sees a task named `dispatch`, and the source-order
 *         check finds no `if (env.SEND_ENABLED)` ahead of it.
 *   M2b keep the cron conditional but drop the one startup line → 1 RED: (a), "exactly ONE line".
 *   M2c keep both but make the summary line claim `delivering every …` unconditionally → 1 RED: (a).
 *   M3  drop the `if (!env.SEND_ENABLED)` guard around `runSlot` stage 3's dispatch
 *       → 1 RED: (e) — the slot asked a host that cannot send to dispatch (`dispatchCalls` was
 *         `['slot:15:00']`; with the tick's own floor in place the verdict would have been
 *         `send-disabled`, so the call is what the test has to catch).
 *   M4  log the floor refusal on every tick (`if (true)` for the `sendDisabledSince === null` guard)
 *       → 1 RED: (f), three lines for three ticks.
 *   M5  delete the floor guard from `dispatchTick` (`if (false)` for `if (!env.SEND_ENABLED)`)
 *       → 3 RED here (both (b) cases and (f): the tick fell through to the role ask) and 1 in
 *         `tests/active-device.test.ts` (the floor-first source check).
 *   Each restore was verified by hash against the pre-mutation file.
 */

/** This machine, as the slot lock and the role see it. Set before anything reads the env. */
process.env.DS_DEVICE_NAME = 'tabish-mac'
process.env.DS_HOST_ID = 'host-tabish'
process.env.SEND_ENABLED = 'true'
// A catch-up run at startup would be a real `runSlot`; the schedule is what (a) is about.
process.env.CATCHUP_WINDOW_MINUTES = '0'

const envState = { SEND_ENABLED: true, DRY_RUN: true }
const thisMacRole = vi.fn()
let getSettingsCalls = 0
const dispatchCalls: string[] = []
let realDispatchTick: typeof import('@/outreach/dispatcher')['dispatchTick']
const scheduled: { expression: string; name: string | undefined; fn: () => unknown }[] = []

vi.mock('@/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/env')>()
  const env = new Proxy(real.env, {
    get: (t, k, r) => {
      if (k === 'SEND_ENABLED') return envState.SEND_ENABLED
      if (k === 'DRY_RUN') return envState.DRY_RUN
      return Reflect.get(t, k, r)
    },
  })
  return { ...real, env }
})
vi.mock('@/lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/settings')>()
  return {
    ...real,
    getSettings: (...a: Parameters<typeof real.getSettings>) => {
      getSettingsCalls += 1
      return real.getSettings(...a)
    },
  }
})
vi.mock('@/outreach/activeDevice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/activeDevice')>()),
  thisMacRole: () => thisMacRole(),
}))
vi.mock('@/outreach/dispatcher', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/outreach/dispatcher')>()
  realDispatchTick = real.dispatchTick
  return {
    ...real,
    // Delegates to the REAL tick; the spy only records WHO asked, so (e) can say "never called".
    dispatchTick: (reason: string) => {
      dispatchCalls.push(reason)
      return realDispatchTick(reason)
    },
  }
})
vi.mock('node-cron', () => ({
  default: {
    schedule: (expression: string, fn: () => unknown, opts?: { name?: string }) => {
      scheduled.push({ expression, name: opts?.name, fn })
      return { on: () => undefined, getNextRun: () => new Date(0), stop: async () => undefined }
    },
    shutdown: async () => undefined,
  },
}))
vi.mock('@/detection/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/pipeline')>()),
  runDetection: vi.fn(),
}))
vi.mock('@/outreach/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/plan')>()),
  runOutreach: vi.fn(),
}))

const db = await openOutreachDb('scheduler-no-dispatch-on-server')
const { prisma } = await import('@/lib/db')
const { log } = await import('@/lib/logger')
const { startScheduler, stopScheduler, DISPATCHER_NOT_SCHEDULED_LINE } = await import('@/worker/scheduler')
const { runSlot } = await import('@/worker/runSlot')
const { dispatchTick, DISPATCH_STATE_KEY } = await import('@/outreach/dispatcher')
const { runDetection } = await import('@/detection/pipeline')
const { runOutreach } = await import('@/outreach/plan')

/**
 * Per-case line buffers, plus ONE counter that is never reset: (f) is about a host that keeps being
 * asked, so it needs the total across every case that reached the floor, not just its own.
 */
let steps: string[] = []
let infos: string[] = []
let floorRefusalLines = 0
const FLOOR_LINE = /not allowed to send \(SEND_ENABLED=false\)/
vi.spyOn(log, 'step').mockImplementation((msg: string) => {
  steps.push(msg)
  if (FLOOR_LINE.test(msg)) floorRefusalLines += 1
})
vi.spyOn(log, 'info').mockImplementation((msg: string) => {
  infos.push(msg)
})
const stepMessages = () => steps
const infoMessages = () => infos

afterAll(async () => {
  await stopScheduler()
  await db.close(prisma)
})

const ACTIVE = { active: true, selected: 'tabish-mac', thisDevice: 'tabish-mac' } as const
const STANDBY = {
  active: false,
  selected: 'DMPLs Mac Studio',
  thisDevice: 'tabish-mac',
  reason: 'another-mac',
  detail: 'DMPLs Mac Studio is the selected sending Mac — this Mac (tabish-mac) holds everything, whatever is signed in here',
} as const

/** What the SENDING Mac last wrote. A host that must not write leaves these bytes exactly alone. */
const SENTINEL = JSON.stringify({
  at: '2026-10-15T09:00:00.000Z',
  atIst: '15 Oct 14:30',
  action: 'send',
  reason: 'sending',
  detail: '1 message(s) sent',
  sent: 1,
})
const stateRow = async () => (await prisma.setting.findUnique({ where: { key: DISPATCH_STATE_KEY } }))?.value ?? null

beforeEach(async () => {
  envState.SEND_ENABLED = true
  envState.DRY_RUN = true
  getSettingsCalls = 0
  dispatchCalls.length = 0
  scheduled.length = 0
  steps = []
  infos = []
  thisMacRole.mockReset().mockResolvedValue(ACTIVE)
  await prisma.setting.deleteMany()
  await prisma.setting.create({ data: { key: DISPATCH_STATE_KEY, value: SENTINEL } })
})
afterEach(async () => {
  await stopScheduler()
})

// ── (a) the schedule ───────────────────────────────────────────────────────────────────────

describe('(a) startScheduler registers a dispatcher only on a host that can send', () => {
  it('SEND_ENABLED=false: the slots and detection are scheduled, NO task named dispatch, one line says why', async () => {
    envState.SEND_ENABLED = false
    expect(await startScheduler('worker')).toBe(true)

    const names = scheduled.map((s) => s.name)
    expect(names, 'a dispatch cron on a host that cannot send is 96 refused ticks a day').not.toContain('dispatch')
    // Everything else the server is FOR is still there.
    expect(names).toContain('detect')
    for (const slot of ['11:00', '15:00', '17:00', '20:00']) expect(names).toContain(`slot-${slot}`)

    const notScheduled = [...stepMessages(), ...infoMessages()].filter((m) => m === DISPATCHER_NOT_SCHEDULED_LINE)
    expect(notScheduled, 'exactly ONE line about the dispatcher, not one per task').toHaveLength(1)
    expect(DISPATCHER_NOT_SCHEDULED_LINE).toMatch(/SEND_ENABLED=false/)
    expect(DISPATCHER_NOT_SCHEDULED_LINE).toMatch(/selected Mac/)

    const summary = infoMessages().find((m) => m.startsWith('watching '))
    expect(summary, 'the summary line is still printed').toBeDefined()
    expect(summary, 'and does not promise a delivery cadence nothing runs').not.toMatch(/delivering every/)
    expect(summary).toMatch(/not delivering from this host/)
  })

  it('SEND_ENABLED=true: the dispatch cron is registered, said so, and wired to dispatchTick', async () => {
    thisMacRole.mockResolvedValue(STANDBY) // so the tick it fires below drives nothing
    expect(await startScheduler('worker')).toBe(true)

    const dispatch = scheduled.filter((s) => s.name === 'dispatch')
    expect(dispatch).toHaveLength(1)
    expect(dispatch[0]!.expression).toMatch(/^\*\/\d+ \* \* \* \*$/)
    expect([...stepMessages(), ...infoMessages()]).not.toContain(DISPATCHER_NOT_SCHEDULED_LINE)
    expect(infoMessages().find((m) => m.startsWith('watching '))).toMatch(/delivering every/)

    await dispatch[0]!.fn()
    expect(dispatchCalls, 'the dispatch task must call dispatchTick("cron")').toEqual(['cron'])
  })
})

// ── (b)–(d) the tick ───────────────────────────────────────────────────────────────────────

describe('(b) a SEND_ENABLED=false host holds by name, writes nothing and asks nothing', () => {
  it('DRY_RUN on: send-disabled, the sending Mac\'s dispatchState row untouched, no role ask, no settings read', async () => {
    envState.SEND_ENABLED = false
    envState.DRY_RUN = true
    const r: DispatchTickResult = await dispatchTick('cron')
    expect(r.verdict.action).toBe('hold')
    if (r.verdict.action !== 'hold') throw new Error('unreachable')
    expect(r.verdict.reason).toBe('send-disabled')
    expect(r.verdict.detail).toMatch(/SEND_ENABLED=false/)
    expect(await stateRow(), 'a host that cannot send overwrote what the sending Mac last did').toBe(SENTINEL)
    expect(thisMacRole, 'the floor is asked BEFORE the role — a refused host pays no read').not.toHaveBeenCalled()
    expect(getSettingsCalls).toBe(0)
  })

  it('DRY_RUN off: the same — the floor does not depend on the dry-run switch', async () => {
    envState.SEND_ENABLED = false
    envState.DRY_RUN = false
    const r = await dispatchTick('operator:someone@example.com')
    expect(r.verdict.action === 'hold' && r.verdict.reason).toBe('send-disabled')
    expect(await stateRow()).toBe(SENTINEL)
    expect(thisMacRole).not.toHaveBeenCalled()
  })
})

describe('(c) a standby Mac holds by name and a DRY_RUN standby no longer overwrites the sender\'s row', () => {
  it('SEND_ENABLED=true, role inactive, DRY_RUN on: not-the-selected-mac, row untouched', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    envState.DRY_RUN = true
    const r = await dispatchTick('device')
    expect(r.verdict.action).toBe('hold')
    if (r.verdict.action !== 'hold') throw new Error('unreachable')
    expect(r.verdict.reason).toBe('not-the-selected-mac')
    expect(r.verdict.detail).toBe(STANDBY.detail)
    expect(await stateRow(), 'a DRY_RUN standby overwrote the sending Mac\'s dispatchState (audit L6)').toBe(SENTINEL)
    expect(thisMacRole).toHaveBeenCalledTimes(1)
    // The tick itself reads no settings on a standby: `thisMacRole` is the one read, and it is mocked here.
    expect(getSettingsCalls).toBe(0)
  })

  it('DRY_RUN off: the same (the 10 Sept rule, unchanged)', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    envState.DRY_RUN = false
    const r = await dispatchTick('device')
    expect(r.verdict.action === 'hold' && r.verdict.reason).toBe('not-the-selected-mac')
    expect(await stateRow()).toBe(SENTINEL)
  })
})

describe('(d) the selected Mac still writes — the control that makes (b) and (c) mean "refused"', () => {
  it('selected + DRY_RUN: the dry-run hold IS written, as before', async () => {
    envState.DRY_RUN = true
    const r = await dispatchTick('device')
    expect(r.verdict.action === 'hold' && r.verdict.reason).toBe('dry-run')
    const row = await stateRow()
    expect(row).not.toBe(SENTINEL)
    expect(JSON.parse(row!)).toMatchObject({ action: 'hold', reason: 'dry-run', sent: 0 })
    // DRY_RUN is answered before the tick reads settings it would not use.
    expect(getSettingsCalls).toBe(0)
  })

  it('selected + live (autopilot off): the full path runs and writes its verdict — the write path is not dead', async () => {
    envState.DRY_RUN = false
    const r = await dispatchTick('device')
    expect(r.verdict.action === 'hold' && r.verdict.reason).toBe('autopilot-off')
    const row = await stateRow()
    expect(row).not.toBe(SENTINEL)
    expect(JSON.parse(row!)).toMatchObject({ action: 'hold', reason: 'autopilot-off' })
    expect(getSettingsCalls, 'the settings are read once the tick knows it will use them').toBeGreaterThanOrEqual(1)
  })
})

// ── (e) the slot ───────────────────────────────────────────────────────────────────────────

describe('(e) runSlot stage 3', () => {
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
    vi.mocked(runDetection).mockReset().mockResolvedValue(detection())
    vi.mocked(runOutreach).mockReset().mockResolvedValue({ outcomes: [], queued: 0, sent: 0, failed: 0, skipped: 0 })
    await prisma.scrapeRun.deleteMany()
  })

  it('SEND_ENABLED=false: dispatchTick is never asked, the skip is recorded, the run stays OK', async () => {
    envState.SEND_ENABLED = false
    const result = await runSlot('15:00')
    expect(dispatchCalls, 'the slot asked a host that cannot send to dispatch').toEqual([])
    expect(result.status).toBe('OK')
    const run = await latestRun()
    expect(run.status, 'a permanent, by-design refusal must not mark all four daily slots PARTIAL').toBe('OK')
    expect(run.error).toBeNull()
    expect(detailOf(run).dispatch).toEqual({ skipped: 'send-disabled' })
    // The stages around it are untouched: detection ran, planning ran.
    expect(vi.mocked(runDetection)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runOutreach)).toHaveBeenCalledTimes(1)
    expect(await stateRow(), 'and the slot wrote nothing to the fleet\'s dispatchState').toBe(SENTINEL)
  })

  it('control, SEND_ENABLED=true: the slot still dispatches and records the tick\'s verdict', async () => {
    thisMacRole.mockResolvedValue(STANDBY)
    const result = await runSlot('15:00')
    expect(dispatchCalls).toEqual(['slot:15:00'])
    expect(result.status).toBe('OK')
    expect(detailOf(await latestRun()).dispatch).toMatchObject({ action: 'hold', reason: 'not-the-selected-mac', outcomes: [] })
  })
})

// ── (f) logging economy ────────────────────────────────────────────────────────────────────

describe('(f) the floor refusal is logged once per process, not once per tick', () => {
  it('three more ticks, at most one new line — and exactly one in the whole file', async () => {
    envState.SEND_ENABLED = false
    const before = floorRefusalLines
    for (let i = 0; i < 3; i++) await dispatchTick('cron')
    expect(
      floorRefusalLines - before,
      'a line per tick on a host whose answer never changes is 96 lines a day',
    ).toBeLessThanOrEqual(1)
    // Earlier cases already tripped the floor, so under a full run the delta is 0 and the total is 1;
    // run alone (-t) this case is the first to trip it and the delta is 1 and the total is 1. A
    // refusal logged per tick breaks both readings.
    expect(floorRefusalLines).toBe(1)
  })
})

// ── the source of the order, for a reader who skips the behaviour ──────────────────────────

describe('source order', () => {
  it('the scheduler keeps its dispatcher schedule inside one SEND_ENABLED branch', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src/worker/scheduler.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const branch = src.indexOf('if (env.SEND_ENABLED)')
    const schedule = src.indexOf("name: 'dispatch'")
    expect(branch).toBeGreaterThan(-1)
    expect(schedule).toBeGreaterThan(branch)
    // And there is exactly one place that schedules it.
    expect(src.match(/name: 'dispatch'/g)).toHaveLength(1)
  })
})
