/**
 * REFERENCE COPY OF 26e230d — DO NOT EDIT. Oracle for tests/facts-equivalence (Stage 3).
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * A frozen transcription of how `runOutreach` (src/outreach/plan.ts, lines ~200–700 at 26e230d)
 * assembles the per-pair `GovernorInput`, and how `recheckBeforeSend` (src/outreach/gate.ts,
 * lines ~814–939) assembles the `ResendInput`. The queries are copied verbatim — same `where`,
 * same `select`, same ordering — and the shared helpers are CALLED, not re-implemented:
 * `freshCampaignsFor`, `campaignsNamingHandle`, `replyHaltWhere`, `splitParks`,
 * `crossSpacingVerdict`, `materialAllowance`, `templateForSettings`, `followUpForSettings`,
 * `followUpSubject`, `isFollowUp`, `isIntroductionToSomeoneWhoKnowsUs`, `citesOnlyADate`,
 * `isStandardMessageBody`, `sessionUsable`, `mayArmAccount`.
 *
 * Stage 3 replaces those per-pair reads with one bulk loader. The proof that the loader is
 * equivalent is that, for every pair in a scenario, its facts deep-equal what THIS file
 * assembles — and this file must therefore never be "improved" along with the production
 * code. It is a photograph of the old shape. When the production code moves, this stays.
 *
 * ── HOW TO USE IT ──────────────────────────────────────────────────────────
 *
 * Import it DYNAMICALLY, after `openOutreachDb` has pointed the process at a database: it
 * imports `@/lib/db`, which binds the client at import time (see tests/helpers/outreach-db.ts).
 *
 *   legacyRunContext(prisma, settings, now, pairs)   the run-level preloads (memberships, the
 *                                                     eligible fleet, ever-replied recipients,
 *                                                     delivered bodies, post subjects, watch
 *                                                     channels, person verdicts, the ceiling)
 *   legacyPairFacts(prisma, pair, settings, now, ctx) the per-pair Promise.all + assembly;
 *                                                     builds a context itself when none is given
 *   legacySendFacts(attempt, opts, witness)           the gate's Promise.all + assembly
 *
 * `tests/planner-golden.test.ts` runs both on its scenario so the oracle cannot rot silently:
 * a renamed column or a changed helper signature fails there, not in Stage 3.
 */

import type { PrismaClient } from '@/generated/prisma/client'
import type { RuntimeSettings } from '@/lib/settings'
import type { GovernorInput } from '@/outreach/governor'
import type { ResendInput, ResendAttempt, QueueWitness } from '@/outreach/gate'
import { prisma as sharedPrisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { istDayStart } from '@/lib/time'
import { newMaterialFloor } from '@/lib/cutoff'
import { readStringArray } from '@/lib/json'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { profileGoneFloor, splitParks } from '@/outreach/parkedRows'
import { replyHaltWhere } from '@/outreach/replyHalt'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { materialAllowance, campaignsNamingHandle } from '@/outreach/materialAllowance'
import { eligibleFleetSenders } from '@/outreach/availability'
import { readCategoryMemberships, categoriesFor } from '@/outreach/categories'
import { freshCampaignsFor, readPersonHandles, readWatchChannels } from '@/outreach/compose'
import { isStandardMessageBody, templateForSettings, type FleetTemplate } from '@/outreach/fleetTemplate'
import {
  citesOnlyADate,
  followUpForSettings,
  followUpPostReference,
  followUpSubject,
  isFollowUp,
  isIntroductionToSomeoneWhoKnowsUs,
  renderFollowUp,
  type FollowUpTemplate,
} from '@/outreach/followUpTemplate'
import { mayArmAccount } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'
import type { CategoryMemberships } from '@/outreach/senderCategories'

/** The pair shape the planner iterates: `outreachPair.findMany({ include: { sender, target } })`. */
export interface LegacyPair {
  id: string
  senderId: string
  targetId: string
  sender: { id: string; handle: string; status: string; cohort: number }
  target: { id: string; handle: string; displayName: string; optedOut: boolean; isVerified: boolean | null }
}

export interface LegacyRunContext {
  totalSentEver: number
  memberships: CategoryMemberships
  eligibleFleet: { id: string; handle: string }[]
  everRepliedTargetIds: Set<string>
  deliveredBodiesByPair: Map<string, string[]>
  campaignSubjectById: Map<string, { brands: string; publisher: { handle: string; displayName: string | null } }>
  watchChannels: { handle: string; displayName: string | null }[]
  personHandles: Set<string>
}

/** plan.ts lines ~200–466: everything read ONCE per run before the per-pair loop. */
export async function legacyRunContext(
  prisma: PrismaClient,
  _settings: RuntimeSettings,
  now: Date,
  pairs: readonly LegacyPair[],
): Promise<LegacyRunContext> {
  const totalSentEver = await prisma.outreachAttempt.count({
    where: { status: { in: [...IN_FLIGHT_STATUSES] } },
  })

  const watchChannels = await readWatchChannels()
  const personHandles = await readPersonHandles(pairs.map((p) => p.target.handle))

  const everRepliedTargetIds = new Set(
    (
      await prisma.outreachAttempt.findMany({
        where: { targetId: { in: [...new Set(pairs.map((p) => p.targetId))] }, replyPostedAt: { not: null } },
        select: { targetId: true },
        distinct: ['targetId'],
      })
    ).map((r) => r.targetId),
  )

  const memberships = await readCategoryMemberships()
  const eligibleFleet = await eligibleFleetSenders()

  const deliveredBodiesByPair = new Map<string, string[]>()
  for (const row of await prisma.outreachAttempt.findMany({
    where: { status: { in: [...DELIVERED_STATUSES] } },
    select: { pairId: true, renderedBody: true },
  })) {
    const list = deliveredBodiesByPair.get(row.pairId)
    if (list) list.push(row.renderedBody.trim())
    else deliveredBodiesByPair.set(row.pairId, [row.renderedBody.trim()])
  }

  const campaignSubjectById = new Map<string, { brands: string; publisher: { handle: string; displayName: string | null } }>(
    (
      await prisma.detectedCampaign.findMany({
        where: { verdict: 'CAMPAIGN', postedAt: { gte: newMaterialFloor(now) } },
        select: { id: true, brands: true, target: { select: { handle: true, displayName: true } } },
      })
    ).map((c) => [c.id, { brands: c.brands, publisher: c.target }]),
  )

  return {
    totalSentEver,
    memberships,
    eligibleFleet,
    everRepliedTargetIds,
    deliveredBodiesByPair,
    campaignSubjectById,
    watchChannels,
    personHandles,
  }
}

/** plan.ts lines ~484–700: the per-pair Promise.all and the GovernorInput it assembles. */
export async function legacyPairFacts(
  prisma: PrismaClient,
  pair: LegacyPair,
  settings: RuntimeSettings,
  now: Date,
  ctx?: LegacyRunContext,
): Promise<GovernorInput> {
  const c = ctx ?? (await legacyRunContext(prisma, settings, now, [pair]))
  const dayStart = istDayStart(now)
  const { memberships } = c

  const fleetTemplateFor = (p: { sender: { handle: string }; target: { handle: string } }) =>
    templateForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, p.sender.handle),
      categoriesFor(memberships.byTargetHandle, p.target.handle),
    )
  const followUpTemplateFor = (p: { sender: { handle: string }; target: { handle: string } }): FollowUpTemplate =>
    followUpForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, p.sender.handle),
      categoriesFor(memberships.byTargetHandle, p.target.handle),
    )

  const windowFloor = new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000)
  const [touches, replied, pairToday, ringDeliveries, pending, parked, freshCampaigns, targetCampaigns, targetDelivered] =
    await Promise.all([
      prisma.outreachAttempt.count({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
      }),
      prisma.outreachAttempt.findFirst({
        where: replyHaltWhere({
          scope: settings.replyHaltScope,
          senderId: pair.senderId,
          targetId: pair.targetId,
          resumeHours: settings.replyResumeHours,
          now,
        }),
        orderBy: { repliedAt: 'desc' },
        select: { repliedAt: true },
      }),
      prisma.outreachAttempt.count({
        where: {
          pairId: pair.id,
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: dayStart },
        },
      }),
      prisma.outreachAttempt.findMany({
        where: {
          pair: { targetId: pair.targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000) },
        },
        orderBy: { sentAt: 'asc' },
        select: { sentAt: true, pair: { select: { senderId: true, sender: { select: { handle: true } } } } },
      }),
      prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: ['QUEUED', 'READY', 'SENDING'] } } }),
      prisma.outreachAttempt.findMany({
        where: {
          pair: { targetId: pair.targetId },
          status: 'FAILED',
          failureCode: { not: null, notIn: ['unreadable'] },
          OR: [{ pairId: pair.id }, { failureCode: 'profile-gone', queuedAt: { gte: profileGoneFloor(now) } }],
        },
        select: { failureCode: true, queuedAt: true, pair: { select: { senderId: true } } },
      }),
      freshCampaignsFor({ target: pair.target, targetId: pair.targetId, pairId: pair.id, now }),
      campaignsNamingHandle(prisma, { handle: pair.target.handle, displayName: pair.target.displayName }, windowFloor),
      prisma.outreachAttempt.count({
        where: {
          pair: { targetId: pair.targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: windowFloor },
        },
      }),
    ])

  const describableCampaigns = [...freshCampaigns]
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .flatMap((camp) => {
      const about = c.campaignSubjectById.get(camp.id)
      const subject = about
        ? followUpSubject(
            readStringArray(about.brands),
            about.publisher,
            {
              handle: pair.target.handle,
              displayName: pair.target.displayName,
              isPerson: c.personHandles.has(pair.target.handle),
            },
            c.watchChannels,
          )
        : null
      return subject === null ? [] : [{ id: camp.id, postedAt: camp.postedAt, subject }]
    })

  return {
    now,
    sender: { status: pair.sender.status },
    target: { optedOut: pair.target.optedOut, isVerified: pair.target.isVerified },
    touchesSoFar: touches,
    targetHasEverReplied: c.everRepliedTargetIds.has(pair.targetId),
    targetRepliedAt: replied?.repliedAt ?? null,
    pairSentTodayCount: pairToday,
    maxPerPairPerDay: settings.maxPerPairPerDay,
    crossSpacing: crossSpacingVerdict({
      now,
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: pair.senderId,
      eligibleSenders: c.eligibleFleet,
      targetHandle: pair.target.handle,
      memberships,
      lastDeliveryBySender: new Map(
        ringDeliveries
          .filter((r) => r.sentAt !== null)
          .map((r) => [r.pair.senderId, { sentAt: r.sentAt!, handle: r.pair.sender.handle }]),
      ),
    }),
    hasPendingAttempt: pending > 0,
    ...splitParks(parked, pair.senderId, now),
    material: materialAllowance({ campaignsInWindow: targetCampaigns, deliveredInWindow: targetDelivered }),
    unusedCampaignCount: freshCampaigns.length,
    describableCampaignCount: describableCampaigns.length,
    totalSentEver: c.totalSentEver,
    maxTotalSends: env.MAX_TOTAL_SENDS,
    fleetTemplate: fleetTemplateFor(pair),
    followUpTemplate: followUpTemplateFor(pair),
    repeatsADeliveredBody: (() => {
      if (!settings.singleTemplate) return false
      const delivered = c.deliveredBodiesByPair.get(pair.id) ?? []
      if (delivered.length === 0) return false

      if (touches > 0) {
        const f = followUpTemplateFor(pair)
        if (!f.ok) return false
        const newest = describableCampaigns[0]
        if (!newest) return false
        return delivered.includes(
          renderFollowUp(f.body, followUpPostReference({ postedAt: newest.postedAt, subject: newest.subject })).trim(),
        )
      }

      const t: FleetTemplate = fleetTemplateFor(pair)
      if (!t.ok) return false
      return delivered.includes(t.body.trim())
    })(),
  }
}

/** gate.ts lines ~814–939: `recheckBeforeSend`'s Promise.all and the ResendInput it assembles. */
export async function legacySendFacts(
  attempt: ResendAttempt,
  opts: { unattended: boolean; overrides?: readonly string[] },
  witness: QueueWitness = { kind: 'this-disk' },
): Promise<ResendInput> {
  const prisma = sharedPrisma
  const settings = await getSettings()
  const dayStart = istDayStart()
  const { sender, target, senderId, targetId } = attempt.pair

  const materialWindowFloor = new Date(Date.now() - settings.defaultCooldownDays * 86_400_000)
  const [replied, pairToday, ringDeliveries, eligibleFleet, ladder, senderRow, parked, targetCampaigns, targetDelivered, memberships, thisDraft, deliveredRows, everRepliedCount] =
    await Promise.all([
      prisma.outreachAttempt.findFirst({
        where: replyHaltWhere({
          scope: settings.replyHaltScope,
          senderId,
          targetId,
          resumeHours: settings.replyResumeHours,
        }),
        orderBy: { repliedAt: 'desc' },
        select: { replyPostedAt: true },
      }),
      prisma.outreachAttempt.count({
        where: { pair: { senderId, targetId }, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } },
      }),
      prisma.outreachAttempt.findMany({
        where: {
          pair: { targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: new Date(Date.now() - settings.defaultCooldownDays * 24 * 60 * 60 * 1000) },
        },
        orderBy: { sentAt: 'asc' },
        select: { sentAt: true, pair: { select: { senderId: true, sender: { select: { handle: true } } } } },
      }),
      eligibleFleetSenders(),
      opts.unattended ? mayArmAccount(sender.handle) : Promise.resolve({ ok: true as const, reason: 'baseline' as const }),
      prisma.senderAccount.findUnique({
        where: { id: senderId },
        select: { sessionInvalidAt: true },
      }),
      prisma.outreachAttempt.findMany({
        where: {
          pair: { targetId },
          status: 'FAILED',
          failureCode: { not: null, notIn: ['unreadable'] },
          id: { not: attempt.id },
          OR: [{ pair: { senderId } }, { failureCode: 'profile-gone', queuedAt: { gte: profileGoneFloor(new Date()) } }],
        },
        select: { failureCode: true, queuedAt: true, pair: { select: { senderId: true } } },
      }),
      campaignsNamingHandle(prisma, { handle: target.handle, displayName: target.displayName }, materialWindowFloor),
      prisma.outreachAttempt.count({
        where: {
          pair: { targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: materialWindowFloor },
          id: { not: attempt.id },
        },
      }),
      readCategoryMemberships(),
      prisma.outreachAttempt.findUnique({ where: { id: attempt.id }, select: { renderedBody: true, touchNumber: true } }),
      prisma.outreachAttempt.findMany({
        where: { senderId, targetId, status: { in: [...DELIVERED_STATUSES] }, id: { not: attempt.id } },
        select: { renderedBody: true },
      }),
      prisma.outreachAttempt.count({ where: { targetId, replyPostedAt: { not: null } } }),
    ])

  const targetEverReplied = everRepliedCount > 0
  const deliveredBodies = deliveredRows.map((r) => r.renderedBody.trim())
  const thisBody = thisDraft?.renderedBody.trim() ?? null

  return {
    attemptStatus: attempt.status,
    unattended: opts.unattended,
    senderStatus: sender.status,
    senderCohortCleared: ladder.ok,
    senderCohortDetail: ladder.ok ? undefined : ladder.detail,
    ...splitParks(parked, senderId, new Date()),
    material: materialAllowance({ campaignsInWindow: targetCampaigns, deliveredInWindow: targetDelivered }),
    senderHasSession: sessionUsable({
      hasSessionOnDisk:
        witness.kind === 'this-disk' ? profileStatus(sender.handle).hasSession : witness.handles.includes(sender.handle),
      sessionInvalidAt: senderRow?.sessionInvalidAt ?? null,
    }),
    targetOptedOut: target.optedOut,
    targetIsWatchOnly: target.role === 'WATCH',
    senderCategories: categoriesFor(memberships.bySenderHandle, sender.handle),
    targetCategories: categoriesFor(memberships.byTargetHandle, target.handle),
    fleetTemplate: templateForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, sender.handle),
      categoriesFor(memberships.byTargetHandle, target.handle),
    ),
    isFollowUp: isFollowUp({
      touchesSoFar: (thisDraft?.touchNumber ?? 1) - 1,
      targetHasEverReplied: targetEverReplied,
    }),
    introducesUsToSomeoneWhoKnowsUs: isIntroductionToSomeoneWhoKnowsUs({
      storedBodyIsStandardMessage: thisBody !== null && isStandardMessageBody(thisBody, settings),
      storedTouchNumber: thisDraft?.touchNumber ?? 1,
      pairHasDelivered: deliveredRows.length > 0,
      targetHasEverReplied: targetEverReplied,
    }),
    followUpTemplate: followUpForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, sender.handle),
      categoriesFor(memberships.byTargetHandle, target.handle),
    ),
    repeatsADeliveredBody: thisBody !== null && deliveredBodies.includes(thisBody),
    followUpCitesOnlyADate: thisBody !== null && citesOnlyADate(thisBody),
    targetIsVerified: target.isVerified,
    targetRepliedAt: replied?.replyPostedAt ?? null,
    pairSentTodayCount: pairToday,
    maxPerPairPerDay: settings.maxPerPairPerDay,
    crossSpacing: crossSpacingVerdict({
      now: new Date(),
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: senderId,
      eligibleSenders: eligibleFleet,
      targetHandle: target.handle,
      memberships,
      lastDeliveryBySender: new Map(
        ringDeliveries
          .filter((r) => r.sentAt !== null)
          .map((r) => [r.pair.senderId, { sentAt: r.sentAt!, handle: r.pair.sender.handle }]),
      ),
    }),
    overrides: opts.overrides,
  }
}
