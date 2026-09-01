import { describe, expect, it } from 'vitest'
import { describeOnDemand, type OnDemandFacts } from '@/outreach/onDemand'
import { RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'

const NOW = new Date('2026-08-03T10:00:00Z')

/**
 * A state with nothing unusual about it: connected, healthy, never contacted.
 * Each test breaks exactly one thing, so a failure names the rule not the fixture.
 */
function clean(): OnDemandFacts {
  return {
    now: NOW,
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    targetOptedOut: false,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    isSelfSend: false,
    followUpTemplateSet: true,
    touchesSoFar: 0,
    targetRepliedAt: null,
    pendingAttemptCount: 0,
    unusedCampaignCount: 2,
    totalInFlight: 0,
    maxTotalSends: 6,
  }
}

const reasons = (notes: { reason: string }[]) => notes.map((n) => n.reason)

describe('describeOnDemand — the ordinary case', () => {
  it('has nothing to block and nothing to warn about', () => {
    const v = describeOnDemand(clean())
    expect(v.blocks).toEqual([])
    expect(v.warnings).toEqual([])
  })
})

describe('describeOnDemand — absolute stops', () => {
  it.each([
    ['a flagged account', { senderStatus: 'CHALLENGED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['a paused account', { senderStatus: 'PAUSED' }, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
    ['a retired channel', { targetOptedOut: true }, RESEND_BLOCKS.TARGET_OPTED_OUT],
    ['an unconnected account', { senderHasSession: false }, RESEND_BLOCKS.NO_SESSION],
    ['the pair daily cap', { pairSentTodayCount: 5 }, RESEND_BLOCKS.PAIR_DAILY_CAP],
    ['messaging itself', { isSelfSend: true }, 'self-send'],
  ])('blocks %s', (_label, patch, reason) => {
    const v = describeOnDemand({ ...clean(), ...patch })
    expect(reasons(v.blocks)).toContain(reason)
  })

  it('reports EVERY problem, not just the first', () => {
    const v = describeOnDemand({ ...clean(), senderStatus: 'CHALLENGED', targetOptedOut: true, senderHasSession: false })
    expect(reasons(v.blocks)).toEqual(
      expect.arrayContaining([
        RESEND_BLOCKS.SENDER_NOT_ACTIVE,
        RESEND_BLOCKS.TARGET_OPTED_OUT,
        RESEND_BLOCKS.NO_SESSION,
      ]),
    )
  })

  /**
   * ── THE ONE VOLUME RULE LEFT (2026-08-18) — both directions ──────────────
   * A cap that cannot refuse is an off switch; one that cannot permit is an outage.
   */
  it('does not block on a pair allowance that is approached but not reached', () => {
    const v = describeOnDemand({ ...clean(), pairSentTodayCount: 4, maxPerPairPerDay: 5 })
    expect(v.blocks).toEqual([])
  })

  it('blocks at the pair allowance, and the sentence names both numbers', () => {
    const v = describeOnDemand({ ...clean(), pairSentTodayCount: 5, maxPerPairPerDay: 5 })
    const block = v.blocks.find((b) => b.reason === RESEND_BLOCKS.PAIR_DAILY_CAP)
    expect(block).toBeDefined()
    expect(block!.text).toContain('5')
    expect(block!.text).toContain('one account to one recipient')
  })
})

describe('describeOnDemand — warnings', () => {
  it('warns that they replied, and says when', () => {
    const v = describeOnDemand({ ...clean(), targetRepliedAt: new Date('2026-08-01T10:00:00Z') })
    expect(reasons(v.warnings)).toContain(RESEND_BLOCKS.TARGET_REPLIED)
    expect(v.warnings[0]!.text).toContain('2 days ago')
  })

  it('puts the reply warning first — it is the most consequential', () => {
    const v = describeOnDemand({
      ...clean(),
      targetRepliedAt: new Date('2026-08-02T10:00:00Z'),
      touchesSoFar: 1,
      unusedCampaignCount: 0,
      pendingAttemptCount: 1,
    })
    expect(v.warnings[0]!.reason).toBe(RESEND_BLOCKS.TARGET_REPLIED)
  })

  it('warns about repetition only after a first message exists', () => {
    const never = describeOnDemand({ ...clean(), touchesSoFar: 0, unusedCampaignCount: 0 })
    expect(reasons(never.warnings)).not.toContain('no-new-material')

    const followUp = describeOnDemand({ ...clean(), touchesSoFar: 1, unusedCampaignCount: 0 })
    expect(reasons(followUp.warnings)).toContain('no-new-material')
  })

  it('does not warn about repetition when fresh material exists', () => {
    const v = describeOnDemand({ ...clean(), touchesSoFar: 1, unusedCampaignCount: 3 })
    expect(reasons(v.warnings)).not.toContain('no-new-material')
  })

  it('warns when a draft is already waiting', () => {
    expect(reasons(describeOnDemand({ ...clean(), pendingAttemptCount: 1 }).warnings)).toContain(
      'pending-attempt-exists',
    )
  })

  it('warns at the lifetime ceiling but not below it', () => {
    expect(reasons(describeOnDemand({ ...clean(), totalInFlight: 5, maxTotalSends: 6 }).warnings)).not.toContain(
      'lifetime-send-cap-reached',
    )
    expect(reasons(describeOnDemand({ ...clean(), totalInFlight: 6, maxTotalSends: 6 }).warnings)).toContain(
      'lifetime-send-cap-reached',
    )
  })

  it('has no ceiling to warn about when none is configured', () => {
    const v = describeOnDemand({ ...clean(), totalInFlight: 999, maxTotalSends: null })
    expect(reasons(v.warnings)).not.toContain('lifetime-send-cap-reached')
  })
})

describe('the two vocabularies agree', () => {
  /**
   * The UI passes every warning code it displayed to `sendNow` as an override. A
   * warning whose code is not in OVERRIDABLE_BLOCKS is therefore un-crossable, and
   * the button would refuse *after* telling the operator to acknowledge it —
   * confusing, and impossible to diagnose from the screen.
   *
   * Only the stops `evaluateResend` actually enforces need to be crossable. The rest
   * (repetition, the pending draft, the ceiling) are governor rules that the on-demand
   * path bypasses by construction, because it never asks the governor.
   *
   * ONE SWITCH, 2026-08-08: this was two entries. `pair-disabled` went with the per-route
   * chips — routes are automatic now, so there is nothing for a human to acknowledge.
   */
  const ENFORCED_BY_RESEND = [RESEND_BLOCKS.TARGET_REPLIED]

  it.each(ENFORCED_BY_RESEND)('%s is warned about AND overridable', (reason) => {
    expect(OVERRIDABLE_BLOCKS).toContain(reason)
  })

  it('never lists an absolute stop as overridable', () => {
    for (const absolute of [
      RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      RESEND_BLOCKS.TARGET_OPTED_OUT,
      RESEND_BLOCKS.NO_SESSION,
      RESEND_BLOCKS.PAIR_DAILY_CAP,
      RESEND_BLOCKS.NOT_WAITING,
    ]) {
      expect(OVERRIDABLE_BLOCKS).not.toContain(absolute)
    }
  })

  it('never both blocks and warns about the same thing', () => {
    // A code in both lists would render as "you cannot do this" and "tick to do it
    // anyway" at once. Exercised against a deliberately maximal failure state.
    const v = describeOnDemand({
      ...clean(),
      senderStatus: 'CHALLENGED',
      targetOptedOut: true,
      senderHasSession: false,
      pairSentTodayCount: 9,
      targetRepliedAt: new Date('2026-08-01T10:00:00Z'),
      touchesSoFar: 4,
      unusedCampaignCount: 0,
      pendingAttemptCount: 2,
      totalInFlight: 10,
    })
    expect(reasons(v.blocks).filter((r) => reasons(v.warnings).includes(r))).toEqual([])
  })
})
