import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { runDeviceAgent, stopDeviceAgent } from './index'

/**
 *   pnpm agent:device
 *
 * The entry point a user runs on their own machine. See `src/agent/README.md` for why the
 * server cannot do this, and `src/agent/index.ts` for why the agent adds no send logic of
 * its own.
 */
async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal} — stopping the device agent`)
  stopDeviceAgent()
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

runDeviceAgent().catch((err) => {
  log.alarm('device agent failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
