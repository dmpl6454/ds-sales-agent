import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { istDayStart } from '@/lib/time'
import { browserSender } from './senders/browser'
import { profileStatus } from './browser/profile'

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
 */

export interface DeliverResult {
  sent: number
  failed: number
  skipped: number
  outcomes: { pairKey: string; result: string }[]
}

export async function deliverWaiting(): Promise<DeliverResult> {
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

  const dayStart = istDayStart()

  for (const attempt of waiting) {
    const { sender, target } = attempt.pair
    const pairKey = `${sender.handle}→${target.handle}`

    const hold = (reason: string) => {
      out.skipped += 1
      out.outcomes.push({ pairKey, result: `held: ${reason}` })
      log.step('waiting message held back', { pair: pairKey, reason })
    }

    if (!sender.autoSendEnabled) {
      hold('auto-send is off for this account')
      continue
    }
    if (sender.status !== 'ACTIVE') {
      hold(`account is ${sender.status}`)
      continue
    }
    if (!attempt.pair.enabled) {
      hold('this route is switched off')
      continue
    }
    if (target.optedOut) {
      hold('channel is retired')
      continue
    }
    if (!profileStatus(sender.handle).hasSession) {
      hold('account is not connected')
      continue
    }

    // A reply anywhere on this target halts every sender to it — a live conversation
    // must never receive a queued cold pitch.
    const replied = await prisma.outreachAttempt.findFirst({
      where: { pair: { targetId: target.id }, repliedAt: { not: null } },
      select: { id: true },
    })
    if (replied) {
      hold('they replied — outreach to this channel is halted')
      continue
    }

    // Caps are per day and this attempt may have been drafted days ago.
    const [targetToday, senderToday] = await Promise.all([
      prisma.outreachAttempt.count({
        where: { pair: { targetId: target.id }, status: 'SENT', sentAt: { gte: dayStart } },
      }),
      prisma.outreachAttempt.count({
        where: { pair: { senderId: sender.id }, status: 'SENT', sentAt: { gte: dayStart } },
      }),
    ])
    if (targetToday >= settings.maxPerTargetPerDay) {
      hold(`channel already received ${targetToday} today`)
      continue
    }
    if (senderToday >= sender.dailyCap) {
      hold(`account already sent ${senderToday} today`)
      continue
    }

    // SENDING is the lock: it stops the dashboard button and this loop from both
    // driving the same attempt.
    const claimed = await prisma.outreachAttempt.updateMany({
      where: { id: attempt.id, status: 'READY' },
      data: { status: 'SENDING' },
    })
    if (claimed.count === 0) {
      hold('already being sent')
      continue
    }

    log.step('delivering a waiting message', { pair: pairKey, chars: attempt.renderedBody.length })
    const outcome = await browserSender.send({
      attemptId: attempt.id,
      senderHandle: sender.handle,
      sessionPath: profileStatus(sender.handle).dir,
      targetHandle: target.handle,
      body: attempt.renderedBody,
    })

    if (outcome.status === 'SENT') {
      await prisma.$transaction([
        prisma.outreachAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            sentBy: `autopilot:${sender.handle}`,
            threadUrl: outcome.threadUrl ?? null,
            error: null,
          },
        }),
        prisma.messageVariant.update({
          where: { id: attempt.variantId },
          data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
        }),
        prisma.auditLog.create({
          data: {
            actor: 'autopilot',
            action: 'attempt.sent.autopilot',
            entity: `OutreachAttempt:${attempt.id}`,
            detail: `${pairKey} — ${outcome.threadUrl ?? 'delivered'}`,
          },
        }),
      ])
      out.sent += 1
      out.outcomes.push({ pairKey, result: 'sent' })
      continue
    }

    const error = outcome.status === 'FAILED' ? outcome.error : 'sender returned no outcome'

    if (outcome.status === 'FAILED' && outcome.challenged) {
      // Halt the account. Never a retry — that is how a recoverable flag becomes a ban.
      await prisma.$transaction([
        prisma.senderAccount.update({ where: { id: sender.id }, data: { status: 'CHALLENGED' } }),
        prisma.outreachAttempt.update({ where: { id: attempt.id }, data: { status: 'READY', error } }),
        prisma.auditLog.create({
          data: {
            actor: 'autopilot',
            action: 'sender.challenged',
            entity: `SenderAccount:${sender.handle}`,
            detail: error,
          },
        }),
      ])
      out.failed += 1
      out.outcomes.push({ pairKey, result: 'CHALLENGED — account halted' })
      log.alarm('Instagram checkpoint during autopilot — account halted, nothing retried', {
        sender: sender.handle,
      })
      continue
    }

    await prisma.outreachAttempt.update({ where: { id: attempt.id }, data: { status: 'READY', error } })
    out.failed += 1
    out.outcomes.push({ pairKey, result: `failed: ${error}` })
  }

  if (out.sent > 0 || out.failed > 0) {
    log.info('autopilot delivery', { sent: out.sent, failed: out.failed, held: out.skipped })
  }
  return out
}
