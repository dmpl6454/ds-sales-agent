/**
 * The safety gate: decides whether a given sender→target pair may be contacted now.
 *
 * Detections supply the *material* for a message; this decides whether sending one
 * is permitted.
 *
 * ── 2026-08-18: THE CAPS WERE REMOVED ON TABISH'S INSTRUCTION ──────────────
 *
 * *"there must be only a limit of say 5 messages per target per same account in a day
 * … rest unlimited. Remove all caps."* The rules that were removed that day: the
 * 7-day per-pair cooldown, the sender-blind recipient spacing window, the
 * unanswered-touch cap, the cross-sender per-recipient daily cap and the per-sender
 * daily cap. The risk was stated to him plainly (hundreds of near-identical cold DMs
 * a day is the documented ban pattern) and the call recorded as his.
 *
 * What survives here, and why:
 *
 *   PAIR DAILY CAP — exactly his rule: one account may send one recipient at most
 *   five messages per IST day. Counted per pair, because rotation may point several
 *   of our pages at one recipient and each carries its own allowance.
 *
 *   NEW MATERIAL REQUIRED — every follow-up must reference a campaign not used
 *   before for this pair. This is not a volume cap: it is what stops the planner
 *   re-drafting the identical template to an unresponsive recipient every day
 *   forever, which is the repetition Meta's written spam policy penalises most.
 *
 *   TARGET_REPLIED — a live conversation halts automated messages for
 *   `replyResumeHours` (seven days since 2026-08-19, Tabish's "resume after 7 days").
 *
 *   OPT-OUT, SENDER STATUS, PENDING ATTEMPT, LIFETIME CEILING — retirement,
 *   checkpoint safety, idempotency and the env floor. None of these are volume caps.
 *
 * Deliberately pure — no DB, no clock, no env. Every input is passed in, so every
 * rule (including the awkward boundaries) is unit-testable.
 */

import { crossSpacingDetail, type CrossSpacingVerdict } from './crossSpacing'

export interface GovernorInput {
  now: Date

  sender: {
    status: string // ACTIVE | PAUSED | CHALLENGED
  }
  target: {
    optedOut: boolean
  }

  /**
   * How many times this pair has been contacted.
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
  /** DELIVERED messages from THIS sender to THIS target today (IST). */
  pairSentTodayCount: number
  /** At most this many per pair per IST day (5) — Tabish's rule. */
  maxPerPairPerDay: number

  /**
   * The RING RULE's verdict for this pair (crossSpacing.ts — Tabish, 2026-08-19).
   *
   * Replaces the any-other-page-in-7-days form restored on 2026-08-18, which halted the
   * whole fleet within a day of the 1-minute pace: hold only when EVERY eligible page has
   * written to this recipient inside the window, plus the `crossPageGapHours` gap between
   * different pages. Computed by the caller (plan.ts) with the same shared predicate the
   * gate and the dashboard use, so the three can never disagree.
   */
  crossSpacing: CrossSpacingVerdict

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
   * something off. Set to 1, no combination of cap or scheduling bugs can produce
   * a second message. Raising it is a deliberate, visible act.
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
  NO_NEW_MATERIAL: 'no-new-material-to-reference',
  PAIR_DAILY_CAP: 'pair-daily-cap',
  TARGET_RECENTLY_CONTACTED: 'target-recently-contacted',
} as const

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
   * RETIREMENT is `target.optedOut`, checked immediately below and derived from the TARGET
   * rather than from a pair row, so it cannot be lost by a pair being recreated. Keeping the
   * burner out of automatic outreach is `SenderAccount.fleetMember`, which is identity
   * rather than a switch and which no UI toggles.
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
      detail: `replied at ${input.targetRepliedAt.toISOString()} — paused for seven days, then resumes (or the moment "I have replied" is pressed)`,
    }
  }

  // Never stack two unsent messages for the same pair. In manual mode an
  // un-tapped attempt from yesterday must not become a queue of five.
  if (input.hasPendingAttempt) {
    return { eligible: false, reason: SKIP_REASONS.PENDING_ATTEMPT }
  }

  // A follow-up must have something new to say — a campaign we have not written
  // about before for this pair. Without this, a second message is a byte-identical
  // repeat of the standard template, drafted again every day forever, and
  // repetition is precisely what lowers the enforcement threshold.
  if (input.touchesSoFar > 0 && input.unusedCampaignCount === 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.NO_NEW_MATERIAL,
      detail: 'nothing new to reference since the last message — waiting for a fresh campaign',
    }
  }

  /**
   * THE RING RULE, refused at DRAFTING as well as at delivery, so a held draft is never
   * written — the queue itself is the thing an operator reads, and a draft that exists
   * only to be refused later is the "why is nothing sending" noise this file's reason
   * codes exist to prevent. Same predicate, same sentence as the gate (crossSpacing.ts).
   */
  if (input.crossSpacing.held) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_RECENTLY_CONTACTED,
      detail: crossSpacingDetail(input.crossSpacing) ?? undefined,
    }
  }

  // Five per day from one account to one recipient (2026-08-18, Tabish).
  if (input.pairSentTodayCount >= input.maxPerPairPerDay) {
    return {
      eligible: false,
      reason: SKIP_REASONS.PAIR_DAILY_CAP,
      detail: `this account already sent this recipient ${input.pairSentTodayCount} message(s) today (limit ${input.maxPerPairPerDay})`,
    }
  }

  return { eligible: true, touchNumber: input.touchesSoFar + 1 }
}
