import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { randomInt } from '@/lib/time'
import { browserSender } from './senders/browser'
import { profileStatus } from './browser/profile'
import { recheckBeforeSend } from './gate'
import { thisMacRole } from './activeDevice'
import { browserShutdownRequested } from './shutdown'
import { recordDelivered, revertUndrivenClaim } from './recordSend'
import { claimForAttempt, settleClaims, type Reservation } from './reservations'
import { markChallenged } from './challenge'
import { markSessionInvalid, clearSessionInvalid } from './sessionHealth'
import { ensureConversationChecked } from './replyCheck'
import { probeHandle } from '@/detection/exists'

/**
 * Deliver messages that are ALREADY waiting.
 *
 * Without this, autopilot did nothing for a draft that already existed — and that is
 * the normal case, not an edge case. The planner only dispatches attempts it creates
 * in the same run, and the governor skips any pair that already has one waiting
 * (`pending-attempt-exists`, which correctly stops two unsent messages stacking up).
 * The two rules together meant: a message prepared while autopilot was off could
 * never be sent by autopilot once it was switched on. You would turn it on, watch
 * nothing happen, and the only explanation on screen would be a pair marked "pending".
 *
 * So each slot delivers first, then plans. Delivering is the point of the slot;
 * drafting is preparation for the next one.
 *
 * Everything that made the attempt permissible was checked when it was drafted. What
 * this re-checks is only what can have CHANGED since — because a draft can sit for
 * days, and every one of these is a reason not to send it now:
 *
 *   - autopilot switched off, or this account's auto-send switched off
 *   - the account flagged by Instagram, or disconnected
 *   - the route turned off, or the channel retired
 *   - the target replied (a live conversation must not receive a cold pitch)
 *   - today's caps already used by something else
 *
 * Anything held back stays READY and keeps its Send button. Never dropped.
 *
 * ── BOUNDED SINCE PHASE 5 ─────────────────────────────────────────────────
 *
 * This used to drain the whole queue in one call, sleeping 45-180 s between sends. At
 * four accounts with three drafts that was a two-minute slot; at fleet volume — measured,
 * 11-14 paid posts a day from `@viralbhayani` — it is an hour of continuous browser
 * driving, every message of it inside one hour, into one inbox, from a dozen different
 * pages. `maxSends` bounds it, and `dispatcher.ts` calls it repeatedly on a schedule
 * instead. Nothing is dropped by the bound: what is not sent stays READY.
 *
 * It is no longer called directly by a slot. `dispatchTick` is the only caller, because
 * the pacing rules and the fleet-wide send lock live there and a second entry point would
 * bypass both — the "one gate, two callers, never re-inline it" lesson applied before it
 * had a chance to bite.
 */

export interface DeliverResult {
  sent: number
  failed: number
  skipped: number
  outcomes: { pairKey: string; result: string }[]
}

export interface DeliverOptions {
  /**
   * Stop after this many attempts to deliver.
   *
   * COUNTED WHETHER OR NOT THEY SUCCEED, and that is the version that bounds the right
   * thing. The first cut counted delivered messages, so a run of failures — a DOM change,
   * a paste that would not land — drove Instagram once per waiting draft while the counter
   * sat at zero. What needs bounding is browser activity against these accounts, and a
   * failed send is exactly as much of that as a successful one.
   *
   * Defaults to 1 — the value that cannot cluster. A default of `Infinity` would mean a
   * caller who forgot the argument got the old unbounded behaviour, which is the wrong
   * direction for an omission to fail in.
   */
  maxSends?: number
}

/**
 * The retry cap now lives in `src/lib/constants.ts` and is re-exported here so this file —
 * the enforcer — still owns the name its callers import. It moved because the FAILURES LIST
 * on the dashboard reads it as well, and a view model importing this module to get one number
 * would pull the browser stack into the Next server bundle. See the docblock there.
 */
export { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'

export async function deliverWaiting(opts: DeliverOptions = {}): Promise<DeliverResult> {
  const maxSends = opts.maxSends ?? 1
  /** Browser drives this call has performed. The bound is measured against this. */
  let driven = 0
  const out: DeliverResult = { sent: 0, failed: 0, skipped: 0, outcomes: [] }
  const settings = await getSettings()

  if (!settings.autopilotEnabled) {
    log.step('autopilot off — waiting messages stay for a human')
    return out
  }
  if (env.DRY_RUN) {
    log.step('DRY_RUN — not delivering waiting messages')
    return out
  }

  const waiting = await prisma.outreachAttempt.findMany({
    where: { status: 'READY' },
    include: { pair: { include: { sender: true, target: true } } },
    orderBy: { queuedAt: 'asc' },
  })
  if (waiting.length === 0) return out

  /**
   * Accounts Instagram flagged DURING this run.
   *
   * `waiting` is one query taken before the loop, so every attempt in it carries a
   * sender snapshot from that moment. Flagging a sender writes CHALLENGED to the
   * database and leaves the snapshot untouched — so without this set, and without the
   * re-read below, the loop keeps driving the Chrome profile of an account that
   * Instagram just challenged. Two guards rather than one because they cover different
   * things: the set covers what THIS loop did, the re-read covers what anything else
   * did (the dashboard, a concurrent CLI, a human pressing Pause).
   */
  const challengedThisRun = new Set<string>()

  for (const attempt of waiting) {
    /**
     * The bound, checked at the top of each iteration rather than after a send.
     *
     * Checked here so the remaining attempts are not gated, claimed or logged at all — a
     * tick that has done its one send should do no further work, and pre-claiming a
     * reservation for a message this tick will not send would consume a recipient's
     * allowance for nothing.
     */
    if (driven >= maxSends) {
      log.step('dispatch bound reached — the rest wait for the next tick', {
        maxSends,
        driven,
        remaining: waiting.length - (out.sent + out.failed + out.skipped),
      })
      break
    }

    const { sender, target } = attempt.pair
    const pairKey = `${sender.handle}→${target.handle}`

    const hold = (reason: string) => {
      out.skipped += 1
      out.outcomes.push({ pairKey, result: `held: ${reason}` })
      log.step('waiting message held back', { pair: pairKey, reason })
    }

    if (challengedThisRun.has(sender.id)) {
      hold('this account was flagged by Instagram earlier in this run')
      continue
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
      hold('the sending account no longer exists')
      continue
    }
    if (live.status !== 'ACTIVE') {
      hold(`@${sender.handle} is ${live.status.toLowerCase()} right now`)
      continue
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
     */
    if (!profileStatus(sender.handle).hasSession) {
      hold(`no-session — this Mac holds no signed-in profile for @${sender.handle}`)
      continue
    }
    const gate = await recheckBeforeSend(attempt, { unattended: true })
    if (!gate.ok) {
      hold(gate.detail ?? gate.reason)
      continue
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
     * So the check moves to where the risk is. Only for follow-ups (a first touch has no
     * conversation to read) and only when this pair's thread is stale, so its cost is
     * proportional to messages sent rather than to prospects held.
     *
     * BEFORE the SENDING claim and before any reservation, so a hold leaves nothing to
     * unwind. And it FAILS CLOSED: a thread we could not read holds the message, because
     * "we could not look" must never be spent as though it were "nobody answered".
     */
    if (attempt.touchNumber > 1) {
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
         * A checkpoint stops the whole tick and the account with it. Everything else is
         * about this one conversation, so the loop moves on.
         */
        if (conversation.reason === 'checkpoint') {
          hold(conversation.detail)
          challengedThisRun.add(sender.id)
          out.failed += 1
          continue
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
         * loop of 2026-08-18), reintroduced on the READ path where nothing counted drives.
         *
         * So it takes the SAME discipline as a retryable send failure: to the BACK of the
         * queue with `attempts` incremented, and parked FAILED at MAX_DELIVERY_ATTEMPTS,
         * where the landing page names it with the re-queue and discard controls. A read
         * that never drove a browser (`no-session`) still holds for free below, and a found
         * reply is the gate's business — neither burns an attempt.
         */
        if (conversation.reason === 'unreadable' || conversation.reason === 'incomplete') {
          const totalAttempts = attempt.attempts + 1
          const park = totalAttempts >= MAX_DELIVERY_ATTEMPTS
          await prisma.outreachAttempt.update({
            where: { id: attempt.id },
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
          out.failed += 1
          out.outcomes.push({
            pairKey,
            result: park
              ? `the conversation could not be read ${totalAttempts} times — parked for a person to look at`
              : `held: ${conversation.detail} — retries after the rest of the queue`,
          })
          if (park) {
            log.alarm('a follow-up’s conversation could not be read repeatedly and is parked — it will not be retried on its own', {
              pair: pairKey,
              attempts: totalAttempts,
              check: `pnpm ig:thread ${sender.handle} ${target.handle}`,
            })
          } else {
            log.step('waiting message held back', { pair: pairKey, reason: `${conversation.detail} — moved to the back of the queue` })
          }
          continue
        }

        hold(conversation.detail)
        continue
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
        const again = await recheckBeforeSend(attempt, { unattended: true })
        if (!again.ok) {
          hold(again.detail ?? again.reason)
          continue
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
     */
    if (!(await getSettings()).autopilotEnabled) {
      log.step('autopilot was switched off mid-tick — stopping before the claim, nothing sent')
      break
    }
    /* The agent was told to stop while this tick evaluated: a claim now would start a drive the
       shutdown drain then has to wait on, or kill. See src/outreach/shutdown.ts. */
    if (browserShutdownRequested()) {
      log.step('the agent is stopping — not claiming another message, nothing sent')
      break
    }

    // SENDING is the lock: it stops the dashboard button and this loop from both
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
      break
    }

    const claimed = await prisma.outreachAttempt.updateMany({
      where: { id: attempt.id, status: 'READY' },
      data: { status: 'SENDING' },
    })
    if (claimed.count === 0) {
      hold('already being sent')
      continue
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
     * it — a person pressing Send one message at a time is not a cluster.
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
        attended: false,
      })
      if (!claim.ok) {
        // Put it back where it was. Nothing was sent, so nothing is lost.
        await prisma.outreachAttempt.updateMany({
          where: { id: attempt.id, status: 'SENDING' },
          data: { status: 'READY' },
        })
        hold(claim.detail)

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
          break
        }
        continue
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
       */
      if (out.sent > 0) {
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
        out.failed += 1
        out.outcomes.push({ pairKey, result: `@${target.handle}'s page no longer exists — parked; no browser was driven` })
        continue
      }

    } catch (err) {
      await revertUndrivenClaim(attempt.id, claimHeld, err)
      hold('the database did not answer before the drive — back in the queue, nothing was sent')
      /* A database fault is about the shared store, not this draft: end the tick rather than
         claim the next one into the same failure. The next tick is 30 seconds away. */
      break
    }

    log.step('delivering a waiting message', { pair: pairKey, chars: attempt.renderedBody.length })
    // Counted BEFORE the await. A send that throws still drove a browser, and the bound is
    // about activity against these accounts rather than about outcomes.
    driven += 1
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
        sentBy: `autopilot:${sender.handle}`,
        threadUrl: outcome.threadUrl,
        audit: {
          actor: 'autopilot',
          action: 'attempt.sent.autopilot',
          entity: `OutreachAttempt:${attempt.id}`,
          detail: `${pairKey} — ${outcome.threadUrl ?? 'delivered'}`,
        },
      })
      /**
       * A delivered send is PROOF the session works — the whole path ran, including
       * `assertLoggedInAs`. The one sanctioned clearing besides an identity-verified
       * hand login; a no-op when nothing was marked.
       */
      await clearSessionInvalid(sender.id, `a send to @${attempt.pair.target.handle} delivered`)
      out.sent += 1
      out.outcomes.push({ pairKey, result: 'sent' })
      continue
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
      await markChallenged({ senderId: sender.id, handle: sender.handle, detail: error, actor: 'autopilot' })
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
      out.failed += 1
      out.outcomes.push({ pairKey, result: 'CHALLENGED — account halted' })
      log.alarm('Instagram checkpoint during autopilot — account halted, nothing retried', {
        sender: sender.handle,
      })
      continue
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
      await markSessionInvalid({ senderId: sender.id, handle: sender.handle, detail: error, actor: 'autopilot' })
      await prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: { status: 'READY', error, failureCode, attempts: { increment: 1 } },
      })
      out.failed += 1
      out.outcomes.push({ pairKey, result: `@${sender.handle} is logged out — it needs signing in again before anything can send from it` })
      continue
    }

    if (failureCode === 'profile-gone') {
      // The drive itself met "Sorry, this page isn't available". Parked on FIRST sighting — a
      // retry cannot make a deleted account exist — and the planner refuses this recipient for a
      // week (TARGET_UNREACHABLE) so no other page drives at it either.
      await prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', error, failureCode, attempts: MAX_DELIVERY_ATTEMPTS },
      })
      out.failed += 1
      out.outcomes.push({ pairKey, result: `@${target.handle}'s page no longer exists — parked after one look` })
      continue
    }

    if (failureCode === 'recipient-unconfirmed') {
      /**
       * The inbox route opened a conversation that could not be confirmed as this recipient's
       * (audit C1, 2026-10-09). Nothing was typed. Parked on FIRST sighting, like a gone page:
       * a retry cannot change Instagram's search ranking or its DOM, and the generic path below
       * would drive the same door twice more — each drive possibly opening a stranger's
       * conversation again. `attempts: MAX_DELIVERY_ATTEMPTS` puts it on the landing page's
       * parked list with re-queue and discard. Reservations were released by `settleClaims`
       * above. The park rests this pair (rotation, the gate and the governor all count it), so
       * rotation tries the next page — which meets the same door: up to a ring's worth of
       * parks per door-less recipient, then nothing until a person re-queues them.
       */
      await prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', error, failureCode, attempts: MAX_DELIVERY_ATTEMPTS },
      })
      out.failed += 1
      out.outcomes.push({
        pairKey,
        result: `the inbox route could not confirm the conversation is with @${target.handle} — nothing typed, parked after one look`,
      })
      log.alarm('the inbox route could not confirm who it opened — parked, nothing typed, not retried', {
        pair: pairKey,
        attemptId: attempt.id,
      })
      continue
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
      out.failed += 1
      out.outcomes.push({ pairKey, result: 'may be delivered — needs a human to read the thread' })
      log.alarm('composer cleared but the message never appeared — NOT retried, a human must read the thread', {
        pair: pairKey,
        attemptId: attempt.id,
        check: `pnpm ig:thread ${sender.handle} ${target.handle}`,
      })
      continue
    }

    /**
     * ── THE RETRY CAP (2026-08-18) ─────────────────────────────────────────────
     *
     * READY is what this loop picks up, so a draft that fails the same way every time
     * used to loop FOREVER: MEASURED this morning, `no-composer` against one recipient
     * drove a real Chrome profile at Instagram once a minute for four minutes straight
     * before a hand intervened — repeated automated activity against a revenue account,
     * and each drive spent the whole per-tick bound, so one unmessageable recipient
     * starved the other 73 drafts. The `attempts` counter was incremented in four places
     * and read by NOTHING.
     *
     * It is read now: after MAX_DELIVERY_ATTEMPTS failures the draft parks in FAILED,
     * which nothing automatic picks up — the same treatment `not-in-thread` gets, for
     * the same reason, and it is only safe because the parked list renders on the
     * landing page with the failure named and the two controls that settle it
     * (re-queue after fixing the cause, or discard). A parked message nobody can see
     * is worse than a retried one.
     */
    const totalAttempts = attempt.attempts + 1
    const park = totalAttempts >= MAX_DELIVERY_ATTEMPTS
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
        ...(park ? {} : { queuedAt: new Date() }),
      },
    })
    out.failed += 1
    out.outcomes.push({
      pairKey,
      result: park ? `failed ${totalAttempts} times (${failureCode}) — parked for a person to look at` : `failed: ${error}`,
    })
    if (park) {
      log.alarm('a draft failed repeatedly and is parked — it will not be retried on its own', {
        pair: pairKey,
        failureCode,
        attempts: totalAttempts,
      })
    }
  }

  if (out.sent > 0 || out.failed > 0) {
    log.info('autopilot delivery', { sent: out.sent, failed: out.failed, held: out.skipped })
  }
  return out
}
