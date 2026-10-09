import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE 7-DAY RING REST FIRES FOR A BOLLYWOOD RECIPIENT — M12, the real gate, a real database.
 *
 * Tabish, 2026-08-19: *"the 7 day constraint which should occur only if target has been
 * contacted by all targets"*. "All" can only mean the pages that are ALLOWED to write to the
 * recipient: his 25 Aug rule forbids the marketing page from writing to a bollywood company
 * at all. Until 2026-10-09 the ring rule counted the whole fleet, so @madaboutmarketingg —
 * marketing only, never able to deliver here — kept "every page has written" false forever
 * for every bollywood recipient, and the rest never fired on the fleet that sends most.
 *
 * `tests/cross-spacing.test.ts` proves the PURE verdict narrows the ring. This proves the gate
 * HANDS it what it needs — the recipient's handle and the memberships read from the real join
 * tables — because a pure verdict that is right and a caller that passes the wrong input is
 * the half-wired rule this codebase keeps finding.
 *
 * ── THE FIXTURE, AND WHY EACH PART IS THERE ────────────────────────────────
 *
 *   - `profileStatus` is mocked to "has a session": NO_SESSION is asked before spacing, and a
 *     test must never write into the real credential directory.
 *   - SIX paid posts name the recipient, so the material allowance (6) is not spent by the
 *     four deliveries and MATERIAL_EXHAUSTED cannot answer first.
 *   - The draft's body differs from what its page delivered, so IDENTICAL cannot answer first.
 *   - Deliveries are 1-3 days old, so FOLLOW_UP_SAME_DAY cannot answer first.
 *   - No follow-up copy is written, so WITHOUT the fix the gate falls through to
 *     `follow-up-template-not-set` — a different, visible reason, which is what the mutation
 *     (passing the unfiltered fleet) produces.
 */

vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))

const dir = mkdtempSync(join(tmpdir(), 'ds-ring-rest-fleet-'))
const dbPath = join(dir, 'ring.db')

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
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { recheckBeforeSend, RESEND_BLOCKS } = await import('@/outreach/gate')

/** The four bollywood pages send for BOTH fleets (sender-fleets.ts, 2026-09-04); the marketing page for one. */
const BOLLYWOOD = ['chron', 'soc', 'pap', 'tf']
const MARKETING_ONLY = 'mad'
const RECIPIENT = 'bollywood_co'
const DAY = 86_400_000

async function seedSender(handle: string) {
  await prisma.senderAccount.create({
    data: {
      id: handle,
      handle,
      displayName: handle,
      cohort: 1,
      status: 'ACTIVE',
      fleetMember: true,
      sessionPath: `/p/${handle}`,
      personaName: '',
      personaRole: '',
      personaBrand: '',
      personaPhone: '',
      personaEmail: '',
    },
  })
}

async function attemptForGate(id: string) {
  return prisma.outreachAttempt.findUniqueOrThrow({
    where: { id },
    include: { pair: { include: { sender: true, target: true } } },
  })
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.categorySender.deleteMany({})
  await prisma.categoryTarget.deleteMany({})
  await prisma.category.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  await prisma.category.create({ data: { id: 'c_boll', name: 'Bollywood', slug: 'bollywood' } })
  await prisma.category.create({ data: { id: 'c_mkt', name: 'Marketing', slug: 'marketing' } })
  for (const h of BOLLYWOOD) {
    await seedSender(h)
    await prisma.categorySender.create({ data: { id: `cs_b_${h}`, categoryId: 'c_boll', senderId: h } })
    await prisma.categorySender.create({ data: { id: `cs_m_${h}`, categoryId: 'c_mkt', senderId: h } })
  }
  await seedSender(MARKETING_ONLY)
  await prisma.categorySender.create({ data: { id: `cs_m_${MARKETING_ONLY}`, categoryId: 'c_mkt', senderId: MARKETING_ONLY } })

  /* A bollywood prospect carries NO membership row — the default fleet. */
  await prisma.targetAccount.create({
    data: { id: RECIPIENT, handle: RECIPIENT, displayName: 'Bollywood Co', kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })

  for (let i = 0; i < 6; i++) {
    const shortcode = `RINGREST00${i}`
    await prisma.detectedCampaign.create({
      data: {
        id: `dc${i}`,
        targetId: 'some_channel',
        shortcode,
        permalink: `https://www.instagram.com/p/${shortcode}/`,
        caption: `a detected paid post mentioning @${RECIPIENT}`,
        verdict: 'CAMPAIGN',
        postedAt: new Date(Date.now() - (i + 1) * 3_600_000),
      },
    })
  }

  /* Every bollywood page has written to them in the last week — 1 to 3 days ago, never today. */
  for (const [i, h] of BOLLYWOOD.entries()) {
    await prisma.outreachPair.create({ data: { id: `pair_${h}`, senderId: h, targetId: RECIPIENT } })
    await prisma.outreachAttempt.create({
      data: {
        id: `delivered_${h}`,
        pairId: `pair_${h}`,
        senderId: h,
        targetId: RECIPIENT,
        variantId: 'v1',
        touchNumber: 1,
        renderedBody: `the introduction ${h} sent`,
        status: 'SENT',
        sentAt: new Date(Date.now() - (1 + (i % 3)) * DAY),
      },
    })
  }

  /* The next message, from the first bollywood page. */
  await prisma.outreachAttempt.create({
    data: {
      id: 'waiting',
      pairId: 'pair_chron',
      senderId: 'chron',
      targetId: RECIPIENT,
      variantId: 'v2',
      touchNumber: 2,
      renderedBody: 'a different second message naming a post of theirs',
      status: 'READY',
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('the ring rest at the gate counts the pages that can write to THIS recipient', () => {
  it('a bollywood recipient every bollywood page has written to is resting — the marketing page is not one of "all"', async () => {
    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: false })
    if (gate.ok) throw new Error('unexpected: every page that can write here has written, so the recipient rests')
    expect(gate.reason).toBe(RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED)
    expect(gate.detail).toContain('all 4')
  })

  it('the negative direction: one bollywood page yet to write means no rest', async () => {
    await prisma.outreachAttempt.delete({ where: { id: 'delivered_tf' } })
    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: false })
    if (gate.ok) throw new Error('unexpected: a seeded follow-up with no follow-up copy cannot be clear to send')
    expect(gate.reason).not.toBe(RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED)
  })

  it('a MARKETING-fleet recipient still waits for the marketing page — it can write there', async () => {
    await prisma.categoryTarget.create({ data: { id: 'ct', categoryId: 'c_mkt', targetId: RECIPIENT } })
    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: false })
    if (gate.ok) throw new Error('unexpected: a seeded follow-up with no follow-up copy cannot be clear to send')
    expect(gate.reason).not.toBe(RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED)
  })
})
