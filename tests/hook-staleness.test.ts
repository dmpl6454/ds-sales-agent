import { describe, it, expect } from 'vitest'
import { assertedRecency, hookRecencyStale, brandFirstTouch, describeRecency } from '@/outreach/brandPitch'
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import type { ResendInput } from '@/outreach/gate'

/**
 * A FROZEN BODY MUST NOT CARRY A DECAYING CLAIM.
 *
 * MEASURED 2026-08-13: the Amazon draft was written on 11 August about a campaign 9 days old
 * — "last week", correct at the time — and is still queued today about a placement 11 days
 * old. `describeRecency` bands `days <= 10` as "last week", so the sentence stopped being
 * true while the draft sat there. Autopilot being off is exactly what makes this accumulate.
 */

const NOW = new Date('2026-08-13T12:00:00Z')
const pitch = (postedAt: Date) =>
  brandFirstTouch({
    brandName: 'Amazon India',
    handle: 'amazondotin',
    publisherName: 'Mad Over Marketing',
    postedAt,
    now: new Date('2026-08-11T12:00:00Z'),
  })

describe('assertedRecency — what does this already-written body claim?', () => {
  it('reads the band out of a real rendered pitch', () => {
    // Written on the 11th about a post from the 2nd: 9 days → "last week".
    expect(assertedRecency(pitch(new Date('2026-08-02T12:00:00Z')))).toBe('last week')
    expect(assertedRecency(pitch(new Date('2026-08-10T12:00:00Z')))).toBe('this week')
    expect(assertedRecency(pitch(new Date('2026-07-10T12:00:00Z')))).toBe('recently')
  })

  it('returns null for a pitch that names no placement — the degraded opening', () => {
    const body = brandFirstTouch({
      brandName: 'Amazon India',
      handle: 'amazondotin',
      publisherName: null,
      postedAt: new Date('2026-08-02T12:00:00Z'),
      now: NOW,
    })
    expect(assertedRecency(body)).toBeNull()
  })

  it('returns null when a placement is named without a date', () => {
    // Past 120 days `describeRecency` returns null and the claim is undated.
    const body = pitch(new Date('2026-01-02T12:00:00Z'))
    expect(body).toContain('placement with Mad Over Marketing')
    expect(assertedRecency(body)).toBeNull()
  })

  it('is not fooled by the word "recently" used elsewhere in an edited body', () => {
    /**
     * The reason this is anchored on the placement sentence rather than matching the bare
     * phrase: "recently" is an ordinary English word and an operator may edit a body by hand.
     */
    const edited = 'Hi there,\n\nWe have recently expanded our network.\n\nCould I send a short plan?'
    expect(assertedRecency(edited)).toBeNull()
  })
})

describe('hookRecencyStale', () => {
  it('FIRES on the live case: written when it was 9 days old, read when it is 11', () => {
    const postedAt = new Date('2026-08-02T12:00:00Z')
    const body = pitch(postedAt)
    expect(assertedRecency(body)).toBe('last week')
    // Same body, two days later. The band is now "recently".
    expect(describeRecency(postedAt, NOW)).toBe('recently')
    expect(hookRecencyStale({ body, postedAt, now: NOW })).toBe(true)
  })

  it('does NOT fire while the claim is still true — the common path stays free', () => {
    const postedAt = new Date('2026-08-08T12:00:00Z')
    const body = pitch(postedAt)
    expect(hookRecencyStale({ body, postedAt, now: NOW })).toBe(false)
  })

  it('does not fire on a body that makes no dated claim, whatever the age', () => {
    const body = brandFirstTouch({
      brandName: 'Amazon India',
      handle: 'amazondotin',
      publisherName: null,
      postedAt: null,
      now: NOW,
    })
    for (const postedAt of [null, new Date('2020-01-01T00:00:00Z'), new Date('2026-08-13T11:00:00Z')]) {
      expect(hookRecencyStale({ body, postedAt, now: NOW })).toBe(false)
    }
  })

  it('a dated claim whose campaign we can no longer date is STALE, not safe', () => {
    /**
     * Absence of data must not harden into permission. The body says "last week" and the post
     * it referred to is gone — that is exactly the state in which the sentence cannot be
     * stood behind.
     */
    const body = pitch(new Date('2026-08-02T12:00:00Z'))
    expect(hookRecencyStale({ body, postedAt: null, now: NOW })).toBe(true)
  })

  it('fires in the other direction too — a body older than its own claim', () => {
    // "recently" asserted, but the campaign turns out to be two days old.
    const body = pitch(new Date('2026-07-10T12:00:00Z'))
    expect(assertedRecency(body)).toBe('recently')
    expect(hookRecencyStale({ body, postedAt: new Date('2026-08-12T12:00:00Z'), now: NOW })).toBe(true)
  })
})

describe('the gate stop', () => {
  const ok = (): ResendInput => ({
    attemptStatus: 'READY',
    unattended: false,
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    senderDailyCap: 5,
    targetOptedOut: false,
  targetIsWatchOnly: false,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
    personaSharedWithAnotherSender: false,
    draftPersonaStale: false,
    draftHookStale: false,
  })

  it('permits when the claim is current', () => {
    expect(evaluateResend(ok()).ok).toBe(true)
  })

  it('refuses when it is not', () => {
    const r = evaluateResend({ ...ok(), draftHookStale: true })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT)
  })

  it('is NOT overridable — this is about the message being wrong, not about timing', () => {
    /**
     * "I know something the agent does not" is a good argument about spacing. It is no
     * argument for telling a company we saw their placement "last week" when it was three
     * weeks ago, to the one team certain to know when they ran it.
     */
    expect(OVERRIDABLE_BLOCKS).not.toContain(RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT)
    const r = evaluateResend({
      ...ok(),
      draftHookStale: true,
      overrides: [RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT],
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT)
  })
})
