import { prisma } from '@/lib/db'
import { profileStatus } from './browser/profile'
import { clearSessionInvalid } from './sessionHealth'
import type { ConnectState } from './browser/connect'

/**
 * CONNECTING A SENDER FROM THE HOSTED WEBSITE — the device relay.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * `startConnect`/`pollConnect` drive a REAL Chrome profile. On localhost that is fine — the
 * dashboard process is on the machine with the profiles. On the HOSTED dashboard it is
 * impossible and must stay impossible: the Linode has no display, no `~/.ds-sales-agent`,
 * and `SEND_ENABLED=false` is the hard floor that keeps it that way. A signing session on a
 * datacenter is the cookie transplant the whole design forbids. So a click on the hosted
 * "Connect" cannot open a browser HERE — and until now it silently tried and did nothing.
 *
 * ── THE SHAPE OF THE FIX IS THE ONE THIS CODEBASE ALREADY USES ──────────────
 *
 * Sending works exactly this way: the server never drives a browser, it writes a draft; the
 * device agent on a person's own Mac reads it and delivers. Connecting is the same relay:
 * the hosted server writes a CONNECT REQUEST into the shared database, and the operator's
 * device agent — the process from the DMG, running where the profiles are — claims requests
 * addressed to ITS device and runs the ordinary local connect flow. The browser code
 * (`startConnect`, `pollConnect`, the wrong-account guard, the identity check) is UNCHANGED;
 * only WHO triggers it and WHERE the status lives moves into the database.
 *
 * ── WHY ONE SETTING ROW PER REQUEST, NOT ONE ARRAY ──────────────────────────
 *
 * `devicePresence` keeps every device in one JSON array and tolerates last-write-wins. A
 * connect request has TWO writers racing on a fast cycle — the server sets 'requested', the
 * device transitions it through 'opening' → 'waiting' → 'connected' every few seconds — so a
 * shared array would lose updates. One row per handle (`connectRequest:<handle>`) makes each
 * request its own independent upsert with no read-modify-write on shared state.
 *
 * ── WHY THE REQUEST NAMES A TARGET DEVICE ───────────────────────────────────
 *
 * With more than one operator, account X must be signed in on the Mac that will SEND from X,
 * from THAT person's home IP. A request unaddressed to a device could be claimed by the wrong
 * machine and create the profile in the wrong place — a session on the wrong network, which
 * is the exact failure the hand-login-per-machine rule exists to prevent. So the operator
 * chooses which present device services the request, and only that device's agent picks it up.
 */

/** Every state a relayed connect request can be in. Maps onto `ConnectState` for the UI. */
export type ConnectRequestStatus =
  | 'requested' // the server asked; no device has picked it up yet
  | 'opening' // a device claimed it and is launching Chrome
  | 'waiting' // Chrome is open on the device, waiting for the human to sign in
  | 'connected' // signed in and recorded
  | 'wrong-account' // that profile is signed in as someone else
  | 'error' // something failed on the device
  | 'cancelled' // the operator (or a timeout) called it off

export interface ConnectRequest {
  handle: string
  /** Which device should open the sign-in window (a name from `devicePresence`). */
  device: string
  /** The operator who asked, for the audit trail. */
  requestedBy: string
  status: ConnectRequestStatus
  /** A human sentence for the dashboard — always current for the status. */
  message: string
  /** Set on 'connected': whether identity was proven against Instagram (clears a dead-session mark). */
  verified?: boolean
  /** Set on 'wrong-account': who the profile is actually signed in as. */
  actual?: string
  createdAt: string
  updatedAt: string
}

/** These statuses are still in flight — a device should act, and the UI should keep polling. */
const ACTIVE_STATUSES: ReadonlySet<ConnectRequestStatus> = new Set(['requested', 'opening', 'waiting'])

/** A request older than this with no device having finished it is abandoned and swept. */
export const CONNECT_REQUEST_TTL_MS = 20 * 60_000

const KEY_PREFIX = 'connectRequest:'
const keyFor = (handle: string): string => `${KEY_PREFIX}${handle}`

export function isActiveStatus(status: ConnectRequestStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

/** Read one request, or null. A corrupt row is treated as absent rather than throwing. */
export async function readConnectRequest(handle: string): Promise<ConnectRequest | null> {
  const row = await prisma.setting.findUnique({ where: { key: keyFor(handle) } })
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as ConnectRequest
    return parsed && typeof parsed.handle === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The operator asks a device to open a sign-in window. One active request per handle: a
 * second ask overwrites the first, which is the same "never two windows" discipline
 * `cancelConnect` enforces locally.
 */
export async function enqueueConnectRequest(args: {
  handle: string
  device: string
  requestedBy: string
  now?: Date
}): Promise<ConnectRequest> {
  const now = (args.now ?? new Date()).toISOString()
  const request: ConnectRequest = {
    handle: args.handle,
    device: args.device,
    requestedBy: args.requestedBy,
    status: 'requested',
    message: `Asked ${args.device} to open a sign-in window for @${args.handle}…`,
    createdAt: now,
    updatedAt: now,
  }
  const value = JSON.stringify(request)
  await prisma.setting.upsert({
    where: { key: keyFor(args.handle) },
    update: { value },
    create: { key: keyFor(args.handle), value },
  })
  return request
}

/** A device writes back where it has got to. Merges onto the existing row, never invents one. */
export async function updateConnectRequest(
  handle: string,
  patch: Partial<Pick<ConnectRequest, 'status' | 'message' | 'verified' | 'actual'>>,
  now?: Date,
): Promise<void> {
  const current = await readConnectRequest(handle)
  if (!current) return
  const next: ConnectRequest = { ...current, ...patch, updatedAt: (now ?? new Date()).toISOString() }
  await prisma.setting.upsert({
    where: { key: keyFor(handle) },
    update: { value: JSON.stringify(next) },
    create: { key: keyFor(handle), value: JSON.stringify(next) },
  })
}

/** Remove a request entirely — an operator cancel, or a device that has fully settled it. */
export async function deleteConnectRequest(handle: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: keyFor(handle) } })
}

/**
 * Every ACTIVE request addressed to this device. This is what the device agent's connect
 * pass claims. A terminal status ('connected'/'wrong-account'/'error'/'cancelled') is left
 * for the UI to read once and is then swept by TTL, so a settled request is never re-driven.
 */
export async function activeRequestsForDevice(device: string): Promise<ConnectRequest[]> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: KEY_PREFIX } } })
  const out: ConnectRequest[] = []
  for (const row of rows) {
    try {
      const r = JSON.parse(row.value) as ConnectRequest
      if (r && r.device === device && isActiveStatus(r.status)) out.push(r)
    } catch {
      /* skip a corrupt row */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Delete requests past their TTL in any status — an abandoned window leaves no ghost row. */
export async function sweepStaleRequests(now?: Date): Promise<number> {
  const cutoff = (now ?? new Date()).getTime() - CONNECT_REQUEST_TTL_MS
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: KEY_PREFIX } } })
  let removed = 0
  for (const row of rows) {
    try {
      const r = JSON.parse(row.value) as ConnectRequest
      if (new Date(r.updatedAt).getTime() < cutoff) {
        await prisma.setting.deleteMany({ where: { key: row.key } })
        removed += 1
      }
    } catch {
      await prisma.setting.deleteMany({ where: { key: row.key } }) // a corrupt row is swept too
      removed += 1
    }
  }
  return removed
}

/**
 * How a relayed request reads to the dashboard's existing connect UI. PURE, so the mapping
 * is testable and the UI needs no new state machine — a relayed connect and a local one
 * settle through the identical `ConnectState` union.
 */
export function requestToConnectState(request: ConnectRequest | null, handle: string): ConnectState {
  if (!request) return { state: 'closed', message: 'No connection in progress. Press Connect to start.' }
  switch (request.status) {
    case 'connected':
      return { state: 'connected', handle, verified: request.verified ?? false }
    case 'wrong-account':
      return { state: 'wrong-account', actual: request.actual ?? 'someone else', expected: handle }
    case 'error':
      return { state: 'error', message: request.message }
    case 'cancelled':
      return { state: 'closed', message: request.message }
    case 'requested':
    case 'opening':
    case 'waiting':
      return { state: 'waiting', message: request.message }
  }
}

/**
 * Record a completed sign-in — the DB half of `recordConnected`, extracted so the DEVICE
 * agent can call it too (it is where the profile actually lives, so `profileStatus` reads
 * the right disk). The server action keeps its own `revalidatePath` wrapper; a device has
 * no Next request to revalidate.
 *
 * `verified` is honoured exactly as the local flow honours it: only proof against Instagram
 * clears a `sessionInvalidAt` mark. A cookie on disk is the evidence that mark exists to
 * overrule, so an unverified "connected" writes the session path and nothing else.
 */
export async function persistSenderSession(handle: string, verified: boolean): Promise<void> {
  const st = profileStatus(handle)
  const sender = await prisma.senderAccount.update({
    where: { handle },
    data: { sessionPath: st.dir, sessionSavedAt: new Date() },
  })
  if (verified) {
    await clearSessionInvalid(sender.id, 'hand login relayed from the dashboard, identity verified against Instagram')
  }
}