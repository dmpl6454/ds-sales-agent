import cron, { type ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { istDateKey, istStamp, istDayStart, slotToCron, TIMEZONE } from '@/lib/time'
import { runSlot } from './runSlot'

/**
 * The standing watch, extracted so it can run either as its own process
 * (`pnpm worker`) or inside the dashboard's process (`instrumentation.ts`).
 *
 * Why it can now run inside the dashboard: "autopilot" meant nothing without a
 * scheduler, and the scheduler was a second command nobody had run. The dashboard
 * cheerfully said messages would go out at 11:00 while no process existed to send
 * them. Truly hands-free means starting the app is enough.
 *
 * `noOverlap` matters: a slow scrape must not overlap the next slot and plan
 * outreach twice against the same state.
 *
 * Catch-up-on-boot exists because the most dangerous failure here is silent. If the
 * machine was asleep at 11:00, plain cron never fires and nobody notices — the
 * system looks healthy and does nothing.
 */

const tasks: ScheduledTask[] = []
let started = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/** Key in the Setting table. Also read by the dashboard to prove the watch is alive. */
export const HEARTBEAT_KEY = 'schedulerHeartbeat'
const HEARTBEAT_INTERVAL_MS = 60_000
/** A heartbeat older than this means the scheduler is not running. */
export const HEARTBEAT_STALE_MS = 3 * 60_000

export interface SchedulerHeartbeat {
  pid: number
  host: 'worker' | 'dashboard'
  at: string
}

async function writeHeartbeat(host: SchedulerHeartbeat['host']): Promise<void> {
  const value = JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() })
  await prisma.setting
    .upsert({ where: { key: HEARTBEAT_KEY }, update: { value }, create: { key: HEARTBEAT_KEY, value } })
    .catch(() => undefined) // a failed heartbeat must never take the scheduler down
}

/** What the dashboard reads. `null` when no scheduler has ever run. */
export async function readHeartbeat(): Promise<{ beat: SchedulerHeartbeat; fresh: boolean } | null> {
  const row = await prisma.setting.findUnique({ where: { key: HEARTBEAT_KEY } })
  if (!row) return null
  try {
    const beat = JSON.parse(row.value) as SchedulerHeartbeat
    return { beat, fresh: Date.now() - new Date(beat.at).getTime() < HEARTBEAT_STALE_MS }
  } catch {
    return null
  }
}

/**
 * Starts the scheduler. Safe to call more than once in a process.
 *
 * Refuses to start if another process is already beating. Two schedulers would run
 * every slot twice — and while detection is idempotent on shortcode and the governor
 * blocks a second pending attempt per pair, "mostly deduplicated" is not a property
 * worth relying on when the failure is a duplicate DM to a real prospect.
 */
export async function startScheduler(host: SchedulerHeartbeat['host']): Promise<boolean> {
  if (started) return true

  /**
   * Is another scheduler REALLY running?
   *
   * A fresh heartbeat is not enough, and trusting it alone broke hands-free
   * completely. Restarting the dashboard writes a heartbeat, and a `kill -9` gives
   * the old process no chance to clear it — so a restart inside the 3-minute
   * staleness window found its own corpse's heartbeat, declared "another scheduler
   * is already running", and declined. The dashboard then sat there with autopilot
   * ON and nothing scheduled, forever, because the refusal never retried.
   *
   * The pid is right there in the record, so ask the operating system instead of
   * inferring liveness from a timestamp. `process.kill(pid, 0)` sends no signal; it
   * throws only if no such process exists. Local-only by nature, which is exactly
   * the case this guard is for — two processes on one machine.
   */
  const existing = await readHeartbeat()
  if (existing && existing.beat.pid !== process.pid) {
    const otherAlive = (() => {
      try {
        process.kill(existing.beat.pid, 0)
        return true
      } catch {
        return false
      }
    })()

    if (existing.fresh && otherAlive) {
      log.warn('another scheduler is already running — not starting a second', {
        otherPid: existing.beat.pid,
        otherHost: existing.beat.host,
        lastBeat: existing.beat.at,
      })
      return false
    }
    if (existing.fresh && !otherAlive) {
      log.step('taking over from a scheduler that died without clearing its heartbeat', {
        deadPid: existing.beat.pid,
      })
    }
  }

  started = true
  log.info('scheduler starting', {
    host,
    slots: env.SLOTS.join(','),
    tz: TIMEZONE,
    dryRun: env.DRY_RUN,
    autopilot: env.AUTOPILOT_ENABLED,
    now: istStamp(),
  })
  if (env.DRY_RUN) {
    log.warn('DRY_RUN is ON — the pipeline runs fully but sends nothing. Set DRY_RUN=0 to go live.')
  }

  await writeHeartbeat(host)
  heartbeatTimer = setInterval(() => void writeHeartbeat(host), HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()

  await catchUpIfMissed()

  for (const slot of env.SLOTS) {
    const expression = slotToCron(slot)
    const task = cron.schedule(
      expression,
      async () => {
        try {
          await runSlot(slot)
        } catch (err) {
          log.alarm('slot threw at top level', { slot, error: err instanceof Error ? err.message : String(err) })
        }
      },
      { timezone: TIMEZONE, name: `slot-${slot}`, noOverlap: true },
    )
    /**
     * A slot the process slept through, recovered.
     *
     * `catchUpIfMissed` only runs at startup, so it covers "the machine was off at
     * 11:00" and nothing else. Closing a laptop lid does not restart the process — it
     * suspends it — so on wake there is no startup to catch up from.
     *
     * What node-cron does on its own is not enough either. It arms a `setTimeout`,
     * which macOS suspends with the process; on wake the timer fires late, and
     * `missedExecutionTolerance` (default **1000 ms**, and we do not override it)
     * decides whether "late" counts as a run. Anything slept through is far more than
     * a second late, so it is classified as missed and emitted here — and until this
     * handler existed, nothing was listening. The slot vanished with no log line, no
     * retry, and a dashboard still reporting autopilot ON.
     *
     * That is the exact failure the catch-up comment above calls the most dangerous
     * one: the system looks healthy and does nothing.
     *
     * The same staleness window applies as at startup, and for the same reason —
     * waking on Wednesday must not replay Monday's 11:00 slot. `noOverlap` on the
     * task keeps this from colliding with a slot that is already running.
     */
    task.on('execution:missed', (context) => {
      void (async () => {
        const missedAt = context.date
        const ageMinutes = Math.floor((Date.now() - missedAt.getTime()) / 60_000)

        if (env.CATCHUP_WINDOW_MINUTES <= 0) {
          log.warn('slot was missed and catch-up is disabled — nothing will run', { slot, ageMinutes })
          return
        }
        if (ageMinutes > env.CATCHUP_WINDOW_MINUTES) {
          log.warn('slot was missed but is too old to replay', {
            slot,
            ageMinutes,
            window: env.CATCHUP_WINDOW_MINUTES,
          })
          return
        }

        // Another process (or the startup catch-up) may already have run it.
        const already = await prisma.scrapeRun
          .findFirst({ where: { slot, startedAt: { gte: istDayStart(new Date()) } }, select: { id: true } })
          .catch(() => null)
        if (already) {
          log.step('slot was missed but has already run today — not replaying', { slot })
          return
        }

        log.warn('slot was missed while the process was suspended — running it now', { slot, ageMinutes })
        try {
          await runSlot(slot)
        } catch (err) {
          log.alarm('missed-slot replay threw', { slot, error: err instanceof Error ? err.message : String(err) })
        }
      })()
    })

    tasks.push(task)
    log.step('scheduled', { slot, cron: expression, next: task.getNextRun()?.toISOString() ?? 'unknown' })
  }

  log.info(`watching ${env.SLOTS.length} slots daily`)
  return true
}

export async function stopScheduler(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  await Promise.allSettled(tasks.map((t) => t.stop()))
  tasks.length = 0
  started = false
  await cron.shutdown(10_000).catch(() => undefined)
}

/**
 * If the newest slot that should already have run today has no ScrapeRun, and it was
 * missed recently enough to still be worth running, run it now. The window stops us
 * replaying Monday's 11:00 slot on Wednesday.
 */
async function catchUpIfMissed(): Promise<void> {
  if (env.CATCHUP_WINDOW_MINUTES <= 0) return

  const now = new Date()
  const dayStart = istDayStart(now)
  const minutesSinceMidnight = Math.floor((now.getTime() - dayStart.getTime()) / 60_000)

  const due = env.SLOTS.map((slot) => {
    const [hh, mm] = slot.split(':').map(Number)
    return { slot, minutes: hh! * 60 + mm! }
  })
    .filter((s) => s.minutes <= minutesSinceMidnight)
    .sort((a, b) => b.minutes - a.minutes)

  const mostRecent = due[0]
  if (!mostRecent) {
    log.step('catch-up: no slots due yet today', { istDate: istDateKey(now) })
    return
  }

  const ageMinutes = minutesSinceMidnight - mostRecent.minutes
  if (ageMinutes > env.CATCHUP_WINDOW_MINUTES) {
    log.step('catch-up: most recent slot is too old to replay', {
      slot: mostRecent.slot,
      ageMinutes,
      window: env.CATCHUP_WINDOW_MINUTES,
    })
    return
  }

  const already = await prisma.scrapeRun.findFirst({
    where: { slot: mostRecent.slot, startedAt: { gte: dayStart } },
    select: { id: true },
  })
  if (already) {
    log.step('catch-up: most recent slot already ran', { slot: mostRecent.slot })
    return
  }

  log.warn('catch-up: slot was missed while the process was down — running it now', {
    slot: mostRecent.slot,
    ageMinutes,
  })
  await runSlot(mostRecent.slot)
}

/** Next scheduled fire time across all slots, for the dashboard. */
export function nextRunAt(): Date | null {
  const times = tasks.map((t) => t.getNextRun()).filter((d): d is Date => d instanceof Date)
  return times.length > 0 ? new Date(Math.min(...times.map((d) => d.getTime()))) : null
}
