import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE BADGE DOOR'S QUEUE IS FAIR — A DEAD HANDLE CANNOT STARVE FRESH CANDIDATES.
 *
 * MEASURED 2026-08-22 from the device log before this existed: `enriched=10 unreachable=10`
 * on pass after pass for HOURS, `candidates` pinned at ~25. The queue is rebuilt
 * newest-post-first each pass and an unreachable handle recorded nothing, so the same ~10
 * dead handles (`@rajasthaliresort.com` — a URL typed as a handle; `@aaflims.official` — a
 * documented 404) consumed the entire enrichment budget every 30 minutes while candidates
 * from new paid posts waited behind them, forever. Tabish saw it from the other end:
 * *"Paid posts are blatantly missing company tags"* — companies asserted on paid posts that
 * never arrived as prospects.
 *
 * This is the `resolveBrand` livelock of 2026-08-12 ("sort a just-failed handle LAST"),
 * one module over — the lesson never reached here. Driven against a REAL SQLite file
 * because the queue is assembled from three Prisma queries; a pure mirror of the filter
 * would agree with itself either way.
 *
 * `enrichHandle` is MOCKED (it makes a real HTTP call to Instagram). `createBrandTarget`
 * is MOCKED because admission is not under test here — `tests/verified-only.test.ts` owns
 * the bar; this file owns WHO GETS A TURN.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-badge-door-'))
const dbPath = join(dir, 'badge.db')

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

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
    "isVerified" BOOLEAN,
    "followerCount" INTEGER,
    "campaignTalent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");

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
    CONSTRAINT "DetectedCampaign_targetId_fkey" FOREIGN KEY ("targetId")
      REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX "DetectedCampaign_shortcode_key" ON "DetectedCampaign"("shortcode");

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
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const enrichMock = vi.fn()
vi.mock('@/detection/enrichHandle', () => ({
  enrichHandle: (h: string) => enrichMock(h),
}))

const createTargetMock = vi.fn(async () => 'created' as const)
vi.mock('@/outreach/brandTarget', () => ({
  createBrandTarget: (...args: unknown[]) => createTargetMock(...(args as [])),
}))

const { badgeDoorPass, resetBadgeDoorMemory } = await import('@/detection/badgeDoor')
const { prisma } = await import('@/lib/db')

function reachable(handle: string, isVerified: boolean) {
  return {
    handle, reachable: true, accountType: 2, isVerified,
    followers: 1000, fullName: handle.toUpperCase(), reason: null, status: null,
  }
}
function dead(handle: string) {
  return {
    handle, reachable: false, accountType: null, isVerified: null,
    followers: null, fullName: null, reason: 'HTTP 404', status: 404,
  }
}

/** Two campaigns: the NEWER asserts @deadco (the stuck class), the OLDER asserts @freshco. */
async function seed() {
  await prisma.detectedCampaign.deleteMany()
  await prisma.targetAccount.deleteMany()
  await prisma.brandLookup.deleteMany()
  const channel = await prisma.targetAccount.create({
    data: { handle: 'somechannel', displayName: 'Some Channel', kind: 'CHANNEL', role: 'WATCH' },
  })
  await prisma.detectedCampaign.create({
    data: {
      targetId: channel.id, shortcode: 'NEWPOST', permalink: 'https://x/NEWPOST',
      postedAt: new Date('2026-08-22T06:00:00Z'), caption: 'launch with @deadco', verdict: 'CAMPAIGN',
    },
  })
  await prisma.detectedCampaign.create({
    data: {
      targetId: channel.id, shortcode: 'OLDPOST', permalink: 'https://x/OLDPOST',
      postedAt: new Date('2026-08-21T06:00:00Z'), caption: 'launch with @freshco', verdict: 'CAMPAIGN',
    },
  })
  await prisma.brandLookup.createMany({
    data: [
      { handle: 'deadco', kind: 'MISSING', isVerified: null },
      { handle: 'freshco', kind: 'UNRESOLVED', isVerified: null },
    ],
  })
}

beforeEach(async () => {
  resetBadgeDoorMemory()
  enrichMock.mockReset()
  createTargetMock.mockClear()
  await seed()
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('the badge door queue is fair to fresh candidates', () => {
  it('reproduces the livelock precondition: the newest-post handle is tried first', async () => {
    enrichMock.mockImplementation(async (h: string) => (h === 'deadco' ? dead(h) : reachable(h, true)))

    const pass1 = await badgeDoorPass({ maxEnrichments: 1, enrichSpacingMs: 0 })
    // Budget of 1 goes to deadco (newest post), which is unreachable — freshco never reached.
    expect(enrichMock.mock.calls.map((c) => c[0])).toEqual(['deadco'])
    expect(pass1.unreachable).toBe(1)
    expect(pass1.haltedEarly).toBe(true)
  })

  it('sends a failed handle to the back, so the NEXT pass reaches the fresh candidate', async () => {
    enrichMock.mockImplementation(async (h: string) => (h === 'deadco' ? dead(h) : reachable(h, true)))

    await badgeDoorPass({ maxEnrichments: 1, enrichSpacingMs: 0 }) // deadco fails, is remembered
    const pass2 = await badgeDoorPass({ maxEnrichments: 1, enrichSpacingMs: 0 })

    // WITHOUT the memory this second call enriches deadco again and freshco starves —
    // restoring the old `continue` (no unreachableAt.set) fails exactly here.
    expect(enrichMock.mock.calls.map((c) => c[0])).toEqual(['deadco', 'freshco'])
    expect(pass2.admitted).toBe(1)
    expect(pass2.coolingOff).toBe(1) // the skip is REPORTED, never silent
    expect(createTargetMock).toHaveBeenCalledTimes(1)
  })

  it('a cooling-off handle spends none of the budget and none of the endpoint', async () => {
    enrichMock.mockImplementation(async (h: string) => dead(h))
    await badgeDoorPass({ maxEnrichments: 2, enrichSpacingMs: 0 }) // both fail, both remembered

    enrichMock.mockClear()
    const pass2 = await badgeDoorPass({ maxEnrichments: 2, enrichSpacingMs: 0 })
    expect(enrichMock).not.toHaveBeenCalled()
    expect(pass2.enriched).toBe(0)
    expect(pass2.coolingOff).toBe(2)
    expect(pass2.candidates).toBe(2) // still candidates — excluded, not forgotten
  })

  it('a handle that succeeds is forgotten by the failure memory', async () => {
    // Fails once, then the account comes back (the @colorstv class: MISSING yet real).
    enrichMock.mockImplementationOnce(async (h: string) => dead(h))
    await badgeDoorPass({ maxEnrichments: 1, enrichSpacingMs: 0 })

    resetBadgeDoorMemory() // simulate the cooldown having expired without waiting 24h
    enrichMock.mockImplementation(async (h: string) => reachable(h, true))
    const pass = await badgeDoorPass({ maxEnrichments: 2, enrichSpacingMs: 0 })
    expect(pass.unreachable).toBe(0)
    expect(pass.admitted).toBe(2)
  })

  it('an unreachable enrichment never becomes a verdict', async () => {
    enrichMock.mockImplementation(async (h: string) => dead(h))
    await badgeDoorPass({ maxEnrichments: 2, enrichSpacingMs: 0 })

    const rows = await prisma.brandLookup.findMany({ orderBy: { handle: 'asc' } })
    // isVerified stays NULL on both — a refusal to answer is never a badge fact.
    expect(rows.map((r) => r.isVerified)).toEqual([null, null])
    expect(createTargetMock).not.toHaveBeenCalled()
  })
})
