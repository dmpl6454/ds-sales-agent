import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { istDayStart } from '@/lib/time'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { validatePersona } from './render'
import { composeForPair, unusedCampaignCount, NoVariantsError, VariantsExhaustedError } from './compose'
import { profileStatus } from './browser/profile'
import { sessionUsable } from './sessionHealth'
import { replyHaltFloor } from './replyHalt'
import { RESEND_BLOCKS } from './gate'

/**
 * Send a message to a chosen account, now, because a person decided to.
 *
 * The scheduled path answers "may we contact this pair?" and the answer is usually
 * no — that is the point of `governor.ts`, and its spacing rules exist so nobody has
 * to think about them. This is the other case: someone has a reason the system does
 * not know about, and the system should not be the thing standing in the way.
 *
 * So the governor's rules are still evaluated here, but as *facts to show* rather
 * than as permissions. Every one of them becomes a sentence in a confirmation dialog
 * naming what is about to be crossed. That is the whole safety argument for this
 * feature: it does not remove a guard, it moves the decision to a human and makes
 * sure the human is told exactly what they are deciding.
 *
 * Which is also why the split below is not cosmetic:
 *
 *   BLOCKS   refuse outright, no dialog, no override. These are not judgement calls
 *            — the account is flagged, the channel is retired, there is no browser
 *            session, or the day's volume is spent. See OVERRIDABLE_BLOCKS in
 *            `gate.ts` for why each one is absolute.
 *   WARNINGS are shown, acknowledged, and crossed. Spacing, repetition, and "they
 *            already replied" all live here.
 *
 * `describeOnDemand` is pure — no DB, no clock, no env — so both directions of every
 * rule are testable. This repo has an eight-instance history of guards verified only
 * in the direction that passes, and a guard whose whole job is to produce a warning
 * fails silently by producing none.
 */

export interface OnDemandFacts {
  now: Date

  /** Absolute-stop inputs. */
  senderStatus: string // ACTIVE | PAUSED | CHALLENGED
  senderHasSession: boolean
  targetOptedOut: boolean
  /** DELIVERED from THIS account to THIS recipient today — the one volume rule left. */
  pairSentTodayCount: number
  maxPerPairPerDay: number
  /** A sender must never message itself; Instagram's self-thread is a different surface. */
  isSelfSend: boolean

  /** Warning inputs — everything the governor would have refused on. */
  touchesSoFar: number
  targetRepliedAt: Date | null
  pendingAttemptCount: number
  unusedCampaignCount: number
  totalInFlight: number
  maxTotalSends: number | null
}

export interface OnDemandNote {
  /** Stable code. Overridable ones match RESEND_BLOCKS so the two vocabularies agree. */
  reason: string
  /** One sentence, written for the person clicking the button. */
  text: string
}

export interface OnDemandVerdict {
  /** Non-empty means the button refuses. No dialog is offered. */
  blocks: OnDemandNote[]
  /** Shown in the dialog. Must be acknowledged before the send proceeds. */
  warnings: OnDemandNote[]
}

/**
 * ── EVERY RULE A PERSON MAY CROSS, AS A CLOSED SET ────────────────────────────────────
 *
 * `/rules` promises at the top of the page that *"every number is read from the module
 * that enforces it"*, and its "never crossed" list keeps that promise — `STOP_LABELS` is
 * TOTAL over `RESEND_BLOCKS`, so a gate stop added without a sentence is a compile error.
 * Its "you may cross" list did not: it was one hand-written sentence, and it still named
 * **"the route being off"** — `PAIR_DISABLED`, a stop DELETED on 2026-08-08 along with the
 * per-route chip. So the page told a reader they could cross a rule that no longer exists,
 * on the one screen whose entire job is saying what the system will and will not do.
 *
 * Same shape as `MAX_TOTAL_SENDS` being counted two ways: a page describing a rule by a
 * different source than the one enforcing it is worse than a page that omits it, because
 * it reads as knowledge. So the crossable set is declared HERE, beside the code that emits
 * it, and the page renders labels TOTAL over these keys.
 *
 * `TARGET_REPLIED` deliberately reuses the gate's own string — it is the one stop that is
 * both a gate block and crossable, and two vocabularies for one rule is how they drift.
 */
export const CROSSABLE_RULES = {
  TARGET_REPLIED: RESEND_BLOCKS.TARGET_REPLIED,
  NO_NEW_MATERIAL: 'no-new-material',
  PENDING_ATTEMPT_EXISTS: 'pending-attempt-exists',
  LIFETIME_SEND_CAP_REACHED: 'lifetime-send-cap-reached',
} as const

export type CrossableRule = (typeof CROSSABLE_RULES)[keyof typeof CROSSABLE_RULES]

const MS_PER_DAY = 86_400_000

/** "3 days ago" / "today" — the dialog needs plain English, not an ISO string. */
function agoLabel(now: Date, then: Date): string {
  const days = Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function describeOnDemand(f: OnDemandFacts): OnDemandVerdict {
  const blocks: OnDemandNote[] = []
  const warnings: OnDemandNote[] = []

  // ── Absolute stops ────────────────────────────────────────────────────────
  //
  // Collected in full rather than returned on the first hit. Someone who fixes the
  // one problem shown and finds the button still refusing has been told half the
  // truth, which is the failure the dashboard's "Needs you" list already avoids.

  if (f.isSelfSend) {
    blocks.push({
      reason: 'self-send',
      text: 'An account cannot message itself.',
    })
  }

  if (f.senderStatus === 'CHALLENGED') {
    blocks.push({
      reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      text: 'Instagram has flagged this account. Sending from it is halted until you open it by hand and clear the prompt.',
    })
  } else if (f.senderStatus !== 'ACTIVE') {
    blocks.push({
      reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      text: `This account is ${f.senderStatus.toLowerCase()}. Resume it before sending.`,
    })
  }

  if (f.targetOptedOut) {
    blocks.push({
      reason: RESEND_BLOCKS.TARGET_OPTED_OUT,
      text: 'This channel is retired — it was removed with the promise that it would never be contacted again. That promise is not overridable.',
    })
  }

  if (!f.senderHasSession) {
    blocks.push({
      reason: RESEND_BLOCKS.NO_SESSION,
      text: 'This account is not connected. Press Connect on its row and log in in the Chrome window that opens.',
    })
  }

  if (f.pairSentTodayCount >= f.maxPerPairPerDay) {
    blocks.push({
      reason: RESEND_BLOCKS.PAIR_DAILY_CAP,
      text: `This account has already sent this recipient ${f.pairSentTodayCount} message${f.pairSentTodayCount === 1 ? '' : 's'} today (the limit is ${f.maxPerPairPerDay} per day from one account to one recipient). Try again tomorrow.`,
    })
  }

  // ── Warnings ──────────────────────────────────────────────────────────────

  // Deliberately first. It is the most consequential thing anyone can cross here:
  // a live human conversation, and the recipient is the one person who engaged.
  if (f.targetRepliedAt !== null) {
    warnings.push({
      reason: CROSSABLE_RULES.TARGET_REPLIED,
      text: `They replied ${agoLabel(f.now, f.targetRepliedAt)}. Automated outreach to them is halted so a person can take over — sending now adds another message to a live conversation.`,
    })
  }

  if (f.touchesSoFar > 0 && f.unusedCampaignCount === 0) {
    warnings.push({
      reason: CROSSABLE_RULES.NO_NEW_MATERIAL,
      text: 'Nothing new has been detected from them since your last message, so this one repeats material they have already seen. Repetition is the thing Instagram penalises most.',
    })
  }

  if (f.pendingAttemptCount > 0) {
    warnings.push({
      reason: CROSSABLE_RULES.PENDING_ATTEMPT_EXISTS,
      text: 'A message to them is already written and waiting to be sent. This creates a second one.',
    })
  }

  if (f.maxTotalSends !== null && f.totalInFlight >= f.maxTotalSends) {
    warnings.push({
      reason: CROSSABLE_RULES.LIFETIME_SEND_CAP_REACHED,
      text: `The overall send limit of ${f.maxTotalSends} is reached (${f.totalInFlight} used or waiting). The scheduled agent has stopped preparing anything new.`,
    })
  }

  return { blocks, warnings }
}

// ───────────────────────────────────────────────────────────────────────────
// The DB half. Queries and composition only — every decision is above.
// ───────────────────────────────────────────────────────────────────────────

export interface OnDemandPreview {
  ok: boolean
  blocks: OnDemandNote[]
  warnings: OnDemandNote[]
  /** Present when ok — the attempt is created READY and waits for confirmation. */
  attemptId?: string
  body?: string
  senderHandle?: string
  senderName?: string
  targetHandle?: string
  targetName?: string
}

/**
 * Compose a message for this sender→target and leave it waiting.
 *
 * Creates a real `OutreachAttempt` in READY rather than holding a body in memory,
 * for two reasons. The stored body is the single source of truth the send guard
 * compares the composer against, so a preview that is not the stored bytes would
 * make that guard compare against the wrong thing. And a draft the operator then
 * abandons is not an orphan — it appears in the awaiting tray with the same Send
 * and Discard controls as any other, because it IS any other.
 */
export async function prepareOnDemand(senderHandle: string, targetHandle: string): Promise<OnDemandPreview> {
  const [sender, target, settings] = await Promise.all([
    prisma.senderAccount.findUnique({ where: { handle: senderHandle } }),
    prisma.targetAccount.findUnique({ where: { handle: targetHandle } }),
    getSettings(),
  ])
  if (!sender) return { ok: false, blocks: [{ reason: 'no-sender', text: `@${senderHandle} is not one of your accounts.` }], warnings: [] }
  if (!target) return { ok: false, blocks: [{ reason: 'no-target', text: `@${targetHandle} is not a channel you watch.` }], warnings: [] }

  /**
   * The route may not exist — every sender×target combination is offered, and the
   * seed only creates the ones autopilot uses. Created DISABLED: choosing to send one
   * message is not choosing to let the scheduler send more, and "adding is never the
   * same act as sending" has to hold in this direction too.
   */
  const pair =
    (await prisma.outreachPair.findUnique({
      where: { senderId_targetId: { senderId: sender.id, targetId: target.id } },
    })) ??
    (sender.handle === target.handle
      ? null
      : await prisma.outreachPair.create({
          data: {
            senderId: sender.id,
            targetId: target.id,
            cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
            enabled: false,
          },
        }))

  const dayStart = istDayStart()
  const [touches, replied, pairToday, pending, totalInFlight, unusedCampaigns] =
    await Promise.all([
      pair
        ? prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } } })
        : 0,
      prisma.outreachAttempt.findFirst({
        // The warning matches the stop's window: a reply older than replyResumeHours no
        // longer halts, so warning about it would name a rule that is not in force.
        where: {
          pair: { targetId: target.id },
          replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) },
          replyHandledAt: null,
        },
        orderBy: { repliedAt: 'desc' },
        select: { repliedAt: true },
      }),
      // The one volume rule left: five per day from THIS account to THIS recipient.
      pair
        ? prisma.outreachAttempt.count({
            where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } },
          })
        : 0,
      pair
        ? prisma.outreachAttempt.count({
            where: { pairId: pair.id, status: { in: ['QUEUED', 'READY', 'SENDING'] } },
          })
        : 0,
      prisma.outreachAttempt.count({ where: { status: { in: [...IN_FLIGHT_STATUSES] } } }),
      /**
       * The SAME new-material count the planner uses, from `compose.ts`.
       *
       * This was `hoursAgo(settings.hookMaxAgeHours)` while the planner used
       * `newMaterialFloor()`, which takes the LATER of the hook window and the 1 August
       * detection cutoff. Measured: at HOOK_MAX_AGE_HOURS=72 the hook window reaches
       * SIX AND A HALF HOURS further back than the cutoff, so this dialog offered
       * pre-cutoff campaigns as "something new to say" that the planner refuses — and
       * `no-new-material` is a WARNING here, so the operator could cross a rule using a
       * campaign the system does not consider new at all.
       */
      pair ? unusedCampaignCount({ target, pairId: pair.id }) : 0,
    ])

  const verdict = describeOnDemand({
    now: new Date(),
    senderStatus: sender.status,
    // §3.5: a cookie on disk AND nothing has since proved it dead — same combined input
    // the delivery gate uses, so the dialog and the gate cannot disagree.
    senderHasSession: sessionUsable({
      hasSessionOnDisk: profileStatus(sender.handle).hasSession,
      sessionInvalidAt: sender.sessionInvalidAt,
    }),
    targetOptedOut: target.optedOut,
    pairSentTodayCount: pairToday,
    maxPerPairPerDay: settings.maxPerPairPerDay,
    isSelfSend: sender.handle === target.handle,
    touchesSoFar: touches,
    targetRepliedAt: replied?.repliedAt ?? null,
    pendingAttemptCount: pending,
    unusedCampaignCount: unusedCampaigns,
    totalInFlight,
    maxTotalSends: env.MAX_TOTAL_SENDS,
  })

  if (verdict.blocks.length > 0 || !pair) {
    return { ok: false, blocks: verdict.blocks, warnings: verdict.warnings }
  }

  /**
   * ── Compose — the SAME function the planner calls ─────────────────────────
   *
   * This used to be a hand-copied version of the planner's composition, and it drifted
   * in three ways: an unscoped variant pool (a media-buying body reachable for a
   * publisher), a looser campaign floor, and no brand first touch. "Exactly as the
   * planner does" was a comment asserting a property nothing enforced.
   */
  let composed
  try {
    composed = await composeForPair({
      pair: { ...pair, sender, target },
      senderHandle: sender.handle,
      touchNumber: touches + 1,
    })
  } catch (e) {
    if (e instanceof NoVariantsError) {
      return {
        ok: false,
        blocks: [
          {
            reason: 'no-variants',
            text: `@${sender.handle} has no ${target.kind === 'BRAND' ? 'brand' : 'channel'} message templates. Run: pnpm db:seed`,
          },
        ],
        warnings: verdict.warnings,
      }
    }
    /**
     * Every message this account can write has already been sent to this recipient.
     *
     * A BLOCK rather than a warning, and deliberately not in `OVERRIDABLE_BLOCKS`. Every
     * stop a person may cross is about TIMING — too soon, nothing new to say, they already
     * replied. This one says the message itself would be a word-for-word repeat of one this
     * recipient has already read, and "I know something the agent does not" is not an
     * argument that applies to that. Same reasoning as the persona gate.
     */
    if (e instanceof VariantsExhaustedError) {
      return {
        ok: false,
        blocks: [{ reason: 'variants-exhausted', text: e.message }],
        warnings: verdict.warnings,
      }
    }
    throw e
  }
  const { body, hookLine } = composed

  const attempt = await prisma.outreachAttempt.create({
    data: {
      pairId: pair.id,
      senderId: sender.id,
      targetId: target.id,
      campaignId: composed.campaignId,
      variantId: composed.variantId,
      touchNumber: touches + 1,
      hookLine,
      renderedBody: body,
      status: 'READY',
    },
  })

  return {
    ok: true,
    blocks: [],
    warnings: verdict.warnings,
    attemptId: attempt.id,
    body,
    senderHandle: sender.handle,
    senderName: sender.displayName,
    targetHandle: target.handle,
    targetName: target.displayName,
  }
}
