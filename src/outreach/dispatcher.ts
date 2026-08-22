import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { hoursAgo, istHourOfDay, istStamp } from '@/lib/time'
import { fleetUsage } from './reservations'
import {
  assessBreaker,
  decideDispatch,
  CHALLENGE_WINDOW_HOURS,
  FAILURE_WINDOW_HOURS,
  type BreakerVerdict,
  type DispatchVerdict,
} from './pacing'
import { deliverWaiting, type DeliverResult } from './deliver'
import { LAST_SEND_STARTED_KEY, gapClock } from './paceClock'

/**
 * The paced dispatcher: the thing that decides a message may go out NOW, and the lock
 * that stops two of them going out at once.
 *
 * ── THE DECISION IS IN pacing.ts ──────────────────────────────────────────
 *
 * This file is queries and side effects. Every rule — the active-hours window, the
 * minimum gap, both breaker signals — lives in `pacing.ts` as a pure function with a test
 * for firing AND for permitting, exactly like `governor.ts`, `gate.ts` and `rotation.ts`.
 * If you find yourself adding an `if` here, it belongs there with a test.
 *
 * ── THE SEND LOCK, AND THE HOLE IT CLOSES ─────────────────────────────────
 *
 * There is exactly one OS clipboard, and `sendDm` pastes the body from it — because
 * nobody hand-types a 1200-character pitch, and typing one would need Shift+Enter between
 * twenty lines where a single missed modifier sends twenty separate DMs.
 *
 * So two sends running at once can interleave copy and paste and put **message A into
 * thread B**. The per-attempt `READY → SENDING` claim does not help: it stops the SAME
 * message being sent twice and says nothing about two DIFFERENT messages racing. That
 * hole exists today — a slot's `deliverWaiting` and a click on the dashboard's Send
 * button can overlap, and `runSlot`'s own lock comment says so in as many words while
 * only protecting slots from slots.
 *
 * `withSendLock` is fleet-wide and covers every path that drives a browser to send. It
 * asks the OS whether the holder is alive rather than inferring it from a timestamp —
 * "freshness is not liveness" has already been learned twice here, once for the scheduler
 * heartbeat and once for the slot lock.
 */

/** Setting key holding `{"pid":123,"what":"dispatch","at":"..."}` while a send is running. */
const SEND_LOCK_KEY = 'sendLock'

/**
 * A send takes 30-60 s, and since Phase 6 a follow-up may READ the conversation first —
 * another full browser session — so one held lock can legitimately cover two.
 *
 * Six minutes is generous enough that a slow-but-working read-then-send is never reported
 * as stalled, and short enough that a genuinely wedged one is. Staleness alone never
 * grants the lock anyway: the holder's pid must also be gone. This value only decides
 * when to SHOUT, so erring long costs a delayed alarm and erring short costs a false one —
 * and a false alarm on a healthy fleet is how an operator learns to ignore the real one.
 */
const SEND_LOCK_STALE_MS = 6 * 60_000

/** Setting key holding the last tick's outcome, so the dashboard can show what happened. */
export const DISPATCH_STATE_KEY = 'dispatchState'
/** Setting key holding a human's explicit pause: `{"at":...,"by":...,"reason":...}`. */
export const DISPATCH_PAUSE_KEY = 'dispatchPaused'

/**
 * The pace clock lives in `paceClock.ts` now — the WRITE site moved to
 * `browserSender.send` (see that module for the measured reason), and re-exporting here
 * keeps every existing reader pointed at one implementation.
 */
export { LAST_SEND_STARTED_KEY, recordSendStarted, gapClock } from './paceClock'

/**
 * The gap clock: when did a send last BEGIN?
 *
 * Falls back to the newest `sentAt` when the row does not exist yet — a fleet that has
 * never run under the new code must not read "never sent" and fire immediately, which would
 * ignore the gap exactly once on every deploy. `null` only when nothing has ever been sent.
 */
export async function lastSendStartedAt(): Promise<Date | null> {
  const [row, lastSend] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LAST_SEND_STARTED_KEY } }),
    prisma.outreachAttempt.findFirst({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
  ])
  const started = row?.value ? new Date(String(row.value)) : null

  /**
   * ── THE FALLBACK MUST NOT SWALLOW THE PRIMARY (found by measuring, 2026-08-21) ──
   *
   * The first version of this returned `max(started, completed)`, reasoning that the later
   * of the two clocks was the safer answer. It is not: a send's COMPLETION is always ~47s
   * after that same send's START, so the max is the completion EVERY time and the fix
   * silently reinstated the exact behaviour it was written to remove. Deployed, the agent
   * restarted, and the measured period was **106.8s against a 107s baseline** — the change
   * did nothing, and the source-grep test passed the whole way because the caller genuinely
   * did read this function.
   *
   * A defensive fallback that outranks the signal it is defending is this codebase's most
   * repeated shape, and this is the first time it has appeared inside a fix for itself.
   *
   * So: the stamp WINS whenever it exists. `sentAt` is the fallback for one case only — a
   * fleet whose first send under this code has not happened yet, which must not read as
   * "never sent" and ignore the gap once on every deploy. `tests/gap-is-a-period.test.ts`
   * now drives this against a real database in both directions, because a grep cannot see
   * which of two clocks a comparison returns.
   */
  return gapClock(started, lastSend?.sentAt ?? null)
}

export interface SendLockHolder {
  pid: number
  what: string
  at: string
}

export type SendLockVerdict = { action: 'take' } | { action: 'decline'; stalled: boolean }

/**
 * PURE. May we take the send lock?
 *
 * Same shape and same reasoning as `decideSlotLock`, and deliberately the same answer to
 * the case that matters: **a live holder is never stepped over, however old the lock is.**
 * A send that is hung but alive still owns the clipboard, and taking the lock from it is
 * how message A ends up in thread B. Nothing sends, rather than something sends wrongly —
 * and `stalled` turns the wait into an alarm instead of a silence.
 */
export function decideSendLock(args: {
  held: SendLockHolder | null
  holderAlive: boolean
  ourPid: number
  ageMs: number
  staleMs?: number
}): SendLockVerdict {
  const { held, holderAlive, ourPid, ageMs, staleMs = SEND_LOCK_STALE_MS } = args
  if (held === null) return { action: 'take' } // unparseable must not deadlock forever
  if (held.pid === ourPid) return { action: 'take' }
  if (!holderAlive) return { action: 'take' }
  return { action: 'decline', stalled: ageMs >= staleMs }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireSendLock(what: string): Promise<boolean> {
  const value = JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() })

  // `create` on the primary key IS the test-and-set: it succeeds only if no row exists.
  // A `findUnique` then `upsert` is a check-then-act, which has already produced two
  // concurrent slots here once and a double-send path twice.
  try {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value } })
    return true
  } catch {
    // A row exists. Whether it represents a live sender is a separate question.
  }

  const row = await prisma.setting.findUnique({ where: { key: SEND_LOCK_KEY } })
  if (!row) {
    try {
      await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value } })
      return true
    } catch {
      return false
    }
  }

  let held: SendLockHolder | null = null
  try {
    held = JSON.parse(row.value) as SendLockHolder
  } catch {
    held = null
  }

  const ageMs = held ? Date.now() - new Date(held.at).getTime() : Infinity
  const verdict = decideSendLock({
    held,
    holderAlive: held !== null && alive(held.pid),
    ourPid: process.pid,
    ageMs,
  })

  if (verdict.action === 'decline') {
    const detail = { otherPid: held?.pid, doing: held?.what, secondsHeld: Math.round(ageMs / 1000) }
    if (verdict.stalled) {
      log.alarm('a send has been running for a long time — nothing else can send until it finishes', detail)
    } else {
      log.step('another send is in progress — waiting for the next opportunity', detail)
    }
    return false
  }

  // Conditional on the row still holding exactly what we read, so two processes finding
  // the same corpse cannot both claim it.
  const claimed = await prisma.setting.updateMany({
    where: { key: SEND_LOCK_KEY, value: row.value },
    data: { value },
  })
  if (claimed.count === 0) {
    log.step('another sender took the lock first — declining', { previousPid: held?.pid })
    return false
  }
  /**
   * THREE different reasons we got here, and they must not print as one.
   *
   * The first version said "taking over a send lock left by a process that is gone" for
   * ALL of them — including the case where the row is our OWN, so it reported this live
   * process's pid as a dead one. Observed while verifying Phase 5: `deadPid=87738` for a
   * pid that was running the very code emitting the line. Somebody debugging a wedged
   * fleet would go looking for a crash that never happened.
   *
   * `runSlot`'s `acquireSlotLock` has the identical line and the identical flaw; it is
   * corrected there too, in this commit.
   */
  if (held === null) {
    log.step('the send lock held an unreadable value — replacing it')
  } else if (held.pid === process.pid) {
    log.step('reclaiming a send lock this process left behind', { doing: held.what })
  } else {
    log.step('taking over a send lock left by a process that is gone', { deadPid: held.pid })
  }
  return true
}

async function releaseSendLock(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SEND_LOCK_KEY } }).catch(() => undefined)
}

/**
 * True while THIS process holds the lock through `withSendLock`.
 *
 * ── THE BUG THIS PREVENTS, FOUND BY RUNNING IT ────────────────────────────
 *
 * `acquireSendLock` grants the lock when the row already names our own pid — it has to,
 * because a crash inside this process leaves a row behind and pids get reused. But that
 * made a NESTED `withSendLock` succeed, and the inner call's `finally` then DELETED the
 * row while the outer call was still sending. From that moment the send was unprotected:
 * another process could take the lock and drive a second browser, which is the interleaved
 * clipboard — message A into thread B — that this lock exists to prevent.
 *
 * The database row cannot distinguish those cases; only the process can. So nesting is
 * refused outright rather than made reentrant: there is one clipboard, so a process asking
 * to send while it is already sending is a bug upstream, and returning `null` makes it fail
 * closed and visible instead of quietly unlocking.
 *
 * Nothing in the codebase nests today. This is here because the ONLY reason the nested
 * path was exercised at all was a verification script written to poke at it, and the next
 * caller will not be.
 */
let heldInThisProcess = false

/**
 * Run `fn` while holding the fleet-wide send lock, or return `null` without running it.
 *
 * `null` means "somebody else is sending", which is never an error and never loses a
 * message: whatever was waiting is still waiting, with its Send button.
 */
/**
 * ── WHY THE LOCK NO LONGER STAMPS THE PACE CLOCK (2026-08-21, evening) ────
 *
 * `withSendLock` briefly carried an `{ isSend }` flag and stamped `fleetLastSendStartedAt`
 * on acquisition. That placement was measured wrong the same day it shipped: acquiring the
 * lock is a statement of INTENT, and a dispatch tick acquires it before it knows whether any
 * draft passes the gate. On a drained queue every passing tick stamped the clock, the log
 * read "the last message went out 0 minute(s) ago" for twelve consecutive minutes with zero
 * sends, and a draft that became sendable waited up to a full gap period behind stamps from
 * ticks that delivered nothing.
 *
 * The stamp lives in `browserSender.send` now — the ONE implementation every delivered
 * message passes through, still inside this lock (both its callers hold it), still before
 * the browser moves. The reply sweep and the pruner never reach it, so a read can never
 * cost a send's worth of spacing, which is the property the deleted flag existed to protect.
 */
export async function withSendLock<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  /**
   * MAY THIS MACHINE SEND AT ALL? Checked here because this function is the ONE place
   * every path that drives a browser passes through — the dispatcher, the dashboard's
   * Send button, the on-demand dialog, the CLI. Putting the floor in the agent alone left
   * the other four open on the server, which is the "one rule, several callers" gap this
   * codebase has produced four times; here it would have meant a hosted dashboard trying
   * to drive a Chrome that has no Instagram session and no business having one.
   *
   * `SEND_ENABLED=false` on the server is what makes hosting safe STRUCTURALLY rather
   * than by convention. The Chrome profiles carry device identity written by a hand login
   * from a home IP; copying them to a datacenter is a cookie transplant that works right
   * up until enforcement lands silently. So the server detects, classifies and shows, and
   * a person's own machine sends.
   *
   * Environment only, never a Setting — a web page must not be able to grant itself the
   * ability to send, exactly as with `AUTOPILOT_ENABLED`. And it fails in the safe
   * direction: a misconfigured server prepares messages and delivers nothing.
   */
  if (!env.SEND_ENABLED) {
    log.step('this machine is not allowed to send (SEND_ENABLED=false) — the message stays waiting', { what })
    return null
  }

  if (heldInThisProcess) {
    log.warn('a send is already in progress in this process — refusing to start a second', { what })
    return null
  }
  if (!(await acquireSendLock(what))) return null
  heldInThisProcess = true
  try {
    return await fn()
  } finally {
    heldInThisProcess = false
    await releaseSendLock()
  }
}

/** A human's explicit stop, if there is one. */
export async function readPause(): Promise<{ at: string; by: string; reason?: string } | null> {
  const row = await prisma.setting.findUnique({ where: { key: DISPATCH_PAUSE_KEY } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as { at: string; by: string; reason?: string }
  } catch {
    /**
     * An unparseable pause row is treated as A PAUSE, not as its absence.
     *
     * The opposite default would mean a corrupted row silently re-enables unattended
     * sending, which is the permissive direction on the one control whose entire purpose
     * is to stop it.
     */
    return { at: 'unknown', by: 'unknown', reason: 'the pause record could not be read' }
  }
}

/**
 * Gather what the breaker needs and ask it.
 *
 * Exported because the dashboard shows the same verdict the dispatcher acts on. A page
 * computing this its own way could disagree with the rule actually halting the fleet —
 * the failure `checkPersonaDistinct` was extracted to prevent.
 */
export async function assessFleetBreaker(now: Date = new Date()): Promise<BreakerVerdict> {
  const challengeFloor = hoursAgo(CHALLENGE_WINDOW_HOURS, now)
  const failureFloor = hoursAgo(FAILURE_WINDOW_HOURS, now)

  const [challenged, notInThread, delivered, manualPause] = await Promise.all([
    /**
     * Accounts flagged recently.
     *
     * `status: 'CHALLENGED'` AND a recent timestamp, so there are two ways out: a human
     * clears the halt (`clearChallenged` nulls both fields, releasing immediately), or the
     * window passes. A `challengedAt` of NULL on a CHALLENGED account counts as RECENT —
     * it can only mean a writer skipped the column, and absence of data must not harden
     * into the permissive answer.
     */
    prisma.senderAccount.count({
      where: {
        status: 'CHALLENGED',
        OR: [{ challengedAt: { gte: challengeFloor } }, { challengedAt: null }],
      },
    }),
    prisma.outreachAttempt.count({
      where: { failureCode: 'not-in-thread', queuedAt: { gte: failureFloor } },
    }),
    prisma.outreachAttempt.count({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: failureFloor } },
    }),
    readPause(),
  ])

  return assessBreaker({
    challengedInWindow: challenged,
    notInThreadInWindow: notInThread,
    deliveredInWindow: delivered,
    manualPause,
  })
}

export interface DispatchTickResult {
  /** What the pacing rules decided. */
  verdict: DispatchVerdict
  /** Present only when the verdict was `send` and the lock was ours. */
  delivered?: DeliverResult
  /** True when another send was already running, so this tick did nothing. */
  lockBusy?: boolean
  /**
   * On a `too-soon` hold: milliseconds until the fleet gap clears, so a caller can wake
   * exactly then instead of on its own grid (2026-08-22).
   *
   * WHY, MEASURED TWICE THE SAME DAY: the device poll's 30s grid put the first eligible
   * tick at drive-end + 30s, so a ~47s drive produced a 77s period — first through an
   * additive sleep, then, after that was fixed, through pure discretisation: ticks landed
   * at +47s (held, 13s early) and +77s (sent, 17s late). "Expected ~60s" was written
   * without walking the grid, and one live interval disproved it. The dispatcher is the
   * one place that knows when the gap clears, so it SAYS so rather than letting every
   * caller rediscover the boundary by polling past it.
   */
  retryInMs?: number
  at: string
}

/**
 * One dispatcher tick: send at most `maxSendsPerTick` messages, then return.
 *
 * ── BOUNDED, ON PURPOSE ───────────────────────────────────────────────────
 *
 * The old delivery step drained the whole queue inside a slot with a 45-180 s sleep
 * between sends. At fleet volume — measured, 11-14 paid posts a day from `@viralbhayani`
 * alone — that is an hour of continuous browser driving inside one slot, and all of it
 * inside one hour into one inbox from a dozen different pages. Bounding the tick moves
 * spacing out of a sleep in a loop and into the SCHEDULE, where a wedged tick cannot sit
 * on the lock waiting.
 *
 * Nothing is dropped by the bound. Whatever is not sent this tick is still READY, and the
 * next tick is fifteen minutes away.
 */
export async function dispatchTick(reason: string): Promise<DispatchTickResult> {
  const at = new Date()
  const settings = await getSettings()

  if (env.DRY_RUN) {
    const verdict: DispatchVerdict = {
      action: 'hold',
      reason: 'dry-run',
      detail: 'DRY_RUN is on — the pipeline runs fully and sends nothing',
    }
    await recordDispatchState({ at, verdict, sent: 0 })
    return { verdict, at: at.toISOString() }
  }

  const [breaker, waitingCount, lastStart] = await Promise.all([
    assessFleetBreaker(at),
    prisma.outreachAttempt.count({ where: { status: 'READY' } }),
    /**
     * The gap clock is when a send last BEGAN, not when one finished (2026-08-21).
     * Measuring from completion added the ~47s browser drive to every gap, so a 1-minute
     * setting produced a 107-second period — 33/hour where it named 60. See
     * `GAP_MEASURED_FROM_SEND_START` in pacing.ts for the measurement.
     */
    lastSendStartedAt(),
  ])

  const minutesSinceLastSend =
    lastStart == null ? null : Math.floor((at.getTime() - lastStart.getTime()) / 60_000)

  const verdict = decideDispatch({
    autopilotEnabled: settings.autopilotEnabled,
    breaker,
    istHour: istHourOfDay(at),
    minutesSinceLastSend,
    minGapMinutes: settings.fleetMinGapMinutes,
    waitingCount,
  })

  if (verdict.action === 'hold') {
    // Every hold is logged with its reason. "Nothing happened" with no explanation is the
    // failure the whole delivery step was built to prevent, and a dispatcher that holds
    // silently reintroduces it four times an hour.
    log.step('dispatcher held', { reason: verdict.reason, detail: verdict.detail, tick: reason })
    await recordDispatchState({ at, verdict, sent: 0 })
    /* On too-soon, say exactly when the gap clears — computed from the same clock the
       decision just read, so caller and rule cannot disagree about the boundary. */
    if (verdict.reason === 'too-soon' && lastStart !== null) {
      const clearsAt = lastStart.getTime() + settings.fleetMinGapMinutes * 60_000
      return { verdict, retryInMs: Math.max(0, clearsAt - at.getTime()), at: at.toISOString() }
    }
    return { verdict, at: at.toISOString() }
  }

  /**
   * The lock is taken AFTER the decision and released before returning, so a tick that
   * was never going to send does not block the dashboard's Send button for the duration
   * of its own queries.
   */
  const result = await withSendLock(`dispatch:${reason}`, async () => {
    /* The pace clock is stamped by `browserSender.send` when a drive actually begins —
       a tick that holds every draft must not reset it (see recordSendStarted). */
    return deliverWaiting({ maxSends: settings.maxSendsPerTick })
  })

  if (result === null) {
    const busy: DispatchVerdict = {
      action: 'hold',
      reason: 'send-in-progress',
      detail: 'another send is already running — this tick did nothing and nothing was lost',
    }
    await recordDispatchState({ at, verdict: busy, sent: 0 })
    return { verdict: busy, lockBusy: true, at: at.toISOString() }
  }

  await recordDispatchState({
    at,
    verdict,
    sent: result.sent,
    held: result.outcomes.length - result.sent,
    /**
     * WHY individual messages were held, not just how many.
     *
     * Without this the dashboard read **"0 message(s) sent"** with a held count and no
     * reason whenever pacing PERMITTED the tick and every candidate was then held by a
     * per-attempt check — an unreadable conversation, a persona mismatch, a spent cap.
     *
     * The docblock on `recordDispatchState` says this mechanism exists because *"autopilot
     * is on and nothing has gone out" has no explanation anywhere*, and it stopped one
     * level short of its own claim: it explained why the FLEET did not send and not why a
     * MESSAGE did not. Found 2026-08-05 by asking what the screen shows when the
     * just-in-time conversation read holds a follow-up.
     */
    holdReasons: result.outcomes
      .filter((o) => o.result.startsWith('held: '))
      .map((o) => `${o.pairKey} — ${o.result.slice('held: '.length)}`),
  })
  return { verdict, delivered: result, at: at.toISOString() }
}

export interface DispatchState {
  at: string
  /** IST, for a human reading the dashboard. */
  atIst: string
  action: 'send' | 'hold'
  reason: string
  detail: string
  sent: number
  held?: number
  /**
   * Why individual messages were held, one line each. Present only when something was.
   *
   * Bounded to a handful: at fleet scale a tick could hold sixty-five, and a dashboard panel
   * is not a log file. The count in `held` is the total; this is the explanation.
   */
  holdReasons?: string[]
}

/**
 * What a permitted tick actually achieved, in one sentence for a person.
 *
 * PURE and separated because it is a DECISION about what to say, and this file's own rule is
 * that an `if` belongs in a tested function rather than in a database writer.
 *
 * It exists because the previous version said **"0 message(s) sent"** whenever pacing cleared
 * the fleet to send and every individual message was then held — by an unreadable
 * conversation, a persona mismatch, a spent cap. That explained why the FLEET did not send and
 * not why a MESSAGE did not, which is the question someone has when the dashboard says
 * autopilot is on and nothing has moved. The docblock below claims this mechanism exists
 * precisely so that question has an answer, and it stopped one level short of its own claim.
 */
export function describeTickOutcome(args: { sent: number; held: number; firstHoldReason?: string }): string {
  const { sent, held, firstHoldReason } = args
  if (sent > 0) return `${sent} message(s) sent`
  if (firstHoldReason === undefined) return 'nothing was waiting to send'
  return held <= 1
    ? `nothing sent — the one waiting message was held: ${firstHoldReason}`
    : `nothing sent — all ${held} waiting messages were held, starting with: ${firstHoldReason}`
}

/**
 * Record what the last tick did.
 *
 * A toggle that promises behaviour must show whether anything is behind it — that is why
 * the scheduler's heartbeat is on screen in red when it is stale. The same argument
 * applies with more force here, because the dispatcher is now the ONLY unattended path to
 * a delivered message: without this, "autopilot is on and nothing has gone out" has no
 * explanation anywhere.
 */
async function recordDispatchState(args: {
  at: Date
  verdict: DispatchVerdict
  sent: number
  held?: number
  holdReasons?: string[]
}): Promise<void> {
  const reasons = (args.holdReasons ?? []).slice(0, 5)
  const sentDetail = describeTickOutcome({ sent: args.sent, held: args.held ?? 0, firstHoldReason: reasons[0] })

  const state: DispatchState = {
    at: args.at.toISOString(),
    atIst: istStamp(args.at),
    action: args.verdict.action,
    reason: args.verdict.action === 'send' ? (args.sent > 0 ? 'sending' : 'all-held') : args.verdict.reason,
    detail: args.verdict.action === 'send' ? sentDetail : args.verdict.detail,
    sent: args.sent,
    ...(args.held === undefined ? {} : { held: args.held }),
    ...(reasons.length === 0 ? {} : { holdReasons: reasons }),
  }
  const value = JSON.stringify(state)
  await prisma.setting
    .upsert({ where: { key: DISPATCH_STATE_KEY }, update: { value }, create: { key: DISPATCH_STATE_KEY, value } })
    .catch(() => undefined) // recording what happened must never be what stops it happening
}

/** What the dashboard reads. `null` when no tick has ever run. */
export async function readDispatchState(): Promise<DispatchState | null> {
  const row = await prisma.setting.findUnique({ where: { key: DISPATCH_STATE_KEY } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as DispatchState
  } catch {
    return null
  }
}

/** Fleet pacing as the dashboard should show it: used against the limit being enforced. */
export async function dispatchStatus(now: Date = new Date()): Promise<{
  state: DispatchState | null
  breaker: BreakerVerdict
  usage: { thisHour: number; today: number }
  limits: { perHour: number; perDay: number; minGapMinutes: number; perTick: number }
  waiting: number
}> {
  const [state, breaker, usage, settings, waiting] = await Promise.all([
    readDispatchState(),
    assessFleetBreaker(now),
    fleetUsage(now),
    getSettings(),
    prisma.outreachAttempt.count({ where: { status: 'READY' } }),
  ])
  return {
    state,
    breaker,
    usage,
    limits: {
      perHour: settings.fleetMaxPerHour,
      perDay: settings.fleetMaxPerDay,
      minGapMinutes: settings.fleetMinGapMinutes,
      perTick: settings.maxSendsPerTick,
    },
    waiting,
  }
}
