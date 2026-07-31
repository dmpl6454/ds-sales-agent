import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { randomInt } from '@/lib/time'
import { browserSender } from './senders/browser'
import { profileStatus } from './browser/profile'
import { recheckBeforeSend } from './gate'

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


  for (const attempt of waiting) {
    const { sender, target } = attempt.pair
    const pairKey = `${sender.handle}→${target.handle}`

    const hold = (reason: string) => {
      out.skipped += 1
      out.outcomes.push({ pairKey, result: `held: ${reason}` })
      log.step('waiting message held back', { pair: pairKey, reason })
    }

    /**
     * The SAME gate the dashboard's Send button runs — one definition, two callers.
     *
     * This was fifty lines of inline checks here and three of them in `sendNow`, and
     * the two drifted: the button ended up missing the route switch, the retired
     * channel, *they replied*, and both daily caps. Duplicating a safety rule is how
     * that happens, so the rules now live in `gate.ts` and both paths call them.
     */
    const gate = await recheckBeforeSend(attempt, { unattended: true })
    if (!gate.ok) {
      hold(gate.detail ?? gate.reason)
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
