import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── §3.5: THE LOGGED-OUT ACCOUNT ────────────────────────────────────────────
 *
 * A dead Instagram session was invisible: the cookie file survives a server-side
 * revocation, so `hasSession` said "connected" while every real send threw
 * `NotLoggedInError` — which was caught, filed as `failureCode: 'navigation'`
 * (the retryable code), and written NOWHERE on the account. The paced dispatcher
 * drove a browser at the dead session every fifteen minutes, forever.
 *
 * These tests verify BOTH directions, deliberately, because a guard only ever run
 * on its passing case is this codebase's signature failure:
 *
 *   failing case  a `sessionInvalid` outcome writes the mark through the ONE
 *                 writer, keeps the draft READY, and the gate then refuses with
 *                 the existing `no-session` stop
 *   passing case  an account with a live session still sends — a fail-closed
 *                 default here would brick the whole fleet
 */

const senderFindUnique = vi.fn()
const attemptFindMany = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const senderUpdate = vi.fn()
const auditCreate = vi.fn()
const send = vi.fn()
const recheck = vi.fn()
const claimForAttempt = vi.fn()
const settleClaims = vi.fn()
const markChallenged = vi.fn()
const markSessionInvalid = vi.fn()
const clearSessionInvalid = vi.fn()
const ensureConversationChecked = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: (...a: unknown[]) => senderFindUnique(...a), update: (...a: unknown[]) => senderUpdate(...a) },
    outreachAttempt: {
      findMany: (...a: unknown[]) => attemptFindMany(...a),
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ autopilotEnabled: true }) }))
vi.mock('@/lib/env', () => ({
  env: { DRY_RUN: false, SEND_JITTER_MIN_SECONDS: 0, SEND_JITTER_MAX_SECONDS: 0 },
}))
vi.mock('@/lib/time', () => ({ randomInt: () => 0, istDateKey: () => '2026-08-06' }))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: { send: (...a: unknown[]) => send(...a) } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))
vi.mock('@/outreach/gate', () => ({ recheckBeforeSend: (...a: unknown[]) => recheck(...a) }))
vi.mock('@/outreach/recordSend', () => ({ recordDelivered: async () => undefined }))
vi.mock('@/outreach/reservations', () => ({
  claimForAttempt: (...a: unknown[]) => claimForAttempt(...a),
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: (...a: unknown[]) => markChallenged(...a) }))
vi.mock('@/outreach/sessionHealth', () => ({
  markSessionInvalid: (...a: unknown[]) => markSessionInvalid(...a),
  clearSessionInvalid: (...a: unknown[]) => clearSessionInvalid(...a),
}))
vi.mock('@/outreach/replyCheck', () => ({
  ensureConversationChecked: (...a: unknown[]) => ensureConversationChecked(...a),
}))

const { deliverWaiting } = await import('@/outreach/deliver')

function oneDraft() {
  const sender = { id: 'send_1', handle: 'tabishmukaddam1', status: 'ACTIVE', autoSendEnabled: true }
  return [
    {
      id: 'att_1',
      variantId: 'var_1',
      renderedBody: 'body one',
      senderId: 'send_1',
      targetId: 'targ_a',
      touchNumber: 1,
      pair: { sender, target: { handle: 'target_a' } },
    },
  ]
}

beforeEach(() => {
  senderFindUnique.mockReset().mockResolvedValue({ status: 'ACTIVE', autoSendEnabled: true })
  attemptFindMany.mockReset().mockResolvedValue(oneDraft())
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  attemptUpdate.mockReset().mockResolvedValue({})
  senderUpdate.mockReset().mockResolvedValue({})
  auditCreate.mockReset().mockResolvedValue({})
  recheck.mockReset().mockResolvedValue({ ok: true })
  claimForAttempt.mockReset().mockResolvedValue({ ok: true, held: [{ id: 'res_1', seq: 1 }] })
  settleClaims.mockReset().mockResolvedValue(undefined)
  markChallenged.mockReset().mockResolvedValue(undefined)
  markSessionInvalid.mockReset().mockResolvedValue(undefined)
  clearSessionInvalid.mockReset().mockResolvedValue(undefined)
  ensureConversationChecked.mockReset().mockResolvedValue({ ok: true, reason: 'fresh' })
  send.mockReset().mockResolvedValue({ status: 'SENT', threadUrl: 'https://x' })
})

describe('a logged-out account is RECORDED, not retried into', () => {
  it('writes the evidence through the one writer that also stamps the timestamp', async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'Chrome profile for @tabishmukaddam1 is not logged in',
      failureCode: 'logged-out',
      sessionInvalid: true,
    })
    await deliverWaiting()

    /**
     * `markSessionInvalid` writes `sessionInvalidAt` too, which the gate reads. A code
     * path writing the failure any other way would leave the timestamp null — and the
     * gate would keep reading "connected", which is the every-fifteen-minutes bug itself.
     */
    expect(markSessionInvalid).toHaveBeenCalledOnce()
    expect(markSessionInvalid.mock.calls[0]![0]).toMatchObject({
      senderId: 'send_1',
      handle: 'tabishmukaddam1',
      actor: 'autopilot',
    })
    expect(markChallenged).not.toHaveBeenCalled()
  })

  it('keeps the draft READY — the message is fine, the account is not', async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'not logged in',
      failureCode: 'logged-out',
      sessionInvalid: true,
    })
    const out = await deliverWaiting()
    const data = (attemptUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.status).toBe('READY')
    expect(data.failureCode).toBe('logged-out')
    expect(out.failed).toBe(1)
    expect(out.outcomes[0]!.result).toContain('logged out')
  })

  /** The other direction: a live session must still deliver, or the fleet is bricked. */
  it('still sends and CLEARS the mark when the session works', async () => {
    const out = await deliverWaiting()
    expect(send).toHaveBeenCalledOnce()
    expect(out.sent).toBe(1)
    expect(markSessionInvalid).not.toHaveBeenCalled()
    // A delivered send is one of the two sanctioned proofs.
    expect(clearSessionInvalid).toHaveBeenCalledOnce()
    expect(clearSessionInvalid.mock.calls[0]![0]).toBe('send_1')
  })

  /** An ordinary transient failure must NOT mark the session — only evidence may. */
  it('does not mark the session on a plain navigation failure', async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'could not reach the profile',
      failureCode: 'navigation',
    })
    await deliverWaiting()
    expect(markSessionInvalid).not.toHaveBeenCalled()
    expect(clearSessionInvalid).not.toHaveBeenCalled()
  })
})

describe('the pure liveness question', () => {
  /**
   * Imported directly (unmocked) — `sessionUsable` is the single definition of
   * "connected" the gate, the planner and every page share.
   */
  it('answers both directions', async () => {
    const real = await vi.importActual<typeof import('@/outreach/sessionHealth')>('@/outreach/sessionHealth')
    // live: cookie on disk, nothing has disproved it
    expect(real.sessionUsable({ hasSessionOnDisk: true, sessionInvalidAt: null })).toBe(true)
    // dead: cookie on disk, a real send proved it dead — the @tabishmukaddam1 state
    expect(real.sessionUsable({ hasSessionOnDisk: true, sessionInvalidAt: new Date('2026-08-06T06:15:00Z') })).toBe(false)
    // never logged in: no cookie at all
    expect(real.sessionUsable({ hasSessionOnDisk: false, sessionInvalidAt: null })).toBe(false)
    // both: no cookie AND marked — still dead
    expect(real.sessionUsable({ hasSessionOnDisk: false, sessionInvalidAt: new Date() })).toBe(false)
  })
})
