/**
 * Starts the standing watch inside the dashboard's own process.
 *
 * This is what makes "hands free" true. Before this file, the scheduler only existed
 * as a second command (`pnpm worker`) that nobody had run — so autopilot could be
 * switched on, the dashboard would say messages go out at 11:00, and nothing
 * whatsoever would happen. A promise on screen with no process behind it.
 *
 * Turning the dashboard on is now enough. What the scheduler does by itself is
 * detection and drafting; delivering still needs all four autopilot switches, so
 * running it here does not widen what can be sent — only whether anything runs at all.
 *
 * Set `EMBEDDED_SCHEDULER=false` when the dashboard and `pnpm worker` run separately
 * (a server, say). Whichever starts second sees the other's heartbeat and declines,
 * so a mistake here costs a log line rather than duplicate messages.
 */
export async function register() {
  // Next runs this hook for every runtime; node-cron and Prisma are Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.EMBEDDED_SCHEDULER === 'false') return

  const { startScheduler } = await import('@/worker/scheduler')
  const { log } = await import('@/lib/logger')
  try {
    await startScheduler('dashboard')
  } catch (err) {
    // A scheduler that fails to start must not take the dashboard down with it —
    // the page is how you would find out anything is wrong.
    log.alarm('embedded scheduler failed to start', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
