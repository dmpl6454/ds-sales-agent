import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { runDeviceAgent, stopDeviceAgent } from './index'
import { sendLockHeldHere } from '@/outreach/dispatcher'

/**
 *   pnpm agent:device
 *
 * The entry point a user runs on their own machine. See `src/agent/README.md` for why the
 * server cannot do this, and `src/agent/index.ts` for why the agent adds no send logic of
 * its own.
 */
/**
 * ── A RESTART WAITS FOR THE DRIVE IN FLIGHT (2026-10-09) ────────────────────
 *
 * This exited at once. A reinstall (`launchctl unload`), a DMG update, a logout or a kickstart
 * landing mid-send killed the browser between the READY→SENDING claim and the thread check, and
 * the next process's orphan sweep parked that draft `not-in-thread` — "may already have it" —
 * which nothing automatic releases. CLAUDE.md's rule 8 ("never restart while the send lock is
 * held") was a procedure a person had to remember; this makes the process honour it.
 *
 * `stopDeviceAgent` first, so no new tick starts; then wait, bounded, for any lock-holding job in
 * THIS process (a send, a reply sweep, disk care) to finish. The worker drains the same way. The
 * bound is below the launchd ExitTimeOut install-watch.sh sets, so we exit cleanly before launchd
 * would kill us. A second signal skips the wait — a person pressing Ctrl-C twice means now.
 */
const SHUTDOWN_DRAIN_MS = 100_000
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn(`received ${signal} again — stopping without waiting`)
    process.exit(0)
  }
  shuttingDown = true
  log.info(`received ${signal} — stopping the device agent`)
  stopDeviceAgent()
  if (sendLockHeldHere()) {
    log.info('a send or sweep is in progress — waiting for it to finish before stopping', {
      maxSeconds: SHUTDOWN_DRAIN_MS / 1000,
    })
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS
    while (sendLockHeldHere() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
    if (sendLockHeldHere()) {
      log.alarm('stopping with a send or sweep still in progress — the orphan sweep will park it for a person')
    }
  }
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

runDeviceAgent().catch((err) => {
  log.alarm('device agent failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
