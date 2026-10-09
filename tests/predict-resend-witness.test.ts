import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE QUEUE'S HEAD ROW ASKS THE SENDING MAC'S DISK, AND NOTHING ELSE DOES — audit H8, the real
 * gate against a real database.
 *
 * On the hosted Linode there is no `~/.ds-sales-agent` at all, so `recheckBeforeSend` answered
 * "account is not connected" for every draft: the head row of the queue could never say anything
 * else, under a switch card saying the Studio sends. `predictResendForQueue` is the same gate with
 * ONE input swapped — the sending Mac's published handles stand in for this disk — and it is
 * display-only.
 *
 * Four cases, and the first is the one that carries the safety weight: ENFORCEMENT still reads
 * THIS disk. The fixture handle is one no real Chrome profile can have, so the real
 * `profileStatus` answers "no session" without this test ever touching the credential directory
 * (it only reads). `profileStatus` is deliberately NOT mocked — mocking it would make case (a)
 * vacuous, and (a) is what fails if `recheckBeforeSend`'s default witness is ever anything but
 * this disk.
 *
 *   (a) recheckBeforeSend                         → no-session  (this disk holds no profile)
 *   (b) predictResendForQueue, handle in witness  → past no-session (the first test able to reach it)
 *   (c) predictResendForQueue, empty witness      → no-session
 *   (d) …handle in witness, session PROVED dead   → no-session  (`sessionInvalidAt` still folds in)
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-predict-witness-'))
const dbPath = join(dir, 'witness.db')

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
const { recheckBeforeSend, predictResendForQueue, RESEND_BLOCKS } = await import('@/outreach/gate')

/** No real profile can carry this name, so this machine's disk answers "no session" for it. */
const SENDER = 'zz_fixture_sender'
const TARGET = 'zz_fixture_target'

async function draft() {
  return prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: 'waiting' },
    include: { pair: { include: { sender: true, target: true } } },
  })
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  await prisma.senderAccount.create({
    data: {
      id: SENDER,
      handle: SENDER,
      displayName: SENDER,
      /* Cohort 1 is the ladder's baseline and always passes, so it cannot answer first. */
      cohort: 1,
      status: 'ACTIVE',
      fleetMember: true,
      /* A recorded hand login — the sending Mac's DB record says it holds this account. */
      sessionPath: `/p/${SENDER}`,
      personaName: '',
      personaRole: '',
      personaBrand: '',
      personaPhone: '',
      personaEmail: '',
    },
  })
  /* Verified, a prospect, never written to and never replied: nothing ahead of NO_SESSION refuses. */
  await prisma.targetAccount.create({
    data: { id: TARGET, handle: TARGET, displayName: 'Fixture Co', kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })
  await prisma.outreachPair.create({ data: { id: 'pair', senderId: SENDER, targetId: TARGET } })
  await prisma.outreachAttempt.create({
    data: {
      id: 'waiting',
      pairId: 'pair',
      senderId: SENDER,
      targetId: TARGET,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: 'a first message',
      status: 'READY',
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('whose disk answers "is this account signed in"', () => {
  it('(a) enforcement still asks THIS disk — recheckBeforeSend refuses with no-session', async () => {
    const gate = await recheckBeforeSend(await draft(), { unattended: true })
    if (gate.ok) throw new Error('unexpected: no profile on this disk can carry the fixture handle')
    expect(gate.reason).toBe(RESEND_BLOCKS.NO_SESSION)
  })

  it('(b) the queue’s prediction asks the SENDING Mac — its handles carry it past no-session', async () => {
    const gate = await predictResendForQueue(await draft(), { device: 'Studio', handles: [SENDER] })
    expect(gate.ok ? 'ok' : gate.reason, 'the sending Mac holds this account, so the session stop must not answer').not.toBe(
      RESEND_BLOCKS.NO_SESSION,
    )
    /* And nothing else in this fixture refuses, so the head row would read "clear". */
    expect(gate.ok, gate.ok ? '' : `${gate.reason}: ${gate.detail ?? ''}`).toBe(true)
  })

  it('(c) a sending Mac that does not hold the account → no-session', async () => {
    const gate = await predictResendForQueue(await draft(), { device: 'Studio', handles: [] })
    if (gate.ok) throw new Error('unexpected: the sending Mac holds no profile for this account')
    expect(gate.reason).toBe(RESEND_BLOCKS.NO_SESSION)
  })

  it('(d) a session PROVED dead still refuses, whatever the witness says', async () => {
    await prisma.senderAccount.update({ where: { id: SENDER }, data: { sessionInvalidAt: new Date() } })
    const gate = await predictResendForQueue(await draft(), { device: 'Studio', handles: [SENDER] })
    if (gate.ok) throw new Error('unexpected: a dead session must never read as connected')
    expect(gate.reason).toBe(RESEND_BLOCKS.NO_SESSION)
  })
})
