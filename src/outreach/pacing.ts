/**
 * WHEN may the fleet send the next message, and when must it stop altogether?
 *
 * ── WHY DELIVERY LEFT THE SLOT ────────────────────────────────────────────
 *
 * `deliverWaiting` used to run inside a slot and deliver EVERYTHING waiting, spacing
 * consecutive sends by `SEND_JITTER_*` (45-180 s). At four accounts with three drafts
 * that is a two-minute slot. At fleet scale it is not: measured, `@viralbhayani` posts
 * 11-14 paid posts a day, so a single slot could hold fourteen drafts and take an hour
 * of continuous browser driving — and every one of those sends would land inside the
 * same hour, from fourteen different pages, into one inbox. That is precisely the
 * recipient-side pattern the whole fleet design is trying to avoid, and it would arrive
 * as a side effect of the delivery loop rather than as anyone's decision.
 *
 * So delivery is now PACED: at most `maxSendsPerTick` per tick, a minimum gap between
 * consecutive sends fleet-wide, and a per-hour fleet allowance. A slot is bounded again,
 * and sends spread across the day instead of clustering behind whatever fired last.
 *
 * ── ACTIVE HOURS: A GUARD THAT USED TO BE IMPLICIT ────────────────────────
 *
 * This is the part that must not be lost in the move. Delivery only ever ran at 11:00,
 * 15:00, 17:00 and 20:00 IST, so "we never DM at 4 a.m." was true — but true by
 * accident, as a property of the slot list rather than a rule anyone wrote down. A
 * dispatcher on its own cadence would happily send at 03:40, from an Indian business
 * page, which is a behavioural signal no amount of pacing offsets.
 *
 * `withinActiveHours` makes that rule explicit and slightly wider than the slots
 * (10:00-21:00 IST) so a tick just after the 20:00 slot can still drain. Taking an
 * implicit safety property and writing it down is the only way a refactor can be shown
 * not to have dropped it.
 *
 * ── PURE ──────────────────────────────────────────────────────────────────
 *
 * No database, no clock, no env — every input is passed in, exactly like `governor.ts`,
 * `gate.ts` and `rotation.ts`. This codebase has a twelve-instance history of guards
 * verified only in the direction that passes, and a circuit breaker is the worst
 * possible place for that: a breaker that cannot trip reads as a healthy one.
 */

/** IST hour (inclusive) from which unattended sending is allowed. */
export const ACTIVE_FROM_HOUR = 10
/** IST hour (EXCLUSIVE) at which unattended sending stops. 21 = last send by 20:59. */
export const ACTIVE_TO_HOUR = 21

/**
 * Minimum minutes between two consecutive fleet sends.
 *
 * Not the same control as the per-hour allowance, and both are needed. The hourly
 * allowance shapes volume; this stops two sends landing seconds apart when two callers
 * (a slot and a dispatcher tick, or a tick and the dashboard) happen to align. The send
 * lock serialises them so they cannot interleave, and without this they would simply
 * queue up and run back to back — serialised, and still a cluster.
 *
 * 3 MINUTES SINCE 2026-08-19, Tabish's instruction ("reduce the time from every 5 mins
 * to 3 mins or lesser … we are using multiple accounts, messaging should be faster").
 * That is ~220 deliveries of headroom inside the 10:00-21:00 window, against a queue
 * whose depth is bounded by prospect inflow. The risk was stated when the caps went and
 * is unchanged in kind: a tighter gap concentrates identical-template sends from one
 * home IP, and the recipient-side pattern is what draws reports. Going FASTER is one
 * Setting row (`fleetMinGapMinutes` = 1 — the device agent polls every 60s, so one
 * minute is the effective floor); going slower is the same row. Neither needs a deploy.
 */
export const FLEET_MIN_GAP_MINUTES = 3

/**
 * Fleet sends allowed per IST hour. UNLIMITED since 2026-08-18, Tabish's instruction
 * ("Remove all caps … no ceiling to send messages"). What paces the fleet now is the
 * minimum gap above — one send every FLEET_MIN_GAP_MINUTES inside the active window,
 * which works out to roughly 220 sends a day at the 3-minute default. The mechanism is
 * kept wired (a `fleetMaxPerHour` Setting row re-binds it in one write), because the
 * alternative is discovering at 2 a.m. that the only way to slow the fleet is a code
 * change. The risk of removing the hourly allowance was stated to Tabish plainly and
 * the call recorded as his.
 */
export const FLEET_MAX_PER_HOUR = Number.POSITIVE_INFINITY

/**
 * Fleet sends allowed per IST day. UNLIMITED by default, deliberately.
 *
 * Tabish decided: no per-sender cap and NO SYSTEM-WIDE CAP — throughput is whatever the
 * detected paid posts amount to. A fleet-per-day cap IS a system-wide cap, so shipping
 * one with a number in it would quietly reverse that decision, which is the failure the
 * "decisions that must not be quietly reversed" section exists to prevent.
 *
 * The MECHANISM is built and wired anyway, because the alternative is discovering at 2
 * a.m. that the only way to stop the fleet is a code change. It is one `Setting` row
 * away from binding (`fleetMaxPerDay`), and `Infinity` means every `count >= limit`
 * comparison is false forever, so no guard changes shape.
 */
export const FLEET_MAX_PER_DAY = Number.POSITIVE_INFINITY

/**
 * Sends per dispatcher tick. ONE.
 *
 * A tick that sends one message and returns is the anti-clustering rule at its simplest:
 * spacing becomes a property of the SCHEDULE rather than of a sleep inside a loop, and a
 * loop that sleeps is a loop that can be wedged holding a lock. It is configurable
 * because draining a backlog faster is a legitimate operator choice, but the default is
 * the one that cannot cluster.
 */
export const MAX_SENDS_PER_TICK = 1

/** How often the dispatcher wakes. 15 minutes → 44 opportunities inside the window. */
export const DISPATCH_INTERVAL_MINUTES = 15

/**
 * ── THE CIRCUIT BREAKER ───────────────────────────────────────────────────
 *
 * Two signals mean STOP, and they are different in kind.
 *
 * **A checkpoint on any account.** Every sender drives the same code path from the same
 * residential IP with the same behavioural signature. If Instagram flagged one of them,
 * the thing that got flagged is the PATTERN, and continuing to push 64 more accounts
 * through it is the "retry into enforcement" mistake at fleet scale. The individual
 * account is already halted (`CHALLENGED` is checked in `gate.ts`, `plan.ts` and
 * `deliver.ts`); this halts everyone else, which nothing did before.
 *
 * **A rising rate of `not-in-thread`.** The composer cleared and the message never
 * appeared. That is what a shadow restriction looks like from outside — Instagram
 * accepting the keystroke and dropping the message — and it is also the only failure
 * where the recipient may have the message anyway. One occurrence can be a slow render
 * or a DOM change, so a single event alarms loudly (it already does) without halting the
 * fleet. A repeated one, as a PROPORTION of recent sends, is the signal.
 *
 * ── AND IT CAN BE RELEASED ────────────────────────────────────────────────
 *
 * "A hard stop with no release is a bug wearing a safety feature's clothes" — this
 * project's own lesson, learned when the first reply retired a channel permanently. So
 * the challenge trip is scoped to a WINDOW rather than to the mere existence of a
 * `CHALLENGED` row: clearing the challenge on the dashboard (a human looked at the
 * account) releases it immediately, and if nobody ever does, it releases itself after
 * the window instead of halting the fleet forever. The flagged account itself stays
 * halted either way — that stop is separate and is not on a timer.
 */

/** Any account challenged inside this window halts the whole fleet. */
export const CHALLENGE_WINDOW_HOURS = 24

/** Window over which `not-in-thread` is measured against successful sends. */
export const FAILURE_WINDOW_HOURS = 24

/**
 * Both must hold to trip. A count alone would halt the fleet over two failures in a
 * hundred sends; a rate alone would halt it over one failure in one send, which is the
 * first send after a quiet week.
 */
export const NOT_IN_THREAD_MIN_COUNT = 2
export const NOT_IN_THREAD_MIN_RATE = 0.3

export type BreakerReason = 'challenged' | 'not-in-thread-rate' | 'manual'

export type BreakerVerdict =
  | { tripped: false }
  | { tripped: true; reason: BreakerReason; detail: string }

export interface BreakerInput {
  /** Accounts Instagram challenged within `challengeWindowHours`. */
  challengedInWindow: number
  challengeWindowHours?: number
  /** Sends whose composer cleared but which never appeared, within the failure window. */
  notInThreadInWindow: number
  /** Sends that DID appear in the thread, same window. The denominator. */
  deliveredInWindow: number
  failureWindowHours?: number
  /**
   * A human pressed Pause. Recorded rather than inferred, so the dashboard can say who
   * and when — an unexplained halt is indistinguishable from a broken one.
   */
  manualPause?: { at: string; by: string; reason?: string } | null
}

export function assessBreaker(input: BreakerInput): BreakerVerdict {
  const challengeWindowHours = input.challengeWindowHours ?? CHALLENGE_WINDOW_HOURS
  const failureWindowHours = input.failureWindowHours ?? FAILURE_WINDOW_HOURS

  // A person's explicit stop outranks everything the system inferred.
  if (input.manualPause) {
    return {
      tripped: true,
      reason: 'manual',
      detail:
        `sending was paused by ${input.manualPause.by} at ${input.manualPause.at}` +
        (input.manualPause.reason ? ` — ${input.manualPause.reason}` : ''),
    }
  }

  if (input.challengedInWindow > 0) {
    return {
      tripped: true,
      reason: 'challenged',
      detail:
        `${input.challengedInWindow} account(s) were flagged by Instagram in the last ` +
        `${challengeWindowHours}h — the whole fleet is held until someone has looked`,
    }
  }

  const total = input.notInThreadInWindow + input.deliveredInWindow
  const rate = total === 0 ? 0 : input.notInThreadInWindow / total
  if (input.notInThreadInWindow >= NOT_IN_THREAD_MIN_COUNT && rate >= NOT_IN_THREAD_MIN_RATE) {
    return {
      tripped: true,
      reason: 'not-in-thread-rate',
      detail:
        `${input.notInThreadInWindow} of the last ${total} sends cleared the composer but never ` +
        `appeared in the thread (${Math.round(rate * 100)}%) in ${failureWindowHours}h — ` +
        `this is what a restriction looks like, so nothing else is sent until someone has looked`,
    }
  }

  return { tripped: false }
}

/**
 * Is `hour` inside [from, to)?
 *
 * Wrap-around is handled (from 22 to 6 means the night) even though the configured
 * window does not need it. A window that silently evaluated to "never" because someone
 * inverted two numbers would stop all sending with no reason on screen, and that failure
 * looks exactly like the system working.
 */
export function withinActiveHours(hour: number, from = ACTIVE_FROM_HOUR, to = ACTIVE_TO_HOUR): boolean {
  if (from === to) return true // a zero-width window means "no restriction", not "never"
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

export type DispatchAction = 'send' | 'hold'

export type DispatchVerdict =
  | { action: 'send' }
  | { action: 'hold'; reason: string; detail: string }

export interface DispatchInput {
  /** The dashboard toggle AND the env floor, already combined by `getSettings`. */
  autopilotEnabled: boolean
  breaker: BreakerVerdict
  /** 0-23, IST. Passed in rather than read, so both directions are testable. */
  istHour: number
  activeFromHour?: number
  activeToHour?: number
  /** Since the last DELIVERED message from any sender. `null` = nothing ever sent. */
  minutesSinceLastSend: number | null
  minGapMinutes?: number
  /** Drafts in READY. Zero is the ordinary case and is not a problem. */
  waitingCount: number
}

/**
 * May the fleet send right now?
 *
 * Ordered most-absolute first so the reason reported is the fundamental one — the same
 * ordering discipline as `evaluateResend`. The breaker comes before "is anything
 * waiting" deliberately: a tripped breaker is a fact an operator needs to see on every
 * tick, and reporting "nothing waiting" while the fleet is halted would hide it behind
 * an empty queue.
 */
export function decideDispatch(input: DispatchInput): DispatchVerdict {
  if (input.breaker.tripped) {
    return { action: 'hold', reason: `breaker-${input.breaker.reason}`, detail: input.breaker.detail }
  }

  if (!input.autopilotEnabled) {
    return {
      action: 'hold',
      reason: 'autopilot-off',
      detail: 'autopilot is off — waiting messages keep their Send button and nothing goes out on its own',
    }
  }

  if (input.waitingCount === 0) {
    return { action: 'hold', reason: 'nothing-waiting', detail: 'no drafts are waiting to be sent' }
  }

  const from = input.activeFromHour ?? ACTIVE_FROM_HOUR
  const to = input.activeToHour ?? ACTIVE_TO_HOUR
  if (!withinActiveHours(input.istHour, from, to)) {
    return {
      action: 'hold',
      reason: 'outside-active-hours',
      detail: `it is ${String(input.istHour).padStart(2, '0')}:xx IST — unattended sending runs ${from}:00-${to}:00`,
    }
  }

  const minGap = input.minGapMinutes ?? FLEET_MIN_GAP_MINUTES
  if (input.minutesSinceLastSend !== null && input.minutesSinceLastSend < minGap) {
    return {
      action: 'hold',
      reason: 'too-soon',
      detail: `the last message went out ${input.minutesSinceLastSend} minute(s) ago — spacing is ${minGap} minutes`,
    }
  }

  return { action: 'send' }
}
