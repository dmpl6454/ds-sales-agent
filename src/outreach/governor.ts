/**
 * The cadence governor: decides whether a given sender→target pair may be
 * contacted right now.
 *
 * This is the single most important safety component in the system. The two
 * target channels post 12–18 paid campaigns a day between them; sending on every
 * detection would mean ~28 near-identical DMs a day into two inboxes, which trips
 * Meta's duplicate-content detection and the recipient's report button within
 * about 48 hours.
 *
 * So detections supply the *hook*, and this function sets the *rate*.
 *
 * Deliberately pure — no DB, no clock, no env. Every input is passed in, so every
 * rule (including the awkward boundaries) is unit-testable.
 */

export interface GovernorInput {
  now: Date

  pair: {
    enabled: boolean
    cooldownDays: number
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
  /** How many times this pair has been contacted. Drives touchNumber. */
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
}

export type GovernorDecision =
  | { eligible: true; touchNumber: number }
  | { eligible: false; reason: string; detail?: string }

/** Reason codes are stable strings so the dashboard can group and explain skips. */
export const SKIP_REASONS = {
  PAIR_DISABLED: 'pair-disabled',
  TARGET_OPTED_OUT: 'target-opted-out',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  TARGET_REPLIED: 'target-replied',
  PENDING_ATTEMPT: 'pending-attempt-exists',
  COOLDOWN_ACTIVE: 'cooldown-active',
  TARGET_DAILY_CAP: 'target-daily-cap',
  SENDER_DAILY_CAP: 'sender-daily-cap',
} as const

const MS_PER_DAY = 86_400_000

export function evaluatePair(input: GovernorInput): GovernorDecision {
  // Checks are ordered cheapest-and-most-absolute first, so the reason reported
  // is the most fundamental one rather than an incidental later rule.

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

  if (input.lastSentAt !== null) {
    const elapsedMs = input.now.getTime() - input.lastSentAt.getTime()
    const requiredMs = input.pair.cooldownDays * MS_PER_DAY
    if (elapsedMs < requiredMs) {
      const daysLeft = Math.ceil((requiredMs - elapsedMs) / MS_PER_DAY)
      return {
        eligible: false,
        reason: SKIP_REASONS.COOLDOWN_ACTIVE,
        detail: `${daysLeft}d remaining of ${input.pair.cooldownDays}d cooldown`,
      }
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
