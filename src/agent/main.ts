import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { runDeviceAgent, stopDeviceAgent } from './index'
import { sendLockHeldHere } from '@/outreach/dispatcher'
import { requestBrowserShutdown } from '@/outreach/shutdown'

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
 * First NOTHING NEW STARTS: no tick, no new holder of the send lock, no next claim inside a tick
 * already running, no next conversation in a sweep (src/outreach/shutdown.ts — without that, a
 * tick still evaluating drafts went on to claim one, and this wait then killed its drive). Then
 * wait, bounded, for whatever already holds the lock in THIS process to finish. The bound is
 * below the launchd ExitTimeOut install-watch.sh sets, so we exit before launchd would kill us.
 * A second signal skips the wait — a person pressing Ctrl-C twice means now.
 *
 * UNVERIFIED ON A MAC: the plist's main process is `caffeinate`, with pnpm and then node beneath
 * it, so whether launchd's SIGTERM reaches node and is given time to drain depends on how those
 * two pass it on. Look for "waiting for it to finish" in watch.log after the next reinstall.
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
  // Nothing new starts (no tick, no lock, no claim, no next conversation); what runs finishes.
  requestBrowserShutdown()
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
