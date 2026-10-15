import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@/generated/prisma/client'
import { takeQueryCount } from '@/lib/queryCount'

/**
 * A TEMPORARY SQLITE DATABASE SHAPED LIKE THE OUTREACH SCHEMA, for driving the REAL planner,
 * gate and composer against real rows (Stage 0 of the outreach redesign, 2026-10-15).
 *
 * ── HOW TO USE IT, AND WHY THE ORDER MATTERS ─────────────────────────────────
 *
 * `openOutreachDb` must be awaited AT MODULE TOP LEVEL, before the first dynamic import of
 * anything that reaches `@/lib/db` or `@/lib/env` — the pattern `tests/rotation-fleet.test.ts`
 * uses. Both modules read `process.env` ONCE, at import: `env.ts` parses it with zod and
 * `db.ts` builds the client from `env.DATABASE_URL`, and dotenv never overrides a variable
 * already set. A static `import { prisma } from '@/lib/db'` at the top of a test file is
 * evaluated before any statement in that file runs, so it would bind the client to
 * `vitest.config.ts`'s default file and every seed below would land in the wrong database.
 *
 *     const { dbPath } = await openOutreachDb('my-test')
 *     const { prisma } = await import('@/lib/db')
 *     const { runOutreach } = await import('@/outreach/plan')
 *
 * This module itself imports nothing that reads the environment: `@/lib/queryCount` is a
 * counter on `globalThis` and a type-only import of the client is erased at compile time.
 *
 * ── WHAT ELSE IT SETS ───────────────────────────────────────────────────────
 *
 *   TZ=Asia/Kolkata     every day boundary here is IST (`istDayStart`), and a test that
 *                       ran under the machine's zone would compute "today" differently.
 *   DS_QUERY_COUNT=1    so `db.ts` subscribes to the client's query event and
 *                       `countQueries` below can report how many statements a stretch of
 *                       work issued. It is read at db import, which is why it is set here
 *                       and not inside `countQueries`.
 *
 * ── THE DDL IS COPIED, NOT INVENTED ─────────────────────────────────────────
 *
 * Transcribed from `tests/remove-sender-live.test.ts` (the most complete block in the suite,
 * with the schema's own foreign keys), `tests/fleet-reservations.test.ts` (DailyReservation)
 * and `prisma/migrations/20260729104141_init/migration.sql` (ScrapeRun, which no test had
 * needed). Every column was cross-checked against `prisma/schema.prisma` at 26e230d. A
 * column the planner selects that is missing here fails at RUNTIME while typecheck passes
 * (the `tests/cohorts-live.test.ts` lesson), so the whole planner path is driven, not mirrored.
 */

export const OUTREACH_DDL = `
  CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "personaRole" TEXT NOT NULL,
    "personaBrand" TEXT NOT NULL,
    "personaPhone" TEXT NOT NULL,
    "personaEmail" TEXT NOT NULL,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fleetMember" BOOLEAN NOT NULL DEFAULT true,
    "dailyCap" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "challengedAt" DATETIME,
    "cohort" INTEGER NOT NULL DEFAULT 1,
    "sessionPath" TEXT,
    "sessionSavedAt" DATETIME,
    "sessionInvalidAt" DATETIME,
    "sessionInvalidReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );
  CREATE TABLE "TargetAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "role" TEXT NOT NULL DEFAULT 'PROSPECT',
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN,
    "followerCount" INTEGER,
    "campaignTalent" BOOLEAN NOT NULL DEFAULT false,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );
  CREATE TABLE "OutreachPair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "maxUnansweredTouches" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bespokeBody" TEXT,
    "bespokeNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutreachPair_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachPair_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE TABLE "DetectedCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caption" TEXT NOT NULL,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "mediaType" TEXT,
    "brands" TEXT NOT NULL DEFAULT '[]',
    "signals" TEXT NOT NULL DEFAULT '[]',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL,
    "humanLabel" BOOLEAN,
    "labelledBy" TEXT,
    "labelledAt" DATETIME,
    "verdictSource" TEXT NOT NULL DEFAULT 'none',
    "classifierModel" TEXT,
    "classifierReason" TEXT,
    "taggedAccounts" TEXT NOT NULL DEFAULT '[]',
    "rawPayload" TEXT,
    "frameText" TEXT,
    CONSTRAINT "DetectedCampaign_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  /* MessageVariant BEFORE OutreachAttempt — the order the SQLite migrations leave it in. */
  CREATE TABLE "MessageVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageVariant_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campaignId" TEXT,
    "variantId" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "hookLine" TEXT,
    "renderedBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "sentBy" TEXT,
    "threadUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "repliedAt" DATETIME,
    "replyPostedAt" DATETIME,
    "replyText" TEXT,
    "replyCheckedAt" DATETIME,
    "replyHandledAt" DATETIME,
    "replyHandledBy" TEXT,
    CONSTRAINT "OutreachAttempt_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "OutreachPair" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "DetectedCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MessageVariant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );
  CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "BrandLookup" (
    "handle" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "category" TEXT,
    "displayName" TEXT,
    "followers" INTEGER,
    "isVerified" BOOLEAN,
    "enrichment" TEXT,
    "reachable" BOOLEAN,
    "decidedBy" TEXT,
    "modelConfidence" INTEGER,
    "modelReason" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
  );
  CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategorySender" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategorySender_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CategorySender_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE TABLE "CategoryTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategoryTarget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CategoryTarget_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE TABLE "DailyReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "attemptId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "DailyReservation_day_scope_subjectId_seq_key"
    ON "DailyReservation"("day", "scope", "subjectId", "seq");
  CREATE INDEX "DailyReservation_day_scope_subjectId_idx"
    ON "DailyReservation"("day", "scope", "subjectId");
  CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slot" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "postsSeen" INTEGER NOT NULL DEFAULT 0,
    "newPosts" INTEGER NOT NULL DEFAULT 0,
    "detected" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "detail" TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key" ON "OutreachPair"("senderId", "targetId");
  CREATE UNIQUE INDEX "DetectedCampaign_shortcode_key" ON "DetectedCampaign"("shortcode");
  CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
  CREATE UNIQUE INDEX "CategorySender_categoryId_senderId_key" ON "CategorySender"("categoryId", "senderId");
  CREATE UNIQUE INDEX "CategoryTarget_categoryId_targetId_key" ON "CategoryTarget"("categoryId", "targetId");
`

export interface OutreachDb {
  dbPath: string
  dir: string
}

/**
 * Create the file, execute the DDL, and point this process at it. See the module docblock
 * for why this must run before anything imports `@/lib/db`.
 */
export async function openOutreachDb(name: string): Promise<OutreachDb> {
  const dir = mkdtempSync(join(tmpdir(), `ds-${name}-`))
  const dbPath = join(dir, `${name}.db`)
  const bootstrap = new Database(dbPath)
  try {
    bootstrap.exec(OUTREACH_DDL)
  } finally {
    bootstrap.close()
  }
  process.env.DATABASE_URL = `file:${dbPath}`
  process.env.TZ = 'Asia/Kolkata'
  process.env.DS_QUERY_COUNT = '1'
  return { dbPath, dir }
}

// ── seed builders ─────────────────────────────────────────────────────────────
//
// Every id is DERIVED from the handle or the parent ids rather than generated, because the
// rotation ring spreads never-messaged recipients by `stableIndex(targetId, …)` — a hash of
// the id string. A golden capture keyed on outcomes is only stable if the ids are.

/** The persona columns are NOT NULL and nothing a planner test reads them for. */
const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

export function senderId(handle: string): string {
  return `s_${handle}`
}

export function targetId(handle: string): string {
  return `t_${handle}`
}

export function pairId(sender: string, target: string): string {
  return `p_${sender}__${target}`
}

export async function seedSender(
  prisma: PrismaClient,
  s: {
    handle: string
    cohort?: number
    fleetMember?: boolean
    status?: string
    /** A recorded hand login. `null` means never signed in — rotation then skips the page. */
    sessionPath?: string | null
    sessionInvalidAt?: Date | null
    challengedAt?: Date | null
  },
): Promise<{ id: string; handle: string }> {
  const id = senderId(s.handle)
  await prisma.senderAccount.create({
    data: {
      id,
      handle: s.handle,
      displayName: s.handle,
      ...PERSONA,
      cohort: s.cohort ?? 1,
      fleetMember: s.fleetMember ?? true,
      status: s.status ?? 'ACTIVE',
      sessionPath: s.sessionPath === undefined ? `/profiles/${s.handle}` : s.sessionPath,
      sessionInvalidAt: s.sessionInvalidAt ?? null,
      challengedAt: s.challengedAt ?? null,
    },
  })
  return { id, handle: s.handle }
}

export async function seedTarget(
  prisma: PrismaClient,
  t: {
    handle: string
    role?: 'PROSPECT' | 'WATCH'
    kind?: 'CHANNEL' | 'BRAND'
    isVerified?: boolean | null
    optedOut?: boolean
    displayName?: string
    brandCategory?: string | null
    campaignTalent?: boolean
    discoveredFromCampaignId?: string | null
  },
): Promise<{ id: string; handle: string }> {
  const id = targetId(t.handle)
  await prisma.targetAccount.create({
    data: {
      id,
      handle: t.handle,
      displayName: t.displayName ?? t.handle,
      role: t.role ?? 'PROSPECT',
      kind: t.kind ?? 'BRAND',
      /* `true` unless stated: the VERIFIED ONLY rule refuses null and false at both ends, so
         a scenario that forgot the badge would read as a wall of target-not-verified. */
      isVerified: t.isVerified === undefined ? true : t.isVerified,
      optedOut: t.optedOut ?? false,
      brandCategory: t.brandCategory ?? null,
      campaignTalent: t.campaignTalent ?? false,
      discoveredFromCampaignId: t.discoveredFromCampaignId ?? null,
      /* A prospect's feed is never read; `createBrandTarget` writes false explicitly. */
      watchEnabled: (t.role ?? 'PROSPECT') === 'WATCH',
    },
  })
  return { id, handle: t.handle }
}

export async function seedPair(prisma: PrismaClient, sender: string, target: string): Promise<{ id: string }> {
  const id = pairId(sender, target)
  await prisma.outreachPair.create({ data: { id, senderId: sender, targetId: target } })
  return { id }
}

/**
 * One enabled variant per target kind, so `composeForPair` cannot throw `NoVariantsError`.
 * Under `singleTemplate` the variant's body is never rendered; only its id is recorded.
 */
export async function seedVariants(prisma: PrismaClient, sender: string): Promise<void> {
  for (const targetKind of ['CHANNEL', 'BRAND'] as const) {
    await prisma.messageVariant.create({
      data: { id: `v_${sender}_${targetKind}`, senderId: sender, targetKind, label: `v-${targetKind}`, body: 'unused' },
    })
  }
}

let attemptSeq = 0

/** Deterministic attempt ids within one process: `a_<n>` in seed order. */
function nextAttemptId(): string {
  attemptSeq += 1
  return `a_${String(attemptSeq).padStart(3, '0')}`
}

async function pairEnds(prisma: PrismaClient, id: string): Promise<{ senderId: string; targetId: string }> {
  const pair = await prisma.outreachPair.findUniqueOrThrow({ where: { id }, select: { senderId: true, targetId: true } })
  return pair
}

/** A DELIVERED message on a pair — the whole of what spacing, touches and claims are derived from. */
export async function seedDelivery(
  prisma: PrismaClient,
  d: {
    pairId: string
    sentAt: Date
    touchNumber: number
    body: string
    campaignId?: string | null
    /** SENT by default; REPLIED is also a delivered status and must count the same. */
    status?: 'SENT' | 'REPLIED'
    id?: string
  },
): Promise<{ id: string }> {
  const ends = await pairEnds(prisma, d.pairId)
  const id = d.id ?? nextAttemptId()
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: d.pairId,
      senderId: ends.senderId,
      targetId: ends.targetId,
      campaignId: d.campaignId ?? null,
      variantId: `v_${ends.senderId}_BRAND`,
      touchNumber: d.touchNumber,
      renderedBody: d.body,
      status: d.status ?? 'SENT',
      queuedAt: d.sentAt,
      sentAt: d.sentAt,
      sentBy: 'autopilot:test',
    },
  })
  return { id }
}

/**
 * A reply recorded on an existing delivered attempt. `replyPostedAt` null is the UNDATED reply:
 * it is listed, it never halts (Tabish's permissive direction), and it does not count as "they
 * have ever replied" — the gate and planner read `replyPostedAt`, never `repliedAt`.
 */
export async function seedReply(
  prisma: PrismaClient,
  r: { attemptId: string; repliedAt: Date; replyPostedAt: Date | null; replyText: string },
): Promise<void> {
  await prisma.outreachAttempt.update({
    where: { id: r.attemptId },
    data: { status: 'REPLIED', repliedAt: r.repliedAt, replyPostedAt: r.replyPostedAt, replyText: r.replyText },
  })
}

/** A parked FAILED attempt on a pair. `queuedAt` is the park's clock (parkedRows.ts). */
export async function seedPark(
  prisma: PrismaClient,
  p: { pairId: string; failureCode: string; queuedAt: Date; touchNumber?: number; body?: string; id?: string },
): Promise<{ id: string }> {
  const ends = await pairEnds(prisma, p.pairId)
  const id = p.id ?? nextAttemptId()
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: p.pairId,
      senderId: ends.senderId,
      targetId: ends.targetId,
      variantId: `v_${ends.senderId}_BRAND`,
      touchNumber: p.touchNumber ?? 1,
      renderedBody: p.body ?? 'parked body',
      status: 'FAILED',
      failureCode: p.failureCode,
      attempts: 3,
      error: `parked: ${p.failureCode}`,
      queuedAt: p.queuedAt,
    },
  })
  return { id }
}

/** A waiting or superseded draft on a pair (READY / QUEUED / SKIPPED), with an optional claim. */
export async function seedDraft(
  prisma: PrismaClient,
  d: {
    pairId: string
    status: 'READY' | 'QUEUED' | 'SKIPPED' | 'SENDING'
    touchNumber: number
    body: string
    campaignId?: string | null
    queuedAt: Date
    id?: string
  },
): Promise<{ id: string }> {
  const ends = await pairEnds(prisma, d.pairId)
  const id = d.id ?? nextAttemptId()
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: d.pairId,
      senderId: ends.senderId,
      targetId: ends.targetId,
      campaignId: d.campaignId ?? null,
      variantId: `v_${ends.senderId}_BRAND`,
      touchNumber: d.touchNumber,
      renderedBody: d.body,
      status: d.status,
      queuedAt: d.queuedAt,
      error: d.status === 'SKIPPED' ? 'discarded in the scenario' : null,
    },
  })
  return { id }
}

/**
 * A paid post. `channelId` is the WATCH page that published it — `DetectedCampaign.targetId`
 * is the posting channel, never the company named, which is the linkage mistake this
 * codebase has made four times.
 */
export async function seedPost(
  prisma: PrismaClient,
  p: {
    shortcode: string
    channelId: string
    postedAt: Date
    caption: string
    /** A JSON string, as the column stores it. */
    brands?: string
    /** A JSON string, as the column stores it. */
    taggedAccounts?: string
    verdict?: 'CAMPAIGN' | 'ORGANIC' | 'UNCLASSIFIED'
    id?: string
  },
): Promise<{ id: string }> {
  const id = p.id ?? `c_${p.shortcode}`
  await prisma.detectedCampaign.create({
    data: {
      id,
      targetId: p.channelId,
      shortcode: p.shortcode,
      permalink: `https://www.instagram.com/p/${p.shortcode}/`,
      postedAt: p.postedAt,
      detectedAt: p.postedAt,
      caption: p.caption,
      brands: p.brands ?? '[]',
      taggedAccounts: p.taggedAccounts ?? '[]',
      verdict: p.verdict ?? 'CAMPAIGN',
      verdictSource: 'semantic',
      confidence: 95,
    },
  })
  return { id }
}

/** A fleet (Category row) with its sender and target memberships. */
export async function seedCategory(
  prisma: PrismaClient,
  slug: string,
  members: { senders: readonly string[]; targets: readonly string[] },
): Promise<{ id: string }> {
  const id = `cat_${slug}`
  await prisma.category.create({ data: { id, name: slug, slug } })
  let position = 0
  for (const sender of members.senders) {
    await prisma.categorySender.create({
      data: { id: `cs_${slug}_${sender}`, categoryId: id, senderId: sender, position: position++ },
    })
  }
  for (const target of members.targets) {
    await prisma.categoryTarget.create({ data: { id: `ct_${slug}_${target}`, categoryId: id, targetId: target } })
  }
  return { id }
}

export async function setSetting(prisma: PrismaClient, key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

/**
 * How many statements did `fn` issue? Zeroes the process-wide counter first, so the number is
 * attributable to this stretch of work alone.
 *
 * Sets nothing itself: counting only works because `openOutreachDb` set `DS_QUERY_COUNT=1`
 * before `@/lib/db` was imported, which is when the client subscribes. Called against a client
 * built without that variable it reports 0 — the "0 queries to render `/`" number
 * `src/lib/queryCount.ts` records as the implausibility that caught its own first version.
 */
export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  takeQueryCount()
  const result = await fn()
  const queries = takeQueryCount()
  return { result, queries }
}
