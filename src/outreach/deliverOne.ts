import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings, type RuntimeSettings } from '@/lib/settings'
import { randomInt } from '@/lib/time'
import { browserSender } from './senders/browser'
import { profileStatus } from './browser/profile'
import { recheckBeforeSend, isOverridable } from './gate'
import { thisMacRole } from './activeDevice'
import { browserShutdownRequested } from './shutdown'
import { recordDelivered, revertUndrivenClaim } from './recordSend'
import { claimForAttempt, settleClaims, type Reservation } from './reservations'
import { markChallenged } from './challenge'
import { markSessionInvalid, clearSessionInvalid } from './sessionHealth'
import { ensureConversationChecked } from './replyCheck'
import { probeHandle } from '@/detection/exists'
import {
  DELIVER_HELD,
  type DeliverMode,
  type DeliverOneResult,
  type FailedLadder,
  type StopWhy,
} from './deliverResult'

export { DELIVER_HELD }
export type { DeliverMode, DeliverOneResult, FailedLadder, StopWhy }

/**
 * The retry cap lives in `src/lib/constants.ts` and is re-exported here so the enforcer — this
 * file, since Stage 1.3 — still owns the name. It moved there because the FAILURES LIST on the
 * dashboard reads it as well, and a view model importing this module to get one number would
 * pull the browser stack into the Next server bundle. See the docblock there.
 */
export { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'

/** The row `deliverWaiting` loads and `sendNow` loads: an attempt with its pair, sender and target. */
export type WaitingAttempt = Prisma.OutreachAttemptGetPayload<{
  include: { pair: { include: { sender: true; target: true } } }
}>

/**
 * ── ONE DELIVERY FUNCTION, TWO CALLERS (Stage 1.3, audit M2 / M3 / M4 / M11) ─────────────
 *
 * Until now the unattended path (`deliverWaiting`, the loop in `deliver.ts`) and the attended
 * one (`sendNow`, the dashboard's Send button) each carried their own copy of "claim this
 * draft, drive it, file the outcome", and the copies had drifted — exactly the shape
 * `gate.ts` and `readThread.ts` were extracted to stop. MEASURED drift, and what it cost:
 *
 *   - `sendNow` CLAIMED READY→SENDING BEFORE it asked for the fleet lock, and on a refused
 *     lock flipped the row back and answered "Another message is being sent right now" about
 *     a draft it had flipped to SENDING and back — the false sentence on the hosted dashboard
 *     (its lock is always refused by `SEND_ENABLED=false`). It is also the only reason
 *     `parkOrphanedSending` needs a dwell. Both callers claim INSIDE the lock now.
 *   - `sendNow` skipped the anonymous dead-page probe: a button press could drive a Chrome
 *     profile at a deleted page, three minutes of browser activity from a revenue account for
 *     nothing. It asks the probe now — an anonymous request, not a drive.
 *   - the failure ladders (challenged / logged out / not-in-thread / recipient-unconfirmed /
 *     retryable) existed twice.
 *
 * `sendNow` also never read the thread a follow-up gets read on the unattended path, and that
 * difference is KEPT, on purpose: the read is a REAL browser drive and the rule here is that a
 * refactor adds none. See "THE EXPOSURE THIS CHANGES" below.
 *
 * The body below is `deliver.ts`'s per-attempt block, MOVED rather than rewritten, with the
 * differences between the two callers expressed as a function of `mode` and nowhere else.
 *
 * ── THE GUARD ORDER, and why each step sits where it does ─────────────────────────────────
 *
 *   1. `challengedThisRun`   an account Instagram flagged earlier in THIS run
 *   2. live sender status    the account row, read now, for the one row whose browser we drive
 *   3. the disk              a Mac that holds no profile for this account cannot send it
 *   4. `recheckBeforeSend`   every RULE about whether the message may go (gate.ts)
 *   5. the asks, EARLY       autopilot (unattended only), shutdown, sending Mac — BEFORE the
 *                            read, because the read is itself a browser drive
 *   6. the thread read       UNATTENDED ONLY: `ensureConversationChecked`, then the gate again
 *                            if it read. The Send button does not read (see the exposure below)
 *   7. the asks, LAST        the same three, immediately before the claim
 *   8. the atomic claim      READY→SENDING by `updateMany` (condition and write in one statement)
 *   9. the allowance claim   `claimForAttempt`, all-or-nothing, with the revert on refusal
 *  10. the spacing           when the CALLER says a drive already happened in this tick
 *  11. the anonymous probe   one request; `missing` parks with no drive
 *  12. the drive             `browserSender.send`, counted BEFORE the await
 *  13. settle, then record   `settleClaims`, then `recordDelivered` or the failure ladder
 *
 * Step 5 is new, and an EARLIER ask than any that existed: a guard asked earlier than today is
 * strictly safer (the reverse is never allowed here), and the read at step 6 can take a minute
 * with a real Chrome profile open. It is asked for BOTH callers although only the dispatcher
 * reads — for the button it sits directly before step 7's identical asks, a duplicate that costs
 * one query and can only ever refuse EARLIER. It is not removed for the button because the
 * tape both callers share is one order, and because "ask earlier" is the one direction a guard
 * here may always move.
 *
 * Nothing that drives a browser sits between step 7's asks and step 8's claim —
 * `tests/active-device.test.ts` pins that by position. The two window guards (steps 7-11 are
 * inside one `try`) put a claim whose drive never began back to READY through
 * `revertUndrivenClaim`.
 *
 * ── HOW THE TWO CALLERS DIFFER, every difference in one list ──────────────────────────────
 *
 *   unattended (the dispatcher)                       attended (the Send button)
 *   ─────────────────────────────────────────────     ───────────────────────────────────────
 *   re-asks the autopilot switch (steps 5, 7)          does not: a person substitutes for it
 *   reads the conversation before a stale follow-up    does NOT read: no browser drive is added
 *   (step 6), counted as a drive                       (it relies on `repliedAt` as of the last sweep,
 *                                                      as it always did)
 *   gate sees no overrides                             gate sees `mode.overrides` (whitelisted there)
 *   claims from READY                                  claims from READY or QUEUED
 *   `claimForAttempt({ attended: false })`             `{ attended: true }`: the hour bucket is skipped
 *   sentBy `autopilot:<handle>`, actor `autopilot`     `operator:<handle>` or `override(<codes>):<handle>`,
 *                                                      actor = the operator's email
 *   no start audit                                     `attempt.send.start[.override]` before the drive
 *   a lost claim is "already being sent"               the status is re-read for the sentence
 *   a drive-found `profile-gone` parks on first sight  falls to the ordinary retry (see below)
 *   a retryable failure goes to the BACK of the        stays READY with `attempts + 1`, no queue move, no
 *   queue and parks at MAX_DELIVERY_ATTEMPTS           park — and writes `attempt.send.failed`
 *   a checkpoint raises the autopilot alarm            markChallenged already alarms
 *   recipient-unconfirmed raises an alarm              audits `attempt.send.recipient-unconfirmed`
 *   not-in-thread raises an alarm                      the same alarm, plus `attempt.send.uncertain`
 *
 * The drive-found `profile-gone` row is the one difference nobody designed: the 9 Sept fix
 * added it to `deliver.ts` only. It is PRESERVED here as a mode difference rather than quietly
 * unified, because unifying changes what a person's press leaves behind (READY and a failure
 * audit today, a park tomorrow). The anonymous probe in step 11 is new to the attended path and
 * has only one sensible ladder, so it parks for both.
 *
 * ── DRIVES, AND WHAT THE BOUND COUNTS (audit M2) ──────────────────────────────────────────
 *
 * `drives` is the number of times THIS call opened a real browser at Instagram: one for the
 * pre-send read whenever the read ran (unattended only; `checked-now`, `reply-found`, `unreadable`,
 * `incomplete`, `checkpoint` — only `fresh` and `no-session` opened nothing), plus one for
 * `browserSender.send`, counted BEFORE its await. The dispatcher's `maxSendsPerTick` bounds the sum. `deliver.ts` used
 * to count the send alone, so a tick whose stale follow-ups each needed a read could drive
 * several profiles in one tick — each read is a Chrome window on a revenue account, and an
 * `unreadable` one is exactly what looped @acearteofficial's profile every two minutes.
 *
 * ── THE EXPOSURE THIS CHANGES, STATED ─────────────────────────────────────────────────────
 *
 * THE SEND BUTTON GAINS NO BROWSER DRIVE. The first cut of this function ran the pre-send thread
 * read for both callers, so a press on a stale follow-up could open a Chrome profile for up to a
 * minute under the fleet lock before it sent — a drive HEAD's `sendNow` never made, added by a
 * refactor whose rule is that it adds none, and added to the one path a person uses precisely
 * when they have a reason the scheduled path does not know about. It is unattended-only now.
 * What the button relies on instead is what it always relied on: `repliedAt` as of the last
 * sweep, through the gate. That is a real gap (a reply nobody has swept yet does not hold a
 * press) and it is HEAD's gap, stated rather than closed; closing it is an exposure change a
 * person decides — a one-condition edit at step 6, plus the tape and `sendNowAnswer`.
 *
 * The button does gain ONE anonymous probe (step 11): a request with no session from this
 * machine's own IP (decision 4), which can only turn a draft aimed at a deleted page into a
 * park with NO drive — strictly fewer browser drives than HEAD, never more.
 *
 * The unattended path gains nothing it did not have except the earlier asks and the bound
 * counting its reads.
 *
 * ── WHAT IT MUST NOT DO ───────────────────────────────────────────────────────────────────
 *
 * It does not take the send lock — both callers hold it already, and `withSendLock` refuses to
 * nest. It lets a throw from `browserSender.send` propagate, exactly as both callers always
 * did: the row stays SENDING and the orphan sweep parks it for a person to read the thread,
 * because after the drive started the recipient may hold the message. And every writer it calls
 * — the claim `updateMany`, `claimForAttempt`, `revertUndrivenClaim`, `settleClaims`,
 * `recordDelivered`, `markChallenged`, `markSessionInvalid`, `clearSessionInvalid` — is the sole
 * writer of its kind; nothing here re-inlines one.
 */
export async function deliverOne(a: {
  attempt: WaitingAttempt
  settings: RuntimeSettings
  mode: DeliverMode
  /** Accounts Instagram flagged during this run. The attended caller passes a fresh, empty set. */
  challengedThisRun: Set<string>
  /**
   * Sleep the send jitter before the probe and the drive. THE CALLER DECIDES, because only it
   * knows whether a drive already happened in this tick: `deliverWaiting` passes `driven > 0`.
   * It was `out.sent > 0`, so a FAILED first drive was followed back-to-back by the second with
   * no spacing (audit M3).
   */
  spaceBeforeDrive?: boolean
}): Promise<DeliverOneResult> {
  const { attempt, settings, mode, challengedThisRun } = a
  const { sender, target } = attempt.pair
  const pairKey = `${sender.handle}→${target.handle}`
  const unattended = mode.unattended
  const actor = mode.unattended ? 'autopilot' : mode.operator
  /** What was ACTUALLY crossed, from the whitelist — a stray value neither reaches the gate nor the audit trail. */
  const crossed = mode.unattended ? [] : (mode.overrides ?? []).filter(isOverridable)
  /** Browser drives this call has performed. Read by every return below, so it is always current. */
  let drives = 0

  const held = (reason: string, detail: string): DeliverOneResult => ({ kind: 'held', reason, detail, drives })
  const stop = (why: StopWhy, detail: string): DeliverOneResult => ({ kind: 'stop-tick', why, detail, drives })
  const failed = (
    f: Omit<Extract<DeliverOneResult, { kind: 'failed' }>, 'kind' | 'drives'>,
  ): DeliverOneResult => ({ kind: 'failed', ...f, drives })

  if (challengedThisRun.has(sender.id)) {
    return held(DELIVER_HELD.FLAGGED_THIS_RUN, 'this account was flagged by Instagram earlier in this run')
  }

  /**
   * Read the account's CURRENT status, immediately before driving its browser.
   *
   * The gate below checks the snapshot. That is the right thing to check for
   * everything that cannot change mid-run, and the wrong thing for the one that can:
   * `status` is written by this very loop, by `sendNow`, and by a human on the
   * dashboard, at any moment. A stale ACTIVE here means opening Chrome on a flagged
   * account.
   */
  const live = await prisma.senderAccount.findUnique({
    where: { id: sender.id },
    select: { status: true },
  })
  if (!live) {
    return held(DELIVER_HELD.SENDER_GONE, 'the sending account no longer exists')
  }
  if (live.status !== 'ACTIVE') {
    return held(DELIVER_HELD.SENDER_NOT_ACTIVE, `@${sender.handle} is ${live.status.toLowerCase()} right now`)
  }

  /**
   * Every RULE about whether this message may be sent lives in `gate.ts`, and this is
   * the same call the dashboard's Send button makes. Nothing above duplicates it.
   *
   * What the two checks above DO is re-read state that can change between the
   * `waiting` query and this moment, for the one row whose browser we are about to
   * drive: the account being deleted, and `status` — which is written by this very
   * loop, by `sendNow`, and by a human on the dashboard, at any time. A stale ACTIVE
   * there means opening Chrome on a flagged account, so it is a FRESHNESS concern
   * about an input, not a second copy of a rule. The gate then judges the snapshot,
   * which is correct for everything that cannot move mid-run.
   *
   * ONE SWITCH, 2026-08-08: an `autoSendEnabled` hold used to sit here too, and it was
   * the one genuinely duplicated rule — a permission decision made outside the gate.
   * It went with the per-account switch. Leaving it would have been worse than
   * redundant: the gate can no longer return `auto-send-off`, so `/messages` would
   * have rendered "Clear to send. Every check passes" over a draft this loop held
   * forever, for a reason deleted from `REMEDIES` and therefore on no screen at all.
   * That is the failure this project keeps rediscovering, so the invariant to preserve
   * is that a draft the gate permits is a draft this loop will attempt.
   */
  /**
   * HELD FOR FREE, BEFORE THE GATE (2026-09-10). A Mac whose disk lacks this account's
   * profile cannot send it, and the gate would say so — after its own queries, under the
   * fleet lock. MEASURED: a second Mac holding one profile evaluated all 44 waiting drafts
   * through the gate on every tick and held the lock for most of every poll period, starving
   * the Mac that could send. The disk answers in microseconds; the gate still rules on
   * everything else for the drafts this Mac can actually drive.
   *
   * The reason is the gate's own `'no-session'`: this IS that stop, asked first, so a caller
   * rendering it (the Send button adds its "press Connect" hint to exactly this reason)
   * treats it as the gate's.
   */
  if (!profileStatus(sender.handle).hasSession) {
    return held('no-session', `no-session — this Mac holds no signed-in profile for @${sender.handle}`)
  }
  const gate = await recheckBeforeSend(attempt, {
    unattended: mode.unattended,
    overrides: mode.unattended ? undefined : mode.overrides,
  })
  if (!gate.ok) {
    return held(gate.reason, gate.detail ?? gate.reason)
  }

  /**
   * ── THE ASKS, EARLY (Stage 1.3) — BEFORE THE READ, NEVER ONLY AFTER IT ───────────────────
   *
   * The thread read below is a REAL browser drive that can take a minute, and until now the
   * three questions that make a drive permissible — is the switch still on, has the agent been
   * told to stop, is this still the sending Mac — were asked only AFTER it. So a switch flipped
   * OFF, a SIGTERM, or a Mac handover landing in the gate's queries still opened a Chrome
   * profile at Instagram for the read, and only the claim was refused. Asked here too, the read
   * never starts on a stale permission. The same three are asked again at step 7, because the
   * read itself is a long window; the first ask is ADDITIONAL, never a replacement.
   *
   * ONLY THE DISPATCHER READS, but the shutdown and Mac asks are made for the Send button as
   * well: there they sit directly before step 7's identical asks and add one query, a duplicate
   * that can only refuse EARLIER. Do not delete them as redundant for the button — the first
   * ask is what keeps the dispatcher's read from starting, and the order is one shape for both.
   *
   * The autopilot switch is the dispatcher's alone: the Send button is a person acting, and a
   * human being present is exactly what substitutes for the switch (gate.ts, `unattended`).
   */
  if (mode.unattended && !(await getSettings()).autopilotEnabled) {
    log.step('autopilot was switched off mid-tick — stopping before the conversation read, nothing driven')
    return stop('autopilot-off', 'autopilot was switched off before the conversation read')
  }
  if (browserShutdownRequested()) {
    log.step('the agent is stopping — not reading another conversation, nothing driven')
    return stop('shutdown', 'the agent is stopping before the conversation read')
  }
  const roleBeforeRead = await thisMacRole()
  if (!roleBeforeRead.active) {
    log.step('the sending Mac changed mid-tick — stopping before the conversation read, nothing driven', { detail: roleBeforeRead.detail })
    return stop('role-changed', roleBeforeRead.detail)
  }

  /**
   * ── READ THE CONVERSATION BEFORE WRITING INTO IT AGAIN. Phase 6. ──────
   *
   * The gate above consults `repliedAt`, which is only as good as the last time anyone
   * looked. The scheduled sweep's capacity is a CONSTANT — eight conversations a day —
   * while the number of conversations grows with the fleet, so at the planned size a
   * follow-up would routinely land in a thread last read a week ago. The stop that
   * halts every sender the moment a human answers would still be there, reading data
   * nobody had refreshed.
   *
   * So the check moves to where the risk is, and only when this pair's thread is stale, so
   * its cost is proportional to messages sent rather than to prospects held.
   *
   * ASKED FOR EVERY DRAFT, A FIRST TOUCH INCLUDED (review of C2, finding A). This was
   * `touchNumber > 1`, on the reasoning that a first touch has no conversation to read. It
   * can: when the recipient DM'd this page first, the inbox parks that reply on another
   * page's row (halting THAT page), rotation then elects this one, and the planner drafts it
   * a first touch — which went into the conversation they had opened, unread. The guard owns
   * the rule now: an ordinary first touch costs it a few queries and opens no browser; one
   * the inbox left evidence for, or whose pair already carries a reply, reads first.
   *
   * BEFORE the SENDING claim and before any reservation, so a hold leaves nothing to
   * unwind. And it FAILS CLOSED: a thread we could not read holds the message, because
   * "we could not look" must never be spent as though it were "nobody answered".
   *
   * UNATTENDED ONLY, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT (Stage 1.3 review). The
   * first cut of `deliverOne` ran this for the Send button too, which opened a Chrome profile
   * for up to a minute, under the fleet lock, on a press — a browser drive HEAD's `sendNow`
   * never made. A refactor adds no drive, so the button is held to HEAD's behaviour: it relies
   * on `repliedAt` as of the last sweep, through the gate above, exactly as before. The cost,
   * stated: a reply nobody has swept yet does not hold a press on a stale follow-up. Whether
   * the button should pay a read for that is an exposure decision for a person; it is this one
   * condition, the tape in `tests/deliver-one-two-callers.test.ts` and `sendNowAnswer`.
   */
  if (mode.unattended) {
    const conversation = await ensureConversationChecked({
      senderId: attempt.senderId,
      senderHandle: sender.handle,
      targetId: attempt.targetId,
      targetHandle: target.handle,
      attemptId: attempt.id,
      touchNumber: attempt.touchNumber,
    })
    if (!conversation.ok) {
      /**
       * EVERY REFUSAL BUT `no-session` CAME FROM A READ THAT OPENED CHROME (Stage 1.3, audit M2).
       * `no-session` is the one that returns before any browser: the profile is missing, so the
       * guard never launches. `reply-found`, `unreadable`, `incomplete` and `checkpoint` all
       * mean a real profile was driven at Instagram, and the dispatcher's per-tick bound has to
       * count it or a tick of stale follow-ups drives one profile per draft.
       */
      if (conversation.reason !== 'no-session') drives += 1

      /**
       * A checkpoint stops the account for the rest of this run. Everything else is about this
       * one conversation, so the loop moves on. (It is NOT a stop-tick: the other senders'
       * drafts are not evidence about this account, and `challengedThisRun` already keeps
       * every later draft of THIS sender from being driven.)
       */
      if (conversation.reason === 'checkpoint') {
        challengedThisRun.add(sender.id)
        return failed({
          ladder: 'read-checkpoint',
          failureCode: 'checkpoint',
          parked: false,
          challenged: true,
          detail: conversation.detail,
          attempts: attempt.attempts,
        })
      }

      /**
       * ── AN UNREADABLE READ IS A BROWSER DRIVE, AND IT COUNTS LIKE ONE (2026-09-01) ──
       *
       * `unreadable` and `incomplete` mean a REAL Chrome profile was just driven at
       * Instagram and came back without a usable read. Held in place, the draft kept its
       * queue position and the next tick drove the SAME profile again — MEASURED:
       * @acearteofficial's profile was deleted after its first touches, and the follow-up's
       * pre-send read failed `no-message-button` every ~2 minutes, indefinitely, from a
       * revenue account; @officialsleepwell looped the same way on an incomplete read.
       * That is the exact class the retry cap below was built for (the `no-composer`
       * loop of 2026-08-18), reintroduced on the READ path where nothing counts drives.
       *
       * So it takes the SAME discipline as a retryable send failure: to the BACK of the
       * queue with `attempts` incremented, and parked FAILED at MAX_DELIVERY_ATTEMPTS,
       * where the landing page names it with the re-queue and discard controls. A read
       * that never drove a browser (`no-session`) still holds for free below, and a found
       * reply is the gate's business — neither burns an attempt.
       *
       * ── THE WRITE IS THE GUARD (Stage 1.3 review) ──────────────────────────────────────
       *
       * This is the ONE status write on a row that is still waiting (READY), and it lands after
       * a read that can run for a minute. `discardAttempt`, `editAttemptBody` and the reply
       * sweep's supersede all carry `status IN (READY, QUEUED)` inside their own `where` and
       * none of them takes the fleet lock — so a draft a person discards DURING the read is
       * SKIPPED by the time the read comes back `unreadable`. A plain `update` by id wrote READY
       * straight over that, and the dispatcher then picked up and sent a message a person had
       * cancelled. Every other ladder write below acts on a SENDING row, which none of those can
       * touch; this is the only one that needed the condition in the statement (rule 50).
       *
       * Same predicate the claim at step 8 uses, so "may this row still be written" and "may it
       * still be claimed" cannot disagree. Lost, nothing is parked, bumped or logged as a hold:
       * the row is no longer this call's to speak for, and the sentence says what it is now.
       */
      if (conversation.reason === 'unreadable' || conversation.reason === 'incomplete') {
        const totalAttempts = attempt.attempts + 1
        const park = totalAttempts >= MAX_DELIVERY_ATTEMPTS
        const wrote = await prisma.outreachAttempt.updateMany({
          where: { id: attempt.id, status: 'READY' },
          data: {
            status: park ? 'FAILED' : 'READY',
            error: conversation.detail,
            // Its own code, not 'navigation': a read that could not see the thread is not a
            // failed SEND, and must not retire the pair (see FAILURE_CODES.unreadable).
            failureCode: 'unreadable',
            attempts: { increment: 1 },
            ...(park ? {} : { queuedAt: new Date() }),
          },
        })
        if (wrote.count === 0) {
          // Re-read for the SENTENCE only — never as a guard; the write above was the guard.
          const now = await prisma.outreachAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } })
          return held(DELIVER_HELD.CLAIM_LOST, `already ${(now?.status ?? 'gone').toLowerCase()}`)
        }
        if (park) {
          log.alarm('a waiting message’s conversation could not be read repeatedly and is parked — it will not be retried on its own', {
            pair: pairKey,
            attempts: totalAttempts,
            check: `pnpm ig:thread ${sender.handle} ${target.handle}`,
          })
        } else {
          log.step('waiting message held back', { pair: pairKey, reason: `${conversation.detail} — moved to the back of the queue` })
        }
        return failed({
          ladder: 'read-unreadable',
          failureCode: 'unreadable',
          parked: park,
          detail: conversation.detail,
          attempts: totalAttempts,
        })
      }

      // `reply-found` and `no-session`: a plain hold. The reply is already recorded.
      return held(conversation.reason, conversation.detail)
    }

    /**
     * Re-run the gate if the thread was actually opened.
     *
     * `ensureConversationChecked` can RECORD a reply, and the gate's verdict above was
     * computed before that. Re-asking is four cheap queries against one send; not
     * asking would mean the one code path able to discover a reply mid-delivery
     * discovers it and proceeds anyway.
     */
    if (conversation.reason === 'checked-now') {
      drives += 1
      // This block is the dispatcher's alone, so no overrides: the gate drops them when unattended.
      const again = await recheckBeforeSend(attempt, { unattended: true, overrides: undefined })
      if (!again.ok) {
        return held(again.reason, again.detail ?? again.reason)
      }
    }
  }

  /**
   * THE SWITCH, RE-READ AT THE LAST MOMENT (2026-08-19). Settings were read once at
   * the top of this call, and everything between that read and here — the gate, a
   * just-in-time conversation read that opens a real browser — can take a minute. At
   * the one-minute pace Tabish observed the tail: he flipped autopilot OFF and a send
   * that had already passed the top-of-call check still went out. One fresh query
   * closes that window to the only gap nothing can close: a browser already mid-paste,
   * which must finish or a message lands with no record of it.
   *
   * (The dispatcher's alone — see the early asks above for why the Send button does not ask.)
   */
  if (mode.unattended && !(await getSettings()).autopilotEnabled) {
    log.step('autopilot was switched off mid-tick — stopping before the claim, nothing sent')
    return stop('autopilot-off', 'autopilot was switched off before the claim')
  }
  /* The agent was told to stop while this tick evaluated: a claim now would start a drive the
     shutdown drain then has to wait on, or kill. See src/outreach/shutdown.ts. */
  if (browserShutdownRequested()) {
    log.step('the agent is stopping — not claiming another message, nothing sent')
    return stop('shutdown', 'the agent is stopping before the claim')
  }

  // SENDING is the lock: it stops the dashboard button and the dispatcher from both
  // driving the same attempt.
  /**
   * THE SENDING MAC, JUST IN TIME (2026-09-10). MEASURED: the tick asked at its start and again
   * at the lock, then spent two minutes evaluating 44 drafts and drove the first sendable one —
   * 80 s after the switch had made another Mac the sender. Same shape as the autopilot check
   * above, for the same reason: a long evaluation is a window, and the only moment that
   * matters is the one before the claim.
   */
  const roleNow = await thisMacRole()
  if (!roleNow.active) {
    log.step('the sending Mac changed mid-tick — stopping before the claim, nothing sent', { detail: roleNow.detail })
    return stop('role-changed', roleNow.detail)
  }

  /**
   * CLAIMED INSIDE THE LOCK, FOR BOTH CALLERS (Stage 1.3, audit M4). `sendNow` used to flip the
   * row to SENDING before asking for the lock and flip it back when the lock was refused, so a
   * refused lock answered "Another message is being sent right now" about a draft it had just
   * claimed — and `parkOrphanedSending` needed a 12-second dwell to tell that transient claim
   * from a corpse. Both callers reach this line already holding the lock, so a SENDING row is
   * only ever one whose claimant is driving it (or died driving it).
   *
   * Condition and write are ONE statement. The Send button accepts a QUEUED draft too (the
   * gate's `not-waiting` accepts READY and QUEUED); the dispatcher only ever drains READY.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: attempt.id, status: mode.unattended ? 'READY' : { in: ['READY', 'QUEUED'] } },
    data: { status: 'SENDING' },
  })
  if (claimed.count === 0) {
    if (unattended) return held(DELIVER_HELD.CLAIM_LOST, 'already being sent')
    // Re-read for the SENTENCE the person reads — never as a guard; the write above was the guard.
    const now = await prisma.outreachAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } })
    return held(DELIVER_HELD.CLAIM_LOST, `already ${(now?.status ?? 'gone').toLowerCase()}`)
  }

  /**
   * Claim the recipient's daily allowance ATOMICALLY, after the gate has decided.
   *
   * The gate counts and compares, which two concurrent runs both pass. This puts the
   * condition in a write on a unique key, so exactly one caller wins. Under rotation
   * it is the only thing standing between 63 senders and one inbox — `cooldownDays` is
   * per pair and cannot see the other 62.
   *
   * The fleet buckets are claimed here too, in the same all-or-nothing call. The hourly
   * one is what stops fourteen drafts leaving inside one hour; `attended: false` is
   * explicit because this is the unattended path and the hour bucket exists for exactly
   * it — a person pressing Send one message at a time is not a cluster. The attended caller
   * passes `attended: true`, which skips the HOUR bucket and only that one: the DAY bucket is
   * a volume ceiling, and daily caps are not crossable by a person either.
   */
  /**
   * EVERYTHING FROM THE CLAIM TO THE DRIVE IS GUARDED (2026-10-09). A database error in here
   * left the row SENDING with no browser ever opened, and the orphan sweep then parked it as
   * possibly delivered — holding the pair for good. See `revertUndrivenClaim`.
   */
  let claimHeld: readonly Reservation[] = []
  try {
    const claim = await claimForAttempt({
      attemptId: attempt.id,
      pairId: attempt.pairId,
      maxPerPairPerDay: settings.maxPerPairPerDay,
      fleetMaxPerHour: settings.fleetMaxPerHour,
      fleetMaxPerDay: settings.fleetMaxPerDay,
      attended: !unattended,
    })
    if (!claim.ok) {
      // Put it back where it was. Nothing was sent, so nothing is lost.
      await prisma.outreachAttempt.updateMany({
        where: { id: attempt.id, status: 'SENDING' },
        data: { status: 'READY' },
      })

      /**
       * A FLEET refusal ends the tick; a per-pair one does not.
       *
       * The difference is what the refusal is about. "This channel has had its message
       * today" says nothing about the next attempt in the queue, so the loop should carry
       * on. "The fleet has used this hour's pace" is true of every remaining attempt, so
       * continuing would gate, claim and roll back all of them one by one — dozens of
       * writes to reach the identical answer, and a log full of the same sentence.
       */
      if (claim.reason === 'fleet-hourly-pace' || claim.reason === 'fleet-daily-cap') {
        log.step('fleet pacing reached — the rest wait for the next tick', { reason: claim.reason })
        return stop('fleet-pace', claim.detail)
      }
      return held(claim.reason, claim.detail)
    }
    claimHeld = claim.held

    /**
     * Space consecutive sends.
     *
     * SEND_JITTER_MIN/MAX_SECONDS were parsed, range-validated, cross-checked
     * (min <= max) and documented in .env as "Human-like delay bounds between
     * consecutive DMs" — and read by nothing. There was no delay between consecutive
     * sends at all. At 1-2/day that is academic; the danger is config asserting a
     * control that does not exist, and raising volume is exactly when someone would
     * rely on it.
     *
     * It also serialises the clipboard, which is process-global: two overlapping sends
     * could otherwise interleave copy and paste and put message A into thread B.
     *
     * THE CALLER DECIDES WHETHER ONE IS DUE (audit M3). It was gated on `out.sent > 0` — a
     * message DELIVERED earlier in the tick — so with `maxSendsPerTick` above 1 a FAILED first
     * drive was followed back-to-back by the second: two Chrome drives at Instagram with no
     * spacing, exactly when something was already going wrong. What spacing is about is a
     * drive having happened, so `deliverWaiting` passes `driven > 0`. The sleep stays HERE —
     * inside the lock, before the probe — and must not move out of it: the clipboard argument
     * above is about holding the lock across the wait.
     */
    if (a.spaceBeforeDrive) {
      const waitSeconds = randomInt(env.SEND_JITTER_MIN_SECONDS, env.SEND_JITTER_MAX_SECONDS)
      log.step('spacing before the next send', { seconds: waitSeconds })
      await new Promise((r) => setTimeout(r, waitSeconds * 1000))
    }

    /**
     * ONE ANONYMOUS REQUEST BEFORE A BROWSER DRIVE (9 Sept 2026). A recipient admitted as verified
     * can cease to exist — @acearteofficial (1 Sept), @hemantpandeyji (8 Sept) — and until now the
     * first anyone learned of it was Chrome standing on "Sorry, this page isn't available" from a
     * revenue account, three times per sender. `probeHandle` asks Instagram's profile endpoint
     * with no session (decision 4) from this machine's own IP; `missing` parks the draft here
     * with NO drive. `unknown` (a throttle, a blip) changes nothing — absence of an answer is not
     * a verdict, and the drive itself recognises the dead page as the second net.
     *
     * Asked for the Send button too (Stage 1.3): a press at a deleted page is the same minute of
     * browser activity from a revenue account for nothing.
     */
    const probe = await probeHandle(target.handle)
    if (probe.check === 'missing') {
      const error = `@${target.handle}'s Instagram page no longer exists (anonymous probe: not found) — nothing was driven`
      await prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureCode: 'profile-gone', error, attempts: MAX_DELIVERY_ATTEMPTS },
      })
      await settleClaims(claim.held, { delivered: false, failureCode: 'profile-gone' })
      log.warn("the recipient's page is gone — parked without a browser drive", { pair: pairKey })
      return failed({
        ladder: 'probe-gone',
        failureCode: 'profile-gone',
        parked: true,
        detail: error,
        attempts: MAX_DELIVERY_ATTEMPTS,
      })
    }

    /**
     * The Send button's record that a drive is about to start, and what was crossed to get
     * here — the one place that audit row has ever been written, kept INSIDE the guarded window
     * so a throw puts the draft back rather than leaving SENDING with nothing recorded.
     */
    if (!mode.unattended) {
      await audit(
        mode.operator,
        crossed.length > 0 ? 'attempt.send.start.override' : 'attempt.send.start',
        `OutreachAttempt:${attempt.id}`,
        `@${sender.handle} → @${target.handle}${crossed.length > 0 ? ` — crossed: ${crossed.join(', ')}` : ''}`,
      )
    }
  } catch (err) {
    await revertUndrivenClaim(attempt.id, claimHeld, err)
    /* A database fault is about the shared store, not this draft: end the tick rather than
       claim the next one into the same failure. The next tick is 30 seconds away. */
    return stop('db-fault', 'the database did not answer before the drive — back in the queue, nothing was sent')
  }

  log.step('delivering a waiting message', { pair: pairKey, chars: attempt.renderedBody.length })
  // Counted BEFORE the await. A send that throws still drove a browser, and the bound is
  // about activity against these accounts rather than about outcomes.
  drives += 1
  const outcome = await browserSender.send({
    attemptId: attempt.id,
    senderHandle: sender.handle,
    sessionPath: profileStatus(sender.handle).dir,
    targetHandle: target.handle,
    body: attempt.renderedBody,
  })

  await settleClaims(claimHeld, {
    delivered: outcome.status === 'SENT',
    failureCode: outcome.status === 'FAILED' ? outcome.failureCode : null,
  })

  if (outcome.status === 'SENT') {
    // The SENT row commits ALONE and first; the variant bump and the audit line are
    // best-effort afterwards. They shared a transaction with it, so a SQLITE_BUSY on
    // either rolled back the record of a DM the recipient already had. See
    // `recordSend.ts`.
    await recordDelivered({
      attemptId: attempt.id,
      variantId: attempt.variantId,
      // An overridden send is a materially different event and must be legible as one
      // months later, when the only record of why is this string.
      sentBy: mode.unattended
        ? `autopilot:${sender.handle}`
        : crossed.length > 0
          ? `override(${crossed.join('+')}):${sender.handle}`
          : `operator:${sender.handle}`,
      threadUrl: outcome.threadUrl,
      audit: mode.unattended
        ? {
            actor: 'autopilot',
            action: 'attempt.sent.autopilot',
            entity: `OutreachAttempt:${attempt.id}`,
            detail: `${pairKey} — ${outcome.threadUrl ?? 'delivered'}`,
          }
        : {
            actor: mode.operator,
            action: crossed.length > 0 ? 'attempt.sent.override' : 'attempt.sent.auto',
            entity: `OutreachAttempt:${attempt.id}`,
            detail: outcome.threadUrl ?? 'delivered',
          },
    })
    /**
     * A delivered send is PROOF the session works — the whole path ran, including
     * `assertLoggedInAs`. The one sanctioned clearing besides an identity-verified
     * hand login; a no-op when nothing was marked.
     */
    await clearSessionInvalid(sender.id, `a send to @${target.handle} delivered`)
    return { kind: 'sent', threadUrl: outcome.threadUrl ?? null, drives }
  }

  const error = outcome.status === 'FAILED' ? outcome.error : 'sender returned no outcome'
  const failureCode = outcome.status === 'FAILED' ? outcome.failureCode : 'unknown'

  if (outcome.status === 'FAILED' && outcome.challenged) {
    /**
     * Halt the account. Never a retry — that is how a recoverable flag becomes a ban.
     *
     * `markChallenged` rather than an inline update, because Phase 5 added a second
     * field that must be written at the same instant (`challengedAt`, which the fleet
     * breaker reads) and four separate code paths set this status. One of them omitting
     * the timestamp would make the breaker read "nothing was flagged" and keep sending —
     * silent, and permissive.
     *
     * It is no longer in a transaction with the attempt update. The account being halted
     * is the fact that matters and it must not be able to roll back because a write
     * about one draft contended — the same ordering argument as `recordSend.ts`.
     */
    await markChallenged({ senderId: sender.id, handle: sender.handle, detail: error, actor })
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
    })
    /**
     * Nothing else in THIS run may touch this account.
     *
     * `waiting` was read once before the loop, so every later attempt from this sender
     * carries a snapshot taken while it was still ACTIVE — the database now says
     * CHALLENGED and the loop would keep driving its Chrome profile anyway. At four
     * accounts one sender rarely had two waiting drafts, so this was close to
     * unreachable. Rotation makes it reachable BY DESIGN: spreading one sender across
     * many targets is the entire point. Retrying into a checkpoint is the one mistake
     * this project cannot afford.
     */
    challengedThisRun.add(sender.id)
    if (mode.unattended) {
      log.alarm('Instagram checkpoint during autopilot — account halted, nothing retried', {
        sender: sender.handle,
      })
    }
    return failed({
      ladder: 'challenged',
      failureCode,
      parked: false,
      challenged: true,
      detail: error,
      attempts: attempt.attempts + 1,
    })
  }

  if (outcome.status === 'FAILED' && outcome.sessionInvalid) {
    /**
     * The session is dead — Instagram showed a login form (or the wrong account)
     * where a session was expected. Record the EVIDENCE through the one writer, so
     * the gate's `no-session` stop holds every later tick instead of the dispatcher
     * driving a browser at the dead session every fifteen minutes forever. The draft
     * stays READY: nothing is wrong with the message, only with the account, and a
     * hand login releases it.
     */
    await markSessionInvalid({ senderId: sender.id, handle: sender.handle, detail: error, actor })
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
    })
    return failed({
      ladder: 'session-invalid',
      failureCode,
      parked: false,
      sessionInvalid: true,
      detail: error,
      attempts: attempt.attempts + 1,
    })
  }

  if (mode.unattended && failureCode === 'profile-gone') {
    // The drive itself met "Sorry, this page isn't available". Parked on FIRST sighting — a
    // retry cannot make a deleted account exist — and the planner refuses this recipient for a
    // week (TARGET_UNREACHABLE) so no other page drives at it either.
    //
    // UNATTENDED ONLY, as it always was: `sendNow` never had this branch (the fix of 9 Sept went
    // into the loop alone), so a drive-found dead page leaves the Send button's draft READY with
    // `attempts + 1` and a failure audit. Preserved as a mode difference, not unified — see the
    // header. The anonymous probe above is what both callers share, and it parks for both.
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', error, failureCode, attempts: MAX_DELIVERY_ATTEMPTS },
    })
    return failed({
      ladder: 'drive-gone',
      failureCode,
      parked: true,
      detail: error,
      attempts: MAX_DELIVERY_ATTEMPTS,
    })
  }

  /**
   * Only a MISMATCH stops here (review of audit C1). `unknown` and `ambiguous` arrive with
   * `recipientRetryable` and fall through to the retry cap below: they are what a transient
   * miss at the profile door looks like (a Message button not rendered inside 15 s, or its
   * click eaten by a modal), the next drive starts again at that door, and parking them on
   * first sight retired a healthy route over one slow render. They still release the
   * reservation (`settleClaims` above — nothing was typed) and still park at the cap under
   * this code. The flag is opt-in, so a refusal arriving without it parks: the safe side.
   */
  const recipientRetryable = outcome.status === 'FAILED' && outcome.recipientRetryable === true
  if (failureCode === 'recipient-unconfirmed' && !recipientRetryable) {
    /**
     * The inbox route opened a conversation that names somebody ELSE (audit C1, 2026-10-09).
     * Nothing was typed. Parked on FIRST sighting, like a gone page: the generic path below
     * would drive the same search twice more — each drive possibly opening that stranger's
     * conversation again. `attempts: MAX_DELIVERY_ATTEMPTS` puts it on the landing page's
     * parked list with re-queue and discard. Reservations were released by `settleClaims`
     * above. The park rests this pair (rotation, the gate and the governor all count it), so
     * rotation tries the next page — which meets the same door: up to a ring's worth of
     * parks per such recipient, then nothing until a person re-queues them.
     *
     * Before this was one function, the Send button's copy of this park read: READY is what the
     * dispatcher picks up, so with autopilot on the generic branch would have the same search
     * driven again within ~30 s — possibly opening that stranger's conversation again.
     */
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', error, failureCode, attempts: MAX_DELIVERY_ATTEMPTS },
    })
    if (mode.unattended) {
      log.alarm('the inbox route opened somebody else’s conversation — parked, nothing typed, not retried', {
        pair: pairKey,
        attemptId: attempt.id,
      })
    } else {
      await audit(actor, 'attempt.send.recipient-unconfirmed', `OutreachAttempt:${attempt.id}`, error)
    }
    return failed({
      ladder: 'recipient-parked',
      failureCode,
      parked: true,
      detail: error,
      attempts: MAX_DELIVERY_ATTEMPTS,
    })
  }

  if (failureCode === 'not-in-thread') {
    /**
     * ── THE ONE FAILURE THAT IS NOT RETRIED. Changed in Phase 5. ─────────
     *
     * The composer CLEARED — Instagram accepted the keystroke — and the message then
     * never appeared in the conversation. Two things are true at once:
     *
     *   1. the recipient may well HAVE the message, and
     *   2. this is what a shadow restriction looks like from outside.
     *
     * Phase 0 made it recordable and alarming and deliberately changed no behaviour, so
     * until now it went back to READY like every other failure — and READY is exactly
     * what the delivery loop picks up. The next tick sent it again, to someone who
     * probably already had it, from an account that may be restricted. Both halves of
     * that are bad and the combination is the worst outcome available.
     *
     * So it parks in FAILED. Nothing automatic reads FAILED: this loop queries
     * `status: 'READY'`, and `evaluateResend` refuses anything that is not READY or
     * QUEUED with `not-waiting`, which is NOT in OVERRIDABLE_BLOCKS. Reading the actual
     * thread (`pnpm ig:thread <sender> <target>`) is what settles it for a person.
     *
     * The reservation is KEPT, as it already was. Releasing it would permit a second
     * message on top of one that probably landed.
     *
     * ── AND IT IS NO LONGER VISIBLE ON ANY SCREEN (2026-08-24) ──────────────
     *
     * This used to read: *parking a message where nothing picks it up is only safe because
     * it is VISIBLE — `/messages` lists these under "check the thread", with the two buttons
     * that resolve them.* Tabish removed that section, so the sentence is false and is
     * corrected here rather than deleted, because the reasoning still holds and the trade is
     * now a knowing one: a not-in-thread park is PERMANENT on its pair, nothing surfaces it,
     * and `resolveUncertainSend` still exists but has no caller. What that costs, measured
     * the day it changed: 18 such rows across 14 recipients, and for 10 of those recipients
     * the parked page was also the one rotation had elected, so they are skipped every pass.
     */
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', error, failureCode, attempts: { increment: 1 } },
    })
    log.alarm('composer cleared but the message never appeared — NOT retried, a human must read the thread', {
      pair: pairKey,
      attemptId: attempt.id,
      sender: sender.handle,
      target: target.handle,
      check: `pnpm ig:thread ${sender.handle} ${target.handle}`,
    })
    // The Send button's audit trail for the same event: the only record, months later, that a
    // person pressed Send and the message may or may not have arrived.
    if (!mode.unattended) await audit(actor, 'attempt.send.uncertain', `OutreachAttempt:${attempt.id}`, error)
    return failed({
      ladder: 'not-in-thread',
      failureCode,
      parked: true,
      detail: error,
      attempts: attempt.attempts + 1,
    })
  }

  /**
   * ── THE RETRY CAP (2026-08-18) ─────────────────────────────────────────────
   *
   * READY is what this loop picks up, so a draft that fails the same way every time
   * used to loop FOREVER: MEASURED this morning, `no-composer` against one recipient
   * drove a real Chrome profile at Instagram once a minute for four minutes straight
   * before a hand intervened — repeated automated activity against a revenue account,
   * and each drive spent the whole per-tick bound, so one unmessageable recipient
   * starved the other 73 drafts. The `attempts` counter was incremented in four
   * places and read by NOTHING.
   *
   * It is read now: after MAX_DELIVERY_ATTEMPTS failures the draft parks in FAILED,
   * which nothing automatic picks up — the same treatment `not-in-thread` gets, for
   * the same reason, and it is only safe because the parked list renders on the
   * landing page with the failure named and the two controls that settle it
   * (re-queue after fixing the cause, or discard). A parked message nobody can see
   * is worse than a retried one.
   *
   * THE SEND BUTTON DOES NOT PARK, AND DOES NOT MOVE THE DRAFT: a person pressed Send and sees
   * the failure in the same breath, so "leave the draft intact so it can be retried or sent by
   * hand" is the right answer for them — the loop that would re-drive it is the dispatcher's,
   * and the dispatcher parks it at the cap on ITS next failure. It writes `attempt.send.failed`.
   */
  const totalAttempts = attempt.attempts + 1
  const park = mode.unattended && totalAttempts >= MAX_DELIVERY_ATTEMPTS
  await prisma.outreachAttempt.update({
    where: { id: attempt.id },
    /**
     * A retryable failure goes to the BACK of the queue (2026-08-19, Tabish: "even if
     * it fails … proceed to next item"). The queue is drained oldest-first, so a draft
     * that kept its original `queuedAt` sat at the FRONT after failing and the next
     * tick drove the same recipient again — three minutes of the whole fleet waiting
     * on one blocked profile. Bumping `queuedAt` means the very next tick takes the
     * next recipient, and the failed one retries after everything currently ahead of
     * it. The cap still parks it for a person after MAX_DELIVERY_ATTEMPTS in total.
     */
    data: {
      status: park ? 'FAILED' : 'READY',
      error,
      failureCode,
      attempts: { increment: 1 },
      ...(park || !mode.unattended ? {} : { queuedAt: new Date() }),
    },
  })
  if (park) {
    log.alarm('a draft failed repeatedly and is parked — it will not be retried on its own', {
      pair: pairKey,
      failureCode,
      attempts: totalAttempts,
    })
  }
  if (!mode.unattended) await audit(actor, 'attempt.send.failed', `OutreachAttempt:${attempt.id}`, error)
  return failed({ ladder: 'retry', failureCode, parked: park, detail: error, attempts: totalAttempts })
}

/**
 * One audit row, written the way `actions.ts` always wrote the Send button's: awaited and
 * UNGUARDED, so a failure to record what a person did surfaces to them rather than vanishing.
 * (The delivered-message row is the exception and goes through `recordDelivered`, whose audit
 * is best-effort by design: a lost log line must never be what stops a delivery being recorded.)
 */
async function audit(actor: string, action: string, entity: string, detail: string): Promise<void> {
  await prisma.auditLog.create({ data: { actor, action, entity, detail } })
}
