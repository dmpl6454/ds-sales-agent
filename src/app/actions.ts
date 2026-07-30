'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { runSlot } from '@/worker/runSlot'
import { browserSender } from '@/outreach/senders/browser'
import { profileStatus } from '@/outreach/browser/profile'
import { setSetting, SETTING_KEYS } from '@/lib/settings'

/**
 * The only three actions the dashboard needs.
 *
 * Everything else that used to live here — editing personas, toggling autopilot,
 * tuning cooldowns, labelling classifications — moved to `pnpm agent` and
 * `pnpm db:studio`. Those are operator tasks, and putting controls that can break
 * outreach on the page a CEO reads is how they get pressed by accident.
 *
 * Every state change still writes an AuditLog row.
 */

async function audit(action: string, entity: string, detail?: string) {
  await prisma.auditLog.create({
    data: { actor: env.OPERATOR_NAME, action, entity, detail: detail ?? null },
  })
}

/** Run a slot immediately rather than waiting for the schedule. Takes ~15s. */
export async function syncNow() {
  const result = await runSlot('manual')
  await audit('sync.now', 'ScrapeRun', `status=${result.status} detected=${result.detected}`)
  revalidatePath('/')
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
 * Guards, in the order they bite:
 *
 *   1. The attempt must still be awaiting send. A double click cannot double send.
 *   2. The Chrome profile must exist and be logged in as exactly this sender.
 *   3. The composer must contain our message before Enter is pressed.
 *   4. The message must appear in the thread before it is recorded as SENT.
 *
 * A checkpoint marks the sender CHALLENGED and halts it. That state is cleared by a
 * human who has looked at the account, never automatically.
 */
export async function sendNow(attemptId: string): Promise<SendNowResult> {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  const { sender, target } = attempt.pair

  // Guard 1 — idempotency. Two clicks, or a click racing the worker, must not
  // produce two messages to a real prospect.
  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') {
    return { ok: false, message: `already ${attempt.status.toLowerCase()} — nothing sent` }
  }
  if (sender.status !== 'ACTIVE') {
    return { ok: false, message: `@${sender.handle} is ${sender.status} — sending is halted for this account` }
  }

  // Guard 2 — a profile that was never logged into by hand cannot send, and must
  // not be "fixed" by importing a session from somewhere else.
  const profile = profileStatus(sender.handle)
  if (!profile.initialised) {
    return {
      ok: false,
      message: `@${sender.handle} has no Chrome profile yet. Run once in a terminal:  pnpm ig:login ${sender.handle}`,
    }
  }

  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'SENDING' } })
  await audit('attempt.send.start', `OutreachAttempt:${attemptId}`, `@${sender.handle} → @${target.handle}`)

  const outcome = await browserSender.send({
    attemptId,
    senderHandle: sender.handle,
    sessionPath: profile.dir,
    targetHandle: target.handle,
    body: attempt.renderedBody,
  })

  if (outcome.status === 'SENT') {
    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          sentBy: `auto:${sender.handle}`,
          threadUrl: outcome.threadUrl ?? null,
          error: null,
        },
      }),
      prisma.messageVariant.update({
        where: { id: attempt.variantId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      }),
    ])
    await audit('attempt.sent.auto', `OutreachAttempt:${attemptId}`, outcome.threadUrl ?? 'delivered')
    revalidatePath('/')
    return { ok: true, message: `Sent to @${target.handle} from @${sender.handle}.` }
  }

  const error = outcome.status === 'FAILED' ? outcome.error : 'sender returned no outcome'

  if (outcome.status === 'FAILED' && outcome.challenged) {
    // Halt the account. Not a retry, not a backoff — a stop.
    await prisma.$transaction([
      prisma.senderAccount.update({ where: { id: sender.id }, data: { status: 'CHALLENGED' } }),
      prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'READY', error } }),
    ])
    await audit('sender.challenged', `SenderAccount:${sender.handle}`, error)
    revalidatePath('/')
    return {
      ok: false,
      challenged: true,
      message: `Instagram showed a checkpoint for @${sender.handle}. Sending is halted for that account and nothing was retried. Open the account by hand before doing anything else.`,
    }
  }

  // Everything else: leave the draft intact so it can be retried or sent by hand.
  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'READY', error } })
  await audit('attempt.send.failed', `OutreachAttempt:${attemptId}`, error)
  revalidatePath('/')
  return { ok: false, message: error }
}

/**
 * Confirm a message was sent by hand. Still needed: if you send from your phone, or
 * the automated path fails and you finish it yourself, the record has to catch up
 * or the agent will prepare a duplicate.
 */
export async function markSent(attemptId: string) {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  if (attempt.status === 'SENT') return

  await prisma.$transaction([
    prisma.outreachAttempt.update({
      where: { id: attemptId },
      data: { status: 'SENT', sentAt: new Date(), sentBy: env.OPERATOR_NAME },
    }),
    prisma.messageVariant.update({
      where: { id: attempt.variantId },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    }),
  ])
  await audit(
    'attempt.sent',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}`,
  )
  revalidatePath('/')
}

/**
 * The autopilot toggle.
 *
 * Turning it ON means: at each slot, any armed account with a logged-in Chrome
 * profile sends its permitted message by itself, with no human present.
 *
 * `AUTOPILOT_ENABLED` in `.env` is a hard floor and is checked here rather than
 * only in the reader. A dashboard is a web page: anyone who can reach it can call
 * this action. The environment variable is the boundary a page cannot cross.
 */
export async function setAutopilot(on: boolean): Promise<{ ok: boolean; message: string }> {
  if (on && !env.AUTOPILOT_ENABLED) {
    return {
      ok: false,
      message:
        'Autopilot is disabled for this deployment. Set AUTOPILOT_ENABLED=true in .env and restart — that switch is deliberately not changeable from this page.',
    }
  }
  await setSetting(SETTING_KEYS.autopilotEnabled, on ? 'true' : 'false')
  await audit('autopilot.set', 'Setting:autopilotEnabled', on ? 'ON' : 'OFF')
  revalidatePath('/')
  return {
    ok: true,
    message: on ? 'Autopilot on — armed accounts will send at each slot.' : 'Autopilot off — messages will wait for you.',
  }
}

/**
 * Arm or disarm one account for unattended sending.
 *
 * Per-account rather than global-only because these three accounts are not
 * interchangeable and should graduate one at a time: prove it on one, watch it,
 * then arm the next. A single global switch would move all three at once, which is
 * exactly the change nobody should be able to make casually.
 */
export async function setAccountAutopilot(handle: string, on: boolean): Promise<{ ok: boolean; message: string }> {
  const sender = await prisma.senderAccount.findUniqueOrThrow({ where: { handle } })

  if (on && !profileStatus(handle).initialised) {
    return { ok: false, message: `@${handle} needs its one-time login first:  pnpm ig:login ${handle}` }
  }
  if (on && sender.status !== 'ACTIVE') {
    return { ok: false, message: `@${handle} is ${sender.status} — clear that before arming it` }
  }

  await prisma.senderAccount.update({ where: { handle }, data: { autoSendEnabled: on } })
  await audit('sender.autopilot.set', `SenderAccount:${handle}`, on ? 'ARMED' : 'DISARMED')
  revalidatePath('/')
  return { ok: true, message: on ? `@${handle} will send by itself.` : `@${handle} will wait for you.` }
}

/** Discard a queued message without sending. Does not start the cooldown. */
export async function skipAttempt(attemptId: string, reason: string) {
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'SKIPPED', error: reason || 'skipped by operator' },
  })
  await audit('attempt.skipped', `OutreachAttempt:${attemptId}`, reason)
  revalidatePath('/')
}
