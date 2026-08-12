import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * WHICH SENDER→TARGET ROUTES MAY EXIST — the pure rule, and the paths that create rows.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * The one-switch change (Tabish, 2026-08-08) stopped anything reading
 * `OutreachPair.enabled`, so a pair row IS a live route. `ensureFleetPairs` carries the two
 * exclusions that matter — never self-pair, never pair one of our own pages to another —
 * but FIVE other paths created pairs directly and applied neither:
 *
 *     addSender · addTarget · confirmBrand · scripts/brands.ts · importProspects.ts
 *
 * `addTarget` was the live hole. It read `senderAccount.findMany()` with no filter, so
 * `addTarget('bollywoodsocietyy')` — a fleet SENDER that is legitimately also a watched
 * CHANNEL target row — created the exact route `ensureFleetPairs` refuses to create, and
 * one revenue page would have cold-pitched another.
 *
 * The `addTarget` test below FAILS against the pre-fix code (verified by running it: three
 * routes created, `madaboutmarketingg→bollywoodsocietyy` among them) and passes after.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-route-rule-'))
const dbPath = join(dir, 'routes.db')

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
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachPair_senderId_fkey" FOREIGN KEY ("senderId")
      REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachPair_targetId_fkey" FOREIGN KEY ("targetId")
      REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key"
    ON "OutreachPair"("senderId", "targetId");
  CREATE INDEX "OutreachPair_enabled_idx" ON "OutreachPair"("enabled");

  CREATE TABLE "MessageVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageVariant_senderId_fkey" FOREIGN KEY ("senderId")
      REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "body" TEXT NOT NULL,
    "sentAt" DATETIME,
    "repliedAt" DATETIME,
    "replyText" TEXT,
    "replyHandledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachAttempt_pairId_fkey" FOREIGN KEY ("pairId")
      REFERENCES "OutreachPair"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

/**
 * The boundary `actions.ts` sits behind, and nothing more.
 *
 * `requireOperator` is the real authorisation gate and belongs to `lib/session`; a test
 * about which ROUTES get created must not also be a test of scrypt. `next/cache` and the
 * modules that drive a browser are stubbed because importing them pulls Patchright and the
 * Next runtime into a unit test. Everything that decides which pairs exist — the queries,
 * the filter, the shared predicate — is the REAL code.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/detection/exists', () => ({ handleExists: async () => 'exists' }))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: {} }))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: async () => ({ hasSession: false }) }))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))
vi.mock('@/outreach/dispatcher', () => ({
  withSendLock: async (_k: string, fn: () => unknown) => fn(),
  dispatchTick: async () => ({}),
  DISPATCH_PAUSE_KEY: 'dispatchPausedUntil',
}))

const { mayRouteExist, routeAllowed } = await import('@/outreach/routes')
const { addTarget, addSender } = await import('@/app/actions')
const { ensureFleetPairs } = await import('@/outreach/plan')
const { prisma } = await import('@/lib/db')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

async function seedSender(handle: string, fleetMember = true) {
  return prisma.senderAccount.create({
    data: { id: `s_${handle}`, handle, displayName: handle, fleetMember, ...persona },
  })
}

async function seedTarget(handle: string, optedOut = false) {
  return prisma.targetAccount.create({
    data: { id: `t_${handle}`, handle, displayName: handle, optedOut },
  })
}

/** Every route that exists, as "sender→target" handle strings — the readable unit here. */
async function routes(): Promise<string[]> {
  const pairs = await prisma.outreachPair.findMany({ include: { sender: true, target: true } })
  return pairs.map((p) => `${p.sender.handle}→${p.target.handle}`).sort()
}

beforeEach(async () => {
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.auditLog.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.targetAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

// ── The pure rule, both directions ────────────────────────────────────────

describe('mayRouteExist — the one definition of which routes may exist', () => {
  const ours = new Set(['madaboutmarketingg', 'bollywoodsocietyy', 'bollywoodchronicle'])

  const ask = (senderHandle: string, targetHandle: string, targetOptedOut = false) =>
    mayRouteExist({ senderHandle, targetHandle, ourHandles: ours, targetOptedOut })

  it('permits an ordinary prospect', () => {
    expect(ask('madaboutmarketingg', 'madovermarketing_mom')).toEqual({ allowed: true })
  })

  it('refuses a sender paired to ITSELF', () => {
    expect(ask('bollywoodsocietyy', 'bollywoodsocietyy')).toEqual({
      allowed: false,
      refusal: 'self',
    })
  })

  /**
   * The clause that actually bites, and the reason this module exists. Society and
   * chronicle are fleet SENDERS and also CHANNEL target rows we watch for ground truth.
   */
  it('refuses a target that is one of OUR OWN PAGES', () => {
    expect(ask('madaboutmarketingg', 'bollywoodsocietyy')).toEqual({
      allowed: false,
      refusal: 'target-is-our-own-page',
    })
    expect(ask('bollywoodsocietyy', 'bollywoodchronicle')).toEqual({
      allowed: false,
      refusal: 'target-is-our-own-page',
    })
  })

  it('refuses a RETIRED target', () => {
    expect(ask('madaboutmarketingg', 'madovermarketing_mom', true)).toEqual({
      allowed: false,
      refusal: 'target-retired',
    })
  })

  /**
   * THE DIRECTION OF THE RULE, PINNED. `ourHandles` is the FLEET, not every account we own.
   *
   * The burner `@tabishmukaddam1` is `fleetMember: false` and is deliberately still
   * messageable: it is the rehearsal recipient every end-to-end send in this project was
   * proven against, and `safeTargetIds()` exists to keep that reachable. "Exclude every
   * handle we own" reads like the safer simplification and would silently retire the only
   * safe test recipient there is. `tests/fleet-pairs.test.ts` asserts the same thing through
   * the database; this asserts it on the rule itself.
   */
  it('excludes FLEET pages only — the burner stays messageable', () => {
    expect(
      mayRouteExist({
        senderHandle: 'madaboutmarketingg',
        targetHandle: 'tabishmukaddam1',
        ourHandles: ours, // the burner is NOT a fleet member, so not in this set
        targetOptedOut: false,
      }),
    ).toEqual({ allowed: true })
  })

  it('routeAllowed is the same answer as a boolean', () => {
    expect(routeAllowed({ senderHandle: 'a', targetHandle: 'b', ourHandles: ours, targetOptedOut: false })).toBe(true)
    expect(routeAllowed({ senderHandle: 'a', targetHandle: 'a', ourHandles: ours, targetOptedOut: false })).toBe(false)
  })
})

// ── addTarget: THE BUG ────────────────────────────────────────────────────

describe('addTarget never creates a route the fleet rule forbids', () => {
  /**
   * THE ACTUAL BUG, and the reason this file is a database test rather than a pure one.
   *
   * Before the fix `addTarget` read `senderAccount.findMany()` with no filter and paired
   * the new target with all of them, excluding only the self-pair. Adding
   * `@bollywoodsocietyy` as a watched channel therefore created
   * `madaboutmarketingg→bollywoodsocietyy` and `bollywoodchronicle→bollywoodsocietyy` —
   * two live routes from one of our revenue pages to another, which `ensureFleetPairs`
   * explicitly refuses to create.
   */
  it('adding one of OUR OWN PAGES as a channel creates NO route to it', async () => {
    await seedSender('madaboutmarketingg')
    await seedSender('bollywoodsocietyy')
    await seedSender('bollywoodchronicle')

    const result = await addTarget('bollywoodsocietyy', 'Bollywood Society', 'Bollywood Society')
    expect(result.ok).toBe(true)

    // The target row is right and wanted — we watch our own pages for ground truth.
    expect(await prisma.targetAccount.findUnique({ where: { handle: 'bollywoodsocietyy' } })).not.toBeNull()

    // What must not exist is any ROUTE to it.
    expect(await routes()).toEqual([])
  })

  it('adding an ordinary prospect creates a route from every account we own', async () => {
    await seedSender('madaboutmarketingg')
    await seedSender('bollywoodsocietyy')

    await addTarget('royalcanin.india', 'Royal Canin India', 'Royal Canin')

    expect(await routes()).toEqual([
      'bollywoodsocietyy→royalcanin.india',
      'madaboutmarketingg→royalcanin.india',
    ])
  })

  it('never pairs a target with a sender of the same handle', async () => {
    await seedSender('madovermarketing_mom')
    await addTarget('madovermarketing_mom', 'M.O.M', 'M.O.M')
    expect(await routes()).toEqual([])
  })
})

// ── addSender: the mirror image ───────────────────────────────────────────

describe('addSender never creates a route the fleet rule forbids', () => {
  /**
   * A NEW SENDER IS `fleetMember: true` BY DEFAULT, so it must not be paired with target
   * rows that are our own pages either — the same hole from the other direction, reachable
   * by adding the accounts in the opposite order.
   */
  it('a new sender gets no route to a target that is one of our own pages', async () => {
    await seedSender('bollywoodsocietyy')
    await seedTarget('bollywoodsocietyy') // watched for ground truth
    await seedTarget('madovermarketing_mom') // a real prospect

    const result = await addSender('madaboutmarketingg', 'Mad About Marketing')
    expect(result.ok).toBe(true)

    expect(await routes()).toEqual(['madaboutmarketingg→madovermarketing_mom'])
  })

  it('a new sender gets no route to a RETIRED target', async () => {
    await seedTarget('madovermarketing_mom')
    await seedTarget('retiredchannel', true)
    await seedSender('bollywoodsocietyy') // template for the persona copy

    await addSender('madaboutmarketingg', 'Mad About Marketing')

    expect(await routes()).toEqual(['madaboutmarketingg→madovermarketing_mom'])
  })

  it('a new sender is never paired to its own target row', async () => {
    await seedSender('bollywoodsocietyy')
    await seedTarget('madaboutmarketingg')

    await addSender('madaboutmarketingg', 'Mad About Marketing')

    expect(await routes()).toEqual([])
  })
})

// ── the creators and ensureFleetPairs must agree ──────────────────────────

describe('every creator agrees with ensureFleetPairs', () => {
  /**
   * The property that matters more than any single call site: whatever `addTarget` and
   * `addSender` create, a subsequent slot must find nothing to add and nothing to disagree
   * with. If a creator were stricter, `ensureFleetPairs` would fill the gap on the next
   * slot; if it were looser — which it was — the extra row is a live route no rule allows.
   */
  it('ensureFleetPairs adds nothing after addTarget, and removes no need for it', async () => {
    await seedSender('madaboutmarketingg')
    await seedSender('bollywoodsocietyy')
    await seedTarget('bollywoodsocietyy')

    await addTarget('royalcanin.india', 'Royal Canin India', 'Royal Canin')
    const afterAdd = await routes()

    const { created } = await ensureFleetPairs()
    expect(created).toBe(0)
    expect(await routes()).toEqual(afterAdd)
  })
})
