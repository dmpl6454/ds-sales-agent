import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * REMOVE ON A WATCHED CHANNEL MUST NEVER ERASE ITS CORPUS (2026-10-09) — and Add brings a
 * removed one back only through the same door a new page passes.
 *
 * EXECUTED at the base commit against this same DDL: Remove on a watched page with five
 * stored posts returned *"Stopped watching @viralbhayani and removed it"*, the row and all
 * five posts were gone (one carried a person's label, one the text read off its footage), a
 * delivered message to ANOTHER company lost the post it had claimed (`campaign` SET NULL),
 * and a prospect whose only rows were a not-in-thread park and a SENDING draft was deleted
 * with both. The rule was "delete unless a message was DELIVERED", and a watched page is
 * never messaged.
 *
 * Driven through the REAL actions against a temporary SQLite file built from the schema's own
 * DDL (`prisma migrate diff`, foreign keys included) — the defect IS a cascade, and a
 * hand-written DDL without the foreign keys would pass every assertion here vacuously. The
 * harness control below proves the cascade fires.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-remove-target-'))
const dbPath = join(dir, 'remove.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
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
  CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key" ON "OutreachPair"("senderId", "targetId");
  CREATE UNIQUE INDEX "DetectedCampaign_shortcode_key" ON "DetectedCampaign"("shortcode");
  CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
  CREATE UNIQUE INDEX "CategorySender_categoryId_senderId_key" ON "CategorySender"("categoryId", "senderId");
  CREATE UNIQUE INDEX "CategoryTarget_categoryId_targetId_key" ON "CategoryTarget"("categoryId", "targetId");
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

/* The boundary `actions.ts` sits behind, exactly as tests/route-rule.test.ts stubs it — plus
   the two network calls the Add path makes, which this file drives in both directions. */
const probe = vi.hoisted(() => ({
  check: 'exists' as 'exists' | 'missing' | 'unknown',
  calls: 0,
  feedPosts: 5,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/detection/exists', () => ({
  handleExists: async () => probe.check,
  probeHandle: async () => {
    probe.calls++
    return {
      check: probe.check,
      facts: probe.check === 'exists' ? { name: 'Probe Says Hello', followers: 1234, verified: true } : null,
    }
  },
}))
vi.mock('@/detection/feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/feed')>()),
  fetchFeed: async () => ({
    posts: Array.from({ length: probe.feedPosts }, (_, i) => ({ postedAt: new Date(Date.now() - i * 3_600_000).toISOString() })),
  }),
}))
vi.mock('@/detection/enrichHandle', () => ({
  enrichHandle: async () => ({ reachable: false, reason: 'not in this test', status: 0 }),
}))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: {} }))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: async () => ({ hasSession: false }) }))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))
vi.mock('@/outreach/dispatcher', () => ({
  withSendLock: async (_k: string, fn: () => unknown) => fn(),
  dispatchTick: async () => ({}),
  DISPATCH_PAUSE_KEY: 'dispatchPausedUntil',
}))

const { removeTarget, addTarget, setTargetWatch } = await import('@/app/actions')
const { excludedHandles } = await import('@/detection/brandCandidates')
const { badgeDoorPass } = await import('@/detection/badgeDoor')
const { prisma } = await import('@/lib/db')

const persona = { personaName: '', personaRole: '', personaBrand: '', personaPhone: '', personaEmail: '' }

async function sender(id: string) {
  await prisma.senderAccount.create({ data: { id, handle: id, displayName: id, ...persona } })
  await prisma.messageVariant.create({ data: { id: `v_${id}`, senderId: id, label: 'A', body: 'b' } })
}

async function target(id: string, data: { role?: string; optedOut?: boolean; watchEnabled?: boolean; discoveredFromCampaignId?: string } = {}) {
  await prisma.targetAccount.create({
    data: {
      id,
      handle: id,
      displayName: id,
      role: data.role ?? 'PROSPECT',
      optedOut: data.optedOut ?? false,
      watchEnabled: data.watchEnabled ?? (data.role === 'WATCH'),
      discoveredFromCampaignId: data.discoveredFromCampaignId ?? null,
    },
  })
}

async function post(id: string, targetId: string, extra: { humanLabel?: boolean; frameText?: string; caption?: string; verdict?: string } = {}) {
  await prisma.detectedCampaign.create({
    data: {
      id,
      targetId,
      shortcode: id,
      permalink: `https://instagram.com/p/${id}`,
      postedAt: new Date(),
      caption: extra.caption ?? 'a post',
      verdict: extra.verdict ?? 'CAMPAIGN',
      humanLabel: extra.humanLabel ?? null,
      frameText: extra.frameText ?? null,
    },
  })
}

async function attempt(id: string, s: string, t: string, data: { status: string; failureCode?: string; campaignId?: string; targetId?: string }) {
  await prisma.outreachPair.upsert({
    where: { senderId_targetId: { senderId: s, targetId: t } },
    update: {},
    create: { id: `p_${s}_${t}`, senderId: s, targetId: t },
  })
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: `p_${s}_${t}`,
      senderId: s,
      targetId: data.targetId ?? t,
      variantId: `v_${s}`,
      touchNumber: 1,
      renderedBody: 'a message long enough to be a real body',
      status: data.status,
      failureCode: data.failureCode ?? null,
      campaignId: data.campaignId ?? null,
      sentAt: data.status === 'SENT' ? new Date() : null,
    },
  })
}

/** The @viralbhayani shape from the reproduction: a watched page with posts that matter. */
async function seedWatchedCorpus() {
  await sender('chronicle')
  await target('viral', { role: 'WATCH' })
  await post('c1', 'viral', { humanLabel: false })
  await post('c2', 'viral', { frameText: 'SWITCH' })
  await post('c3', 'viral')
  await target('company_p')
  await attempt('sent_p', 'chronicle', 'company_p', { status: 'SENT', campaignId: 'c3' })
  await target('company_q', { discoveredFromCampaignId: 'c2' })
}

beforeEach(async () => {
  probe.check = 'exists'
  probe.calls = 0
  probe.feedPosts = 5
  await prisma.auditLog.deleteMany({})
  await prisma.brandLookup.deleteMany({})
  await prisma.setting.deleteMany({})
  await prisma.categoryTarget.deleteMany({})
  await prisma.categorySender.deleteMany({})
  await prisma.category.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('removeTarget on a watched channel keeps its corpus', () => {
  it('retires the page — stops reading it — and every post, label, claim and provenance survives', async () => {
    await seedWatchedCorpus()

    const r = await removeTarget('viral')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('3 stored posts are kept')

    const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'viral' } })
    expect(row.role, 'a removed competitor must stay a competitor').toBe('WATCH')
    expect(row.optedOut).toBe(true)
    expect(row.watchEnabled, 'a retired watched page must stop being read').toBe(false)

    expect(await prisma.detectedCampaign.count({ where: { targetId: 'viral' } })).toBe(3)
    expect((await prisma.detectedCampaign.findUniqueOrThrow({ where: { id: 'c1' } })).humanLabel).toBe(false)
    expect((await prisma.detectedCampaign.findUniqueOrThrow({ where: { id: 'c2' } })).frameText).toBe('SWITCH')
    expect(
      (await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'sent_p' } })).campaignId,
      "another company's delivered message keeps the post it claimed",
    ).toBe('c3')
    const q = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'company_q' } })
    expect(await prisma.detectedCampaign.findUnique({ where: { id: q.discoveredFromCampaignId! } })).not.toBeNull()

    expect(await prisma.auditLog.count({ where: { action: 'target.watch.retired' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'target.deleted' } })).toBe(0)
    // Still on the list discovery reads, so it can never be minted as a prospect.
    expect((await excludedHandles()).has('viral')).toBe(true)
  })

  /**
   * THE HARNESS CONTROL. The cascade really fires here: a direct delete of the same seed takes
   * the posts and SET-NULLs the claim. Without this, the survival above could be passing because
   * foreign keys are off in this harness — they are off by default in SQLite.
   */
  it('control: a raw delete of the same row DOES cascade the posts and null the claim', async () => {
    await seedWatchedCorpus()
    await prisma.targetAccount.delete({ where: { handle: 'viral' } })
    expect(await prisma.detectedCampaign.count({ where: { targetId: 'viral' } })).toBe(0)
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'sent_p' } })).campaignId).toBeNull()
  })

  it('deletes an EMPTY watched page outright — undoing a wrong add loses nothing', async () => {
    await target('afaqs', { role: 'WATCH' })
    await prisma.category.create({ data: { id: 'cat_m', name: 'Marketing', slug: 'marketing' } })
    await prisma.categoryTarget.create({ data: { id: 'ct_a', categoryId: 'cat_m', targetId: 'afaqs' } })

    const r = await removeTarget('afaqs')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('removed it')
    expect(await prisma.targetAccount.count({ where: { handle: 'afaqs' } })).toBe(0)
    expect(await prisma.categoryTarget.count()).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'target.deleted' } })).toBe(1)
  })

  /**
   * THE CHECK IS INSIDE THE DELETE. A watched page with no posts and no attempt of its own, but
   * a pair holding an attempt whose denormalised `targetId` drifted elsewhere: the pair cascade
   * would take that attempt, so the delete must refuse and the page be retired instead.
   */
  it('retires rather than deletes when a pair under it holds an attempt', async () => {
    await sender('chronicle')
    await target('watch_w', { role: 'WATCH' })
    await target('elsewhere')
    await attempt('drifted', 'chronicle', 'watch_w', { status: 'SENT', targetId: 'elsewhere' })

    const r = await removeTarget('watch_w')
    expect(r.ok).toBe(true)
    expect(await prisma.targetAccount.count({ where: { handle: 'watch_w' } })).toBe(1)
    expect(await prisma.outreachAttempt.count({ where: { id: 'drifted' } }), 'the pair cascade must not run').toBe(1)
  })
})

describe('removeTarget on a prospect ALWAYS retires', () => {
  it('even with nothing recorded — a deleted prospect is re-minted with live routes', async () => {
    await sender('chronicle')
    await target('empty_p')
    await prisma.outreachPair.create({ data: { id: 'p_e', senderId: 'chronicle', targetId: 'empty_p' } })

    const r = await removeTarget('empty_p')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('never be messaged')
    const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'empty_p' } })
    expect(row.optedOut).toBe(true)
    expect(row.role).toBe('PROSPECT')
    expect((await prisma.outreachPair.findUniqueOrThrow({ where: { id: 'p_e' } })).enabled).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: 'target.retired' } })).toBe(1)
  })

  it('a not-in-thread park — the recipient may HAVE it — survives', async () => {
    await sender('chronicle')
    await target('maybe_p')
    await attempt('park', 'chronicle', 'maybe_p', { status: 'FAILED', failureCode: 'not-in-thread' })
    await removeTarget('maybe_p')
    expect(await prisma.targetAccount.count({ where: { handle: 'maybe_p' } })).toBe(1)
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'park' } })).failureCode).toBe('not-in-thread')
  })

  it('a SENDING row — a browser mid-paste — survives', async () => {
    await sender('chronicle')
    await target('live_p')
    await attempt('sending', 'chronicle', 'live_p', { status: 'SENDING' })
    await removeTarget('live_p')
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'sending' } })).status).toBe('SENDING')
  })

  /**
   * WHY "ALWAYS". The badge door lists every asserted handle with NO row and admits a verified
   * one without a network call. A retired row stops that; a deleted one is minted again on the
   * next brand pass, with live routes and none of its history. Run dry, so nothing is created.
   */
  it('the badge door does not re-mint a removed prospect — and would have, had it been deleted', async () => {
    await target('watch_live', { role: 'WATCH' })
    await post('pp', 'watch_live', { caption: 'Big thanks to @hprospect for this placement', verdict: 'CAMPAIGN' })
    await target('hprospect')
    await prisma.brandLookup.create({ data: { handle: 'hprospect', kind: 'PERSON', isVerified: true, displayName: 'H' } })

    await removeTarget('hprospect')
    const after = await badgeDoorPass({ maxEnrichments: 0, dryRun: true, enrichSpacingMs: 0 })
    expect(after.admitted, 'a retired prospect was offered for re-admission').toBe(0)
    expect((await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'hprospect' } })).optedOut).toBe(true)

    // The control: with the row gone, the same pass DOES offer it back.
    await prisma.targetAccount.delete({ where: { handle: 'hprospect' } })
    const control = await badgeDoorPass({ maxEnrichments: 0, dryRun: true, enrichSpacingMs: 0 })
    expect(control.admitted, 'harness bug: the badge door would not admit this handle at all').toBe(1)
  })
})

describe('Add brings a removed watched page back — through the new-page door', () => {
  it('re-reads it after the probe and the feed vet, keeping every stored post', async () => {
    await seedWatchedCorpus()
    await removeTarget('viral')
    probe.calls = 0

    const r = await addTarget('viral', '', '', 'WATCH')
    expect(r.ok).toBe(true)
    expect(probe.calls, 'a revival must ask Instagram who this is, like a new add').toBe(1)
    expect(r.message).toContain('Probe Says Hello')
    expect(r.message).toContain('3 stored posts were kept')
    const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'viral' } })
    expect(row.optedOut).toBe(false)
    expect(row.watchEnabled).toBe(true)
    expect(row.role).toBe('WATCH')
    expect(await prisma.detectedCampaign.count({ where: { targetId: 'viral' } })).toBe(3)
    expect(await prisma.auditLog.count({ where: { action: 'target.watch.resumed' } })).toBe(1)
  })

  it('a handle that has since vanished stays removed', async () => {
    await target('gone_w', { role: 'WATCH', optedOut: true, watchEnabled: false })
    probe.check = 'missing'
    const r = await addTarget('gone_w', '', '', 'WATCH')
    expect(r.ok).toBe(false)
    expect((await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'gone_w' } })).optedOut).toBe(true)
  })

  it('a page whose feed now returns nothing stays removed', async () => {
    await target('silent_w', { role: 'WATCH', optedOut: true, watchEnabled: false })
    probe.feedPosts = 0
    const r = await addTarget('silent_w', '', '', 'WATCH')
    expect(r.ok).toBe(false)
    const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'silent_w' } })
    expect(row.optedOut).toBe(true)
    expect(row.watchEnabled).toBe(false)
  })

  /**
   * OUR OWN PAGES are WATCH rows too (the role backfill), retired and unread since 13 Aug —
   * resuming them is ~1,500 feed requests a day and Tabish's call. Neither the hardcoded list
   * nor a SenderAccount by the same handle may be revived from the Add form.
   */
  it('never revives one of our own pages — by the list, or by a sending account of that name', async () => {
    await sender('bollywoodchronicle')
    await target('bollywoodchronicle', { role: 'WATCH', optedOut: true, watchEnabled: false })
    await sender('ourotherpage')
    await target('ourotherpage', { role: 'WATCH', optedOut: true, watchEnabled: false })

    for (const h of ['bollywoodchronicle', 'ourotherpage']) {
      const r = await addTarget(h, '', '', 'WATCH')
      expect(r.ok, `@${h} was revived`).toBe(false)
      expect(r.message).toContain('one of our own pages')
      const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: h } })
      expect(row.optedOut).toBe(true)
      expect(row.watchEnabled).toBe(false)
    }
    expect(probe.calls).toBe(0)
  })

  it('never clears optedOut on a retired PROSPECT, whichever kind is chosen', async () => {
    await target('retired_p', { optedOut: true })
    for (const role of ['WATCH', 'PROSPECT'] as const) {
      const r = await addTarget('retired_p', '', '', role)
      expect(r.ok).toBe(false)
      expect(r.message).toContain('ig:unretire-target')
    }
    const row = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'retired_p' } })
    expect(row.optedOut).toBe(true)
    expect(row.role).toBe('PROSPECT')
  })

  it('a live watched page added again as a company is refused, and stays a watched page', async () => {
    await target('live_w', { role: 'WATCH' })
    const r = await addTarget('live_w', '', '', 'PROSPECT')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('never messaged')
    expect((await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'live_w' } })).role).toBe('WATCH')
    const again = await addTarget('live_w', '', '', 'WATCH')
    expect(again.message).toContain('already a page we watch')
  })
})

describe('setTargetWatch — the side door', () => {
  it('will not turn reading back on for a removed watched page; turning it off is always allowed', async () => {
    await target('removed_w', { role: 'WATCH', optedOut: true, watchEnabled: false })
    const on = await setTargetWatch('removed_w', true)
    expect(on.ok).toBe(false)
    expect((await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'removed_w' } })).watchEnabled).toBe(false)

    await target('paused_w', { role: 'WATCH' })
    expect((await setTargetWatch('paused_w', false)).ok).toBe(true)
    expect((await setTargetWatch('paused_w', true)).ok).toBe(true)
  })
})

/**
 * ONE DELETE, AND THE CHECK IS IN IT — a source grep, because the failure mode is a future
 * "simplification" back to a count followed by `delete({ where: { handle } })`.
 */
describe('the delete statement carries its own guard', () => {
  it('removeTarget deletes only through a conditional deleteMany', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/actions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    const start = src.indexOf('export async function removeTarget(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toMatch(/targetAccount\.delete\(/)
    const del = body.match(/targetAccount\.deleteMany\(\{[\s\S]*?\}\)\s*\n/)
    expect(del, 'no conditional deleteMany in removeTarget').not.toBeNull()
    const where = del![0]
    expect(where).toMatch(/role:\s*'WATCH'/)
    expect(where).toMatch(/campaigns:\s*\{\s*none:\s*\{\}\s*\}/)
    expect(where).toMatch(/attempts:\s*\{\s*none:\s*\{\}\s*\}/)
    expect(where).toMatch(/pairs:\s*\{\s*none:\s*\{\s*attempts:\s*\{\s*some:\s*\{\}\s*\}\s*\}\s*\}/)
  })
})
