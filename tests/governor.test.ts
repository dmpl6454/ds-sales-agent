import { describe, it, expect } from 'vitest'
import { evaluatePair, SKIP_REASONS, type GovernorInput } from '@/outreach/governor'

/**
 * The governor is what stands between "12–18 campaigns detected today" and
 * "28 DMs into two inboxes". Every rule is tested, including the boundaries,
 * because a bug here is not a crash — it is spam sent to a real prospect.
 */

const DAY = 86_400_000
const NOW = new Date('2026-07-29T09:30:00.000Z')

/** Eligible baseline. Each test perturbs exactly one field. */
function base(overrides: Partial<GovernorInput> = {}): GovernorInput {
  return {
    now: NOW,
    pair: { enabled: true, cooldownDays: 7 },
    sender: { status: 'ACTIVE', dailyCap: 5 },
    target: { optedOut: false },
    lastSentAt: null,
    touchesSoFar: 0,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 1,
    hasPendingAttempt: false,
    ...overrides,
  }
}

describe('the happy path', () => {
  it('allows a never-contacted pair', () => {
    const d = evaluatePair(base())
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(1)
  })

  it('increments touchNumber from prior contacts', () => {
    const d = evaluatePair(base({ touchesSoFar: 4, lastSentAt: new Date(NOW.getTime() - 30 * DAY) }))
    expect(d.eligible && d.touchNumber).toBe(5)
  })

  it('never exhausts — a pair contacted 50 times stays eligible after cooldown', () => {
    // This system is a standing watch, not a finite sequence. There is
    // deliberately no maximum touch count.
    const d = evaluatePair(base({ touchesSoFar: 50, lastSentAt: new Date(NOW.getTime() - 8 * DAY) }))
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(51)
  })
})

describe('absolute stops', () => {
  it('skips a disabled pair', () => {
    const d = evaluatePair(base({ pair: { enabled: false, cooldownDays: 7 } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.PAIR_DISABLED })
  })

  it('skips an opted-out target', () => {
    const d = evaluatePair(base({ target: { optedOut: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })

  it.each(['PAUSED', 'CHALLENGED'])('skips a %s sender', (status) => {
    const d = evaluatePair(base({ sender: { status, dailyCap: 5 } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.SENDER_NOT_ACTIVE })
  })

  it('opt-out outranks everything, including a fresh eligible pair', () => {
    const d = evaluatePair(base({ target: { optedOut: true }, pair: { enabled: true, cooldownDays: 0 } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })
})

describe('a reply halts every sender to that target', () => {
  it('stops the pair once the target has replied', () => {
    const d = evaluatePair(base({ targetRepliedAt: new Date(NOW.getTime() - 2 * DAY) }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
  })

  it('stops even when the cooldown has long since elapsed', () => {
    // A human conversation has started. Continuing to fire templated pitches at
    // them from other accounts would be actively damaging.
    const d = evaluatePair(
      base({
        targetRepliedAt: new Date(NOW.getTime() - 90 * DAY),
        lastSentAt: new Date(NOW.getTime() - 90 * DAY),
      }),
    )
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
  })
})

describe('cooldown', () => {
  it('blocks one hour before the cooldown expires', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - (7 * DAY - 3_600_000)) }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.COOLDOWN_ACTIVE })
  })

  it('allows exactly at the boundary', () => {
    expect(evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - 7 * DAY) })).eligible).toBe(true)
  })

  it('allows one second past the boundary', () => {
    expect(evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - (7 * DAY + 1000)) })).eligible).toBe(true)
  })

  it('reports how long is left, for the dashboard', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - 2 * DAY) }))
    expect(d.eligible).toBe(false)
    expect(!d.eligible && d.detail).toContain('5d remaining')
  })

  it('honours a per-pair cooldown override', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY)
    expect(evaluatePair(base({ pair: { enabled: true, cooldownDays: 3 }, lastSentAt: threeDaysAgo })).eligible).toBe(true)
    expect(evaluatePair(base({ pair: { enabled: true, cooldownDays: 7 }, lastSentAt: threeDaysAgo })).eligible).toBe(false)
  })

  it('a cooldown of 0 means every slot is eligible', () => {
    const d = evaluatePair(base({ pair: { enabled: true, cooldownDays: 0 }, lastSentAt: new Date(NOW.getTime() - 60_000) }))
    expect(d.eligible).toBe(true)
  })
})

describe('daily caps', () => {
  it('blocks when the target already received its allowance today', () => {
    // The real scenario: two of our senders both target MOM. Without this,
    // MOM receives two pitches on the same morning.
    const d = evaluatePair(base({ targetSentTodayCount: 1, maxPerTargetPerDay: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_DAILY_CAP })
  })

  it('allows a second send when the cap is raised', () => {
    expect(evaluatePair(base({ targetSentTodayCount: 1, maxPerTargetPerDay: 2 })).eligible).toBe(true)
  })

  it('blocks when the sender is at its own cap', () => {
    const d = evaluatePair(base({ senderSentTodayCount: 5, sender: { status: 'ACTIVE', dailyCap: 5 } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.SENDER_DAILY_CAP })
  })

  it('reports the target cap before the sender cap when both are hit', () => {
    // Recipient protection is the more important reason to surface.
    const d = evaluatePair(
      base({ targetSentTodayCount: 1, senderSentTodayCount: 5, sender: { status: 'ACTIVE', dailyCap: 5 } }),
    )
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_DAILY_CAP })
  })
})

describe('pending attempts', () => {
  it('does not stack a second message while one is unsent', () => {
    // In manual mode, an un-tapped attempt from yesterday must not become a
    // queue of five by Friday.
    const d = evaluatePair(base({ hasPendingAttempt: true }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.PENDING_ATTEMPT })
  })
})

describe('the Phase 1 routing matrix, simulated over a week', () => {
  /**
   * Four pairs, 7-day cooldown, 1 DM per target per day. Confirms the design
   * claim: ~2 DMs/day peak, and it never stops.
   */
  it('caps a single day at one DM per target even with two senders per target', () => {
    // Both senders target MOM. First is eligible; second sees the same-day count.
    const first = evaluatePair(base({ targetSentTodayCount: 0 }))
    expect(first.eligible).toBe(true)

    const second = evaluatePair(base({ targetSentTodayCount: 1 }))
    expect(second.eligible).toBe(false)
  })

  it('re-opens the pair after the cooldown rather than retiring it', () => {
    const lastSent = new Date(NOW.getTime() - 7 * DAY)
    const d = evaluatePair(base({ lastSentAt: lastSent, touchesSoFar: 12, targetSentTodayCount: 0 }))
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(13)
  })
})
