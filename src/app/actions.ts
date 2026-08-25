'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { runSlot } from '@/worker/runSlot'
import { browserSender } from '@/outreach/senders/browser'
// `mayArmAccount` is deliberately NOT imported here any more: the arming button is gone
// (one switch, 2026-08-08) and the ladder is enforced by `gate.ts` at delivery instead.
// The FUNCTION is very much alive — do not delete it on the strength of this file.
import { nextCohort } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { recheckBeforeSend, isOverridable } from '@/outreach/gate'
import { prepareOnDemand, type OnDemandPreview } from '@/outreach/onDemand'
import { getSettings, setSetting, SETTING_KEYS } from '@/lib/settings'
import { startConnect, pollConnect, cancelConnect, type ConnectState } from '@/outreach/browser/connect'
import { handleExists, probeHandle } from '@/detection/exists'
import { addTargetMessage } from './add-target-message'
import { assertSafeHandle } from '@/lib/urls'
import { distinctiveSlice } from '@/outreach/matching'
import { recordDelivered } from '@/outreach/recordSend'
import { claimForAttempt, settleClaims, releaseReservation } from '@/outreach/reservations'
import { markChallenged, clearChallenged } from '@/outreach/challenge'
import { markSessionInvalid, clearSessionInvalid } from '@/outreach/sessionHealth'
import { withSendLock, DISPATCH_PAUSE_KEY, dispatchTick } from '@/outreach/dispatcher'
import { importProspects, type ImportOutcome } from '@/outreach/importProspects'
import { routeAllowed, fleetHandles } from '@/outreach/routes'
import { ensureCategory, addTargetToCategory } from '@/outreach/categories'
import { discardAttempt } from '@/outreach/discard'
import { handOffWaitingDrafts } from '@/outreach/handOff'
import { log } from '@/lib/logger'
import { validatePersona } from '@/outreach/render'
import { checkTemplateBody } from '@/outreach/templateGuard'
import { requireOperator } from '@/lib/session'
import { MESSAGE_VARIANTS } from '../../prisma/variants'
import { BRAND_MESSAGE_VARIANTS } from '../../prisma/brandVariants'

/**
 * Everything the dashboard can do.
 *
 * Connecting accounts and managing channels moved here from the terminal
 * deliberately: `pnpm ig:login` is a developer flow, and the person who runs this
 * day to day should never need a shell. The safety properties are unchanged — the
 * password is still typed into Chrome's own form, and nothing here reads it.
 *
 * Deeper operator surgery (personas, cooldowns, reclassification) stays in
 * `pnpm agent` and `pnpm db:studio`. Controls that can quietly break outreach do
 * not belong on the page a CEO reads.
 *
 * Every state change writes an AuditLog row.
 *
 * AUTHENTICATION
 *
 * Every exported function here begins with `await requireOperator()`, and that placement
 * is the point: it is the FIRST statement, before arguments are read or anything is
 * written. Several of these mutate and then audit, so a check deferred into `audit()`
 * would let the mutation complete and fail afterwards — the same shape as the
 * check-then-write bug that let a double click send twice.
 *
 * AUTHORISATION, added 2026-08-08 with hosting. `requireOperator` is `requireUser` plus
 * "may this person change anything". EVERY action in this file mutates something — there
 * are no read-only actions here, which is what makes the blanket rule correct rather than
 * lazy; anything read-only belongs in a view model, not an action. A signed-in VIEWER can
 * therefore see every page and call none of these.
 *
 * It is a separate function rather than a flag on `requireUser` deliberately: an argument
 * defaulting to "no role check" is one forgotten parameter away from an unprotected
 * mutation, and this file once exported eighteen actions with nothing in front of them at
 * all. `tests/action-authorisation.test.ts` asserts no action ever downgrades to
 * `requireUser`.
 *
 * This is the second layer, not the only one. `src/middleware.ts` refuses
 * unauthenticated requests at the router, but a server action is a POST endpoint and
 * middleware is a router filter: a matcher edit or a Next upgrade that lets one request
 * through must still find every action closed. Before this existed all 18 were callable
 * by anything that could reach the port.
 */

/**
 * The signed-in operator's email, recorded as `AuditLog.actor` and `sentBy`.
 *
 * Replaces `env.OPERATOR_NAME`, which was one shared string for everyone — so with open
 * registration the audit trail on three revenue accounts would have said "operator" no
 * matter who pressed the button.
 */
async function audit(actor: string, action: string, entity: string, detail?: string) {
  await prisma.auditLog.create({
    data: { actor, action, entity, detail: detail ?? null },
  })
}

/** Run a slot immediately rather than waiting for the schedule. Takes ~15s. */
export async function syncNow() {
  const user = await requireOperator()
  const result = await runSlot('manual')
  await audit(user.email, 'sync.now', 'ScrapeRun', `status=${result.status} detected=${result.detected}`)
  revalidatePath('/')
  return result
}

export interface SendNowResult {
  ok: boolean
  message: string
  /** true when the account hit an Instagram checkpoint. Nothing may retry. */
  challenged?: boolean
}

/**
 * Send it. For real.
 *
 * Opens the sending account's own logged-in Chrome profile, navigates feed →
 * profile → Message, pastes the drafted body, verifies the composer contains
 * exactly that body, presses Enter, and confirms the message appears in the thread.
 * Takes roughly 30-60 seconds and a Chrome window will be visible while it runs —
 * that visibility is deliberate, not a debug leftover.
 *
 * Guards, in the order they bite:
 *
 *   1. `recheckBeforeSend` — the SAME gate autopilot runs: still waiting, account
 *      ACTIVE and connected, route on, channel not retired, THEY HAVE NOT REPLIED,
 *      and neither daily cap spent. The only difference from the unattended path is
 *      that a human being present substitutes for the auto-send switch.
 *   2. An atomic claim to SENDING, so two clicks cannot become two messages.
 *   3. The Chrome profile must be logged in as exactly this sender.
 *   4. The composer must contain our message before Enter is pressed.
 *   5. The message must appear in the thread before it is recorded as SENT.
 *
 * A checkpoint marks the sender CHALLENGED and halts it. That state is cleared by a
 * human who has looked at the account, never automatically.
 *
 * `overrides` carries stops the operator acknowledged in the on-demand dialog. It is
 * intersected with OVERRIDABLE_BLOCKS inside the gate, never trusted as given — a
 * server action is reachable by anything that can reach the page, so the whitelist
 * has to hold at the gate rather than at the caller. An overridden send is recorded
 * with a different `sentBy` so the audit trail never conflates "the system decided
 * this was fine" with "a person overruled it".
 */
export async function sendNow(attemptId: string, overrides?: readonly string[]): Promise<SendNowResult> {
  const user = await requireOperator()
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  const { sender, target } = attempt.pair

  /**
   * Guard 1 — the SAME re-check autopilot runs.
   *
   * This used to be three inline guards, and it silently lacked five that
   * `deliverWaiting` enforced: the route being switched off, the channel retired,
   * *they replied*, and both daily caps. A human clicking Send is not a reason to skip
   * any of those — it is only a reason not to require the account's unattended-sending
   * switch, which is the single difference `unattended: false` expresses.
   */
  const gate = await recheckBeforeSend(attempt, { unattended: false, overrides })
  if (!gate.ok) {
    const fix =
      gate.reason === 'no-session'
        ? ` Press Connect on its row, and log in in the Chrome window that opens.`
        : ''
    return { ok: false, message: `@${sender.handle}: ${gate.detail ?? gate.reason}.${fix}` }
  }

  /**
   * Guard 2 — claim it ATOMICALLY.
   *
   * This was a check-then-act: read the status, then write SENDING as a separate
   * statement, under a comment asserting "a double click cannot double send". Two
   * clicks, two operators, or a click racing a slot's `deliverWaiting` all passed the
   * read before either wrote. `deliverWaiting` got this right with a conditional
   * updateMany; the button did not. Condition and write in one statement.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: { in: ['READY', 'QUEUED'] } },
    data: { status: 'SENDING' },
  })
  if (claimed.count === 0) {
    const now = await prisma.outreachAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true },
    })
    return { ok: false, message: `already ${(now?.status ?? 'gone').toLowerCase()} — nothing sent` }
  }

  /**
   * Claim the recipient's daily allowance atomically — the SAME call `deliverWaiting`
   * makes, for the same reason.
   *
   * The gate above counts and compares, which two callers both pass. A daily cap is one
   * of the stops a human may NOT cross (crossing cooldown sends one extra message to one
   * person; crossing a daily cap has no bound at all), so the button claims exactly as
   * the slot does and refuses on the same terms.
   */
  const sendSettings = await getSettings()
  const claim = await claimForAttempt({
    attemptId,
    pairId: attempt.pairId,
    maxPerPairPerDay: sendSettings.maxPerPairPerDay,
    /**
     * `attended: true` skips the fleet's HOURLY bucket and only that one.
     *
     * The hourly bucket is pacing — it exists so fourteen unattended drafts cannot leave
     * inside one hour. A person pressing Send, once, is not a cluster, and refusing them
     * because a scheduled tick used this hour's pace would make the button unreliable for
     * exactly the case it was built for. The fleet's DAILY bucket still binds, because
     * that is a volume ceiling and daily caps are not crossable here: crossing cooldown
     * sends one extra message to one person, crossing a daily cap has no bound at all.
     */
    fleetMaxPerDay: sendSettings.fleetMaxPerDay,
    attended: true,
  })
  if (!claim.ok) {
    await prisma.outreachAttempt.updateMany({
      where: { id: attemptId, status: 'SENDING' },
      data: { status: 'READY' },
    })
    return { ok: false, message: `@${sender.handle}: ${claim.detail}.` }
  }

  /**
   * What was ACTUALLY crossed, not what the caller asked to cross. Computed from the
   * whitelist so a stray or malicious value can neither reach the gate nor appear in
   * the audit trail as though it had.
   */
  const crossed = (overrides ?? []).filter(isOverridable)

  await audit(
    user.email,
    crossed.length > 0 ? 'attempt.send.start.override' : 'attempt.send.start',
    `OutreachAttempt:${attemptId}`,
    `@${sender.handle} → @${target.handle}${crossed.length > 0 ? ` — crossed: ${crossed.join(', ')}` : ''}`,
  )

  /**
   * ── THE FLEET-WIDE SEND LOCK ────────────────────────────────────────────
   *
   * There is one OS clipboard and `sendDm` pastes the body from it. Two sends running at
   * once can interleave copy and paste and put **message A into thread B**. The atomic
   * READY→SENDING claim above does not cover this: it stops the SAME message going twice
   * and says nothing about two DIFFERENT messages racing — which is precisely what a click
   * landing during a dispatcher tick is. `runSlot`'s lock comment already reasoned about
   * this hazard while only protecting slots from slots.
   *
   * Refused rather than queued. Waiting would hold a server action open for the 40 seconds
   * of somebody else's send, and the honest answer is that the message is still there.
   */
  const outcome = await withSendLock(`operator:${sender.handle}`, () =>
    browserSender.send({
      attemptId,
      senderHandle: sender.handle,
      sessionPath: profileStatus(sender.handle).dir,
      targetHandle: target.handle,
      body: attempt.renderedBody,
    }),
  )

  if (outcome === null) {
    // Nothing was driven, so give back everything claimed and put the draft back.
    await settleClaims(claim.held, { delivered: false, attempted: false })
    await prisma.outreachAttempt.updateMany({
      where: { id: attemptId, status: 'SENDING' },
      data: { status: 'READY' },
    })
    return {
      ok: false,
      message: 'Another message is being sent right now. Nothing was sent — try again in a minute.',
    }
  }

  await settleClaims(claim.held, {
    delivered: outcome.status === 'SENT',
    failureCode: outcome.status === 'FAILED' ? outcome.failureCode : null,
  })

  if (outcome.status === 'SENT') {
    // SENT commits alone; the variant bump follows best-effort. They shared a
    // transaction, so a lock timeout on a rotation statistic could roll back the record
    // of a DM the recipient already had. See `recordSend.ts`.
    await recordDelivered({
      attemptId,
      variantId: attempt.variantId,
      // An overridden send is a materially different event and must be legible as one
      // months later, when the only record of why is this string.
      sentBy: crossed.length > 0 ? `override(${crossed.join('+')}):${sender.handle}` : `operator:${sender.handle}`,
      threadUrl: outcome.threadUrl,
    })
    await audit(
      user.email,
      crossed.length > 0 ? 'attempt.sent.override' : 'attempt.sent.auto',
      `OutreachAttempt:${attemptId}`,
      outcome.threadUrl ?? 'delivered',
    )
    // A delivered send is PROOF the session works — the one sanctioned clearing besides
    // an identity-verified hand login. A no-op when nothing was marked.
    await clearSessionInvalid(sender.id, `a send to @${target.handle} delivered`)
    revalidatePath('/')
    return { ok: true, message: `Sent to @${target.handle} from @${sender.handle}.` }
  }

  const error = outcome.status === 'FAILED' ? outcome.error : 'sender returned no outcome'
  const failureCode = outcome.status === 'FAILED' ? outcome.failureCode : 'unknown'

  if (outcome.status === 'FAILED' && outcome.challenged) {
    // Halt the account. Not a retry, not a backoff — a stop. `markChallenged` writes
    // `challengedAt` too, which the fleet breaker reads; four paths set this status and one
    // of them omitting the timestamp would make the breaker permit.
    await markChallenged({ senderId: sender.id, handle: sender.handle, detail: error, actor: user.email })
    await prisma.outreachAttempt.update({
      where: { id: attemptId },
      data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
    })
    revalidatePath('/')
    return {
      ok: false,
      challenged: true,
      message: `Instagram showed a checkpoint for @${sender.handle}. Sending is halted for that account and nothing was retried. Open the account by hand before doing anything else.`,
    }
  }

  if (outcome.status === 'FAILED' && outcome.sessionInvalid) {
    /**
     * The session is dead — a login form (or the wrong account) where a session was
     * expected. Record the evidence through the one writer so the `no-session` stop
     * holds this account everywhere until a hand login proves otherwise. The draft
     * stays READY: nothing is wrong with the message, only with the account.
     */
    await markSessionInvalid({ senderId: sender.id, handle: sender.handle, detail: error, actor: user.email })
    await prisma.outreachAttempt.update({
      where: { id: attemptId },
      data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
    })
    revalidatePath('/')
    return {
      ok: false,
      message:
        `@${sender.handle} is logged out of Instagram — the message was not sent and is still waiting. ` +
        `Sign the account in again (Connect on the accounts page), then send it.`,
    }
  }

  if (failureCode === 'not-in-thread') {
    /**
     * NOT returned to READY. Phase 5, and the same policy the unattended path now uses.
     *
     * The composer cleared and the message never appeared, so the recipient may already
     * have it AND the account may be restricted. Handing it back with a Send button beside
     * it invites the one action that is wrong in both cases. It parks in FAILED, where
     * nothing automatic reads it, and appears on `/messages` under "check the thread" with
     * the two buttons that resolve it. The reservation is kept.
     */
    await prisma.outreachAttempt.update({
      where: { id: attemptId },
      data: { status: 'FAILED', error, failureCode, attempts: { increment: 1 } },
    })
    log.alarm('composer cleared but the message never appeared — NOT retried, a human must read the thread', {
      attemptId,
      sender: sender.handle,
      target: target.handle,
      check: `pnpm ig:thread ${sender.handle} ${target.handle}`,
    })
    await audit(user.email, 'attempt.send.uncertain', `OutreachAttempt:${attemptId}`, error)
    revalidatePath('/')
    return {
      ok: false,
      message:
        /* This used to end `the message is waiting under "check the thread"` and named a
           section removed on 2026-08-24. A refusal that sends a person to a screen which
           cannot answer it is worse than one that says plainly there is nothing to press. */
        `The message was accepted by the composer but never appeared in the thread with @${target.handle}. ` +
        `It has NOT been re-queued and will not be retried: @${target.handle} may already have it. ` +
        `Open the conversation if you want to know which it was — nothing on the dashboard will ask you again, ` +
        `and @${sender.handle} will not write to them again.`,
    }
  }

  // Everything else: leave the draft intact so it can be retried or sent by hand.
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
  })
  await audit(user.email, 'attempt.send.failed', `OutreachAttempt:${attemptId}`, error)
  revalidatePath('/')
  return { ok: false, message: error }
}

/**
 * Write a message to a chosen channel from a chosen account, right now.
 *
 * The scheduled path exists so nobody has to think about spacing. This is the escape
 * hatch for when someone has a reason the system does not know about — a phone call,
 * an event, a warm introduction — and it deliberately does not ask what that reason
 * is. What it does instead is tell the operator precisely which of the normal rules
 * they are about to cross, in a sentence each, before anything is sent.
 *
 * Preparing is NOT sending. This returns a draft and a list of warnings; delivery
 * needs a second, explicit call to `sendNow` carrying the acknowledged codes. An
 * abandoned draft is an ordinary waiting message with the usual Send and Discard
 * controls beside it, so there is no half-created state to clean up.
 */
export async function prepareOnDemandSend(
  senderHandle: string,
  targetHandle: string,
): Promise<OnDemandPreview> {
  const user = await requireOperator()
  const preview = await prepareOnDemand(senderHandle, targetHandle)
  await audit(
    user.email,
    preview.ok ? 'ondemand.prepared' : 'ondemand.refused',
    `OutreachAttempt:${preview.attemptId ?? '-'}`,
    `@${senderHandle} → @${targetHandle}` +
      (preview.ok
        ? preview.warnings.length > 0
          ? ` — warnings: ${preview.warnings.map((w) => w.reason).join(', ')}`
          : ''
        : ` — blocked: ${preview.blocks.map((b) => b.reason).join(', ')}`),
  )
  if (preview.ok) revalidatePath('/')
  return preview
}

/*
  ── `markReplyHandled` WAS DELETED HERE (2026-08-25, Tabish) ──────────────────

  It wrote `replyHandledAt` / `replyHandledBy` and was the "I have replied" button's only
  caller. Both that button and "Open inbox" were removed from the reply card on his
  instruction: *"There is no need for clicking 'I have replied' or 'Open Inbox'. Remove
  this entirely, fleet resumes on its own after 7 days anyways."*

  He is right on the mechanism and the measurement agreed with him before it went: across
  ALL 71 replies this system has ever recorded, `replyHandledAt` was non-null 0 times. The
  early release had never once been used, and the halt has never leaked (0 sends delivered
  to a recipient inside their own halt window).

  An exported server action with no caller is not free — it is reachable by anything that
  can reach the page — so it is deleted rather than orphaned. The COLUMNS survive: dropping
  them is a live-Postgres migration for no behavioural gain, and the queries still filter
  `replyHandledAt: null` so re-adding a release is one UI change and no schema work.
*/

/**
 * Settle a post the classifier could not: was this actually a paid placement?
 *
 * ── WHY THIS SHIPS IN THE SAME COMMIT AS THE FOOTAGE CHECK ──────────────────
 *
 * `humanLabel`, `labelledBy` and `labelledAt` have existed on `DetectedCampaign` since
 * the schema was written and NOTHING HAS EVER WRITTEN TO THEM. There were 17 REVIEW rows
 * on this database, the oldest six days old, and no control anywhere to resolve one.
 *
 * That was survivable while REVIEW meant "the classifier was unsure". It stops being
 * survivable the moment reading a post's FOOTAGE can put a post here: escalating the
 * Thane bus to REVIEW without a way to answer it converts an invisible miss into an
 * unactionable one, which is worse, because the queue LOOKS like it is being handled.
 *
 * It is also the only way the one measurement that matters can ever exist. `ig:accuracy`
 * scores captions against caption-derived labels, so by construction it cannot measure
 * recall on placements that live only in the footage. A person answering these is the
 * only source of that label — every answer here is a row in the harness that does not
 * exist yet.
 *
 * ONE WRITER, like `markChallenged` and `markSessionInvalid`. A verdict set by a person
 * is stamped `verdictSource: 'human'` so it can never be counted as a model's opinion or
 * a #Collaboration fact — and `ig:accuracy` scopes to `verdictSource: 'rules'`, so human
 * answers can never contaminate the harness they exist to feed.
 */
export async function labelPost(shortcode: string, wasPaid: boolean): Promise<MutationResult> {
  const user = await requireOperator()
  const post = await prisma.detectedCampaign.findUnique({
    where: { shortcode },
    include: { target: { select: { handle: true } } },
  })
  if (!post) return { ok: false, message: 'That post is no longer stored.' }

  await prisma.detectedCampaign.update({
    where: { shortcode },
    data: {
      humanLabel: wasPaid,
      labelledBy: user.email,
      labelledAt: new Date(),
      /**
       * The person's answer REPLACES the verdict, because they looked at the post and the
       * classifier only read text about it. Recorded as `human` so no screen and no
       * measurement can mistake it for a judgement anything else made.
       */
      verdict: wasPaid ? 'CAMPAIGN' : 'ORGANIC',
      verdictSource: 'human',
    },
  })
  /**
   * ── AND THE CASCADE, WHICH SETTING THE VERDICT DOES NOT COMPLETE ─────────
   *
   * Flipping `verdict` to ORGANIC reaches five consumers automatically, because every one of
   * them queries `verdict: 'CAMPAIGN'` — `unusedCampaignCount`, `pickHook`, `autoResolve`,
   * the hook renderer and the nav badge. That is the easy half and it needs no code.
   *
   * What it does NOT reach is `TargetAccount.discoveredFromCampaignId`. A company becomes a
   * prospect BECAUSE of a paid post, and saying "this post was ordinary" says the reason
   * that company is in our database was wrong — but the row sits there, messageable, and
   * nothing looks back at the post that created it.
   *
   * So a dismissal also retires any prospect whose ONLY provenance was this post AND which
   * has never been written to. Both conditions matter:
   *
   *   never written to   a company that already received a message stays, because
   *                      `optedOut` is about future contact and the send history is the
   *                      record of what a real person actually got.
   *   only provenance    `discoveredFromCampaignId` holds ONE id, so a company found in
   *                      this post is a company found here and nowhere else. If that ever
   *                      becomes a list, this has to count the survivors instead.
   *
   * Retired rather than deleted, for the reason `removeTarget` documents: retirement is a
   * flag on the target that `governor.ts` and `gate.ts` both check, and a promise carried by
   * a deleted row would survive exactly one pass of `ensureFleetPairs`.
   */
  let retired = 0
  if (!wasPaid) {
    const orphaned = await prisma.targetAccount.findMany({
      where: { discoveredFromCampaignId: post.id, optedOut: false, attempts: { none: {} } },
      select: { id: true, handle: true },
    })
    if (orphaned.length > 0) {
      const r = await prisma.targetAccount.updateMany({
        where: { id: { in: orphaned.map((o) => o.id) } },
        data: { optedOut: true },
      })
      retired = r.count
      await audit(
        user.email,
        'target.retired.with.post',
        `TargetAccount:${orphaned.map((o) => o.handle).join(',')}`,
        `the post they were found in (${shortcode}) was marked ordinary`,
      )
    }
  }

  await audit(user.email, 'post.labelled', `DetectedCampaign:${shortcode}`, `paid=${wasPaid} @${post.target.handle}`)
  revalidatePath('/paid-posts')
  revalidatePath('/targets')
  return {
    ok: true,
    message: wasPaid
      ? `Recorded as paid. @${post.target.handle} is a live prospect for this placement.`
      : retired > 0
        ? `Marked ordinary, and ${retired} company${retired === 1 ? '' : 'ies'} found only in this post will not be messaged.`
        : `Marked ordinary.`,
  }
}

/**
 * Confirm a message was sent by hand. Still needed: if you send from your phone, or
 * the automated path fails and you finish it yourself, the record has to catch up
 * or the agent will prepare a duplicate.
 */
export async function markSent(attemptId: string): Promise<MutationResult> {
  const user = await requireOperator()
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })

  /**
   * Only from a state where the message was not already recorded as delivered.
   *
   * This returned early for SENT alone, so SKIPPED, SENDING and — worst — REPLIED could
   * all be flipped to SENT. Flipping REPLIED keeps `repliedAt` but changes the status,
   * desynchronising the two: status-based queries stop seeing the reply while
   * `repliedAt`-based ones still do, so the same conversation reads as answered to one
   * guard and unanswered to another. It also incremented the variant's usage counter on
   * every call.
   */
  if (attempt.status === 'SENT') return { ok: true, message: 'Already recorded as sent.' }
  if (attempt.status === 'REPLIED') {
    return { ok: false, message: 'They replied to that message — it is already recorded as delivered.' }
  }
  if (attempt.status === 'SENDING') {
    return { ok: false, message: 'That message is being sent right now — wait for it to finish.' }
  }

  await recordDelivered({ attemptId, variantId: attempt.variantId, sentBy: user.email })
  await audit(user.email, 
'attempt.sent',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}`,
  )
  revalidatePath('/')
  return { ok: true, message: `Recorded as sent to @${attempt.pair.target.handle}.` }
}

/** Longest body we will hand to the composer. Well above any real pitch. */
const MAX_BODY_CHARS = 4000

/**
 * Edit a drafted message before it goes.
 *
 * Allowed because the agent writing every message from scratch is a safety control,
 * not a claim that it writes them perfectly — and a human who spots a wrong detail
 * should be able to fix it rather than discard and hope the next draft is better.
 *
 * Only while the message is still waiting. Once it is SENDING a browser is already
 * typing it, and once SENT the recipient has it; editing the record afterwards would
 * make the audit trail describe a message nobody received.
 *
 * The stored body is the single source of truth downstream: the composer read-back
 * compares against exactly this text, so an edit is carried through the send guard
 * automatically rather than needing to be taught about.
 */
export async function editAttemptBody(attemptId: string, body: string): Promise<MutationResult> {
  const user = await requireOperator()
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })

  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') {
    return {
      ok: false,
      message:
        attempt.status === 'SENDING'
          ? 'That message is being sent right now — too late to edit.'
          : `That message is already ${attempt.status.toLowerCase()} and cannot be changed.`,
    }
  }

  const next = body.replace(/\r\n/g, '\n').trim()
  if (next.length === 0) return { ok: false, message: 'A message cannot be empty. Discard it instead.' }
  if (next.length > MAX_BODY_CHARS) {
    return { ok: false, message: `That is ${next.length} characters; the limit is ${MAX_BODY_CHARS}.` }
  }
  /**
   * Refuse a body the send guards cannot verify.
   *
   * `distinctiveSlice` returns null when no body line is distinctive enough to look
   * for on the page. Saving such a body is not harmless: the composer read-back would
   * then refuse the send with "composer content does not match the drafted message",
   * which is true but points at entirely the wrong thing — the operator would go
   * hunting for a paste bug. Fail at the point of the mistake, with an explanation.
   */
  const bodyLines = next.split('\n').filter((l) => l.trim().length > 0)
  if (bodyLines.length < 2 || distinctiveSlice(next) === null) {
    /**
     * Two conditions, one message, because they are the same mistake.
     *
     * A single-line body defeats the interior-line rule: with nothing to strip,
     * `distinctiveSlice` has to use the only line there is, and if that line is the
     * greeting the needle is the target's name — which renders in the thread header
     * regardless of whether anything was delivered. `renderMessage` never produces a
     * one-line body, so this is only reachable by editing, which is exactly why it is
     * checked here.
     */
    return {
      ok: false,
      message:
        'That message is too short to verify on screen before sending. It needs a greeting line and at least one sentence of 40 characters or more below it — and that sentence has to be your own wording, not the "I\'m …" introduction or the signature, since those are identical in every message this account sends.',
    }
  }

  if (next === attempt.renderedBody.trim()) return { ok: true, message: 'No changes.' }

  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { renderedBody: next } })
  await audit(user.email, 
'attempt.edited',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}, ${attempt.renderedBody.length} → ${next.length} chars`,
  )
  revalidatePath('/')
  return { ok: true, message: `Saved. ${next.length} characters.` }
}

/**
 * The autopilot toggle.
 *
 * Turning it ON means: at each slot, any armed account with a logged-in Chrome
 * profile sends its permitted message by itself, with no human present.
 *
 * `AUTOPILOT_ENABLED` in `.env` is a hard floor and is checked here rather than
 * only in the reader. A dashboard is a web page: anyone who can reach it can call
 * this action. The environment variable is the boundary a page cannot cross.
 */
export async function setAutopilot(on: boolean): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()
  if (on && !env.AUTOPILOT_ENABLED) {
    return {
      ok: false,
      message:
        'Autopilot is disabled for this deployment. Set AUTOPILOT_ENABLED=true in .env and restart — that switch is deliberately not changeable from this page.',
    }
  }
  await setSetting(SETTING_KEYS.autopilotEnabled, on ? 'true' : 'false')
  await audit(user.email, 'autopilot.set', 'Setting:autopilotEnabled', on ? 'ON' : 'OFF')
  revalidatePath('/')
  return {
    ok: true,
    message: on ? 'Autopilot on — armed accounts will send at each slot.' : 'Autopilot off — messages will wait for you.',
  }
}

/**
 * Put a PARKED draft back in the queue, after a person has fixed what parked it.
 *
 * Reachable only for FAILED rows that are provably undelivered — `not-in-thread` is
 * excluded exactly as it is in `discardAttempt`, because those may have reached the
 * recipient and have their own two-button resolution. `attempts` resets to zero, or the
 * retry cap would park the row again on its first failure and the button would appear
 * to do nothing.
 */
export async function requeueParkedAttempt(attemptId: string): Promise<MutationResult> {
  const user = await requireOperator()
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: 'FAILED', failureCode: { not: 'not-in-thread' } },
    data: { status: 'READY', attempts: 0, error: null, failureCode: null },
  })
  if (claimed.count === 0) {
    /* `not-in-thread` is excluded by the where clause above, and since 2026-08-24 there is no
       flow to point at — so the refusal says what is true rather than naming a deleted screen. */
    return {
      ok: false,
      message:
        'That message is not parked, or it is one Instagram may already have delivered — those are never re-queued.',
    }
  }
  await audit(user.email, 'attempt.requeued', `OutreachAttempt:${attemptId}`, 'parked draft returned to the queue by an operator')
  revalidatePath('/')
  return { ok: true, message: 'Back in the queue. The next tick will try it again from the start.' }
}

/**
 * The standard message, editable — with the floor checked AT SAVE (2026-08-17, Tabish:
 * "provide a universal template editor").
 *
 * `checkTemplateBody` renders a real sample through the SAME `renderMessage` the composer
 * uses and asks the SAME `distinctiveSlice` the send guards ask. The refusal it returns is
 * shown verbatim, because the failure it prevents — a template too short to carry a
 * quotable line — refuses EVERY send in the system and would otherwise surface hours later
 * as a sending outage with nothing pointing at the edit.
 *
 * Existing drafts keep the bytes they were written with; the gate compares against the
 * STORED body, so an edit here never silently rewrites a message somebody already read.
 * `pnpm ig:discard-stale-drafts` is the broom for a queue drafted under old copy, and the
 * form says so beside the Save button.
 *
 * Passing null (or only whitespace) resets to the shipped copy — deleting the override is
 * how "back to standard" works, so there is no second copy of the standard text to drift.
 */
export async function setSingleTemplateBody(body: string | null): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()

  if (body === null || body.trim().length === 0) {
    await prisma.setting.deleteMany({ where: { key: SETTING_KEYS.singleTemplateBody } })
    await audit(user.email, 'setting.changed', 'Setting:singleTemplateBody', 'reset to the shipped standard message')
    revalidatePath('/')
    return { ok: true, message: 'Back to the standard message. New drafts use the shipped copy.' }
  }

  const verdict = checkTemplateBody(body)
  if (!verdict.ok) return { ok: false, message: verdict.reason }

  await setSetting(SETTING_KEYS.singleTemplateBody, body.trim())
  await audit(
    user.email,
    'setting.changed',
    'Setting:singleTemplateBody',
    `standard message edited (${body.trim().length} chars)`,
  )
  revalidatePath('/')
  return {
    ok: true,
    message:
      'Saved. New drafts use this text. Messages already waiting keep the copy they were ' +
      'written with — discard them if the old wording should not go out.',
  }
}

/**
 * THE PER-ACCOUNT "AUTO-SEND" TOGGLE IS GONE — ONE SWITCH, 2026-08-08.
 *
 * `setAccountAutopilot` used to live here, and its argument was that accounts should
 * graduate one at a time. The mechanism that actually does that is the cohort LADDER, which
 * is derived from history and cannot be clicked past; the toggle was a second, weaker copy
 * of the same idea that an operator had to remember to flip. Tabish: *"The moment autopilot
 * is turned on there must be no more switches."*
 *
 * What replaced it, so nothing was merely removed:
 *   - `setAutopilot` above is the ONE switch. It is tracked, and it is the whole permission.
 *   - Whether a given account CAN send is now an ability rather than a setting: a hand
 *     login, an ACTIVE status, its own signature, and its group's soak served.
 *   - `mayArmAccount` — this action's other caller — is UNTOUCHED and is asked by `gate.ts`
 *     at the moment of delivery, so the 14-day ladder is enforced on the send path itself
 *     rather than at a button nobody may now press.
 */

// ── Connecting an account ───────────────────────────────────────────────────

/**
 * Open the Chrome window so the operator can log this account in.
 *
 * This is the dashboard equivalent of `pnpm ig:login`, and it is deliberately the
 * same underlying flow: the account's own persistent profile, a real Chrome window,
 * a human typing the password into Instagram's own form. What is NOT happening here
 * is worth stating because it is the whole safety argument — no credential is read
 * by this process, and no session is imported from anywhere.
 */
export async function connectAccount(handle: string): Promise<ConnectState> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { state: 'error', message: `@${handle} is not one of your accounts` }
  await audit(user.email, 'sender.connect.start', `SenderAccount:${handle}`)
  const result = await startConnect(handle)
  // `startConnect` can report connected immediately (the profile was already logged in,
  // identity-verified against Instagram) — a path `checkConnect` never sees, so it must
  // be recorded here or that login leaves no trace.
  if (result.state === 'connected') await recordConnected(handle, user.email, result.verified)
  return result
}

/** Polled by the page every few seconds while the Chrome window is open. */
export async function checkConnect(handle: string): Promise<ConnectState> {
  const user = await requireOperator()
  const result = await pollConnect(handle)
  if (result.state === 'connected') await recordConnected(handle, user.email, result.verified)
  return result
}

/**
 * Records the session. Deliberately does NOT touch `status`.
 *
 * This set `status: 'ACTIVE'`, reasoning that a fresh hand login is what clears a
 * CHALLENGED account. But `connected` is returned on paths where no login happens —
 * `pollConnect`'s no-window fallback reports connected purely from a cookie on disk with
 * no identity check at all. So "Instagram flagged the account -> CHALLENGED -> press
 * Connect -> silently ACTIVE" took one click and inspected nothing, which is the opposite
 * of what the halt is for. Clearing it is now `clearChallenge`, a separate deliberate act.
 *
 * The dead-session mark follows the same discipline: cleared only when `verified` — the
 * connect flow resolved the session against Instagram and it matched this handle. A
 * cookie surviving on disk is exactly the evidence `sessionInvalidAt` exists to overrule,
 * so an unverified "connected" must not clear it.
 */
async function recordConnected(handle: string, userEmail: string, verified: boolean): Promise<void> {
  const st = profileStatus(handle)
  const sender = await prisma.senderAccount.update({
    where: { handle },
    data: { sessionPath: st.dir, sessionSavedAt: new Date() },
  })
  if (verified) await clearSessionInvalid(sender.id, 'hand login via the dashboard, identity verified against Instagram')
  await audit(userEmail, 'sender.login', `SenderAccount:${handle}`, `connected via dashboard into ${st.dir}`)
  revalidatePath('/')
}

/**
 * Clear a CHALLENGED halt, after a human has actually looked at the account.
 *
 * Separate from connecting on purpose. A checkpoint means Instagram took action; the
 * session may well still be valid, so "the session works" is not evidence the cause was
 * addressed. The only thing that should lift this is a person confirming they opened the
 * account and dealt with whatever Instagram was asking.
 *
 * Deliberately does NOT re-enable auto-send. Coming back from a halt and returning to
 * unattended sending are two decisions, and this is only the first.
 */
export async function clearChallenge(handle: string): Promise<MutationResult> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: `@${handle} not found.` }
  if (sender.status !== 'CHALLENGED') {
    return { ok: false, message: `@${handle} is ${sender.status} — nothing to clear.` }
  }
  if (!profileStatus(handle).hasSession) {
    return { ok: false, message: `@${handle} is not connected. Press Connect first, then clear the halt.` }
  }

  /**
   * `clearChallenged` nulls `challengedAt` as well as setting the status.
   *
   * That is what RELEASES the fleet circuit breaker. Since Phase 5 a checkpoint on any one
   * account halts every other account too — they all drive the same code path from one
   * residential IP, so a flag is evidence about the pattern rather than about the account
   * — and clearing the halt is the good way out of that. The other way is waiting out the
   * 24-hour window, which exists only so an un-cleared flag cannot wedge the fleet forever.
   */
  await clearChallenged(sender.id)
  await audit(user.email, 'sender.challenge.cleared', `SenderAccount:${handle}`, 'operator confirmed they checked the account')
  revalidatePath('/')
  return {
    ok: true,
    message:
      `@${handle} is active again, and unattended sending across the fleet is released. ` +
      `Auto-send for this account is still off — arm it deliberately.`,
  }
}

export async function abortConnect(handle: string): Promise<{ ok: true }> {
  const user = await requireOperator()
  await cancelConnect(handle)
  await audit(user.email, 'sender.connect.cancel', `SenderAccount:${handle}`)
  revalidatePath('/')
  return { ok: true }
}

// ── Managing sending accounts ───────────────────────────────────────────────

export interface MutationResult {
  ok: boolean
  message: string
}

/**
 * Add a sending account.
 *
 * Three things have to happen together or the account is broken in a way that only
 * shows up at send time:
 *   - the persona, because rendering refuses to build a message without one
 *   - the follow-up variants, because the planner throws if a sender has none
 *   - a routing pair to every channel, because a sender with no pairs is inert
 *
 * New pairs start DISABLED. Adding an account should never, by itself, cause a
 * message to be sent — arming is a separate, deliberate act.
 */
export async function addSender(handleRaw: string, displayNameRaw: string): Promise<MutationResult> {
  const user = await requireOperator()
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()
  const displayName = displayNameRaw.trim() || handle

  try {
    assertSafeHandle(handle)
  } catch {
    return { ok: false, message: 'That is not a valid Instagram handle (letters, numbers, dots, underscores).' }
  }
  /**
   * ── SAY WHERE IT IS, NOT JUST THAT IT EXISTS (2026-08-17) ─────────────────
   *
   * This used to read *"@x is already one of your accounts."* — true, and it sent Tabish
   * looking for an account he could not see, so he concluded it had been deleted. It had
   * not: `pnpm ig:prune-pairs` had removed @tabishmukaddam1's 70 ROUTES, and the account row
   * survived exactly as designed (a pair is a route, the account is an identity).
   *
   * The page was not hiding it either — `AccountGroupView` collapses a group that needs no
   * attention, which is right at 65 accounts and means a healthy account is a click away.
   *
   * So the refusal now names the group it is in and the state it is in. *"If the person a
   * warning is FOR has to ask what it means, the warning has not done its job"* — already in
   * CLAUDE.md, about a different warning.
   */
  const existing = await prisma.senderAccount.findUnique({
    where: { handle },
    select: { fleetMember: true, status: true, sessionInvalidAt: true },
  })
  if (existing) {
    const where = !existing.fleetMember
      ? 'under “Not in the rotation — writes to nobody”'
      : existing.status === 'CHALLENGED'
        ? 'under “Needs you now”'
        : 'on this page — open the groups below to see it'
    return {
      ok: false,
      message:
        `@${handle} is already one of your accounts, ${where}. ` +
        `Nothing was changed. Removing its routes does not remove the account — the account is the identity, a route is permission to write to one recipient.`,
    }
  }
  /**
   * Being both a sender and a target is allowed — messaging one account you own from
   * another is the safest end-to-end rehearsal available, which is exactly why
   * `addTarget` permits it. This used to refuse it, so the same combined state was
   * reachable by adding the target second and forbidden by adding the sender second.
   *
   * The invariant that actually matters is narrower and is enforced below: a sender must
   * never message ITSELF, so that pair is simply not created.
   */
  const alsoATarget = await prisma.targetAccount.findUnique({ where: { handle } })

  const exists = await handleExists(handle)
  if (exists === 'missing') return { ok: false, message: `@${handle} does not exist on Instagram.` }

  // Persona is constant across senders per the brief. Copied from an existing
  // account so a new one cannot drift from the others.
  const template = await prisma.senderAccount.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!template) return { ok: false, message: 'No existing account to copy the persona from. Run pnpm db:seed.' }

  const sender = await prisma.senderAccount.create({
    data: {
      handle,
      displayName,
      personaName: template.personaName,
      personaRole: template.personaRole,
      personaBrand: template.personaBrand,
      personaPhone: template.personaPhone,
      personaEmail: template.personaEmail,
      autoSendEnabled: false,
      dailyCap: template.dailyCap,
      status: 'ACTIVE',
      /**
       * PHASE 9: which onboarding group this account joins.
       *
       * Never cohort 1 — that is the baseline the ladder measures against and it is exempt
       * from the soak, so a new account landing there would be armable immediately and the
       * whole staging mechanism would be bypassed by the first account added.
       */
      cohort: await nextCohort(),
    },
  })

  /**
   * BOTH pools. A sender needs channel variants and brand variants, because `plan.ts`
   * scopes the least-recently-used lookup by `targetKind` and throws when the pool it
   * needs is empty.
   *
   * This copied only the channel pool, so an account added here was born unable to pitch
   * a brand — and the symptom would be a thrown error naming the pool, on the first brand
   * pair, for whichever account had been designated to send them. Exactly what happened to
   * `@tabishmukaddam1`: added via the dashboard, 12 channel variants, zero brand.
   */
  await prisma.messageVariant.createMany({
    data: [
      ...MESSAGE_VARIANTS.map((v) => ({ senderId: sender.id, label: v.label, body: v.body, targetKind: 'CHANNEL' })),
      ...BRAND_MESSAGE_VARIANTS.map((v) => ({
        senderId: sender.id,
        label: v.label,
        body: v.body,
        targetKind: 'BRAND',
      })),
    ],
  })

  /**
   * ROUTES FROM THE NEW SENDER, THROUGH THE SHARED RULE.
   *
   * A NEW SENDER IS `fleetMember: true`, so this is the same hole from the other direction:
   * it excluded only the self-pair, so a new account was wired to `@bollywoodsocietyy` and
   * `@bollywoodchronicle` — target rows we watch for ground truth and must never message.
   * Reachable simply by adding the accounts in the opposite order to `addTarget`.
   *
   * The read happens AFTER the sender row is created, so `handle` is already in the fleet
   * set and its own target row (if it has one) is refused as `self` rather than needing a
   * separate check. A set read before the create would omit the account being added and let
   * its own self-pair through the very rule meant to refuse it.
   *
   * One statement, so a failure part-way cannot leave a sender wired to only some channels.
   */
  const targets = await prisma.targetAccount.findMany()
  const ourHandles = await fleetHandles(prisma)
  const allowed = targets.filter((t) =>
    routeAllowed({
      senderHandle: handle,
      targetHandle: t.handle,
      ourHandles,
      // From the row this action just created, never a literal: `addSender` sets
      // `fleetMember: true`, and a hardcoded `true` here would keep creating routes on the
      // day that default changes.
      senderIsFleetMember: sender.fleetMember,
      targetOptedOut: t.optedOut,
      // A new sender gets a route to every PROSPECT and to no watched publisher. Without
      // this a fresh account is wired to both competitors on the day it is added.
      targetIsWatchOnly: t.role === 'WATCH',
    }),
  )
  await prisma.outreachPair.createMany({
    data: allowed.map((t) => ({
      senderId: sender.id,
      targetId: t.id,
      cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
      enabled: true,
    })),
  })

  await audit(
    user.email,
    'sender.added',
    `SenderAccount:${handle}`,
    `${allowed.length} of ${targets.length} channels routed` +
      (allowed.length < targets.length ? ' (the rest are our own pages, retired, or itself)' : ''),
  )
  revalidatePath('/')
  return {
    ok: true,
    message:
      (exists === 'unknown'
        ? `Added @${handle}. Could not reach Instagram to confirm it exists — check the spelling. Connect it next.`
        : // ONE SWITCH: "then enable the channels you want it to message" named the per-route
          // chip, and signing in is now the whole remaining step.
          `Added @${handle}. Sign it in next — after that it sends whenever Autopilot is on.`) +
      (alsoATarget
        ? ` Note @${handle} is also a channel you watch; no route from it to itself was created.`
        : ''),
  }
}

/**
 * Remove a sending account.
 *
 * History is never deleted. Attempts record what was actually sent to real people,
 * and that record is what spacing, the unanswered-touch cap and the new-material
 * rule are computed from — deleting it would let the system re-contact someone it
 * has already written to. So an account with send history is retired (disabled,
 * disarmed, PAUSED) rather than destroyed; only a never-used account is deleted
 * outright.
 *
 * The Chrome profile is deliberately left on disk. Deleting it would throw away the
 * device identity built up by the hand login, which is unrecoverable and would make
 * a future re-add look like new hardware to Instagram.
 */
export async function removeSender(handle: string): Promise<MutationResult> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({
    where: { handle },
    include: { pairs: { include: { attempts: { where: { status: { in: ['SENT', 'REPLIED'] } } } } } },
  })
  if (!sender) return { ok: false, message: `@${handle} not found.` }

  await cancelConnect(handle)

  /**
   * OUT OF THE ROTATION FIRST, THEN THE QUEUE MOVES, THEN THE ROW IS SETTLED.
   *
   * `fleetMember: false` first, so the planner (which reads this flag live, on the
   * server) cannot elect this account for a fresh recipient in the window between the
   * hand-off reading the queue and the row being retired — otherwise a 15-minute
   * planning pass could re-create the very drafts just transferred away.
   *
   * Then the queue: Tabish's rule (2026-08-19) is that removing a sender must never
   * cost a message — every waiting draft moves to the account rotation would choose
   * next. Anything that cannot move (a recipient another account already covers, a
   * retired recipient) is discarded through the one discard writer, audited.
   */
  await prisma.senderAccount.update({ where: { handle }, data: { fleetMember: false } })
  const handOff = await handOffWaitingDrafts({ senderId: sender.id, senderHandle: handle, actor: user.email })
  const movedNote =
    handOff.transferred + handOff.discarded + handOff.kept === 0
      ? ''
      : ` Queue: ${handOff.transferred} draft${handOff.transferred === 1 ? '' : 's'} moved to other accounts by rotation` +
        (handOff.discarded > 0 ? `, ${handOff.discarded} discarded as already covered` : '') +
        (handOff.kept > 0 ? `, ${handOff.kept} could not move and stayed put` : '') +
        '.'

  const sentCount = sender.pairs.reduce((n, p) => n + p.attempts.length, 0)

  if (sentCount === 0) {
    await prisma.senderAccount.delete({ where: { handle } })
    await audit(
      user.email,
      'sender.deleted',
      `SenderAccount:${handle}`,
      `no send history; hand-off: ${handOff.transferred} moved, ${handOff.discarded} discarded, ${handOff.kept} kept`,
    )
    revalidatePath('/')
    return { ok: true, message: `Removed @${handle}. Its Chrome profile is left on disk in case you re-add it.${movedNote}` }
  }

  await prisma.$transaction([
    prisma.senderAccount.update({ where: { handle }, data: { autoSendEnabled: false, status: 'PAUSED' } }),
    prisma.outreachPair.updateMany({ where: { senderId: sender.id }, data: { enabled: false } }),
  ])
  await audit(
    user.email,
    'sender.retired',
    `SenderAccount:${handle}`,
    `${sentCount} sent messages kept; hand-off: ${handOff.transferred} moved, ${handOff.discarded} discarded, ${handOff.kept} kept`,
  )
  revalidatePath('/')
  return {
    ok: true,
    message:
      `@${handle} has sent ${sentCount} message${sentCount === 1 ? '' : 's'}, so it is retired rather than deleted — ` +
      `that history is what stops anyone being contacted twice.${movedNote}`,
  }
}

// ── Managing channels ───────────────────────────────────────────────────────

/**
 * Add a channel to watch.
 *
 * The detector is `semantic` — see the note at the `create` below for why that changed on
 * 2026-08-13 and why `passthrough` was right until it wasn't.
 *
 * PAIRS ARE CREATED LIVE, NOT DISABLED. This docblock said the opposite until 2026-08-13,
 * three months after the per-route chip was deleted: *"Pairs start DISABLED, for the same
 * reason as a new sender: adding something must never be the same act as starting to
 * message it."* Since 2026-08-08 a pair row IS a live route, so that sentence described a
 * brake that no longer exists — on the one action that creates a recipient.
 *
 * The promise it made is still kept, by different machinery: Autopilot (one switch, off),
 * the recipient-side caps, the 7-day cooldown and the cohort ladder. What is NOT kept any
 * more is per-row inertness, and anyone reading this should know which of the two they have.
 */
export async function addTarget(
  handleRaw: string,
  displayNameRaw: string,
  greetingRaw: string,
  /**
   * WHICH KIND OF TARGET — and it is REQUIRED, with no default, on purpose.
   *
   * The two kinds do opposite things: a WATCH row has its feed read forever and is never
   * written to; a PROSPECT is written to and never read. Defaulting either way makes one of
   * them the thing you get by not choosing, and this action is the one place a person adds
   * a recipient by hand. `RenderTarget.kind` was made required for exactly this reason and
   * the compiler then named all 24 call sites.
   */
  role: 'WATCH' | 'PROSPECT',
): Promise<MutationResult> {
  const user = await requireOperator()
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()
  const displayName = displayNameRaw.trim() || handle
  // The greeting is what the recipient literally reads first ("Hi <this>,").
  const greeting = greetingRaw.trim() || displayName

  try {
    assertSafeHandle(handle)
  } catch {
    return { ok: false, message: 'That is not a valid Instagram handle (letters, numbers, dots, underscores).' }
  }
  if (await prisma.targetAccount.findUnique({ where: { handle } })) {
    return { ok: false, message: `@${handle} is already a channel you watch.` }
  }

  /**
   * One fetch answers two questions: does it exist, and WHO does Instagram say it is. The
   * facts go into the result sentence — "filmigyan" exists (219 followers, a fan page)
   * while the page actually meant is @filmygyan (31.6M, verified), and a bare yes/no check
   * passes both identically. The wrong add must be visible to the person who just made it.
   */
  const { check: exists, facts } = await probeHandle(handle)
  if (exists === 'missing') return { ok: false, message: `@${handle} does not exist on Instagram.` }

  /**
   * A NEW CHANNEL IS JUDGED BY `semantic`, NOT `passthrough` — changed 2026-08-13.
   *
   * `passthrough` stores posts and judges NONE of them, and says so honestly
   * (`readiness()`: "this channel has no classifier set up"). It was the right default when
   * the only alternative was `mom`, a hand-written rule set for ONE publisher's
   * `#Collaboration` convention — applying that to an arbitrary channel would silently
   * mislabel posts, which is worse than judging nothing.
   *
   * It is the wrong default now, because `semantic` is general and measured: 95-97% correct
   * at 100% recall on the one channel with ground truth. What `passthrough` actually
   * produced was a channel added through this form storing posts forever, finding zero paid
   * campaigns, and rendering a card that says "not classified" — the failure the operator
   * would read as "they do no paid work".
   *
   * Cost is a fraction of a cent a post: MEASURED $0.0000239 with a 94% prompt-cache hit,
   * and 2.7 cents to classify the entire corpus. The add form says so rather than leaving
   * a spend to be discovered.
   *
   * `passthrough` stays reachable and is still the right answer for a channel we own and do
   * not want judged — it is simply no longer what you get by not choosing.
   */
  const target = await prisma.targetAccount.create({
    data: {
      handle,
      displayName,
      contactFirstName: greeting,
      kind: 'CHANNEL',
      role,
      /**
       * A WATCH row is added to be judged, so it gets the real classifier. A PROSPECT is
       * never read at all, so pointing one at a detector would fetch a feed every pass
       * forever for a row nobody classifies — the same reasoning as `brandTarget.ts`.
       */
      detectorKey: role === 'WATCH' ? 'semantic' : 'passthrough',
      /**
       * And the other half of the same decision: watching is what a WATCH row is FOR, and a
       * prospect's feed is not read. Explicit against a schema default of TRUE, because a
       * hand-added prospect quietly enrolling itself into detection is how a 60-row list
       * becomes a thousand requests a day.
       */
      watchEnabled: role === 'WATCH',
    },
  })

  /**
   * ROUTES TO THE NEW CHANNEL, THROUGH THE SHARED RULE.
   *
   * An account can be both a sender and a target — we watch our own pages for ground truth
   * — but a ROUTE between two accounts we own must never exist. This read every sender with
   * NO filter and excluded only the self-pair, so `addTarget('bollywoodsocietyy')` created
   * `madaboutmarketingg→bollywoodsocietyy` and `bollywoodchronicle→bollywoodsocietyy`:
   * exactly the routes `ensureFleetPairs` refuses to create, from one revenue page to
   * another. Inert while pairs were created disabled and a human had to flip a chip; LIVE
   * since nothing reads `enabled` (Tabish, 2026-08-08).
   *
   * Filtered rather than delegated to `ensureFleetPairs()`: this creates rows for ONE new
   * target across every sender, where `ensureFleetPairs` is scoped to `fleetMember: true`.
   *
   * THIS COMMENT USED TO END *"Calling it here would silently stop creating the burner's
   * rehearsal routes"*, defending an unfiltered read as deliberate. It was, and it was
   * wrong: MEASURED 2026-08-13, the burner held **72** pair rows created exactly this way,
   * and rehearsal never needed them — `prepareOnDemandSend` creates the one pair it wants
   * when a person picks both ends. The fleet question is now asked of `routes.ts` like
   * every other exclusion, so the read stays unfiltered and the RULE does the filtering.
   */
  const senders = await prisma.senderAccount.findMany()
  const ourHandles = await fleetHandles(prisma)
  const allowed = senders.filter((s) =>
    routeAllowed({
      senderHandle: s.handle,
      targetHandle: handle,
      ourHandles,
      senderIsFleetMember: s.fleetMember,
      targetOptedOut: target.optedOut,
      // A channel added to be WATCHED is never a recipient. `addTarget` is the one action
      // that creates a watched publisher, so this is where the two types are decided.
      targetIsWatchOnly: target.role === 'WATCH',
    }),
  )
  await prisma.outreachPair.createMany({
    data: allowed.map((s) => ({
      senderId: s.id,
      targetId: target.id,
      cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
      enabled: true,
    })),
  })

  await audit(
    user.email,
    'target.added',
    `TargetAccount:${handle}`,
    `${allowed.length} of ${senders.length} accounts routed` +
      (allowed.length < senders.length ? ' (the rest are our own pages, or itself)' : ''),
  )
  revalidatePath('/')
  // The form lives on /targets; revalidating only '/' left the list beside it stale, so a
  // successful add read as "nothing happened" until the next auto-refresh.
  revalidatePath('/targets')
  return {
    ok: true,
    /**
     * ONE SWITCH, 2026-08-08. This said "Turn on the accounts you want to message it from",
     * which named the per-route chip. There is no such control, and the routes were created
     * `enabled: true` a few lines above — so the old sentence sent an operator looking for a
     * switch AND implied adding a channel was inert. It is not: it is reachable the moment
     * Autopilot is on, which is the fact worth telling them.
     *
     * AND IT MUST MATCH THE ROLE (2026-08-20): the one sentence above was returned for
     * WATCH adds too, promising the fleet would write to a page whose whole definition is
     * that it is never written to. `addTargetMessage` is pure and tested in both roles,
     * and it carries Instagram's own identity facts — see its docblock for the filmigyan
     * measurement that forced this.
     */
    message: addTargetMessage(role, handle, exists, facts),
  }
}

/**
 * Stop watching a channel.
 *
 * Same rule as senders: a channel we have written to is retired, not deleted.
 * `optedOut` is a hard stop the governor checks independently of pairs, so it holds
 * even if a pair is re-enabled later by accident.
 */
export async function removeTarget(handle: string): Promise<MutationResult> {
  const user = await requireOperator()
  const target = await prisma.targetAccount.findUnique({
    where: { handle },
    include: { pairs: { include: { attempts: { where: { status: { in: ['SENT', 'REPLIED'] } } } } } },
  })
  if (!target) return { ok: false, message: `@${handle} not found.` }

  const sentCount = target.pairs.reduce((n, p) => n + p.attempts.length, 0)

  if (sentCount === 0) {
    await prisma.targetAccount.delete({ where: { handle } })
    await audit(user.email, 'target.deleted', `TargetAccount:${handle}`, 'never contacted')
    revalidatePath('/')
    return { ok: true, message: `Stopped watching @${handle} and removed it.` }
  }

  await prisma.$transaction([
    prisma.targetAccount.update({ where: { handle }, data: { optedOut: true } }),
    prisma.outreachPair.updateMany({ where: { targetId: target.id }, data: { enabled: false } }),
  ])
  await audit(user.email, 'target.retired', `TargetAccount:${handle}`, `${sentCount} sent messages kept`)
  revalidatePath('/')
  return {
    ok: true,
    message: `Stopped messaging @${handle}. ${sentCount} sent message${sentCount === 1 ? '' : 's'} kept, so it can never be contacted again by accident.`,
  }
}

/**
 * THE PER-ROUTE CHIP IS GONE — ONE SWITCH, 2026-08-08.
 *
 * `setPairEnabled` used to turn one sender→recipient route on or off. Two reasons it went,
 * and the second is the one that matters:
 *
 * 1. It never scaled. At 65 senders × 60 recipients it is 3,900 controls, and `/prospects`
 *    was built in Phase 7 precisely because nobody decides 3,900 routes one at a time.
 * 2. It was a SWITCH BEHIND THE SWITCH. Autopilot could read ON, every account signed in,
 *    and nothing send — because a route somewhere was off. That is exactly the
 *    "nothing happened and nothing says why" failure this project keeps rediscovering.
 *
 * Which routes may exist is now one rule, `routeAllowed` in `src/outreach/routes.ts`, and
 * `ensureFleetPairs` creates every one of them. The stops that used to be expressible by
 * switching a route off are still expressible, by the controls that MEAN them:
 *   - stop writing to a recipient  → retire them (`removeTarget`; `optedOut` is a hard stop
 *     the governor checks independently, which a disabled pair never was)
 *   - stop an account sending      → its session, its status, or `fleetMember`
 * `OutreachPair.enabled` survives in the schema and is still read; nothing on a page sets it.
 */

/**
 * Discard a queued message without sending. Does not start the cooldown.
 *
 * The claim, the status guard and the audit row live in `src/outreach/discard.ts` —
 * ONE writer, shared with `pnpm ig:dedupe-drafts`, which had to discard 15 rows from a
 * terminal and cannot reach a server action. What must not drift between the two is the
 * status guard inside the update; the docblock there says why.
 */
export async function skipAttempt(attemptId: string, reason: string): Promise<MutationResult> {
  const user = await requireOperator()
  const result = await discardAttempt({
    attemptId,
    reason: reason || 'skipped by operator',
    actor: user.email,
  })
  if (!result.ok) return result
  revalidatePath('/')
  return result
}

/**
 * Set the persona a sending account introduces itself with.
 *
 * DECISION 3b, made fixable from the page instead of Prisma Studio.
 *
 * All four accounts shipped with the identical *Kapil Jain, Co-founder, Bollywood Society*
 * block, so a DM from @madaboutmarketingg introduces the co-founder of a different company.
 * That went unnoticed for weeks because nothing on screen ever showed the persona, and it
 * could only be changed by editing the database by hand.
 *
 * `validatePersona` runs BEFORE the write, so an invalid phone or email is refused rather
 * than saved and then discovered by the planner. That value is reproduced verbatim in every
 * message this account ever sends; the original brief carried an 11-digit "10-digit" number
 * and it would have appeared in all of them.
 *
 * Distinctness is deliberately NOT enforced here. Two accounts may share a persona — that
 * is the state today and channel outreach runs on it. What is refused is a BRAND pitch from
 * a shared persona, in `brandGuards.ts`, because a brand's social team checks. Blocking the
 * save as well would make the state unrepresentable and force whoever is mid-edit to get all
 * four right in one atomic step.
 */
export async function setPersona(
  handle: string,
  persona: { name: string; role: string; brand: string; phone: string; email: string },
): Promise<MutationResult> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: 'That account no longer exists.' }

  const candidate = {
    personaName: persona.name.trim(),
    personaRole: persona.role.trim(),
    personaBrand: persona.brand.trim(),
    personaPhone: persona.phone.trim(),
    personaEmail: persona.email.trim(),
  }

  const problems = validatePersona(candidate)
  if (problems.length > 0) {
    // Refuse rather than save. This text is in every outgoing message.
    return { ok: false, message: problems.join(' ') }
  }

  await prisma.senderAccount.update({ where: { id: sender.id }, data: candidate })

  await audit(
    user.email,
    'sender.persona.set',
    `SenderAccount:${handle}`,
    `${candidate.personaName}, ${candidate.personaRole}, ${candidate.personaBrand}`,
  )
  revalidatePath('/')
  return { ok: true, message: 'Saved.' }
}

/**
 * "IT'S A COMPANY" / "NOT A COMPANY" ARE GONE — ONE SWITCH, 2026-08-08.
 *
 * `confirmBrand` and `dismissBrandCandidate` were the two buttons on every handle
 * Instagram's category endpoint could not classify. They existed because there was
 * genuinely no automatic answer: measured 2026-08-03, everything still readable is
 * IDENTICAL for @tilara.india (a brand) and @adityathackeray (a politician), so a rule
 * over those fields would have messaged the politician.
 *
 * Tabish, on seeing @adidas sitting in that queue: *"How can adidas not be recognized as
 * anything? I do not want this option to select manually, correct it."*
 *
 * The answer was a different INPUT, not a button. `src/detection/decideBrand.ts` asks the
 * model — about the handle AND the paid post it appeared in, which is evidence the endpoint
 * never had — and `autoResolve.ts` runs it from the pipeline, so the queue is answered
 * before anyone could have opened it. `brandTarget.ts` is the one creator of BRAND targets.
 *
 * The safety property that made these buttons acceptable is kept and is now structural:
 * when the model is NOT confident the account is LEFT ALONE — never messaged, never queued
 * for a human. Absence of confidence stays absence, which is the direction this codebase has
 * failed in five times; it does not harden into "not a company" any more than it does into
 * "yes, message them". `/paid-posts` reports what was decided and why, so removing the
 * control did not remove the explanation.
 */

// ── The paced dispatcher ────────────────────────────────────────────────────

/**
 * Run a dispatcher tick now, rather than waiting for the schedule.
 *
 * Deliberately NOT the same button as "Check now". `syncNow` runs a slot — it reads the
 * channels and drafts — and this delivers. They were one action while delivery lived
 * inside the slot, and merging them again would mean a control labelled *check the
 * channels* opens a Chrome window and DMs somebody, which is the mistake reply checking
 * on the `manual` slot already made once. A control does what its label says.
 *
 * Every pacing rule still applies: the breaker, the active-hours window, the minimum gap,
 * the per-hour allowance. This changes WHEN the tick happens, never WHETHER it may send.
 */
export async function dispatchNow(): Promise<MutationResult> {
  const user = await requireOperator()
  const result = await dispatchTick(`operator:${user.email}`)
  await audit(
    user.email,
    'dispatch.now',
    'Dispatcher',
    `${result.verdict.action} — ${result.verdict.action === 'hold' ? result.verdict.reason : `${result.delivered?.sent ?? 0} sent`}`,
  )
  revalidatePath('/')

  if (result.verdict.action === 'hold') {
    return { ok: false, message: `Nothing sent — ${result.verdict.detail}.` }
  }
  const sent = result.delivered?.sent ?? 0
  const held = (result.delivered?.outcomes.length ?? 0) - sent
  return {
    ok: true,
    message:
      sent > 0
        ? `Sent ${sent} message(s).${held > 0 ? ` ${held} held back — see the log beside each one.` : ''}`
        : `Nothing was sent. ${held} message(s) were held back for the reasons listed on each one.`,
  }
}

/**
 * Stop all unattended sending, now, with a reason.
 *
 * Distinct from switching Autopilot off, and both are worth having. Autopilot is the
 * standing answer to *may this deployment send unattended*; this is "stop, I am looking at
 * something", it records WHO and WHEN, and it appears on the dashboard as a tripped
 * breaker rather than as a toggle someone might assume was always off.
 *
 * It does not touch the Autopilot toggle, so resuming cannot accidentally switch unattended
 * sending on for someone who had it off.
 */
export async function pauseDispatch(reason: string): Promise<MutationResult> {
  const user = await requireOperator()
  const value = JSON.stringify({
    at: new Date().toISOString(),
    by: user.email,
    reason: reason.trim().slice(0, 200) || undefined,
  })
  await setSetting(DISPATCH_PAUSE_KEY, value)
  await audit(user.email, 'dispatch.paused', 'Dispatcher', reason.trim() || 'no reason given')
  revalidatePath('/')
  return { ok: true, message: 'Unattended sending is paused. Waiting messages keep their Send button.' }
}

/**
 * Release the pause.
 *
 * Only the MANUAL pause. It cannot clear a breaker tripped by a checkpoint or by a run of
 * `not-in-thread` failures — those release by dealing with the cause (clear the account's
 * halt; resolve the uncertain sends), never by pressing a button that says resume. A
 * release control that can dismiss a safety signal is how a safety signal stops being one.
 */
export async function resumeDispatch(): Promise<MutationResult> {
  const user = await requireOperator()
  const existing = await prisma.setting.findUnique({ where: { key: DISPATCH_PAUSE_KEY } })
  if (!existing) return { ok: true, message: 'Unattended sending was not paused.' }

  await prisma.setting.deleteMany({ where: { key: DISPATCH_PAUSE_KEY } })
  await audit(user.email, 'dispatch.resumed', 'Dispatcher', 'operator released the pause')
  revalidatePath('/')
  return { ok: true, message: 'Unattended sending is released. The next tick is within 15 minutes.' }
}

/**
 * ── RESOLVING A SEND WE CANNOT ACCOUNT FOR ─────────────────────────────────
 *
 * `not-in-thread` means the composer cleared — Instagram took the keystroke — and the
 * message never appeared in the conversation. The recipient may have it; the account may
 * be restricted. Since Phase 5 those attempts park in FAILED rather than returning to
 * READY, because handing one back with a Send button invites the action that is wrong in
 * both readings.
 *
 * Only a person who has READ THE THREAD can settle it, which is why this takes a verdict
 * rather than guessing from a retry:
 *
 *   'delivered'     — they have it. Recorded SENT, and the daily reservation is kept,
 *                     because a message that landed used the recipient's allowance.
 *   'not-delivered' — the thread is empty. Back to READY, and the reservation is RELEASED:
 *                     this is the one moment when delivery has genuinely been ruled out by
 *                     someone who looked, and the cap is on messages a person receives,
 *                     not on attempts we made.
 *
 * That asymmetry is the same one `settleClaims` argues for, resolved here by evidence
 * instead of by inference.
 *
 * ── THIS ACTION HAS NO CALLER SINCE 2026-08-24, AND THAT IS SAID OUT LOUD ──
 *
 * Tabish removed the "Check the conversation" section that rendered its two buttons. The
 * action is kept — deleting the only writer that can settle one of these rows would make the
 * decision irreversible from the product side — but a server action nothing can reach is this
 * codebase's signature defect (`addSender` sat unreachable for weeks), so it is LABELLED
 * rather than left looking wired. Reaching it again means either putting a control back or
 * calling it from a CLI; do not assume a screen is using it.
 */
export async function resolveUncertainSend(
  attemptId: string,
  verdict: 'delivered' | 'not-delivered',
): Promise<MutationResult> {
  const user = await requireOperator()

  const attempt = await prisma.outreachAttempt.findUnique({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  if (!attempt) return { ok: false, message: 'That message no longer exists.' }

  /**
   * Only an attempt actually parked as uncertain. Guarding on BOTH the status and the
   * failure code, not either: a plain FAILED row is a different thing, and this action
   * would otherwise be a way to mark any failed attempt as delivered.
   */
  if (attempt.status !== 'FAILED' || attempt.failureCode !== 'not-in-thread') {
    return {
      ok: false,
      message: `That message is ${attempt.status.toLowerCase()} and is not waiting on a thread check.`,
    }
  }

  const { sender, target } = attempt.pair

  if (verdict === 'delivered') {
    await recordDelivered({
      attemptId,
      variantId: attempt.variantId,
      // Legible months later as what it is: a human read the thread and confirmed it.
      sentBy: `thread-confirmed:${user.email}`,
      threadUrl: attempt.threadUrl,
      audit: {
        actor: user.email,
        action: 'attempt.uncertain.confirmed',
        entity: `OutreachAttempt:${attemptId}`,
        detail: `@${sender.handle} → @${target.handle}: operator read the thread and confirmed delivery`,
      },
    })
    revalidatePath('/')
    return { ok: true, message: `Recorded as delivered to @${target.handle}.` }
  }

  /**
   * Nothing arrived, confirmed by someone who looked. Give the recipient's allowance back
   * and let the draft be sent again.
   *
   * `failureCode` is cleared with it. Leaving it would keep this attempt in the breaker's
   * `not-in-thread` count forever — a resolved incident going on halting the fleet, which
   * is the "hard stop with no release" failure arriving by way of a stale column.
   */
  for (const r of await prisma.dailyReservation.findMany({ where: { attemptId }, select: { id: true } })) {
    await releaseReservation(r.id)
  }
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'READY', failureCode: null, error: null },
  })
  await audit(
    user.email,
    'attempt.uncertain.notdelivered',
    `OutreachAttempt:${attemptId}`,
    `@${sender.handle} → @${target.handle}: operator read the thread, nothing arrived — re-queued`,
  )
  revalidatePath('/')
  return {
    ok: true,
    message: `@${target.handle} never received it. The message is waiting again with its Send button.`,
  }
}

// ── Prospects ───────────────────────────────────────────────────────────────

/**
 * Import a pasted list of prospects. DRY RUN unless `commit` is true.
 *
 * The preview is the real answer, not an optimistic one: it parses, reports every rejected
 * line by number, and CHECKS EACH HANDLE against Instagram — so "50 will be added" means
 * fifty accounts that exist. Same rule as `ig:classify` and `ig:brands`, and for the same
 * reason: this is the only bulk write on the dashboard, and a mistyped column or the wrong
 * sheet must cost nothing.
 *
 * What it creates is deliberately inert. Pairs DISABLED, nothing armed, nothing watched.
 * Someone pasting a list to see what it looks like must not thereby message fifty people.
 */
export async function importProspectList(text: string, commit: boolean): Promise<ImportOutcome> {
  const user = await requireOperator()
  const outcome = await importProspects(text, {
    dryRun: !commit,
    actor: user.email,
    note: `imported by ${user.email}`,
  })
  if (commit) {
    await audit(
      user.email,
      'prospects.import',
      'TargetAccount',
      `${outcome.created} created from ${outcome.parsed.prospects.length} row(s); ` +
        `${outcome.parsed.rejected.length} rejected; all routes disabled, none watched`,
    )
    revalidatePath('/prospects')
  }
  return outcome
}

/**
 * Watch a target's feed, or stop.
 *
 * Separate from whether it may be messaged, which is what pairs decide. Turning watching ON
 * costs four requests per slot forever, so it is a decision rather than a default — and
 * turning it off does NOT retire the account or touch its send history.
 */
export async function setTargetWatch(handle: string, on: boolean): Promise<MutationResult> {
  const user = await requireOperator()
  const target = await prisma.targetAccount.findUnique({ where: { handle } })
  if (!target) return { ok: false, message: `@${handle} is not in the list.` }

  await prisma.targetAccount.update({ where: { handle }, data: { watchEnabled: on } })
  await audit(user.email, on ? 'target.watch.on' : 'target.watch.off', `TargetAccount:${handle}`)
  revalidatePath('/prospects')
  return {
    ok: true,
    message: on
      ? `Now reading @${handle}'s posts at every check.`
      : `Stopped reading @${handle}'s posts. Messaging is unaffected.`,
  }
}

/**
 * Put a target in a category, or take it out.
 *
 * The category is what rotation reads: each successive message to this recipient comes
 * from the next sender in that category's ring. Membership alone sends nothing — the pair
 * must still be enabled, the account armed and connected, and autopilot on.
 */
export async function setTargetCategory(handle: string, categoryName: string): Promise<MutationResult> {
  const user = await requireOperator()
  const target = await prisma.targetAccount.findUnique({ where: { handle } })
  if (!target) return { ok: false, message: `@${handle} is not in the list.` }

  const name = categoryName.trim()
  if (name === '') {
    await prisma.categoryTarget.deleteMany({ where: { targetId: target.id } })
    await audit(user.email, 'target.category.cleared', `TargetAccount:${handle}`)
    revalidatePath('/targets')
    return {
      ok: true,
      message: `@${handle} is no longer in a rotation group — the whole fleet takes turns writing to them again.`,
    }
  }

  const cat = await ensureCategory(name)

  /**
   * A GROUP WITH NO SENDERS SILENCES THIS RECIPIENT, so it is refused.
   *
   * Since 2026-08-13 a recipient in NO group is rotated through the fleet; a recipient in a
   * group uses that group's ring, and an EMPTY ring returns `empty-ring` — nothing is ever
   * written to them again. That is a real footgun and it is new: before the fleet fallback,
   * naming an empty group changed nothing at all, because rotation was inert either way.
   *
   * Refusing is right rather than clever. The whole reason the group is being set is to
   * NARROW who writes; narrowing to nobody is never what was meant, and the failure would be
   * invisible — a recipient that quietly stops receiving drafts looks exactly like a
   * recipient the spacing rules are holding back.
   */
  const ringSize = await prisma.categorySender.count({ where: { categoryId: cat.id, enabled: true } })
  if (ringSize === 0) {
    return {
      ok: false,
      message:
        `${name} has no sending accounts in it, so putting @${handle} there would stop anything ` +
        `being written to them at all. Add accounts to the group first.`,
    }
  }

  /**
   * One category per target, so replacing means clearing first.
   *
   * `whoseTurn` uses the FIRST category when a target is in several and deliberately does
   * not merge rings — two groups rotating through one recipient is a business decision
   * about who may pitch them, and inventing an answer would make that decision invisible.
   * Letting the UI create that state quietly would be the same mistake one layer up.
   */
  await prisma.categoryTarget.deleteMany({ where: { targetId: target.id } })
  await addTargetToCategory(cat.id, target.id)
  await audit(user.email, 'target.category.set', `TargetAccount:${handle}`, name)
  revalidatePath('/targets')
  return {
    ok: true,
    message: `@${handle} is in ${name}. Only that group's ${ringSize} account${ringSize === 1 ? '' : 's'} will write to them now.`,
  }
}
