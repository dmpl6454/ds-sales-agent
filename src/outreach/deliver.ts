import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings, type RuntimeSettings } from '@/lib/settings'
import { deliverOne, type DeliverOneResult } from './deliverOne'

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
 * `deliverOne` re-checks is only what can have CHANGED since — because a draft can sit for
 * days, and every one of these is a reason not to send it now:
 *
 *   - autopilot switched off
 *   - the account flagged by Instagram, or disconnected
 *   - the channel retired
 *   - the target replied (a live conversation must not receive a cold pitch)
 *   - today's caps already used by something else
 *
 * Anything held back stays READY and keeps its Send button. Never dropped.
 *
 * ── THIS FILE IS THE LOOP; THE DELIVERY IS `deliverOne.ts` (Stage 1.3) ────────────────────
 *
 * The per-attempt block — every guard, the claim, the drive, the failure ladder — used to live
 * here and was copied, with drift, into the dashboard's Send button. It is one function now
 * (`deliverOne`) with two callers, and what remains here is what only a LOOP knows: the bound,
 * the in-run set of flagged accounts, whether a drive already happened (for the spacing), and
 * the sentences the dispatcher's "why was nothing sent" tape is made of.
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
   * Stop after this many browser drives.
   *
   * COUNTED WHETHER OR NOT THEY SUCCEED, and that is the version that bounds the right
   * thing. The first cut counted delivered messages, so a run of failures — a DOM change,
   * a paste that would not land — drove Instagram once per waiting draft while the counter
   * sat at zero. What needs bounding is browser activity against these accounts, and a
   * failed send is exactly as much of that as a successful one.
   *
   * AND A PRE-SEND THREAD READ IS A DRIVE TOO (Stage 1.3, audit M2). `deliverOne` reports the
   * drives it performed — the read when it opened Chrome, plus the send — and the sum is what
   * this bound is measured against. It counted the send alone, so a tick whose stale
   * follow-ups each needed a read drove one profile per draft.
   *
   * Defaults to 1 — the value that cannot cluster. A default of `Infinity` would mean a
   * caller who forgot the argument got the old unbounded behaviour, which is the wrong
   * direction for an omission to fail in.
   */
  maxSends?: number
  /**
   * The settings the caller already read. `dispatchTick` reads them for its own decision and
   * hands them down, so a tick is one `getSettings` fewer. Omitted, this reads its own.
   *
   * This is the TOP-OF-CALL snapshot only. The just-in-time re-reads immediately before each
   * claim stay separate and fresh inside `deliverOne` — a snapshot older than the claim is
   * exactly what those re-reads exist to correct.
   */
  settings?: RuntimeSettings
}

export async function deliverWaiting(opts: DeliverOptions = {}): Promise<DeliverResult> {
  const maxSends = opts.maxSends ?? 1
  /** Browser drives this call has performed. The bound is measured against this. */
  let driven = 0
  const out: DeliverResult = { sent: 0, failed: 0, skipped: 0, outcomes: [] }
  const settings = opts.settings ?? (await getSettings())

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
   * re-read inside `deliverOne`, the loop keeps driving the Chrome profile of an account that
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

    const r = await deliverOne({
      attempt,
      settings,
      mode: { unattended: true },
      challengedThisRun,
      /**
       * Space this drive from the previous one when ANY drive has happened in this tick —
       * delivered or not (audit M3). `driven` is read BEFORE this attempt's own drives are
       * added, so a read-then-send inside one attempt is not spaced from itself.
       */
      spaceBeforeDrive: driven > 0,
    })
    driven += r.drives

    switch (r.kind) {
      case 'held':
        hold(r.detail)
        break

      case 'sent':
        out.sent += 1
        out.outcomes.push({ pairKey, result: 'sent' })
        break

      case 'stop-tick':
        /**
         * The tick ends here. Two of the five reasons are also a recorded hold (the fleet's pace
         * and a database fault are about every remaining draft, so the one that met them says so);
         * the other three — the switch, the shutdown, a Mac handover — leave nothing to explain on
         * the tape: nothing was claimed, and the next tick re-asks.
         */
        if (r.why === 'fleet-pace' || r.why === 'db-fault') hold(r.detail)
        log.step('the tick stops here', { why: r.why })
        return finish(out)

      case 'failed':
        out.failed += 1
        if (r.ladder === 'read-checkpoint') {
          // A checkpoint during the READ is both: this draft is held, and the account is the failure.
          hold(r.detail)
          break
        }
        out.outcomes.push({ pairKey, result: failedOutcome(r, sender.handle, target.handle) })
        break

      default: {
        const exhaustive: never = r
        throw new Error(`unhandled delivery result: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  return finish(out)
}

function finish(out: DeliverResult): DeliverResult {
  if (out.sent > 0 || out.failed > 0) {
    log.info('autopilot delivery', { sent: out.sent, failed: out.failed, held: out.skipped })
  }
  return out
}

/**
 * The line a failure leaves on the dispatcher's tape — the sentence the dashboard's "why was
 * nothing sent" panel and `holdReasons` are made of. PURE over the result, EXHAUSTIVE over the
 * ladder: a new branch of `deliverOne`'s failure ladder is a compile error here until it has a
 * sentence, rather than a tape that reads "failed" and nothing else.
 *
 * `read-unreadable` is the one that starts with `held:` while counting as a failure — the read
 * drove a browser and the draft went to the back of the queue, which the panel shows as a hold.
 */
function failedOutcome(r: Extract<DeliverOneResult, { kind: 'failed' }>, sender: string, target: string): string {
  switch (r.ladder) {
    case 'read-unreadable':
      return r.parked
        ? `the conversation could not be read ${r.attempts} times — parked for a person to look at`
        : `held: ${r.detail} — retries after the rest of the queue`
    case 'read-checkpoint':
      // The loop files this one as a hold before it gets here; the case is kept so the switch
      // stays exhaustive, and it says the same thing.
      return `held: ${r.detail}`
    case 'probe-gone':
      return `@${target}'s page no longer exists — parked; no browser was driven`
    case 'challenged':
      return 'CHALLENGED — account halted'
    case 'session-invalid':
      return `@${sender} is logged out — it needs signing in again before anything can send from it`
    case 'drive-gone':
      return `@${target}'s page no longer exists — parked after one look`
    case 'recipient-parked':
      return `the inbox route opened a conversation that does not name @${target} — nothing typed, parked after one look`
    case 'not-in-thread':
      return 'may be delivered — needs a human to read the thread'
    case 'retry':
      return r.parked
        ? `failed ${r.attempts} times (${r.failureCode}) — parked for a person to look at`
        : `failed: ${r.detail}`
    default: {
      const exhaustive: never = r.ladder
      throw new Error(`unhandled failure ladder: ${String(exhaustive)}`)
    }
  }
}
