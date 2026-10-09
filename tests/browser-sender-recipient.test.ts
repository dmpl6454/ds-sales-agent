import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * AUDIT C1 (2026-10-09): how the send driver files an inbox-route refusal.
 *
 * `RecipientUnconfirmedError` is a question about the RECIPIENT. The driver must file it as
 * `recipient-unconfirmed` — a code the delivery paths park on first sight and whose reservation
 * is released — and must set NEITHER `challenged` (which halts the account and trips the fleet
 * breaker) NOR `sessionInvalid` (which marks a live sender session dead and sends a person to
 * the riskiest act in this design, a re-login). Both are what a subclass of the session errors,
 * or a mapping placed after them, would produce.
 */

const sendDm = vi.fn()
vi.mock('@/outreach/browser/sendDm', () => ({ sendDm: (...a: unknown[]) => sendDm(...a) }))
vi.mock('@/outreach/paceClock', () => ({ recordSendStarted: async () => undefined }))
vi.mock('@/lib/env', () => ({ env: { DRY_RUN: false } }))
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() } }))

const { browserSender } = await import('@/outreach/senders/browser')
const { RecipientUnconfirmedError } = await import('@/outreach/browser/messageEntry')
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
  })

  it('a real checkpoint is still a checkpoint', async () => {
    sendDm.mockRejectedValue(new CheckpointError('https://www.instagram.com/challenge/x/', 'challenge'))
    const out = await browserSender.send(req)
    expect(out).toMatchObject({ status: 'FAILED', failureCode: 'enforcement', challenged: true })
  })
})
