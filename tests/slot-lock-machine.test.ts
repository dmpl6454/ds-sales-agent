import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { openOutreachDb } from './helpers/outreach-db'

/**
 * ── THE SLOT LOCK HAS A MACHINE IDENTITY (Stage 1.1, 2026-10-15) ────────────────────────
 *
 * THE DEFECT, VERIFIED AT HEAD: `slotRunning` is one Postgres row shared by every host, and
 * `acquireSlotLock` asked the LOCAL kernel about the holder's pid. The Mac's `:3100` dashboard's
 * "Sync now" runs `runSlot('manual')` in the Mac's own process while the Linode worker holds
 * the row; `process.kill(<linode pid>, 0)` on the Mac answers ESRCH, the verdict was
 * 'take-over', and two planners ran — two drafts for one pair, the worst spam signal there is.
 * The send lock fixed the identical mistake on 2026-09-10; this is the same fix one lock along.
 *
 * The pure half pins `decideSlotLock` in every direction; the live half drives the REAL
 * acquire path through `withSlotLock` — the smallest public entry that reaches it (the
 * primitives are deliberately not exported: handing them out is how a caller releases a lock
 * it never took). `DS_DEVICE_NAME` and `DS_HOST_ID` stand in for this machine's identity.
 *
 * MUTATION, APPLIED BY HAND ONCE (2026-10-15): deleting the `if (!holderIsLocal)` branch of
 * `decideSlotLock` (treat every row as local) turned 6 of 34 cases RED across this file and
 * `tests/phase0.test.ts` — the three foreign pure cases and the three foreign live cases (a
 * fresh Linode row, a same-name twin, a no-device row) — and every local case stayed green.
 * The foreign-fresh cases fail because a foreign row's `holderAlive` is false and a dead local
 * holder is taken over; the live ones because this kernel has never heard of pid 2147483000.
 * Restored after, byte-identical.
 */

/** This machine, as the lock sees it. Set before `runSlot` is imported, as the agent would have them. */
const THIS_DEVICE = 'tabish-mac'
const THIS_HOST = 'host-tabish'
process.env.DS_DEVICE_NAME = THIS_DEVICE
process.env.DS_HOST_ID = THIS_HOST

const db = await openOutreachDb('slot-lock-machine')
const { prisma } = await import('@/lib/db')
const { decideSlotLock, withSlotLock, touchSlotLock } = await import('@/worker/runSlot')

afterAll(async () => {
  await db.close(prisma)
})

const MINUTE = 60_000
const STALE = 30 * MINUTE

describe('decideSlotLock — a foreign holder is judged by its progress stamp, a local one by its pid', () => {
  const OURS = 999
  const FOREIGN = { pid: 4242, slot: '11:00', at: '2026-10-15T05:30:00.000Z', device: 'linode-detect', host: 'host-linode' }
  const LOCAL = { pid: 4242, slot: '11:00', at: '2026-10-15T05:30:00.000Z', device: THIS_DEVICE, host: THIS_HOST }

  it('foreign and fresh → decline, not stalled — whatever this OS says about a pid it cannot see', () => {
    // The caller passes `holderAlive: false` for a foreign row (the probe is gated on locality)…
    expect(decideSlotLock({ held: FOREIGN, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
    // …and even if a local pid happened to coincide and answer "alive", the answer is the same.
    expect(decideSlotLock({ held: FOREIGN, holderAlive: true, holderIsLocal: false, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('foreign and stale → take over: a planner that has not refreshed its row in 30 minutes has died or hung', () => {
    expect(decideSlotLock({ held: FOREIGN, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: STALE })).toEqual({
      action: 'take-over',
    })
    expect(decideSlotLock({ held: FOREIGN, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: STALE - 1 })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('a foreign row whose progress stamp cannot be read counts as no progress, never as fresh', () => {
    // `acquireSlotLock` maps an unparseable `at` to Infinity; NaN would be declined forever.
    expect(decideSlotLock({ held: FOREIGN, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: Infinity })).toEqual({
      action: 'take-over',
    })
  })

  it('a row with NO device is foreign — passed as the caller computes it', () => {
    const legacy = { pid: 4242, slot: '11:00', at: FOREIGN.at }
    // Fresh: honoured. A Linode worker restarted onto this build waits for its predecessor's
    // old-format row to go stale rather than reading it as its own (one ≤30-minute wait, never
    // a second planner); a Mac reading the Linode's old-format row — the case that bit — waits too.
    expect(decideSlotLock({ held: legacy, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
    expect(decideSlotLock({ held: legacy, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: STALE })).toEqual({
      action: 'take-over',
    })
  })

  it('local and dead → take over (a crash or kill -9 left the row behind)', () => {
    expect(decideSlotLock({ held: LOCAL, holderAlive: false, holderIsLocal: true, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'take-over',
    })
  })

  it('local, alive and fresh → decline', () => {
    expect(decideSlotLock({ held: LOCAL, holderAlive: true, holderIsLocal: true, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('local, alive and stale → decline AND stalled: a hung local slot shares our clipboard, so it is an alarm, never a take-over', () => {
    expect(decideSlotLock({ held: LOCAL, holderAlive: true, holderIsLocal: true, ourPid: OURS, ageMs: 10 * 60 * MINUTE })).toEqual({
      action: 'decline',
      stalled: true,
    })
  })

  it('our own pid → take over', () => {
    expect(decideSlotLock({ held: { ...LOCAL, pid: OURS }, holderAlive: true, holderIsLocal: true, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'take-over',
    })
  })

  it('an unparseable row → take over rather than deadlock forever', () => {
    expect(decideSlotLock({ held: null, holderAlive: false, holderIsLocal: false, ourPid: OURS, ageMs: Infinity })).toEqual({
      action: 'take-over',
    })
  })
})

/**
 * The real acquire path, against a real database. Every row below names a pid that does not
 * exist on this machine, so under the OLD rule (ask the local kernel) each one read as dead
 * and was taken over — the pid alone can no longer decide.
 */
describe('acquireSlotLock, through withSlotLock — a Mac does not step over the Linode worker', () => {
  /** Larger than Linux's default pid_max (4194304) and macOS's (99998): ESRCH everywhere, never a live process. */
  const NOWHERE_PID = 2_147_483_000
  const slotRow = () => prisma.setting.findUnique({ where: { key: 'slotRunning' } })
  const seed = (fields: Record<string, unknown>) => {
    const value = JSON.stringify({ pid: NOWHERE_PID, slot: '11:00', ...fields })
    return prisma.setting.create({ data: { key: 'slotRunning', value } }).then(() => value)
  }
  const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString()

  beforeEach(async () => {
    await prisma.setting.deleteMany()
  })

  it('a FRESH row from another machine is declined, and left byte-identical', async () => {
    const foreign = await seed({ at: agoIso(20_000), device: 'linode-detect', host: 'other-host' })
    let ran = false
    expect(await withSlotLock('manual', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
    expect((await slotRow())?.value).toBe(foreign)
  })

  it('a row from another machine that stopped refreshing 31 minutes ago is taken over, and the new row names THIS machine', async () => {
    await seed({ at: agoIso(31 * MINUTE), device: 'linode-detect', host: 'other-host' })
    const during = await withSlotLock('manual', () => slotRow())
    expect(during).not.toBeNull()
    const written = JSON.parse(during!.value) as Record<string, unknown>
    expect(written).toMatchObject({ pid: process.pid, slot: 'manual', device: THIS_DEVICE, host: THIS_HOST })
    // …and the holder that took it over is the one that releases it.
    expect(await slotRow()).toBeNull()
  })

  it('a row this machine wrote (same name, same host) whose pid is dead is recovered at once', async () => {
    await seed({ at: agoIso(20_000), device: THIS_DEVICE, host: THIS_HOST })
    expect(await withSlotLock('slot-11:00', async () => 'ran')).toBe('ran')
    expect(await slotRow()).toBeNull()
  })

  it('a row under OUR NAME from a DIFFERENT host is another machine (rule 51): declined while fresh', async () => {
    const twin = await seed({ at: agoIso(20_000), device: THIS_DEVICE, host: 'host-twin' })
    let ran = false
    expect(await withSlotLock('manual', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
    expect((await slotRow())?.value).toBe(twin)
  })

  it('a row with NO device (a build older than the field) is foreign: honoured while fresh, taken over once stale', async () => {
    const legacyFresh = await seed({ at: agoIso(20_000) })
    expect(await withSlotLock('manual', async () => 'ran')).toBeNull()
    expect((await slotRow())?.value).toBe(legacyFresh)

    await prisma.setting.deleteMany()
    await seed({ at: agoIso(31 * MINUTE) })
    expect(await withSlotLock('manual', async () => 'ran')).toBe('ran')
    expect(await slotRow()).toBeNull()
  })

  it('every writer carries the machine: the refresh keeps device and host, so a holder never reads its own row as foreign', async () => {
    await withSlotLock('slot-15:00', async () => {
      const before = JSON.parse((await slotRow())!.value) as Record<string, unknown>
      expect(before).toMatchObject({ device: THIS_DEVICE, host: THIS_HOST })
      await new Promise((r) => setTimeout(r, 5))
      await touchSlotLock('slot-15:00')
      const after = JSON.parse((await slotRow())!.value) as Record<string, unknown>
      expect(after).toMatchObject({ pid: process.pid, slot: 'slot-15:00', device: THIS_DEVICE, host: THIS_HOST })
      expect(after.at).not.toBe(before.at)
    })
    expect(await slotRow()).toBeNull()
  })
})
