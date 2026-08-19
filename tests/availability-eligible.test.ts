/**
 * `eligibleFleetSenderIds` — the PRODUCER of the ring rule's "all our pages" set,
 * against a real database file.
 *
 * `tests/cross-spacing.test.ts` proves what the ring predicate DOES with an eligible
 * set; nothing there proves what the set MEANS. That producer/consumer gap is this
 * codebase's recurring shape (`repliedAt` was read in six places and written in none),
 * and this set carries real weight in BOTH directions: a sender wrongly counted makes
 * ring-complete unreachable (the 7-day rest never fires), and a sender wrongly dropped
 * makes it fire early (recipients rest before every page has written).
 *
 * A real DB file because the function is assembled from a Prisma `select` — a stale
 * column name fails at RUNTIME while typecheck passes (the skipDuplicates lesson).
 * DDL transcribed from tests/cohorts-live.test.ts, which transcribed it from the
 * migrations — never from a reading of the model.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ds-eligible-'))
const dbPath = join(dir, 'eligible.db')

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
`)
bootstrap.exec(`
  INSERT INTO "SenderAccount" ("id","handle","displayName","personaName","personaRole","personaBrand","personaPhone","personaEmail","fleetMember","status","sessionPath","updatedAt") VALUES
    ('s-eligible',  's-eligible',  'x','x','x','x','x','x', true,  'ACTIVE',     '/p/a', CURRENT_TIMESTAMP),
    ('s-burner',    's-burner',    'x','x','x','x','x','x', false, 'ACTIVE',     '/p/b', CURRENT_TIMESTAMP),
    ('s-never',     's-never',     'x','x','x','x','x','x', true,  'ACTIVE',     NULL,   CURRENT_TIMESTAMP),
    ('s-challenged','s-challenged','x','x','x','x','x','x', true,  'CHALLENGED', '/p/c', CURRENT_TIMESTAMP);
  INSERT INTO "SenderAccount" ("id","handle","displayName","personaName","personaRole","personaBrand","personaPhone","personaEmail","fleetMember","status","sessionPath","sessionInvalidAt","updatedAt") VALUES
    ('s-dead',      's-dead',      'x','x','x','x','x','x', true,  'ACTIVE',     '/p/d', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
const { eligibleFleetSenderIds } = await import('@/outreach/availability')

describe('eligibleFleetSenderIds', () => {
  it('counts exactly the fleet members rotation could elect — and no one else', async () => {
    const ids = await eligibleFleetSenderIds()
    expect(ids).toEqual(['s-eligible'])
  })
})
