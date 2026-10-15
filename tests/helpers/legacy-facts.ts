/**
 * REFERENCE COPY OF 26e230d — DO NOT EDIT. Oracle for tests/facts-equivalence (Stage 3).
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * A frozen transcription of how `runOutreach` (src/outreach/plan.ts, lines ~183–760 at 26e230d)
 * assembles the per-pair `GovernorInput`, and how `recheckBeforeSend` (src/outreach/gate.ts,
 * lines ~814–939) assembles the `ResendInput`.
 *
 * EVERY DATABASE READ IS INLINED HERE — the planner's and the gate's own `Promise.all` queries
 * AND the reads the production helpers they call make underneath: `usedCampaignIds`,
 * `claimedCampaignIds`, `campaignsNamingHandleRows` (the findMany and its JS filter),
 * `freshCampaignsFor`, `campaignsNamingHandle`, `replyHaltWhere`'s output shape,
 * `readCategoryMemberships`, `readSenderAvailability`, `eligibleFleetSenders`,
 * `readWatchChannels`, `readPersonHandles`, `readCohortStates`, `cohortSoakDays` and
 * `mayArmAccount`. Each copy carries the `file:line` it was taken from. The status sets they
 * filter on are frozen literals too, not the live constants.
 *
 * The first version imported those helpers and CALLED them, which made the oracle a photograph
 * of nothing: a Stage 3 bulk loader replaces exactly those reads, so an edit to any of them would
 * have moved the oracle along with production and the equivalence proof would have passed
 * trivially (the review's finding, 2026-10-15). What this file still calls are the PURE
 * assemblers — `splitParks`, `crossSpacingVerdict`, `materialAllowance`,
 * `mentionsHandleExactly`, `brandStringsNameProspect`, `categoriesFor`, `templateForSettings`,
 * `followUpForSettings`, `followUpSubject`, `isFollowUp`, `isIntroductionToSomeoneWhoKnowsUs`,
 * `citesOnlyADate`, `isStandardMessageBody`, `sessionUsable`, `mayArmCohort`, `renderFollowUp`,
 * `followUpPostReference` — which take facts and return verdicts, and are what Stage 2 pins
 * through `tests/rules-golden.test.ts`. Three things are deliberately live and are not reads a
 * loader replaces: `getSettings` (the configuration, parsed once per gate call as production
 * does), `profileStatus` (this machine's disk, mocked by the test), and the clock/floor
 * helpers (`istDayStart`, `newMaterialFloor`, `profileGoneFloor`).
 *
 * Stage 3 replaces the per-pair reads with one bulk loader. The proof that the loader is
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
 * The planner re-reads each pair AFTER the pairs before it have written, so a caller replaying a
 * run must put each written draft back before evaluating the next pair — see the oracle test in
 * `tests/planner-golden.test.ts`, which runs both functions on its scenario so the oracle cannot
 * rot silently: a renamed column or a changed helper signature fails there, not in Stage 3.
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
import { profileGoneFloor, splitParks } from '@/outreach/parkedRows'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { materialAllowance, mentionsHandleExactly, brandStringsNameProspect } from '@/outreach/materialAllowance'
import { categoriesFor } from '@/outreach/senderCategories'
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
import { mayArmCohort, DEFAULT_COHORT_SOAK_DAYS, type CohortMember, type CohortState, type LadderVerdict } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'
import type { CategoryMemberships } from '@/outreach/senderCategories'

// ── frozen constants ──────────────────────────────────────────────────────────

/** src/lib/constants.ts:61 at 26e230d — `DELIVERED_STATUSES`. */
const DELIVERED_STATUSES = ['SENT', 'REPLIED'] as const
/** src/lib/constants.ts:73 at 26e230d — `IN_FLIGHT_STATUSES`. */
const IN_FLIGHT_STATUSES = ['SENT', 'REPLIED', 'SENDING', 'READY', 'QUEUED'] as const

// ── frozen reads: the helpers production calls, copied verbatim ─────────────

/** src/outreach/compose.ts:94–100 at 26e230d — `usedCampaignIds`. */
async function legacyUsedCampaignIds(prisma: PrismaClient, pairId: string): Promise<string[]> {
  const rows = await prisma.outreachAttempt.findMany({
    where: { pairId, campaignId: { not: null }, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { campaignId: true },
  })
  return rows.map((r) => r.campaignId).filter((id): id is string => id !== null)
}

/** src/outreach/compose.ts:142–148 at 26e230d — `claimedCampaignIds`. */
async function legacyClaimedCampaignIds(prisma: PrismaClient, targetId: string): Promise<string[]> {
  const rows = await prisma.outreachAttempt.findMany({
    where: { targetId, campaignId: { not: null }, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { campaignId: true },
  })
  return rows.map((r) => r.campaignId).filter((id): id is string => id !== null)
}

/**
 * src/outreach/materialAllowance.ts:264–298 at 26e230d — `campaignsNamingHandleRows`: the
 * findMany with its three-armed OR, and the JS filter over the two PURE predicates.
 */
async function legacyCampaignsNamingHandleRows(
  prisma: PrismaClient,
  prospect: { handle: string; displayName?: string | null },
  windowFloor: Date,
): Promise<{ id: string; postedAt: Date }[]> {
  const handle = prospect.handle
  const candidates = await prisma.detectedCampaign.findMany({
    where: {
      verdict: 'CAMPAIGN',
      postedAt: { gte: windowFloor },
      OR: [
        { taggedAccounts: { contains: `"${handle}"` } },
        { caption: { contains: `@${handle}` } },
        { brands: { not: '[]' } },
      ],
    },
    select: { id: true, postedAt: true, caption: true, taggedAccounts: true, brands: true },
  })
  return candidates
    .filter((c) => mentionsHandleExactly(c, handle) || brandStringsNameProspect(c.brands, prospect))
    .map((c) => ({ id: c.id ?? '', postedAt: c.postedAt ?? new Date(0) }))
}

/** src/outreach/materialAllowance.ts:300–306 at 26e230d — `campaignsNamingHandle`. */
async function legacyCampaignsNamingHandle(
  prisma: PrismaClient,
  prospect: { handle: string; displayName?: string | null },
  windowFloor: Date,
): Promise<number> {
  return (await legacyCampaignsNamingHandleRows(prisma, prospect, windowFloor)).length
}

/** src/outreach/compose.ts:177–191 at 26e230d — `freshCampaignsFor`. */
async function legacyFreshCampaignsFor(
  prisma: PrismaClient,
  args: { target: { handle: string; displayName?: string | null }; targetId: string; pairId: string; now: Date },
): Promise<{ id: string; postedAt: Date }[]> {
  const [naming, usedByThisPair, claimedForRecipient] = await Promise.all([
    legacyCampaignsNamingHandleRows(prisma, args.target, newMaterialFloor(args.now)),
    legacyUsedCampaignIds(prisma, args.pairId),
    legacyClaimedCampaignIds(prisma, args.targetId),
  ])
  const spokenFor = new Set([...usedByThisPair, ...claimedForRecipient])
  return naming.filter((c) => !spokenFor.has(c.id))
}

/**
 * src/outreach/replyHalt.ts:45–47 (`replyHaltFloor`), 117–122 (`replyHaltPairFilter`) and
 * 129–141 (`replyHaltWhere`) at 26e230d — the whole `where` an enforcer asks, as one object.
 */
function legacyReplyHaltWhere(args: {
  scope: 'pair' | 'target'
  senderId: string
  targetId: string
  resumeHours: number
  now?: Date
}): {
  pair: { targetId: string; senderId?: string }
  replyPostedAt: { gte: Date }
  replyHandledAt: null
} {
  const now = args.now ?? new Date()
  return {
    pair: args.scope === 'pair' ? { senderId: args.senderId, targetId: args.targetId } : { targetId: args.targetId },
    replyPostedAt: { gte: new Date(now.getTime() - args.resumeHours * 60 * 60 * 1000) },
    replyHandledAt: null,
  }
}

/** src/outreach/categories.ts:636–662 at 26e230d — `readCategoryMemberships`, minus its `cache()` wrapper. */
async function legacyReadCategoryMemberships(prisma: PrismaClient): Promise<CategoryMemberships> {
  const [senderRows, targetRows] = await Promise.all([
    prisma.categorySender.findMany({
      where: { enabled: true },
      select: { category: { select: { slug: true } }, sender: { select: { handle: true } } },
    }),
    prisma.categoryTarget.findMany({
      where: { enabled: true },
      select: { category: { select: { slug: true } }, target: { select: { handle: true } } },
    }),
  ])
  const bySenderHandle = new Map<string, string[]>()
  for (const r of senderRows) {
    const k = r.sender.handle.toLowerCase()
    const list = bySenderHandle.get(k)
    if (list) list.push(r.category.slug)
    else bySenderHandle.set(k, [r.category.slug])
  }
  const byTargetHandle = new Map<string, string[]>()
  for (const r of targetRows) {
    const k = r.target.handle.toLowerCase()
    const list = byTargetHandle.get(k)
    if (list) list.push(r.category.slug)
    else byTargetHandle.set(k, [r.category.slug])
  }
  return { bySenderHandle, byTargetHandle }
}

/**
 * src/outreach/availability.ts:29–45 at 26e230d — `readSenderAvailability`, with
 * `sessionRecorded` (src/outreach/sessionHealth.ts:148–150) inlined as its one-line predicate.
 */
async function legacyReadSenderAvailability(prisma: PrismaClient): Promise<Map<string, string>> {
  const unavailable = new Map<string, string>()
  for (const s of await prisma.senderAccount.findMany({
    select: { id: true, handle: true, status: true, sessionPath: true, sessionInvalidAt: true },
  })) {
    if (s.status === 'CHALLENGED') unavailable.set(s.id, 'flagged by Instagram')
    else if (s.status !== 'ACTIVE') unavailable.set(s.id, s.status.toLowerCase())
    else if (s.sessionInvalidAt !== null) unavailable.set(s.id, 'logged out — needs signing in again')
    else if (!(s.sessionPath !== null && s.sessionInvalidAt === null)) unavailable.set(s.id, 'never signed in')
  }
  return unavailable
}

/** src/outreach/availability.ts:62–68 at 26e230d — `eligibleFleetSenders`. */
async function legacyEligibleFleetSenders(prisma: PrismaClient): Promise<{ id: string; handle: string }[]> {
  const [fleet, unavailable] = await Promise.all([
    prisma.senderAccount.findMany({ where: { fleetMember: true, status: 'ACTIVE' }, select: { id: true, handle: true } }),
    legacyReadSenderAvailability(prisma),
  ])
  return fleet.filter((s) => !unavailable.has(s.id))
}

/** src/outreach/compose.ts:288–293 at 26e230d — `readWatchChannels`. */
async function legacyReadWatchChannels(prisma: PrismaClient): Promise<{ handle: string; displayName: string | null }[]> {
  return prisma.targetAccount.findMany({
    where: { role: 'WATCH' },
    select: { handle: true, displayName: true },
  })
}

/** src/outreach/compose.ts:306–314 at 26e230d — `readPersonHandles`. */
async function legacyReadPersonHandles(prisma: PrismaClient, handles: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(handles.filter((h) => h.length > 0))]
  if (wanted.length === 0) return new Set()
  const rows = await prisma.brandLookup.findMany({
    where: { handle: { in: wanted }, kind: 'PERSON' },
    select: { handle: true },
  })
  return new Set(rows.map((r) => r.handle))
}

/** src/outreach/cohorts.ts:241–297 at 26e230d — `readCohortStates`. */
async function legacyReadCohortStates(prisma: PrismaClient, now: Date): Promise<CohortState[]> {
  const senders = await prisma.senderAccount.findMany({
    select: { handle: true, cohort: true, status: true, challengedAt: true, sessionPath: true, sessionInvalidAt: true },
    orderBy: [{ cohort: 'asc' }, { handle: 'asc' }],
  })
  const firstSends = await prisma.outreachAttempt.groupBy({
    by: ['senderId'],
    where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
    _min: { sentAt: true },
  })
  const senderIds = await prisma.senderAccount.findMany({ select: { id: true, handle: true } })
  const handleById = new Map(senderIds.map((s) => [s.id, s.handle]))
  const firstByHandle = new Map<string, Date>()
  for (const row of firstSends) {
    const handle = handleById.get(row.senderId)
    if (handle && row._min.sentAt) firstByHandle.set(handle, row._min.sentAt)
  }

  const byCohort = new Map<number, CohortMember[]>()
  for (const s of senders) {
    const member: CohortMember = {
      handle: s.handle,
      cohort: s.cohort,
      status: s.status,
      challengedAt: s.challengedAt,
      hasSession: s.sessionPath !== null && s.sessionInvalidAt === null,
      firstDeliveredAt: firstByHandle.get(s.handle) ?? null,
    }
    byCohort.set(s.cohort, [...(byCohort.get(s.cohort) ?? []), member])
  }

  return [...byCohort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cohort, members]) => {
      const delivered = members.map((m) => m.firstDeliveredAt).filter((d): d is Date => d !== null)
      const soakStartedAt = delivered.length > 0 ? new Date(Math.min(...delivered.map((d) => d.getTime()))) : null
      return {
        cohort,
        members,
        live: members.filter((m) => m.hasSession && m.status === 'ACTIVE').length,
        everChallenged: members.filter((m) => m.challengedAt !== null || m.status === 'CHALLENGED').length,
        soakStartedAt,
        soakDays: soakStartedAt === null ? 0 : (now.getTime() - soakStartedAt.getTime()) / 86_400_000,
      }
    })
}

/** src/outreach/cohorts.ts:319–323 at 26e230d — `cohortSoakDays`. */
async function legacyCohortSoakDays(prisma: PrismaClient): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'cohortSoakDays' } })
  const n = Number(row?.value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COHORT_SOAK_DAYS
}

/** src/outreach/cohorts.ts:308–316 at 26e230d — `mayArmAccount`, calling the PURE `mayArmCohort`. */
async function legacyMayArmAccount(prisma: PrismaClient, handle: string, now: Date): Promise<LadderVerdict> {
  const [sender, states, soakDays] = await Promise.all([
    prisma.senderAccount.findUnique({ where: { handle }, select: { cohort: true } }),
    legacyReadCohortStates(prisma, now),
    legacyCohortSoakDays(prisma),
  ])
  if (!sender) return { ok: false, reason: 'previous-cohort-not-live', detail: `no sender @${handle}` }
  return mayArmCohort({ cohort: sender.cohort, states, soakDays, now })
}

// ── the planner ───────────────────────────────────────────────────────────────

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

/** plan.ts lines ~183–466 at 26e230d: everything read ONCE per run before the per-pair loop. */
export async function legacyRunContext(
  prisma: PrismaClient,
  _settings: RuntimeSettings,
  now: Date,
  pairs: readonly LegacyPair[],
): Promise<LegacyRunContext> {
  const totalSentEver = await prisma.outreachAttempt.count({
    where: { status: { in: [...IN_FLIGHT_STATUSES] } },
  })

  const watchChannels = await legacyReadWatchChannels(prisma)
  const personHandles = await legacyReadPersonHandles(
    prisma,
    pairs.map((p) => p.target.handle),
  )

  const everRepliedTargetIds = new Set(
    (
      await prisma.outreachAttempt.findMany({
        where: { targetId: { in: [...new Set(pairs.map((p) => p.targetId))] }, replyPostedAt: { not: null } },
        select: { targetId: true },
        distinct: ['targetId'],
      })
    ).map((r) => r.targetId),
  )

  const memberships = await legacyReadCategoryMemberships(prisma)
  const eligibleFleet = await legacyEligibleFleetSenders(prisma)

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

/** plan.ts lines ~484–700 at 26e230d: the per-pair Promise.all and the GovernorInput it assembles. */
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
        where: legacyReplyHaltWhere({
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
      legacyFreshCampaignsFor(prisma, { target: pair.target, targetId: pair.targetId, pairId: pair.id, now }),
      legacyCampaignsNamingHandle(prisma, { handle: pair.target.handle, displayName: pair.target.displayName }, windowFloor),
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

// ── the gate ──────────────────────────────────────────────────────────────────

/** gate.ts lines ~814–939 at 26e230d: `recheckBeforeSend`'s Promise.all and the ResendInput it assembles. */
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
        where: legacyReplyHaltWhere({
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
      legacyEligibleFleetSenders(prisma),
      opts.unattended
        ? legacyMayArmAccount(prisma, sender.handle, new Date())
        : Promise.resolve({ ok: true as const, reason: 'baseline' as const }),
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
      legacyCampaignsNamingHandle(prisma, { handle: target.handle, displayName: target.displayName }, materialWindowFloor),
      prisma.outreachAttempt.count({
        where: {
          pair: { targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: materialWindowFloor },
          id: { not: attempt.id },
        },
      }),
      legacyReadCategoryMemberships(prisma),
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
