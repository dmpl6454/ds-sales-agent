import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { hoursAgo, istDayStart } from '@/lib/time'
import { evaluatePair, type GovernorDecision } from './governor'
import { renderMessage, validatePersona } from './render'
import { manualAssistSender } from './senders/manual'
import type { SendOutcome } from './senders/types'

/**
 * The outreach half of one slot: for every routing pair, ask the governor whether
 * it may be contacted, and if so build and dispatch the message.
 *
 * Detection is intentionally NOT a precondition. If the classifier breaks or the
 * channel simply had a quiet day, outreach still runs with an empty hook line. A
 * monitoring subsystem must never be able to silence the thing it monitors —
 * "sends nothing, reports nothing wrong" is the failure mode that actually costs
 * money.
 */

export interface PlanOutcome {
  pairKey: string
  eligible: boolean
  skipReason?: string
  skipDetail?: string
  attemptId?: string
  status?: string
  hookLine?: string | null
  error?: string
}

export interface PlanSummary {
  outcomes: PlanOutcome[]
  queued: number
  sent: number
  failed: number
  skipped: number
}

export async function runOutreach(): Promise<PlanSummary> {
  const settings = await getSettings()
  const now = new Date()
  const dayStart = istDayStart(now)

  const pairs = await prisma.outreachPair.findMany({
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })

  // Lifetime in-flight count: delivered, replied, OR prepared and waiting. Counting
  // the waiting ones is what makes MAX_TOTAL_SENDS=1 mean "one message exists",
  // rather than "one message was delivered while three more sat queued".
  // Incremented locally below so the ceiling also holds within a single slot.
  let totalSentEver = await prisma.outreachAttempt.count({
    where: { status: { in: ['SENT', 'REPLIED', 'READY', 'QUEUED'] } },
  })
  if (env.MAX_TOTAL_SENDS !== null && totalSentEver >= env.MAX_TOTAL_SENDS) {
    log.warn('lifetime send ceiling reached — sending nothing', {
      sent: totalSentEver,
      ceiling: env.MAX_TOTAL_SENDS,
      raiseWith: 'MAX_TOTAL_SENDS in .env',
    })
  }

  const outcomes: PlanOutcome[] = []

  // Counters accumulate WITHIN this run as well as from the DB, so two pairs
  // sharing a target in the same slot cannot both slip past the daily cap.
  const sentToTargetToday = new Map<string, number>()
  const sentBySenderToday = new Map<string, number>()

  for (const pair of pairs) {
    const pairKey = `${pair.sender.handle}→${pair.target.handle}`

    const [lastSent, touches, replied, targetToday, senderToday, pending] = await Promise.all([
      prisma.outreachAttempt.findFirst({
        where: { pairId: pair.id, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      }),
      prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: ['SENT', 'REPLIED'] } } }),
      prisma.outreachAttempt.findFirst({
        where: { pair: { targetId: pair.targetId }, repliedAt: { not: null } },
        orderBy: { repliedAt: 'desc' },
        select: { repliedAt: true },
      }),
      prisma.outreachAttempt.count({
        where: { pair: { targetId: pair.targetId }, status: 'SENT', sentAt: { gte: dayStart } },
      }),
      prisma.outreachAttempt.count({
        where: { pair: { senderId: pair.senderId }, status: 'SENT', sentAt: { gte: dayStart } },
      }),
      prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: ['QUEUED', 'READY'] } } }),
    ])

    const decision: GovernorDecision = evaluatePair({
      now,
      pair: { enabled: pair.enabled },
      sender: { status: pair.sender.status, dailyCap: pair.sender.dailyCap },
      target: { optedOut: pair.target.optedOut },
      lastSentAt: lastSent?.sentAt ?? null,
      touchesSoFar: touches,
      targetRepliedAt: replied?.repliedAt ?? null,
      targetSentTodayCount: targetToday + (sentToTargetToday.get(pair.targetId) ?? 0),
      senderSentTodayCount: senderToday + (sentBySenderToday.get(pair.senderId) ?? 0),
      maxPerTargetPerDay: settings.maxPerTargetPerDay,
      hasPendingAttempt: pending > 0,
      totalSentEver,
      maxTotalSends: env.MAX_TOTAL_SENDS,
    })

    if (!decision.eligible) {
      outcomes.push({ pairKey, eligible: false, skipReason: decision.reason, skipDetail: decision.detail })
      continue
    }

    // A malformed persona would be reproduced in every message this sender ever
    // sends, so it blocks the send rather than producing a flawed one.
    const personaProblems = validatePersona(pair.sender)
    if (personaProblems.length > 0) {
      log.alarm('sender persona is invalid — refusing to send', {
        sender: pair.sender.handle,
        problems: personaProblems,
      })
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: 'invalid-persona',
        skipDetail: personaProblems.join('; '),
      })
      continue
    }

    try {
      const result = await createAndDispatch({
        pair,
        touchNumber: decision.touchNumber,
        hookMaxAgeHours: settings.hookMaxAgeHours,
      })
      outcomes.push({ pairKey, eligible: true, ...result })

      // Any attempt that now exists counts against the ceiling, whether it was
      // delivered or is waiting for a human.
      if (result.status === 'SENT' || result.status === 'READY' || result.status === 'QUEUED') {
        totalSentEver += 1
      }
      if (result.status === 'SENT') {
        sentToTargetToday.set(pair.targetId, (sentToTargetToday.get(pair.targetId) ?? 0) + 1)
        sentBySenderToday.set(pair.senderId, (sentBySenderToday.get(pair.senderId) ?? 0) + 1)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('outreach failed', { pair: pairKey, error: message })
      outcomes.push({ pairKey, eligible: true, error: message })
    }
  }

  const summary: PlanSummary = {
    outcomes,
    queued: outcomes.filter((o) => o.status === 'READY' || o.status === 'QUEUED').length,
    sent: outcomes.filter((o) => o.status === 'SENT').length,
    failed: outcomes.filter((o) => o.status === 'FAILED' || o.error).length,
    skipped: outcomes.filter((o) => !o.eligible).length,
  }

  log.info('outreach summary', {
    queued: summary.queued,
    sent: summary.sent,
    failed: summary.failed,
    skipped: summary.skipped,
    dryRun: env.DRY_RUN,
  })

  return summary
}

type PairWithRelations = Awaited<ReturnType<typeof prisma.outreachPair.findMany>> extends (infer T)[] ? T : never

async function createAndDispatch(args: {
  pair: Awaited<ReturnType<typeof prisma.outreachPair.findFirstOrThrow>> & {
    sender: Awaited<ReturnType<typeof prisma.senderAccount.findFirstOrThrow>>
    target: Awaited<ReturnType<typeof prisma.targetAccount.findFirstOrThrow>>
  }
  touchNumber: number
  hookMaxAgeHours: number
}): Promise<Omit<PlanOutcome, 'pairKey' | 'eligible'>> {
  const { pair, touchNumber, hookMaxAgeHours } = args

  // Freshest usable hook. Ordered by postedAt then gridIndex because
  // og:description gives day precision only — see detection/types.ts.
  const hook = await prisma.detectedCampaign.findFirst({
    where: {
      targetId: pair.targetId,
      verdict: 'CAMPAIGN',
      postedAt: { gte: hoursAgo(hookMaxAgeHours) },
    },
    orderBy: [{ postedAt: 'desc' }, { detectedAt: 'desc' }],
  })

  // Least-recently-used variant. `nulls first` so never-used ones go first.
  const variant = await prisma.messageVariant.findFirst({
    where: { senderId: pair.senderId, enabled: true },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { timesUsed: 'asc' }],
  })
  if (!variant) {
    throw new Error(`sender @${pair.sender.handle} has no enabled message variants — run: pnpm db:seed`)
  }

  // A message written for this specific recipient beats a rotated variant every
  // time — see prisma/bespoke.ts for why that is a safety property, not a nicety.
  // The variant is still recorded so rotation stats stay meaningful if we fall back.
  const usingBespoke = Boolean(pair.bespokeBody && pair.bespokeBody.trim().length > 0)
  const { body, hookLine } = renderMessage({
    persona: pair.sender,
    target: pair.target,
    variantBody: usingBespoke ? pair.bespokeBody! : variant.body,
    // A bespoke draft already references the recipient's actual work, so bolting a
    // generated hook line on top would read as two openings stapled together.
    hook: usingBespoke ? null : hook,
  })

  const attempt = await prisma.outreachAttempt.create({
    data: {
      pairId: pair.id,
      campaignId: hook?.id ?? null,
      variantId: variant.id,
      touchNumber,
      hookLine,
      renderedBody: body,
      status: 'QUEUED',
    },
  })

  // DRY_RUN stops here: the attempt exists and is auditable, but is never
  // surfaced for sending and never delivered.
  if (env.DRY_RUN) {
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SKIPPED', error: 'DRY_RUN' },
    })
    log.step('DRY_RUN — would have queued', {
      sender: pair.sender.handle,
      target: pair.target.handle,
      hook: hookLine ?? '(none)',
    })
    return { attemptId: attempt.id, status: 'SKIPPED', hookLine }
  }

  // There is only one sender now. The browser-driving path was removed after
  // research established that cookie-replay into a fresh profile is the highest-risk
  // option available, and that automating the click saves ~90 seconds a day while
  // putting the accounts on the table. The agent prepares; a human clicks.
  const outcome: SendOutcome = await manualAssistSender.send({
    attemptId: attempt.id,
    senderHandle: pair.sender.handle,
    sessionPath: pair.sender.sessionPath,
    targetHandle: pair.target.handle,
    body,
  })

  await applyOutcome(attempt.id, variant.id, pair.senderId, outcome)
  return { attemptId: attempt.id, status: outcome.status, hookLine }
}

async function applyOutcome(
  attemptId: string,
  variantId: string,
  senderId: string,
  outcome: SendOutcome,
): Promise<void> {
  if (outcome.status === 'SENT') {
    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: attemptId },
        data: { status: 'SENT', sentAt: new Date(), sentBy: 'auto', threadUrl: outcome.threadUrl },
      }),
      prisma.messageVariant.update({
        where: { id: variantId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      }),
    ])
    return
  }

  if (outcome.status === 'READY') {
    await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'READY' } })
    return
  }

  // FAILED. A challenge pauses the sender so nothing else touches it until a
  // human has looked. Retrying into a challenge is how accounts get banned.
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'FAILED', error: outcome.error },
  })
  if (outcome.challenged) {
    await prisma.senderAccount.update({ where: { id: senderId }, data: { status: 'CHALLENGED' } })
    await prisma.auditLog.create({
      data: {
        actor: 'worker',
        action: 'sender.challenged',
        entity: `SenderAccount:${senderId}`,
        detail: outcome.error,
      },
    })
  }
}

export type { PairWithRelations }
