import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'
import type { RefusedRecipient } from '@/outreach/browser/messageEntry'

/**
 * AUDIT C1, REVIEWED (2026-10-09): the dashboard's Send button files an unconfirmed recipient
 * the way the dispatcher does — a MISMATCH parks on first sight, `unknown` and `ambiguous` are a
 * transient door miss and take the button's ordinary retryable-failure path. See
 * `tests/recipient-unconfirmed-retry.test.ts` for why one slow render must not retire a route.
 *
 * Driven for real from the THROWN ERROR through the real `browserSender` and the real `sendNow`,
 * with only the session, the database, the gate, the reservations, the lock and the browser
 * faked — the button has no other behavioural harness, and the verdict travelling from the
 * driver to this branch is exactly what a source grep cannot see.
 */

const sendDm = vi.fn()
const findUniqueOrThrow = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const auditCreate = vi.fn()
const settleClaims = vi.fn()
const markChallenged = vi.fn()
const markSessionInvalid = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    outreachAttempt: {
      findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrow(...a),
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}))
vi.mock('@/lib/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/settings')>()),
  getSettings: async () => ({ maxPerPairPerDay: 5, fleetMaxPerDay: null }),
}))
vi.mock('@/outreach/gate', async (orig) => ({
  ...(await orig<typeof import('@/outreach/gate')>()),
  recheckBeforeSend: async () => ({ ok: true }),
}))
vi.mock('@/outreach/reservations', async (orig) => ({
  ...(await orig<typeof import('@/outreach/reservations')>()),
  claimForAttempt: async () => ({ ok: true, held: [{ id: 'res_1', seq: 1 }] }),
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/dispatcher', async (orig) => ({
  ...(await orig<typeof import('@/outreach/dispatcher')>()),
  withSendLock: async (_what: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/outreach/challenge', async (orig) => ({
  ...(await orig<typeof import('@/outreach/challenge')>()),
  markChallenged: (...a: unknown[]) => markChallenged(...a),
}))
vi.mock('@/outreach/sessionHealth', async (orig) => ({
  ...(await orig<typeof import('@/outreach/sessionHealth')>()),
  markSessionInvalid: (...a: unknown[]) => markSessionInvalid(...a),
  clearSessionInvalid: async () => undefined,
}))
vi.mock('@/outreach/browser/sendDm', () => ({ sendDm: (...a: unknown[]) => sendDm(...a) }))
vi.mock('@/outreach/paceClock', async (orig) => ({
  ...(await orig<typeof import('@/outreach/paceClock')>()),
  recordSendStarted: async () => undefined,
}))
vi.mock('@/outreach/browser/profile', () => ({
  profileStatus: () => ({ dir: '/tmp/p', hasSession: true }),
  ensureProfileDir: () => '/tmp/p',
}))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))

const { sendNow } = await import('@/app/actions')
const { RecipientUnconfirmedError } = await import('@/outreach/browser/messageEntry')

/** The update `sendNow` wrote for the draft after the drive (the claim is an `updateMany`). */
function filed(): Record<string, unknown> {
  expect(attemptUpdate).toHaveBeenCalledTimes(1)
  return (attemptUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data
}

beforeEach(() => {
  sendDm.mockReset()
  findUniqueOrThrow.mockReset().mockResolvedValue({
    id: 'att_1',
    pairId: 'pair_1',
    variantId: 'var_1',
    attempts: 0,
    renderedBody: 'Hi,the standard message body that is long enough to carry a needle',
    pair: { sender: { id: 'send_1', handle: 'bollywoodchronicle' }, target: { id: 'targ_tips', handle: 'tips' } },
  })
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  attemptUpdate.mockReset().mockResolvedValue({})
  auditCreate.mockReset().mockResolvedValue({})
  settleClaims.mockReset().mockResolvedValue(undefined)
  markChallenged.mockReset().mockResolvedValue(undefined)
  markSessionInvalid.mockReset().mockResolvedValue(undefined)
})

describe('the Send button: an unconfirmed recipient parks on first sight only when somebody else opened', () => {
  it('a MISMATCH parks FAILED at the cap, releases the reservation, halts nothing', async () => {
    sendDm.mockRejectedValue(new RecipientUnconfirmedError({ kind: 'mismatch', seen: ['tips_india'] }))
    const res = await sendNow('att_1')
    expect(res.ok).toBe(false)
    expect(filed()).toMatchObject({ status: 'FAILED', failureCode: 'recipient-unconfirmed', attempts: MAX_DELIVERY_ATTEMPTS })
    expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }))
    expect(markChallenged).not.toHaveBeenCalled()
    expect(markSessionInvalid).not.toHaveBeenCalled()
  })

  const retryable: RefusedRecipient[] = [
    { kind: 'unknown', why: 'no profile link in the conversation' },
    { kind: 'ambiguous', seen: ['mutual.friend', 'tips'] },
  ]
  for (const verdict of retryable) {
    it(`an ${verdict.kind.toUpperCase()} verdict takes the ordinary retryable path — READY, attempts + 1, reservation released`, async () => {
      sendDm.mockRejectedValue(new RecipientUnconfirmedError(verdict))
      const res = await sendNow('att_1')
      expect(res.ok).toBe(false)
      expect(filed()).toEqual({
        status: 'READY',
        error: expect.stringContaining('@tips'),
        failureCode: 'recipient-unconfirmed',
        attempts: { increment: 1 },
      })
      expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }))
      expect(markChallenged).not.toHaveBeenCalled()
      expect(markSessionInvalid).not.toHaveBeenCalled()
    })
  }
})
