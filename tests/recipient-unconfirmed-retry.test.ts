import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'
import type { RefusedRecipient } from '@/outreach/browser/messageEntry'

/**
 * AUDIT C1, REVIEWED (2026-10-09): ONE TRANSIENT DOOR MISS MUST NOT RETIRE A ROUTE.
 *
 * A recipient WITH a working Message button reaches the inbox route whenever the profile door
 * misses transiently — the button not visible inside 15 s on a slow render, or found and its
 * click eaten three times by a modal. The inbox route's recipient reader is inferred and fails
 * closed until the live DOM is observed, so it answers `unknown` (or `ambiguous`), the drive
 * throws `RecipientUnconfirmedError`, and the draft was parked on FIRST sight with
 * `attempts = MAX_DELIVERY_ATTEMPTS` — a park `parkBlocksRoute`, the planner and the gate all
 * treat as permanent. One slow render retired the route. A retry starts again at the PROFILE
 * door, which works, so "a retry cannot change Instagram's search ranking or its DOM" is false
 * for those two verdicts.
 *
 * Only a `mismatch` — a conversation that demonstrably names somebody else opened — parks on
 * first sight. `unknown` and `ambiguous` take the ordinary retry path: attempts + 1, the back of
 * the queue, and the usual park at the cap, still carrying `recipient-unconfirmed` so the parked
 * list says what happened. The reservation is released either way, because nothing was typed.
 *
 * Driven end to end from the THROWN ERROR — the real `browserSender` maps it, the real
 * `deliverWaiting` files it — so the verdict cannot be lost between the two without this failing.
 */

const sendDm = vi.fn()
const attemptFindMany = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const senderFindUnique = vi.fn()
const settleClaims = vi.fn()
const markChallenged = vi.fn()
const markSessionInvalid = vi.fn()

vi.mock('@/outreach/browser/sendDm', () => ({ sendDm: (...a: unknown[]) => sendDm(...a) }))
vi.mock('@/outreach/paceClock', () => ({ recordSendStarted: async () => undefined }))
vi.mock('@/outreach/shutdown', () => ({ browserShutdownRequested: () => false }))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true, selected: 'this-mac', thisDevice: 'this-mac' }) }))
vi.mock('@/detection/exists', () => ({ probeHandle: async () => ({ check: 'unknown', facts: null }) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: (...a: unknown[]) => senderFindUnique(...a) },
    outreachAttempt: {
      findMany: (...a: unknown[]) => attemptFindMany(...a),
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
  },
}))
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() } }))
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ autopilotEnabled: true }) }))
vi.mock('@/lib/env', () => ({ env: { DRY_RUN: false, SEND_JITTER_MIN_SECONDS: 0, SEND_JITTER_MAX_SECONDS: 0 } }))
vi.mock('@/lib/time', () => ({ randomInt: () => 0, istDateKey: () => '2026-10-09' }))
vi.mock('@/outreach/browser/profile', () => ({
  profileStatus: () => ({ dir: '/tmp/p', hasSession: true }),
  ensureProfileDir: () => '/tmp/p',
}))
vi.mock('@/outreach/gate', () => ({ recheckBeforeSend: async () => ({ ok: true }) }))
vi.mock('@/outreach/recordSend', () => ({ recordDelivered: async () => undefined, revertUndrivenClaim: async () => true }))
vi.mock('@/outreach/reservations', () => ({
  claimForAttempt: async () => ({ ok: true, held: [{ id: 'res_1', seq: 1 }] }),
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: (...a: unknown[]) => markChallenged(...a) }))
vi.mock('@/outreach/sessionHealth', () => ({
  markSessionInvalid: (...a: unknown[]) => markSessionInvalid(...a),
  clearSessionInvalid: async () => undefined,
}))
vi.mock('@/outreach/replyCheck', () => ({ ensureConversationChecked: async () => ({ ok: true, reason: 'fresh' }) }))

const { deliverWaiting } = await import('@/outreach/deliver')
const { RecipientUnconfirmedError } = await import('@/outreach/browser/messageEntry')

const sender = { id: 'send_1', handle: 'bollywoodchronicle', status: 'ACTIVE' }
function draft(attempts: number) {
  return [
    {
      id: 'att_1',
      variantId: 'var_1',
      renderedBody: 'Hi,the standard message body that is long enough to carry a needle',
      senderId: 'send_1',
      targetId: 'targ_tips',
      touchNumber: 1,
      attempts,
      pair: { sender, target: { handle: 'tips' } },
    },
  ]
}

/** The update `deliverWaiting` wrote for the one draft, after the drive. */
function filed(): Record<string, unknown> {
  const calls = attemptUpdate.mock.calls.filter((c) => (c[0] as { where: { id: string } }).where.id === 'att_1')
  expect(calls).toHaveLength(1)
  return (calls[0]![0] as { data: Record<string, unknown> }).data
}

beforeEach(() => {
  sendDm.mockReset()
  attemptFindMany.mockReset().mockResolvedValue(draft(0))
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  attemptUpdate.mockReset().mockResolvedValue({})
  senderFindUnique.mockReset().mockResolvedValue({ status: 'ACTIVE' })
  settleClaims.mockReset().mockResolvedValue(undefined)
  markChallenged.mockReset().mockResolvedValue(undefined)
  markSessionInvalid.mockReset().mockResolvedValue(undefined)
})

describe('the dispatcher: an unconfirmed recipient parks on first sight only when somebody else opened', () => {
  it('a MISMATCH parks FAILED at the cap on first sight, releases the reservation, halts nothing', async () => {
    sendDm.mockRejectedValue(new RecipientUnconfirmedError({ kind: 'mismatch', seen: ['tips_india'] }))
    await deliverWaiting({ maxSends: 1 })
    const data = filed()
    expect(data).toMatchObject({ status: 'FAILED', failureCode: 'recipient-unconfirmed', attempts: MAX_DELIVERY_ATTEMPTS })
    expect(data).not.toHaveProperty('queuedAt')
    expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }))
    expect(markChallenged).not.toHaveBeenCalled()
    expect(markSessionInvalid).not.toHaveBeenCalled()
  })

  const retryable: RefusedRecipient[] = [
    { kind: 'unknown', why: 'no profile link in the conversation' },
    { kind: 'ambiguous', seen: ['mutual.friend', 'tips'] },
  ]
  for (const verdict of retryable) {
    it(`an ${verdict.kind.toUpperCase()} verdict is retried: attempts + 1, back of the queue, reservation released`, async () => {
      sendDm.mockRejectedValue(new RecipientUnconfirmedError(verdict))
      const before = Date.now()
      await deliverWaiting({ maxSends: 1 })
      const data = filed()
      expect(data).toMatchObject({ status: 'READY', failureCode: 'recipient-unconfirmed', attempts: { increment: 1 } })
      expect((data.queuedAt as Date).getTime()).toBeGreaterThanOrEqual(before)
      expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }))
      expect(markChallenged).not.toHaveBeenCalled()
      expect(markSessionInvalid).not.toHaveBeenCalled()
    })

    it(`an ${verdict.kind.toUpperCase()} verdict at the cap parks FAILED, still named recipient-unconfirmed`, async () => {
      attemptFindMany.mockResolvedValue(draft(MAX_DELIVERY_ATTEMPTS - 1))
      sendDm.mockRejectedValue(new RecipientUnconfirmedError(verdict))
      await deliverWaiting({ maxSends: 1 })
      const data = filed()
      expect(data).toMatchObject({ status: 'FAILED', failureCode: 'recipient-unconfirmed', attempts: { increment: 1 } })
      expect(data).not.toHaveProperty('queuedAt')
      expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }))
    })
  }
})
