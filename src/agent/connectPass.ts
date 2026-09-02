import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { deviceId } from './claim'
import {
  startConnect,
  pollConnect,
  cancelConnect,
  isConnecting,
  connectingHandles,
  type ConnectState,
} from '@/outreach/browser/connect'
import {
  activeRequestsForDevice,
  updateConnectRequest,
  persistSenderSession,
  sweepStaleRequests,
  type ConnectRequest,
} from '@/outreach/connectRelay'

/**
 * SERVICING CONNECT REQUESTS RAISED FROM THE HOSTED WEBSITE.
 *
 * The hosted dashboard cannot open a browser (see connectRelay.ts). It writes a request
 * addressed to a device; this pass, running on that device's agent, is what actually opens
 * the sign-in window — using the SAME `startConnect`/`pollConnect` the local dashboard uses.
 * Nothing about the browser flow is re-implemented; this is a state pump between the shared
 * database and that local flow.
 *
 * ── WHY IT REUSES THE IN-MEMORY MAP ─────────────────────────────────────────
 *
 * `startConnect` opens a Chrome window and leaves it open, keyed by handle in a module-level
 * Map inside connect.ts. That Map lives in THIS long-running agent process, so a window
 * opened one pass is still open the next — exactly the property the local dashboard relies
 * on. `isConnecting(handle)` is how we tell "a window is already open here" from "start one".
 *
 * ── WHY THIS DOES NOT TAKE THE SEND LOCK ────────────────────────────────────
 *
 * The obvious instinct — wrap each browser step in `withSendLock` — was tried and starves:
 * a send holds that lock for the whole ~47s it drives Chrome, and the connect pass polling
 * every 3s never wins the gap, so a sign-in request sat at 'requested' forever (MEASURED
 * 2026-09-02). The local dashboard's connect flow does NOT lock either, and for the reason
 * that makes it safe here too: two contexts on ONE profile is the danger, and Chrome's own
 * per-profile SingletonLock prevents it — a second launch on a user-data-dir already open
 * fails rather than opening a rival context. On localhost the dashboard and the agent are
 * two processes and have always relied on exactly that; the relay is one process and no
 * worse. A collision (a send and a connect on the SAME account at once) makes one launch
 * fail and retry, which is self-healing and touches only the account being connected.
 */

/** Adaptive cadence: responsive while a sign-in is live, quiet when nothing is pending. */
const ACTIVE_POLL_MS = 3_000
const IDLE_POLL_MS = 20_000

let running = false

/** Map a local connect outcome onto a relayed request's status, and finish the DB side. */
async function applyOutcome(request: ConnectRequest, outcome: ConnectState): Promise<void> {
  const { handle } = request
  switch (outcome.state) {
    case 'connected': {
      // The DEVICE records the session — it is where the profile actually lives, so
      // profileStatus reads the right disk. Verified vs cookie-only is honoured by
      // persistSenderSession exactly as the local flow honours it.
      await persistSenderSession(handle, outcome.verified)
      await prisma.auditLog.create({
        data: {
          actor: request.requestedBy,
          action: 'sender.login',
          entity: `SenderAccount:${handle}`,
          detail: `connected via the hosted dashboard, relayed through device:${deviceId()}${outcome.verified ? ', identity verified against Instagram' : ' (cookie on disk, unverified)'}`,
        },
      })
      await updateConnectRequest(handle, {
        status: 'connected',
        verified: outcome.verified,
        message: `@${handle} is signed in${outcome.verified ? ' — confirmed with Instagram.' : '.'}`,
      })
      log.info('relayed connect completed', { handle, verified: outcome.verified })
      return
    }
    case 'wrong-account':
      await updateConnectRequest(handle, {
        status: 'wrong-account',
        actual: outcome.actual,
        message: `That window is signed in as @${outcome.actual}, not @${handle}. Sign out there, then try again.`,
      })
      return
    case 'error':
      await updateConnectRequest(handle, { status: 'error', message: outcome.message })
      return
    case 'closed':
      // The window closed with no session, or timed out — a clean cancel, not a failure.
      await updateConnectRequest(handle, { status: 'cancelled', message: outcome.message })
      return
    case 'waiting':
      await updateConnectRequest(handle, { status: 'waiting', message: outcome.message })
      return
    case 'opening':
      return
  }
}

/** Drive one request one step: open the window if none is open here, else poll it. */
async function serviceOne(request: ConnectRequest): Promise<void> {
  const { handle } = request
  const outcome: ConnectState = isConnecting(handle) ? await pollConnect(handle) : await startConnect(handle)
  await applyOutcome(request, outcome)
}

/** One servicing cycle. Returns whether any request was active (so the caller can pace). */
export async function connectPass(): Promise<boolean> {
  if (running) return true
  running = true
  try {
    await sweepStaleRequests()
    const mine = await activeRequestsForDevice(deviceId())
    const active = new Set(mine.map((r) => r.handle))
    for (const request of mine) {
      try {
        await serviceOne(request)
      } catch (err) {
        // One bad request must not stop the others or the agent. Record it against the
        // request so the operator sees a sentence rather than a spinner.
        await updateConnectRequest(request.handle, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined)
        await cancelConnect(request.handle).catch(() => undefined)
      }
    }

    /**
     * Close any window this process still holds open whose request is gone — the operator
     * cancelled it (the row is deleted) or a TTL sweep removed a stale one. Without this the
     * window would linger until connect.ts's own 20-minute sweep, holding the profile's
     * Chrome lock and failing every send for that account meanwhile.
     */
    for (const handle of connectingHandles()) {
      if (!active.has(handle)) await cancelConnect(handle).catch(() => undefined)
    }

    return mine.length > 0
  } catch (err) {
    log.error('connect request pass failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  } finally {
    running = false
  }
}

/**
 * Self-rescheduling loop: fast while a sign-in is in progress, slow when idle, so an idle
 * agent spends one indexed query every 20s rather than hammering the database. Returns a
 * stop function; the interval is never referenced so it cannot keep the process alive.
 */
export function startConnectLoop(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const cycle = async () => {
    if (stopped) return
    let active = false
    try {
      active = await connectPass()
    } catch {
      /* connectPass already swallows; belt and braces */
    }
    if (stopped) return
    timer = setTimeout(() => void cycle(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    timer.unref?.()
  }
  void cycle()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}