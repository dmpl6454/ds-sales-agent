import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { getSettings } from '@/lib/settings'
import { mayArmAccount } from './cohorts'
import { checkPersonaDistinct } from './brandGuards'
import { signatureBlock } from './render'
import { replyHaltFloor } from './replyHalt'
import { profileStatus } from './browser/profile'
import { sessionUsable } from './sessionHealth'
import { assertedRecency, hookRecencyStale } from './brandPitch'
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
  senderDailyCap: number

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
   * A reply from this target to ANY of our senders, WITHIN the resume window — the DB
   * half only surfaces replies newer than `replyResumeHours` (default one day), so an
   * older reply simply stops arriving here and messaging resumes. Tabish's decision,
   * 2026-08-07; see src/outreach/replyHalt.ts for what survived of the manual release.
   */
  targetRepliedAt: Date | null

  targetSentTodayCount: number
  senderSentTodayCount: number
  maxPerTargetPerDay: number

  /**
   * The most recent DELIVERY to this recipient from ANY of our pages, when it falls
   * inside the spacing window — null outside it, so the pure half needs no clock.
   * Sender-blind on purpose: the incident this guards against is two different pages
   * in one inbox, which no per-pair fact can see.
   */
  targetRecentContact: { fromHandle: string; hoursAgo: number } | null

  /**
   * Does this account share its persona with another sending account?
   *
   * Checked at DELIVERY as well as at drafting, and that is the point of putting it
   * here. The planner refuses to CREATE a message from a shared persona, but a draft
   * written before the gate existed — or before decision 6 extended it to channels —
   * is already sitting in READY with a Send button beside it. "Nothing sends until each
   * account has its own persona" has to be true of those too, or the brake only applies
   * to work that has not happened yet.
   *
   * NOT overridable, and deliberately absent from OVERRIDABLE_BLOCKS. Every stop a human
   * may cross is about TIMING — too soon, nothing new to say, they already replied. This
   * one is about the message being wrong for its recipient, and "I know something the
   * agent does not" is not an argument that applies to a signature naming the wrong
   * company. The fix is to give the account its own persona, which takes a minute.
   */
  personaSharedWithAnotherSender: boolean

  /**
   * The DRAFT no longer carries the identity this account now uses.
   *
   * OBSERVED IN PRODUCTION 2026-08-05, and it is this project's signature failure in a new
   * place. The sequence, from the audit log:
   *
   *   15:10:54  a draft is prepared — the body is rendered with the persona AS IT IS
   *   15:12:23  the operator gives the account its own identity
   *   15:12:28  Send is pressed. The persona gate CHECKS THE ACCOUNT and passes, because
   *             the account's identity is now distinct
   *   15:13:15  delivered — still saying "I'm Kapil Jain, Co-founder of Bollywood Society"
   *
   * The gate was satisfied by a fact that had nothing to do with what was actually sent. The
   * whole point of decision 3b is that a recipient must not receive a pitch signed by another
   * company, and a message can now do exactly that WHILE the guard reports everything is fine.
   *
   * It is not hypothetical: at the moment this was found, all three waiting drafts said
   * "Co-founder of Bollywood Society" while two of those accounts had become Mad About
   * Marketing and Bollywood Chronicle.
   *
   * Refusing rather than re-rendering is deliberate. The stored body is the single source of
   * truth downstream — the composer read-back compares against exactly it, and an operator may
   * have edited it by hand. Silently rewriting someone's words at the moment of sending is a
   * worse cure than a refusal that says what to do.
   */
  draftPersonaStale: boolean
  /**
   * The dated claim in the stored body no longer matches the campaign's age.
   *
   * A body is rendered once and frozen; `describeRecency` bands `days <= 10` as "last week".
   * MEASURED 2026-08-13: a draft written on 11 August about a 9-day-old campaign still says
   * "last week" about a placement now 11 days old, and is still queued.
   */
  draftHookStale: boolean

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
  TARGET_REPLIED: 'target-replied',
  NO_SESSION: 'no-session',
  /**
   * ── ONE RECIPIENT, ONE CONVERSATION AT A TIME (2026-08-17) ─────────────────────────
   *
   * MEASURED the evening rotation went live with three recorded senders: @absolutejk
   * heard from @bollywoodchronicle at 17:44 and from @bollywoodsocietyy at 18:13 —
   * twenty-nine minutes apart, near-identical template bodies, different page names.
   * Tabish spotted it from the dashboard before any code did.
   *
   * Every spacing rule was PER PAIR — the 7-day cooldown, the first-touch exemption
   * from new-material — so a second page writing to a fresh recipient was a "first
   * touch" with no history, and the only cross-sender rule (2/recipient/day) PERMITS
   * exactly one duplicate a day. Rotation then deliberately elects the NEXT page for
   * the next touch. Nothing anywhere asked "has anyone written to this person lately?"
   *
   * Now something does, at delivery, where it cannot be drafted around: a recipient
   * with a DELIVERED message from ANY of our pages inside the spacing window refuses
   * every page. A blocked sender never locks a recipient — nothing was delivered — so
   * the fallback Tabish described ("another page only if the first was blocked") still
   * works by construction. Absolute like the daily caps: recipient protection is not a
   * matter of operator judgement, and two of our pages in one inbox in one afternoon
   * is the cross-account fingerprint half this design exists to avoid.
   */
  TARGET_RECENTLY_CONTACTED: 'target-recently-contacted',
  TARGET_DAILY_CAP: 'target-daily-cap',
  SENDER_DAILY_CAP: 'sender-daily-cap',
  PERSONA_NOT_DISTINCT: 'persona-not-distinct',
  COHORT_NOT_CLEARED: 'cohort-not-cleared',
  PERSONA_CHANGED_SINCE_DRAFT: 'persona-changed-since-draft',
  HOOK_STALE_SINCE_DRAFT: 'hook-stale-since-draft',
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
 *   TARGET/SENDER_DAILY_CAP — the last bound on volume. Crossing cooldown sends one
 *     extra message to one person; crossing a daily cap has no bound at all, which is
 *     the difference between a deliberate follow-up and a stuck button.
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

  // A reply means a human conversation started. Continuing to fire a queued cold
  // pitch into it is the single most damaging thing this system could do, so it halts
  // every sender to this target, not just the one that got the reply.
  if (input.targetRepliedAt !== null && !allowed.has(RESEND_BLOCKS.TARGET_REPLIED)) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_REPLIED,
      detail: `they replied at ${input.targetRepliedAt.toISOString()} — messaging them pauses for a day, then resumes on its own`,
    }
  }

  if (!input.senderHasSession) {
    return { ok: false, reason: RESEND_BLOCKS.NO_SESSION, detail: 'account is not connected' }
  }

  /**
   * Decision 6. Absolute — this one is not in OVERRIDABLE_BLOCKS and must not be.
   *
   * 63 pages emitting one byte-identical contact block is the cross-account fingerprint
   * decision 3 exists to prevent, and rotation sharpens it: a recipient hearing from a
   * different page each time, with the same name and phone number underneath every one,
   * is being told the pages are one operation.
   */
  if (input.personaSharedWithAnotherSender) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.PERSONA_NOT_DISTINCT,
      detail: 'this account shares its persona with another sending account — give it its own first',
    }
  }

  /**
   * NOT overridable, for the same reason as the distinctness check beside it: this is about
   * the message being wrong for its recipient, not about timing. "I know something the agent
   * does not" is not an argument that applies to a signature naming the wrong company.
   */
  if (input.draftPersonaStale) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT,
      detail:
        'this account was given a new identity after this message was written, so the message still signs off as the old one — discard it and write a new one',
    }
  }

  /**
   * NOT overridable, and it sits directly after the persona staleness stop because it is
   * the same shape of problem: the body was true when it was written and is not true now.
   *
   * "I know something the agent does not" is an argument about TIMING. It is not an argument
   * for telling a company we saw their placement "last week" when it was three weeks ago —
   * to the one team certain to know exactly when they ran it.
   */
  if (input.draftHookStale) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT,
      detail:
        'this message says when we saw their placement, and it has been waiting long enough that the timing is no longer right — discard it and write a new one',
    }
  }

  if (input.targetRecentContact != null) {
    const { fromHandle, hoursAgo } = input.targetRecentContact
    const when = hoursAgo < 24 ? `${Math.max(1, Math.round(hoursAgo))}h ago` : `${Math.round(hoursAgo / 24)} day(s) ago`
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED,
      detail: `this recipient heard from @${fromHandle} ${when} — spacing applies across every page, not per account`,
    }
  }

  if (input.targetSentTodayCount >= input.maxPerTargetPerDay) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_DAILY_CAP,
      detail: `channel already received ${input.targetSentTodayCount} today`,
    }
  }

  if (input.senderSentTodayCount >= input.senderDailyCap) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.SENDER_DAILY_CAP,
      detail: `account already sent ${input.senderSentTodayCount} today`,
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
    sender: { handle: string; status: string; dailyCap: number }
    target: { optedOut: boolean; role: string; kind?: string }
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
  const targetKindOf = target.kind ?? 'CHANNEL'

  const [replied, targetToday, targetRecent, senderToday, personaShared, ladder, draft, senderRow] = await Promise.all([
    prisma.outreachAttempt.findFirst({
      /**
       * `gte: replyHaltFloor(...)` rather than `not: null` since 2026-08-07: a reply
       * halts its target for `replyResumeHours` (default one day) and then releases
       * ITSELF — Tabish removed the manual-release requirement, with the risk stated.
       * "Handled" survives as an early release. See src/outreach/replyHalt.ts.
       */
      where: {
        pair: { targetId },
        repliedAt: { gte: replyHaltFloor(settings.replyResumeHours) },
        replyHandledAt: null,
      },
      orderBy: { repliedAt: 'desc' },
      select: { repliedAt: true },
    }),
    // DELIVERED_STATUSES, matching plan.ts — a bare 'SENT' filter lets a reply
    // *lower* a daily count and so buy an extra send. See the note there.
    prisma.outreachAttempt.count({
      where: { pair: { targetId }, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } },
    }),
    /**
     * The newest delivery to this RECIPIENT from any page, inside the spacing window.
     * Sender-blind, unlike every other spacing fact here — see TARGET_RECENTLY_CONTACTED.
     */
    prisma.outreachAttempt.findFirst({
      where: {
        pair: { targetId },
        status: { in: [...DELIVERED_STATUSES] },
        sentAt: { gte: new Date(Date.now() - settings.defaultCooldownDays * 24 * 60 * 60 * 1000) },
      },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true, pair: { select: { sender: { select: { handle: true } } } } },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { senderId }, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } },
    }),
    /**
     * Is this account's persona shared with another sender?
     *
     * Computed by the SAME function the planner and the dashboard warning use. A page
     * that worked this out its own way could disagree with the rule actually blocking
     * the send, which is the failure `checkPersonaDistinct` was extracted to prevent.
     */
    (async () => {
      const settings2 = await getSettings()
      const all = await prisma.senderAccount.findMany({
        select: {
          id: true,
          personaName: true,
          personaRole: true,
          personaBrand: true,
          personaPhone: true,
          personaEmail: true,
        },
      })
      const me = all.find((s) => s.id === senderId)
      if (!me) return false
      const verdict = checkPersonaDistinct({
        persona: me,
        otherPersonas: all.filter((s) => s.id !== senderId),
        targetKind: targetKindOf,
        gateChannels: settings2.personaGateChannels,
      })
      return !verdict.ok
    })(),
    /**
     * The cohort ladder, asked HERE rather than trusted from `autoSendEnabled`.
     *
     * Only for unattended sends — a human pressing Send is the presence the ladder is about.
     * Skipped entirely when attended, so a dashboard click costs no extra queries.
     */
    opts.unattended ? mayArmAccount(sender.handle) : Promise.resolve({ ok: true as const, reason: 'baseline' as const }),
    /**
     * The body as WRITTEN, plus the persona as it is NOW. Queried here rather than added to
     * `ResendAttempt` so no caller has to be taught about it — and the answer must come from
     * the live row, since the whole failure is that the two drifted apart.
     */
    prisma.outreachAttempt.findUnique({
      where: { id: attempt.id },
      select: {
        renderedBody: true,
        sender: {
          select: { personaName: true, personaRole: true, personaBrand: true, personaPhone: true, personaEmail: true },
        },
        /**
         * The campaign a channel follow-up's dated claim is about. A BRAND first touch gets
         * its date from somewhere else entirely — see `hookCampaignPostedAt` below.
         */
        campaign: { select: { postedAt: true } },
        target: { select: { discoveredFromCampaignId: true } },
      },
    }),
    /**
     * §3.5: has anything PROVED the on-disk session dead? Queried live rather than added
     * to `ResendAttempt`, so no caller has to be taught about it — and so an account
     * marked mid-run is refused on the very next attempt, not the next process start.
     */
    prisma.senderAccount.findUnique({
      where: { id: senderId },
      select: { sessionInvalidAt: true },
    }),
  ])

  /**
   * Computed with the SAME function that WROTE those lines, never by comparing fields. A page
   * or a gate working this out its own way is how the two disagree — the mistake
   * `checkPersonaDistinct` was extracted to prevent.
   *
   * Since 2026-08-07 the identity is the signature block alone (channel name, phone,
   * email) — the "I'm Kapil Jain…" intro is gone from new messages. Drafts written under
   * the OLD shape pass this probe when their contact block still matches, deliberately:
   * their signature read "Co-founder, Bollywood Society ⏎ phone ⏎ email", which contains
   * the new block as a substring, and the stop exists to catch a message signed as the
   * WRONG identity, not one signed in last month's format.
   */
  const draftPersonaStale = draft !== null && !draft.renderedBody.includes(signatureBlock(draft.sender))

  const draftHookStale = await isDraftHookStale(draft)

  return evaluateResend({
    attemptStatus: attempt.status,
    draftPersonaStale,
    draftHookStale,
    unattended: opts.unattended,
    senderStatus: sender.status,
    senderCohortCleared: ladder.ok,
    senderCohortDetail: ladder.ok ? undefined : ladder.detail,
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
    senderDailyCap: sender.dailyCap,
    targetOptedOut: target.optedOut,
    targetIsWatchOnly: target.role === 'WATCH',
    targetRepliedAt: replied?.repliedAt ?? null,
    targetSentTodayCount: targetToday,
    targetRecentContact:
      targetRecent?.sentAt != null
        ? {
            fromHandle: targetRecent.pair.sender.handle,
            hoursAgo: (Date.now() - targetRecent.sentAt.getTime()) / 3_600_000,
          }
        : null,
    senderSentTodayCount: senderToday,
    maxPerTargetPerDay: settings.maxPerTargetPerDay,
    personaSharedWithAnotherSender: personaShared,
    overrides: opts.overrides,
  })
}

/**
 * HAS THE DATED CLAIM IN THIS DRAFT DECAYED? Read out of the BODY, not recomputed.
 *
 * `hookRecencyStale` finds the band the stored text asserts and compares it against the band
 * that campaign's age would produce NOW. Reading the body is what makes this correct for a
 * draft an operator edited by hand: the stored bytes are what the recipient receives and what
 * the send guards compare against.
 *
 * ── THE DATE COMES FROM TWO DIFFERENT PLACES ──────────────────────────────
 *
 * A channel follow-up references the attempt's OWN campaign. A brand's FIRST TOUCH is built
 * from `TargetAccount.discoveredFromCampaignId` — the post that made them a prospect — and
 * MEASURED on the live drafts, every brand draft has `campaignId: null` while still asserting
 * "last week". Reading only `attempt.campaign` would have left this stop unreachable on
 * exactly the messages that have it wrong.
 *
 * ── THE QUERY IS ONLY PAID FOR WHEN THERE IS A CLAIM ──────────────────────
 *
 * `assertedRecency` is asked first, on a string already in hand. A body that names no date
 * cannot be stale, and that is most of them — the degraded opening claims no placement at
 * all — so the ordinary path adds no round trip to a gate the dashboard calls per draft.
 */
async function isDraftHookStale(
  draft: {
    renderedBody: string
    campaign: { postedAt: Date } | null
    target: { discoveredFromCampaignId: string | null }
  } | null,
): Promise<boolean> {
  if (draft === null) return false
  if (assertedRecency(draft.renderedBody) === null) return false

  let postedAt: Date | null = draft.campaign?.postedAt ?? null
  if (postedAt === null && draft.target.discoveredFromCampaignId !== null) {
    const discovered = await prisma.detectedCampaign.findUnique({
      where: { id: draft.target.discoveredFromCampaignId },
      select: { postedAt: true },
    })
    postedAt = discovered?.postedAt ?? null
  }

  /**
   * A claim we can no longer date is STALE, not safe. The body says "last week" and we have
   * lost the post it referred to — that is precisely the state in which the sentence cannot
   * be stood behind. Absence of data must not harden into permission.
   */
  return hookRecencyStale({ body: draft.renderedBody, postedAt, now: new Date() })
}
