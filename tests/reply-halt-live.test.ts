import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A RING PAUSED ONLY BY REPLIES IS RESTING, NOT STUCK — audit H9, the real `buildRestTally`.
 *
 * Under the pair scope Tabish chose on 2026-09-01, a reply blocks its page's ROUTE, so rotation
 * never elects a reply-paused page and the tally's elected-halt check cannot fire. A recipient who
 * replied to every page in their rotation — a one-page ring is enough — was therefore
 * `all-unavailable` and landed in ROTATION_STUCK: "needs a person", "not on a clock", sending
 * somebody hunting a sign-in fault for a hold that frees ITSELF when the first page's halt ends.
 *
 * Driven against a real database because the fact is assembled from four maps over one read
 * (replies, parks, account availability, the ring), and a pure mirror of that assembly would agree
 * with itself either way.
 *
 *   one page, reply-paused                     → TARGET_REPLIED, released at the halt's end
 *   one page reply-paused, the other signed out → ROTATION_STUCK (a mixed cause stays a person's)
 *   target scope                               → TARGET_REPLIED with the target sentence
 *
 * And the /targets row over the same rows (`buildProspectsPage`): it said "messaging pauses for
 * seven days" while naming the next page writing to them — under the pair scope the row must name
 * the page they answered and say the others may still write ONLY when one will; under the target
 * scope it must not name a next page at all.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-rest-reply-'))
const dbPath = join(dir, 'rest.db')

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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { buildRestTally } = await import('@/app/view-model/rest-tally')
const { buildProspectsPage } = await import('@/app/view-model/prospects-page')
const { SKIP_REASONS } = await import('@/outreach/governor')

const HOUR = 3_600_000
const NOW = new Date()
const WROTE = new Date(NOW.getTime() - 24 * HOUR)

async function seedSender(handle: string, signedIn: boolean) {
  await prisma.senderAccount.create({
    data: {
      id: handle,
      handle,
      displayName: handle,
      cohort: 1,
      status: 'ACTIVE',
      fleetMember: true,
      sessionPath: signedIn ? `/p/${handle}` : null,
      personaName: '',
      personaRole: '',
      personaBrand: '',
      personaPhone: '',
      personaEmail: '',
    },
  })
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  await seedSender('pap', true)
  await prisma.targetAccount.create({
    data: { id: 'co', handle: 'co', displayName: 'Co', kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })
  await prisma.outreachPair.create({ data: { id: 'pair_pap', senderId: 'pap', targetId: 'co' } })
  /* What @pap delivered, and their DATED answer to it, inside the window — the halt is active. */
  await prisma.outreachAttempt.create({
    data: {
      id: 'delivered',
      pairId: 'pair_pap',
      senderId: 'pap',
      targetId: 'co',
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: 'the introduction',
      status: 'REPLIED',
      sentAt: new Date(NOW.getTime() - 48 * HOUR),
      repliedAt: WROTE,
      replyPostedAt: WROTE,
      replyText: 'Tell me more',
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

const bucket = (t: Awaited<ReturnType<typeof buildRestTally>>, reason: string) => t.byReason.find((r) => r.reason === reason)

describe('a reply-paused ring under the pair scope', () => {
  it('a one-page ring paused by a reply is TARGET_REPLIED, on a clock — not stuck, not a person’s', async () => {
    const t = await buildRestTally(NOW)
    const replied = bucket(t, SKIP_REASONS.TARGET_REPLIED)
    expect(replied?.count, JSON.stringify(t.byReason)).toBe(1)
    expect(replied!.needsAPerson).toBe(false)
    expect(replied!.nextReleaseAt?.getTime()).toBe(WROTE.getTime() + 168 * HOUR)
    expect(replied!.label).toMatch(/every page in their rotation/)
    expect(bucket(t, 'no-account-can-write')).toBeUndefined()
  })

  it('a ring where a reply is only ONE of the causes stays stuck, and the sentence names replies', async () => {
    await seedSender('soc', false) // never signed in
    await prisma.outreachPair.create({ data: { id: 'pair_soc', senderId: 'soc', targetId: 'co' } })
    const t = await buildRestTally(NOW)
    const stuck = bucket(t, 'no-account-can-write')
    expect(stuck?.count, JSON.stringify(t.byReason)).toBe(1)
    expect(stuck!.label).toMatch(/replied/)
    expect(bucket(t, SKIP_REASONS.TARGET_REPLIED)).toBeUndefined()
  })

  /**
   * Replies must be the WHOLE cause. A page that is reply-paused AND signed out is still waiting on
   * a sign-in, so the ring is a mixed case — even though every page carries a reply.
   */
  it('every page reply-paused but one also signed out is still stuck', async () => {
    await seedSender('soc', false)
    await prisma.outreachPair.create({ data: { id: 'pair_soc', senderId: 'soc', targetId: 'co' } })
    await prisma.outreachAttempt.create({
      data: {
        id: 'delivered_soc',
        pairId: 'pair_soc',
        senderId: 'soc',
        targetId: 'co',
        variantId: 'v1',
        touchNumber: 1,
        renderedBody: 'the introduction, from soc',
        status: 'REPLIED',
        sentAt: new Date(NOW.getTime() - 72 * HOUR),
        repliedAt: WROTE,
        replyPostedAt: WROTE,
        replyText: 'Who is this?',
      },
    })
    const t = await buildRestTally(NOW)
    expect(bucket(t, 'no-account-can-write')?.count, JSON.stringify(t.byReason)).toBe(1)
    expect(bucket(t, SKIP_REASONS.TARGET_REPLIED)).toBeUndefined()
  })

  /** …and a page that is reply-paused AND holding a parked send is waiting on a person too. */
  it('a reply-paused page that also holds a parked send is still stuck', async () => {
    await prisma.outreachAttempt.create({
      data: {
        id: 'parked',
        pairId: 'pair_pap',
        senderId: 'pap',
        targetId: 'co',
        variantId: 'v2',
        touchNumber: 2,
        renderedBody: 'a follow-up that may have reached them',
        status: 'FAILED',
        failureCode: 'not-in-thread',
        queuedAt: new Date(NOW.getTime() - 30 * HOUR),
      },
    })
    const t = await buildRestTally(NOW)
    expect(bucket(t, 'no-account-can-write')?.count, JSON.stringify(t.byReason)).toBe(1)
    expect(bucket(t, SKIP_REASONS.TARGET_REPLIED)).toBeUndefined()
  })

  it('the window is the Setting: 48 hours reads two days and releases two days after they wrote', async () => {
    await prisma.setting.create({ data: { key: 'replyResumeHours', value: '48' } })
    const t = await buildRestTally(NOW)
    const replied = bucket(t, SKIP_REASONS.TARGET_REPLIED)!
    expect(replied.nextReleaseAt?.getTime()).toBe(WROTE.getTime() + 48 * HOUR)
    expect(replied.label).toMatch(/two days/)
    expect(t.replyHaltSpan).toBe('two days')
  })
})

describe('under the target scope', () => {
  it('the elected page is halted and the sentence says every page pauses', async () => {
    await prisma.setting.create({ data: { key: 'replyHaltScope', value: 'target' } })
    const t = await buildRestTally(NOW)
    const replied = bucket(t, SKIP_REASONS.TARGET_REPLIED)
    expect(replied?.count, JSON.stringify(t.byReason)).toBe(1)
    expect(replied!.label).toMatch(/every one of our pages/)
  })
})

describe('the /targets row says what the reply pauses', () => {
  const row = async () => (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!

  it('pair, another page able to write: names the page they answered, and the other page writes next', async () => {
    await seedSender('soc', true)
    await prisma.outreachPair.create({ data: { id: 'pair_soc', senderId: 'soc', targetId: 'co' } })
    const p = await row()
    expect(p.replied).toBe(true)
    expect(p.nextSenderWillWrite, p.nextSenderSentence).toBe(true)
    expect(p.nextSenderSentence).toMatch(/@soc/)
    expect(p.replyNote).toMatch(/They replied to @pap — that page is paused until .* IST; our other pages may still write to them/)
    expect(p.replyNote).not.toMatch(/every one of our pages|seven days/)
  })

  it('pair, the only page is the one they answered: no promise that another page writes', async () => {
    const p = await row()
    expect(p.nextSenderWillWrite).toBe(false)
    expect(p.replyNote).toMatch(/They replied to @pap/)
    expect(p.replyNote).not.toMatch(/other pages may still write/)
  })

  it('target: every page is paused, and the row names no next page', async () => {
    await prisma.setting.create({ data: { key: 'replyHaltScope', value: 'target' } })
    await seedSender('soc', true)
    await prisma.outreachPair.create({ data: { id: 'pair_soc', senderId: 'soc', targetId: 'co' } })
    const p = await row()
    expect(p.nextSenderWillWrite).toBe(false)
    expect(p.nextSenderSentence).toMatch(/Nothing is written to them until .* IST — they replied, and a reply pauses every page/)
    expect(p.nextSenderSentence).not.toMatch(/@soc/)
    expect(p.replyNote).toMatch(/every one of our pages is paused/)
  })
})
