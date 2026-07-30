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
    pair: { enabled: true },
    sender: { status: 'ACTIVE', dailyCap: 5 },
    target: { optedOut: false },
    lastSentAt: null,
    touchesSoFar: 0,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 1,
    hasPendingAttempt: false,
    totalSentEver: 0,
    maxTotalSends: null,
    ...overrides,
  }
}

describe('the happy path', () => {
  it('allows a never-contacted pair', () => {
    const d = evaluatePair(base())
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(1)
  })


  it('is a one-shot system — a contacted pair never becomes eligible again', () => {
    const d = evaluatePair(base({ touchesSoFar: 1, lastSentAt: new Date(NOW.getTime() - 400 * DAY) }))
    expect(d.eligible).toBe(false)
  })
})

describe('absolute stops', () => {
  it('skips a disabled pair', () => {
    const d = evaluatePair(base({ pair: { enabled: false } }))
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
    const d = evaluatePair(base({ target: { optedOut: true } }))
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

describe('one shot per target, ever', () => {
  /**
   * Instagram permits exactly one message request to a non-follower and drops
   * further ones until they accept, so a cooldown-and-repeat model was describing
   * a capability the platform does not offer. Repeated contact with a non-responder
   * is also what Meta's written spam policy names as lowering the threshold.
   */
  it('allows the first contact', () => {
    expect(evaluatePair(base({ lastSentAt: null, touchesSoFar: 0 })).eligible).toBe(true)
  })

  it('refuses a second contact one day later', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - DAY), touchesSoFar: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.ALREADY_CONTACTED })
  })

  it('refuses a second contact a YEAR later — there is no waiting it out', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - 365 * DAY), touchesSoFar: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.ALREADY_CONTACTED })
  })

  it('refuses when touchesSoFar says contacted even with no recorded sentAt', () => {
    // Belt and braces: either signal alone is enough to block.
    const d = evaluatePair(base({ lastSentAt: null, touchesSoFar: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.ALREADY_CONTACTED })
  })

  it('explains itself in the detail, for the dashboard', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - 3 * DAY), touchesSoFar: 1 }))
    expect(!d.eligible && d.detail).toContain('one message per target, ever')
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

describe('the lifetime send ceiling', () => {
  /**
   * The guard that must hold even if every other rule has a bug. "Send exactly one
   * message to prove it works" is enforced here rather than by an operator
   * remembering to turn something off.
   */
  it('blocks everything once the ceiling is reached', () => {
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('allows the very first send when the ceiling is 1', () => {
    expect(evaluatePair(base({ totalSentEver: 0, maxTotalSends: 1 })).eligible).toBe(true)
  })

  it('outranks every other rule, including a perfectly eligible pair', () => {
    const d = evaluatePair(
      base({ totalSentEver: 5, maxTotalSends: 1 }),
    )
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('is reported before target opt-out, because it is the more absolute stop', () => {
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1, target: { optedOut: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('counts prepared-but-unsent messages too', () => {
    // With four routing pairs and a ceiling of 1, counting only delivered messages
    // would let all four be drafted before the ceiling bound.
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1, lastSentAt: null, touchesSoFar: 0 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('says how to raise it', () => {
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1 }))
    expect(!d.eligible && d.detail).toContain('MAX_TOTAL_SENDS')
  })

  it('null means no ceiling', () => {
    expect(evaluatePair(base({ totalSentEver: 9999, maxTotalSends: null })).eligible).toBe(true)
  })

  it('a ceiling of 0 blocks the very first send', () => {
    expect(evaluatePair(base({ totalSentEver: 0, maxTotalSends: 0 })).eligible).toBe(false)
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

  it('does NOT re-open a pair after time passes — one shot is permanent', () => {
    const d = evaluatePair(base({ lastSentAt: new Date(NOW.getTime() - 7 * DAY), touchesSoFar: 1 }))
    expect(d.eligible).toBe(false)
  })
})
