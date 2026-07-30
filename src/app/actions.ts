'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { runSlot } from '@/worker/runSlot'

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

/**
 * Confirm a message was sent by hand — only relevant before automatic sending is
 * switched on. This is the commit point that starts the cooldown, so it must
 * follow the real send rather than replace it.
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

/** Discard a queued message without sending. Does not start the cooldown. */
export async function skipAttempt(attemptId: string, reason: string) {
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'SKIPPED', error: reason || 'skipped by operator' },
  })
  await audit('attempt.skipped', `OutreachAttempt:${attemptId}`, reason)
  revalidatePath('/')
}
