import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RefusedRecipient } from '@/outreach/browser/messageEntry'

/**
 * AUDIT C1 (2026-10-09): how the send driver files an inbox-route refusal.
 *
 * `RecipientUnconfirmedError` is a question about the RECIPIENT. The driver must file it as
 * `recipient-unconfirmed` — a code whose reservation is released — and must set NEITHER
 * `challenged` (which halts the account and trips the fleet breaker) NOR `sessionInvalid` (which
 * marks a live sender session dead and sends a person to the riskiest act in this design, a
 * re-login). Both are what a subclass of the session errors, or a mapping placed after them,
 * would produce.
 *
 * And it must carry the VERDICT (review of C1): the delivery paths park a `mismatch` on first
 * sight and retry `unknown`/`ambiguous` — a transient miss at the profile door — on the ordinary
 * path. Losing the verdict here would park every refusal, which is the bug that review found.
 */

const sendDm = vi.fn()
vi.mock('@/outreach/browser/sendDm', () => ({ sendDm: (...a: unknown[]) => sendDm(...a) }))
vi.mock('@/outreach/paceClock', () => ({ recordSendStarted: async () => undefined }))
vi.mock('@/lib/env', () => ({ env: { DRY_RUN: false } }))
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() } }))

const { browserSender } = await import('@/outreach/senders/browser')
const { RecipientUnconfirmedError, refusalMayRetry } = await import('@/outreach/browser/messageEntry')
const { CheckpointError } = await import('@/outreach/browser/session')

const req = { attemptId: 'att_1', senderHandle: 'bollywoodchronicle', sessionPath: '/tmp/p', targetHandle: 'tips', body: 'hello' }

beforeEach(() => {
  sendDm.mockReset()
})

describe('browserSender files a recipient refusal as a fact about the recipient', () => {
  it("maps RecipientUnconfirmedError to 'recipient-unconfirmed', with no account flag of any kind", async () => {
    sendDm.mockRejectedValue(new RecipientUnconfirmedError({ kind: 'mismatch', seen: ['tips_india'] }))
    const out = await browserSender.send(req)
    expect(out).toMatchObject({ status: 'FAILED', failureCode: 'recipient-unconfirmed' })
    if (out.status !== 'FAILED') throw new Error('unreachable')
    expect(out.challenged).toBeUndefined()
    expect(out.sessionInvalid).toBeUndefined()
    // The recipient is named in the row's prose, which nothing regex-tests.
    expect(out.error).toContain('@tips')
    // A mismatch is NOT retryable: no flag, so both delivery paths park it on first sight.
    expect(out.recipientRetryable).toBeUndefined()
  })

  for (const verdict of [
    { kind: 'unknown', why: 'no profile link in the conversation' },
    { kind: 'ambiguous', seen: ['mutual.friend', 'tips'] },
  ] satisfies RefusedRecipient[]) {
    it(`an ${verdict.kind} refusal is flagged retryable — still the same code, still no account flag`, async () => {
      sendDm.mockRejectedValue(new RecipientUnconfirmedError(verdict))
      const out = await browserSender.send(req)
      expect(out).toMatchObject({ status: 'FAILED', failureCode: 'recipient-unconfirmed', recipientRetryable: true })
      if (out.status !== 'FAILED') throw new Error('unreachable')
      expect(out.challenged).toBeUndefined()
      expect(out.sessionInvalid).toBeUndefined()
    })
  }

  it('refusalMayRetry: only a mismatch is final', () => {
    expect(refusalMayRetry({ kind: 'mismatch', seen: ['tips_india'] })).toBe(false)
    expect(refusalMayRetry({ kind: 'ambiguous', seen: ['mutual.friend', 'tips'] })).toBe(true)
    expect(refusalMayRetry({ kind: 'unknown', why: 'verdict never settled' })).toBe(true)
  })

  it('a real checkpoint is still a checkpoint', async () => {
    sendDm.mockRejectedValue(new CheckpointError('https://www.instagram.com/challenge/x/', 'challenge'))
    const out = await browserSender.send(req)
    expect(out).toMatchObject({ status: 'FAILED', failureCode: 'enforcement', challenged: true })
  })
})
