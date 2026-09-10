import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `parkOrphanedSending` — a row stuck in SENDING with no live drive is parked, not left
 * to wedge its pair forever. Driven through the REAL Prisma client against a temporary
 * SQLite file, like tests/hand-off.test.ts and for the same reason: the behaviour under
 * test is conditional writes (`updateMany` with the status in the WHERE), which a pure
 * mirror of the logic would agree with either way.
 *
 * MEASURED before the mechanism existed: three rows sat in SENDING for ~19 hours
 * (26 Aug), each blocking its pair via `hasPendingAttempt`. Fourth occurrence of the
 * class (22 Aug ×2, 23 Aug ×1, 26 Aug ×3).
 *
 * The properties that must hold:
 *
 *   - WITHOUT the send lock (no row, or a row naming another pid) it parks NOTHING —
 *     the "any SENDING row is an orphan" invariant only holds while the lock is ours,
 *     and a guard that fires without its precondition would park a live send
 *   - WITH the lock held by this pid, the orphan parks as FAILED / not-in-thread with
 *     an audit row, and ONLY the orphan — READY and SENT rows are untouched
 *   - a row that leaves SENDING during the dwell (the `sendNow` pre-lock claim being
 *     reverted) is NOT parked — the dwell exists exactly for that race
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-stale-sending-'))
const dbPath = join(dir, 'stale.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
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
const { parkOrphanedSending } = await import('@/outreach/dispatcher')
const { deviceId } = await import('@/outreach/devicePresence')

const SEND_LOCK_KEY = 'sendLock'

// The sweep acts only on a row naming THIS pid on THIS Mac (2026-09-10); a row naming no
// Mac — the shape an older agent writes — is another Mac's, and the sweep leaves it alone.
function lockValue(pid: number, device: string = deviceId()) {
  return JSON.stringify({ pid, device, what: 'test', at: new Date().toISOString() })
}
/** The row an agent older than the device field writes — no `device` key at all. */
function legacyLockValue(pid: number) {
  return JSON.stringify({ pid, what: 'test', at: new Date().toISOString() })
}

async function seed() {
  await prisma.auditLog.deleteMany()
  await prisma.outreachAttempt.deleteMany()
  await prisma.outreachPair.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.senderAccount.deleteMany()
  await prisma.targetAccount.deleteMany()

  await prisma.senderAccount.create({
    data: {
      id: 'send_1', handle: 'pageone', displayName: 'Page One',
      personaName: '', personaRole: '', personaBrand: 'Page One', personaPhone: '', personaEmail: '',
    },
  })
  await prisma.targetAccount.create({
    data: { id: 'targ_1', handle: 'companyone', displayName: 'Company One', kind: 'BRAND' },
  })
  await prisma.outreachPair.create({ data: { id: 'pair_1', senderId: 'send_1', targetId: 'targ_1' } })

  const base = { pairId: 'pair_1', senderId: 'send_1', targetId: 'targ_1', variantId: 'var_1', touchNumber: 1, renderedBody: 'hello' }
  await prisma.outreachAttempt.create({ data: { ...base, id: 'att_sending', status: 'SENDING' } })
  await prisma.outreachAttempt.create({ data: { ...base, id: 'att_ready', status: 'READY' } })
  await prisma.outreachAttempt.create({ data: { ...base, id: 'att_sent', status: 'SENT', sentAt: new Date() } })
}

beforeEach(seed)

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('parkOrphanedSending', () => {
  it('parks NOTHING when no send lock row exists — the invariant needs the lock', async () => {
    const parked = await parkOrphanedSending(0)
    expect(parked).toBe(0)
    const row = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(row?.status).toBe('SENDING')
  })

  it('parks NOTHING when the lock names another pid — some other process may be driving', async () => {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value: lockValue(process.pid + 99_991) } })
    const parked = await parkOrphanedSending(0)
    expect(parked).toBe(0)
    const row = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(row?.status).toBe('SENDING')
  })

  /**
   * A pid is a fact about one machine (2026-09-10). Two Macs share this lock row, and a
   * foreign dispatcher that matched on pid alone would dwell and then park THIS Mac's live
   * drive as an orphan while its browser is mid-paste. A row naming another Mac — or no Mac
   * at all, the shape an older agent writes — must park nothing however its pid reads.
   */
  it('parks NOTHING when the lock names our pid on ANOTHER Mac', async () => {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value: lockValue(process.pid, 'somebody-elses-mac') } })
    expect(await parkOrphanedSending(0)).toBe(0)
    const row = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(row?.status).toBe('SENDING')
  })

  it('parks NOTHING when the lock names no Mac at all (an agent older than the device field)', async () => {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value: legacyLockValue(process.pid) } })
    expect(await parkOrphanedSending(0)).toBe(0)
    const row = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(row?.status).toBe('SENDING')
  })

  it('parks the orphan as not-in-thread with an audit row, and touches nothing else', async () => {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value: lockValue(process.pid) } })
    const parked = await parkOrphanedSending(0)
    expect(parked).toBe(1)

    const orphan = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(orphan?.status).toBe('FAILED')
    expect(orphan?.failureCode).toBe('not-in-thread')
    expect(orphan?.attempts).toBe(1)
    // "may be delivered" is the honest reading, so the prose must send a person to the thread
    expect(orphan?.error).toMatch(/read the thread/)

    const ready = await prisma.outreachAttempt.findUnique({ where: { id: 'att_ready' } })
    const sent = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sent' } })
    expect(ready?.status).toBe('READY')
    expect(sent?.status).toBe('SENT')

    const audits = await prisma.auditLog.findMany({ where: { action: 'attempt.parked-orphaned-sending' } })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.entity).toBe('OutreachAttempt:att_sending')
    expect(audits[0]!.detail).toContain('pageone→companyone')
  })

  it('does NOT park a row that leaves SENDING during the dwell — the sendNow pre-lock race', async () => {
    await prisma.setting.create({ data: { key: SEND_LOCK_KEY, value: lockValue(process.pid) } })
    const sweep = parkOrphanedSending(400)
    // a sendNow whose lock attempt returned busy reverts its claim — simulate that revert
    await new Promise((r) => setTimeout(r, 50))
    await prisma.outreachAttempt.update({ where: { id: 'att_sending' }, data: { status: 'READY' } })
    const parked = await sweep
    expect(parked).toBe(0)
    const row = await prisma.outreachAttempt.findUnique({ where: { id: 'att_sending' } })
    expect(row?.status).toBe('READY')
    expect(row?.attempts).toBe(0)
    expect(await prisma.auditLog.count()).toBe(0)
  })
})
