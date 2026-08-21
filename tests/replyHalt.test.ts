import { describe, expect, it } from 'vitest'
import { replyHaltActive, replyHaltFloor, REPLY_RESUME_HOURS_DEFAULT } from '@/outreach/replyHalt'

/**
 * The reply halt releases ITSELF after `replyResumeHours` — Tabish's decision,
 * 2026-08-07, chosen after the risk was stated (an automated follow-up resuming into a
 * conversation a human answered). These tests pin the rule in BOTH directions on both
 * sides of the boundary, because a halt that never releases and a halt that never holds
 * would each pass a one-direction suite.
 */
describe('replyHaltActive', () => {
  const NOW = new Date('2026-08-07T12:00:00Z')
  const HOURS = 24

  it('a fresh reply halts', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-07T11:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(true)
  })

  it('a reply older than the window has released itself', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-06T11:59:59Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(false)
  })

  it('exactly at the boundary still halts — the window is inclusive', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-06T12:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(true)
  })

  /**
   * ── AN UNDATABLE REPLY DOES NOT HOLD THE HALT (Tabish's rule, 2026-08-21) ──
   *
   * `replyPostedAt: null` covers two cases that must behave the same: no reply at all,
   * and a reply whose date the thread/inbox never showed. Verbatim: *"the agent must see
   * the date on the reply … if no date is visible send the message … as the reply might
   * be to an older conversation."* The reply itself is still recorded (`repliedAt`,
   * `replyText`) and still listed for a person — only the automatic seven-day pause
   * requires a date it can count from. This is the permissive direction, chosen by him,
   * recorded here.
   */
  it('no dated reply, no halt — undatable replies release per the 2026-08-21 rule', () => {
    expect(replyHaltActive({ replyPostedAt: null, replyHandledAt: null, resumeHours: HOURS, now: NOW })).toBe(false)
  })

  it('"handled" is an early release inside the window', () => {
    expect(
      replyHaltActive({
        replyPostedAt: new Date('2026-08-07T11:00:00Z'),
        replyHandledAt: new Date('2026-08-07T11:30:00Z'),
        resumeHours: HOURS,
        now: NOW,
      }),
    ).toBe(false)
  })

  /**
   * A prospect who keeps replying keeps deferring: each NEW reply carries its own
   * timestamp (only unrecorded messages count as new — replyCheck.ts), so the window
   * re-arms from the newest one.
   */
  it('a newer reply re-arms the window', () => {
    const old = replyHaltActive({ replyPostedAt: new Date('2026-08-05T12:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW })
    const renewed = replyHaltActive({ replyPostedAt: new Date('2026-08-07T09:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW })
    expect(old).toBe(false)
    expect(renewed).toBe(true)
  })

  it('the old behaviour is one Setting away — a huge window never releases in practice', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2020-01-01T00:00:00Z'), replyHandledAt: null, resumeHours: 24 * 365 * 100, now: NOW }),
    ).toBe(true)
  })
})

describe('replyHaltFloor', () => {
  it('is exactly resumeHours before now', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    expect(replyHaltFloor(24, now).toISOString()).toBe('2026-08-06T12:00:00.000Z')
    expect(replyHaltFloor(1, now).toISOString()).toBe('2026-08-07T11:00:00.000Z')
  })

  it('default is seven days — Tabish\'s "resume after 7 days automatically or manually" (2026-08-19)', () => {
    expect(REPLY_RESUME_HOURS_DEFAULT).toBe(168)
  })
})
