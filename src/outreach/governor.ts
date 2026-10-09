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
import type { FleetTemplate } from './fleetTemplate'
import { isFollowUp, type FollowUpTemplate } from './followUpTemplate'
import { materialAllowanceDetail, type MaterialVerdict } from './materialAllowance'

export interface GovernorInput {
  now: Date

  sender: {
    status: string // ACTIVE | PAUSED | CHALLENGED
  }
  target: {
    optedOut: boolean
    /**
     * Verified only (Tabish, 2026-08-20). NULL is refused — never looked is not verified.
     * Refused HERE as well as at the gate so no draft is written that can never be sent;
     * a rule enforced only at delivery fills the queue with permanent holds.
     */
    isVerified: boolean | null
  }

  /**
   * How many times this pair has been contacted.
   */
  touchesSoFar: number

  /**
   * Has this recipient EVER replied to ANY of our pages? (2026-09-04, Tabish.)
   *
   * REQUIRED, with no default, for the reason `fleetTemplate` is: a caller that forgot it would
   * send a company already in conversation with us a fresh introduction, and having the
   * compiler name every call site is cheaper than finding that in a delivered thread.
   *
   * DISTINCT from `targetRepliedAt`, which is the ACTIVE halt and expires after a week. This
   * one never expires: the fact that someone answered us does not stop being true.
   */
  targetHasEverReplied: boolean

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

  /**
   * ONE MESSAGE PER DETECTED PAID POST — Tabish, 2026-08-21.
   *
   * *"If only a single paid post is detected … then we send a message to the brand only once
   * unless we detect another paid post."* MEASURED before the change: **133 recipients had
   * heard from more than one of our pages**, many from all five — @indiagatefoods got five
   * messages from five pages in twelve hours off ONE paid post.
   *
   * The existing `NO_NEW_MATERIAL` rule already said this and was defeated by its SCOPE:
   * `unusedCampaignCount` is per PAIR, so one paid post reads as unused for all five senders,
   * and the check only runs when `touchesSoFar > 0` while each sender's own pair has zero.
   * This asks the question about the RECIPIENT, which is who the rule was always about.
   *
   * See `materialAllowance.ts`. Computed by the caller with the shared predicate the gate and
   * the dashboard use, so the three cannot disagree.
   */
  material: MaterialVerdict

  /** True when an attempt for this pair is already waiting to be sent. */
  hasPendingAttempt: boolean

  /**
   * A PARKED FAILURE ON THIS PAIR THAT NOBODY HAS SETTLED YET.
   *
   * ── THE DUPLICATE THIS CLOSES, MEASURED 2026-08-21 ────────────────────────
   *
   * Tabish photographed a thread where @bollywoodchronicle had sent
   * @indiagatefoods the SAME message twice. The database explains it exactly:
   *
   *     07:30  FAILED  not-in-thread   bollywoodchronicle → indiagatefoods
   *     09:16  a NEW draft for the same pair
   *     12:39  SENT                    bollywoodchronicle → indiagatefoods
   *
   * `hasPendingAttempt` counts QUEUED|READY|SENDING, and `touchesSoFar` counts DELIVERED
   * statuses. **FAILED is in neither**, so a parked attempt makes the pair look untouched —
   * and the fresh draft is therefore a FIRST touch, which `NO_NEW_MATERIAL` exempts by
   * construction. Every guard passed; the recipient got two identical DMs.
   *
   * `not-in-thread` is the case that makes this severe rather than untidy: its entire
   * meaning is *the composer cleared and we cannot prove what happened, so the recipient
   * MAY have it*. CLAUDE.md's "`not-in-thread` is never retried" was a promise about the
   * ATTEMPT; nothing was protecting the PAIR, so the planner simply reopened it.
   *
   * The same hole is why @sohamrockstrent accumulated SIX parked drafts at three attempts
   * each — eighteen browser drives at one revenue profile against a recipient whose
   * composer cannot open (see blocker 5) — because each park was invisible to the guard.
   *
   * ── WHAT RELEASES IT, AS OF 2026-08-24 ───────────────────────────────────
   *
   * A capped failure still has re-queue and discard on the landing page, and either releases
   * this stop. An unaccounted-for send no longer has anything: Tabish removed the two-button
   * "check the conversation" flow, so a `not-in-thread` park is now PERMANENT on the pair that
   * produced it. That is deliberate and it is the safe direction for the recipient — the page
   * that may already have delivered never writes to them again — but note the consequence,
   * because it is not obvious: rotation elects ONE sender per recipient and `unavailable` is
   * built from account facts (`readSenderAvailability`), not from parked routes, so if the
   * elected page is the parked one that recipient is skipped every pass. MEASURED the day the
   * flow was removed: 14 recipients carried a park, and for 10 of them the parked page was the
   * elected one.
   */
  parkedFailureCode: string | null

  /**
   * When a message to this RECIPIENT — from ANY of our pages — was parked because their page
   * answered "Sorry, this page isn't available", within PROFILE_GONE_RECHECK_DAYS; null otherwise.
   * Target-scoped on purpose: the parked-failure stop is per PAIR, which is how four senders each
   * drove Chrome three times at @hemantpandeyji's dead page (9 Sept 2026). See parkedRows.ts.
   */
  targetProfileGoneAt: Date | null

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

  /**
   * WHICH STANDARD MESSAGE THIS ROUTE WOULD SEND, or why there is none.
   *
   * Computed by the caller with `templateForSettings` — the same pure rule the gate and the
   * composer ask — so the three can never disagree about which fleet a route belongs to or
   * what that fleet's copy is. REQUIRED with no default, so the compiler names every call
   * site rather than one of them silently permitting.
   */
  fleetTemplate: FleetTemplate

  /**
   * WHAT A SECOND MESSAGE TO THIS RECIPIENT WOULD SAY, or why there is none (2026-09-01).
   *
   * Only consulted when `touchesSoFar > 0`: a first touch is the standard message and is
   * untouched by this. Computed by the caller with `followUpForSettings` — the same pure
   * rule the gate and the composer ask. REQUIRED with no default, so the compiler names
   * every call site rather than one of them silently permitting a repeat.
   */
  followUpTemplate: FollowUpTemplate

  /**
   * Of the unclaimed paid posts naming this recipient, how many can be DESCRIBED to them —
   * a subject `followUpSubject` attributes to this recipient: their own film or product, or
   * the campaign they are talent on (2026-09-01, Tabish: *"an amateur message with no
   * context to the paid posts"*). Only consulted when `touchesSoFar > 0`; a first touch is
   * the standard message and names no post. Computed by the caller from the SAME selector
   * and subject rule `pickFollowUpHook` uses, so the count and the pick cannot disagree.
   * REQUIRED with no default, so the compiler names every call site.
   */
  describableCampaignCount: number

  /**
   * Would the body about to be written be BYTE-IDENTICAL to one this pair has already
   * delivered? Computed by the caller against the same template this decision is made with,
   * so the two cannot disagree. REQUIRED, so the compiler names every call site.
   */
  repeatsADeliveredBody: boolean
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
  /** A send we cannot account for — the recipient may already have it. A person must look. */
  UNCERTAIN_DELIVERY: 'uncertain-delivery-unsettled',
  /** Repeated failures parked this pair. Re-drafting would re-drive the browser forever. */
  PARKED_FAILURE: 'parked-failure-unsettled',
  /** The recipient's Instagram page is gone (deleted or renamed); nothing is deliverable. */
  TARGET_UNREACHABLE: 'target-unreachable',
  NO_NEW_MATERIAL: 'no-new-material-to-reference',
  /**
   * ── UNCLAIMED POSTS EXIST AND NONE CAN BE DESCRIBED TO THEM (2026-09-01) ──
   *
   * A follow-up must say what the post was about — "your Toxic placement on 29 Aug" — and
   * the date-only fallback is DELETED: Tabish, from a delivered thread, *"this message is
   * mentioning nothing but date and placement. This is an amateur message with no context
   * to the paid posts."* MEASURED when he said it: 16 of 25 live pairs rendered date-only,
   * 12 such messages already delivered.
   *
   * So a recipient whose unclaimed posts all fail `followUpSubject` — multi-advertiser
   * round-ups, subjects belonging to somebody else — gets NO follow-up, which is the other
   * half of the same instruction: a message with nothing specific to say is not sent to
   * someone who does not need it. Releases by itself when a post arrives whose subject is
   * theirs, exactly like NO_NEW_MATERIAL beside it; nothing a person does clears it faster.
   */
  NO_DESCRIBABLE_POST: 'no-post-we-can-describe',
  /** Every paid post we have seen naming this recipient has already been written about. */
  MATERIAL_EXHAUSTED: 'material-exhausted',
  PAIR_DAILY_CAP: 'pair-daily-cap',
  FOLLOW_UP_SAME_DAY: 'follow-up-waits-for-tomorrow',
  TARGET_RECENTLY_CONTACTED: 'target-recently-contacted',
  TARGET_NOT_VERIFIED: 'target-not-verified',
  /**
   * The fleet this route belongs to has no standard message written yet (2026-08-26).
   *
   * Refused HERE as well as at the gate, for the reason `TARGET_NOT_VERIFIED` is: a rule
   * enforced only at delivery fills the queue with permanent holds. The remedy is a
   * textarea, so this clears the moment the copy is written — no draft, no discard.
   */
  NO_FLEET_TEMPLATE: 'no-standard-message-for-this-fleet',
  /**
   * ── THE CROSS-FLEET REFUSAL, TOLD APART FROM A MISSING TEMPLATE (2026-08-31) ──
   *
   * This governor has no category check of its own: a cross-fleet pair reaches it through
   * `templateForSettings`, which answers `different-fleet` because no ONE standard message
   * covers a bollywood page writing to a marketing company. Both answers used to be
   * reported as `NO_FLEET_TEMPLATE`.
   *
   * MEASURED 2026-08-31, and the number is why this matters: the planner's tally read
   * `no-standard-message-for-this-fleet=245` on a day when the only second fleet
   * (marketing) HAD its copy written — 280 characters of it. Executing the real resolver
   * over all 3,356 fleet pairs returned 3,000 bollywood, 111 marketing and **exactly 245
   * `different-fleet`**. So every one of those 245 was a correct refusal wearing a label
   * that says *go and write a template*, on the one line a person reads to find out why
   * the fleet is quiet.
   *
   * The per-pair `detail` was always honest; only the aggregate name was wrong. It carries
   * the SAME string as the gate's `RESEND_BLOCKS.DIFFERENT_CATEGORY`, deliberately: one
   * fact, one name, wherever a person meets it.
   *
   * `ambiguous` (a SENDER in two fleets) stays under NO_FLEET_TEMPLATE, and that is not
   * laziness: there genuinely is no single standard message for such a route, which is
   * what that label says. No sender is in two fleets today.
   */
  DIFFERENT_CATEGORY: 'different-category',
  /**
   * ── INSTAGRAM SILENTLY DROPS A REPEAT OF THE SAME BYTES (2026-08-26) ─────
   *
   * MEASURED, and this is the sharpest measurement in the file. Since `singleTemplate` went
   * on, every message is byte-identical — so a SECOND message from one page to one recipient
   * is a verbatim repeat of what is already in that thread.
   *
   *   touch 1  394 delivered, 22 not-in-thread   ->   5% failure
   *   touch 2   11 delivered, 53 not-in-thread   ->  83% failure
   *
   * SIX of six parked threads were then READ, with the parked body deliberately excluded
   * from the completeness bar so the read could be trusted: every one showed **exactly one**
   * copy of our template — the first touch — and `complete: true`. The second message is
   * genuinely not there. The composer cleared, Instagram raised no error, and nothing
   * arrived.
   *
   * So `bodyAppearedSince` was RIGHT every time and is not the bug: it correctly refused to
   * record a delivery that did not happen. What is wrong is sending the message at all.
   *
   * CLAUDE.md predicted this in as many words when the single template shipped — *"Meta's
   * written spam policy penalises REPETITION and merge-field templates do not count as
   * variation… that risk is real and is stated rather than smoothed over"*. This is that
   * risk, measured.
   *
   * IT IS NOT ONLY WASTE. A `not-in-thread` park is PERMANENT on the pair, so every one of
   * these burns a route for a message nobody received — 77 pairs so far — and keeps
   * signalling repetition to the one party whose opinion ends this project.
   *
   * The rule lifts by itself the moment a follow-up says something different: turn
   * `singleTemplate` off and the variant pools return, or give the fleet a second template.
   */
  IDENTICAL_TO_A_SENT_MESSAGE: 'identical-to-a-message-they-already-have',
  /**
   * ── THIS PAIR HAS EARNED A FOLLOW-UP AND THERE IS NO FOLLOW-UP MESSAGE (2026-09-01) ──
   *
   * Everything else about this pair is fine — the recipient is verified and not retired,
   * the account is healthy, nobody has replied on this route, the allowance has room, a
   * paid post naming them is unclaimed, the ring says it is this page's turn, the daily cap
   * is not spent. The ONLY thing missing is what a second message would say.
   *
   * ── AND THAT IS WHY IT IS CHECKED LAST, WHICH BREAKS THIS FILE'S USUAL ORDER ──
   *
   * Every other stop here is ordered most-fundamental-first so the reason reported is the
   * deepest true one, and by that logic a missing template belongs beside
   * `NO_FLEET_TEMPLATE`, near the top. It is deliberately at the bottom instead, and the
   * argument is the one this file already paid for on 2026-08-31: `DIFFERENT_CATEGORY` had
   * to be split out of `NO_FLEET_TEMPLATE` because **245 correct refusals were wearing a
   * label that says *go and write a template*, on the one line a person reads to find out
   * why the fleet is quiet.**
   *
   * Placed early, this stop would relabel every held follow-up in the fleet — including the
   * ones waiting on a paid post, on the ring, or on the daily cap, none of which a textarea
   * releases. Placed last, the number it reports is exactly the number of messages that
   * would go out the moment Tabish writes the copy, which is the only figure worth putting
   * next to the box.
   *
   * NOT overridable at the gate's end, for the `FLEET_TEMPLATE_NOT_SET` reason: every stop a
   * human may cross is about TIMING, this one is about WHAT THE MESSAGE SAYS, and the remedy
   * is a textarea rather than a judgement call.
   */
  NO_FOLLOW_UP_TEMPLATE: 'no-follow-up-message-written',
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

  if (input.target.isVerified !== true) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_NOT_VERIFIED,
      detail:
        'only accounts carrying Instagram’s verified badge are messaged, and this one does not — nothing is written to them',
    }
  }

  /**
   * ── NOTHING IS DRAFTED FOR A FLEET WITH NO COPY (2026-08-26, Tabish) ──────
   *
   * *"a separate template message would be sent for the marketing and brand category …
   * keep it empty for now."* Checked here, beside the other questions about WHO this
   * message would be, because it is the same kind: not *when* we may write, but *what a
   * message to this recipient would even say*.
   *
   * The two alternatives to refusing are both silent. Falling back to the default fleet's
   * copy sends a marketing-trade company the entertainment network's pitch — well-formed,
   * plausible, and wrong in the one way nothing on a screen would show. An empty body makes
   * `distinctiveSlice` return null, which refuses every send in the SYSTEM with no sentence
   * naming the cause.
   */
  if (!input.fleetTemplate.ok) {
    return {
      eligible: false,
      /* "these two are in different fleets" and "nobody has written this fleet's copy" are
         different problems with different remedies — see DIFFERENT_CATEGORY. */
      reason:
        input.fleetTemplate.reason === 'different-fleet'
          ? SKIP_REASONS.DIFFERENT_CATEGORY
          : SKIP_REASONS.NO_FLEET_TEMPLATE,
      detail: input.fleetTemplate.detail,
    }
  }

  if (input.sender.status !== 'ACTIVE') {
    return {
      eligible: false,
      reason: SKIP_REASONS.SENDER_NOT_ACTIVE,
      detail: `sender status is ${input.sender.status}`,
    }
  }

  // A reply means a human conversation has started, and continuing to fire templated
  // pitches into it would be actively damaging. WHICH senders it halts is the scope's: the
  // caller's `targetRepliedAt` comes from `replyHaltWhere`, so under `pair` (Tabish's choice
  // since 2026-09-01) only the page that got the reply, under `target` every page.
  if (input.targetRepliedAt !== null) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_REPLIED,
      detail: `replied at ${input.targetRepliedAt.toISOString()} — paused for seven days, then resumes on its own`,
    }
  }

  // Never stack two unsent messages for the same pair. In manual mode an
  // un-tapped attempt from yesterday must not become a queue of five.
  if (input.hasPendingAttempt) {
    return { eligible: false, reason: SKIP_REASONS.PENDING_ATTEMPT }
  }

  /**
   * ── AFTER the facts about WHO, before the material and volume rules ───────
   *
   * A reply, a retired recipient, a missing badge and a flagged account are all more
   * fundamental than what the bytes would say, and this file reports the most fundamental
   * true reason. It sits ABOVE the material rules because those are about timing — another
   * paid post releases them — and this one is not: no amount of waiting makes Instagram
   * deliver a verbatim repeat. See SKIP_REASONS.IDENTICAL_TO_A_SENT_MESSAGE.
   */
  if (input.repeatsADeliveredBody) {
    return {
      eligible: false,
      reason: SKIP_REASONS.IDENTICAL_TO_A_SENT_MESSAGE,
      detail:
        'the next message would be word for word the one this page already sent them — Instagram accepts it and never delivers it, so nothing is written until there is something different to say',
    }
  }

  /**
   * A PARKED FAILURE BLOCKS A NEW DRAFT FOR THIS PAIR UNTIL A PERSON SETTLES IT.
   *
   * Checked here — after the pending check and before anything about material or spacing —
   * because it is a fact about what the RECIPIENT may already hold, which outranks every
   * question about timing. See `parkedFailureCode` for the measured duplicate.
   *
   * `not-in-thread` gets its own reason and its own sentence: "we cannot prove whether they
   * got it" and "it repeatedly failed" are different facts with different remedies, and
   * collapsing them would put the ambiguous case behind a button labelled for the certain
   * one. Everything else is the retry cap having parked the pair.
   */
  /**
   * THE RECIPIENT'S PAGE IS GONE (9 Sept 2026) — a fact about WHO, asked before the per-pair parks
   * because every park to a vanished page is a symptom of this one cause. Lifts by itself after
   * PROFILE_GONE_RECHECK_DAYS, when ONE anonymous probe (deliver.ts) asks again before any drive.
   */
  if (input.targetProfileGoneAt !== null) {
    return {
      eligible: false,
      reason: SKIP_REASONS.TARGET_UNREACHABLE,
      detail: `their Instagram page answered "this page isn't available" on ${input.targetProfileGoneAt.toISOString().slice(0, 10)} — the account is gone or renamed; nothing is written to them until it is seen again`,
    }
  }

  if (input.parkedFailureCode !== null) {
    return input.parkedFailureCode === 'not-in-thread'
      ? {
          eligible: false,
          reason: SKIP_REASONS.UNCERTAIN_DELIVERY,
          detail:
            'a message to them cleared the composer and never appeared in the thread, so they may already have it — this page writes nothing further to them',
        }
      : {
          eligible: false,
          reason: SKIP_REASONS.PARKED_FAILURE,
          detail: `a message to them was parked after repeated failures (${input.parkedFailureCode}) — re-queue or discard it before another is written`,
        }
  }

  /**
   * ONE MESSAGE PER DETECTED PAID POST, ASKED ABOUT THE RECIPIENT (2026-08-21).
   *
   * Checked BEFORE the per-pair new-material rule below, because it is the stronger and more
   * general form of the same idea: that rule asks "has THIS page written about this campaign",
   * this one asks "has ANY page", which is the question a recipient's inbox actually poses.
   * Ordered after the pair-level pending/parked checks so a more specific fact about this
   * exact draft still wins the sentence.
   */
  if (input.material.held) {
    return {
      eligible: false,
      reason: SKIP_REASONS.MATERIAL_EXHAUSTED,
      detail: materialAllowanceDetail(input.material) ?? undefined,
    }
  }

  // A follow-up must have something new to say — a campaign we have not written
  // about before for this pair. Without this, a second message is a byte-identical
  // repeat of the standard template, drafted again every day forever, and
  // repetition is precisely what lowers the enforcement threshold.
  if (isFollowUp(input) && input.unusedCampaignCount === 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.NO_NEW_MATERIAL,
      detail: 'nothing new to reference since the last message — waiting for a fresh campaign',
    }
  }

  /**
   * The stronger half of the same rule (2026-09-01): unclaimed posts exist, but none has a
   * subject this recipient would recognise as their own, and a follow-up that cites only a
   * date is the "amateur message with no context" Tabish refused from a live thread.
   * Directly after NO_NEW_MATERIAL because it is the same family with the same release —
   * a new paid post — not a textarea, which is why it does not join the two follow-up
   * stops checked last.
   */
  if (isFollowUp(input) && input.describableCampaignCount === 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.NO_DESCRIBABLE_POST,
      detail:
        'paid posts naming them are unclaimed, but none can be described to them — the subject is unclear or belongs to another advertiser, and a follow-up must say what the post was about; waiting for a post whose subject is theirs',
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
  /**
   * ── A SECOND MESSAGE FROM ONE PAGE WAITS FOR TOMORROW (2026-09-04, Tabish) ──
   *
   * *"follow up messages by the same sender are not sent the very same day for the target,
   * they are instead sent the very next day … madabout (if it is sole or others in the ring
   * are exhausted) sends the follow up message the very next day (not the same day)."*
   *
   * MEASURED over 14 days: 16 pair-days carried more than one delivery and 5 carried three or
   * more — @madaboutmarketingg wrote to @supersox_india at 14:26, 14:36 and 14:48 on 2
   * September. With one page in the marketing ring, a second paid post detected the same
   * afternoon becomes a second message the same afternoon, and from the recipient's side that
   * is one page writing three times in twenty minutes.
   *
   * A FIRST touch is untouched: it is the only message that pair has ever sent, and the pair
   * cap below is what bounds it.
   *
   * Checked BEFORE the pair cap so a follow-up names the rule actually binding it — the cap is
   * five a day and this is one, so for a follow-up this is always the tighter of the two.
   * The day boundary is the same IST one `pairSentTodayCount` is counted against, so the two
   * cannot name different days across midnight.
   */
  if (isFollowUp(input) && input.pairSentTodayCount > 0) {
    return {
      eligible: false,
      reason: SKIP_REASONS.FOLLOW_UP_SAME_DAY,
      detail: `this account already wrote to this recipient today — a second message from the same page waits for tomorrow`,
    }
  }

  if (input.pairSentTodayCount >= input.maxPerPairPerDay) {
    return {
      eligible: false,
      reason: SKIP_REASONS.PAIR_DAILY_CAP,
      detail: `this account already sent this recipient ${input.pairSentTodayCount} message(s) today (limit ${input.maxPerPairPerDay})`,
    }
  }

  /**
   * LAST, AND ONLY FOR A FOLLOW-UP. See `SKIP_REASONS.NO_FOLLOW_UP_TEMPLATE` for why this
   * one breaks the most-fundamental-first ordering: reported here, the count is exactly the
   * pairs a textarea would release, and every other pair keeps the reason that is actually
   * holding it.
   *
   * A FIRST touch never reaches this — `touchesSoFar` is 0 — so writing no follow-up copy
   * leaves first-touch outreach byte-for-byte as it was.
   */
  if (isFollowUp(input) && !input.followUpTemplate.ok) {
    return {
      eligible: false,
      reason: SKIP_REASONS.NO_FOLLOW_UP_TEMPLATE,
      detail: input.followUpTemplate.detail,
    }
  }

  return { eligible: true, touchNumber: input.touchesSoFar + 1 }
}
