import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * OUR INTRODUCTION NEVER GOES TO A COMPANY THAT ALREADY KNOWS US — H5, the real gate.
 *
 * Tabish, 2026-09-04: *"if the 7 day period has passed and they have replied then we don't
 * need to ever send the normal message to them again ever."* The composers obey it. A DRAFT
 * written before the reply did not, and this file is the trace that proved it, kept as the
 * regression: page A delivered the standard message, the recipient replied to A, page B still
 * held a READY first-touch introduction written before the reply. At HEAD eef825b
 * `recheckBeforeSend(B)` returned `{ ok: true }` in pair scope; in target scope it returned
 * `target-replied` for seven days and then `{ ok: true }`.
 *
 * ── NO SESSION MOCK, ON PURPOSE ────────────────────────────────────────────
 *
 * A seeded account can never hold a session (the gate reads the real credential directory,
 * which a test must never write), so a send that passes every rule here ends at
 * `no-session`. The new stop is asked BEFORE that, so it is visible exactly as it matters —
 * and the control case below, the same seed with no reply and no delivery, ends at
 * `no-session`, which is what proves the stop is not simply refusing everything.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-intro-after-reply-'))
const dbPath = join(dir, 'intro.db')

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
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')

const A = 'page_a'
const B = 'page_b'
const T = 'knows_us_co'
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function attemptForGate(id: string) {
  return prisma.outreachAttempt.findUniqueOrThrow({
    where: { id },
    include: { pair: { include: { sender: true, target: true } } },
  })
}

async function seedSender(handle: string) {
  await prisma.senderAccount.create({
    data: {
      id: handle,
      handle,
      displayName: handle,
      cohort: 1,
      status: 'ACTIVE',
      personaName: '',
      personaRole: '',
      personaBrand: '',
      personaPhone: '',
      personaEmail: '',
    },
  })
}

/** Page A's delivered introduction — and, when `replyAgo` is given, the recipient's DATED reply to it. */
async function aDelivered(replyAgo: number | null) {
  await prisma.outreachAttempt.create({
    data: {
      id: 'a_delivered',
      pairId: 'pair_a',
      senderId: A,
      targetId: T,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: SINGLE_TEMPLATE_MIDDLE,
      status: replyAgo === null ? 'SENT' : 'REPLIED',
      sentAt: new Date(Date.now() - (replyAgo === null ? 2 * DAY : replyAgo + HOUR)),
      repliedAt: replyAgo === null ? null : new Date(Date.now() - replyAgo),
      replyPostedAt: replyAgo === null ? null : new Date(Date.now() - replyAgo),
      replyText: replyAgo === null ? null : 'Hi, let us talk',
    },
  })
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  await seedSender(A)
  await seedSender(B)
  await prisma.targetAccount.create({
    data: { id: T, handle: T, displayName: 'Knows Us Co', kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })
  await prisma.outreachPair.create({ data: { id: 'pair_a', senderId: A, targetId: T } })
  await prisma.outreachPair.create({ data: { id: 'pair_b', senderId: B, targetId: T } })
  /* Two paid posts naming them, so the material allowance never answers first in the control. */
  for (const [i, sc] of ['INTROAAAAAA', 'INTROBBBBBB'].entries()) {
    await prisma.detectedCampaign.create({
      data: {
        id: `dc${i}`,
        targetId: 'some_channel',
        shortcode: sc,
        permalink: `https://www.instagram.com/p/${sc}/`,
        caption: `a detected paid post mentioning @${T}`,
        verdict: 'CAMPAIGN',
        postedAt: new Date(Date.now() - (i + 1) * HOUR),
      },
    })
  }
  /* Page B's introduction, written before anything else happened — a first touch, standard bytes. */
  await prisma.outreachAttempt.create({
    data: {
      id: 'b_intro',
      pairId: 'pair_b',
      senderId: B,
      targetId: T,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: SINGLE_TEMPLATE_MIDDLE,
      status: 'READY',
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

const gateFor = async (id: string) => recheckBeforeSend(await attemptForGate(id), { unattended: true })

describe('an introduction written before the recipient replied is never sent', () => {
  it('pair scope (the default): page B is not reply-halted, and the introduction is still refused', async () => {
    await aDelivered(HOUR)
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: our introduction to a company already talking to us went out')
    expect(gate.reason).toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })

  it('target scope, reply an hour old: the permanent fact is named, not the halt that "resumes on its own"', async () => {
    await prisma.setting.create({ data: { key: 'replyHaltScope', value: 'target' } })
    await aDelivered(HOUR)
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: refused by the reply halt at least')
    expect(gate.reason).toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })

  it('target scope, reply EIGHT days old: the halt has lapsed and the introduction is still refused', async () => {
    await prisma.setting.create({ data: { key: 'replyHaltScope', value: 'target' } })
    await aDelivered(8 * DAY)
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: our introduction went out once the seven days had passed')
    expect(gate.reason).toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })

  it('an override saved since the draft was written does not hide the shipped-copy introduction', async () => {
    await prisma.setting.create({
      data: { key: 'singleTemplateBody', value: 'Hi,An override of the standard message, long enough to be a sendable template.' },
    })
    await aDelivered(HOUR)
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: the shipped introduction slipped through once an override existed')
    expect(gate.reason).toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })

  it('no reply anywhere, but page B has ALREADY delivered — the queued introduction is not its second message', async () => {
    await aDelivered(null)
    await prisma.outreachAttempt.create({
      data: {
        id: 'b_delivered',
        pairId: 'pair_b',
        senderId: B,
        targetId: T,
        variantId: 'v1',
        touchNumber: 1,
        /* Different bytes (the copy was edited between the two writes), so IDENTICAL cannot answer. */
        renderedBody: 'Hi,An earlier standard message that has since been edited, delivered by the on-demand dialog.',
        status: 'SENT',
        sentAt: new Date(Date.now() - 3 * HOUR),
      },
    })
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: an introduction went out as this page’s second message')
    expect(gate.reason).toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })

  it('CONTROL: no reply and no delivery from B — a genuine first touch reaches the session check', async () => {
    await aDelivered(null)
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: a seeded account cannot be clear to send')
    expect(gate.reason).toBe(RESEND_BLOCKS.NO_SESSION)
  })

  it('CONTROL: a follow-up-shaped draft to the replier is not this stop', async () => {
    await aDelivered(HOUR)
    await prisma.outreachAttempt.update({
      where: { id: 'b_intro' },
      data: { renderedBody: 'Hi,Following up on your Toxic placement on 8 Oct — we can put that same campaign in front of 300M+ views.' },
    })
    const gate = await gateFor('b_intro')
    if (gate.ok) throw new Error('unexpected: a seeded follow-up with no copy written cannot be clear to send')
    expect(gate.reason).not.toBe(RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US)
  })
})
