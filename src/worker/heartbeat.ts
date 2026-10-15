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
