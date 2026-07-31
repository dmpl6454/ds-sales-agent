import { describe, expect, it } from 'vitest'
import { evaluateResend, RESEND_BLOCKS, type ResendInput } from '@/outreach/gate'

/**
 * A state where sending is permitted. Each test breaks exactly one thing, so a
 * failure names the rule rather than the fixture.
 */
function ok(): ResendInput {
  return {
    attemptStatus: 'READY',
    unattended: false,
    pairEnabled: true,
    senderStatus: 'ACTIVE',
    senderAutoSendEnabled: false,
    senderHasSession: true,
    senderDailyCap: 5,
    targetOptedOut: false,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
  }
}

describe('evaluateResend — the permitted case', () => {
  it('allows a READY attempt when nothing has changed', () => {
    expect(evaluateResend(ok())).toEqual({ ok: true })
  })

  it('allows a QUEUED attempt too', () => {
    expect(evaluateResend({ ...ok(), attemptStatus: 'QUEUED' })).toEqual({ ok: true })
  })

  it('allows an unattended send when the account is armed', () => {
    expect(evaluateResend({ ...ok(), unattended: true, senderAutoSendEnabled: true })).toEqual({ ok: true })
  })
})

describe('evaluateResend — blocks the dashboard Send button used to bypass', () => {
  it('blocks when the target has replied', () => {
    const r = evaluateResend({ ...ok(), targetRepliedAt: new Date('2026-07-31T08:22:00Z') })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('blocks when the target is opted out', () => {
    const r = evaluateResend({ ...ok(), targetOptedOut: true })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT })
  })

  it('blocks when the route is switched off', () => {
    const r = evaluateResend({ ...ok(), pairEnabled: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.PAIR_DISABLED })
  })

  it('blocks when the target already had its allowance today', () => {
    const r = evaluateResend({ ...ok(), targetSentTodayCount: 2, maxPerTargetPerDay: 2 })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_DAILY_CAP })
  })

  it('blocks when the sender is at its own daily cap', () => {
    const r = evaluateResend({ ...ok(), senderSentTodayCount: 5, senderDailyCap: 5 })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.SENDER_DAILY_CAP })
  })
})

describe('evaluateResend — blocks both callers already had', () => {
  it('blocks an attempt that is no longer waiting', () => {
    const r = evaluateResend({ ...ok(), attemptStatus: 'SENT' })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.NOT_WAITING })
  })

  it('blocks a CHALLENGED sender', () => {
    const r = evaluateResend({ ...ok(), senderStatus: 'CHALLENGED' })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE })
  })

  it('blocks a disconnected profile', () => {
    const r = evaluateResend({ ...ok(), senderHasSession: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.NO_SESSION })
  })
})

describe('evaluateResend — attended vs unattended', () => {
  it('requires auto-send ONLY when unattended', () => {
    const r = evaluateResend({ ...ok(), unattended: true, senderAutoSendEnabled: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.AUTO_SEND_OFF })
  })

  /**
   * The switch means "this account may send with nobody present". A human clicking
   * Send is the presence it is asking about, so requiring it there would be wrong.
   */
  it('does NOT require auto-send when a human clicked Send', () => {
    expect(evaluateResend({ ...ok(), unattended: false, senderAutoSendEnabled: false })).toEqual({ ok: true })
  })
})

describe('evaluateResend — precedence', () => {
  it('reports a reply ahead of a daily cap, because it is the more absolute stop', () => {
    const r = evaluateResend({
      ...ok(),
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      targetSentTodayCount: 9,
    })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('reports not-waiting ahead of everything, because nothing else can matter', () => {
    const r = evaluateResend({ ...ok(), attemptStatus: 'SENT', targetOptedOut: true, pairEnabled: false })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.NOT_WAITING })
  })
})
