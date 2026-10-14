import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * REMOVING A SENDER MUST NEVER ERASE WHAT ITS HAND-OFF KEPT (2026-10-09).
 *
 * `removeSender` decided delete-or-retire on DELIVERED messages alone (SENT / REPLIED), and
 * `OutreachPair.sender` and `OutreachAttempt.sender` are ON DELETE CASCADE. So for an account
 * that had never delivered, the delete erased exactly what the hand-off leaves in place on
 * purpose: a not-in-thread park (the recipient may HAVE that message), a profile-gone park (the
 * recipient's 7-day stop for every page), a SENDING row mid-drive (its delivery then lands on a
 * row that no longer exists), and a superseded draft carrying a reply — the permanent "they
 * know us" fact the introduction stop reads, so other pages could send the standard
 * introduction again. The result then said these "stayed with" the account it had just deleted.
 *
 * Retiring wrote `status: 'PAUSED'`, and the reply sweep reads only ACTIVE senders' threads —
 * the @bachelorssociety finding of 1 Sept, fixed then by hand as ACTIVE + `fleetMember: false`.
 * Left ACTIVE, a retired account must hold nothing waiting, because the dispatcher delivers any
 * READY draft of an ACTIVE account; so what the hand-off kept for want of a page is withdrawn.
 *
 * The delete carries its own guard over all three ways it reaches a row: the account's attempts,
 * its pairs' attempts (a drifted `senderId`), and other accounts' attempts on its variants
 * (RESTRICT — the old re-pointing hand-off left those, and the delete then threw).
 *
 * Driven through the REAL action against a temporary SQLite file carrying the schema's own
 * foreign keys (`prisma migrate diff`) — the defect IS a cascade, and a DDL without them would
 * pass every assertion here vacuously. The harness control below proves the cascade fires.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-remove-sender-'))
const dbPath = join(dir, 'remove-sender.db')

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
  /* MessageVariant BEFORE OutreachAttempt: the order the SQLite migrations leave it in
     (20260805100000 redefines OutreachAttempt), as tests/hand-off-remove.test.ts does. In the
     other order SQLite runs the variant cascade first and the variant RESTRICT refuses EVERY
     sender delete, which would hide this defect behind a throw. Postgres's init.sql adds the
     attempt cascade before the variant one; its firing order is not verified here. */
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

/* The boundary `actions.ts` sits behind, exactly as tests/remove-target-live.test.ts stubs it. */
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/detection/exists', () => ({
  handleExists: async () => 'exists',
  probeHandle: async () => ({ check: 'exists', facts: null }),
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

const { removeSender } = await import('@/app/actions')
const { SUPERSEDED_BY_REPLY } = await import('@/outreach/replyCheck')
const { prisma } = await import('@/lib/db')

const persona = { personaName: '', personaRole: '', personaBrand: '', personaPhone: '', personaEmail: '' }

async function sender(id: string, data: { status?: string; fleetMember?: boolean } = {}) {
  await prisma.senderAccount.create({
    data: {
      id,
      handle: id,
      displayName: id,
      status: data.status ?? 'ACTIVE',
      fleetMember: data.fleetMember ?? true,
      sessionPath: `/tmp/profiles/${id}`,
      ...persona,
    },
  })
  await prisma.messageVariant.create({ data: { id: `v_${id}`, senderId: id, label: 'A', body: 'b', targetKind: 'BRAND' } })
}

async function target(id: string) {
  await prisma.targetAccount.create({ data: { id, handle: id, displayName: id, kind: 'BRAND', role: 'PROSPECT' } })
}

/** An attempt on the `pairOf → t` pair; `senderId` may differ from the pair's (a drifted row). */
async function attempt(
  id: string,
  pairOf: string,
  t: string,
  data: {
    status: string
    senderId?: string
    failureCode?: string
    reply?: boolean
    /** An undatable reply: observed (`repliedAt`) with no date of its own (`replyPostedAt`). */
    undatedReply?: boolean
    error?: string
    /** Whose message variant the row carries — the old re-pointing hand-off left a mismatch. */
    variantOf?: string
  },
) {
  await prisma.outreachPair.upsert({
    where: { senderId_targetId: { senderId: pairOf, targetId: t } },
    update: {},
    create: { id: `p_${pairOf}_${t}`, senderId: pairOf, targetId: t },
  })
  const by = data.senderId ?? pairOf
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: `p_${pairOf}_${t}`,
      senderId: by,
      targetId: t,
      variantId: `v_${data.variantOf ?? by}`,
      touchNumber: 1,
      renderedBody: 'a message long enough to be a real body for the send guards',
      status: data.status,
      failureCode: data.failureCode ?? null,
      error: data.error ?? null,
      sentAt: data.status === 'SENT' ? new Date() : null,
      ...(data.reply
        ? { repliedAt: new Date(), replyPostedAt: new Date(), replyText: 'Hi, what are your rates?' }
        : {}),
      ...(data.undatedReply ? { repliedAt: new Date(), replyText: 'Hi' } : {}),
    },
  })
}

/** The four rows the finding names, on an account that has never delivered a message. */
async function seedNeverDeliveredWithKeptRows() {
  await sender('leaving')
  await sender('alpha')
  for (const t of ['t_park', 't_gone', 't_live', 't_reply']) await target(t)
  await attempt('park', 'leaving', 't_park', { status: 'FAILED', failureCode: 'not-in-thread' })
  await attempt('gone', 'leaving', 't_gone', { status: 'FAILED', failureCode: 'profile-gone' })
  await attempt('live', 'leaving', 't_live', { status: 'SENDING' })
  await attempt('replied', 'leaving', 't_reply', { status: 'SKIPPED', reply: true, error: SUPERSEDED_BY_REPLY })
}

beforeEach(async () => {
  await prisma.auditLog.deleteMany({})
  await prisma.setting.deleteMany({})
  await prisma.categoryTarget.deleteMany({})
  await prisma.categorySender.deleteMany({})
  await prisma.category.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('removeSender keeps every row the hand-off kept', () => {
  /**
   * THE HARNESS CONTROL. The cascade really fires here: a raw delete of the same seed takes all
   * four rows. Without it the survival below could be passing because foreign keys are off —
   * they are off by default in SQLite.
   */
  it('control: a raw delete of the account DOES cascade all four rows away', async () => {
    await seedNeverDeliveredWithKeptRows()
    await prisma.senderAccount.delete({ where: { id: 'leaving' } })
    expect(await prisma.outreachAttempt.count({ where: { id: { in: ['park', 'gone', 'live', 'replied'] } } })).toBe(0)
  })

  it('a never-delivered account holding a park, a dead-page stop, a send in flight and a reply is retired, all four intact', async () => {
    await seedNeverDeliveredWithKeptRows()

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)

    const row = await prisma.senderAccount.findUnique({ where: { handle: 'leaving' } })
    expect(row, 'the account was deleted, and its rows with it').not.toBeNull()
    expect(row!.fleetMember).toBe(false)

    const park = await prisma.outreachAttempt.findUnique({ where: { id: 'park' } })
    expect(park?.status, 'the not-in-thread park — the recipient may HAVE it').toBe('FAILED')
    expect(park?.failureCode).toBe('not-in-thread')
    const gone = await prisma.outreachAttempt.findUnique({ where: { id: 'gone' } })
    expect(gone?.failureCode, "the profile-gone park — the recipient's own 7-day stop").toBe('profile-gone')
    const live = await prisma.outreachAttempt.findUnique({ where: { id: 'live' } })
    expect(live?.status, 'the send in flight must have a row to record its delivery on').toBe('SENDING')
    const replied = await prisma.outreachAttempt.findUnique({ where: { id: 'replied' } })
    expect(replied?.replyPostedAt, 'the reply — the permanent "they know us" fact').not.toBeNull()
    expect(replied?.replyText).toBe('Hi, what are your rates?')

    expect(await prisma.auditLog.count({ where: { action: 'sender.deleted' } })).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'sender.retired' } })).toBe(1)
    expect(r.message).toContain('retired')
    expect(r.message).toContain('may have reached')
    expect(r.message).toContain('being sent right now')
    expect(r.message).toContain('reply')
  })

  /**
   * THE PAIR CASCADE TOO. An attempt whose denormalised `senderId` drifted from its pair's is not
   * this account's by the `attempts` relation, and the pair cascade takes it all the same.
   */
  it('retires rather than deletes when a pair of its holds an attempt whose senderId drifted', async () => {
    await sender('leaving')
    await sender('alpha')
    await target('t_drift')
    await attempt('drifted', 'leaving', 't_drift', { status: 'FAILED', failureCode: 'not-in-thread', senderId: 'alpha' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    expect(await prisma.senderAccount.count({ where: { handle: 'leaving' } })).toBe(1)
    expect(await prisma.outreachAttempt.count({ where: { id: 'drifted' } }), 'the pair cascade must not run').toBe(1)
  })

  it('an undatable reply on a superseded draft keeps the account too', async () => {
    await sender('leaving')
    await sender('alpha')
    await target('t_reply')
    await attempt('undated', 'leaving', 't_reply', { status: 'SKIPPED', undatedReply: true, error: SUPERSEDED_BY_REPLY })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    expect(await prisma.senderAccount.count({ where: { handle: 'leaving' } })).toBe(1)
    expect((await prisma.outreachAttempt.findUnique({ where: { id: 'undated' } }))?.repliedAt).not.toBeNull()
  })

  /**
   * THE THIRD CASCADE EDGE. The old re-pointing hand-off moved drafts onto other pages' pairs
   * still carrying the leaving account's `variantId`, and `OutreachAttempt.variant` is ON DELETE
   * RESTRICT. Deleting such an account cascades to its variants and THROWS — after `fleetMember`
   * and the hand-off had already committed, so the form only ever said "Could not remove".
   */
  it('retires, rather than throwing, when another account\'s message still carries its variant', async () => {
    await sender('leaving')
    await sender('alpha')
    await target('t_moved')
    await attempt('moved', 'alpha', 't_moved', { status: 'SENT', variantOf: 'leaving' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    expect(await prisma.senderAccount.count({ where: { handle: 'leaving' } })).toBe(1)
    expect(await prisma.outreachAttempt.count({ where: { id: 'moved' } })).toBe(1)
    expect(r.message).toContain('using its stored text')
  })

  it('withdraws a draft no other account can take, and then deletes an account that held nothing else', async () => {
    await sender('leaving')
    await target('t_lonely')
    await attempt('lonely', 'leaving', 't_lonely', { status: 'READY' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    expect(await prisma.senderAccount.count({ where: { handle: 'leaving' } })).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped', entity: 'OutreachAttempt:lonely' } })).toBe(1)
    expect(r.message).toContain('1 withdrawn unsent')
    expect(r.message, 'nothing stayed with a deleted account').not.toMatch(/stay|kept with/i)
  })

  it('still DELETES an account whose every message was released unsent, with nothing recorded on them', async () => {
    await sender('leaving')
    await sender('alpha')
    await target('t_waiting')
    await target('t_old')
    await attempt('draft', 'leaving', 't_waiting', { status: 'READY' })
    await attempt('released', 'leaving', 't_old', { status: 'SKIPPED' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    expect(await prisma.senderAccount.count({ where: { handle: 'leaving' } })).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'sender.deleted' } })).toBe(1)
    expect(r.message).toContain('Removed @leaving')
    expect(r.message, 'nothing stayed with a deleted account').not.toMatch(/stay|kept with/i)
    // The released draft's recipient is written to by the rotation, not dropped.
    expect(await prisma.outreachPair.count({ where: { senderId: 'alpha', targetId: 't_waiting' } })).toBe(1)
  })
})

describe('a retired account stays readable and never sends by itself', () => {
  /**
   * NOT PAUSED. The reply sweep reads only ACTIVE senders' threads, so a PAUSED retired account's
   * conversations dropped out of it — 430 for @bachelorssociety, 299 never read (1 Sept).
   */
  it('a delivered account is retired with its status untouched — ACTIVE stays ACTIVE', async () => {
    await sender('leaving')
    await sender('alpha')
    await target('t_sent')
    await attempt('sent', 'leaving', 't_sent', { status: 'SENT' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    const row = await prisma.senderAccount.findUniqueOrThrow({ where: { handle: 'leaving' } })
    expect(row.status, 'PAUSED hides its conversations from the reply sweep').toBe('ACTIVE')
    expect(row.fleetMember).toBe(false)
    expect(r.message).toContain('1 delivered')
  })

  it('never clears a CHALLENGED flag as a side effect', async () => {
    await sender('leaving', { status: 'CHALLENGED' })
    await sender('alpha')
    await target('t_sent')
    await attempt('sent', 'leaving', 't_sent', { status: 'SENT' })

    await removeSender('leaving')
    expect((await prisma.senderAccount.findUniqueOrThrow({ where: { handle: 'leaving' } })).status).toBe('CHALLENGED')
  })

  /**
   * THE CONSEQUENCE OF NOT PAUSING. The hand-off KEEPS a draft whose fleet has no other page, and
   * the dispatcher delivers any READY draft of an ACTIVE account — it never reads `fleetMember`.
   * A retired account left ACTIVE holding one would go on sending after it was removed. So nothing
   * waiting may be left on it: the row is kept, released, and audited.
   */
  it('leaves nothing waiting on a retired account for the dispatcher to deliver from it', async () => {
    await sender('leaving')
    await target('t_sent')
    await target('t_lonely')
    await attempt('sent', 'leaving', 't_sent', { status: 'SENT' })
    await attempt('lonely', 'leaving', 't_lonely', { status: 'READY' })

    const r = await removeSender('leaving')
    expect(r.ok).toBe(true)
    const row = await prisma.senderAccount.findUniqueOrThrow({ where: { handle: 'leaving' } })
    expect(row.status).toBe('ACTIVE')
    expect(
      await prisma.outreachAttempt.count({ where: { senderId: 'leaving', status: { in: ['READY', 'QUEUED'] } } }),
      'a READY draft on a retired ACTIVE account is delivered by the dispatcher',
    ).toBe(0)
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'lonely' } })).status).toBe('SKIPPED')
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped', entity: 'OutreachAttempt:lonely' } })).toBe(1)
    expect(r.message, 'a removed account must not be described as holding a message it will send').not.toMatch(/stayed with/)
  })
})

/**
 * ONE DELETE, AND THE CHECK IS IN IT — a source grep, because the failure mode is a future
 * "simplification" back to a count followed by `delete({ where: { handle } })`, and a count read
 * a moment earlier is passed by a send that lands in between.
 */
describe('the delete statement carries its own guard', () => {
  it('removeSender deletes only through a conditional deleteMany', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/actions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    const start = src.indexOf('export async function removeSender(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toMatch(/senderAccount\.delete\(/)
    expect(body).not.toMatch(/status:\s*'PAUSED'/)
    const del = body.match(/senderAccount\.deleteMany\(\{[\s\S]*?\}\)\s*\n/)
    expect(del, 'no conditional deleteMany in removeSender').not.toBeNull()
    expect(del![0]).toMatch(/attempts:\s*\{\s*none:/)
    expect(del![0]).toMatch(/pairs:\s*\{\s*none:\s*\{\s*attempts:\s*\{\s*some:/)
    expect(del![0]).toMatch(/variants:\s*\{\s*none:\s*\{\s*attempts:\s*\{\s*some:/)
  })
})

/**
 * THE FORM SAYS WHAT THE ACTION DOES. Its own prose promised "a message that may already have
 * reached someone stays with this account" above an action that deleted such messages. The words
 * now come from the module that also writes the result sentence.
 */
describe('the remove form describes the rule the action enforces', () => {
  it('renders the shared description, not its own copy of the old rule', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/senders/remove-form.tsx'), 'utf8')
    expect(src).toMatch(/\{REMOVE_SENDER_BLURB\}/)
    expect(src).not.toMatch(/already delivered messages is\s+retired/)
  })
})
