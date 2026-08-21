import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { getSettings } from '@/lib/settings'
import { mayArmAccount } from './cohorts'
import { replyHaltFloor } from './replyHalt'
import { profileStatus } from './browser/profile'
import { sessionUsable } from './sessionHealth'
import { crossSpacingVerdict, crossSpacingDetail, type CrossSpacingVerdict } from './crossSpacing'
import { materialAllowance, materialAllowanceDetail, campaignsNamingHandle, type MaterialVerdict } from './materialAllowance'
import { eligibleFleetSenderIds } from './availability'
import { DELIVERED_STATUSES } from '@/lib/constants'

/**
 * May an ALREADY-DRAFTED attempt be sent right now?
 *
 * Distinct from `governor.ts`, which decides whether to *create* a message. This
 * decides whether a message that already exists is still permissible — a draft can
 * sit for days, and several things that were true when it was written may not be now.
 *
 * WHY THIS FILE EXISTS
 *
 * `deliverWaiting` re-checked eight conditions before delivering. `sendNow` — the
 * dashboard's Send button — checked three. The five it lacked included the two most
 * absolute stops in the system: `target.optedOut` and *the target has replied*. So
 * `removeTarget` told the operator a channel "can never be contacted again by
 * accident" while a draft's Send button still delivered, and recording a reply halted
 * autopilot but not the button beside it.
 *
 * Copying five checks into `sendNow` would have left two copies to drift apart again,
 * which is how this happened. One function, two callers.
 *
 * The decision half is deliberately PURE, like `governor.ts`: no DB, no clock, no env.
 * Every input is passed in, so every rule is testable in both directions — firing and
 * not firing. That matters more than usual here: this codebase has an eight-instance
 * history of guards that were only ever verified in the direction that passes.
 */

export interface ResendInput {
  /** Current status of the attempt. Only READY/QUEUED may be sent. */
  attemptStatus: string
  /**
   * True when nobody is present (autopilot).
   *
   * Still load-bearing after the per-account switch was removed: it drops overrides
   * (nobody can have acknowledged anything) and it asks the cohort ladder, which is
   * about how many accounts run with nobody watching.
   */
  unattended: boolean

  senderStatus: string // ACTIVE | PAUSED | CHALLENGED
  /**
   * PHASE 9: is this sender's onboarding cohort cleared for unattended sending?
   *
   * Checked at DELIVERY as well as at arming, so a future code path that forgets the ladder
   * does not get round it. Only consulted when `unattended`: a human pressing Send is
   * present, and the ladder is about how many accounts run without anyone watching.
   *
   * Defaults undefined = cleared, so every existing caller behaves as before; cohort 1 is the
   * baseline and always passes anyway.
   */
  senderCohortCleared?: boolean
  senderCohortDetail?: string
  senderHasSession: boolean

  /**
   * An unsettled parked failure on THIS pair, or null. See `RESEND_BLOCKS.UNCERTAIN_DELIVERY`
   * for the duplicate this closes. Required with no default, so the compiler names every
   * caller — a guard that reaches one of `recheckBeforeSend`'s callers and not the others is
   * the drift this file was extracted to stop.
   */
  parkedFailureCode: string | null

  /** One message per detected paid post, asked about the recipient. See materialAllowance.ts. */
  material: MaterialVerdict

  targetOptedOut: boolean
  /**
   * `TargetAccount.role === 'WATCH'` — a publisher we read, never a recipient.
   *
   * ── WHY THIS IS AT THE GATE AND NOT ONLY IN routes.ts ─────────────────────
   *
   * `routes.ts` decides which routes may be CREATED. It cannot help with the rows that
   * already exist, and MEASURED on the day this shipped there were 26 attempts and 8 pairs
   * to our two competitors, 6 of them still READY with a live Send button. A rule that only
   * governs creation leaves every draft written before it was written.
   *
   * `prepareOnDemandSend` is also deliberately exempt from `routes.ts` and creates its own
   * pair, so the on-demand dialog is a second path this has to cover. The gate is asked by
   * BOTH the dispatcher and every Send button, which is why it is the one place that closes
   * both holes.
   */
  targetIsWatchOnly: boolean
  /**
   * `TargetAccount.isVerified` — TRUE only where Instagram itself shows the badge.
   *
   * ── VERIFIED ONLY (Tabish, 2026-08-20) ────────────────────────────────────
   *
   * *"No message is to be sent to any target that are unverified."* Given after MEASURING
   * `@lego.mybrickhouse` ("My Brickhouse", unverified, no category) receiving a real
   * media-buying pitch from a revenue account two minutes after the genuine
   * `@legoindia_official`.
   *
   * **NULL IS REFUSED, and that is the whole design.** "We never looked" is not "verified",
   * and this codebase's most-repeated defect is absence of data hardening into a positive
   * verdict. The cost of refusing NULL is paid at CREATION instead: `createBrandTarget`
   * enriches every new row so the fact exists at birth, and `pnpm ig:audit-targets --run`
   * backfills the rest. So a NULL here means a row that predates both — visible, fixable,
   * and never a silent send.
   */
  targetIsVerified: boolean | null
  /**
   * A reply from this target to ANY of our senders, WITHIN the resume window — the DB
   * half only surfaces replies newer than `replyResumeHours` (default one day), so an
   * older reply simply stops arriving here and messaging resumes. Tabish's decision,
   * 2026-08-07; see src/outreach/replyHalt.ts for what survived of the manual release.
   */
  targetRepliedAt: Date | null

  /**
   * DELIVERED messages from THIS account to THIS recipient today (IST) — at most
   * `maxPerPairPerDay` (5) from one account to one recipient in a day, Tabish's rule of
   * 2026-08-18. Counted per PAIR, not per target.
   */
  pairSentTodayCount: number
  maxPerPairPerDay: number

  /**
   * The most recent DELIVERY to this recipient from ANOTHER of our pages, when it falls
   * inside the spacing window — null outside it, so the pure half needs no clock.
   *
   * ── REMOVED THE MORNING OF 2026-08-18, RESTORED THE SAME EVENING ──────────
   *
   * It went out with the other caps ("remove all caps"), and the consequence arrived on
   * the first afternoon: @absolutejk heard from three different pages of ours inside two
   * days. Tabish, seeing it: *"add back cross account spacing, we do not want 3 accounts
   * to send the same message to the individual 3 times."*
   *
   * SENDER-BLIND on purpose, and it is the only spacing fact that is: the thing being
   * protected is one person's inbox, which cannot see which of our pages wrote. A
   * per-pair rule is structurally unable to notice a SECOND page arriving — that is the
   *2026-08-17 duplicate incident, and removing this rule reproduced it within hours.
   *
   * It does NOT bound throughput: it bounds how many of our pages reach ONE recipient.
   * The same account may still follow up (the per-pair rule above governs that), and
   * every other recipient is untouched.
   *
   * ── RESHAPED 2026-08-19 INTO THE RING RULE (Tabish's instruction) ────────
   *
   * "there is no limit except the 7 day constraint which should occur only if target has
   * been contacted by all targets or a reply has been detected." The any-other-page form
   * above halted the entire fleet the day after the 1-minute pace shipped — MEASURED:
   * 33/33 waiting drafts held, first clear five days out, 76 recipients locked by ONE
   * page each. The rule is now `crossSpacingVerdict` (crossSpacing.ts, the ONE
   * implementation shared with the planner and the dashboard): hold only when EVERY
   * eligible page has written inside the window, plus a short inter-page gap
   * (`crossPageGapHours`, default 24h, Tabish's lever) so the ring cannot walk through
   * one inbox in an afternoon. The ban-pattern risk of up to five near-identical
   * templates per inbox per week was stated and is recorded as his call.
   */
  crossSpacing: CrossSpacingVerdict

  /**
   * Blocks a present human has explicitly acknowledged, from the on-demand dialog.
   *
   * Filtered against OVERRIDABLE_BLOCKS before use, so an unexpected value is inert
   * rather than dangerous. Autopilot never sets this — `unattended: true` and a
   * non-empty override list is a contradiction, and `evaluateResend` rejects it.
   */
  overrides?: readonly string[]
}

export type ResendResult = { ok: true } | { ok: false; reason: string; detail?: string }

/** Stable strings so callers and logs can group them. */
export const RESEND_BLOCKS = {
  NOT_WAITING: 'not-waiting',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  TARGET_OPTED_OUT: 'target-opted-out',
  TARGET_IS_WATCH_ONLY: 'target-is-watch-only',
  TARGET_NOT_VERIFIED: 'target-not-verified',
  TARGET_REPLIED: 'target-replied',
  NO_SESSION: 'no-session',
  /**
   * ── THE ONE VOLUME RULE LEFT (2026-08-18, Tabish's instruction) ─────────────────────
   *
   * *"there must be only a limit of say 5 messages per target per same account in a day
   * … rest unlimited. Remove all caps."* The cross-sender per-recipient cap, the
   * per-sender daily cap, the 7-day sender-blind spacing window, the per-pair cooldown
   * and the unanswered-touch limit were all removed the same day, on that instruction —
   * the risk (hundreds of near-identical cold DMs a day is the documented ban pattern)
   * was stated to him plainly and the call recorded as his.
   *
   * What survives is exactly his rule: one account may deliver at most five messages to
   * one recipient in one IST day. The reply halt (seven days since 2026-08-19), opt-out, watch-only,
   * checkpoint handling and the circuit breaker are untouched — those are not volume
   * caps, they are conversation and account safety.
   */
  PAIR_DAILY_CAP: 'pair-daily-cap',
  /**
   * ── ONE RECIPIENT, ONE OF OUR PAGES (restored 2026-08-18 evening) ─────────
   *
   * Sender-blind spacing: a recipient with a DELIVERED message from ANY of our pages
   * inside the window refuses every OTHER page. Removed with the caps that morning and
   * put back the same day on Tabish's instruction, after three of our accounts reached
   * @absolutejk inside two days — the exact pattern it was written for in the first place.
   *
   * Absolute, like the daily cap: protecting one person's inbox from an operation that
   * looks like several is not a matter of operator judgement, and it is the cross-account
   * fingerprint half of the whole fleet design.
   */
  TARGET_RECENTLY_CONTACTED: 'target-recently-contacted',
  /**
   * ── A SEND TO THIS PAIR WENT UNACCOUNTED FOR, AND NOBODY HAS SETTLED IT ────
   *
   * The other end of the governor's `UNCERTAIN_DELIVERY` (2026-08-21). The governor stops a
   * NEW draft being written; this stops a draft that already exists — including the ones
   * written before the rule, which is why every load-bearing rule here is enforced at both
   * ends.
   *
   * MEASURED: @bollywoodchronicle delivered the identical message to @indiagatefoods twice,
   * because a `not-in-thread` park at 07:30 was invisible to both the pending-attempt count
   * (QUEUED|READY|SENDING) and the touch count (DELIVERED). `not-in-thread` means the
   * composer cleared and the message never appeared, i.e. **the recipient may have it** — so
   * writing another is the one thing that must not follow it.
   *
   * ABSOLUTE, and deliberately absent from `OVERRIDABLE_BLOCKS`. Every stop a human may
   * cross is about TIMING; this is about whether a stranger already holds this exact
   * message, and "I know something the agent does not" is not an argument about that — it is
   * an argument for opening the thread and pressing one of the two buttons that settle it.
   */
  /**
   * ONE MESSAGE PER DETECTED PAID POST (2026-08-21, Tabish). The other end of the governor's
   * `MATERIAL_EXHAUSTED`: 133 recipients had heard from more than one of our pages, many from
   * all five, off a single paid post. Absolute — it is a fact about how much we have to say to
   * this person, not about timing.
   */
  MATERIAL_EXHAUSTED: 'material-exhausted',
  UNCERTAIN_DELIVERY: 'uncertain-delivery-unsettled',
  /** Repeated failures parked this pair; re-queue or discard before another is sent. */
  PARKED_FAILURE: 'parked-failure-unsettled',
  COHORT_NOT_CLEARED: 'cohort-not-cleared',
} as const

/**
 * The ONLY stops a present human may knowingly cross, and the whitelist is closed.
 *
 * `overrides` is applied by membership in this list, never by trusting the caller's
 * string — so a bug (or a crafted request to a server action) that passes
 * `['sender-not-active']` cannot send from an account Instagram has flagged. Adding
 * a member here is a deliberate act with a real consequence; do not widen it to make
 * a UI simpler.
 *
 * What stays absolute, and why each one is not a matter of operator judgement:
 *
 *   SENDER_NOT_ACTIVE — CHALLENGED means Instagram is already unhappy with this
 *     account. Sending into that is the retry-into-a-checkpoint the whole design
 *     refuses, and no confirmation dialog changes what it does to the account.
 *   TARGET_OPTED_OUT — "never contact again". Retirement is the one promise the UI
 *     makes that must survive every other feature.
 *   NO_SESSION — not a policy, a fact. There is no logged-in browser to type into.
 *   PAIR_DAILY_CAP — the last bound on volume. Crossing it has no bound at all, which
 *     is the difference between a deliberate follow-up and a stuck button.
 *   NOT_WAITING — idempotency, not policy. Overriding it would mean sending a
 *     message that is already gone.
 *
 * TARGET_REPLIED is here because the operator chose it (2026-08-03): the button is
 * meant to reach someone mid-conversation. It is genuinely the riskiest thing anyone can
 * cross here — Meta's policy penalises repeated unwanted contact, and the person who
 * engaged is the worst possible recipient of an unwanted extra message — so the dialog
 * must show the reply and its timestamp rather than a generic "are you sure".
 *
 * ONE SWITCH, 2026-08-08: it is now the ONLY entry. `pair-disabled` was the other, and it
 * went with the per-route chips — a route being off was a DEFAULT for unattended sending
 * rather than a claim about the recipient, so with routes automatic there is no longer
 * anything for a human to acknowledge. Note what did NOT change: every stop listed above
 * as absolute is still absolute, and the list shrinking is the whitelist getting NARROWER.
 */
export type ResendBlock = (typeof RESEND_BLOCKS)[keyof typeof RESEND_BLOCKS]

/**
 * Typed as `ResendBlock[]`, not `string[]`, since 2026-08-08. `string[]` accepted both a
 * TYPO and an ABSOLUTE stop as members — the two ways this list can go wrong — and neither
 * was a compile error. (That an absolute stop must never appear is also asserted by
 * `tests/stopInventory.test.ts`, where the reasoning for each one lives; this makes the
 * common half of it unrepresentable rather than merely tested.)
 */
export const OVERRIDABLE_BLOCKS: readonly ResendBlock[] = [RESEND_BLOCKS.TARGET_REPLIED]

/**
 * Is this arbitrary string a stop a present human may cross?
 *
 * The narrow element type above deliberately makes `OVERRIDABLE_BLOCKS.includes(someString)`
 * a type error, and every caller here is validating UNTRUSTED input — a server action is
 * reachable by anything that can reach the page, so `['sender-not-active']` arriving from a
 * crafted request must be inert rather than unrepresentable. So the widening happens HERE,
 * once, in a named predicate both callers share: `evaluateResend` and the audit trail in
 * `actions.ts`. Two call sites each casting on their own is how they drift apart, which is
 * the mistake `gate.ts` itself exists to correct.
 */
export function isOverridable(reason: string): reason is ResendBlock {
  return (OVERRIDABLE_BLOCKS as readonly string[]).includes(reason)
}

export function evaluateResend(input: ResendInput): ResendResult {
  /**
   * Overrides are intersected with the whitelist, never taken on trust, and are
   * dropped entirely when nobody is present. An unattended send has no human to have
   * acknowledged anything, so an override arriving with `unattended: true` is a bug
   * upstream — treating it as empty makes that bug fail closed.
   */
  const allowed = new Set<string>(input.unattended ? [] : (input.overrides ?? []).filter(isOverridable))

  // Ordered most-absolute first, so the reason reported is the fundamental one.

  // Nothing else can matter if this attempt is not waiting to be sent. Also the
  // idempotency check — though callers MUST additionally claim it atomically; a pure
  // function cannot make a check-then-act sequence safe.
  if (input.attemptStatus !== 'READY' && input.attemptStatus !== 'QUEUED') {
    return {
      ok: false,
      reason: RESEND_BLOCKS.NOT_WAITING,
      detail: `already ${input.attemptStatus.toLowerCase()} — nothing sent`,
    }
  }

  if (input.senderStatus !== 'ACTIVE') {
    return {
      ok: false,
      reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      detail: `account is ${input.senderStatus} — sending is halted for it`,
    }
  }

  // Per-account arming was removed 2026-08-08 (one-switch). Ability is derived:
  // session, status, cohort, persona — all checked below.

  /**
   * The cohort ladder, re-asked at the moment of delivery. NOT overridable — see the note on
   * OVERRIDABLE_BLOCKS. `=== false` rather than a falsy test, so an omitted field means
   * "cleared" and no existing caller is silently blocked by a new input.
   */
  if (input.unattended && input.senderCohortCleared === false) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.COHORT_NOT_CLEARED,
      detail: input.senderCohortDetail ?? 'this account is in an onboarding cohort that has not been cleared yet',
    }
  }

  if (input.targetOptedOut) {
    /**
     * "recipient", not "channel". MEASURED 2026-08-17 from a real draft on screen: a pitch to
     * @azmishabana18 — a BRAND row, and a person — was refused with *"Channel is retired. This
     * channel is retired."* Ninety-five of the 99 targets are companies, not channels, so the
     * word was wrong for almost every row it can appear on.
     *
     * The gate cannot see `kind` and should not need to: retirement means the same thing for
     * both, so the honest fix is a word that is true of both rather than a branch.
     */
    return { ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT, detail: 'this recipient is retired' }
  }

  /**
   * NOT overridable, and absent from OVERRIDABLE_BLOCKS on purpose. Every stop a human may
   * cross is about TIMING; this one is about WHO the recipient is. "I know something the
   * agent does not" is not an argument for pitching a competitor whose feed we read to find
   * their advertisers.
   */
  if (input.targetIsWatchOnly) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_IS_WATCH_ONLY,
      detail: 'this is a page we watch for paid posts, not a company we message',
    }
  }

  /**
   * VERIFIED ONLY. Checked beside watch-only because it is the same KIND of question — who
   * the recipient is, not when we may write — and therefore NOT overridable: "I know
   * something the agent does not" is an argument about timing, never about whether the
   * account on the other end is the company it appears to be.
   */
  if (input.targetIsVerified !== true) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_NOT_VERIFIED,
      detail:
        input.targetIsVerified === null
          ? 'we have never confirmed whether this account carries Instagram’s verified badge, and only verified accounts are messaged'
          : 'this account has no verified badge on Instagram — it may be a fan or reseller page rather than the company itself',
    }
  }

  // A reply means a human conversation started. Continuing to fire a queued cold
  // pitch into it is the single most damaging thing this system could do, so it halts
  // every sender to this target, not just the one that got the reply.
  if (input.targetRepliedAt !== null && !allowed.has(RESEND_BLOCKS.TARGET_REPLIED)) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_REPLIED,
      detail: `they replied (written ${input.targetRepliedAt.toISOString()}) — messaging them pauses for seven days from that date, then resumes on its own (or the moment "I have replied" is pressed)`,
    }
  }

  /**
   * An unaccounted-for send, or a pair parked by repeated failures. Checked before the
   * session and the caps: those are about whether we CAN send, this is about whether the
   * recipient already holds this message. Neither is overridable.
   */
  if (input.parkedFailureCode !== null) {
    return input.parkedFailureCode === 'not-in-thread'
      ? {
          ok: false,
          reason: RESEND_BLOCKS.UNCERTAIN_DELIVERY,
          detail:
            'an earlier message to them cleared the composer and never appeared in the thread, so they may already have it — open the conversation and settle it before this one goes',
        }
      : {
          ok: false,
          reason: RESEND_BLOCKS.PARKED_FAILURE,
          detail: `an earlier message to them was parked after repeated failures (${input.parkedFailureCode}) — re-queue or discard that one first`,
        }
  }

  /**
   * Has this recipient earned another message? Checked with the parked/uncertain stops rather
   * than with the caps, because it is a fact about what we have to SAY to them; the caps are
   * facts about timing and clear by themselves.
   */
  if (input.material.held) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.MATERIAL_EXHAUSTED,
      detail: materialAllowanceDetail(input.material) ?? undefined,
    }
  }

  if (!input.senderHasSession) {
    return { ok: false, reason: RESEND_BLOCKS.NO_SESSION, detail: 'account is not connected' }
  }

  /**
   * Checked BEFORE the per-pair cap, because it is the more fundamental refusal: "someone
   * else already wrote to this person" is a fact about the recipient, while the pair cap
   * is a fact about this one conversation. A refusal should name the deeper reason.
   */
  if (input.crossSpacing.held) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED,
      detail: crossSpacingDetail(input.crossSpacing)!,
    }
  }

  if (input.pairSentTodayCount >= input.maxPerPairPerDay) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.PAIR_DAILY_CAP,
      detail: `this account already sent this recipient ${input.pairSentTodayCount} message(s) today — the limit is ${input.maxPerPairPerDay} per day for one account to one recipient`,
    }
  }

  return { ok: true }
}

/**
 * The attempt shape the wrapper needs. Structural rather than a Prisma generated
 * type, so both call sites satisfy it with the includes they already fetch.
 */
export interface ResendAttempt {
  id: string
  status: string
  pair: {
    senderId: string
    targetId: string
    sender: { handle: string; status: string }
    /**
     * `displayName` is REQUIRED (nullable), not optional: the allowance's brand-string
     * arm matches on it, and an optional field a caller omits would silently disable
     * that arm for exactly that caller — the half-wired-rule shape. The compiler names
     * every constructor instead (the RenderTarget.kind pattern).
     */
    target: { handle: string; displayName: string | null; optedOut: boolean; role: string; kind?: string; isVerified: boolean | null }
  }
}

/**
 * Gathers the live inputs and applies `evaluateResend`.
 *
 * Kept separate from the decision so the rules stay unit-testable. This half is
 * queries only — if you find yourself adding an `if` here, it belongs in
 * `evaluateResend` with a test.
 */
export async function recheckBeforeSend(
  attempt: ResendAttempt,
  opts: { unattended: boolean; overrides?: readonly string[] },
): Promise<ResendResult> {
  const settings = await getSettings()
  const dayStart = istDayStart()
  const { sender, target, senderId, targetId } = attempt.pair

  const materialWindowFloor = new Date(Date.now() - settings.defaultCooldownDays * 86_400_000)
  const [replied, pairToday, ringDeliveries, eligibleSenderIds, ladder, senderRow, parked, targetCampaigns, targetDelivered] =
    await Promise.all([
    prisma.outreachAttempt.findFirst({
      /**
       * `gte: replyHaltFloor(...)` rather than `not: null` since 2026-08-07: a reply
       * halts its target for `replyResumeHours` (seven days since 2026-08-19, Tabish's
       * "resume after 7 days automatically or manually" instruction) and then releases ITSELF.
       * "Handled" survives as an early release. See src/outreach/replyHalt.ts.
       */
      where: {
        pair: { targetId },
        replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) },
        replyHandledAt: null,
      },
      orderBy: { repliedAt: 'desc' },
      select: { replyPostedAt: true },
    }),
    // DELIVERED_STATUSES, matching plan.ts — a bare 'SENT' filter lets a reply
    // *lower* a daily count and so buy an extra send. See the note there.
    // Counted per PAIR (this sender to this target): the one volume rule left.
    prisma.outreachAttempt.count({
      where: { pair: { senderId, targetId }, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } },
    }),
    /**
     * Every page's newest delivery to this recipient inside the window — the ring rule's
     * input (crossSpacing.ts). Self-deliveries are INCLUDED on purpose: the predicate
     * needs them to answer "has EVERY page written", and it never holds on self alone —
     * excluding self here would make ring-complete unreachable for the one page that has
     * already gone. Ascending order so later rows overwrite: the map keeps each sender's
     * newest.
     */
    prisma.outreachAttempt.findMany({
      where: {
        pair: { targetId },
        status: { in: [...DELIVERED_STATUSES] },
        sentAt: { gte: new Date(Date.now() - settings.defaultCooldownDays * 24 * 60 * 60 * 1000) },
      },
      orderBy: { sentAt: 'asc' },
      select: { sentAt: true, pair: { select: { senderId: true, sender: { select: { handle: true } } } } },
    }),
    eligibleFleetSenderIds(),
    /**
     * The cohort ladder, asked HERE rather than trusted from `autoSendEnabled`.
     *
     * Only for unattended sends — a human pressing Send is the presence the ladder is about.
     * Skipped entirely when attended, so a dashboard click costs no extra queries.
     */
    opts.unattended ? mayArmAccount(sender.handle) : Promise.resolve({ ok: true as const, reason: 'baseline' as const }),
    /**
     * §3.5: has anything PROVED the on-disk session dead? Queried live rather than added
     * to `ResendAttempt`, so no caller has to be taught about it — and so an account
     * marked mid-run is refused on the very next attempt, not the next process start.
     */
    prisma.senderAccount.findUnique({
      where: { id: senderId },
      select: { sessionInvalidAt: true },
    }),
    /**
     * An unsettled parked failure on this pair — EXCLUDING this attempt itself, or a draft
     * that had failed once and was re-queued would refuse to send on its own history.
     * `not-in-thread` is preferred when several exist, because "they may already have it"
     * is the graver fact. See `RESEND_BLOCKS.UNCERTAIN_DELIVERY`.
     */
    prisma.outreachAttempt.findFirst({
      where: {
        pair: { senderId, targetId },
        status: 'FAILED',
        failureCode: { not: null },
        id: { not: attempt.id },
      },
      orderBy: [{ failureCode: 'asc' }, { queuedAt: 'desc' }],
      select: { failureCode: true },
    }),
    /* The recipient's allowance: paid posts NAMING them (see campaignsNamingHandle — the
       targetId column is the posting channel, so counting it here was zero forever). */
    campaignsNamingHandle(prisma, { handle: target.handle, displayName: target.displayName }, materialWindowFloor),
    prisma.outreachAttempt.count({
      where: {
        pair: { targetId },
        status: { in: [...DELIVERED_STATUSES] },
        sentAt: { gte: materialWindowFloor },
        /* This draft is not yet delivered, so it cannot count against its own allowance. */
        id: { not: attempt.id },
      },
    }),
  ])

  return evaluateResend({
    attemptStatus: attempt.status,
    unattended: opts.unattended,
    senderStatus: sender.status,
    senderCohortCleared: ladder.ok,
    senderCohortDetail: ladder.ok ? undefined : ladder.detail,
    parkedFailureCode: parked?.failureCode ?? null,
    material: materialAllowance({ campaignsInWindow: targetCampaigns, deliveredInWindow: targetDelivered }),
    /**
     * §3.5: "connected" means a cookie on disk AND nothing has since proved it dead. A
     * dead session found during a real send writes `sessionInvalidAt`, and folding it in
     * HERE — as an input to the existing NO_SESSION stop — is what stops the dispatcher
     * burning a tick on it every fifteen minutes. No new rule; the stop, its prose and
     * its remedy are unchanged.
     */
    senderHasSession: sessionUsable({
      hasSessionOnDisk: profileStatus(sender.handle).hasSession,
      sessionInvalidAt: senderRow?.sessionInvalidAt ?? null,
    }),
    targetOptedOut: target.optedOut,
    targetIsWatchOnly: target.role === 'WATCH',
    targetIsVerified: target.isVerified,
    targetRepliedAt: replied?.replyPostedAt ?? null,
    pairSentTodayCount: pairToday,
    maxPerPairPerDay: settings.maxPerPairPerDay,
    crossSpacing: crossSpacingVerdict({
      now: new Date(),
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: senderId,
      eligibleSenderIds,
      lastDeliveryBySender: new Map(
        ringDeliveries
          .filter((r) => r.sentAt !== null)
          .map((r) => [r.pair.senderId, { sentAt: r.sentAt!, handle: r.pair.sender.handle }]),
      ),
    }),
    overrides: opts.overrides,
  })
}
