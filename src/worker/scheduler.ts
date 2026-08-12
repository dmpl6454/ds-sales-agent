import cron, { type ScheduledTask } from 'node-cron'
import { hostname as osHostname } from 'node:os'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { istDateKey, istStamp, istDayStart, slotToCron, TIMEZONE } from '@/lib/time'
import { runSlot, withSlotLock } from './runSlot'
import { dispatchTick } from '@/outreach/dispatcher'
import { DISPATCH_INTERVAL_MINUTES, ACTIVE_FROM_HOUR, ACTIVE_TO_HOUR } from '@/outreach/pacing'
import { runDetection } from '@/detection/pipeline'
import { DETECT_INTERVAL_MINUTES, DETECT_LOOKBACK_HOURS } from '@/detection/cadence'
import { runOutreach } from '@/outreach/plan'
import { getSettings } from '@/lib/settings'

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
  /**
   * WHICH MACHINE wrote this beat. Added 2026-08-08, when the database stopped being a
   * SQLite file on one laptop and became a Postgres several hosts share.
   *
   * A pid is meaningless across machines. The liveness check below asks the operating
   * system `process.kill(pid, 0)` — which answers only about THIS machine — so once the
   * Linode and a laptop share a database, the laptop reads the Linode's beat, finds no
   * such local pid, concludes "it died without clearing its heartbeat", and starts a
   * SECOND scheduler. Two schedulers is the exact failure the guard exists to prevent,
   * produced by the guard itself.
   *
   * Optional, because a beat written before this field existed must still be readable —
   * an absent machine is treated as "not this one", which is the conservative direction:
   * it refuses to start rather than assuming the other process is dead.
   */
  machine?: string
}

/** This host's name, as recorded on a heartbeat. `DS_DEVICE_NAME` lets a deploy label itself. */
export function machineId(): string {
  return process.env.DS_DEVICE_NAME ?? osHostname()
}

async function writeHeartbeat(host: SchedulerHeartbeat['host']): Promise<void> {
  const value = JSON.stringify({ pid: process.pid, host, at: new Date().toISOString(), machine: machineId() })
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
 * ── ONE SWITCH: DRAFTING FOLLOWS DETECTION, NOT THE SEND SLOTS ────────────────────────
 *
 * The body of the 15-minute detect task: read the feeds, then — when autopilot is on —
 * write drafts for whatever was found.
 *
 * Tabish, 2026-08-08: *"The moment autopilot is turned on there must be no more switches…
 * Automated mode must simply send the messages."* A paid post detected at 11:20 used to wait
 * for the 15:00 slot before anything was written about it, so the only reason a draft did not
 * exist was a schedule nobody had asked for. Detection already runs on its own fast clock
 * (Tabish, 2026-08-07); drafting had no separate argument for being slow, and a hook line is
 * age-bounded by `HOOK_MAX_AGE_HOURS`, so a slow draft can retire the very material it was
 * going to reference. Same lesson as the 166 unread cover frames: a feature that only happens
 * when someone runs a command is not running.
 *
 * SENDING IS UNTOUCHED, AND THAT WAS VERIFIED RATHER THAN ASSUMED. This writes READY rows
 * only. `plan.ts` has exactly ONE `.send()` call site and it is hardcoded to
 * `manualAssistSender`, which logs and returns `{ status: 'READY' }`; `browserSender` is
 * deliberately not imported there, and that file's own docblock says a second import of
 * anything that drives a browser is the thing to notice if it ever comes back. `dispatchTick`
 * on its own paced cron remains the single path to a recipient, re-asking every rule at
 * delivery through `gate.ts`. Putting a send path on a 15-minute clock would bypass active
 * hours, the fleet allowance, the minimum gap and the breaker all at once.
 *
 * Gated on the switch because drafting is the visible half of "autopilot is on": with it off,
 * the queue must not grow behind an operator's back.
 *
 * Cheap at 96 passes a day. `ensureFleetPairs` reads existing pairs and subtracts, returning
 * before any write when nothing is missing — three indexed SELECTs in the steady state — and
 * a pending attempt for a pair stops a second one being drafted.
 *
 * PLANNING TAKES THE SLOT LOCK, and that is the load-bearing detail of this change. `noOverlap`
 * is PER TASK, so it does nothing between this task and a slot — and the four slots sit on
 * minute 0, always a multiple of `DETECT_INTERVAL_MINUTES`, so the two collide FOUR TIMES A DAY
 * by construction. `runSlot`'s own docblock spells out the consequence: two concurrent
 * `runOutreach` calls both read `hasPendingAttempt: false` for one pair, both create an
 * attempt, and two DMs land on one prospect seconds apart. `hasPendingAttempt` is a
 * read-then-write and cannot close that alone. Holding the lock the slots already hold is what
 * makes a second planner safe, so `withSlotLock` is reused rather than reimplemented.
 *
 * A held lock is NOT a failure and is not logged as one — a slot running right now plans the
 * same drafts anyway.
 *
 * DETECTION'S RESULT SURVIVES A PLANNING FAILURE, which is why planning is caught separately
 * rather than sharing the outer `try`. A late draft is recoverable; a post that scrolls out of
 * the 48-deep feed window can never be re-scraped, so the two failures are not equivalent and
 * must not share a handler.
 *
 * Dependencies are injected so both directions are testable without standing up cron, a
 * browser or a database — the switch-off case is the one that would otherwise be asserted
 * only by reading the source.
 */
export async function detectThenDraft(
  deps: {
    detect?: typeof runDetection
    plan?: typeof runOutreach
    settings?: typeof getSettings
    lock?: typeof withSlotLock
  } = {},
): Promise<void> {
  const detect = deps.detect ?? runDetection
  const plan = deps.plan ?? runOutreach
  const settings = deps.settings ?? getSettings
  const lock = deps.lock ?? withSlotLock

  try {
    const d = await detect()
    // Quiet on the ordinary case — 96 passes a day must not fill the log. `0 parsed`
    // is an alarm inside runDetection itself, which is where it belongs.
    if (d.newPosts > 0 || d.detected > 0) {
      log.info('detection pass', { newPosts: d.newPosts, paid: d.detected })
    }

    if ((await settings()).autopilotEnabled) {
      await lock('detect-draft', plan).catch((e) =>
        log.warn('outreach planning after detect failed', { error: String(e) }),
      )
    }
  } catch (err) {
    log.alarm('detection pass threw at top level', {
      error: err instanceof Error ? err.message : String(err),
    })
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
   * throws only if no such process exists.
   *
   * ── AND A PID ONLY MEANS SOMETHING ON THE MACHINE THAT OWNS IT ────────────
   *
   * That check was written when the database was a SQLite file and every scheduler was
   * on one laptop; its own comment said "local-only by nature, which is exactly the case
   * this guard is for". Sharing a Postgres between the server and a laptop breaks the
   * premise: asking THIS kernel about the Linode's pid returns "no such process", which
   * reads as "it died without clearing its heartbeat" — and the guard against two
   * schedulers starts the second one itself.
   *
   * So liveness is only ASKED when the beat came from this machine. A beat from another
   * machine is judged on freshness alone, which is the conservative direction: it may
   * refuse to start when the other host has genuinely crashed, and the recovery is the
   * staleness window (3 minutes) rather than a duplicate slot firing. Refusing too long
   * is visible on the dashboard; running twice is not.
   */
  const existing = await readHeartbeat()
  if (existing && existing.beat.pid !== process.pid) {
    const sameMachine = (existing.beat.machine ?? null) === machineId()
    const otherAlive = (() => {
      if (!sameMachine) {
        // Cannot ask another host's kernel. Freshness is all there is, and a fresh beat
        // from elsewhere is treated as alive.
        return existing.fresh
      }
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

  /**
   * ── THE DISPATCHER, ON ITS OWN CADENCE ────────────────────────────────────
   *
   * Delivery used to happen only inside a slot, which made the slot's own duration the
   * spacing between sends: everything waiting went out back to back with a 45-180 s sleep
   * between, all of it inside the same hour. Measured volume (11-14 paid posts a day from
   * `@viralbhayani` alone) turns that into an hour of continuous browser driving landing in
   * one inbox from a dozen different pages — the recipient-side pattern the fleet design
   * exists to avoid, arriving as a side effect of a loop rather than as anyone's decision.
   *
   * So a tick every DISPATCH_INTERVAL_MINUTES sends at most `maxSendsPerTick` (default 1)
   * and returns. Spacing becomes a property of the schedule.
   *
   * IT LIVES IN THE SAME PROCESS AS THE SLOTS, and that is not incidental. "Autopilot is
   * ON" once meant nothing because the scheduler was a second command nobody had run —
   * a toggle promising behaviour with no process behind it. Putting the dispatcher
   * anywhere else would recreate exactly that, one layer down: slots firing, drafts
   * accumulating, and nothing on earth able to send one. Starting the app is enough, and
   * `readDispatchState` puts what the last tick did on screen so the claim is checkable.
   *
   * `noOverlap` because a tick drives a browser for ~40 s and a 15-minute interval must
   * never queue two. The fleet-wide send lock covers cross-process overlap; this covers
   * this task overlapping itself.
   */
  const dispatchExpression = `*/${DISPATCH_INTERVAL_MINUTES} * * * *`
  const dispatchTask = cron.schedule(
    dispatchExpression,
    async () => {
      try {
        await dispatchTick('cron')
      } catch (err) {
        log.alarm('dispatcher tick threw at top level', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    { timezone: TIMEZONE, name: 'dispatch', noOverlap: true },
  )
  tasks.push(dispatchTask)
  log.step('scheduled', {
    dispatcher: `every ${DISPATCH_INTERVAL_MINUTES} minutes`,
    cron: dispatchExpression,
    activeHours: `${ACTIVE_FROM_HOUR}:00-${ACTIVE_TO_HOUR}:00 IST`,
    next: dispatchTask.getNextRun()?.toISOString() ?? 'unknown',
  })

  /**
   * ── DETECTION HAS ITS OWN CLOCK ────────────────────────────────────────────
   *
   * Tabish, 2026-08-07: *"the schedule is for sending messages, not for detecting paid
   * posts, paid posts must be detected as fast as possible."* Detection was stage 1 of
   * `runSlot`, so it inherited the four send times — and the 20:00 -> 11:00 gap left
   * posts undetected for FIFTEEN HOURS (~20 of them a night, measured).
   *
   * Reading a public feed anonymously (decision 4: no session, ever) cannot spam anyone,
   * so nothing about DM safety argues for pacing it. See src/detection/cadence.ts for the
   * request-rate measurement behind the interval.
   *
   * `noOverlap` because a pass takes seconds and pages with a 700ms delay; two overlapping
   * passes would double the request rate against the endpoint this is careful with.
   *
   * The SLOTS still run detection first, unchanged — a slot must not plan outreach against
   * a stale corpus, and this task is not a substitute for that ordering.
   */
  const detectExpression = `*/${DETECT_INTERVAL_MINUTES} * * * *`
  /**
   * Wrapped, NOT passed bare. node-cron calls its task with a `TaskContext`, which would land
   * in `detectThenDraft`'s injectable `deps` parameter and silently replace `detect`, `plan`
   * and `settings` with undefined-or-worse from an object this code does not control. Caught
   * by the compiler; kept as a lambda so a future signature change cannot reintroduce it.
   */
  const detectTask = cron.schedule(detectExpression, () => detectThenDraft(),
    { timezone: TIMEZONE, name: 'detect', noOverlap: true },
  )
  tasks.push(detectTask)
  log.step('scheduled', {
    detection: `every ${DETECT_INTERVAL_MINUTES} minutes`,
    cron: detectExpression,
    lookbackHours: DETECT_LOOKBACK_HOURS,
    // Named here because this task no longer only detects. A log line claiming
    // "detection" alone would hide the drafting from anyone reading the boot output.
    thenDrafts: 'when autopilot is on',
    next: detectTask.getNextRun()?.toISOString() ?? 'unknown',
  })

  log.info(
    `watching ${env.SLOTS.length} slots daily, detecting every ${DETECT_INTERVAL_MINUTES} minutes, ` +
      `delivering every ${DISPATCH_INTERVAL_MINUTES} minutes`,
  )
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
