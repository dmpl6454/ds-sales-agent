'use server'

import { invalidateCeoView } from './view-model'
import { invalidateViews } from '@/lib/viewMemo'
import { revalidatePath } from 'next/cache'
import { approveEnrolment, revokePairedDevice, listPairedDevices } from '@/lib/deviceEnrol'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import { env } from '@/lib/env'
import { runSlot } from '@/worker/runSlot'
// `mayArmAccount` is deliberately NOT imported here any more: the arming button is gone
// (one switch, 2026-08-08) and the ladder is enforced by `gate.ts` at delivery instead.
// The FUNCTION is very much alive — do not delete it on the strength of this file.
import { nextCohort } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { recheckBeforeSend } from '@/outreach/gate'
import { deliverOne, type DeliverOneResult } from '@/outreach/deliverOne'
import { gateRefusalMessage, sendNowAnswer, SEND_NOW_BUSY, SEND_NOW_DB } from './send-now-message'
import { prepareOnDemand, type OnDemandPreview } from '@/outreach/onDemand'
import { getSettings, setSetting, SETTING_KEYS } from '@/lib/settings'
import { startConnect, pollConnect, cancelConnect, type ConnectState } from '@/outreach/browser/connect'
import { resolveConnectTarget, connectTargetProblem,
  enqueueConnectRequest,
  readConnectRequest,
  deleteConnectRequest,
  requestToConnectState,
} from '@/outreach/connectRelay'
import { readPresence } from '@/agent'
import { parseRole, type Role } from '@/lib/roles'
import { launchProfile, identify } from '@/outreach/browser/session'
import { profileUrl } from '@/lib/urls'
import { handleExists, probeHandle } from '@/detection/exists'
import { fetchFeed } from '@/detection/feed'
import { addTargetMessage } from './add-target-message'
import { removalVerdict, removeTargetResult } from './remove-target-message'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { ourOwnPageHandles } from '@/detection/visibleChannels'
import { assertSafeHandle } from '@/lib/urls'
import { distinctiveSlice } from '@/outreach/matching'
import { recordDelivered } from '@/outreach/recordSend'
import { releaseReservation } from '@/outreach/reservations'
import { clearChallenged } from '@/outreach/challenge'
import { markSessionInvalid, clearSessionInvalid } from '@/outreach/sessionHealth'
import { withSendLock, DISPATCH_PAUSE_KEY, dispatchTick, acknowledgeBreaker } from '@/outreach/dispatcher'
import { importProspects, type ImportOutcome } from '@/outreach/importProspects'
import { routeAllowed, fleetHandles } from '@/outreach/routes'
import { readCategoryMemberships, categoriesFor } from '@/outreach/categories'
import { ensureCategory, addTargetToCategory } from '@/outreach/categories'
import { discardAttempt } from '@/outreach/discard'
import { handOffWaitingDrafts, releasableWhere } from '@/outreach/handOff'
import { removeSenderResult, tallyHeld } from './remove-sender-message'
import { validatePersona } from '@/outreach/render'
import { checkFollowUpBody, checkTemplateBody } from '@/outreach/templateGuard'
import { fleetTemplateKey } from '@/outreach/fleetTemplate'
import { FOLLOW_UP_DEFAULT_KEY, followUpTemplateKey } from '@/outreach/followUpTemplate'
import { DEFAULT_CATEGORY_SLUG } from '@/outreach/senderCategories'
import { requireOperator } from '@/lib/session'
import { MESSAGE_VARIANTS } from '../../prisma/variants'
import { BRAND_MESSAGE_VARIANTS } from '../../prisma/brandVariants'

/**
 * ONE CALL, TWO CACHES (2026-09-04). `revalidatePath` tells Next the next render of that
 * path must be fresh; since the same day every page builder is also memoised in-process for
 * ten seconds (`src/lib/viewMemo.ts`, the pile-up fix), and a memo that survived the
 * revalidation would hand the next render the OLD rows — the switch just flipped, the draft
 * just discarded, the sender just added — for up to ten seconds, on the one request where a
 * person is looking to see their own change land. So every action goes through this helper
 * and none calls `revalidatePath` directly; `tests/view-memo.test.ts` greps for a bare call.
 */
function refreshPath(path: string): void {
  invalidateViews()
  revalidatePath(path)
}

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
  refreshPath('/')
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
 * ── THIS IS A CALLER OF `deliverOne`, NOT A SECOND DELIVERY PATH (Stage 1.3) ───────────────
 *
 * It used to carry its own copy of "claim, drive, file the outcome", and the copy had drifted
 * from the dispatcher's (audit M4 / M2). What it does itself is now three things, in order:
 *
 *   1. The FIRST REFUSAL — `recheckBeforeSend`, the same gate autopilot runs, asked BEFORE the
 *      lock so that a draft the gate refuses is answered with the gate's own sentence even when
 *      the lock would have been refused too. That is why the call is kept here rather than left
 *      to `deliverOne`: with the gate only inside the lock, every click on a machine that may
 *      not send (the hosted dashboard is `SEND_ENABLED=false`) would read "another message is
 *      being sent right now" over drafts the gate would have named a real reason for. The gate
 *      is asked AGAIN inside `deliverOne`, under the lock, which is the ask that guards.
 *   2. The fleet-wide SEND LOCK, below.
 *   3. `deliverOne`, which owns everything from there: the live status re-read, the disk, the
 *      gate, the asks before the claim, the atomic claim, the allowance claim, the anonymous
 *      probe, the drive, and the failure ladder.
 *
 * What the Send button now does that it did not: it asks the anonymous page probe — one request
 * with no session from this machine's own IP, which parks a draft aimed at a deleted page with
 * NO browser drive. It can only HOLD a message; no send is added and NO BROWSER DRIVE IS ADDED.
 *
 * What it deliberately does NOT do: read the conversation first, as the dispatcher does for a
 * stale follow-up. That read is a real Chrome drive and HEAD's button never made one, so the
 * button still relies on `repliedAt` as of the last sweep, through the gate. A reply nobody has
 * swept yet does not hold a press — HEAD's gap, stated rather than closed; whether the button
 * should pay a read for it is a person's call (`deliverOne`'s step 6 is the one condition).
 *
 * `overrides` carries stops the operator acknowledged in the on-demand dialog. It is
 * intersected with OVERRIDABLE_BLOCKS inside the gate, never trusted as given — a
 * server action is reachable by anything that can reach the page, so the whitelist
 * has to hold at the gate rather than at the caller. An overridden send is recorded
 * with a different `sentBy` so the audit trail never conflates "the system decided
 * this was fine" with "a person overruled it".
 *
 * A checkpoint marks the sender CHALLENGED and halts it. That state is cleared by a
 * human who has looked at the account, never automatically.
 */
export async function sendNow(attemptId: string, overrides?: readonly string[]): Promise<SendNowResult> {
  const user = await requireOperator()
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  const { sender, target } = attempt.pair

  /**
   * Guard 1 — the SAME re-check autopilot runs, as the FIRST REFUSAL.
   *
   * This used to be three inline guards, and it silently lacked five that
   * `deliverWaiting` enforced: the route being switched off, the channel retired,
   * *they replied*, and both daily caps. A human clicking Send is not a reason to skip
   * any of those — it is only a reason not to require the account's unattended-sending
   * switch, which is the single difference `unattended: false` expresses.
   */
  const gate = await recheckBeforeSend(attempt, { unattended: false, overrides })
  if (!gate.ok) {
    return { ok: false, message: gateRefusalMessage(sender.handle, gate.reason, gate.detail) }
  }

  /**
   * ── THE FLEET-WIDE SEND LOCK ────────────────────────────────────────────
   *
   * There is one OS clipboard and `sendDm` pastes the body from it. Two sends running at
   * once can interleave copy and paste and put **message A into thread B**. The atomic
   * READY→SENDING claim does not cover this: it stops the SAME message going twice
   * and says nothing about two DIFFERENT messages racing — which is precisely what a click
   * landing during a dispatcher tick is. `runSlot`'s lock comment already reasoned about
   * this hazard while only protecting slots from slots.
   *
   * Refused rather than queued. Waiting would hold a server action open for the 40 seconds
   * of somebody else's send, and the honest answer is that the message is still there.
   *
   * THE CLAIM IS INSIDE THE LOCK NOW (audit M4). It used to be made before this line and given
   * back when the lock was refused, which made "Another message is being sent right now" a
   * sentence about a draft this very call had just flipped to SENDING and back. Nothing is
   * claimed until `deliverOne` holds the lock, so a refusal here leaves the draft exactly as it
   * was and the sentence below is a statement about the lock, not about the row.
   */
  /* Taking the lock reads and writes the shared database, so it can throw BEFORE anything is
     claimed or driven — and then the honest answer is the database sentence, and there is
     nothing to give back. `entered` separates that from a throw out of `deliverOne`, which can
     come AFTER a browser opened: the recipient may hold the message, the row stays SENDING for
     the orphan sweep's "check the conversation", and the error propagates as it always did.
     (Everything between `deliverOne`'s claim and its drive is guarded inside it, by
     `revertUndrivenClaim`.) */
  let entered = false
  let result: DeliverOneResult | null
  try {
    result = await withSendLock(`operator:${sender.handle}`, async () => {
      // Read inside the lock and BEFORE `entered`, so a failing read is the database sentence.
      const settings = await getSettings()
      entered = true
      return deliverOne({
        attempt,
        settings,
        mode: { unattended: false, operator: user.email, overrides },
        challengedThisRun: new Set<string>(),
      })
    })
  } catch (err) {
    if (entered) throw err
    return { ok: false, message: SEND_NOW_DB }
  }

  if (result === null) return { ok: false, message: SEND_NOW_BUSY }

  const answer = sendNowAnswer(result, { sender: sender.handle, target: target.handle })
  if (answer.refresh) refreshPath('/')
  return { ok: answer.ok, message: answer.message, ...(answer.challenged ? { challenged: true } : {}) }
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
  if (preview.ok) refreshPath('/')
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
  refreshPath('/paid-posts')
  refreshPath('/targets')
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
  refreshPath('/')
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
 *
 * ── THE WRITE IS THE GUARD, NOT THE READ BEFORE IT (Stage 1.3, audit M11) ──────────────────
 *
 * This read the status, validated, and then wrote in a separate statement — the two-statement
 * check-then-act this repo has produced four times (`sendNow`'s idempotency, the first slot
 * lock, the per-target cap, the prune command). Between the read and the write the dispatcher
 * could claim the draft and a browser start pasting the OLD body, while the new one was stored
 * under a row now SENDING — an audit trail describing a message nobody received. The update now
 * carries `status IN (READY, QUEUED)` in its own `where` and the COUNT is the answer.
 *
 * The status read at the top is kept, but only for the MESSAGE: it is what lets a person who
 * opens the editor on a draft that is already SENDING or SENT hear that before they are told
 * their body is too short, exactly as before. It decides nothing; a draft that moved after it
 * is caught by the write, and the sentence for that comes from a fresh read of the status.
 */
export async function editAttemptBody(attemptId: string, body: string): Promise<MutationResult> {
  const user = await requireOperator()
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })

  const notEditable = (status: string): MutationResult => ({
    ok: false,
    message:
      status === 'SENDING'
        ? 'That message is being sent right now — too late to edit.'
        : `That message is already ${status.toLowerCase()} and cannot be changed.`,
  })
  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') return notEditable(attempt.status)

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

  const wrote = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: { in: ['READY', 'QUEUED'] } },
    data: { renderedBody: next },
  })
  if (wrote.count === 0) {
    // The draft left the queue between the read above and this write — a claim, a send, a discard.
    // Re-read for the SENTENCE only; the write already refused.
    const now = await prisma.outreachAttempt.findUnique({ where: { id: attemptId }, select: { status: true } })
    return notEditable(now?.status ?? 'gone')
  }
  await audit(user.email, 
'attempt.edited',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}, ${attempt.renderedBody.length} → ${next.length} chars`,
  )
  refreshPath('/')
  return { ok: true, message: `Saved. ${next.length} characters.` }
}

/**
 * The autopilot toggle.
 *
 * Turning it ON means: at each slot, any armed account with a logged-in Chrome
 * profile sends its permitted message by itself, with no human present.
 *
 * `AUTOPILOT_ENABLED` in `.env` is a hard floor, and it is NOT checked here (see below):
 * it is enforced by every reader of the env-floored `settings.autopilotEnabled` and by
 * `SEND_ENABLED` inside `withSendLock`, so a floored machine may write the shared row and
 * still cannot send. Restoring a floor check in this action would make the hosted dashboard
 * the one place the fleet can never be armed — the 2026-09-02 bug.
 */
export async function setAutopilot(on: boolean): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()
  /**
   * THE SWITCH IS FLEET-WIDE AND WRITABLE FROM ANY DASHBOARD — Tabish, 2026-09-02:
   * "Autopilot button cannot be pressed by any user using the website url. This is wrong."
   *
   * This used to refuse `on` when `env.AUTOPILOT_ENABLED` was false, which made the HOSTED
   * dashboard — the one product every operator shares — the one place the fleet could never
   * be armed. The env floor's real job is unchanged and unweakened: it still decides whether
   * THIS machine may act on the setting (`settings.autopilotEnabled` stays env-floored for
   * every enforcement path, and `SEND_ENABLED=false` inside `withSendLock` means the server
   * structurally cannot drive a browser regardless). Writing the shared Setting from a
   * floored machine arms only the machines that are allowed to send — the devices.
   */
  await setSetting(SETTING_KEYS.autopilotEnabled, on ? 'true' : 'false')
  await audit(user.email, 'autopilot.set', 'Setting:autopilotEnabled', on ? 'ON' : 'OFF')
  invalidateCeoView() // the landing page memo must not show the OLD switch for ten seconds
  refreshPath('/')
  return {
    ok: true,
    message: on
      ? 'Autopilot on — the sending Macs deliver at each slot.'
      : 'Autopilot off — messages will wait for you.',
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
  refreshPath('/')
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
    refreshPath('/')
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
  refreshPath('/')
  return {
    ok: true,
    message:
      'Saved. New drafts use this text. Messages already waiting keep the copy they were ' +
      'written with — discard them if the old wording should not go out.',
  }
}

/**
 * ── A SEPARATE STANDARD MESSAGE PER FLEET (2026-08-26, Tabish) ─────────────
 *
 * *"a separate template message would be sent for the marketing and brand category …
 * keep it empty for now."*
 *
 * Deliberately a SECOND action rather than a `slug` parameter on `setSingleTemplateBody`,
 * because the two do different things with an empty box and merging them would make that
 * difference a runtime branch nobody reads:
 *
 *   default fleet  — clearing RESTORES the shipped copy. Sending continues.
 *   a second fleet — clearing means NOBODY HAS WRITTEN IT, and every send to that fleet
 *                    is refused by name until somebody does.
 *
 * The non-empty path shares `checkTemplateBody`, so the 40-character floor that keeps
 * `distinctiveSlice` able to build a needle applies to EVERY fleet's copy — a marketing
 * template too short to quote would refuse every send to that fleet with the same
 * unexplained silence the default one is guarded against.
 */
/**
 * ── PUT AN ACCOUNT BACK IN THE ROTATION (2026-08-26) ───────────────────────
 *
 * `fleetMember` WAS A ONE-WAY DOOR, and that is the defect this closes. `removeSender`
 * writes `fleetMember: false` (actions.ts, the only mutation of that column in the tree);
 * a grep for a write of `true` outside `src/generated` returns nothing but `select:`
 * projections and comments. The schema default is `true`, so an account could only ever be
 * in the rotation by never having left it.
 *
 * MEASURED 2026-08-26, which is how it surfaced: @madaboutmarketingg was signed in by hand
 * on 17 August, delivered a message on the 18th, and was taken out of the rotation on the
 * 19th. It still holds a live session on disk. It renders under "Not in the rotation —
 * writes to nobody" with no control of any kind, is absent from the Remove form (which
 * lists fleet members), and the Add form correctly refuses it as already present. There was
 * no way, anywhere in the product, to use an account we own and have already signed in.
 *
 * ── THE FLEET IS WRITTEN BEFORE THE ROUTES, for the third time ────────────
 *
 * `routeAllowed` READS the memberships, so applying the category afterwards would wire this
 * account to every recipient of the OTHER fleet and leave the gate holding those drafts
 * forever. Same ordering rule as `createBrandTarget` and `importProspects`; the two rows
 * that leaked on 25 August are what it costs to get it wrong.
 *
 * AN UNKNOWN SLUG REFUSES rather than falling back to the default — the default is what a
 * bollywood page gets, and quietly giving it to an account meant for the marketing fleet is
 * exactly what the fleet rule exists to prevent.
 *
 * Routes are created here rather than left to the planner only so the account is immediately
 * legible on `/targets`; `ensureFleetPairs` would create the same set on its next pass, and
 * `createMany` + the pair unique key make running both harmless.
 */
/**
 * ── "IS THIS ACCOUNT ACTUALLY SIGNED IN?" — ASKED OF INSTAGRAM (2026-08-26) ──
 *
 * Tabish: *"How can we ever click a link via UI and confirm for other senders and reconnect
 * when it doesn't work or gets expired?"* He could not, and the reason is a gap this page
 * has had since Connect was built.
 *
 * `AccountRow.connected` is `sessionUsable(hasSessionOnDisk, sessionInvalidAt)` — a COOKIE
 * ON DISK plus the absence of a mark. The Connect button renders only when that is FALSE.
 * So an account whose session Instagram has revoked SERVER-SIDE reads as connected, offers
 * no control at all, and stays that way until a real send fails and writes
 * `sessionInvalidAt`. *"Freshness is not liveness"* — this file's fourth recording of it —
 * with no way for a person to ask the only party that knows.
 *
 * This asks. It opens the profile, runs `identify()` — Instagram's own endpoints — and
 * records what came back:
 *
 *   logged-in, matching   PROOF. Clears any `sessionInvalidAt` (the only thing that may:
 *                         `clearSessionInvalid` takes proof, never a page load).
 *   logged-in, WRONG      the profile holds somebody else's session. Marked invalid, because
 *     account            sending from it would put an unrelated page into a conversation.
 *   logged-out            positive evidence. Marked invalid so the row shows "needs signing
 *                         in again" and the Connect button appears.
 *   unknown               NOTHING IS WRITTEN. "We could not ask" must never become a verdict
 *                         about the account — the exact mistake that once marked a live
 *                         session dead and sent an operator to re-login for a dead endpoint.
 *
 * Under `withSendLock`, because two contexts on one profile is how device identity dies and
 * the device agent polls every 30 seconds. `SEND_ENABLED=false` refuses it on the server for
 * free, which is correct: the server has no profiles to check.
 */
/**
 * ── "I HAVE LOOKED" — THE RATE BREAKER'S MISSING RELEASE (2026-08-26) ─────
 *
 * The `not-in-thread` breaker's own sentence ends *"nothing else is sent until someone has
 * looked"*, and there was no way to say that you had. Meanwhile it could not self-heal: its
 * denominator is DELIVERIES in the window, which only grow by sending — which it forbids —
 * so the rate rises as deliveries age out. Projected on the real data: 39% now, 47% at +12h,
 * **79% at +18h**, releasing only at +19h when the numerator expired.
 *
 * This acknowledges the failures that ALREADY happened. A failure recorded afterwards trips
 * the breaker again, so it is a release rather than a mute — if the cause was not really
 * fixed, the fleet stops on the first proof. It cannot touch a flagged account or a manual
 * pause: Instagram flagging an account is not something a person can acknowledge away.
 */
export async function acknowledgeFleetBreaker(reason: string): Promise<MutationResult> {
  const user = await requireOperator()
  const text = reason.trim()
  if (text.length < 10) {
    return {
      ok: false,
      message: 'Say what you found, in a sentence — this is the only record of why a halted fleet was resumed.',
    }
  }
  await acknowledgeBreaker(user.email, text)
  refreshPath('/')
  return {
    ok: true,
    message:
      'Recorded. The fleet resumes on the next tick. If another message clears the composer and never ' +
      'arrives, the halt comes straight back — this covers only what had already happened.',
  }
}

export async function checkSignIn(handleRaw: string): Promise<MutationResult> {
  const user = await requireOperator()
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()

  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: `@${handle} is not one of your accounts.` }

  /**
   * HOSTED DASHBOARD (2026-09-02): there is no browser here to ask Instagram and no profile
   * on this disk, so the old `profileStatus` check reported EVERY account "no browser profile
   * on this machine" — even ones signed in and actively sending. Tabish hit exactly this
   * ("unable to sign in or even check sign in"). Report the machine-independent record the
   * sending Mac wrote, and route real (re-)verification to Connect, which opens the sign-in
   * on the operator's own Mac via the relay. Never launch a browser here.
   */
  if (!env.SEND_ENABLED) {
    if (sender.sessionInvalidAt !== null) {
      return {
        ok: false,
        message: `@${handle} was found signed out on its sending Mac. Press Connect to sign in again.`,
      }
    }
    if (sender.sessionPath) {
      return {
        ok: true,
        message: `@${handle} is signed in on its sending Mac. Instagram is re-checked from that Mac; press Connect if you want to sign in fresh.`,
      }
    }
    return {
      ok: false,
      message: `@${handle} has not been signed in on any sending Mac yet. Press Connect to sign in — the window opens on that Mac.`,
    }
  }

  if (!profileStatus(handle).hasSession) {
    return { ok: false, message: `@${handle} has no browser profile on this machine yet — press Connect to sign in.` }
  }

  const outcome = await withSendLock(`identity check @${handle}`, async () => {
    const context = await launchProfile(handle)
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(profileUrl(handle), { waitUntil: 'domcontentloaded', timeout: 60_000 })
      return await identify(page)
    } finally {
      /* Closing is what flushes cookies to disk. Never leave a context open on a profile. */
      await context.close().catch(() => {})
    }
  })

  if (outcome === null) {
    return { ok: false, message: 'Another send or check is running right now — try again in a moment.' }
  }

  if (outcome.kind === 'logged-in' && outcome.username.toLowerCase() === handle) {
    await clearSessionInvalid(sender.id, `identity check by ${user.email}: Instagram says @${outcome.username}`)
    await audit(user.email, 'sender.signin.checked', `SenderAccount:${handle}`, `signed in as @${outcome.username}`)
    refreshPath('/senders')
    return { ok: true, message: `Signed in, and it is the right account — Instagram says @${outcome.username}.` }
  }

  if (outcome.kind === 'logged-in') {
    await markSessionInvalid({
      senderId: sender.id,
      handle,
      detail: `the browser profile is signed in as @${outcome.username}, not @${handle}`,
      actor: user.email,
    })
    refreshPath('/senders')
    return {
      ok: false,
      message:
        `This profile is signed in as @${outcome.username}, NOT @${handle}. Nothing will send from it until ` +
        `that is fixed — sign in again as @${handle}.`,
    }
  }

  if (outcome.kind === 'logged-out') {
    await markSessionInvalid({
      senderId: sender.id,
      handle,
      detail: `identity check by ${user.email}: Instagram treated the session as signed out`,
      actor: user.email,
    })
    refreshPath('/senders')
    return { ok: false, message: `@${handle} is signed out — its Connect button is back, sign in again.` }
  }

  /* UNKNOWN writes nothing. See the docblock. */
  return {
    ok: false,
    message:
      `Could not tell — nothing answered. The sign-in is left exactly as it was, because "we could not ask" ` +
      `is not evidence about the account. Try again shortly. (${outcome.detail?.slice(0, 120) ?? 'no detail'})`,
  }
}

export async function rejoinFleet(
  handleRaw: string,
  categorySlugRaw = '',
  /**
   * ── A ONE-CLICK BUTTON MUST NOT SILENTLY CREATE 514 ROUTES (2026-08-26) ──
   *
   * The first version of this action applied immediately. MEASURED the hour it shipped:
   * @tabishmukaddam1 — the rehearsal burner, whose whole purpose is being OUT of the fleet —
   * was put in with **514 routes to real companies**, eight seconds after the intended
   * account, by someone trying the new control. Nothing had been delivered when it was
   * caught, and it was restored; the next planner pass would have started drafting.
   *
   * So the first call is a PREVIEW and writes nothing: it returns the fleet and the exact
   * number of routes that would be created, from the same computation that will run. The
   * count is server-authoritative rather than an estimate the client made up — this is the
   * one control that turns an account we own into an account that cold-DMs strangers, and
   * "adding is never the same act as sending" has to mean something at the door that does
   * the adding.
   */
  confirmed = false,
): Promise<MutationResult> {
  const user = await requireOperator()
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()

  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: `@${handle} is not one of your accounts.` }
  if (sender.fleetMember) return { ok: false, message: `@${handle} is already in the rotation.` }

  const slug = categorySlugRaw.trim().toLowerCase()
  if (slug) {
    const category = await prisma.category.findUnique({ where: { slug } })
    if (!category) return { ok: false, message: `There is no fleet called "${categorySlugRaw}".` }
    await prisma.categorySender.upsert({
      where: { categoryId_senderId: { categoryId: category.id, senderId: sender.id } },
      create: { categoryId: category.id, senderId: sender.id, enabled: true },
      update: { enabled: true },
    })
  }

  /* Now the routes, with the membership already in place. */
  const memberships = await readCategoryMemberships()
  const ourHandles = await fleetHandles(prisma)
  const targets = await prisma.targetAccount.findMany({
    select: { id: true, handle: true, optedOut: true, role: true },
  })
  const existing = new Set(
    (await prisma.outreachPair.findMany({ where: { senderId: sender.id }, select: { targetId: true } })).map(
      (p) => p.targetId,
    ),
  )
  const data = targets
    .filter(
      (t) =>
        !existing.has(t.id) &&
        routeAllowed({
          senderHandle: sender.handle,
          targetHandle: t.handle,
          senderCategories: categoriesFor(memberships.bySenderHandle, sender.handle),
          targetCategories: categoriesFor(memberships.byTargetHandle, t.handle),
          ourHandles,
          senderIsFleetMember: true,
          targetOptedOut: t.optedOut,
          targetIsWatchOnly: t.role === 'WATCH',
        }),
    )
    .map((t) => ({
      senderId: sender.id,
      targetId: t.id,
      cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
      enabled: true,
    }))
  /**
   * THE PREVIEW STOPS HERE, having written the membership but NOT the flag and NOT the
   * routes. The membership alone changes nothing — `routeAllowed` only matters when a route
   * is created, and `fleetMember` is still false so rotation cannot elect this account.
   */
  if (!confirmed) {
    const where = slug ? `the ${slug} fleet` : 'the default (bollywood) fleet'
    return {
      ok: false,
      message:
        `This puts @${handle} in ${where} and creates ${data.length} route${data.length === 1 ? '' : 's'} ` +
        `to real companies it will then cold-message while Autopilot is on. ` +
        (sender.status === 'PAUSED' ? `It is retired, so this also makes it ACTIVE again. ` : '') +
        `Press again to confirm.`,
    }
  }

  /**
   * ── A RETIRED ACCOUNT COMES BACK ACTIVE, BUT A FLAGGED ONE NEVER DOES ────
   *
   * `removeSender` retired with `status: 'PAUSED'` until 2026-10-09 — it leaves status alone
   * now, but every account retired before then still carries it — and the gate refuses a
   * non-ACTIVE sender (`SENDER_NOT_ACTIVE`). Rejoining without clearing that gives an account with routes,
   * a session and a fleet flag that still cannot send a single message — a control that
   * appears to work and does not, which is this codebase's signature failure.
   *
   * CHALLENGED IS NEVER CLEARED AS A SIDE EFFECT. That is Instagram having flagged the
   * account; it trips the fleet-wide breaker and is cleared deliberately, by its own button,
   * after a person has looked. Same rule `checkConnect` had to learn.
   */
  const restoreActive = sender.status === 'PAUSED'
  await prisma.senderAccount.update({
    where: { handle },
    data: restoreActive ? { fleetMember: true, status: 'ACTIVE' } : { fleetMember: true },
  })

  if (data.length > 0) await prisma.outreachPair.createMany({ data })

  await audit(
    user.email,
    'sender.rejoined-rotation',
    `SenderAccount:${handle}`,
    `back in the rotation${slug ? ` for the ${slug} fleet` : ''}; ${data.length} route(s) created` +
      (restoreActive ? '; status PAUSED -> ACTIVE' : '') +
      (sender.status === 'CHALLENGED' ? '; still CHALLENGED and cannot send until that is cleared' : ''),
  )
  refreshPath('/senders')
  refreshPath('/targets')
  refreshPath('/')
  return {
    ok: true,
    message:
      `@${handle} is back in the rotation${slug ? ` and sends for the ${slug} fleet` : ''}. ` +
      `${data.length} route(s) created.` +
      (restoreActive ? ' It was retired, so it is ACTIVE again.' : '') +
      (sender.status === 'CHALLENGED'
        ? ' It is still flagged by Instagram, so it cannot send until you clear that on its row.'
        : ' It still needs Autopilot on and a usable sign-in to send.'),
  }
}

/**
 * WHICH FLEETS A PAGE SENDS FOR — a SET, not a choice (2026-09-04, Tabish).
 *
 * *"a sender can be a part of either Bollywood or marketing or both or none (that is not
 * assigned or signed in). Furthermore, we need all Bollywood senders to now also be marketing
 * category senders. Hence, they would now be part of two rings (both marketing and Bollywood)
 * and send messages accordingly."*
 *
 * `rejoinFleet` takes ONE slug and only works on an account that has LEFT the rotation, so
 * there was no way to give a page a second fleet or to take one away. This is that control.
 *
 * ── PREVIEW THEN CONFIRM, FOR THE REASON `rejoinFleet` DOES ──────────────────
 *
 * Adding a fleet to a page is not a preference — it wires that page to every live recipient of
 * the new fleet and the planner starts writing to them. On 26 August a bare one-click fleet
 * button put the rehearsal burner in the rotation with 514 routes to real companies within
 * three minutes of shipping. So the first call writes NOTHING and returns the exact number of
 * routes it would create, computed by the SAME `routeAllowed` that will run — a count the
 * client cannot invent — and changing the selection disarms the confirmation, because
 * confirming a number computed for a different selection is precisely the failure being
 * prevented.
 *
 * ── THE MEMBERSHIPS ARE WRITTEN BEFORE THE ROUTES ───────────────────────────
 *
 * Fourth time in this codebase. `routeAllowed` READS the memberships, so creating routes first
 * would wire the page using the OLD fleets and leave the gate holding every one of those
 * drafts forever.
 *
 * ── REMOVING A FLEET DISABLES, IT DOES NOT DELETE ───────────────────────────
 *
 * `CategorySender.enabled` exists for this: the send history rotation reads is interpreted
 * against the membership, so deleting the row would rewrite the past. Existing pair rows are
 * left alone too — `gate.ts` refuses a cross-fleet route by name, and deleting pairs cascades
 * `OutreachAttempt` and would erase the record that real people received real messages.
 */
export async function setSenderFleets(
  handleRaw: string,
  slugsRaw: readonly string[],
  confirmed = false,
): Promise<MutationResult> {
  const user = await requireOperator()
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()

  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: `@${handle} is not one of your accounts.` }

  const wanted = [...new Set(slugsRaw.map((x) => x.trim().toLowerCase()).filter(Boolean))]
  const categories = await prisma.category.findMany({ select: { id: true, slug: true, name: true } })
  const bySlug = new Map(categories.map((c) => [c.slug, c]))
  /* An unknown slug REFUSES rather than being ignored — a silently dropped fleet would look
     applied on screen and be invisible to every enforcer. */
  const unknown = wanted.filter((w) => !bySlug.has(w))
  if (unknown.length > 0) {
    return { ok: false, message: `There is no fleet called "${unknown[0]}".` }
  }

  const current = new Set(
    (
      await prisma.categorySender.findMany({
        where: { senderId: sender.id, enabled: true },
        select: { category: { select: { slug: true } } },
      })
    ).map((r) => r.category.slug),
  )
  const adding = wanted.filter((w) => !current.has(w))
  const removing = [...current].filter((c) => !wanted.includes(c))
  if (adding.length === 0 && removing.length === 0) {
    return { ok: false, message: `@${handle} already sends for exactly that.` }
  }

  /* The routes the NEW selection would add, from the same rule that will create them. */
  const ourHandles = await fleetHandles(prisma)
  const targets = await prisma.targetAccount.findMany({
    select: { id: true, handle: true, optedOut: true, role: true },
  })
  const memberships = await readCategoryMemberships()
  const existing = new Set(
    (await prisma.outreachPair.findMany({ where: { senderId: sender.id }, select: { targetId: true } })).map(
      (p) => p.targetId,
    ),
  )
  const wouldAdd = targets.filter(
    (t) =>
      !existing.has(t.id) &&
      routeAllowed({
        senderHandle: sender.handle,
        targetHandle: t.handle,
        /* The SELECTION being previewed, not what is stored — otherwise the count describes
           the fleets the page already has. */
        senderCategories: wanted,
        targetCategories: categoriesFor(memberships.byTargetHandle, t.handle),
        ourHandles,
        senderIsFleetMember: sender.fleetMember,
        targetOptedOut: t.optedOut,
        targetIsWatchOnly: t.role === 'WATCH',
      }),
  )

  if (!confirmed) {
    const where = wanted.length === 0 ? 'no fleet at all' : wanted.join(' and ')
    return {
      ok: false,
      message:
        `@${handle} will send for ${where}. ` +
        (wouldAdd.length > 0
          ? `That creates ${wouldAdd.length} new route(s) to real companies, and the planner starts writing to them.`
          : 'That creates no new routes.') +
        (removing.length > 0
          ? ` It stops sending for ${removing.join(' and ')} — existing history is kept and nothing is deleted.`
          : ''),
    }
  }

  for (const slug of adding) {
    const category = bySlug.get(slug)!
    await prisma.categorySender.upsert({
      where: { categoryId_senderId: { categoryId: category.id, senderId: sender.id } },
      create: { categoryId: category.id, senderId: sender.id, enabled: true },
      update: { enabled: true },
    })
  }
  for (const slug of removing) {
    const category = bySlug.get(slug)!
    await prisma.categorySender.updateMany({
      where: { categoryId: category.id, senderId: sender.id },
      data: { enabled: false },
    })
  }

  /* Routes AFTER the memberships, and recomputed against what was actually written. */
  const created =
    wouldAdd.length > 0
      ? await prisma.outreachPair.createMany({
          data: wouldAdd.map((t) => ({
            senderId: sender.id,
            targetId: t.id,
            cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
            enabled: true,
          })),
        })
      : { count: 0 }

  await audit(
    user.email,
    'sender.fleets.set',
    `SenderAccount:${handle}`,
    `${wanted.length === 0 ? 'no fleet' : wanted.join(' + ')}` +
      (adding.length ? `; added ${adding.join(', ')}` : '') +
      (removing.length ? `; removed ${removing.join(', ')}` : '') +
      `; ${created.count} route(s) created`,
  )
  refreshPath('/senders')
  refreshPath('/targets')
  refreshPath('/')
  return {
    ok: true,
    message:
      `@${handle} now sends for ${wanted.length === 0 ? 'no fleet — it writes to nobody' : wanted.join(' and ')}. ` +
      `${created.count} route(s) created.`,
  }
}

export async function setFleetTemplateBody(
  slug: string,
  body: string | null,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()

  const clean = slug.trim().toLowerCase()
  /**
   * AN UNKNOWN SLUG REFUSES rather than creating a row nothing reads — the same call the
   * add-account form makes. A `templateBody:` row for a fleet that does not exist would
   * look saved and be invisible to `templateForRoute`, which is the worst of both.
   */
  const category = clean ? await prisma.category.findUnique({ where: { slug: clean } }) : null
  if (!category) return { ok: false, message: `There is no fleet called "${slug}".` }
  if (clean === DEFAULT_CATEGORY_SLUG) {
    return {
      ok: false,
      message: 'The default fleet’s message is the one above — edit it there.',
    }
  }

  const key = fleetTemplateKey(clean)

  if (body === null || body.trim().length === 0) {
    await prisma.setting.deleteMany({ where: { key } })
    await audit(user.email, 'setting.changed', `Setting:${key}`, `${category.name} standard message cleared`)
    refreshPath('/')
    return {
      ok: true,
      message: `Cleared. Nothing is sent to ${category.name} companies until a message is written here.`,
    }
  }

  const verdict = checkTemplateBody(body)
  if (!verdict.ok) return { ok: false, message: verdict.reason }

  await setSetting(key, body.trim())
  await audit(
    user.email,
    'setting.changed',
    `Setting:${key}`,
    `${category.name} standard message set (${body.trim().length} chars)`,
  )
  refreshPath('/')
  return {
    ok: true,
    message: `Saved. New drafts for ${category.name} companies use this text, and any that were held for want of a message can now go out.`,
  }
}

/**
 * ── THE SECOND MESSAGE (2026-09-01, Tabish) ────────────────────────────────
 *
 * A THIRD template action rather than a flag on either of the two above, and the reason is
 * the same one that split `setFleetTemplateBody` off from `setSingleTemplateBody`: the three
 * boxes do different things with an empty one, and merging them makes that difference a
 * runtime branch nobody reads.
 *
 *   the standard message   — clearing RESTORES the shipped copy. Sending continues.
 *   a second FLEET's copy  — clearing means nobody has written it; that fleet is refused.
 *   the FOLLOW-UP          — clearing means no page ever writes a SECOND message to anyone.
 *                            First touches are untouched.
 *
 * It validates with `checkFollowUpBody`, not `checkTemplateBody`, because the two disagree
 * about braces: the standard message refuses every `{{token}}` and this one REQUIRES exactly
 * `{{post}}`. Without the token every follow-up from a page carries identical bytes, so
 * follow-up #2 would be refused as a repeat — the wall this feature exists to remove,
 * rebuilt one storey up and found weeks later as a queue that stopped draining.
 *
 * `slug` is null for the DEFAULT fleet, matching the key shapes in `followUpTemplate.ts`.
 */
export async function setFollowUpBody(
  slug: string | null,
  body: string | null,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()

  const clean = slug?.trim().toLowerCase() ?? null
  let name = 'default'
  if (clean !== null && clean !== DEFAULT_CATEGORY_SLUG) {
    /* An unknown slug REFUSES rather than creating a row nothing reads — the same call the
       fleet-template action makes, for the same reason: a `followUpBody:` row for a fleet
       that does not exist would look saved and be invisible to `followUpForRoute`. */
    const category = await prisma.category.findUnique({ where: { slug: clean } })
    if (!category) return { ok: false, message: `There is no fleet called "${slug}".` }
    name = category.name
  }
  const key = clean === null || clean === DEFAULT_CATEGORY_SLUG ? FOLLOW_UP_DEFAULT_KEY : followUpTemplateKey(clean)

  if (body === null || body.trim().length === 0) {
    await prisma.setting.deleteMany({ where: { key } })
    await audit(user.email, 'setting.changed', `Setting:${key}`, `${name} follow-up message cleared`)
    refreshPath('/')
    return {
      ok: true,
      message:
        'Cleared. No page writes a second message to anyone in this fleet until one is written here. ' +
        'First messages are unaffected.',
    }
  }

  const verdict = checkFollowUpBody(body)
  if (!verdict.ok) return { ok: false, message: verdict.reason }

  await setSetting(key, body.trim())
  await audit(
    user.email,
    'setting.changed',
    `Setting:${key}`,
    `${name} follow-up message set (${body.trim().length} chars)`,
  )
  refreshPath('/')
  return {
    ok: true,
    message:
      'Saved. Companies with a paid post nobody has written about yet can now receive a second ' +
      'message naming that post. Volume is unchanged — the allowance still permits one message ' +
      'per paid post.',
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
/**
 * ── CONNECT WORKS FROM THE HOSTED WEBSITE NOW, VIA THE DEVICE RELAY ──────────
 *
 * On a machine that may drive a browser (`SEND_ENABLED` — localhost, dev), this opens
 * Chrome HERE, exactly as before. On the HOSTED dashboard the server has no browser and
 * must never (the datacenter cookie-transplant the whole design forbids), so it writes a
 * request addressed to a device and the operator's own agent opens the window there. Both
 * paths settle through the identical `ConnectState`, so the client flow is unchanged. See
 * src/outreach/connectRelay.ts.
 */
export async function connectAccount(handle: string, device?: string): Promise<ConnectState> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { state: 'error', message: `@${handle} is not one of your accounts` }
  await audit(user.email, 'sender.connect.start', `SenderAccount:${handle}`)

  if (env.SEND_ENABLED) {
    const result = await startConnect(handle)
    // `startConnect` can report connected immediately (the profile was already logged in,
    // identity-verified against Instagram) — a path `checkConnect` never sees, so it must
    // be recorded here or that login leaves no trace.
    if (result.state === 'connected') await recordConnected(handle, user.email, result.verified)
    return result
  }

  // Two Macs online and no Mac named is REFUSED, never resolved to the freshest heartbeat —
  // that is how the first Connect a new operator pressed was relayed to the wrong home IP
  // (2026-09-10). See `resolveConnectTarget`.
  const online = await onlineSendingDevices()
  const verdict = resolveConnectTarget(device, online)
  if (!verdict.ok && verdict.reason !== 'none-online') {
    return { state: 'error', message: connectTargetProblem(verdict, device, online) }
  }
  const target = verdict.ok ? verdict.device : null
  if (!target) {
    return {
      state: 'error',
      message:
        'No sending device is online. Install the agent on the Mac that will send from this ' +
        'account (Download the installer), start it, then try Connect again.',
    }
  }
  const request = await enqueueConnectRequest({ handle, device: target, requestedBy: user.email })
  return requestToConnectState(request, handle)
}

/** Polled by the page every few seconds while the Chrome window is open. */
export async function checkConnect(handle: string): Promise<ConnectState> {
  const user = await requireOperator()
  if (env.SEND_ENABLED) {
    const result = await pollConnect(handle)
    if (result.state === 'connected') await recordConnected(handle, user.email, result.verified)
    return result
  }
  // Hosted: the device recorded the session itself when it reached 'connected'; the server
  // only reads the relayed status and refreshes the page once it lands.
  const state = requestToConnectState(await readConnectRequest(handle), handle)
  if (state.state === 'connected') refreshPath('/')
  return state
}

/** The devices currently running an agent, freshest first — the sign-in target picker. */
const DEVICE_FRESH_MS = 2 * 60_000

/**
 * ── CHOOSE THE SENDING MAC (2026-09-10) ──
 * The one Mac that sends, sweeps replies and looks up brands; every other Mac holds,
 * whatever is signed in there (`src/outreach/activeDevice.ts`). Only a Mac that is paired or
 * beating can be chosen — a typo must not silence the fleet — and the flip is audited with
 * the Mac it replaced, because months later that row is the only record of why sending
 * moved. The agents read the Setting on their next tick; nothing is restarted.
 */
export async function setActiveDevice(device: string): Promise<{ ok: boolean; message: string }> {
  const user = await requireOperator()
  const name = device.trim()
  const online = await onlineSendingDevices()
  const known = new Set([...listPairedDevices().map((d) => d.name), ...online])
  if (!known.has(name)) {
    return { ok: false, message: `${name || '(nothing)'} is not a paired or online Mac — nothing changed.` }
  }
  /**
   * A NAME TWO MACS CARRY CANNOT BE CHOSEN (2026-10-09). The sending Mac is whichever Mac's name
   * equals this Setting, so selecting a name two Macs run under makes BOTH of them the sending Mac
   * — two dispatchers, two home IPs, one set of accounts. Refused before anything is written.
   */
  const now = Date.now()
  const beatingUnderName = (await readPresence()).filter((d) => d.device === name && now - new Date(d.at).getTime() < DEVICE_FRESH_MS)
  if (beatingUnderName.length > 1) {
    return {
      ok: false,
      message: `Two Macs are running as “${name}” — selecting it would make both of them send. Give one of them another name first (remove it under Paired Macs, then open DS Sales Agent on it again); nothing changed.`,
    }
  }
  if (new Set(listPairedDevices().filter((d) => d.name === name).map((d) => d.fingerprint)).size > 1) {
    return {
      ok: false,
      message: `Two paired Macs carry the name “${name}” — selecting it would make both of them send. Remove one under Paired Macs (each is listed with its key) and pair it again under another name; nothing changed.`,
    }
  }
  const prev = (await getSettings()).activeDevice
  if (prev === name) return { ok: true, message: `${name} is already the sending Mac.` }
  await setSetting(SETTING_KEYS.activeDevice, name)
  await audit(
    user.email,
    'device.active.set',
    'Setting:activeDevice',
    `${name} (was ${prev ?? 'none'}) — it now sends, reads replies and looks up brands; every other Mac holds`,
  )
  invalidateCeoView()
  refreshPath('/')
  refreshPath('/senders')
  const offline = online.includes(name) ? '' : ' — it is not online yet, so nothing sends until it is'
  return { ok: true, message: `${name} is the sending Mac now${offline}.${prev ? ` ${prev} holds from its next tick.` : ''}` }
}

export async function listSendingDevices(): Promise<Array<{ device: string; handles: string[] }>> {
  await requireOperator()
  const now = Date.now()
  return (await readPresence())
    .filter((d) => now - new Date(d.at).getTime() < DEVICE_FRESH_MS)
    .map((d) => ({ device: d.device, handles: d.handles }))
}

/** The freshest present device, or null when none is online. Used when the UI names none. */
/** Every Mac beating within `DEVICE_FRESH_MS`, by name — the set a Connect may be addressed to. */
async function onlineSendingDevices(): Promise<string[]> {
  const now = Date.now()
  return (await readPresence())
    .filter((d) => now - new Date(d.at).getTime() < DEVICE_FRESH_MS)
    .map((d) => d.device)
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
  refreshPath('/')
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
  refreshPath('/')
  return {
    ok: true,
    message:
      `@${handle} is active again, and unattended sending across the fleet is released. ` +
      `Auto-send for this account is still off — arm it deliberately.`,
  }
}

/**
 * ── WHO MAY USE THIS DASHBOARD, AND AT WHAT LEVEL ───────────────────────────
 *
 * People arrive as VIEWERS (the invite code lands a viewer — a leaked code must never reach
 * a Send button, `roles.ts`). An operator promotes a trusted person to operator here, and
 * every promotion is audited under the promoter's name so "who can send from a revenue
 * account" is always answerable. Promotion is a per-person act, deliberately, rather than a
 * shared operator login that would make every action audit as one indistinguishable actor.
 */
export async function listTeam(): Promise<Array<{ email: string; role: Role; isSelf: boolean }>> {
  const actor = await requireOperator()
  const users = await prisma.user.findMany({ orderBy: { email: 'asc' }, select: { email: true, role: true } })
  return users.map((u) => ({
    email: u.email,
    role: parseRole(u.role),
    isSelf: u.email.toLowerCase() === actor.email.toLowerCase(),
  }))
}

export async function setUserRole(email: string, role: Role): Promise<MutationResult> {
  const actor = await requireOperator()
  const normalised = email.trim().toLowerCase()
  /**
   * You cannot change your OWN role. It stops the two ways this bites: an operator
   * demoting themselves into a locked-out dashboard (the key-inside-the-locked-door
   * shape), and — since every other operator can still act — it keeps at least one
   * operator standing by construction whenever one exists.
   */
  if (normalised === actor.email.toLowerCase()) {
    return { ok: false, message: 'You cannot change your own role — ask another operator to do it.' }
  }
  const target = await prisma.user.findUnique({ where: { email: normalised } })
  if (!target) return { ok: false, message: `No account for ${normalised}.` }

  const next: Role = role === 'operator' ? 'operator' : 'viewer'
  await prisma.user.update({ where: { id: target.id }, data: { role: next } })
  await audit(
    actor.email,
    next === 'operator' ? 'user.promoted' : 'user.demoted',
    `User:${normalised}`,
    `role set to ${next}`,
  )
  refreshPath('/senders')
  return {
    ok: true,
    message:
      next === 'operator'
        ? `${normalised} is now an operator — they can connect accounts, send, and arm autopilot.`
        : `${normalised} is now a viewer — they can watch but not change anything.`,
  }
}

export async function abortConnect(handle: string): Promise<{ ok: true }> {
  const user = await requireOperator()
  if (env.SEND_ENABLED) {
    await cancelConnect(handle)
  } else {
    // Deleting the request tells the device to close the window it opened (its next pass
    // finds a live window with no backing request and cancels it).
    await deleteConnectRequest(handle)
  }
  await audit(user.email, 'sender.connect.cancel', `SenderAccount:${handle}`)
  refreshPath('/')
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
 * PAIRS ARE CREATED LIVE. The per-route chip was deleted on 2026-08-08 (one switch), so a
 * pair row IS a live route and adding an account DOES widen what the rotation writes to.
 * What stands between adding and sending is the Autopilot switch, the caps, the cooldown, the
 * cohort ladder and a hand-logged-in session — real rules, but a SHARED brake rather than a
 * per-row one. The comment here said "New pairs start DISABLED" until 2026-09-04, three weeks
 * after that stopped being true; a false invariant in a comment is why nobody looks.
 */
/**
 * ── WHICH FLEET IS THIS ACCOUNT FOR? (2026-08-25, Tabish) ──────────────────
 *
 * *"There is no segregation between adding accounts for the two types of categories I
 * mentioned in the UI."* He is right — the rule shipped and the only way to put an account in
 * the second fleet was a CLI command, which is the "a feature that works only when someone
 * runs a command is not running" failure one door along.
 *
 * The membership is written BEFORE the routes are created, and that order is the whole
 * correctness of it: `routeAllowed` reads the memberships, so a category written afterwards
 * would leave the new account already wired to every recipient of the OTHER fleet.
 *
 * An empty slug means the default category, which is what every existing account carries and
 * what the form's first option says. See `senderCategories.ts`.
 */
export async function addSender(
  handleRaw: string,
  displayNameRaw: string,
  categorySlugRaw = '',
): Promise<MutationResult> {
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
    /**
     * ── AND IT NAMES THE WAY BACK, WHICH IS NOT "ADD IT AGAIN" (2026-08-26) ──
     *
     * Tabish asked how to delete a retired account and re-add it. He cannot, and the honest
     * answer is worth more than a workaround: `removeSender` DELETES only an account that
     * never delivered anything, and RETIRES one that did — because `OutreachAttempt.pairId`
     * is `ON DELETE CASCADE`, so deleting the account erases the record that a real person
     * received a real message, which is what stops them being contacted twice. That is the
     * standing removal rule and it is not negotiable for one account's tidiness.
     *
     * So "re-add" is "Put back in the rotation", on its own row, which since the same day
     * also restores a retired account to ACTIVE. Saying that here is the difference between
     * a refusal and a dead end.
     */
    return {
      ok: false,
      message:
        `@${handle} is already one of your accounts, ${where}. ` +
        `Nothing was changed. To use it again, open that group and press "Put back in the rotation" on its row — ` +
        `that is the way back, and it restores a retired account to active. ` +
        `An account that has delivered a message is never deleted outright, because that record is what stops ` +
        `the same person being contacted twice.`,
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
   * THE FLEET, WRITTEN BEFORE THE ROUTES BELOW READ IT.
   *
   * An unknown slug is a REFUSAL to guess rather than a silent fall back to the default: the
   * default is what a bollywood sender gets, and quietly giving it to an account somebody
   * meant to put in the marketing fleet is how one page ends up cold-pitching the other
   * fleet's companies — the exact thing this whole category rule exists to stop.
   */
  const categorySlug = categorySlugRaw.trim().toLowerCase()
  if (categorySlug !== '') {
    const category = await prisma.category.findUnique({ where: { slug: categorySlug } })
    if (!category) {
      return { ok: false, message: `There is no "${categorySlug}" fleet. Nothing was added.` }
    }
    await prisma.categorySender.create({ data: { categoryId: category.id, senderId: sender.id } })
    await audit(user.email, 'category.member.added', `Category:${category.id}`, `sender @${handle} added to ${categorySlug}`)
  }

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
  /* One read for the whole walk. A new sender belongs to whichever category it was added
     with, so a MARKETING sender gets routes to marketing recipients and to nobody else. */
  const memberships = await readCategoryMemberships()
  const allowed = targets.filter((t) =>
    routeAllowed({
      senderHandle: handle,
      targetHandle: t.handle,
      senderCategories: categoriesFor(memberships.bySenderHandle, handle),
      targetCategories: categoriesFor(memberships.byTargetHandle, t.handle),
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
  refreshPath('/')
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
 * has already written to. So an account holding anything a rule still reads is
 * RETIRED (out of the rotation, row and rows kept) rather than destroyed; only an
 * account holding nothing but drafts released unsent is deleted outright.
 *
 * ── DELIVERED WAS THE WRONG TEST FOR "HOLDS NOTHING" (2026-10-09) ─────────
 *
 * This counted SENT/REPLIED alone and, at zero, ran `senderAccount.delete` — and
 * `OutreachPair.sender` and `OutreachAttempt.sender` are ON DELETE CASCADE. So on an
 * account that had never delivered it erased exactly what the hand-off had just kept:
 * a `not-in-thread` park (the recipient may HAVE it), a `profile-gone` park (the
 * recipient's 7-day stop), a SENDING row mid-drive (whose delivery then had no row to
 * land on), and a superseded draft carrying a reply (the permanent fact that retires
 * the standard introduction for that recipient). `remove-sender-message.ts` has the
 * rule; the delete below carries it.
 *
 * ── A RETIRED ACCOUNT IS NOT PAUSED ───────────────────────────────────────
 *
 * Retiring wrote `status: 'PAUSED'`, and the reply sweep reads only ACTIVE senders'
 * threads — so a retired account's open conversations dropped out of it: 430 for
 * @bachelorssociety, 299 never read (1 Sept), fixed then by hand as ACTIVE +
 * `fleetMember: false`, the burner's shape. Status is left as it is, which also means
 * a CHALLENGED flag is never cleared as a side effect. What PAUSED did incidentally —
 * hold that account's waiting drafts — is done explicitly below: nothing waiting is
 * left on it, because the dispatcher delivers any READY draft of an ACTIVE account.
 *
 * The Chrome profile is deliberately left on disk. Deleting it would throw away the
 * device identity built up by the hand login, which is unrecoverable and would make
 * a future re-add look like new hardware to Instagram.
 */
export async function removeSender(handle: string): Promise<MutationResult> {
  const user = await requireOperator()
  const sender = await prisma.senderAccount.findUnique({ where: { handle }, select: { id: true } })
  if (!sender) return { ok: false, message: `@${handle} not found.` }

  await cancelConnect(handle)

  /**
   * OUT OF THE ROTATION FIRST, THEN THE QUEUE IS RELEASED, THEN THE ROW IS SETTLED.
   *
   * `fleetMember: false` first, so the planner (which reads this flag live, on the
   * server) cannot elect this account for a fresh recipient in the window between the
   * hand-off reading the queue and the row being retired — otherwise a 15-minute
   * planning pass could re-create the very drafts just released. A pass that started
   * BEFORE this write re-reads the flag before it writes a draft (`plan.ts`).
   *
   * Then the queue: Tabish's rule (2026-08-19) is that removing a sender must never
   * cost a message. Each waiting draft is RELEASED (2026-10-09), never re-pointed, and
   * the planner writes the page rotation elects next its OWN message on its next pass —
   * `handOff.ts` says why moving the bytes was wrong. A recipient another account
   * already covers, or a retired one, is discarded; all of it through the one discard
   * writer, audited.
   */
  await prisma.senderAccount.update({ where: { handle }, data: { fleetMember: false } })
  const handOff = await handOffWaitingDrafts({ senderId: sender.id, senderHandle: handle, actor: user.email })

  /**
   * WHAT THE HAND-OFF KEPT FOR WANT OF A PAGE IS WITHDRAWN, NOT LEFT TO SEND.
   *
   * The hand-off keeps a draft when no other page sends for that recipient's fleet. Left
   * here it would be delivered by the dispatcher from an account that was just removed —
   * a retired account stays ACTIVE (above) and the dispatcher never reads `fleetMember`.
   * The same predicate the hand-off released by, the same writer, audited. A send already
   * in flight is refused by that writer's status guard and stays where it is.
   */
  let withdrawn = 0
  const stranded = await prisma.outreachAttempt.findMany({ where: releasableWhere(sender.id), select: { id: true } })
  for (const a of stranded) {
    const r = await discardAttempt({
      attemptId: a.id,
      reason:
        `@${handle} was removed and no other account sends for this recipient's fleet — withdrawn unsent; ` +
        `the planner writes to them again once an account for their fleet exists`,
      actor: user.email,
    })
    if (r.ok) withdrawn += 1
  }
  const queue = { released: handOff.released, discarded: handOff.discarded, withdrawn }
  const handOffDetail =
    `hand-off: ${handOff.released} released, ${handOff.discarded} discarded, ${handOff.kept} kept; ` +
    `${withdrawn} withdrawn on removal`

  /**
   * THE CHECK IS THE STATEMENT, as in `removeTarget`. A count read a moment earlier is passed
   * by a send that lands in between. A row keeps this account when anything still reads it —
   * every status but SKIPPED, and a SKIPPED row carrying a reply (`keepsSender`).
   *
   * Three clauses, one per way a delete reaches a row this account does not solely own:
   *   - its own attempts (the `OutreachAttempt.sender` cascade);
   *   - its PAIRS' attempts — an attempt whose denormalised `senderId` drifted from its pair's
   *     is not in the first relation, and the pair cascade takes it all the same;
   *   - its VARIANTS' attempts on another account — the old re-pointing hand-off left those, and
   *     `OutreachAttempt.variant` is ON DELETE RESTRICT, so the cascade to this account's
   *     variants would throw after `fleetMember` and the hand-off had committed.
   * Any of them present → nothing is deleted, and the account is retired below.
   */
  const keeps = {
    OR: [{ status: { not: 'SKIPPED' } }, { repliedAt: { not: null } }, { replyPostedAt: { not: null } }],
  } satisfies Prisma.OutreachAttemptWhereInput
  const del = await prisma.senderAccount.deleteMany({
    where: {
      id: sender.id,
      attempts: { none: keeps },
      pairs: { none: { attempts: { some: keeps } } },
      variants: { none: { attempts: { some: { senderId: { not: sender.id } } } } },
    },
  })

  if (del.count === 1) {
    await audit(user.email, 'sender.deleted', `SenderAccount:${handle}`, `held nothing a rule reads; ${handOffDetail}`)
    refreshPath('/')
    return { ok: true, message: removeSenderResult({ handle, outcome: 'deleted', queue }) }
  }

  /** Worded from what it holds NOW, read after the delete refused — never from a count taken before. */
  const [rows, borrowed] = await Promise.all([
    prisma.outreachAttempt.findMany({
      where: { OR: [{ senderId: sender.id }, { pair: { senderId: sender.id } }] },
      select: { status: true, failureCode: true, repliedAt: true, replyPostedAt: true },
    }),
    prisma.outreachAttempt.count({
      where: {
        variant: { senderId: sender.id },
        NOT: { OR: [{ senderId: sender.id }, { pair: { senderId: sender.id } }] },
      },
    }),
  ])
  const held = tallyHeld(rows)

  /**
   * Never `status` — see the docblock: PAUSED hides its conversations from the reply sweep,
   * and writing ACTIVE would clear a CHALLENGED flag. `fleetMember` is already false.
   */
  const [retired] = await prisma.$transaction([
    prisma.senderAccount.updateMany({ where: { id: sender.id }, data: { autoSendEnabled: false } }),
    prisma.outreachPair.updateMany({ where: { senderId: sender.id }, data: { enabled: false } }),
  ])
  if (retired.count === 0) return { ok: false, message: `@${handle} was removed by someone else meanwhile.` }
  await audit(
    user.email,
    'sender.retired',
    `SenderAccount:${handle}`,
    `kept: ${held.delivered} delivered, ${held.mayHaveReached} may have reached, ${held.pageGone} page gone, ` +
      `${held.sending} sending, ${held.replies} replies, ${held.other} other, ${borrowed} borrowed-variant; ` +
      handOffDetail,
  )
  refreshPath('/')
  return { ok: true, message: removeSenderResult({ handle, outcome: 'retired', queue, held, borrowed }) }
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
  /** Which fleet; empty = the default. The reasoning is at the write, below. */
  categorySlugRaw = '',
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
  /**
   * ── A HANDLE ALREADY IN THE LIST: SAY WHAT IT IS, AND LET A REMOVED WATCH PAGE COME BACK ──
   *
   * This refused every existing row with *"@x is already a channel you watch"* — false for a
   * retired page and for a company, and a dead end once `removeTarget` stopped deleting
   * watched pages (2026-10-09): a removed page could then never be read again. Now each state
   * gets its own sentence, and exactly ONE is revived: a WATCH row re-added as WATCH. It
   * passes the SAME probe and feed vet as a brand-new watch add below, because a page that has
   * since vanished, or now returns nothing, must not be revived to read nothing, and the
   * identity line is the one defence that makes a wrong watch page visible.
   *
   * Never revived from here: OUR OWN pages (they are WATCH rows too since the role backfill,
   * and resuming reading them is ~1,500 feed requests a day and Tabish's call), and a retired
   * PROSPECT — clearing `optedOut` on a recipient makes it messageable, which is
   * `ig:unretire-target`'s job, on a badge it has just re-read. A role is never changed.
   */
  const existing = await prisma.targetAccount.findUnique({
    where: { handle },
    select: { id: true, role: true, optedOut: true, watchEnabled: true },
  })
  if (existing) {
    const ourSender = await prisma.senderAccount.findUnique({ where: { handle }, select: { id: true } })
    if (ourOwnPageHandles().includes(handle) || ourSender) {
      return { ok: false, message: `@${handle} is one of our own pages; it is not managed from this list.` }
    }
    if (existing.role === 'WATCH') {
      if (role === 'PROSPECT') {
        return { ok: false, message: `@${handle} is a page we watch, and a watched page is never messaged.` }
      }
      if (!existing.optedOut && existing.watchEnabled) {
        return { ok: false, message: `@${handle} is already a page we watch.` }
      }
      /* Falls through to the probe and the feed vet, then is revived below. */
    } else if (existing.optedOut) {
      return {
        ok: false,
        message:
          `@${handle} is retired — never messaged again, its history kept. ` +
          `\`pnpm ig:unretire-target @${handle}\` re-reads its badge if it should be messaged again.`,
      }
    } else {
      return { ok: false, message: `@${handle} is already a company we message.` }
    }
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
   * ── A WATCH PAGE EARNS ITS PLACE BY POSTING, NOT BY EXISTING (2026-08-26) ──
   *
   * MEASURED, and it is why this check exists: `@afaqs` was added as a watched channel on
   * 25 August from a list of names. The handle EXISTS, so `probeHandle` passed it — and its
   * feed returns **zero posts**. It sat watched for a day and produced nothing, while the
   * real account, `@afaqsdotcom`, published 22 posts in the same week. Tabish found it by
   * noticing the dashboard claimed afaqs had no paid posts when it plainly had several.
   *
   * This is *"existence is not identity"* arriving at the WATCH door, where CLAUDE.md
   * already warns it is not harmless: a wrong watch page mints real prospects that get real
   * DMs. The existing identity line (below) shows WHO Instagram says the handle is; it
   * cannot show that the account is silent, because a dormant page and a busy one look
   * identical in a profile lookup.
   *
   * ONLY FOR WATCH, and only on ZERO. A PROSPECT is never read, so its feed is irrelevant.
   * An unreachable feed is reported and admitted — a network blip must not refuse a real
   * page, the same direction `createBrandTarget` takes on a NULL badge — and a page with a
   * handful of old posts is admitted with a warning, because "stopped posting" is a
   * judgement for a person while "returns nothing at all" is a wrong handle.
   */
  let watchNote = ''
  if (role === 'WATCH') {
    try {
      // `record: false`: one handle a person typed is not the detection pass's answer, and must not
      // become the "server's" row the landing page explains an outage from (feed.ts).
      const feed = await fetchFeed(handle, { maxPosts: 12, maxPages: 1, record: false })
      const recent = feed.posts.filter((p) => new Date(p.postedAt).getTime() > Date.now() - 30 * 86_400_000).length
      if (feed.posts.length === 0) {
        return {
          ok: false,
          message:
            `@${handle} exists but its feed returns no posts at all, so watching it would find nothing. ` +
            `That usually means the handle is not the account you meant — check the spelling on Instagram.`,
        }
      }
      if (recent === 0) {
        watchNote =
          ` Note: nothing posted in the last 30 days, so it may be dormant — it is watched, but expect no paid posts from it.`
      }
    } catch {
      /* Unreachable is not a verdict. Admitted, and said so. */
      watchNote = ` Note: its feed could not be read just now, so how much it posts is unconfirmed.`
    }
  }

  /**
   * THE REVIVAL — reached only by a WATCH row re-added as WATCH (see above), and only after
   * the probe and the feed vet a new page passes. Its stored posts never left; reading
   * resumes on the next 15-minute pass. The fleet is NOT changed by re-adding: every prospect
   * already discovered through this page inherited the one it has, so moving it here would
   * split those companies from their source without saying so.
   */
  if (existing) {
    const fleets = await prisma.categoryTarget.findMany({
      where: { targetId: existing.id },
      select: { category: { select: { slug: true } } },
    })
    const current = fleets.map((f) => f.category.slug)
    const asked = categorySlugRaw.trim().toLowerCase()
    const fleetNote =
      asked !== '' && !current.includes(asked)
        ? ` Its fleet is unchanged (${current.length > 0 ? current.join(', ') : 'the default fleet'}) — adding it again does not move it.`
        : ''
    await prisma.targetAccount.update({ where: { id: existing.id }, data: { optedOut: false, watchEnabled: true } })
    const posts = await prisma.detectedCampaign.count({ where: { targetId: existing.id } })
    await audit(user.email, 'target.watch.resumed', `TargetAccount:${handle}`, `${posts} stored posts kept`)
    refreshPath('/')
    refreshPath('/targets')
    refreshPath('/paid-posts')
    return {
      ok: true,
      message:
        addTargetMessage('WATCH', handle, exists, facts) +
        watchNote +
        ` Its ${posts} stored post${posts === 1 ? ' was' : 's were'} kept.` +
        fleetNote,
    }
  }

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
   * THE FLEET, WRITTEN BEFORE THE ROUTES BELOW READ IT — same order and same reason as
   * `addSender`. An unknown slug refuses rather than falling back to the default.
   */
  /*
    A marketing WATCH page put here means every prospect discovered from its paid posts
    INHERITS that fleet (`brandTarget.ts`) and is messaged only by marketing senders. So this
    one field decides who will ever write to companies found through this channel.
  */
  const categorySlug = categorySlugRaw.trim().toLowerCase()
  if (categorySlug !== '') {
    const category = await prisma.category.findUnique({ where: { slug: categorySlug } })
    if (!category) {
      return { ok: false, message: `There is no "${categorySlug}" fleet. Nothing was added.` }
    }
    await prisma.categoryTarget.create({ data: { categoryId: category.id, targetId: target.id } })
    await audit(user.email, 'category.member.added', `Category:${category.id}`, `target @${handle} added to ${categorySlug}`)
  }

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
  /* One read for the whole walk — see readCategoryMemberships. */
  const memberships = await readCategoryMemberships()
  const allowed = senders.filter((s) =>
    routeAllowed({
      senderHandle: s.handle,
      targetHandle: handle,
      senderCategories: categoriesFor(memberships.bySenderHandle, s.handle),
      targetCategories: categoriesFor(memberships.byTargetHandle, handle),
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
  refreshPath('/')
  // The form lives on /targets; revalidating only '/' left the list beside it stale, so a
  // successful add read as "nothing happened" until the next auto-refresh.
  refreshPath('/targets')
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
    message: addTargetMessage(role, handle, exists, facts) + watchNote,
  }
}

/**
 * Remove a target — a watched channel or a company we message.
 *
 * ── IT DELETED A WATCHED CHANNEL'S WHOLE CORPUS (fixed 2026-10-09) ──────────
 *
 * This decided delete-or-retire on DELIVERED messages alone, and a watched page is never
 * messaged, so Remove on any WATCH row ran `targetAccount.delete` — and
 * `DetectedCampaign.target` is ON DELETE CASCADE. Every stored post went with it, with its
 * human label and the text read off its footage; every OTHER recipient's message that
 * claimed one of those posts lost its claim (`OutreachAttempt.campaign` is SET NULL); and a
 * prospect's not-in-thread park or in-flight SENDING row cascaded away with the prospect.
 * None of it could be fetched again — Instagram's feed reaches back 48 posts. The rule now
 * lives in `remove-target-message.ts` (PURE, shared with the card), and in short:
 *
 *   - a WATCH row is deleted only when it holds NO posts and NO attempts — undoing a wrong
 *     add — and that condition is INSIDE the delete statement, so nothing that arrives
 *     between the read and the write can be cascaded away. A row that fails it is retired;
 *   - a retired WATCH row stops being READ (`watchEnabled: false`; `optedOut` alone left the
 *     feed read with its footage skipped) and keeps its role, so it stays on the competitor
 *     list `excludedHandles()` reads and can never be minted as a prospect;
 *   - a PROSPECT is ALWAYS retired. Deleting one does not stop it being messaged: discovery
 *     mints a handle with no row, with live routes and none of its history.
 *
 * `optedOut` is a hard stop the governor and the gate check independently of pairs, so it
 * holds even if a pair is re-enabled later by accident.
 */
export async function removeTarget(handle: string): Promise<MutationResult> {
  const user = await requireOperator()
  const target = await prisma.targetAccount.findUnique({
    where: { handle },
    select: { id: true, role: true, _count: { select: { campaigns: true, attempts: true } } },
  })
  if (!target) return { ok: false, message: `@${handle} not found.` }

  let posts = target._count.campaigns
  let attempts = target._count.attempts
  const refresh = () => {
    refreshPath('/')
    refreshPath('/targets')
    refreshPath('/paid-posts')
  }

  if (removalVerdict({ role: target.role, campaigns: posts, attempts }) === 'delete') {
    /**
     * THE CHECK IS THE STATEMENT. A count read a moment ago is not a guard: the 15-minute
     * detect pass stores posts for a just-added page within minutes. Prisma emits this as one
     * `DELETE … WHERE … AND NOT EXISTS (…)`, and the pairs clause catches an attempt whose
     * denormalised `targetId` drifted from its pair — the pair cascade would take it too.
     */
    const del = await prisma.targetAccount.deleteMany({
      where: {
        id: target.id,
        role: 'WATCH',
        campaigns: { none: {} },
        attempts: { none: {} },
        pairs: { none: { attempts: { some: {} } } },
      },
    })
    if (del.count === 1) {
      await audit(user.email, 'target.deleted', `TargetAccount:${handle}`, '0 posts, 0 attempts')
      refresh()
      return { ok: true, message: removeTargetResult({ handle, outcome: 'deleted', posts: 0, attempts: 0, delivered: 0 }) }
    }
    /* Something arrived between the read and the delete. Retire it, worded from fresh counts. */
    const now = await prisma.targetAccount.findUnique({
      where: { id: target.id },
      select: { _count: { select: { campaigns: true, attempts: true } } },
    })
    posts = now?._count.campaigns ?? posts
    attempts = now?._count.attempts ?? attempts
  }

  const isWatch = target.role === 'WATCH'
  const delivered = await prisma.outreachAttempt.count({
    where: { targetId: target.id, status: { in: [...DELIVERED_STATUSES] } },
  })
  await prisma.$transaction([
    prisma.targetAccount.update({
      where: { id: target.id },
      /* Never the role: a WATCH row must stay a competitor. A prospect's `watchEnabled` is
         left alone — it is retired as a recipient, not as a page we read (7 Aug precedent). */
      data: isWatch ? { optedOut: true, watchEnabled: false } : { optedOut: true },
    }),
    prisma.outreachPair.updateMany({ where: { targetId: target.id }, data: { enabled: false } }),
  ])
  await audit(
    user.email,
    isWatch ? 'target.watch.retired' : 'target.retired',
    `TargetAccount:${handle}`,
    `${posts} posts, ${attempts} attempts (${delivered} delivered) kept`,
  )
  refresh()
  return {
    ok: true,
    message: removeTargetResult({ handle, outcome: isWatch ? 'watch-retired' : 'retired', posts, attempts, delivered }),
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
  refreshPath('/')
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
  refreshPath('/')
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
  refreshPath('/')

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
  refreshPath('/')
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
  refreshPath('/')
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
    refreshPath('/')
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
  refreshPath('/')
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
    refreshPath('/prospects')
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
  /**
   * A REMOVED WATCH PAGE IS NOT TURNED BACK ON FROM HERE (2026-10-09). Reading it again is
   * the Add form's job, which re-checks that the handle still exists and still posts — the
   * vet a removed page must pass like a new one. Turning reading OFF is always allowed: a
   * stop must never need permission.
   */
  if (on && target.role === 'WATCH' && target.optedOut) {
    return { ok: false, message: `@${handle} was removed — add it again to read it.` }
  }

  await prisma.targetAccount.update({ where: { handle }, data: { watchEnabled: on } })
  await audit(user.email, on ? 'target.watch.on' : 'target.watch.off', `TargetAccount:${handle}`)
  refreshPath('/prospects')
  /* The list with this control lives on /targets; '/prospects' is a redirect stub, so
     refreshing it alone left the row showing the old state. */
  refreshPath('/targets')
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
    refreshPath('/targets')
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
  refreshPath('/targets')
  return {
    ok: true,
    message: `@${handle} is in ${name}. Only that group's ${ringSize} account${ringSize === 1 ? '' : 's'} will write to them now.`,
  }
}


// ── PAIRING A MAC (2026-09-03) ────────────────────────────────────────────────

/**
 * The operator's click on /devices/enrol. Appends the Mac's own public key to the server's
 * authorized_keys under forward-only restrictions and releases the connection string to the
 * installer's next poll. Form action, so the approval page is a plain server component.
 */
export async function approveDevice(formData: FormData): Promise<void> {
  const user = await requireOperator()
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  const r = await approveEnrolment(code, user.email)
  if (!r.ok) return redirect(`/devices/enrol?code=${encodeURIComponent(code)}&error=${encodeURIComponent(r.reason)}`)
  await audit(user.email, 'device.paired', `Device:${r.deviceName}`, `key ${r.fingerprint} authorised for the database tunnel only`)
  redirect(`/senders?paired=${encodeURIComponent(r.deviceName)}`)
}

/**
 * Removes one Mac's tunnel key. Its agent loses the database on the next reconnect; nothing else changes.
 *
 * BY KEY FINGERPRINT (2026-10-09): by name, revoking one of two Macs that shared a name removed
 * both. The name travels only for the audit row a person reads.
 */
export async function revokeDevice(formData: FormData): Promise<void> {
  const user = await requireOperator()
  const fingerprint = String(formData.get('fingerprint') ?? '')
  const name = String(formData.get('name') ?? '')
  const removed = await revokePairedDevice(fingerprint)
  await audit(
    user.email,
    'device.revoked',
    `Device:${name}`,
    removed > 0 ? `${fingerprint}: ${removed} tunnel key line(s) removed` : `${fingerprint}: no paired key with that fingerprint`,
  )
  refreshPath('/senders')
}
