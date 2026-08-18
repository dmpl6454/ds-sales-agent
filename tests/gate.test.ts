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
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    targetOptedOut: false,
    targetIsWatchOnly: false,
    targetRepliedAt: null,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
  }
}

describe('evaluateResend — the permitted case', () => {
  it('allows a READY attempt when nothing has changed', () => {
    expect(evaluateResend(ok())).toEqual({ ok: true })
  })

  it('allows a QUEUED attempt too', () => {
    expect(evaluateResend({ ...ok(), attemptStatus: 'QUEUED' })).toEqual({ ok: true })
  })

  /**
   * ONE SWITCH (Tabish, 2026-08-08). There is no longer a per-account arming switch to
   * satisfy: an unattended send needs only the invariants — session, status, cohort,
   * the pair allowance. Asserted here because "autopilot on and nothing goes out" with a
   * hidden second switch behind it is the failure this change removes.
   */
  it('allows an unattended send with no per-account switch to turn on', () => {
    expect(evaluateResend({ ...ok(), unattended: true })).toEqual({ ok: true })
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
})

/**
 * ── THE ONE VOLUME RULE LEFT (2026-08-18, Tabish's instruction) ─────────────
 *
 * "there must be only a limit of say 5 messages per target per same account in a day
 * … rest unlimited. Remove all caps." Both directions asserted: a cap that cannot
 * refuse is an off switch, and one that cannot permit is an outage.
 */
describe('evaluateResend — the pair daily cap', () => {
  it('refuses the sixth message from one account to one recipient in a day', () => {
    const r = evaluateResend({ ...ok(), pairSentTodayCount: 5, maxPerPairPerDay: 5 })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.PAIR_DAILY_CAP })
  })

  it('permits the fifth — 4 of 5 used leaves room', () => {
    expect(evaluateResend({ ...ok(), pairSentTodayCount: 4, maxPerPairPerDay: 5 })).toEqual({ ok: true })
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

/**
 * ── ONE SWITCH: what `unattended` STILL decides ───────────────────────────
 *
 * The per-account arming switch is gone (Tabish, 2026-08-08), so `unattended` no longer
 * gates on a stored flag. It is still load-bearing for two things, and both are asserted
 * here — a removed switch must not quietly take the surviving rules with it.
 */
describe('evaluateResend — attended vs unattended', () => {
  it('applies the same invariants in both directions', () => {
    expect(evaluateResend({ ...ok(), unattended: true })).toEqual({ ok: true })
    expect(evaluateResend({ ...ok(), unattended: false })).toEqual({ ok: true })
  })

  /** The cohort ladder is asked ONLY when nobody is present. */
  it('asks the cohort ladder when unattended, and not when a human clicked Send', () => {
    const blocked = evaluateResend({ ...ok(), unattended: true, senderCohortCleared: false })
    expect(blocked).toMatchObject({ ok: false, reason: RESEND_BLOCKS.COHORT_NOT_CLEARED })
    expect(evaluateResend({ ...ok(), unattended: false, senderCohortCleared: false })).toEqual({ ok: true })
  })
})

describe('evaluateResend — precedence', () => {
  it('reports a reply ahead of the pair cap, because it is the more absolute stop', () => {
    const r = evaluateResend({
      ...ok(),
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      pairSentTodayCount: 9,
    })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('reports not-waiting ahead of everything, because nothing else can matter', () => {
    const r = evaluateResend({ ...ok(), attemptStatus: 'SENT', targetOptedOut: true, senderHasSession: false })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.NOT_WAITING })
  })
})

/**
 * Overrides — the on-demand Send button.
 *
 * Tested in BOTH directions for every entry, and specifically that the closed
 * whitelist holds. The danger here is not that an override fails to work; it is that
 * an override works on something it must never reach, which no ordinary use would
 * ever reveal.
 */
describe('evaluateResend — operator overrides', () => {
  it('crosses target-replied when the operator acknowledged it', () => {
    const r = evaluateResend({
      ...ok(),
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      overrides: [RESEND_BLOCKS.TARGET_REPLIED],
    })
    expect(r).toEqual({ ok: true })
  })

  it('still blocks target-replied when the acknowledgement is absent', () => {
    const r = evaluateResend({ ...ok(), targetRepliedAt: new Date('2026-07-31T08:22:00Z') })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('acknowledging one stop does not cross a different one', () => {
    const r = evaluateResend({
      ...ok(),
      targetOptedOut: true,
      overrides: [RESEND_BLOCKS.TARGET_REPLIED],
    })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT })
  })

  // The whitelist, one test per absolute stop. Each passes the matching override
  // and asserts it is ignored — this is the property the feature rests on.
  it.each([
    ['a retired recipient', { targetOptedOut: true }, RESEND_BLOCKS.TARGET_OPTED_OUT],
    ['a flagged account', { senderStatus: 'CHALLENGED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['a paused account', { senderStatus: 'PAUSED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['an unconnected account', { senderHasSession: false }, RESEND_BLOCKS.NO_SESSION],
    ['a watch-only page', { targetIsWatchOnly: true }, RESEND_BLOCKS.TARGET_IS_WATCH_ONLY],
    ['the pair daily cap', { pairSentTodayCount: 5 }, RESEND_BLOCKS.PAIR_DAILY_CAP],
    ['an already-sent message', { attemptStatus: 'SENT' }, RESEND_BLOCKS.NOT_WAITING],
  ])('refuses to cross %s even when that exact code is passed', (_label, patch, reason) => {
    const r = evaluateResend({ ...ok(), ...patch, overrides: [reason] })
    expect(r).toMatchObject({ ok: false, reason })
  })

  it('ignores overrides entirely when nobody is present', () => {
    const r = evaluateResend({
      ...ok(),
      unattended: true,
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      overrides: [RESEND_BLOCKS.TARGET_REPLIED],
    })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('is unaffected by an override code it does not recognise', () => {
    expect(evaluateResend({ ...ok(), overrides: ['not-a-real-block'] })).toEqual({ ok: true })
  })
})

/**
 * ── TWO TARGET TYPES (2026-08-17): a WATCH page is never a recipient ────────
 *
 * The gate is what catches drafts written BEFORE the rule existed — routes.ts only
 * governs creation, and 6 live drafts to our two competitors were sitting in READY the
 * day this shipped.
 */
describe('evaluateResend — watch-only targets', () => {
  it('refuses a draft aimed at a page we watch', () => {
    const r = evaluateResend({ ...ok(), targetIsWatchOnly: true })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_IS_WATCH_ONLY })
  })

  it('permits an ordinary prospect', () => {
    expect(evaluateResend({ ...ok(), targetIsWatchOnly: false }).ok).toBe(true)
  })
})
