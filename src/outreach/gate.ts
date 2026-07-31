import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { getSettings } from '@/lib/settings'
import { profileStatus } from './browser/profile'

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
   * True when nobody is present (autopilot). Attended sends do NOT require the
   * account's auto-send switch — that switch means "may send with nobody present",
   * and a human clicking Send is the presence it is asking about.
   */
  unattended: boolean

  pairEnabled: boolean
  senderStatus: string // ACTIVE | PAUSED | CHALLENGED
  senderAutoSendEnabled: boolean
  senderHasSession: boolean
  senderDailyCap: number

  targetOptedOut: boolean
  /** Any reply from this target to ANY of our senders. Halts all of them. */
  targetRepliedAt: Date | null

  targetSentTodayCount: number
  senderSentTodayCount: number
  maxPerTargetPerDay: number
}

export type ResendResult = { ok: true } | { ok: false; reason: string; detail?: string }

/** Stable strings so callers and logs can group them. */
export const RESEND_BLOCKS = {
  NOT_WAITING: 'not-waiting',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  AUTO_SEND_OFF: 'auto-send-off',
  PAIR_DISABLED: 'pair-disabled',
  TARGET_OPTED_OUT: 'target-opted-out',
  TARGET_REPLIED: 'target-replied',
  NO_SESSION: 'no-session',
  TARGET_DAILY_CAP: 'target-daily-cap',
  SENDER_DAILY_CAP: 'sender-daily-cap',
} as const

export function evaluateResend(input: ResendInput): ResendResult {
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

  if (input.unattended && !input.senderAutoSendEnabled) {
    return { ok: false, reason: RESEND_BLOCKS.AUTO_SEND_OFF, detail: 'auto-send is off for this account' }
  }

  if (!input.pairEnabled) {
    return { ok: false, reason: RESEND_BLOCKS.PAIR_DISABLED, detail: 'this route is switched off' }
  }

  if (input.targetOptedOut) {
    return { ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT, detail: 'channel is retired' }
  }

  // A reply means a human conversation started. Continuing to fire a queued cold
  // pitch into it is the single most damaging thing this system could do, so it halts
  // every sender to this target, not just the one that got the reply.
  if (input.targetRepliedAt !== null) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_REPLIED,
      detail: `they replied at ${input.targetRepliedAt.toISOString()} — outreach to this channel is halted`,
    }
  }

  if (!input.senderHasSession) {
    return { ok: false, reason: RESEND_BLOCKS.NO_SESSION, detail: 'account is not connected' }
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
    enabled: boolean
    senderId: string
    targetId: string
    sender: { handle: string; status: string; autoSendEnabled: boolean; dailyCap: number }
    target: { optedOut: boolean }
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
  opts: { unattended: boolean },
): Promise<ResendResult> {
  const settings = await getSettings()
  const dayStart = istDayStart()
  const { sender, target, senderId, targetId } = attempt.pair

  const [replied, targetToday, senderToday] = await Promise.all([
    prisma.outreachAttempt.findFirst({
      where: { pair: { targetId }, repliedAt: { not: null } },
      orderBy: { repliedAt: 'desc' },
      select: { repliedAt: true },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { targetId }, status: 'SENT', sentAt: { gte: dayStart } },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { senderId }, status: 'SENT', sentAt: { gte: dayStart } },
    }),
  ])

  return evaluateResend({
    attemptStatus: attempt.status,
    unattended: opts.unattended,
    pairEnabled: attempt.pair.enabled,
    senderStatus: sender.status,
    senderAutoSendEnabled: sender.autoSendEnabled,
    senderHasSession: profileStatus(sender.handle).hasSession,
    senderDailyCap: sender.dailyCap,
    targetOptedOut: target.optedOut,
    targetRepliedAt: replied?.repliedAt ?? null,
    targetSentTodayCount: targetToday,
    senderSentTodayCount: senderToday,
    maxPerTargetPerDay: settings.maxPerTargetPerDay,
  })
}
