/**
 * The safety gate: decides whether a given sender→target pair may be contacted now.
 *
 * Detections supply the *material* for a message; this decides whether sending one
 * is permitted. Multiple messages to the same target ARE allowed — a channel that
 * ran four paid campaigns this week gives four genuinely different reasons to
 * write. What is not allowed is repeating yourself.
 *
 * The rules, and where each comes from:
 *
 *   NEW MATERIAL REQUIRED — every follow-up must reference a campaign not used
 *   before for this pair. This is the load-bearing safety rule, and it is the one
 *   with a primary source: Meta's written spam policy states that repetitive
 *   content *lowers the frequency threshold at which restrictions are applied*.
 *   Fresh material is what makes a second message a new message rather than a
 *   repeat, so this permits volume and protects the account at the same time.
 *
 *   UNANSWERED TOUCH CAP — Instagram allows one *pending* message request to a
 *   non-follower until it is accepted; further requests are not delivered. So a
 *   follow-up before engagement may silently go nowhere. We allow a small number,
 *   spaced, then stop until they engage. (Corrected 2026-07-30: an earlier version
 *   read this as "one message per target, ever", which was wrong — the constraint
 *   is one message *pending*, and it lifts the moment they accept.)
 *
 *   COOLDOWN — minimum spacing between touches for a pair.
 *
 *   DAILY CAPS — per target and per sender. Practitioner figures put aged, healthy
 *   business accounts at 25-35 cold DMs/day; we operate at 1-2, so these are
 *   guard-rails with enormous headroom rather than binding limits.
 *
 *   LIFETIME CEILING — checked first, so "prove it with one message" is enforced
 *   here rather than by someone remembering to switch something off.
 *
 * Deliberately pure — no DB, no clock, no env. Every input is passed in, so every
 * rule (including the awkward boundaries) is unit-testable.
 */

export interface GovernorInput {
  now: Date

  pair: {
    /** Minimum days between touches for this pair. */
    cooldownDays: number
    /**
     * How many unanswered messages we will send before stopping until the target
     * engages. Instagram will not deliver a second pending request to a
     * non-follower, so beyond a couple these are likely wasted rather than risky.
     */
    maxUnansweredTouches: number
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
   * Last successful send to this TARGET from ANY of our pages. Sender-blind, and the
   * one spacing fact that is: MEASURED 2026-08-17, @absolutejk heard from two of our
   * pages twenty-nine minutes apart because every rule here was per pair, a second
   * page's message counted as a fresh first touch, and rotation deliberately elects
   * the next page for the next touch. The recipient's inbox does not care which of
   * our pages a message came from, so neither may the spacing.
   */
  targetLastDeliveredAt: Date | null
  /**
   * How many times this pair has been contacted.
   *
   * For a cold target this can only ever be 0 or 1 — see ALREADY_CONTACTED below.
   */
  touchesSoFar: number

  /** Any reply from this target, to ANY of our senders. Halts everything. */
  targetRepliedAt: Date | null
  /**
   * Detected campaigns for this target that have NOT yet been used as the hook for
   * this pair. Zero means we have nothing new to say — and saying the same thing
   * again is the single behaviour Meta's policy penalises most.
   */
  unusedCampaignCount: number
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
  TARGET_OPTED_OUT: 'target-opted-out',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  TARGET_REPLIED: 'target-replied',
  PENDING_ATTEMPT: 'pending-attempt-exists',
  COOLDOWN_ACTIVE: 'cooldown-active',
  TARGET_RECENTLY_CONTACTED: 'target-recently-contacted',
  NO_NEW_MATERIAL: 'no-new-material-to-reference',
  UNANSWERED_LIMIT: 'unanswered-touch-limit',
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

  /**
   * PAIR_DISABLED IS GONE — one switch, Tabish 2026-08-08.
   *
   * A per-route on/off used to sit here, and `OutreachPair.enabled` was how "adding a
   * prospect is never the same act as messaging them" was enforced. Tabish removed the
   * subordinate switches: *"The moment autopilot is turned on there must be no more
   * switches."* Routes are no longer chosen — they exist, created for every fleet sender ×
   * every messageable target by `ensureFleetPairs` in plan.ts.
   *
   * This widens exposure, so what replaced it is worth naming rather than assuming:
   * RETIREMENT is `target.optedOut`, checked immediately below and derived from the TARGET
   * rather than from a pair row, so it cannot be lost by a pair being recreated. Keeping the
   * burner out of automatic outreach is `SenderAccount.fleetMember`, which is identity
   * rather than a switch and which no UI toggles. Everything else that bounded volume —
   * cooldown, the unanswered-touch cap, both daily caps, the lifetime ceiling, rotation, the
   * persona gate, the cohort ladder, active hours, the fleet gap and allowance, the breaker
   * — is untouched and every one of them is still below or in the dispatcher.
   *
   * A missing pair row is NOT a stop any more. That is the point: it was a stop that a
   * forgotten chip could apply silently, which is the same "nothing happened with no
   * explanation" failure this file's reason codes exist to prevent.
   */

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
      detail: `replied at ${input.targetRepliedAt.toISOString()} — paused for a day, then resumes`,
    }
  }

  // Never stack two unsent messages for the same pair. In manual mode an
  // un-tapped attempt from yesterday must not become a queue of five.
  if (input.hasPendingAttempt) {
    return { eligible: false, reason: SKIP_REASONS.PENDING_ATTEMPT }
  }

  // Stop after a few unanswered touches. Instagram does not deliver a second
  // pending request to a non-follower, so past a couple these are wasted; and
  // continuing to contact someone who has never responded is what Meta's policy
  // describes as repeated unwanted contact.
  if (input.touchesSoFar >= input.pair.maxUnansweredTouches) {
    return {
      eligible: false,
      reason: SKIP_REASONS.UNANSWERED_LIMIT,
      detail: `${input.touchesSoFar} message(s) sent with no reply (limit ${input.pair.maxUnansweredTouches}) — waiting for them to engage`,
    }
  }

  // Spacing between touches.
  if (input.lastSentAt !== null) {
    const elapsedMs = input.now.getTime() - input.lastSentAt.getTime()
    const requiredMs = input.pair.cooldownDays * MS_PER_DAY
    if (elapsedMs < requiredMs) {
      const daysLeft = Math.ceil((requiredMs - elapsedMs) / MS_PER_DAY)
      return {
        eligible: false,
        reason: SKIP_REASONS.COOLDOWN_ACTIVE,
        detail: `${daysLeft}d of ${input.pair.cooldownDays}d spacing remaining`,
      }
    }
  }

  // And spacing for the RECIPIENT, whichever page reached them — the rule the duplicate
  // incident of 2026-08-17 proved missing. Same window as the pair cooldown, so one
  // number governs both and neither can be loosened without the other.
  if (input.targetLastDeliveredAt != null) {
    const elapsedMs = input.now.getTime() - input.targetLastDeliveredAt.getTime()
    const requiredMs = input.pair.cooldownDays * MS_PER_DAY
    if (elapsedMs < requiredMs) {
      const daysLeft = Math.ceil((requiredMs - elapsedMs) / MS_PER_DAY)
      return {
        eligible: false,
        reason: SKIP_REASONS.TARGET_RECENTLY_CONTACTED,
        detail: `another of our pages wrote to them ${Math.max(1, Math.round(elapsedMs / 3_600_000))}h ago — ${daysLeft}d of recipient spacing remaining`,
      }
    }
  }

  // THE important rule. A follow-up must have something new to say — a campaign we
  // have not written about before for this pair. Without this, a second message is
  // a repeat, and repetition is precisely what lowers the enforcement threshold.
  // With it, four paid campaigns legitimately support four different messages.
  if (input.touchesSoFar > 0 && input.unusedCampaignCount === 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.NO_NEW_MATERIAL,
      detail: 'nothing new to reference since the last message — waiting for a fresh campaign',
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
