import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `handOffWaitingDrafts` — removing a sender must never cost a message (Tabish,
 * 2026-08-19), driven through the REAL Prisma client against a temporary SQLite file,
 * exactly like tests/fleet-pairs.test.ts and for the same reason: the behaviour under
 * test is a chain of `where` clauses and conditional writes, which a pure mirror of the
 * logic would agree with either way.
 *
 * The properties that must hold whatever the queue holds:
 *
 *   - a waiting draft moves to the sender ROTATION would choose (not "any" sender)
 *   - a recipient already covered by another account's draft gets its duplicate
 *     DISCARDED, not doubled — two waiting drafts to one person is the 2026-08-17
 *     incident queued up on purpose
 *   - a retired recipient's draft is discarded, because retirement outranks transfer
 *   - `not-in-thread` rows are UNTOUCHED: the recipient may have that message, and it
 *     must stay on the account that actually sent it
 *   - a parked failure (any other code) transfers with its retry counter reset
 *   - with no other fleet account, drafts stay put rather than vanish
 *   - the moved draft's touchNumber is the RECEIVING pair's history + 1
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-hand-off-'))
const dbPath = join(dir, 'handoff.db')

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
    "replyText" TEXT,
    "replyCheckedAt" DATETIME,
    "replyHandledAt" DATETIME,
    "replyHandledBy" TEXT
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
const { handOffWaitingDrafts } = await import('@/outreach/handOff')
const { fleetRingOrder, nextSender } = await import('@/outreach/rotation')

const persona = {
  personaName: '',
  personaRole: '',
  personaBrand: '',
  personaPhone: '',
  personaEmail: '',
}

async function seedSender(id: string, opts: { fleetMember?: boolean; cohort?: number } = {}) {
  await prisma.senderAccount.create({
    data: {
      id,
      handle: id,
      displayName: id,
      fleetMember: opts.fleetMember ?? true,
      cohort: opts.cohort ?? 1,
      // A recorded session, so `readSenderAvailability` counts this account usable and
      // the strict rotation pass is the one exercised.
      sessionPath: `/tmp/profiles/${id}`,
      ...persona,
    },
  })
}

async function seedTarget(id: string, opts: { optedOut?: boolean } = {}) {
  await prisma.targetAccount.create({
    data: { id, handle: id, displayName: id, kind: 'BRAND', role: 'PROSPECT', optedOut: opts.optedOut ?? false },
  })
}

async function seedDraft(args: {
  id: string
  senderId: string
  targetId: string
  status?: string
  failureCode?: string | null
  attempts?: number
}) {
  await prisma.outreachPair.upsert({
    where: { senderId_targetId: { senderId: args.senderId, targetId: args.targetId } },
    update: {},
    create: { id: `pair_${args.senderId}_${args.targetId}`, senderId: args.senderId, targetId: args.targetId },
  })
  await prisma.outreachAttempt.create({
    data: {
      id: args.id,
      pairId: `pair_${args.senderId}_${args.targetId}`,
      senderId: args.senderId,
      targetId: args.targetId,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: 'the standard template',
      status: args.status ?? 'READY',
      failureCode: args.failureCode ?? null,
      attempts: args.attempts ?? 0,
    },
  })
}

beforeEach(async () => {
  await prisma.auditLog.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('handOffWaitingDrafts', () => {
  it('moves a waiting draft to the sender rotation would choose, audited', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('beta')
    await seedTarget('t_brand')
    await seedDraft({ id: 'd1', senderId: 'leaving', targetId: 't_brand' })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 1, discarded: 0, kept: 0 })

    // The rotation's own answer for a never-messaged recipient on the remaining ring.
    const ring = fleetRingOrder([
      { id: 'alpha', handle: 'alpha', cohort: 1 },
      { id: 'beta', handle: 'beta', cohort: 1 },
    ])
    const expected = nextSender({ ring, lastSenderId: null, targetId: 't_brand' })
    if (!expected.ok) throw new Error('fixture bug: rotation refused')

    const moved = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd1' } })
    expect(moved.senderId).toBe(expected.senderId)
    expect(moved.status).toBe('READY')
    expect(moved.touchNumber).toBe(1)

    const pair = await prisma.outreachPair.findUniqueOrThrow({ where: { id: moved.pairId } })
    expect(pair.senderId).toBe(expected.senderId)
    expect(pair.targetId).toBe('t_brand')

    const audit = await prisma.auditLog.findMany({ where: { action: 'attempt.transferred.handoff' } })
    expect(audit).toHaveLength(1)
  })

  it('discards the duplicate when another account already has a draft for the recipient', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_covered')
    await seedDraft({ id: 'theirs', senderId: 'alpha', targetId: 't_covered' })
    await seedDraft({ id: 'ours', senderId: 'leaving', targetId: 't_covered' })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 0, discarded: 1, kept: 0 })

    const ours = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'ours' } })
    expect(ours.status).toBe('SKIPPED')
    // The other account's draft is untouched.
    const theirs = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'theirs' } })
    expect(theirs.status).toBe('READY')
    expect(theirs.senderId).toBe('alpha')
  })

  it('discards a draft to a retired recipient rather than moving it', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_retired', { optedOut: true })
    await seedDraft({ id: 'd_retired', senderId: 'leaving', targetId: 't_retired' })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 0, discarded: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_retired' } })
    expect(row.status).toBe('SKIPPED')
  })

  it('never touches a not-in-thread row — the recipient may have that message', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_maybe')
    await seedDraft({
      id: 'd_maybe',
      senderId: 'leaving',
      targetId: 't_maybe',
      status: 'FAILED',
      failureCode: 'not-in-thread',
      attempts: 1,
    })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 0, discarded: 0, kept: 0 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_maybe' } })
    expect(row.status).toBe('FAILED')
    expect(row.senderId).toBe('leaving')
    expect(row.failureCode).toBe('not-in-thread')
  })

  it('transfers a parked failure with its retry counter reset', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_parked')
    await seedDraft({
      id: 'd_parked',
      senderId: 'leaving',
      targetId: 't_parked',
      status: 'FAILED',
      failureCode: 'no-message-button',
      attempts: 3,
    })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_parked' } })
    expect(row.status).toBe('READY')
    expect(row.senderId).toBe('alpha')
    expect(row.attempts).toBe(0)
    expect(row.failureCode).toBeNull()
  })

  it('keeps drafts in place when no other fleet account exists', async () => {
    await seedSender('leaving')
    await seedSender('burner', { fleetMember: false })
    await seedTarget('t_lonely')
    await seedDraft({ id: 'd_lonely', senderId: 'leaving', targetId: 't_lonely' })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 0, discarded: 0, kept: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_lonely' } })
    expect(row.status).toBe('READY')
    expect(row.senderId).toBe('leaving')
  })

  it("computes the moved draft's touchNumber from the RECEIVING pair's history", async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('beta')
    await seedTarget('t_history')

    // beta delivered long ago; alpha delivered most recently, so rotation walks to beta —
    // and beta's own delivered history must number the transferred draft touch 2.
    await seedDraft({ id: 'old_beta', senderId: 'beta', targetId: 't_history', status: 'SENT' })
    await prisma.outreachAttempt.update({
      where: { id: 'old_beta' },
      data: { sentAt: new Date('2026-08-01T10:00:00Z') },
    })
    await seedDraft({ id: 'old_alpha', senderId: 'alpha', targetId: 't_history', status: 'SENT' })
    await prisma.outreachAttempt.update({
      where: { id: 'old_alpha' },
      data: { sentAt: new Date('2026-08-10T10:00:00Z') },
    })
    await seedDraft({ id: 'd_next', senderId: 'leaving', targetId: 't_history' })

    const summary = await handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })
    expect(summary).toMatchObject({ transferred: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_next' } })
    expect(row.senderId).toBe('beta')
    expect(row.touchNumber).toBe(2)
  })
})
