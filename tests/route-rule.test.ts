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
vi.mock('@/detection/exists', () => ({
  handleExists: async () => 'exists',
  /* `addTarget` reads identity facts now (2026-08-20) — null facts is the honest stub,
     and the message builder renders it as "could not say who this is". */
  probeHandle: async () => ({ check: 'exists', facts: null }),
}))
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

  const ask = (senderHandle: string, targetHandle: string, targetOptedOut = false, targetIsWatchOnly = false) =>
    mayRouteExist({
      senderHandle,
      targetHandle,
      ourHandles: ours,
      senderIsFleetMember: true,
      targetOptedOut,
      targetIsWatchOnly,
    })

  it('permits an ordinary prospect', () => {
    expect(ask('madaboutmarketingg', 'crocsindia')).toEqual({ allowed: true })
  })

  /**
   * ── THE COMPETITOR CLAUSE ─────────────────────────────────────────────────
   *
   * @viralbhayani and @madovermarketing_mom are WATCHED publishers: we read their feeds to
   * find the brands buying placement from them, and those brands are who we write to. They
   * are competitors and must never receive a message.
   *
   * MEASURED the day this shipped, which is why it is a test and not a comment: each of
   * them held **13 attempts and 4 pairs**, and **6 drafts to them were waiting to send**.
   * Nothing in this file refused them — the four refusals were all about the SENDER, about
   * our own pages, or about retirement.
   *
   * Note the handle in the second assertion. Until today this exact pair was the fixture
   * for *"permits an ordinary prospect"*, which is how thoroughly the old model had the two
   * kinds of target confused.
   */
  it('refuses a WATCHED publisher, whoever is writing', () => {
    for (const sender of ['madaboutmarketingg', 'bollywoodsocietyy', 'bollywoodchronicle']) {
      expect(ask(sender, 'viralbhayani', false, true), `@${sender} must not reach a competitor`).toEqual({
        allowed: false,
        refusal: 'target-is-watch-only',
      })
    }
    expect(ask('madaboutmarketingg', 'madovermarketing_mom', false, true)).toEqual({
      allowed: false,
      refusal: 'target-is-watch-only',
    })
  })

  /**
   * The direction that makes the rule falsifiable: the SAME handle is permitted the moment
   * it is a prospect. If this ever fails, the predicate has started refusing on something
   * other than the column — the `kind`-based rule that would have refused every imported
   * prospect is exactly what this catches.
   */
  it('permits the same recipient when it is a PROSPECT', () => {
    expect(ask('madaboutmarketingg', 'somebrand', false, false)).toEqual({ allowed: true })
  })

  /**
   * A retired WATCH row reports `target-retired`, not `target-is-watch-only`. Order matters
   * only for which reason a refusal names, and retirement is the fact an operator can act
   * on — it is the promise `removeTarget` made to somebody.
   */
  it('reports retirement ahead of watch-only when a row is both', () => {
    expect(ask('madaboutmarketingg', 'viralbhayani', true, true)).toEqual({
      allowed: false,
      refusal: 'target-retired',
    })
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
        senderIsFleetMember: true, // the SENDER here is a fleet page; the burner is the recipient
        targetOptedOut: false,
        targetIsWatchOnly: false, // the burner is a rehearsal RECIPIENT, never a watched publisher
      }),
    ).toEqual({ allowed: true })
  })

  /**
   * ── AND THE SAME ACCOUNT IN THE OTHER ROLE, WHICH IS THE 4.3 FIX ───────────────────
   *
   * The two facts are independent and this pair of assertions is what says so. A non-fleet
   * account may RECEIVE (above) and may not automatically SEND (here). Until 2026-08-13
   * only the query in `runOutreach` said the second, so the ROWS existed: MEASURED, 72 of
   * them for `@tabishmukaddam1`, created by three creators that all read
   * `senderAccount.findMany()` unfiltered. A pair row IS a live route since the chips went,
   * so "one query happens not to read it" is not the same claim as "it does not exist".
   *
   * Reported as `sender-not-in-fleet` rather than as any fact about the recipient, because
   * an account outside the rotation has no automatic route to ANYONE — nothing about who
   * the recipient is can make one allowable.
   */
  it('refuses a sender OUTSIDE the fleet, whoever the recipient is', () => {
    for (const target of ['madovermarketing_mom', 'amazondotin', 'crocsindia']) {
      expect(
        mayRouteExist({
          senderHandle: 'tabishmukaddam1',
          targetHandle: target,
          ourHandles: ours,
          senderIsFleetMember: false,
          targetOptedOut: false,
          targetIsWatchOnly: false,
        }),
        `@tabishmukaddam1 must have no automatic route to @${target}`,
      ).toEqual({ allowed: false, refusal: 'sender-not-in-fleet' })
    }
  })

  it('routeAllowed is the same answer as a boolean', () => {
    expect(
      routeAllowed({
        senderHandle: 'a',
        targetHandle: 'b',
        ourHandles: ours,
        senderIsFleetMember: true,
        targetOptedOut: false,
        targetIsWatchOnly: false,
      }),
    ).toBe(true)
    expect(
      routeAllowed({
        senderHandle: 'a',
        targetHandle: 'a',
        ourHandles: ours,
        senderIsFleetMember: true,
        targetOptedOut: false,
        targetIsWatchOnly: false,
      }),
    ).toBe(false)
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

    const result = await addTarget('bollywoodsocietyy', 'Bollywood Society', 'Bollywood Society', 'WATCH')
    expect(result.ok).toBe(true)

    // The target row is right and wanted — we watch our own pages for ground truth.
    expect(await prisma.targetAccount.findUnique({ where: { handle: 'bollywoodsocietyy' } })).not.toBeNull()

    // What must not exist is any ROUTE to it.
    expect(await routes()).toEqual([])
  })

  it('adding an ordinary prospect creates a route from every account we own', async () => {
    await seedSender('madaboutmarketingg')
    await seedSender('bollywoodsocietyy')

    await addTarget('royalcanin.india', 'Royal Canin India', 'Royal Canin', 'PROSPECT')

    expect(await routes()).toEqual([
      'bollywoodsocietyy→royalcanin.india',
      'madaboutmarketingg→royalcanin.india',
    ])
  })

  /**
   * ── THE SAME FORM, THE OTHER KIND, AND NO ROUTE AT ALL ────────────────────
   *
   * The pair of assertions that says the two target types are genuinely different acts.
   * Adding @viralbhayani is how you start WATCHING a competitor for the brands buying
   * placement from them; it must not also make them a recipient.
   *
   * This is what was broken: `addTarget` created a row and then paired it to every sender,
   * so watching a competitor and cold-pitching one were the same click.
   */
  it('adding a page to WATCH creates no route to it', async () => {
    await seedSender('madaboutmarketingg')
    await seedSender('bollywoodsocietyy')

    const r = await addTarget('viralbhayani', 'Viral Bhayani', 'Viral Bhayani', 'WATCH')
    expect(r.ok).toBe(true)

    const row = await prisma.targetAccount.findUnique({ where: { handle: 'viralbhayani' } })
    expect(row?.role).toBe('WATCH')
    // Watched, judged by the real classifier, and never written to.
    expect(row?.watchEnabled).toBe(true)
    expect(row?.detectorKey).toBe('semantic')
    expect(await routes()).toEqual([])
  })

  /** And the prospect direction of the same two columns: written to, never read. */
  it('a company added to message is not enrolled into detection', async () => {
    await seedSender('madaboutmarketingg')
    await addTarget('crocsindia', 'Crocs India', 'Crocs India', 'PROSPECT')

    const row = await prisma.targetAccount.findUnique({ where: { handle: 'crocsindia' } })
    expect(row?.role).toBe('PROSPECT')
    expect(row?.watchEnabled).toBe(false)
    expect(row?.detectorKey).toBe('passthrough')
    expect(await routes()).toEqual(['madaboutmarketingg→crocsindia'])
  })

  it('never pairs a target with a sender of the same handle', async () => {
    await seedSender('madovermarketing_mom')
    await addTarget('madovermarketing_mom', 'M.O.M', 'M.O.M', 'PROSPECT')
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

    await addTarget('royalcanin.india', 'Royal Canin India', 'Royal Canin', 'PROSPECT')
    const afterAdd = await routes()

    const { created } = await ensureFleetPairs()
    expect(created).toBe(0)
    expect(await routes()).toEqual(afterAdd)
  })
})
