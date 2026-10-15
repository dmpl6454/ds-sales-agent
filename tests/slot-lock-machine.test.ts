import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { openOutreachDb } from './helpers/outreach-db'
import type { DetectionSummary } from '@/detection/pipeline'
import type { DispatchTickResult } from '@/outreach/dispatcher'
import type { SlotLockHolder } from '@/worker/runSlot'

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
 * ── AND THE FOUR REVIEWER MAJORS ON THAT BUILD, CLOSED THE SAME DAY ───────────────────────
 *
 *   F1  a stale foreign holder was stepped over on AGE ALONE — a slow-but-alive Linode slot
 *       (one detection stage ran 36 minutes on 8 Sept) would have been stepped over, and the
 *       docblock's claim that the row's own refresh was the ONLY liveness signal was false: the
 *       same worker process writes `schedulerHeartbeat` every 60 s. That beat is now the
 *       holder's PROCESS WITNESS (`holderProcessFresh`): a beat under 3 minutes old naming the
 *       row's machine AND pid vouches for it, and a vouched holder is declined however stale.
 *   F2  a holder that was stepped over never found out: `touchSlotLock` ignored `count === 0`
 *       and the slot ran its remaining stages, so the documented "bounded duplicate planner"
 *       actually happened. It returns false now, and `runSlotLocked` stops before its next stage.
 *   F3  the NaN→Infinity mapping for an unreadable `at` had no test that could fail — the pure
 *       case passed `Infinity` straight in. The live F3 cases below seed the unreadable row.
 *   F4  no case had a FOREIGN row whose pid equals OURS; pids collide across machines.
 *
 * ── AND THE SECOND REVIEW'S THREE MAJORS ON THAT FIX, CLOSED THE SAME DAY ─────────────────
 *
 *   R1  the heartbeat leaf returned null on a DATABASE ERROR, so `startScheduler`'s guard
 *   R2  against a second scheduler was skipped on a transient read failure (at HEAD the start
 *       rejected and the worker exited 1), and on the lock path a thrown read counted as "no
 *       vouch". Now `parseSchedulerHeartbeat` is pure, the read propagates, and
 *       `acquireSlotLock` DECLINES an attempt whose witness it could not read.
 *   R3  the scheduler heartbeat vouches for the WORKER only; a Mac "Sync now" or a `pnpm
 *       run:slot` wedged for 30 minutes was still stepped over, alive. Now EVERY holder's own
 *       process rewrites `beatAt` on the row every 60 s from a timer, and a beat under 3 min
 *       is a process witness on any machine; the heartbeat is kept as a second witness, read
 *       only where it can change the verdict. (The send lock's `deviceIsBeating` was the
 *       reviewer's suggestion and is deliberately NOT used — it proves the machine, and a dead
 *       "Sync now" on a beating Mac would be vouched for indefinitely with nothing on a Mac
 *       to reclaim the row.) The refresh, the beat and the release share one in-process write
 *       queue, because each is conditioned on the exact value the one before it wrote.
 *
 * The pure half pins `decideSlotLock` and `slotBeatVouchesFor` in every direction; the live
 * half drives the REAL acquire path through `withSlotLock` — the smallest public entry that
 * reaches it (the primitives are deliberately not exported: handing them out is how a caller
 * releases a lock it never took) — and the F2 slot case drives `runSlot` itself with its four
 * stages mocked. `DS_DEVICE_NAME` and `DS_HOST_ID` stand in for this machine's identity.
 *
 * MUTATIONS, EACH APPLIED BY HAND ONCE AND SEEN RED (2026-10-15), then restored byte-identical.
 * Counts are over the 59 cases of this file and `tests/phase0.test.ts` together:
 *
 *   M0  delete the `if (!holderIsLocal)` branch of `decideSlotLock` (treat every row as local)
 *       → 13 RED: the six foreign pure cases (a foreign row's `holderAlive` is false and a dead
 *       local holder is taken over) and the seven foreign live declines (this kernel has never
 *       heard of pid 2147483000, so every foreign row read as dead and was taken over — the
 *       R3 Mac row and the R1/R2 "read only where it matters" case among them). Every local
 *       case stayed green.
 *   M1  delete `if (holderProcessFresh) return { action: 'decline', stalled }` (F1, R3)
 *       → 4 RED: the vouched-and-stale pure case, the 31-minute Linode row beside a fresh beat,
 *       the 31-minute Mac row with a fresh own beat, and the "read only where it matters" case
 *       (its own-beat half is taken over). (The vouched-and-FRESH pure case stays green under
 *       it — fresh declines either way — so it pins the table row, not this mutation.)
 *   M2a `rewriteSlotLockRow` returns `true` when `count === 0` (F2)
 *       → 3 RED: the refresh-reports-false case, the `runSlot` stepped-over case, and the
 *       holder-writes case (a beat on a row that changed hands must report false).
 *   M2b `progress()` in `runSlotLocked` ignores the refresh's answer (`await touchSlotLock(slot); return true`)
 *       → 1 RED: the `runSlot` stepped-over case (planning ran) — the refresh case stays green,
 *       which is why the slot is driven and not only the primitive.
 *   M3  delete the `Number.isFinite` mapping in `acquireSlotLock` (`ageMs = rawAge`) (F3)
 *       → 2 RED: both unreadable-stamp live cases (`NaN >= staleMs` is false: declined forever).
 *   M4  hoist `if (held.pid === ourPid) return { action: 'take-over' }` above the foreign branch (F4)
 *       → 2 RED: the pure and the live colliding-pid cases.
 *   M5  `acquireSlotLock` ignores the row's own beat (`const ownBeat: boolean = false`) (R3)
 *       → 2 RED: the 31-minute Mac row with a 10-second beat is taken over, and the "read only
 *       where it matters" case reads the heartbeat for a row its own beat should have answered.
 *   M6  `readSchedulerHeartbeat` wraps the query in its `try` and returns null (the first
 *       version's shape) (R1, R2)
 *       → 2 RED: the REJECT case resolves null for both readers, and the unreadable-witness
 *       live case is taken over instead of declined.
 *   M7  `acquireSlotLock` catches the thrown read as `witness = null` and goes on (R2 — and the
 *       exact `.catch(() => null)` the first finding proposed)
 *       → 1 RED: the unreadable-witness live case is taken over.
 *   M8  the beat rebuilds the row with no `progressAt` — it claims a stage ended (R3)
 *       → 2 RED: the holder-writes case (`at` moved on a beat) and the timer case.
 *   M9  `queuedRowWrite` runs its write at once instead of behind the previous one (R3)
 *       → 1 RED: the refresh-and-beat-in-one-tick case — the second write's `where` names a
 *       value the first already replaced, so it reports a loss that never happened. (A case
 *       that fired a beat without awaiting it and then returned, expecting the release to be
 *       queued behind it, stayed GREEN under this mutation — the delete happened to run first —
 *       and was removed: a test that passes with its guard deleted is not evidence.)
 *   M10a `withSlotLock` never starts the beat timer; M10b it never stops it
 *       → 1 RED each: the timer case (`beatAt` never moves; the timer survives the release).
 */

/** This machine, as the lock sees it. Set before `runSlot` is imported, as the agent would have them. */
const THIS_DEVICE = 'tabish-mac'
const THIS_HOST = 'host-tabish'
process.env.DS_DEVICE_NAME = THIS_DEVICE
process.env.DS_HOST_ID = THIS_HOST

/**
 * The four stages of a slot, mocked so `runSlot` can be driven against the temp database with no
 * feed, no browser and no planner. `importOriginal` keeps everything else real — in particular
 * `holderIsSameMachine`, which `acquireSlotLock` imports from the dispatcher. The factories run
 * lazily, at the first import below, which is after the database is open and the env is set.
 */
vi.mock('@/detection/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/pipeline')>()),
  runDetection: vi.fn(),
}))
vi.mock('@/outreach/replyCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/replyCheck')>()),
  checkForReplies: vi.fn(),
}))
vi.mock('@/outreach/dispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/dispatcher')>()),
  dispatchTick: vi.fn(),
}))
vi.mock('@/outreach/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/plan')>()),
  runOutreach: vi.fn(),
}))

const db = await openOutreachDb('slot-lock-machine')
const { prisma } = await import('@/lib/db')
const { decideSlotLock, withSlotLock, touchSlotLock, beatSlotLock, slotBeatVouchesFor, SLOT_LOCK_BEAT_STALE_MS, runSlot, slotLockHeldInThisProcess } =
  await import('@/worker/runSlot')
const { readSchedulerHeartbeat, HEARTBEAT_KEY } = await import('@/worker/heartbeat')
const { readHeartbeat } = await import('@/worker/scheduler')
const { runDetection } = await import('@/detection/pipeline')
const { checkForReplies } = await import('@/outreach/replyCheck')
const { dispatchTick } = await import('@/outreach/dispatcher')
const { runOutreach } = await import('@/outreach/plan')

afterAll(async () => {
  await db.close(prisma)
})

const MINUTE = 60_000
const STALE = 30 * MINUTE

describe('decideSlotLock — a foreign holder is judged by its progress stamp and its process witness, a local one by its pid', () => {
  const OURS = 999
  const FOREIGN = { pid: 4242, slot: '11:00', at: '2026-10-15T05:30:00.000Z', device: 'linode-detect', host: 'host-linode' }
  const LOCAL = { pid: 4242, slot: '11:00', at: '2026-10-15T05:30:00.000Z', device: THIS_DEVICE, host: THIS_HOST }
  /** A foreign holder nothing vouches for: no heartbeat, or one for another machine or pid. */
  const unvouched = { holderAlive: false, holderIsLocal: false, holderProcessFresh: false, ourPid: OURS }
  const vouched = { ...unvouched, holderProcessFresh: true }

  it('foreign and fresh → decline, not stalled — whatever this OS says about a pid it cannot see', () => {
    // The caller passes `holderAlive: false` for a foreign row (the probe is gated on locality)…
    expect(decideSlotLock({ held: FOREIGN, ...unvouched, ageMs: MINUTE })).toEqual({ action: 'decline', stalled: false })
    // …and even if a local pid happened to coincide and answer "alive", the answer is the same.
    expect(decideSlotLock({ held: FOREIGN, ...unvouched, holderAlive: true, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('foreign and stale with NOTHING vouching for it → take over: no stage ended in 30 minutes and no heartbeat says the process lives', () => {
    expect(decideSlotLock({ held: FOREIGN, ...unvouched, ageMs: STALE })).toEqual({ action: 'take-over' })
    expect(decideSlotLock({ held: FOREIGN, ...unvouched, ageMs: STALE - 1 })).toEqual({ action: 'decline', stalled: false })
  })

  /**
   * F1. The Linode worker's own heartbeat keeps beating while one of its stages runs long, and a
   * beat naming the row's machine and pid is the holder's process, alive. Declined — and STALLED
   * past the bound, so the acquire logs the alarm a slow live holder deserves instead of silence.
   */
  it('F1: foreign and stale, but its scheduler heartbeat vouches for the process → decline, STALLED — a live holder is never stepped over', () => {
    expect(decideSlotLock({ held: FOREIGN, ...vouched, ageMs: STALE })).toEqual({ action: 'decline', stalled: true })
    expect(decideSlotLock({ held: FOREIGN, ...vouched, ageMs: 10 * 60 * MINUTE })).toEqual({ action: 'decline', stalled: true })
  })

  it('F1: foreign, fresh and vouched → decline, not stalled', () => {
    expect(decideSlotLock({ held: FOREIGN, ...vouched, ageMs: MINUTE })).toEqual({ action: 'decline', stalled: false })
  })

  /**
   * F4. A pid is a fact about one machine: a container's first process is pid 1, and two hosts
   * can run the same pid at once. The own-pid take-over is for OUR OWN row, and a row from
   * another machine is never that, whatever its pid — `tests/dispatcher.test.ts` pins the same
   * for the send lock.
   */
  it('F4: a FOREIGN row carrying OUR OWN pid is still foreign — declined while fresh, never "reclaimed"', () => {
    expect(decideSlotLock({ held: { ...FOREIGN, pid: OURS }, ...unvouched, holderAlive: true, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('given Infinity for the age, an unvouched foreign row is taken over — the MAPPING that turns an unreadable stamp into Infinity is pinned by the live F3 cases, not by this', () => {
    expect(decideSlotLock({ held: FOREIGN, ...unvouched, ageMs: Infinity })).toEqual({ action: 'take-over' })
  })

  it('a row with NO device is foreign — passed as the caller computes it, and never vouched (it names no machine a beat could match)', () => {
    const legacy = { pid: 4242, slot: '11:00', at: FOREIGN.at }
    // Fresh: honoured. A Linode worker restarted onto this build waits for its predecessor's
    // old-format row to go stale rather than reading it as its own (one ≤30-minute wait, never
    // a second planner); a Mac reading the Linode's old-format row — the case that bit — waits too.
    expect(decideSlotLock({ held: legacy, ...unvouched, ageMs: MINUTE })).toEqual({ action: 'decline', stalled: false })
    expect(decideSlotLock({ held: legacy, ...unvouched, ageMs: STALE })).toEqual({ action: 'take-over' })
  })

  it('local and dead → take over (a crash or kill -9 left the row behind)', () => {
    expect(decideSlotLock({ held: LOCAL, holderAlive: false, holderIsLocal: true, holderProcessFresh: false, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'take-over',
    })
  })

  it('local, alive and fresh → decline', () => {
    expect(decideSlotLock({ held: LOCAL, holderAlive: true, holderIsLocal: true, holderProcessFresh: false, ourPid: OURS, ageMs: MINUTE })).toEqual({
      action: 'decline',
      stalled: false,
    })
  })

  it('local, alive and stale → decline AND stalled: a hung local slot shares our clipboard, so it is an alarm, never a take-over', () => {
    expect(
      decideSlotLock({ held: LOCAL, holderAlive: true, holderIsLocal: true, holderProcessFresh: false, ourPid: OURS, ageMs: 10 * 60 * MINUTE }),
    ).toEqual({ action: 'decline', stalled: true })
  })

  it('our own pid, on our own row → take over', () => {
    expect(
      decideSlotLock({ held: { ...LOCAL, pid: OURS }, holderAlive: true, holderIsLocal: true, holderProcessFresh: false, ourPid: OURS, ageMs: MINUTE }),
    ).toEqual({ action: 'take-over' })
  })

  it('an unparseable row → take over rather than deadlock forever', () => {
    expect(decideSlotLock({ held: null, ...unvouched, ageMs: Infinity })).toEqual({ action: 'take-over' })
  })
})

/**
 * R3 (reviewer major 3 on the first version). The scheduler heartbeat vouches for the WORKER
 * alone; a Mac's "Sync now" and a `pnpm run:slot` write none, so a Mac slot wedged for thirty
 * minutes was stepped over alive. Now every holder's own process rewrites `beatAt` every 60 s,
 * and that beat is a process witness on any machine. The pure half here; the live half below.
 */
describe("slotBeatVouchesFor — the row's OWN beat is its holder's process witness", () => {
  const NOW = Date.parse('2026-10-15T06:00:00.000Z')
  const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
  const row = (beatAt?: string): SlotLockHolder => ({
    pid: 4242,
    slot: 'manual',
    at: '2026-10-15T05:00:00.000Z', // an hour stale: the stamp is not what this function reads
    device: 'mac-studio',
    host: 'host-studio',
    ...(beatAt === undefined ? {} : { beatAt }),
  })

  it('a beat younger than SLOT_LOCK_BEAT_STALE_MS vouches, whatever the stamp says; one exactly that old does not', () => {
    expect(slotBeatVouchesFor(row(iso(10_000)), NOW)).toBe(true)
    expect(slotBeatVouchesFor(row(iso(SLOT_LOCK_BEAT_STALE_MS - 1)), NOW)).toBe(true)
    expect(slotBeatVouchesFor(row(iso(SLOT_LOCK_BEAT_STALE_MS)), NOW)).toBe(false)
  })

  it('absent → no vouch: a row from a build older than the field is judged on its stamp, the 30-minute bound', () => {
    expect(slotBeatVouchesFor(row(), NOW)).toBe(false)
  })

  it('unparseable → no vouch, and never NaN leaking through the comparison', () => {
    expect(slotBeatVouchesFor(row('not-a-date'), NOW)).toBe(false)
    expect(slotBeatVouchesFor({ ...row(), beatAt: 5 as unknown as string }, NOW)).toBe(false)
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
  /** What the Linode worker writes every 60 s (`scheduler.ts` → `writeHeartbeat`), shaped exactly as it writes it. */
  const seedBeat = (fields: { pid: number; at: string; machine?: string }) =>
    prisma.setting.create({ data: { key: 'schedulerHeartbeat', value: JSON.stringify({ host: 'worker', ...fields }) } })
  const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString()
  /** Drive a take-over and return the row as written by the new holder. */
  const takeOver = async () => {
    const during = await withSlotLock('manual', () => slotRow())
    expect(during, 'expected the lock to be taken over').not.toBeNull()
    const written = JSON.parse(during!.value) as Record<string, unknown>
    expect(written).toMatchObject({ pid: process.pid, slot: 'manual', device: THIS_DEVICE, host: THIS_HOST })
    // …and the holder that took it over is the one that releases it.
    expect(await slotRow()).toBeNull()
    return written
  }
  /** Drive a decline and assert the holder's row was not touched. */
  const declined = async (row: string) => {
    let ran = false
    expect(await withSlotLock('manual', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
    expect((await slotRow())?.value).toBe(row)
  }

  beforeEach(async () => {
    await prisma.setting.deleteMany()
  })

  it('a FRESH row from another machine is declined, and left byte-identical', async () => {
    await declined(await seed({ at: agoIso(20_000), device: 'linode-detect', host: 'other-host' }))
  })

  it('a row from another machine that stopped refreshing 31 minutes ago, with no heartbeat vouching for it, is taken over, and the new row names THIS machine', async () => {
    await seed({ at: agoIso(31 * MINUTE), device: 'linode-detect', host: 'other-host' })
    await takeOver()
  })

  it('a row this machine wrote (same name, same host) whose pid is dead is recovered at once', async () => {
    await seed({ at: agoIso(20_000), device: THIS_DEVICE, host: THIS_HOST })
    expect(await withSlotLock('slot-11:00', async () => 'ran')).toBe('ran')
    expect(await slotRow()).toBeNull()
  })

  it('a row under OUR NAME from a DIFFERENT host is another machine (rule 51): declined while fresh', async () => {
    await declined(await seed({ at: agoIso(20_000), device: THIS_DEVICE, host: 'host-twin' }))
  })

  it('a row with NO device (a build older than the field) is foreign: honoured while fresh, taken over once stale', async () => {
    await declined(await seed({ at: agoIso(20_000) }))

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
      expect(await touchSlotLock('slot-15:00')).toBe(true)
      const after = JSON.parse((await slotRow())!.value) as Record<string, unknown>
      expect(after).toMatchObject({ pid: process.pid, slot: 'slot-15:00', device: THIS_DEVICE, host: THIS_HOST })
      expect(after.at).not.toBe(before.at)
    })
    expect(await slotRow()).toBeNull()
  })

  /**
   * F1, LIVE. The row is 31 minutes stale — the exact row the first version of this build stepped
   * over — and the scheduler heartbeat beside it is what decides. `machineId()` and `deviceId()`
   * are ONE source, so the beat's `machine` and the row's `device` are compared like for like.
   */
  describe('F1 — a foreign holder whose scheduler heartbeat still beats is ALIVE, however stale its stamp', () => {
    const LINODE = { device: 'linode-detect', host: 'other-host' }

    it('a 31-minute-old Linode row beside a fresh beat naming the same machine and pid is declined, byte-identical', async () => {
      const foreign = await seed({ at: agoIso(31 * MINUTE), ...LINODE })
      await seedBeat({ pid: NOWHERE_PID, at: agoIso(10_000), machine: 'linode-detect' })
      await declined(foreign)
      // The control that proves the beat did it: delete it and the same row is stepped over.
      await prisma.setting.delete({ where: { key: 'schedulerHeartbeat' } })
      await takeOver()
    })

    it('the same row beside a beat 4 minutes old is taken over — the witness itself has gone stale (HEARTBEAT_STALE_MS is 3 min)', async () => {
      await seed({ at: agoIso(31 * MINUTE), ...LINODE })
      await seedBeat({ pid: NOWHERE_PID, at: agoIso(4 * MINUTE), machine: 'linode-detect' })
      await takeOver()
    })

    it('a fresh beat for a DIFFERENT pid on that machine is no vouch: a beat for another process says nothing about this one → taken over', async () => {
      await seed({ at: agoIso(31 * MINUTE), ...LINODE })
      await seedBeat({ pid: NOWHERE_PID - 1, at: agoIso(10_000), machine: 'linode-detect' })
      await takeOver()
    })

    it('a fresh beat with the same pid from a DIFFERENT machine is no vouch → taken over', async () => {
      await seed({ at: agoIso(31 * MINUTE), ...LINODE })
      await seedBeat({ pid: NOWHERE_PID, at: agoIso(10_000), machine: 'some-other-box' })
      await takeOver()
    })

    it('a legacy row (no device) beside a legacy beat (no machine) with the same pid: `undefined` is not a machine → taken over', async () => {
      await seed({ at: agoIso(31 * MINUTE) })
      await seedBeat({ pid: NOWHERE_PID, at: agoIso(10_000) })
      await takeOver()
    })
  })

  /**
   * F2, LIVE. Until this build the refresh ignored `count === 0`, so a holder whose row had
   * changed hands kept running. The release is value-conditioned (`deleteMany` on the exact
   * value this process last wrote), so after a loss it matches nothing — asserted here, not
   * assumed: the new holder's row must survive the stepped-over holder's `finally`.
   */
  describe('F2 — a holder that is stepped over finds out, and the release deletes nothing of the new holder', () => {
    const foreignRow = () => JSON.stringify({ pid: NOWHERE_PID, slot: 'other', at: agoIso(0), device: 'linode-detect', host: 'other-host' })

    it('touchSlotLock reports true while the row is ours, false once it changed hands — and stays false', async () => {
      const foreign = foreignRow()
      const seen: boolean[] = []
      await withSlotLock('detect-draft', async () => {
        seen.push(await touchSlotLock('detect-draft'))
        await prisma.setting.update({ where: { key: 'slotRunning' }, data: { value: foreign } })
        seen.push(await touchSlotLock('detect-draft'))
        // A lost lock stays lost: the refresh's `where` still names our old value.
        seen.push(await touchSlotLock('detect-draft'))
        expect((await slotRow())?.value).toBe(foreign)
      })
      expect(seen).toEqual([true, false, false])
      // The wrapper's `finally` ran `releaseSlotLock`, conditioned on OUR value: the foreign row stands.
      expect((await slotRow())?.value).toBe(foreign)
      expect(slotLockHeldInThisProcess()).toBe(false)
    })

    /**
     * THE SLOT ITSELF, with its four stages mocked. The detection mock overwrites the lock row
     * with a foreign holder before returning — what the row looks like after another machine
     * stepped over a 30-minute detection stage — and the assertion is BEHAVIOURAL: the stages
     * after it never run. A control first, so "never called" is proven to be the fence and not
     * the mocks failing to wire.
     */
    describe('runSlot: a slot whose lock changed hands mid-stage runs no further stage', () => {
      const summary = (): DetectionSummary =>
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

      beforeEach(async () => {
        for (const m of [runDetection, checkForReplies, dispatchTick, runOutreach]) vi.mocked(m).mockReset()
        vi.mocked(runDetection).mockResolvedValue(summary())
        vi.mocked(checkForReplies).mockResolvedValue({ checked: 0, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0, outcomes: [] })
        vi.mocked(dispatchTick).mockResolvedValue({
          verdict: { action: 'hold', reason: 'autopilot-off', detail: 'off' },
          at: new Date().toISOString(),
        } as unknown as DispatchTickResult)
        vi.mocked(runOutreach).mockResolvedValue({ outcomes: [], queued: 0, sent: 0, failed: 0, skipped: 0 })
        await prisma.scrapeRun.deleteMany()
        /**
         * Since Stage 1.2 the slot's sweep runs through `sweepUnderLock`, which refuses by name on
         * a Mac that is not selected to send. This Mac is selected here, so the control case below
         * proves the sweep runs UNDER the real fleet lock (`withSendLock` is real in this file) and
         * not merely that the mock was wired. `tests/reply-sweep-under-lock.test.ts` pins the
         * refusal on a standby Mac.
         */
        await prisma.setting.upsert({
          where: { key: 'activeDevice' },
          update: { value: THIS_DEVICE },
          create: { key: 'activeDevice', value: THIS_DEVICE },
        })
      })

      it('control: with the lock kept, an 11:00 slot runs all four stages and records OK', async () => {
        const result = await runSlot('11:00')
        expect(result.status).toBe('OK')
        expect(vi.mocked(runDetection)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(checkForReplies)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(dispatchTick)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(runOutreach)).toHaveBeenCalledTimes(1)
        const run = await latestRun()
        expect(run.status).toBe('OK')
        expect(run.error).toBeNull()
        expect(await slotRow()).toBeNull()
        // The sweep ran under the real fleet lock and released it (Stage 1.2).
        expect(await prisma.setting.findUnique({ where: { key: 'sendLock' } })).toBeNull()
      })

      it('detection outlived the lock and another machine took it: no reply sweep, no dispatch, NO PLANNING; the run is PARTIAL and names the loss; the new holder\'s row survives', async () => {
        const foreign = foreignRow()
        vi.mocked(runDetection).mockImplementation(async () => {
          await prisma.setting.update({ where: { key: 'slotRunning' }, data: { value: foreign } })
          return summary()
        })
        const result = await runSlot('11:00')
        expect(result.status).toBe('PARTIAL')
        expect(result.postsSeen).toBe(3) // the stage that ran is real and recorded
        expect(vi.mocked(runDetection)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(checkForReplies)).not.toHaveBeenCalled()
        expect(vi.mocked(dispatchTick)).not.toHaveBeenCalled()
        expect(vi.mocked(runOutreach)).not.toHaveBeenCalled()
        const run = await latestRun()
        expect(run.status).toBe('PARTIAL')
        expect(run.finishedAt).not.toBeNull()
        expect(run.error).toMatch(/lost the slot lock to another machine — stopped before reply check/)
        // The value-conditioned release deleted nothing of the new holder's.
        expect((await slotRow())?.value).toBe(foreign)
        expect(slotLockHeldInThisProcess()).toBe(false)
      })
    })
  })

  /**
   * F3, LIVE. `acquireSlotLock` maps an unreadable `at` to Infinity — "no progress", so an
   * unvouched foreign row with a stamp nobody can read is taken over rather than declined
   * forever (`NaN >= staleMs` is false). These are the rows the mapping is for.
   */
  describe('F3 — an unreadable progress stamp on a foreign row is NO progress, never NaN', () => {
    it('`at: "not-a-date"` → taken over, and the new row names this device', async () => {
      await seed({ at: 'not-a-date', device: 'linode-detect', host: 'other-host' })
      await takeOver()
    })

    it('`at` omitted entirely → the same', async () => {
      await seed({ device: 'linode-detect', host: 'other-host' })
      await takeOver()
    })
  })

  /** F4, LIVE: the pid in the row is THIS process's own, on a row another machine wrote. */
  it('F4: a foreign row that happens to carry this process\'s pid is declined while fresh — a colliding pid is not us', async () => {
    await declined(await seed({ pid: process.pid, at: agoIso(20_000), device: 'linode-detect', host: 'other-host' }))
  })

  /**
   * R3, LIVE. The rows below are a Mac dashboard's "Sync now" — a holder nothing but its own
   * beat can vouch for: no scheduler heartbeat is ever seeded, and the send lock's machine
   * witness is deliberately not consulted (a dead "Sync now" on a beating Mac would be vouched
   * for indefinitely, and nothing on a Mac reclaims a dead slot row).
   */
  describe('R3 — a foreign holder whose OWN beat is fresh is ALIVE, on any machine, however stale its stamp', () => {
    const MAC = { device: 'mac-studio', host: 'host-studio' }
    const parse = (row: { value: string } | null) => JSON.parse(row!.value) as SlotLockHolder
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const foreignRow = () => JSON.stringify({ pid: NOWHERE_PID, slot: 'other', at: agoIso(0), device: 'linode-detect', host: 'other-host' })

    it('a 31-minute-old Mac row with a 10-second-old beat is declined, byte-identical — and the control: with the beat 4 minutes old, taken over', async () => {
      await declined(await seed({ at: agoIso(31 * MINUTE), beatAt: agoIso(10_000), ...MAC }))
      await prisma.setting.deleteMany()
      await seed({ at: agoIso(31 * MINUTE), beatAt: agoIso(4 * MINUTE), ...MAC })
      await takeOver()
    })

    it('a beat the reader cannot parse is no vouch → taken over', async () => {
      await seed({ at: agoIso(31 * MINUTE), beatAt: 'not-a-date', ...MAC })
      await takeOver()
    })

    it('what the holder writes: the acquire stamps `at` and `beatAt` together, a beat moves `beatAt` ALONE, a boundary refresh moves both — and a beat on a row that changed hands stamps nothing', async () => {
      const foreign = foreignRow()
      await withSlotLock('slot-11:00', async () => {
        const acquired = parse(await slotRow())
        expect(acquired.beatAt).toBe(acquired.at)
        await sleep(5)
        expect(await beatSlotLock('slot-11:00')).toBe(true)
        const beaten = parse(await slotRow())
        expect(beaten.at).toBe(acquired.at)
        expect(Date.parse(beaten.beatAt!)).toBeGreaterThan(Date.parse(acquired.beatAt!))
        expect(beaten).toMatchObject({ pid: process.pid, slot: 'slot-11:00', device: THIS_DEVICE, host: THIS_HOST })
        await sleep(5)
        expect(await touchSlotLock('slot-11:00')).toBe(true)
        const touched = parse(await slotRow())
        expect(Date.parse(touched.at)).toBeGreaterThan(Date.parse(beaten.at))
        expect(touched.beatAt).toBe(touched.at)
        await prisma.setting.update({ where: { key: 'slotRunning' }, data: { value: foreign } })
        expect(await beatSlotLock('slot-11:00')).toBe(false)
        expect((await slotRow())?.value).toBe(foreign)
      })
      // The value-conditioned release matched nothing: the new holder's row stands.
      expect((await slotRow())?.value).toBe(foreign)
    })

    it('the 60-second timer: `beatAt` advances by itself while a run holds the lock, `at` does not, and the timer is gone once the lock is released', async () => {
      // Only the interval is faked; `sleep` and the database stay real.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        await withSlotLock('slot-20:00', async () => {
          const before = parse(await slotRow())
          expect(vi.getTimerCount()).toBe(1)
          await sleep(5)
          await vi.advanceTimersByTimeAsync(60_000)
          // The beat's write is queued and lands asynchronously: wait for the row to move, bounded.
          let after = parse(await slotRow())
          for (let i = 0; i < 100 && after.beatAt === before.beatAt; i += 1) {
            await sleep(10)
            after = parse(await slotRow())
          }
          expect(after.at).toBe(before.at)
          expect(Date.parse(after.beatAt!)).toBeGreaterThan(Date.parse(before.beatAt!))
        })
        expect(vi.getTimerCount()).toBe(0)
        expect(await slotRow()).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('a beat and a boundary refresh issued in the same tick are queued: both land, neither reads the other as a loss', async () => {
      await withSlotLock('slot-15:00', async () => {
        await sleep(5)
        expect(await Promise.all([touchSlotLock('slot-15:00'), beatSlotLock('slot-15:00')])).toEqual([true, true])
        expect(parse(await slotRow())).toMatchObject({ pid: process.pid, slot: 'slot-15:00', device: THIS_DEVICE, host: THIS_HOST })
      })
      expect(await slotRow()).toBeNull()
    })
  })

  /**
   * R1/R2, LIVE (reviewer majors 1 and 2 on the first version). The first leaf returned null when
   * the heartbeat QUERY threw, so (R1) `startScheduler`'s two-schedulers guard was skipped on a
   * transient database error — a dashboard booting before its tunnel answered would have started
   * a second scheduler beside the worker — and (R2) the lock path read "no vouch" and could have
   * stepped over a vouched holder. A read that throws must REJECT to the scheduler and must
   * DECLINE on the lock path. Absent (no row) stays null, which the control asserts.
   */
  describe('R1/R2 — a heartbeat the reader cannot READ is no answer: the scheduler must fail, the lock must decline', () => {
    /** The heartbeat query throws; every other Setting read — the lock row's own — passes through. */
    const breakHeartbeatRead = () => {
      const real = prisma.setting.findUnique.bind(prisma.setting)
      return vi.spyOn(prisma.setting, 'findUnique').mockImplementation((async (args: Parameters<typeof real>[0]) => {
        if (args.where.key === HEARTBEAT_KEY) throw new Error('connection refused (test)')
        return real(args)
      }) as never)
    }

    it('readSchedulerHeartbeat and readHeartbeat REJECT — neither answers null about a read that did not happen', async () => {
      const spy = breakHeartbeatRead()
      try {
        await expect(readSchedulerHeartbeat()).rejects.toThrow('connection refused')
        await expect(readHeartbeat()).rejects.toThrow('connection refused')
      } finally {
        spy.mockRestore()
      }
      // The control: with the read working, an ABSENT row is the ordinary null, for both.
      expect(await readSchedulerHeartbeat()).toBeNull()
      expect(await readHeartbeat()).toBeNull()
    })

    it('a 31-minute foreign row with no beat of its own, beside a heartbeat that cannot be read → DECLINED, byte-identical; with the read restored → taken over', async () => {
      const row = await seed({ at: agoIso(31 * MINUTE), device: 'linode-detect', host: 'other-host' })
      const spy = breakHeartbeatRead()
      try {
        await declined(row)
      } finally {
        spy.mockRestore()
      }
      await takeOver()
    })

    it('the heartbeat is read only where it can change the verdict: a fresh row, and a stale row with a fresh own beat, never read it', async () => {
      const spy = breakHeartbeatRead()
      try {
        await declined(await seed({ at: agoIso(20_000), device: 'linode-detect', host: 'other-host' }))
        await prisma.setting.deleteMany()
        await declined(await seed({ at: agoIso(31 * MINUTE), beatAt: agoIso(10_000), device: 'mac-studio', host: 'host-studio' }))
        expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ where: { key: HEARTBEAT_KEY } }))
      } finally {
        spy.mockRestore()
      }
    })
  })
})
