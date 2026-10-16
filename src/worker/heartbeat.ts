import { prisma } from '@/lib/db'
import { deviceId } from '@/outreach/devicePresence'

/**
 * ── THE SCHEDULER'S HEARTBEAT, AS A LEAF (2026-10-15) ──────────────────────────────────
 *
 * The Linode worker writes `Setting.schedulerHeartbeat` every 60 s from the SAME process that
 * holds the slot lock for the four slots and the 15-minute planner (`scheduler.ts` →
 * `writeHeartbeat`). That makes it a witness for that process in the shared store: a slot lock
 * row naming the worker's machine and pid, beside a beat under 3 minutes old naming the same
 * machine and pid, is a holder that is ALIVE — however long its current stage has run.
 *
 * `runSlot.ts` needs that witness and cannot import `scheduler.ts` (the scheduler imports
 * `runSlot`; the reverse edge is a cycle), so the key, the staleness bound, the row's shape,
 * the machine name and the reader live here, in a module that imports nothing from the
 * worker. `scheduler.ts` re-exports every one of them, so its importers (the view model, the
 * nav, the charts, `scripts/heartbeat.ts`) are untouched.
 */

/** Key in the Setting table. Also read by the dashboard to prove the watch is alive. */
export const HEARTBEAT_KEY = 'schedulerHeartbeat'

/** A heartbeat older than this means the scheduler is not running. */
export const HEARTBEAT_STALE_MS = 3 * 60_000

export interface SchedulerHeartbeat {
  pid: number
  host: 'worker' | 'dashboard'
  at: string
  /**
   * WHICH MACHINE wrote this beat. Added 2026-08-08, when the database stopped being a
   * SQLite file on one laptop and became a Postgres several hosts share.
   *
   * A pid is meaningless across machines. The scheduler's liveness check asks the operating
   * system `process.kill(pid, 0)` — which answers only about THIS machine — so once the
   * Linode and a laptop share a database, the laptop reads the Linode's beat, finds no
   * such local pid, concludes "it died without clearing its heartbeat", and starts a
   * SECOND scheduler. Two schedulers is the exact failure the guard exists to prevent,
   * produced by the guard itself.
   *
   * Optional, because a beat written before this field existed must still be readable —
   * an absent machine is treated as "not this one", which is the conservative direction:
   * it refuses to start rather than assuming the other process is dead.
   *
   * It is a NAME, not a host id (rule 51): the beat carries no `hostId()`. Every reader of it
   * compares the name only, and the one reader that uses it as a vouch (`decideSlotLock`) can
   * therefore be vouched falsely only by a same-name machine running the same pid at the same
   * moment — and a false vouch there is a DECLINE, bounded by this row's 3-minute staleness,
   * never a take-over.
   */
  machine?: string
}

/**
 * This machine's name, as recorded on a heartbeat.
 *
 * ONE SOURCE WITH `deviceId()`, verified before this was made a delegation: until 2026-10-15
 * `scheduler.ts` held its own copy — the `DS_DEVICE_NAME` variable, trimmed, else the OS
 * hostname, byte-identical to `devicePresence.ts:42` — and the blank-is-no-name rule of
 * 2026-10-09 had to be applied to both by hand. (`tests/device-presence.test.ts` greps every
 * source file for readers of that variable, prose included, so this comment names it without
 * spelling the expression.) The slot lock now compares a heartbeat's `machine` against a
 * lock row's `device` (which IS `deviceId()`), so the two must agree by construction, not by
 * two people remembering to edit two files the same way.
 */
export function machineId(): string {
  return deviceId()
}

/**
 * PURE. The beat a `Setting` row holds, or null when the value is not one — unparseable, or
 * parseable but not the shape above. One parser for every reader, so the dashboard, the
 * scheduler's own guard and the slot lock cannot disagree about what counts as a beat.
 */
export function parseSchedulerHeartbeat(value: string): SchedulerHeartbeat | null {
  try {
    const beat = JSON.parse(value) as SchedulerHeartbeat
    if (!beat || typeof beat !== 'object' || typeof beat.pid !== 'number' || typeof beat.at !== 'string') return null
    return beat
  } catch {
    return null
  }
}

/**
 * The scheduler's last beat, or null when none has ever been written or the row is not one.
 *
 * ── ABSENT IS AN ANSWER; UNREADABLE IS NOT (reviewer majors 1 and 2 on the first version) ──
 *
 * A DATABASE ERROR PROPAGATES. The first version of this reader wrapped the `findUnique` in
 * the same `try` as the parse and returned null for both — "a witness that cannot be read must
 * never throw inside the lock path". That reversed the safety direction of every OTHER caller:
 * `startScheduler` reads this to refuse a SECOND scheduler, and at HEAD a database error there
 * rejected the start (the worker exited 1 and pm2 retried; the dashboard logged the alarm and
 * started nothing). Returning null instead skipped the guard entirely — a dev dashboard booting
 * before its tunnel answered would have started a second scheduler beside the Linode worker,
 * the exact failure the guard exists to prevent, and `pnpm worker:heartbeat` and the nav would
 * have printed "never run" about an outage. So: no row, or a row that is not a beat, is null —
 * the fact "nothing vouches" that every caller handles; a read that threw is a thrown error,
 * and each caller decides what an unanswered question means where it is asked. The one caller
 * on a lock path (`runSlot.ts`, `acquireSlotLock`) catches it and DECLINES that attempt — it
 * never steps over a holder the witness might have vouched for — and the next attempt reads
 * again, so declining there cannot deadlock.
 */
export async function readSchedulerHeartbeat(): Promise<SchedulerHeartbeat | null> {
  const row = await prisma.setting.findUnique({ where: { key: HEARTBEAT_KEY } })
  return row ? parseSchedulerHeartbeat(row.value) : null
}

/**
 * Does this OS have a process with this pid? EPERM is YES: the process exists and belongs to
 * another user — the reading `dispatcher.ts` `pidAlive` settled on (2026-10-09). Restated here
 * rather than imported, because importing the dispatcher would load the whole send path into a
 * command that reads feeds. (Moved here from backfill.ts on 16 Oct 2026, with `workerRunningHere`,
 * so `ig:backfill` and `ig:rejudge` ask ONE check; backfill.ts re-exports it.)
 */
export function pidAliveHere(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** The detection worker this beat says is running on THIS host — or that it might be. */
export interface WorkerOnThisHost {
  /** `running`: the beat names this machine and this OS says its pid is alive. `unnamed`: see below. */
  kind: 'running' | 'unnamed'
  pid: number
  /** How long ago it beat, as a person reads it: `30s ago`. */
  ago: string
}

/**
 * PURE. Is the detection worker running on this host? The question every maintenance command that
 * does the worker's own heavy work — `ig:backfill --run`, `ig:rejudge` — must ask before starting,
 * because on the 961 MB box two such processes are two OCR children and two heaps (CLAUDE.md rule
 * 16: one OCR child at a time), and both would judge the same newest posts. ONE check with two
 * callers, so the two commands cannot drift on what "running here" means.
 *
 * Yes on a FRESH beat (under HEARTBEAT_STALE_MS, the scheduler's own bound) that names THIS machine
 * and whose pid this OS says is alive — and `unnamed` on a fresh beat naming NO machine at all (a
 * build older than 2026-08-08) on freshness alone, exactly as `startScheduler` does: such a beat may
 * be another host's, and a pid is a fact about one machine (CLAUDE.md rule 28), so asking this OS
 * about it would prove nothing. A beat from ANOTHER machine (the Mac's), a stale one, or one whose
 * pid is dead is no — `pm2 stop` leaves a fresh beat behind for up to three minutes, and its pid is
 * what tells a stopped worker from a running one. The conservative direction: a wrong refusal costs a
 * person three minutes, two detection processes on 961 MB cost the box.
 */
export function workerRunningHere(input: {
  beat: SchedulerHeartbeat | null
  nowMs: number
  machine: string
  alive: (pid: number) => boolean
}): WorkerOnThisHost | null {
  const { beat } = input
  if (!beat) return null
  const ageMs = input.nowMs - Date.parse(beat.at)
  if (!(ageMs < HEARTBEAT_STALE_MS)) return null
  const ago = `${Math.max(0, Math.round(ageMs / 1000))}s ago`
  if (beat.machine === undefined) return { kind: 'unnamed', pid: beat.pid, ago }
  if (beat.machine !== input.machine) return null
  if (!input.alive(beat.pid)) return null
  return { kind: 'running', pid: beat.pid, ago }
}
