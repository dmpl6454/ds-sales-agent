import cron, { type ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { istDateKey, istStamp, istDayStart, slotToCron, TIMEZONE } from '@/lib/time'
import { runSlot } from './runSlot'

/**
 * The standing watch. Fires at each configured IST slot, every day, forever.
 *
 * `noOverlap` matters: a slow scrape must not overlap the next slot and end up
 * planning outreach twice against the same state.
 *
 * Catch-up-on-boot exists because the most dangerous failure here is silent. If
 * the machine was asleep at 11:00, plain cron simply never fires and nobody
 * notices — the system looks healthy and does nothing. On startup we check
 * whether the most recent slot was missed and run it immediately.
 */

const tasks: ScheduledTask[] = []

async function main(): Promise<void> {
  log.info('worker starting', {
    slots: env.SLOTS.join(','),
    tz: TIMEZONE,
    dryRun: env.DRY_RUN,
    autopilot: env.AUTOPILOT_ENABLED,
    now: istStamp(),
  })

  if (env.DRY_RUN) {
    log.warn('DRY_RUN is ON — the pipeline will run fully but send nothing. Set DRY_RUN=0 to go live.')
  }

  await catchUpIfMissed()

  for (const slot of env.SLOTS) {
    const expression = slotToCron(slot)
    const task = cron.schedule(
      expression,
      async () => {
        try {
          await runSlot(slot)
        } catch (err) {
          log.alarm('slot threw at top level', {
            slot,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
      { timezone: TIMEZONE, name: `slot-${slot}`, noOverlap: true },
    )
    tasks.push(task)
    log.step('scheduled', { slot, cron: expression, next: task.getNextRun()?.toISOString() ?? 'unknown' })
  }

  log.info(`watching ${env.SLOTS.length} slots daily — press Ctrl+C to stop`)
}

/**
 * If the newest slot that should already have run today has no ScrapeRun, and it
 * was missed recently enough to still be worth running, run it now.
 *
 * The window stops us replaying a slot from three days ago on a Monday morning.
 */
async function catchUpIfMissed(): Promise<void> {
  if (env.CATCHUP_WINDOW_MINUTES <= 0) return

  const now = new Date()
  const dayStart = istDayStart(now)
  const minutesSinceMidnight = Math.floor((now.getTime() - dayStart.getTime()) / 60_000)

  // Slots already due today, newest first.
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

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal} — stopping`)
  await Promise.allSettled(tasks.map((t) => t.stop()))
  await cron.shutdown(10_000).catch(() => undefined)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((err) => {
  log.alarm('worker failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
