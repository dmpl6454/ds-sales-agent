'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { setSetting, SETTING_KEYS } from '@/lib/settings'
import { runSlot } from '@/worker/runSlot'

/**
 * Server actions for the dashboard.
 *
 * Every state change writes an AuditLog row. In manual mode a human decides what
 * actually gets sent, so "who marked this sent, and when" has to be answerable
 * later without guesswork.
 */

async function audit(action: string, entity: string, detail?: string) {
  await prisma.auditLog.create({
    data: { actor: env.OPERATOR_NAME, action, entity, detail: detail ?? null },
  })
}

function refresh() {
  revalidatePath('/', 'layout')
}

/** Run a slot immediately. Takes ~15s: two profile renders plus enrichment. */
export async function syncNow() {
  const result = await runSlot('manual')
  await audit('sync.now', 'ScrapeRun', `status=${result.status} detected=${result.detected}`)
  refresh()
  return result
}

/**
 * Confirm a message was sent by hand. This is the manual-mode commit point: it
 * starts the cooldown, so it must reflect reality — only tap it after the DM has
 * actually gone out.
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
  refresh()
}

/** Discard a queued message without sending. Does not start the cooldown. */
export async function skipAttempt(attemptId: string, reason: string) {
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'SKIPPED', error: reason || 'skipped by operator' },
  })
  await audit('attempt.skipped', `OutreachAttempt:${attemptId}`, reason)
  refresh()
}

/**
 * Record that a target replied. This halts EVERY sender to that target — the
 * governor checks replies across the whole target, not per pair, because three
 * accounts continuing to pitch someone mid-conversation is the worst outcome
 * available.
 */
export async function markReplied(attemptId: string) {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { target: true } } },
  })
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'REPLIED', repliedAt: new Date() },
  })
  await audit(
    'attempt.replied',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.target.handle} replied — all senders to this target now halted`,
  )
  refresh()
}

export async function setSenderStatus(senderId: string, status: 'ACTIVE' | 'PAUSED') {
  await prisma.senderAccount.update({ where: { id: senderId }, data: { status } })
  await audit('sender.status', `SenderAccount:${senderId}`, status)
  refresh()
}

/** Per-sender autopilot. Still gated by the global AUTOPILOT_ENABLED env flag. */
export async function setSenderAutoSend(senderId: string, enabled: boolean) {
  await prisma.senderAccount.update({ where: { id: senderId }, data: { autoSendEnabled: enabled } })
  await audit('sender.autoSend', `SenderAccount:${senderId}`, String(enabled))
  refresh()
}

export async function updateSenderPersona(senderId: string, form: FormData) {
  const data = {
    handle: String(form.get('handle') ?? '').trim(),
    displayName: String(form.get('displayName') ?? '').trim(),
    personaName: String(form.get('personaName') ?? '').trim(),
    personaRole: String(form.get('personaRole') ?? '').trim(),
    personaBrand: String(form.get('personaBrand') ?? '').trim(),
    personaPhone: String(form.get('personaPhone') ?? '').trim(),
    personaEmail: String(form.get('personaEmail') ?? '').trim(),
    dailyCap: Number(form.get('dailyCap') ?? 5),
  }
  await prisma.senderAccount.update({ where: { id: senderId }, data })
  await audit('sender.updated', `SenderAccount:${senderId}`, JSON.stringify(data))
  refresh()
}

export async function updateTarget(targetId: string, form: FormData) {
  const contactFirstName = String(form.get('contactFirstName') ?? '').trim()
  const data = {
    displayName: String(form.get('displayName') ?? '').trim(),
    contactFirstName: contactFirstName === '' ? null : contactFirstName,
    optedOut: form.get('optedOut') === 'on',
  }
  await prisma.targetAccount.update({ where: { id: targetId }, data })
  await audit('target.updated', `TargetAccount:${targetId}`, JSON.stringify(data))
  refresh()
}

export async function setPairCooldown(pairId: string, cooldownDays: number) {
  await prisma.outreachPair.update({ where: { id: pairId }, data: { cooldownDays } })
  await audit('pair.cooldown', `OutreachPair:${pairId}`, String(cooldownDays))
  refresh()
}

export async function setPairEnabled(pairId: string, enabled: boolean) {
  await prisma.outreachPair.update({ where: { id: pairId }, data: { enabled } })
  await audit('pair.enabled', `OutreachPair:${pairId}`, String(enabled))
  refresh()
}

/**
 * Answer a REVIEW-queue item. The label is stored on the campaign AND in
 * RuleFeedback, so detector precision can be measured over time rather than
 * assumed.
 */
export async function labelCampaign(campaignId: string, wasActuallyPaid: boolean) {
  await prisma.$transaction([
    prisma.detectedCampaign.update({
      where: { id: campaignId },
      data: {
        humanLabel: wasActuallyPaid,
        labelledBy: env.OPERATOR_NAME,
        labelledAt: new Date(),
        verdict: wasActuallyPaid ? 'CAMPAIGN' : 'ORGANIC',
      },
    }),
    prisma.ruleFeedback.create({
      data: { campaignId, wasActuallyPaid, labelledBy: env.OPERATOR_NAME },
    }),
  ])
  await audit('campaign.labelled', `DetectedCampaign:${campaignId}`, String(wasActuallyPaid))
  refresh()
}

export async function updateSettings(form: FormData) {
  const entries: [string, string][] = [
    [SETTING_KEYS.defaultCooldownDays, String(form.get('defaultCooldownDays') ?? '')],
    [SETTING_KEYS.maxPerTargetPerDay, String(form.get('maxPerTargetPerDay') ?? '')],
    [SETTING_KEYS.hookMaxAgeHours, String(form.get('hookMaxAgeHours') ?? '')],
    [SETTING_KEYS.autopilotEnabled, form.get('autopilotEnabled') === 'on' ? 'true' : 'false'],
  ]
  for (const [key, value] of entries) {
    if (value !== '') await setSetting(key, value)
  }
  await audit('settings.updated', 'Setting', JSON.stringify(Object.fromEntries(entries)))
  refresh()
}
