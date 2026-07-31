import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { startScheduler, stopScheduler } from './scheduler'

/**
 *   pnpm worker
 *
 * Runs the standing watch as its own process. Still supported, and the right choice
 * on a server where the dashboard is not always up.
 *
 * On a laptop it is no longer required: the dashboard starts the same scheduler
 * itself (`instrumentation.ts`). It used to be required for anything automatic to
 * happen at all, with nothing on screen saying so — the dashboard would report
 * "Autopilot is ON" while no process existed to fire a slot.
 *
 * If both are running, whichever starts second sees the other's heartbeat and
 * declines, rather than double-firing every slot.
 */
async function main(): Promise<void> {
  const ok = await startScheduler('worker')
  if (!ok) {
    log.warn('exiting: the dashboard (or another worker) already holds the schedule')
    await prisma.$disconnect()
    process.exit(0)
  }
  log.info('press Ctrl+C to stop')
}

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal} — stopping`)
  await stopScheduler()
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((err) => {
  log.alarm('worker failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
