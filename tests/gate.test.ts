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
    senderDailyCap: 5,
    targetOptedOut: false,
  targetIsWatchOnly: false,
    targetRepliedAt: null,
  targetRecentContact: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
    personaSharedWithAnotherSender: false,
  draftPersonaStale: false,
    draftHookStale: false,
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
   * persona, caps. Asserted here because "autopilot on and nothing goes out" with a
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
  it('reports a reply ahead of a daily cap, because it is the more absolute stop', () => {
    const r = evaluateResend({
      ...ok(),
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      targetSentTodayCount: 9,
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
    ['a retired channel', { targetOptedOut: true }, RESEND_BLOCKS.TARGET_OPTED_OUT],
    ['a flagged account', { senderStatus: 'CHALLENGED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['a paused account', { senderStatus: 'PAUSED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['an unconnected account', { senderHasSession: false }, RESEND_BLOCKS.NO_SESSION],
    ['the target daily cap', { targetSentTodayCount: 2 }, RESEND_BLOCKS.TARGET_DAILY_CAP],
    ['the sender daily cap', { senderSentTodayCount: 5 }, RESEND_BLOCKS.SENDER_DAILY_CAP],
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

describe('the persona gate holds at DELIVERY, not only at drafting  [decision 6]', () => {
  /**
   * The planner refuses to CREATE a message from a shared persona. But a draft written
   * before the gate existed — or before decision 6 extended it to channels — is already
   * sitting in READY with a Send button beside it. "Nothing sends until each account has
   * its own persona" has to be true of those too, or the brake only applies to work that
   * has not happened yet.
   */
  it('refuses a waiting draft from an account whose persona is shared', () => {
    const r = evaluateResend({ ...ok(), personaSharedWithAnotherSender: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.PERSONA_NOT_DISTINCT)
  })

  /** ...and the other direction, or it is just an off switch. */
  it('permits it once the persona is the account\'s own', () => {
    expect(evaluateResend({ ...ok(), personaSharedWithAnotherSender: false }).ok).toBe(true)
  })

  /**
   * ABSOLUTE. Every stop a human may cross is about TIMING — too soon, nothing new to
   * say, they already replied. This one is about the message being wrong for its
   * recipient, and "I know something the agent does not" is not an argument that applies
   * to a signature naming the wrong company.
   */
  it('is NOT overridable, even when a human asks for exactly that', () => {
    const r = evaluateResend({
      ...ok(),
      personaSharedWithAnotherSender: true,
      overrides: [RESEND_BLOCKS.PERSONA_NOT_DISTINCT, 'persona-not-distinct'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.PERSONA_NOT_DISTINCT)
  })

  it('is absent from the overridable whitelist', async () => {
    const { OVERRIDABLE_BLOCKS } = await import('@/outreach/gate')
    expect(OVERRIDABLE_BLOCKS).not.toContain(RESEND_BLOCKS.PERSONA_NOT_DISTINCT)
  })
})

/**
 * ── the persona can change AFTER the words are written ────────────────────
 *
 * OBSERVED IN PRODUCTION 2026-08-05. From the audit log:
 *
 *   15:10:54  a draft is prepared — the body is rendered with the persona AS IT IS
 *   15:12:23  the operator gives the account its own identity
 *   15:12:28  Send is pressed. The persona gate CHECKS THE ACCOUNT and passes
 *   15:13:15  delivered — still saying "I'm Kapil Jain, Co-founder of Bollywood Society"
 *
 * The gate was satisfied by a fact that had nothing to do with what was actually sent. At the
 * moment this was found, all three waiting drafts said "Co-founder of Bollywood Society" while
 * two of those accounts had become Mad About Marketing and Bollywood Chronicle — so a Send
 * button would have delivered another company's name to a real prospect.
 */
describe('a draft whose persona has since changed', () => {
  it('is refused', () => {
    const r = evaluateResend({ ...ok(), draftPersonaStale: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT)
  })

  /** The permitting direction: a draft that still matches its account sends normally. */
  it('is permitted when the body still matches the account', () => {
    expect(evaluateResend({ ...ok(), draftPersonaStale: false }).ok).toBe(true)
  })

  /**
   * NOT crossable. Every stop a person may cross is about TIMING; this one is about the
   * message naming the wrong company, which no confirmation dialog improves.
   */
  it('cannot be overridden', () => {
    const r = evaluateResend({
      ...ok(),
      draftPersonaStale: true,
      overrides: [RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT)
  })

  /** It also applies to an ATTENDED send — a person clicking Send is not the point here. */
  it('applies whether or not a person is present', () => {
    expect(evaluateResend({ ...ok(), unattended: false, draftPersonaStale: true }).ok).toBe(false)
    expect(evaluateResend({ ...ok(), unattended: true, draftPersonaStale: true }).ok).toBe(false)
  })
})

describe('one recipient, one conversation at a time  [2026-08-17]', () => {
  /**
   * THE MEASURED INCIDENT, as a fixture: @absolutejk heard from @bollywoodchronicle at
   * 17:44 and from @bollywoodsocietyy at 18:13 the same day — twenty-nine minutes apart,
   * near-identical bodies, different page names. Every spacing rule was per PAIR, so the
   * second page's message was a "first touch" with no history; the only cross-sender rule
   * (2/recipient/day) PERMITS one duplicate a day; and rotation deliberately elects the
   * next page for the next touch. Tabish saw it on the dashboard before any code did.
   */
  it('refuses when ANY of our pages delivered to this recipient inside the window', () => {
    const r = evaluateResend({
      ...ok(),
      targetRecentContact: { fromHandle: 'bollywoodchronicle', hoursAgo: 0.5 },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED)
      // The detail names the page and the recency — a refusal must say why, on the thing
      // it refuses, and "some rule fired" is not a reason an operator can act on.
      expect(r.detail).toContain('bollywoodchronicle')
    }
  })

  /**
   * The direction Tabish described: "another page only if the first was blocked." A
   * blocked sender DELIVERED nothing, so the recipient never locks — the fallback works
   * by construction rather than by an exception nobody tests.
   */
  it('a recipient nobody has actually reached is open to any page', () => {
    expect(evaluateResend({ ...ok(), targetRecentContact: null }).ok).toBe(true)
  })

  it('is absolute — an override must be inert, like the daily caps', () => {
    const r = evaluateResend({
      ...ok(),
      targetRecentContact: { fromHandle: 'bollywoodchronicle', hoursAgo: 2 },
      overrides: [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED],
    })
    expect(r.ok).toBe(false)
  })

  it('applies unattended and attended alike', () => {
    const contact = { fromHandle: 'bollywoodsocietyy', hoursAgo: 26 }
    expect(evaluateResend({ ...ok(), unattended: true, targetRecentContact: contact }).ok).toBe(false)
    expect(evaluateResend({ ...ok(), unattended: false, targetRecentContact: contact }).ok).toBe(false)
  })
})
