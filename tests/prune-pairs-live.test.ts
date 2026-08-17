import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ── THE GUARD ITSELF, AGAINST A REAL DATABASE ─────────────────────────────────────────
 *
 * `tests/prune-pairs.test.ts` covers the pure rule and greps the command's source. Neither
 * can answer the question that actually decides whether send history survives:
 *
 *     does `deleteMany({ where: { id, attempts: { none: {} } } })` FILTER,
 *     or does Prisma quietly ignore a to-many condition and delete the row?
 *
 * That is not a rhetorical worry here. CLAUDE.md's first gotcha is `skipDuplicates`, which
 * EXISTS on the Postgres client and not on the SQLite one — typecheck was happy and every
 * call threw. A relation filter inside `deleteMany` is the same shape of question: it is a
 * property of the generated client, so the only honest answer is to run it.
 *
 * And the live data cannot answer it either. MEASURED: all 72 of the burner's pair rows
 * carry ZERO attempts, so on the real database the refusing branch never executes. A guard
 * whose failing direction no input can produce is this codebase's signature failure — so
 * the row with history is constructed here on purpose.
 *
 * The cascade is real and is asserted too: SQLite needs `PRAGMA foreign_keys = ON` for
 * `ON DELETE CASCADE` to fire, and the assertion below would pass vacuously without it.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-prune-pairs-'))
const dbPath = join(dir, 'prune.db')

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
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "role" TEXT NOT NULL DEFAULT 'PROSPECT',
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "contactFirstName" TEXT,
    "brandCategory" TEXT,
    "discoveredFromCampaignId" TEXT,
    "importNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");

  CREATE TABLE "MessageVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

async function seedPair(id: string, opts: { attempts: number }) {
  await prisma.senderAccount.upsert({
    where: { handle: 'tabishmukaddam1' },
    update: {},
    create: {
      id: 'burner',
      handle: 'tabishmukaddam1',
      displayName: 'burner',
      fleetMember: false,
      ...persona,
    },
  })
  await prisma.targetAccount.create({ data: { id: `t_${id}`, handle: `brand_${id}`, displayName: id } })
  await prisma.outreachPair.create({ data: { id, senderId: 'burner', targetId: `t_${id}` } })
  for (let i = 0; i < opts.attempts; i++) {
    await prisma.outreachAttempt.create({
      data: {
        id: `${id}_a${i}`,
        pairId: id,
        senderId: 'burner',
        targetId: `t_${id}`,
        variantId: 'v1',
        touchNumber: i + 1,
        renderedBody: 'a message a real person received',
        status: 'SENT',
      },
    })
  }
}

/**
 * Exactly the statement `src/scripts/prune-pairs.ts` runs.
 *
 * A COPY, which this codebase is otherwise hostile to — five rules have drifted across
 * callers here. It is pinned rather than shared: `tests/prune-pairs.test.ts` greps the
 * command's source for this exact `deleteMany … attempts: { none: {} }` shape, so the
 * command cannot change to something this no longer represents without that grep failing.
 * Extracting it into a helper would be tidier and would test the helper instead of the
 * statement the command actually issues, which is the thing in question.
 */
async function pruneOne(pairId: string) {
  return prisma.outreachPair.deleteMany({ where: { id: pairId, attempts: { none: {} } } })
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('the conditional delete actually filters on send history', () => {
  it('removes a route with nothing recorded against it', async () => {
    await seedPair('clean', { attempts: 0 })
    const res = await pruneOne('clean')
    expect(res.count).toBe(1)
    expect(await prisma.outreachPair.count()).toBe(0)
  })

  /**
   * THE ONE THAT MATTERS. If Prisma ignored the relation filter this would delete the pair
   * and the attempts would cascade away with it — silently, with an exit code of 0 and an
   * audit row saying the route "carried no messages".
   */
  it('REFUSES a route that carries send history, and the history survives', async () => {
    await seedPair('used', { attempts: 2 })
    const res = await pruneOne('used')
    expect(res.count, 'the delete must have matched nothing').toBe(0)
    expect(await prisma.outreachPair.count(), 'the route must still exist').toBe(1)
    expect(await prisma.outreachAttempt.count(), 'the messages must still exist').toBe(2)
  })

  /**
   * And the danger is real rather than theoretical: with the guard removed the SAME row
   * deletes and takes its attempts with it. Without this, the assertion above could be
   * passing because the cascade does not fire in this harness at all — which is exactly
   * what happens if `PRAGMA foreign_keys` is off, and it is off by default in SQLite.
   *
   * This is the mutation test, kept in the file rather than performed once by hand.
   */
  it('and without the guard the cascade DOES erase them — so the guard is doing the work', async () => {
    await seedPair('used', { attempts: 2 })
    const res = await prisma.outreachPair.deleteMany({ where: { id: 'used' } })
    expect(res.count).toBe(1)
    expect(
      await prisma.outreachAttempt.count(),
      'if this is 2, ON DELETE CASCADE is not firing here and the test above proves nothing',
    ).toBe(0)
  })
})
