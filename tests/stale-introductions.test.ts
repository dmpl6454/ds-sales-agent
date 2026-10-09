import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE PLANNER'S SWEEP FOR INTRODUCTIONS THE GATE WILL NEVER SEND (H5) — against a real database.
 *
 * The gate refuses our introduction to a company that already knows us. A refusal alone would
 * stall the recipient: the refused draft is never replaced while it waits, and the turn passes
 * only on a delivery. So the planner discards it at the top of every pass, through
 * `discardAttempt` — the ONE writer, audited — and this file proves it discards exactly that
 * class: not a genuine first touch, not a follow-up, not a row a browser is typing, not a
 * parked failure a person must settle.
 *
 * A real database because the sweep is assembled from Prisma `where`s, and a query filter is a
 * property of the generated client rather than of a pure function (the `skipDuplicates` lesson).
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-stale-intro-'))
const dbPath = join(dir, 'sweep.db')

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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");

  CREATE TABLE "Category" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL UNIQUE,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategorySender" (
    "id" TEXT PRIMARY KEY, "categoryId" TEXT NOT NULL, "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0, "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategoryTarget" (
    "id" TEXT PRIMARY KEY, "categoryId" TEXT NOT NULL, "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "brandCategory" TEXT,
    "isVerified" BOOLEAN,
    "followerCount" INTEGER,
    "campaignTalent" BOOLEAN NOT NULL DEFAULT false,
    "discoveredFromCampaignId" TEXT,
    "importNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");

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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key" ON "OutreachPair"("senderId", "targetId");

  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL REFERENCES "OutreachPair"("id") ON DELETE CASCADE,
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
    "replyHandledBy" TEXT
  );

  CREATE TABLE "DetectedCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL UNIQUE,
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
    "frameText" TEXT
  );

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { discardIntroductionsToRecipientsWhoKnowUs } = await import('@/outreach/staleIntroductions')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')

const SETTINGS = { singleTemplateBody: null, fleetTemplateBodies: new Map<string, string>() }
const HOUR = 3_600_000
const FOLLOW_UP_BODY = 'Hi,Following up on your Toxic placement on 8 Oct — we can put that same campaign in front of 300M+ views.'

async function seedSender(handle: string) {
  await prisma.senderAccount.create({
    data: { id: handle, handle, displayName: handle, cohort: 1, status: 'ACTIVE', personaName: '', personaRole: '', personaBrand: '', personaPhone: '', personaEmail: '' },
  })
}
async function seedTarget(handle: string) {
  await prisma.targetAccount.create({
    data: { id: handle, handle, displayName: handle, kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })
}
async function pair(sender: string, target: string) {
  await prisma.outreachPair.create({ data: { id: `p_${sender}_${target}`, senderId: sender, targetId: target } })
}
async function attempt(id: string, sender: string, target: string, data: Record<string, unknown>) {
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: `p_${sender}_${target}`,
      senderId: sender,
      targetId: target,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: SINGLE_TEMPLATE_MIDDLE,
      status: 'READY',
      ...data,
    },
  })
}
const statusOf = async (id: string) => (await prisma.outreachAttempt.findUniqueOrThrow({ where: { id } })).status

beforeEach(async () => {
  await prisma.auditLog.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})

  for (const s of ['a', 'b', 'c']) await seedSender(s)
  /* REPLIED: answered page A. FRESH: never heard from us. WROTE: page B already delivered, no reply. */
  for (const t of ['replied', 'fresh', 'wrote']) await seedTarget(t)
  for (const s of ['a', 'b', 'c']) for (const t of ['replied', 'fresh', 'wrote']) await pair(s, t)

  await attempt('a_to_replied', 'a', 'replied', {
    status: 'REPLIED',
    sentAt: new Date(Date.now() - 3 * HOUR),
    repliedAt: new Date(Date.now() - HOUR),
    replyPostedAt: new Date(Date.now() - HOUR),
  })
  await attempt('b_delivered_wrote', 'b', 'wrote', {
    status: 'SENT',
    renderedBody: 'an earlier, since-edited standard message delivered from the on-demand dialog',
    sentAt: new Date(Date.now() - 2 * HOUR),
  })

  await attempt('b_intro_replied', 'b', 'replied', {}) // the founding case — discarded
  await attempt('c_intro_replied_queued', 'c', 'replied', { status: 'QUEUED' }) // QUEUED too — discarded
  await attempt('b_intro_fresh', 'b', 'fresh', {}) // a genuine first touch — kept
  await attempt('c_followup_fresh', 'c', 'fresh', { renderedBody: FOLLOW_UP_BODY, touchNumber: 2 }) // not a standard body — kept
  await attempt('b_intro_wrote', 'b', 'wrote', {}) // this page already delivered here — discarded
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('the planner discards introductions to recipients who already know us', () => {
  it('discards exactly the introductions the gate would refuse, and audits each as the planner', async () => {
    const r = await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    expect(r.discarded).toBe(3)
    expect(await statusOf('b_intro_replied')).toBe('SKIPPED')
    expect(await statusOf('c_intro_replied_queued')).toBe('SKIPPED')
    expect(await statusOf('b_intro_wrote')).toBe('SKIPPED')

    const audit = await prisma.auditLog.findMany({ where: { action: 'attempt.skipped' }, orderBy: { entity: 'asc' } })
    expect(audit.map((x) => x.entity)).toEqual([
      'OutreachAttempt:b_intro_replied',
      'OutreachAttempt:b_intro_wrote',
      'OutreachAttempt:c_intro_replied_queued',
    ])
    expect(new Set(audit.map((x) => x.actor))).toEqual(new Set(['planner']))
  })

  it('leaves a genuine first touch, and a follow-up, alone', async () => {
    await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    expect(await statusOf('b_intro_fresh')).toBe('READY')
    expect(await statusOf('c_followup_fresh')).toBe('READY')
  })

  it('a follow-up-shaped draft TO THE REPLIER is left alone — only the introduction bytes are refused', async () => {
    await attempt('a_followup_replied', 'a', 'replied', { renderedBody: FOLLOW_UP_BODY, touchNumber: 2 })
    await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    expect(await statusOf('a_followup_replied')).toBe('READY')
  })

  it('never touches a SENDING row or a FAILED park — a browser mid-paste, and a person’s to settle', async () => {
    await prisma.outreachAttempt.update({ where: { id: 'b_intro_replied' }, data: { status: 'SENDING' } })
    await prisma.outreachAttempt.update({
      where: { id: 'c_intro_replied_queued' },
      data: { status: 'FAILED', failureCode: 'no-composer' },
    })
    const r = await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    expect(await statusOf('b_intro_replied')).toBe('SENDING')
    expect(await statusOf('c_intro_replied_queued')).toBe('FAILED')
    expect(r.discarded).toBe(1) // b_intro_wrote only
  })

  it('is idempotent — a second pass finds nothing to do', async () => {
    await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    const again = await discardIntroductionsToRecipientsWhoKnowUs({ settings: SETTINGS, actor: 'planner' })
    expect(again.discarded).toBe(0)
  })

  /**
   * WIRED IN, not just written — "a feature nobody calls is not running" (the 166 cover frames,
   * `resetBrandResolverLimit`). There is no harness that runs `runOutreach` against a real
   * database, so this is a source check: the sweep is called in `runOutreach`, inside a `try`
   * so it can never fail a planning pass, and BEFORE the pairs are read, so the same pass can
   * draft that page's follow-up.
   */
  it('runOutreach calls the sweep, inside a try, before it reads the pairs', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(process.cwd(), 'src/outreach/plan.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const start = src.indexOf('export async function runOutreach(')
    expect(start, 'runOutreach not found').toBeGreaterThanOrEqual(0)
    const body = src.slice(start)
    const call = body.indexOf('await discardIntroductionsToRecipientsWhoKnowUs(')
    const pairsRead = body.indexOf('prisma.outreachPair.findMany(')
    expect(call, 'runOutreach no longer calls the sweep').toBeGreaterThan(0)
    expect(pairsRead, 'the pairs read moved — re-check this test').toBeGreaterThan(0)
    expect(call, 'the sweep must run before the pairs and their pending counts are read').toBeLessThan(pairsRead)
    const tryAt = body.lastIndexOf('try {', call)
    const catchAt = body.indexOf('} catch', call)
    expect(tryAt, 'the sweep is not inside a try — a failure would fail the planning pass').toBeGreaterThan(0)
    expect(catchAt).toBeGreaterThan(call)
    expect(body.slice(tryAt, call)).not.toContain('}')
  })
})
