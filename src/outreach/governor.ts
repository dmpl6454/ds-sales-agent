/**
 * The safety gate: decides whether a given sender→target pair may be contacted.
 *
 * The channels post dozens of commercial posts a day between them. Detections
 * supply the *material* for a message; this function decides whether one is
 * permitted at all — and the answer is usually no, by design.
 *
 * Two rules do most of the work, and both come from Instagram's actual behaviour
 * rather than from a number someone picked:
 *
 *   ONE SHOT PER TARGET — Instagram allows exactly one message request to a
 *   non-follower, text-only, and drops further ones until they accept. Repeated
 *   contact with a non-responder is also the specific behaviour Meta's written
 *   spam policy names as lowering the enforcement threshold.
 *
 *   LIFETIME CEILING — a hard cap on messages ever sent, checked before anything
 *   else, so "prove it works with one message" is enforced here rather than by
 *   someone remembering to switch something off.
 *
 * Deliberately pure — no DB, no clock, no env. Every input is passed in, so every
 * rule (including the awkward boundaries) is unit-testable.
 */

export interface GovernorInput {
  now: Date

  pair: {
    enabled: boolean
  }
  sender: {
    status: string // ACTIVE | PAUSED | CHALLENGED
    dailyCap: number
  }
  target: {
    optedOut: boolean
  }

  /** Last successful send for THIS pair. null = never contacted. */
  lastSentAt: Date | null
  /**
   * How many times this pair has been contacted.
   *
   * For a cold target this can only ever be 0 or 1 — see ALREADY_CONTACTED below.
   */
  touchesSoFar: number

  /** Any reply from this target, to ANY of our senders. Halts everything. */
  targetRepliedAt: Date | null
  /** Sends to this target today (IST), across all senders. */
  targetSentTodayCount: number
  /** Sends by this sender today (IST), across all targets. */
  senderSentTodayCount: number

  /** Global cap on how many DMs one target may receive per IST day. */
  maxPerTargetPerDay: number

  /** True when an attempt for this pair is already waiting to be sent. */
  hasPendingAttempt: boolean

  /**
   * Total messages this system has ever put IN FLIGHT — sent, replied, or sitting
   * prepared and waiting for a human. Counting prepared-but-unsent matters: with a
   * ceiling of 1 and four routing pairs, counting only delivered messages would
   * prepare four at once and the ceiling would bind after the damage was drafted.
   */
  totalSentEver: number
  /**
   * Hard lifetime ceiling. `null` means no ceiling.
   *
   * This exists because "prove it works by sending exactly one message" needs to
   * be enforced by the safety layer, not by an operator remembering to turn
   * something off. Set to 1, no combination of cooldown, cap, or scheduling bugs
   * can produce a second message. Raising it is a deliberate, visible act.
   */
  maxTotalSends: number | null
}

export type GovernorDecision =
  | { eligible: true; touchNumber: number }
  | { eligible: false; reason: string; detail?: string }

/** Reason codes are stable strings so the dashboard can group and explain skips. */
export const SKIP_REASONS = {
  LIFETIME_CAP: 'lifetime-send-cap-reached',
  PAIR_DISABLED: 'pair-disabled',
  TARGET_OPTED_OUT: 'target-opted-out',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  TARGET_REPLIED: 'target-replied',
  PENDING_ATTEMPT: 'pending-attempt-exists',
  ALREADY_CONTACTED: 'already-contacted-one-shot',
  TARGET_DAILY_CAP: 'target-daily-cap',
  SENDER_DAILY_CAP: 'sender-daily-cap',
} as const

const MS_PER_DAY = 86_400_000

export function evaluatePair(input: GovernorInput): GovernorDecision {
  // Checks are ordered cheapest-and-most-absolute first, so the reason reported
  // is the most fundamental one rather than an incidental later rule.

  // The lifetime ceiling is checked before anything else, because it is the one
  // guard that must hold even if every other rule has a bug.
  if (input.maxTotalSends !== null && input.totalSentEver >= input.maxTotalSends) {
    return {
      eligible: false,
      reason: SKIP_REASONS.LIFETIME_CAP,
      detail: `${input.totalSentEver} of ${input.maxTotalSends} lifetime messages used (sent or awaiting send) — raise MAX_TOTAL_SENDS to continue`,
    }
  }

  if (!input.pair.enabled) {
    return { eligible: false, reason: SKIP_REASONS.PAIR_DISABLED }
  }

  if (input.target.optedOut) {
    return { eligible: false, reason: SKIP_REASONS.TARGET_OPTED_OUT }
  }

  if (input.sender.status !== 'ACTIVE') {
    return {
      eligible: false,
      reason: SKIP_REASONS.SENDER_NOT_ACTIVE,
      detail: `sender status is ${input.sender.status}`,
    }
  }

  // A reply means a human conversation has started. Continuing to fire templated
  // pitches at them from three accounts would be actively damaging, so this
  // halts every sender to this target — not just the one that got the reply.
  if (input.targetRepliedAt !== null) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_REPLIED,
      detail: `replied at ${input.targetRepliedAt.toISOString()}`,
    }
  }

  // Never stack two unsent messages for the same pair. In manual mode an
  // un-tapped attempt from yesterday must not become a queue of five.
  if (input.hasPendingAttempt) {
    return { eligible: false, reason: SKIP_REASONS.PENDING_ATTEMPT }
  }

  // ONE SHOT, EVER.
  //
  // Instagram permits exactly one message request to someone who does not follow
  // you, and it is text-only; until they accept, a second request cannot be
  // delivered. A cooldown-and-repeat cadence was therefore modelling a capability
  // the platform does not offer — it would have shown touch counts and countdowns
  // that meant nothing while the platform silently dropped the messages.
  //
  // Meta's written spam policy also makes repeated contact with someone who has
  // not responded the specific behaviour that lowers the enforcement threshold. So
  // this is both the platform's hard constraint and the safer rule.
  if (input.lastSentAt !== null || input.touchesSoFar > 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.ALREADY_CONTACTED,
      detail: input.lastSentAt
        ? `contacted ${Math.floor((input.now.getTime() - input.lastSentAt.getTime()) / MS_PER_DAY)}d ago — one message per target, ever`
        : 'already contacted — one message per target, ever',
    }
  }

  // Guards the recipient, not us. Two of our senders both target MOM; without
  // this, MOM would receive two pitches on the same morning.
  if (input.targetSentTodayCount >= input.maxPerTargetPerDay) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_DAILY_CAP,
      detail: `target already received ${input.targetSentTodayCount} today (cap ${input.maxPerTargetPerDay})`,
    }
  }

  if (input.senderSentTodayCount >= input.sender.dailyCap) {
    return {
      eligible: false,
      reason: SKIP_REASONS.SENDER_DAILY_CAP,
      detail: `sender already sent ${input.senderSentTodayCount} today (cap ${input.sender.dailyCap})`,
    }
  }

  return { eligible: true, touchNumber: input.touchesSoFar + 1 }
}
