import { prisma } from '@/lib/db'
import { sessionRecorded } from './sessionHealth'

/**
 * WHICH ACCOUNTS ROTATION MUST SKIP, AND WHY — one definition, every caller.
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────────────
 *
 * Three places need this answer and they must not disagree: the planner (deciding whose
 * turn it is to be written to), `pnpm ig:dedupe-drafts` (deciding which duplicate survives)
 * and the dashboard (telling an operator who is next). If the page computed availability
 * its own way it could name a different account than the planner will actually use — the
 * exact drift `gate.ts` was extracted to stop, and `/messages` renders these sentences.
 *
 * ── EVERY FACT HERE IS MACHINE-INDEPENDENT ────────────────────────────────
 *
 * There is deliberately no `profileStatus` read. MEASURED 2026-08-13: the planner runs on
 * the Linode (`schedulerHeartbeat` → `machine: linode-detect`), and that host has no
 * `~/.ds-sales-agent` directory at all — Chrome profiles live on each operator's own device
 * and the server may never send. A filesystem check here answers `false` for every account
 * on the one machine that drafts, which would resolve every recipient to `all-unavailable`
 * and stop drafting fleet-wide, silently. `sessionRecorded` says why the weaker claim is
 * the right one.
 *
 * The reasons are sentences because a refusal that reads "every sender is unavailable —
 * bollywoodsocietyy: never signed in; madaboutmarketingg: never signed in" is actionable
 * and "nothing happened" is not.
 */
export async function readSenderAvailability(): Promise<Map<string, string>> {
  const unavailable = new Map<string, string>()
  for (const s of await prisma.senderAccount.findMany({
    select: { id: true, handle: true, status: true, sessionPath: true, sessionInvalidAt: true },
  })) {
    if (s.status === 'CHALLENGED') unavailable.set(s.id, 'flagged by Instagram')
    else if (s.status !== 'ACTIVE') unavailable.set(s.id, s.status.toLowerCase())
    /**
     * §3.5: two different facts, two different fixes, so two different sentences. A dead
     * session was PROVED dead by a real send that met a login form; "never signed in" means
     * no hand login was ever recorded for this account at all.
     */
    else if (s.sessionInvalidAt !== null) unavailable.set(s.id, 'logged out — needs signing in again')
    else if (!sessionRecorded(s)) unavailable.set(s.id, 'never signed in')
  }
  return unavailable
}
