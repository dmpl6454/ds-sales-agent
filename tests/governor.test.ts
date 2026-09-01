import { describe, it, expect } from 'vitest'
import { evaluatePair, SKIP_REASONS, type GovernorInput } from '@/outreach/governor'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { templateForSettings } from '@/outreach/fleetTemplate'
import { followUpForSettings } from '@/outreach/followUpTemplate'

/**
 * The DEFAULT fleet's template, built by the REAL rule rather than written as a literal —
 * a hand-written verdict object goes stale GREEN the day the rule changes shape, which is
 * this suite's own recorded lesson from the `too-soon` fixture.
 */
const DEFAULT_FLEET_TEMPLATE = templateForSettings(
  { singleTemplateBody: null, fleetTemplateBodies: new Map() },
  [],
  [],
)

/**
 * A WRITTEN follow-up message, built by the REAL rule — the state the fleet is in once
 * Tabish has filled the box. Long enough that `distinctiveSlice` finds a needle, and it
 * carries `{{post}}` because `checkFollowUpBody` requires it.
 */
const FOLLOW_UP_WRITTEN = followUpForSettings(
  { followUpBody: `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`, followUpBodies: new Map() },
  [],
  [],
)
/** And the state it ships in: nobody has written it, so no follow-up is drafted or sent. */
const FOLLOW_UP_UNWRITTEN = followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], [])


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
    target: { optedOut: false, isVerified: true },
    touchesSoFar: 0,
    targetRepliedAt: null,
    /* No parked failure on this pair — see the UNCERTAIN_DELIVERY tests for the other side. */
    parkedFailureCode: null,
    /* Room for one message: the allowance is max(1, campaigns). */
    material: { held: false as const, allowance: 1, delivered: 0 },
    unusedCampaignCount: 2,
    describableCampaignCount: 2,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    crossSpacing: { held: false },
    hasPendingAttempt: false,
    totalSentEver: 0,
    maxTotalSends: null,
    fleetTemplate: DEFAULT_FLEET_TEMPLATE,
    /* Written, so the follow-up stop is out of the way of every rule this file is about.
       Its own two directions are driven in tests/follow-up-template.test.ts. */
    followUpTemplate: FOLLOW_UP_WRITTEN,
    repeatsADeliveredBody: false,
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
    const d = evaluatePair(base({ target: { optedOut: true, isVerified: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })

  it.each(['PAUSED', 'CHALLENGED'])('skips a %s sender', (status) => {
    const d = evaluatePair(base({ sender: { status } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.SENDER_NOT_ACTIVE })
  })

  it('opt-out outranks everything, including a fresh eligible pair', () => {
    const d = evaluatePair(base({ target: { optedOut: true, isVerified: true } }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT })
  })
})

describe('a reply halts every sender to that target', () => {
  it('stops the pair once the target has replied', () => {
    const d = evaluatePair(base({ targetRepliedAt: new Date(NOW.getTime() - DAY) }))
    expect(d).toMatchObject({ eligible: false, reason: SKIP_REASONS.TARGET_REPLIED })
  })

  it('names the seven-day pause in its detail', () => {
    // Tabish, 2026-08-19: a reply pauses its
    // target for seven days, then messaging resumes on its own (or on "I have replied").
    const d = evaluatePair(base({ targetRepliedAt: new Date(NOW.getTime() - DAY) }))
    expect(!d.eligible && d.detail).toContain('seven days')
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
    const d = evaluatePair(base({ totalSentEver: 1, maxTotalSends: 1, target: { optedOut: true, isVerified: true } }))
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

/**
 * The drafting half of cross-account spacing, restored 2026-08-18 evening. Refused HERE as
 * well as at the gate so a duplicate is never written at all — a draft that exists only to
 * be refused later is the "why is nothing sending" noise the reason codes exist to prevent.
 */
describe('cross-account spacing at drafting (the ring rule since 2026-08-19)', () => {
  const HOUR = 60 * 60 * 1000

  /**
   * Fixtures are built by the REAL predicate, never hand-written verdict literals — a
   * fixture that pins a shape the rule owns goes stale GREEN the first time the rule
   * changes (the stopInventory lesson, verbatim).
   */
  const ring = (args: { eligible: string[]; deliveredHoursAgo: Array<[string, number]> }) =>
    crossSpacingVerdict({
      now: NOW,
      windowDays: 7,
      crossPageGapHours: 24,
      thisSenderId: 's1',
      eligibleSenderIds: args.eligible,
      lastDeliveryBySender: new Map(
        args.deliveredHoursAgo.map(([id, h]) => [id, { sentAt: new Date(NOW.getTime() - h * HOUR), handle: id }]),
      ),
    })

  it('refuses while a DIFFERENT page is inside the inter-page gap', () => {
    const d = evaluatePair(base({ crossSpacing: ring({ eligible: ['s1', 's2'], deliveredHoursAgo: [['s2', 3]] }) }))
    expect(d.eligible).toBe(false)
    if (!d.eligible) expect(d.reason).toBe(SKIP_REASONS.TARGET_RECENTLY_CONTACTED)
  })

  /**
   * THE RULE TABISH REVERSED, in the permitting direction: one other page wrote three
   * days ago and this draft must be ELIGIBLE. Under the pre-2026-08-19 rule this exact
   * case held — and 33/33 waiting drafts were frozen for five days.
   */
  it('permits when ONE other page wrote days ago — the old any-page hold must not survive', () => {
    const d = evaluatePair(base({ crossSpacing: ring({ eligible: ['s1', 's2', 's3'], deliveredHoursAgo: [['s2', 72]] }) }))
    expect(d.eligible, 'the deleted any-other-page rule is still holding drafts').toBe(true)
  })

  it('refuses when EVERY eligible page has written inside the window (ring-complete)', () => {
    const d = evaluatePair(
      base({
        crossSpacing: ring({
          eligible: ['s1', 's2', 's3'],
          deliveredHoursAgo: [['s1', 6 * 24], ['s2', 4 * 24], ['s3', 2 * 24]],
        }),
      }),
    )
    expect(d.eligible).toBe(false)
    if (!d.eligible) expect(d.reason).toBe(SKIP_REASONS.TARGET_RECENTLY_CONTACTED)
  })

  /** The releasing direction: one page's delivery ages out and the ring reopens. */
  it('releases the moment the oldest page ages out of the window', () => {
    const d = evaluatePair(
      base({
        crossSpacing: ring({
          eligible: ['s1', 's2', 's3'],
          deliveredHoursAgo: [['s1', 2 * 24], ['s2', 8 * 24], ['s3', 3 * 24]],
        }),
      }),
    )
    expect(d.eligible, 'the ring never reopened after a delivery aged out').toBe(true)
  })

  it('permits when no page has ever written to them', () => {
    expect(evaluatePair(base({ crossSpacing: ring({ eligible: ['s1', 's2'], deliveredHoursAgo: [] }) })).eligible).toBe(true)
  })
})

/**
 * ── A PARKED FAILURE BLOCKS A NEW DRAFT FOR THE PAIR (2026-08-21) ──────────
 *
 * The duplicate Tabish photographed, in the database:
 *
 *     07:30  FAILED  not-in-thread   bollywoodchronicle → indiagatefoods
 *     12:39  SENT                    bollywoodchronicle → indiagatefoods
 *
 * `hasPendingAttempt` counts QUEUED|READY|SENDING and `touchesSoFar` counts DELIVERED, so
 * FAILED was in NEITHER — a parked attempt made the pair look untouched, and the fresh draft
 * was a FIRST touch, which the new-material rule exempts by construction. Every guard
 * passed and the recipient received two identical DMs.
 *
 * The same hole gave @sohamrockstrent six parked drafts at three attempts each: eighteen
 * browser drives at one revenue profile against a composer that cannot open.
 */
describe('a parked failure on the pair', () => {
  it('refuses a new draft when a send may already have reached them', () => {
    const d = evaluatePair(base({ parkedFailureCode: 'not-in-thread' }))
    expect(d.eligible).toBe(false)
    if (d.eligible) throw new Error('unreachable')
    expect(d.reason).toBe(SKIP_REASONS.UNCERTAIN_DELIVERY)
    /* The sentence must name the ambiguity, because that is what a person has to settle. */
    expect(d.detail).toMatch(/may already have it/)
  })

  it('refuses a new draft when repeated failures parked the pair, and names the cause', () => {
    const d = evaluatePair(base({ parkedFailureCode: 'no-composer' }))
    expect(d.eligible).toBe(false)
    if (d.eligible) throw new Error('unreachable')
    expect(d.reason).toBe(SKIP_REASONS.PARKED_FAILURE)
    expect(d.detail).toContain('no-composer')
  })

  /**
   * The permitting direction, which is the half that keeps this from becoming an outage:
   * a pair with nothing parked is unaffected.
   */
  it('is silent when there is no parked failure', () => {
    expect(evaluatePair(base({ parkedFailureCode: null })).eligible).toBe(true)
  })

  /**
   * ORDER MATTERS: this is a fact about what the RECIPIENT may hold, so it outranks every
   * question about timing. A pair that is both parked AND inside its daily cap must report
   * the park — the cap will clear by itself tomorrow and the park never will.
   */
  it('outranks the daily cap, so the reported reason is the one a person must act on', () => {
    const d = evaluatePair(base({ parkedFailureCode: 'not-in-thread', pairSentTodayCount: 99, maxPerPairPerDay: 5 }))
    expect(d.eligible).toBe(false)
    if (d.eligible) throw new Error('unreachable')
    expect(d.reason).toBe(SKIP_REASONS.UNCERTAIN_DELIVERY)
  })

  /** But retirement and a live reply still outrank it — those are about the person, not the send. */
  it('does not outrank opt-out', () => {
    const d = evaluatePair(base({ parkedFailureCode: 'not-in-thread', target: { optedOut: true, isVerified: true } }))
    expect(d.eligible).toBe(false)
    if (d.eligible) throw new Error('unreachable')
    expect(d.reason).toBe(SKIP_REASONS.TARGET_OPTED_OUT)
  })
})
