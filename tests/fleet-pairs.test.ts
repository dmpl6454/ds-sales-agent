import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `ensureFleetPairs` — the ONE SWITCH change (Tabish, 2026-08-08), driven through the REAL
 * Prisma client against a real (temporary) SQLite file.
 *
 * ── WHY THESE TESTS EXIST AND WHY THEY TOUCH A DATABASE ───────────────────
 *
 * This is the change that WIDENS EXPOSURE. Until now a sender→target route had to be
 * switched on by hand and new routes were created disabled; now every fleet sender is
 * paired with every messageable target automatically. What is under test is therefore not
 * "does it create rows" but the four things that must never happen no matter how many
 * senders and targets exist:
 *
 *   - one of OUR OWN PAGES must never be paired to another (society/chronicle are fleet
 *     SENDERS and also CHANNEL target rows we watch for ground truth)
 *   - a sender must never be paired to itself
 *   - the burner (`fleetMember: false`) must never be paired to a real prospect
 *   - a retired (`optedOut`) target must never be paired to anything
 *
 * It runs against a real database rather than a pure fixture for two reasons. The
 * exclusions are expressed partly as Prisma `where` clauses, which a pure test of the
 * flatMap could not see at all. And idempotency is a claim about the DATABASE — the sort of
 * claim this codebase has repeatedly found to be false when finally executed. A mirror of
 * the filter logic would agree with itself either way.
 *
 * THAT PAID OFF IMMEDIATELY. The first implementation used
 * `createMany({ skipDuplicates: true })`, which Prisma supports on POSTGRES and NOT on
 * SQLITE — 4 occurrences in the generated Postgres client, 0 in the SQLite one. Since
 * `pnpm typecheck` runs against the Postgres client and `pnpm test` regenerates the SQLite
 * one, the type checker was perfectly happy while every call threw at runtime. These tests
 * are the only thing that could have caught it, and the SQLite harness is what made them
 * catch it BEFORE it reached the Postgres server where it would have worked by luck.
 *
 * DATABASE_URL is set before any import that reads it, matching tests/fleet-reservations.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-fleet-pairs-'))
const dbPath = join(dir, 'pairs.db')

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
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

const { ensureFleetPairs } = await import('@/outreach/plan')
const { prisma } = await import('@/lib/db')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

async function addSender(handle: string, fleetMember = true) {
  return prisma.senderAccount.create({
    data: { id: `s_${handle}`, handle, displayName: handle, fleetMember, ...persona },
  })
}

async function addTarget(handle: string, optedOut = false) {
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
  await prisma.senderAccount.deleteMany({})
  await prisma.targetAccount.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('ensureFleetPairs creates every route the fleet is allowed to have', () => {
  it('pairs each fleet sender with each messageable target', async () => {
    await addSender('madaboutmarketingg')
    await addTarget('madovermarketing_mom')
    await addTarget('royalcanin.india')

    const { created } = await ensureFleetPairs()

    expect(created).toBe(2)
    expect(await routes()).toEqual([
      'madaboutmarketingg→madovermarketing_mom',
      'madaboutmarketingg→royalcanin.india',
    ])
  })
})

describe('it never lets one of our own accounts message another', () => {
  /**
   * The exact live case. `@bollywoodsocietyy` and `@bollywoodchronicle` are fleet SENDERS
   * and ALSO CHANNEL target rows, because watching our own pages is ground truth. If the
   * fleet-handle exclusion were dropped, `@madaboutmarketingg` would cold-pitch
   * `@bollywoodsocietyy` — one of our own pages DMing another.
   */
  it('excludes a target row that belongs to a fleet sender', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    await addSender('bollywoodchronicle')
    await addTarget('bollywoodsocietyy')
    await addTarget('bollywoodchronicle')
    await addTarget('madovermarketing_mom')

    await ensureFleetPairs()

    // Every sender reaches the one genuine prospect, and nothing else.
    expect(await routes()).toEqual([
      'bollywoodchronicle→madovermarketing_mom',
      'bollywoodsocietyy→madovermarketing_mom',
      'madaboutmarketingg→madovermarketing_mom',
    ])
  })

  it('never self-pairs, even when a sender is the ONLY target', async () => {
    await addSender('bollywoodsocietyy')
    await addTarget('bollywoodsocietyy')

    const { created } = await ensureFleetPairs()

    expect(created).toBe(0)
    expect(await routes()).toEqual([])
  })
})

describe('the REAL roster produces no route that must not exist', () => {
  /**
   * THE EXPOSURE QUESTION, ASSERTED RATHER THAN REASONED ABOUT.
   *
   * This reproduces the live roster as of 2026-08-08 — four sender accounts, of which
   * `@tabishmukaddam1` is the only `fleetMember: false`, and the target rows that actually
   * exist, including the two that are also senders and the throwaway rehearsal recipient.
   *
   * The two things this task could have got catastrophically wrong are that one of our own
   * pages DMs another, and that the burner reaches a real prospect. Both are asserted here
   * as properties over the WHOLE result rather than as a hand-listed expectation, so the
   * assertion keeps meaning the same thing when the roster changes.
   */
  const OUR_PAGES = ['madaboutmarketingg', 'bollywoodsocietyy', 'bollywoodchronicle']

  beforeEach(async () => {
    for (const h of OUR_PAGES) await addSender(h)
    await addSender('tabishmukaddam1', false)

    // Our own two pages are ALSO channel target rows — watched for ground truth.
    await addTarget('bollywoodsocietyy')
    await addTarget('bollywoodchronicle')
    // Genuine prospects.
    await addTarget('madovermarketing_mom')
    await addTarget('viralbhayani')
    await addTarget('royalcanin.india')
    // The rehearsal recipient, and a retired channel.
    await addTarget('priyanshu123321123')
    await addTarget('retired.channel', true)
  })

  it('never routes one of our own pages to another of our own pages', async () => {
    await ensureFleetPairs()

    const offending = (await routes()).filter((r) => {
      const target = r.split('→')[1] ?? ''
      return OUR_PAGES.includes(target)
    })

    expect(offending).toEqual([])
  })

  it('gives the burner no route to anything, prospect or otherwise', async () => {
    await ensureFleetPairs()

    const burnerRoutes = (await routes()).filter((r) => r.startsWith('tabishmukaddam1→'))
    expect(burnerRoutes).toEqual([])
  })

  it('routes every fleet page to exactly the messageable prospects, and nothing else', async () => {
    await ensureFleetPairs()

    // 3 fleet senders x 4 messageable targets (mom, viralbhayani, royalcanin, priyanshu).
    // Excluded: our own two pages as targets, the retired channel, and the whole burner row.
    expect(await routes()).toEqual([
      'bollywoodchronicle→madovermarketing_mom',
      'bollywoodchronicle→priyanshu123321123',
      'bollywoodchronicle→royalcanin.india',
      'bollywoodchronicle→viralbhayani',
      'bollywoodsocietyy→madovermarketing_mom',
      'bollywoodsocietyy→priyanshu123321123',
      'bollywoodsocietyy→royalcanin.india',
      'bollywoodsocietyy→viralbhayani',
      'madaboutmarketingg→madovermarketing_mom',
      'madaboutmarketingg→priyanshu123321123',
      'madaboutmarketingg→royalcanin.india',
      'madaboutmarketingg→viralbhayani',
    ])
  })
})

describe('it excludes accounts and targets that must not take part', () => {
  it('gives the burner no pairs at all', async () => {
    await addSender('tabishmukaddam1', false)
    await addSender('madaboutmarketingg')
    await addTarget('madovermarketing_mom')

    await ensureFleetPairs()

    expect(await routes()).toEqual(['madaboutmarketingg→madovermarketing_mom'])
  })

  it('does not pair a retired (optedOut) target', async () => {
    await addSender('madaboutmarketingg')
    await addTarget('madovermarketing_mom')
    await addTarget('retired.brand', true)

    await ensureFleetPairs()

    expect(await routes()).toEqual(['madaboutmarketingg→madovermarketing_mom'])
  })

  /**
   * A burner target row is NOT excluded for being a burner — it is excluded only if the
   * burner is a fleet member. This pins the direction of the fleet-handle rule so it cannot
   * be "simplified" into "exclude every handle we own", which would silently retire the
   * rehearsal targets the on-demand path still uses.
   */
  it('a NON-fleet sender that is also a target row is still messageable', async () => {
    await addSender('tabishmukaddam1', false)
    await addSender('madaboutmarketingg')
    await addTarget('tabishmukaddam1')

    await ensureFleetPairs()

    expect(await routes()).toEqual(['madaboutmarketingg→tabishmukaddam1'])
  })
})

describe('it is idempotent', () => {
  /**
   * The whole design rests on this: `ensureFleetPairs` runs at the top of EVERY slot, so a
   * second call that threw or duplicated would break outreach four times a day. The claim
   * is about `@@unique([senderId, targetId])` + `skipDuplicates`, which is a claim about the
   * database engine and is therefore executed rather than reasoned about.
   */
  it('creates nothing and throws nothing on a rerun', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    await addTarget('madovermarketing_mom')
    await addTarget('royalcanin.india')

    const first = await ensureFleetPairs()
    const before = await routes()

    const second = await ensureFleetPairs()
    const third = await ensureFleetPairs()

    expect(first.created).toBe(4)
    expect(second.created).toBe(0)
    expect(third.created).toBe(0)
    expect(await routes()).toEqual(before)
    expect(await prisma.outreachPair.count()).toBe(4)
  })

  /**
   * The partial case, which is the one a subtraction can get wrong. With several senders
   * and several targets, only SOME routes pre-exist — so the missing set must be computed
   * per (sender, target) and not per sender or per target. A rule that skipped a whole
   * sender because one of its routes existed would silently never create the rest.
   */
  it('fills in only the genuinely missing routes when some already exist', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    await addTarget('madovermarketing_mom')
    await addTarget('royalcanin.india')

    // Pre-create exactly one of the four routes, by hand.
    await prisma.outreachPair.create({
      data: { senderId: 's_madaboutmarketingg', targetId: 't_madovermarketing_mom' },
    })

    const { created } = await ensureFleetPairs()

    expect(created).toBe(3)
    expect(await prisma.outreachPair.count()).toBe(4)
    expect(await routes()).toEqual([
      'bollywoodsocietyy→madovermarketing_mom',
      'bollywoodsocietyy→royalcanin.india',
      'madaboutmarketingg→madovermarketing_mom',
      'madaboutmarketingg→royalcanin.india',
    ])
  })

  it('adds only the new routes when a target is added later', async () => {
    await addSender('madaboutmarketingg')
    await addTarget('madovermarketing_mom')
    await ensureFleetPairs()

    await addTarget('royalcanin.india')
    const { created } = await ensureFleetPairs()

    expect(created).toBe(1)
    expect(await routes()).toEqual([
      'madaboutmarketingg→madovermarketing_mom',
      'madaboutmarketingg→royalcanin.india',
    ])
  })

  /**
   * Existing rows must survive untouched. `createMany` + `skipDuplicates` must SKIP, never
   * upsert — a pair carries `bespokeBody`, the per-recipient first-touch message, and
   * overwriting it every slot would silently replace bespoke copy with a default row.
   */
  it('leaves an existing pair and its bespoke body alone', async () => {
    await addSender('madaboutmarketingg')
    await addTarget('madovermarketing_mom')
    await ensureFleetPairs()

    await prisma.outreachPair.updateMany({
      data: { bespokeBody: 'written for this recipient', cooldownDays: 14 },
    })

    await ensureFleetPairs()

    const pair = await prisma.outreachPair.findFirstOrThrow()
    expect(pair.bespokeBody).toBe('written for this recipient')
    expect(pair.cooldownDays).toBe(14)
  })
})
