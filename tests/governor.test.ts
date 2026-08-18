import { describe, it, expect } from 'vitest'
import { evaluatePair, SKIP_REASONS, type GovernorInput } from '@/outreach/governor'

/**
 * The governor is what stands between "12–18 campaigns detected today" and
 * "28 DMs into two inboxes". Every rule is tested, including the boundaries,
 * because a bug here is not a crash — it is spam sent to a real prospect.
 *
 * ── 2026-08-18: THE CAPS WERE REMOVED ON TABISH'S INSTRUCTION ──────────────
 * The cooldown, the unanswered-touch limit and the target/sender daily caps are
 * gone ("Remove all caps … rest unlimited"). What survives is his one rule —
 * five per day from one account to one recipient — plus everything that was
 * never a volume cap: opt-out, sender status, the reply halt, the pending-attempt
 * check, the new-material rule and the lifetime ceiling.
 */

const DAY = 86_400_000
const NOW = new Date('2026-07-29T09:30:00.000Z')

/** Eligible baseline. Each test perturbs exactly one field. */
function base(overrides: Partial<GovernorInput> = {}): GovernorInput {
  return {
    now: NOW,
    sender: { status: 'ACTIVE' },
    target: { optedOut: false },
    touchesSoFar: 0,
    targetRepliedAt: null,
    unusedCampaignCount: 2,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
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

  it('allows a follow-up when there is fresh material', () => {
    const d = evaluatePair(base({ touchesSoFar: 1, unusedCampaignCount: 3 }))
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(2)
  })
})

describe('absolute stops', () => {
  /**
   * There is no "skips a disabled pair" test any more. PAIR_DISABLED was removed with the
   * per-route switch (one switch, Tabish 2026-08-08) — routes are not chosen, they exist,
   * so there is no per-route "off" left for the governor to report. The stop that carries
   * retirement is the next one: `target.optedOut`, which lives on the TARGET and therefore
   * cannot be lost by a pair row being recreated automatically.
   */
  it('skips an opted-out target', () => {
    const d = evaluatePair(base({ target: { optedOut: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })

  it.each(['PAUSED', 'CHALLENGED'])('skips a %s sender', (status) => {
    const d = evaluatePair(base({ sender: { status } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.SENDER_NOT_ACTIVE })
  })

  it('opt-out outranks everything, including a fresh eligible pair', () => {
    const d = evaluatePair(base({ target: { optedOut: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })
})

describe('a reply halts every sender to that target', () => {
  it('stops the pair once the target has replied', () => {
    const d = evaluatePair(base({ targetRepliedAt: new Date(NOW.getTime() - DAY) }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
  })

  it('names the two-day pause in its detail', () => {
    // Tabish's "cooldown if conversation is ongoing" number: a reply pauses its
    // target for two days, then messaging resumes on its own.
    const d = evaluatePair(base({ targetRepliedAt: new Date(NOW.getTime() - DAY) }))
    expect(!d.eligible && d.detail).toContain('two days')
  })

  it('stops even when the pair itself has plenty of allowance left', () => {
    // A human conversation has started. Continuing to fire templated pitches at
    // them from other accounts would be actively damaging.
    const d = evaluatePair(
      base({ targetRepliedAt: new Date(NOW.getTime() - DAY), pairSentTodayCount: 0, maxPerPairPerDay: 5 }),
    )
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
  })
})

describe('multiple touches, but only with something new to say', () => {
  /**
   * Corrected 2026-07-30. An earlier version locked a pair permanently after one
   * message, on the mistaken reading that Instagram allows "one message per target,
   * ever". The real constraint is one message *pending* to a non-follower, which
   * lifts when they accept — so a channel that ran four paid campaigns supports
   * four genuinely different messages.
   *
   * What actually protects the account is that each follow-up must reference a
   * campaign not used before: Meta's written policy penalises repetition, not
   * volume, and fresh material is what makes a second message a new one. With the
   * spacing caps gone (2026-08-18) this rule carries MORE weight, not less — it is
   * what stops the planner re-drafting the identical template every day forever.
   */
  it('allows the first contact', () => {
    expect(evaluatePair(base({ touchesSoFar: 0 })).eligible).toBe(true)
  })

  it('allows a follow-up when there is new material', () => {
    const d = evaluatePair(base({ touchesSoFar: 1, unusedCampaignCount: 1 }))
    expect(d.eligible).toBe(true)
    expect(d.eligible && d.touchNumber).toBe(2)
  })

  it('refuses a follow-up with NOTHING new to say — the repetition rule', () => {
    const d = evaluatePair(base({ touchesSoFar: 1, unusedCampaignCount: 0 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.NO_NEW_MATERIAL })
  })

  it('does not apply the new-material rule to the FIRST message', () => {
    // A first approach is legitimate even on a quiet week.
    expect(evaluatePair(base({ touchesSoFar: 0, unusedCampaignCount: 0 })).eligible).toBe(true)
  })

  it('supports four messages for a channel that ran four campaigns', () => {
    // The scenario the one-shot rule got wrong.
    for (const touch of [1, 2, 3, 4]) {
      const d = evaluatePair(base({ touchesSoFar: touch - 1, unusedCampaignCount: 5 - touch }))
      expect(d.eligible, `touch ${touch}`).toBe(true)
    }
  })
})

describe('the pair daily cap — the one volume rule left  [2026-08-18]', () => {
  it('refuses the sixth message from one account to one recipient in a day', () => {
    const d = evaluatePair(base({ pairSentTodayCount: 5, maxPerPairPerDay: 5 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.PAIR_DAILY_CAP })
  })

  it('permits while allowance remains — 4 of 5 leaves room', () => {
    expect(evaluatePair(base({ pairSentTodayCount: 4, maxPerPairPerDay: 5 })).eligible).toBe(true)
  })

  it('is counted per PAIR: a different account to the same recipient starts at zero', () => {
    // Rotation may point several of our pages at one recipient; each page carries
    // its own allowance of five. This fixture is the other page's pair.
    expect(evaluatePair(base({ pairSentTodayCount: 0, maxPerPairPerDay: 5 })).eligible).toBe(true)
  })

  it('a reply is reported ahead of the cap, because it is the more absolute stop', () => {
    const d = evaluatePair(
      base({ targetRepliedAt: new Date(NOW.getTime() - DAY), pairSentTodayCount: 9, maxPerPairPerDay: 5 }),
    )
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
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
    const d = evaluatePair(base({ totalSentEver: 5, maxTotalSends: 1 }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('is reported before target opt-out, because it is the more absolute stop', () => {
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1, target: { optedOut: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.LIFETIME_CAP })
  })

  it('counts prepared-but-unsent messages too', () => {
    // With four routing pairs and a ceiling of 1, counting only delivered messages
    // would let all four be drafted before the ceiling bound.
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1, touchesSoFar: 0 }))
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
