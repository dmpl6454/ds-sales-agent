import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `autoResolveBrands` — the pass that makes brand discovery RUN rather than be runnable.
 *
 * ── WHY THIS IS TESTED AGAINST A REAL DATABASE ────────────────────────────
 *
 * This is the second change in this plan that WIDENS EXPOSURE. A `TargetAccount{kind:'BRAND'}`
 * row is a prospect, and since the per-route switch was removed (Tabish, 2026-08-08) the pair
 * rows created beside it ARE live routes — so one call to `createBrandTarget` is the
 * difference between "a company was noticed" and "a revenue account may cold-DM it
 * unattended, with nobody present".
 *
 * What is under test is therefore not "does it create a row" but the properties that must
 * hold no matter what the endpoint returns:
 *
 *   - one of OUR OWN sending accounts must never become a prospect
 *   - a handle already answered must never be looked up again (or the pass starves)
 *   - the per-pass bound must count LOOKUPS, not creations
 *   - a real throttle must stop the pass, and mark nothing
 *
 * The exclusions live partly in Prisma `where` clauses and partly in `routeAllowed`, which a
 * pure test of the loop could not see at all — the same reasoning as `tests/fleet-pairs.test.ts`,
 * where a real harness immediately caught `createMany({ skipDuplicates })` being
 * Postgres-only while `pnpm typecheck` was perfectly happy.
 *
 * `resolveBrand` is MOCKED. It makes a real HTTP call to Instagram and, on UNRESOLVED, a real
 * DeepSeek call — neither belongs in a test suite, and what matters here is how this function
 * treats each of the five verdicts, not how the verdict was reached.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-auto-resolve-'))
const dbPath = join(dir, 'resolve.db')

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
    "enrichment" TEXT,
    "reachable" BOOLEAN,
    "decidedBy" TEXT,
    "modelConfidence" INTEGER,
    "modelReason" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
process.env.TZ = 'Asia/Kolkata'

/**
 * The mock replaces the network AND the model. Each test sets `answers` to the verdict it
 * wants per handle; `calls` records what was actually asked, which is how "settled handles
 * are never looked up again" is asserted — a count of created rows could not tell a skipped
 * lookup from a lookup that returned nothing.
 */
type Verdict = Awaited<ReturnType<typeof import('@/detection/resolveBrand').resolveBrand>>
const answers = new Map<string, Verdict>()
const calls: string[] = []

vi.mock('@/detection/resolveBrand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/resolveBrand')>()
  return {
    ...actual,
    // `mentionsIn` is a pure regex over the caption and is deliberately NOT mocked: the
    // handles this function acts on must be the ones the real parser finds.
    resolveBrand: async (handle: string): Promise<Verdict> => {
      calls.push(handle)
      return answers.get(handle) ?? { kind: 'MISSING', handle }
    },
  }
})

const { autoResolveBrands, MODEL_RETRY_AFTER_MS, UNKNOWN_RETRY_AFTER_MS, orderForLookup } =
  await import('@/detection/autoResolve')
/**
 * The REAL `taggedHandlesIn` — it is pure, and it is the thing under test. The module is
 * mocked above only for `resolveBrand` itself (the network call).
 */
const { taggedHandlesIn } = await import('@/detection/resolveBrand')
const { prisma } = await import('@/lib/db')
const { log } = await import('@/lib/logger')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const brand = (handle: string): Verdict => ({
  kind: 'BRAND',
  handle,
  displayName: handle,
  category: 'Grocery & Convenience Stores',
  followers: 1000,
})

async function addSender(handle: string, fleetMember = true) {
  return prisma.senderAccount.create({
    data: { id: `s_${handle}`, handle, displayName: handle, fleetMember, ...persona },
  })
}

/** A CAMPAIGN post inside the detection window, with the caption that carries the mentions. */
async function addCampaign(shortcode: string, caption: string, channelId: string, postedAt = new Date()) {
  return prisma.detectedCampaign.create({
    data: {
      id: `c_${shortcode}`,
      targetId: channelId,
      shortcode,
      permalink: `https://www.instagram.com/p/${shortcode}/`,
      postedAt,
      caption,
      verdict: 'CAMPAIGN',
    },
  })
}

let channelId = ''

beforeEach(async () => {
  await prisma.auditLog.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.brandLookup.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  answers.clear()
  calls.length = 0

  const channel = await prisma.targetAccount.create({
    data: { id: 't_channel', handle: 'viralbhayani', displayName: 'Viral Bhayani', kind: 'CHANNEL' },
  })
  channelId = channel.id
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('a BRAND becomes a prospect with routes', () => {
  it('creates the target and a pair for every allowed sender', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    await addCampaign('AAA', 'Great launch with @royalcanin.india today', channelId)
    answers.set('royalcanin.india', brand('royalcanin.india'))

    const out = await autoResolveBrands()

    expect(out).toMatchObject({ looked: 1, decided: 1, skippedUnsure: 0, haltedEarly: false })

    const target = await prisma.targetAccount.findUnique({ where: { handle: 'royalcanin.india' } })
    expect(target?.kind).toBe('BRAND')
    expect(target?.discoveredFromCampaignId).toBe('c_AAA')
    // Brands are messaged, not watched — explicit against a schema default of TRUE.
    expect(target?.watchEnabled).toBe(false)
    // A PERSON's first name, and we do not know who runs a company's Instagram.
    expect(target?.contactFirstName).toBeNull()

    const pairs = await prisma.outreachPair.findMany({ include: { sender: true } })
    expect(pairs.map((p) => p.sender.handle).sort()).toEqual(['bollywoodsocietyy', 'madaboutmarketingg'])

    const audit = await prisma.auditLog.findMany()
    expect(audit).toHaveLength(1)
    // The actor is what separates "a person ran a command" from "a pass decided this".
    expect(audit[0]).toMatchObject({ actor: 'auto-resolve', action: 'brand.auto-decided' })
  })

  /**
   * THE SAFETY CASE. A paid post can @-mention one of our own pages — `@bollywoodsocietyy`
   * is a fleet SENDER and legitimately also a watched CHANNEL row — and without the
   * `is-our-sender` refusal the automatic path would turn a revenue account into a prospect
   * and wire every other page to cold-DM it.
   */
  it('refuses to make a prospect out of one of our own sending accounts', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    await addCampaign('BBB', 'Shot by @bollywoodsocietyy', channelId)
    answers.set('bollywoodsocietyy', brand('bollywoodsocietyy'))

    const out = await autoResolveBrands()

    /**
     * NOT LOOKED UP AT ALL since 2026-08-17, where this used to assert `looked: 1`.
     *
     * It was previously refused at target creation, AFTER spending one of the ten lookups a
     * pass gets — which was harmless while captions were the only candidate source. Media
     * tags are a source now, and @viralbhayani and @bollywoodpap appear in their OWN posts'
     * tags, so self-tags would have burned the scarce endpoint on handles that could never
     * become prospects. Excluded before the budget, not after it.
     *
     * The safety assertions below are UNCHANGED and are what the test is really for: no
     * target row, no route, no audit row. Only the cost changed.
     */
    expect(out.looked).toBe(0)
    expect(out.decided).toBe(0)
    expect(await prisma.targetAccount.findUnique({ where: { handle: 'bollywoodsocietyy' } })).toBeNull()
    expect(await prisma.outreachPair.count()).toBe(0)
    expect(await prisma.auditLog.count()).toBe(0)
  })

  /**
   * ── REVERSED DELIBERATELY, 2026-08-13 (repair plan phase 4.3) ──────────────────────
   *
   * This test used to assert the OPPOSITE — that discovering a brand also paired the
   * non-fleet burner — and its reasoning was that `@tabishmukaddam1` "is deliberately still
   * a usable SENDER for rehearsal". The first half of that is true and the conclusion did
   * not follow, which is why the reversal is recorded here rather than done quietly.
   *
   * WHAT WAS MEASURED. On the live database the burner held **72** `OutreachPair` rows —
   * every discovered BRAND target, plus both channels — created exactly this way by three
   * creators that all read `senderAccount.findMany()` unfiltered. Since 2026-08-08 a pair
   * row IS a live route; what kept those 72 inert was `runOutreach` scoping its query to
   * `fleetMember: true`, which is one query away from being routes to real companies from
   * the one account that must never do outreach.
   *
   * WHY REHEARSAL IS UNHARMED, and this is the part the old reasoning missed:
   * `prepareOnDemandSend` CREATES the pair it needs when a person picks a sender and a
   * recipient (`prisma.outreachPair.create` on the `findUnique ?? create` path — it is the
   * documented exempt creator in `tests/one-route-rule.test.ts`). So the pre-made rows
   * bought nothing that choosing to rehearse does not already provide.
   *
   * The rule now lives in `routes.ts` with every other exclusion instead of in one query's
   * `where`, and it reports `sender-not-in-fleet`. The burner remains MESSAGEABLE as a
   * TARGET — a separate fact, asserted directly below and in `tests/route-rule.test.ts`.
   */
  it('does NOT pair a non-fleet sender — an account outside the rotation gets no route', async () => {
    await addSender('madaboutmarketingg')
    await addSender('tabishmukaddam1', false)
    await addCampaign('MMM', 'Launch with @kalkifashion', channelId)
    answers.set('kalkifashion', brand('kalkifashion'))

    await autoResolveBrands()

    const pairs = await prisma.outreachPair.findMany({ include: { sender: true } })
    expect(pairs.map((p) => p.sender.handle).sort()).toEqual(['madaboutmarketingg'])
    // And the prospect WAS created — the refusal is about the route, not about the brand.
    // Without this the assertion above passes just as well on a pass that discovered nothing.
    expect(await prisma.targetAccount.findUnique({ where: { handle: 'kalkifashion' } })).not.toBeNull()
  })

  /**
   * The other half of the same rule, and the one that is a SAFETY property rather than a
   * reachability one: a fleet page that is also a target row must never be paired.
   * `routeAllowed` refuses it on `ourHandles`; a plain `findMany()` would not.
   */
  it('never routes to one of our own fleet pages that is also a target row', async () => {
    await addSender('madaboutmarketingg')
    await addSender('bollywoodsocietyy')
    // Society is a fleet SENDER and legitimately also a watched CHANNEL row.
    await prisma.targetAccount.create({
      data: { id: 't_society', handle: 'bollywoodsocietyy', displayName: 'Society', kind: 'CHANNEL' },
    })
    await addCampaign('NNN', 'Launch with @nutellaindia', channelId)
    answers.set('nutellaindia', brand('nutellaindia'))

    await autoResolveBrands()

    const routes = await prisma.outreachPair.findMany({ include: { sender: true, target: true } })
    expect(routes.every((p) => p.target.handle !== 'bollywoodsocietyy')).toBe(true)
  })

  it('never creates a route from an account to itself', async () => {
    // The brand handle is also a sender, and a target row for it already exists — the
    // rehearsal-recipient shape. `routeAllowed` must drop the self route.
    await addSender('madaboutmarketingg')
    await addCampaign('CCC', 'A campaign with @acme.brand', channelId)
    answers.set('acme.brand', brand('acme.brand'))

    await autoResolveBrands()

    const pairs = await prisma.outreachPair.findMany({ include: { sender: true, target: true } })
    expect(pairs.every((p) => p.sender.handle !== p.target.handle)).toBe(true)
  })
})

describe('a handle that is already settled is never looked up again', () => {
  it.each([
    ['BRAND', { kind: 'BRAND', category: 'Retail' }],
    ['PERSON', { kind: 'PERSON', category: 'Artist' }],
    ['MISSING', { kind: 'MISSING' }],
    /**
     * UNRESOLVED once the MODEL HAS RULED, in both of the ways it can rule.
     *
     * `decidedBy = 'model'` cannot in practice be UNRESOLVED (a model decision changes
     * `kind`), but it is asserted anyway: the gate is "has the model run", and a future
     * decision shape that leaves `kind` alone must not reopen the handle.
     *
     * The other state — UNRESOLVED with `decidedBy = null`, the model never asked — is NOT
     * here. It used to be, on the reasoning that a cached UNRESOLVED could never move at
     * all; that was a BUG rather than a law, and it is now the case immediately below.
     */
    ['UNRESOLVED (model decided)', { kind: 'UNRESOLVED', decidedBy: 'model' }],
    ['UNRESOLVED (model declined)', { kind: 'UNRESOLVED', decidedBy: 'model-declined' }],
  ])('skips a cached %s without spending a lookup', async (_label, row) => {
    await addSender('madaboutmarketingg')
    await addCampaign('DDD', 'Post with @settled.handle', channelId)
    // Older than the retry window, so each row is skipped because it is SETTLED and not
    // because it was tried recently — the two reasons are different and only one is on test.
    await prisma.brandLookup.create({
      data: {
        handle: 'settled.handle',
        checkedAt: new Date(Date.now() - (MODEL_RETRY_AFTER_MS + 60_000)),
        ...row,
      },
    })

    const out = await autoResolveBrands()

    expect(calls).toEqual([])
    expect(out.looked).toBe(0)
  })

  /** UNKNOWN is the one that MUST be retried: it means we never got to look. */
  it('retries a cached UNKNOWN — absence of an answer is not an answer', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('EEE', 'Post with @never.looked', channelId)
    /**
     * `checkedAt` is EXPLICIT and older than `UNKNOWN_RETRY_AFTER_MS`, for the reason this file
     * already states twice elsewhere: the column defaults to now(), which the anti-starvation
     * back-off correctly reads as "its own lookup just came back UNKNOWN — hold it one window".
     * Left at the default this test would assert the back-off rather than the retry, and would
     * fail for a reason that has nothing to do with what it is named after.
     *
     * The property here is unchanged and still the important one: UNKNOWN is never permanent.
     * Both directions of the window itself are asserted in the livelock block below.
     */
    await prisma.brandLookup.create({
      data: {
        handle: 'never.looked',
        kind: 'UNKNOWN',
        checkedAt: new Date(Date.now() - (UNKNOWN_RETRY_AFTER_MS + 60_000)),
      },
    })
    answers.set('never.looked', brand('never.looked'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['never.looked'])
    expect(out.decided).toBe(1)
  })

  it('skips a handle that is already a target row', async () => {
    await addSender('madaboutmarketingg')
    await prisma.targetAccount.create({
      data: { id: 't_known', handle: 'known.brand', displayName: 'Known', kind: 'BRAND' },
    })
    await addCampaign('FFF', 'Post with @known.brand', channelId)

    await autoResolveBrands()

    expect(calls).toEqual([])
  })

  it('asks about a handle once per pass however many captions mention it', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('GGG', 'First post with @repeat.brand', channelId, new Date('2026-08-05'))
    await addCampaign('HHH', 'Second post with @repeat.brand', channelId, new Date('2026-08-06'))
    answers.set('repeat.brand', brand('repeat.brand'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['repeat.brand'])
    expect(out.looked).toBe(1)
  })
})

/**
 * ── THE GAP THIS TASK CLOSES ──────────────────────────────────────────────
 *
 * `7f99c94` made `resolveBrand` fall through to the model for a cached UNRESOLVED the model
 * has never seen. `autoResolveBrands` could not reach it: `isSettled` returned true for
 * ANY cached UNRESOLVED, so the cron `continue`d before `resolveBrand` was ever called.
 *
 * So the fall-through ran only from `pnpm ig:brands` — a human command. That is the failure
 * this codebase has already paid for twice: 166 cover frames saved in a day and none read,
 * because the only frame-aware code sat behind `scripts/ocr.ts --reclassify`. **A feature
 * that works only when someone runs a command is not running.**
 *
 * Today's 30-row backlog was cleared by hand, so what these tests protect is the FUTURE
 * case: a handle lands UNRESOLVED, the model call fails or is skipped (the 30-minute
 * rate-limit cooldown from `7be9766` does exactly that), and nothing ever asks again
 * unattended.
 */
describe('a cached UNRESOLVED the model has never seen is reached by the cron', () => {
  it('looks it up — this is the gap the whole task exists to close', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('AD1', 'New drop with @adidas', channelId)
    /**
     * The live shape, MEASURED 2026-08-11: cached UNRESOLVED, `decidedBy` null because the row
     * predates the model entirely, `checkedAt` 2026-08-06. @adidas is the founding case of the
     * whole feature.
     *
     * `checkedAt` is set EXPLICITLY rather than left to default. The column's default is now(),
     * which the back-off correctly reads as "just tried" — so a row written by this helper
     * without a date would test the retry window instead of the gap, and would have passed for
     * the wrong reason had the back-off not been there.
     */
    await prisma.brandLookup.create({
      data: { handle: 'adidas', kind: 'UNRESOLVED', checkedAt: new Date('2026-08-06') },
    })
    answers.set('adidas', brand('adidas'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['adidas'])
    expect(out.looked).toBe(1)
    // `resolveBrand` owns the one-chance rule; when it decides, the prospect is created.
    expect(out.decided).toBe(1)
  })

  /**
   * The same row, one pass later, with the model having DECLINED it. `resolveBrand` records
   * `decidedBy = 'model-declined'` for exactly this, and the handle must go quiet — asking
   * the same question about the same evidence buys nothing and burns the bound.
   */
  it('goes quiet again once the model has ruled', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('AD2', 'New drop with @adidas', channelId)
    /**
     * `checkedAt` is deliberately set OLD — older than `MODEL_RETRY_AFTER_MS` — so the retry
     * window is provably not what is doing the work here. Left at its now() default this test
     * would pass on the back-off and would still pass with `modelHasRun` deleted, which is the
     * "passes for the wrong reason" trap this suite has been bitten by before.
     */
    await prisma.brandLookup.create({
      data: {
        handle: 'adidas',
        kind: 'UNRESOLVED',
        decidedBy: 'model-declined',
        checkedAt: new Date(Date.now() - (MODEL_RETRY_AFTER_MS + 60_000)),
      },
    })

    const out = await autoResolveBrands()

    expect(calls).toEqual([])
    expect(out.looked).toBe(0)
    // Settled, NOT held: the distinction is what an operator reads off the summary.
    expect(out.awaitingRetry).toBe(0)
  })
})

/**
 * ── THE REPEATED-FAILURE LOOP, AND WHY IT NEEDED ITS OWN MECHANISM ────────
 *
 * The docblock `isSettled` used to carry was RIGHT about a danger and wrong about the fix.
 * The danger, restated precisely now that UNRESOLVED is reopened:
 *
 *   A failed model call records NOTHING (`decidedBy` stays null), deliberately, so it stays
 *   retryable — a network blip or a missing API key must never permanently silence a real
 *   prospect. But "retryable" with no back-off means every fifteen minutes, forever: with no
 *   API key configured, ten such handles fill `MAX_LOOKUPS_PER_PASS` on every pass and the
 *   genuinely new mentions behind them are never reached. Starvation, silent, self-perpetuating
 *   — the same shape as the stale rate-limit latch that disabled this feature for two hours.
 *
 * The back-off is `checkedAt`, which `persistResolution` bumps on EVERY write including a
 * failed one. No new column, and no second copy of state that a restart could disagree with.
 */
describe('a handle whose model call keeps failing backs off instead of starving the pass', () => {
  it('does not re-ask within the retry window', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('FF1', 'Post with @tried.recently', channelId)
    // A model call that FAILED: `decidedBy` null (still retryable), `checkedAt` just now.
    await prisma.brandLookup.create({
      data: { handle: 'tried.recently', kind: 'UNRESOLVED', checkedAt: new Date() },
    })

    const out = await autoResolveBrands()

    expect(calls).toEqual([])
    expect(out.looked).toBe(0)
    // VISIBLE, not silent. A count that quietly rises is the failure this project keeps
    // finding late, so the pass reports how many handles it is holding back.
    expect(out.awaitingRetry).toBe(1)
  })

  it('re-asks once the window has passed', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('FF2', 'Post with @tried.long.ago', channelId)
    await prisma.brandLookup.create({
      data: {
        handle: 'tried.long.ago',
        kind: 'UNRESOLVED',
        checkedAt: new Date(Date.now() - (MODEL_RETRY_AFTER_MS + 60_000)),
      },
    })
    answers.set('tried.long.ago', brand('tried.long.ago'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['tried.long.ago'])
    expect(out.decided).toBe(1)
    expect(out.awaitingRetry).toBe(0)
  })

  /**
   * A row from BEFORE the model existed must be offered on the very first pass, not held for
   * the retry window. Its `checkedAt` is the endpoint lookup's timestamp, which says nothing
   * about the model — and on the live database those are days old, so the window is
   * comfortably clear. This asserts the ordinary case rather than a boundary: the 30 real
   * rows were all `checkedAt` 2026-08-06.
   */
  it('offers a pre-model row immediately — its checkedAt is the endpoint, not the model', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('FF3', 'Post with @old.unresolved', channelId)
    await prisma.brandLookup.create({
      data: { handle: 'old.unresolved', kind: 'UNRESOLVED', checkedAt: new Date('2026-08-06') },
    })
    answers.set('old.unresolved', brand('old.unresolved'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['old.unresolved'])
    expect(out.decided).toBe(1)
  })

  /**
   * THE STARVATION CASE ITSELF, and the one a bound alone cannot show. Ten handles whose
   * model call keeps failing sit in front of one genuinely new mention. Without the back-off
   * the ten consume `MAX_LOOKUPS_PER_PASS` and the new handle is never reached — on this pass
   * and on every pass after it.
   */
  it('lets a NEW mention through past a wall of failing handles', async () => {
    await addSender('madaboutmarketingg')
    const failing = Array.from({ length: 12 }, (_, i) => `fail.${i}`)
    await addCampaign('FF4', `With ${failing.map((h) => `@${h}`).join(' ')} @fresh.brand`, channelId)
    for (const handle of failing) {
      await prisma.brandLookup.create({ data: { handle, kind: 'UNRESOLVED', checkedAt: new Date() } })
    }
    answers.set('fresh.brand', brand('fresh.brand'))

    const out = await autoResolveBrands()

    expect(calls).toEqual(['fresh.brand'])
    expect(out.decided).toBe(1)
    expect(out.awaitingRetry).toBe(12)
  })

  /**
   * AND THE DEGRADATION IS VISIBLE. A pass that spends its whole bound on handles that keep
   * failing must SAY so, or it is exactly the silent no-op this codebase keeps rediscovering.
   * The warning fires on the pass that holds handles back, which is the only moment anyone
   * could act on it.
   */
  it('warns when handles are being held back', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('FF5', 'With @held.one @held.two', channelId)
    for (const handle of ['held.one', 'held.two']) {
      await prisma.brandLookup.create({ data: { handle, kind: 'UNRESOLVED', checkedAt: new Date() } })
    }

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      const out = await autoResolveBrands()
      expect(out.awaitingRetry).toBe(2)
      const said = warn.mock.calls.map(([m]) => String(m)).join(' | ')
      expect(said).toMatch(/awaiting a model retry|retry/i)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the pass is bounded', () => {
  it('stops at maxLookups, counting lookups rather than creations', async () => {
    await addSender('madaboutmarketingg')
    // Five mentions, none of which resolve to a brand — so `decided` stays 0 while the
    // bound is still consumed. A bound that counted creations would drive the endpoint
    // once per mention with the counter stuck at zero, which is the mistake the
    // dispatcher's per-tick bound already made once.
    await addCampaign('III', 'With @a.one @b.two @c.three @d.four @e.five', channelId)
    for (const h of ['a.one', 'b.two', 'c.three', 'd.four', 'e.five']) {
      answers.set(h, { kind: 'PERSON', handle: h, category: 'Artist' })
    }

    const out = await autoResolveBrands({ maxLookups: 2 })

    expect(out.looked).toBe(2)
    expect(out.decided).toBe(0)
    expect(calls).toHaveLength(2)
  })

  /** A post from before Tabish's 1 August cutoff is history, and is not resolved. */
  it('ignores captions from before the detection cutoff', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('JJJ', 'Old post with @ancient.brand', channelId, new Date('2026-07-15'))
    answers.set('ancient.brand', brand('ancient.brand'))

    const out = await autoResolveBrands()

    expect(calls).toEqual([])
    expect(out.looked).toBe(0)
  })
})

describe('a throttle stops the pass, and marks nothing', () => {
  /**
   * UNKNOWN from `resolveBrand` means its internal halt flag is set (a 429/401/403) or the
   * network failed. Every remaining lookup would return UNKNOWN without a request, so
   * continuing would be a silent no-op. The pass stops, reports it, and writes no verdict —
   * continuing to ask after being told to stop is what turns throttling into an IP block.
   */
  it('returns early on UNKNOWN without creating or excluding anything', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('KKK', 'With @throttled.one @after.one @after.two', channelId)
    /**
     * ALL THREE get explicit `checkedAt` values, so the throttling handle is provably FIRST.
     * What is under test here is "a halt stops the pass and marks nothing", which needs the
     * halt to land with work still behind it.
     *
     * Attempt order is now `checkedAt` ascending (the livelock fix) and a handle NEVER LOOKED
     * AT sorts ahead of every handle already tried — so an old timestamp alone is not enough:
     * measured while writing this, `throttled.one` landed THIRD behind two never-looked
     * handles and the pass resolved both before halting. Giving all three a cached row makes
     * the comparison a pure `checkedAt` one. That the case takes this much effort to construct
     * is the fix working: a handle that just failed no longer gets to the front by default.
     */
    const base = Date.now() - 10 * UNKNOWN_RETRY_AFTER_MS
    await prisma.brandLookup.create({
      data: { handle: 'throttled.one', kind: 'UNKNOWN', checkedAt: new Date(base) },
    })
    await prisma.brandLookup.create({
      data: { handle: 'after.one', kind: 'UNKNOWN', checkedAt: new Date(base + 60_000) },
    })
    await prisma.brandLookup.create({
      data: { handle: 'after.two', kind: 'UNKNOWN', checkedAt: new Date(base + 120_000) },
    })
    answers.set('throttled.one', { kind: 'UNKNOWN', handle: 'throttled.one', reason: 'HTTP 429' })
    answers.set('after.one', brand('after.one'))
    answers.set('after.two', brand('after.two'))

    const out = await autoResolveBrands()

    expect(out.haltedEarly).toBe(true)
    expect(out.looked).toBe(1)
    expect(out.decided).toBe(0)
    // The handles behind the throttle were never asked about — not marked, not excluded.
    expect(calls).toEqual(['throttled.one'])
    // ...and they are REPORTED as waiting rather than silently dropped, which is the number
    // whose absence let `looked=1 haltedEarly=true` repeat for hours without alarming anyone.
    expect(out.unreached).toBe(2)
    expect(await prisma.targetAccount.count({ where: { kind: 'BRAND' } })).toBe(0)
  })

  /**
   * Instagram's permanent category-schema 400 is UNRESOLVED, not UNKNOWN, and it must NOT
   * stop the pass — it fires on precisely the accounts most likely to be brands, so halting
   * on it would mean one broken handle emptying every run. That reading already cost this
   * project three consecutive zero-progress runs against a healthy endpoint.
   */
  it('keeps going past an UNRESOLVED — one broken handle is not a throttle', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('LLL', 'With @schema.bug @real.brand', channelId)
    answers.set('schema.bug', { kind: 'UNRESOLVED', handle: 'schema.bug', reason: 'HTTP 400: schema bug' })
    answers.set('real.brand', brand('real.brand'))

    const out = await autoResolveBrands()

    expect(out.haltedEarly).toBe(false)
    expect(out.skippedUnsure).toBe(1)
    expect(out.decided).toBe(1)
    /**
     * BOTH were asked about, which is the property: an UNRESOLVED does not stop the pass. The
     * ORDER is deliberately not asserted — attempt order is now `checkedAt` ascending and both
     * of these are never-looked handles, so pinning a sequence here would couple a test about
     * halting behaviour to the tie-break rule, which has its own tests below.
     */
    expect([...calls].sort()).toEqual(['real.brand', 'schema.bug'])
    expect(out.unreached).toBe(0)
  })
})

/**
 * ── THE LIVELOCK: ONE UNLUCKY HANDLE MONOPOLISED THE WHOLE BUDGET ─────────
 *
 * MEASURED on the live server 2026-08-11. Every 15-minute pass for hours:
 *
 *   brand auto-resolve  looked=1 created=0 needsAHuman=0 awaitingRetry=0 haltedEarly=true
 *   brand lookup rate-limited — backing off  handle=iconicbyonevision status=429
 *
 * `MAX_LOOKUPS_PER_PASS` is 10 and `looked` was 1, forever. Three individually-correct rules
 * composed into a trap: UNKNOWN is deliberately retried (it means "we never got to look"); the
 * walk was newest-post-then-caption order, which is POSITIONAL and identical on every pass; and
 * a 429 correctly halts. So a fixed head starved everything behind it.
 *
 * Control probes proved the endpoint HEALTHY — @iconicbyonevision returned 200 from the server
 * and a laptop, and six spaced probes returned 200 every time. Sporadic 429 bursts against the
 * datacenter IP, landing on whichever handle goes first. Which is why "whichever handle goes
 * first" had to stop being the same handle.
 *
 * TWO FIXES, AND THEY HIDE EACH OTHER — SIMULATED BEFORE EITHER WAS WRITTEN:
 *
 *   ordering alone      drains the backlog, then the unlucky handle is the only one left,
 *                       returns to the head and halts every pass again. Better, not fixed.
 *   the back-off alone  breaks the loop AND MAKES THE ORDERING INVISIBLE: both orders then
 *                       resolve the same handles, so a mutation test on the ordering PASSES
 *                       with the old ordering restored, proving nothing.
 *
 * That second line is why the ordering test below drives a scenario the cooldown cannot reach:
 * a recently-failed handle PAST its window (so legitimately eligible) in front of never-looked
 * mentions. Old order resolves NOTHING; new order resolves all three and takes the halt last.
 */
describe('the retry order rotates, so one unlucky handle cannot starve the rest', () => {
  /**
   * THE LIVELOCK ITSELF, and the mutation-test target.
   *
   * `@throttler` failed most recently, so it must be LAST. Its `checkedAt` is set older than
   * `UNKNOWN_RETRY_AFTER_MS` deliberately — it is therefore ELIGIBLE, and the per-handle
   * back-off provably is not what saves this pass. Only the ordering can.
   *
   * Restore the old caption ordering and `calls` becomes `['throttler']` with nothing decided:
   * the halt lands on the first handle and the other three are never reached.
   */
  it('puts the most-recently-failed handle LAST, behind handles never looked at', async () => {
    await addSender('madaboutmarketingg')
    // Caption order deliberately puts the failing handle FIRST — that is the production shape.
    // The fresh handles are named a/b/c so their alphabetical tie-break (they have never been
    // looked at, so they tie on `checkedAt`) matches reading order and the assertion stays legible.
    await addCampaign('LV1', 'With @throttler @fresh.a @fresh.b @fresh.c', channelId)
    await prisma.brandLookup.create({
      data: {
        handle: 'throttler',
        kind: 'UNKNOWN',
        checkedAt: new Date(Date.now() - (UNKNOWN_RETRY_AFTER_MS + 60_000)),
      },
    })
    answers.set('throttler', { kind: 'UNKNOWN', handle: 'throttler', reason: 'HTTP 429' })
    for (const h of ['fresh.a', 'fresh.b', 'fresh.c']) answers.set(h, brand(h))

    const out = await autoResolveBrands()

    // The three never-looked handles go FIRST; the halt is taken last, costing nothing.
    expect(calls).toEqual(['fresh.a', 'fresh.b', 'fresh.c', 'throttler'])
    expect(out.decided).toBe(3)
    // A real 429 still halts the pass — requirement 1, not weakened.
    expect(out.haltedEarly).toBe(true)
  })

  /** A 429 still stops the pass dead. The ordering changed WHICH handle gets there, not this. */
  it('still halts on a 429 rather than continuing to ask', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('LV2', 'With @a.first @b.throttles @c.behind @d.behind', channelId)
    // Drive checkedAt explicitly so the order is known: a.first, then b.throttles, then the rest.
    const t = Date.now()
    await prisma.brandLookup.create({
      data: { handle: 'a.first', kind: 'UNKNOWN', checkedAt: new Date(t - 5 * UNKNOWN_RETRY_AFTER_MS) },
    })
    await prisma.brandLookup.create({
      data: { handle: 'b.throttles', kind: 'UNKNOWN', checkedAt: new Date(t - 4 * UNKNOWN_RETRY_AFTER_MS) },
    })
    await prisma.brandLookup.create({
      data: { handle: 'c.behind', kind: 'UNKNOWN', checkedAt: new Date(t - 3 * UNKNOWN_RETRY_AFTER_MS) },
    })
    await prisma.brandLookup.create({
      data: { handle: 'd.behind', kind: 'UNKNOWN', checkedAt: new Date(t - 2 * UNKNOWN_RETRY_AFTER_MS) },
    })
    answers.set('a.first', brand('a.first'))
    answers.set('b.throttles', { kind: 'UNKNOWN', handle: 'b.throttles', reason: 'HTTP 429' })
    answers.set('c.behind', brand('c.behind'))
    answers.set('d.behind', brand('d.behind'))

    const out = await autoResolveBrands()

    expect(out.haltedEarly).toBe(true)
    // Stopped AT the throttle. The two behind it were never asked — not marked, not excluded.
    expect(calls).toEqual(['a.first', 'b.throttles'])
    // And the operator can see a queue is waiting, which `looked=1 haltedEarly=true` never said.
    expect(out.unreached).toBe(2)
    expect(await prisma.targetAccount.count({ where: { handle: 'c.behind' } })).toBe(0)
  })

  /**
   * A PERMANENTLY-UNLUCKY HANDLE DOES NOT BLOCK OTHERS ACROSS PASSES.
   *
   * Several passes, one handle that 429s every single time. The livelock was that every pass
   * attempted only that handle; here each pass must reach different work. The mock's `calls`
   * is cleared between passes so what each pass attempted is asserted separately.
   */
  it('lets later passes reach different handles while one keeps failing', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('LV3', 'With @always.429 @p1 @p2 @p3', channelId)
    answers.set('always.429', { kind: 'UNKNOWN', handle: 'always.429', reason: 'HTTP 429' })
    for (const h of ['p1', 'p2', 'p3']) answers.set(h, brand(h))

    const attempts: string[][] = []
    for (let pass = 0; pass < 3; pass++) {
      calls.length = 0
      await autoResolveBrands({ maxLookups: 2 })
      attempts.push([...calls])
      /**
       * `resolveBrand` is MOCKED, so nothing writes `BrandLookup` — the real one bumps
       * `checkedAt` through `persistResolution` on every write, a 429 included, which is what
       * moves a failed handle to the back. Stamping it here reproduces that one effect so the
       * cross-pass behaviour is what is under test rather than the mock's silence.
       */
      for (const handle of calls) {
        const answer = answers.get(handle)
        if (answer?.kind === 'UNKNOWN') {
          await prisma.brandLookup.upsert({
            where: { handle },
            update: { kind: 'UNKNOWN', checkedAt: new Date() },
            create: { handle, kind: 'UNKNOWN', checkedAt: new Date() },
          })
        }
      }
    }

    // THE LIVELOCK WOULD BE [['always.429'], ['always.429'], ['always.429']].
    const everAttempted = new Set(attempts.flat())
    expect(everAttempted.size).toBeGreaterThan(1)
    // Real prospects got looked at rather than being starved behind the failing handle.
    expect([...everAttempted].filter((h) => h !== 'always.429').length).toBeGreaterThanOrEqual(2)
    // And it stops occupying the head: once it has just failed it is held by the back-off.
    expect(attempts[1]).not.toContain('always.429')
  })

  /**
   * UNKNOWN MUST NOT BECOME PERMANENT. The back-off is a delay, never a verdict — absence of
   * data hardening into an answer is this codebase's most-repeated failure, so both directions
   * are asserted: held inside the window, offered again once it lapses.
   */
  it('holds a just-failed UNKNOWN, and retries it once the window lapses', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('LV4', 'With @recent.429', channelId)
    await prisma.brandLookup.create({
      data: { handle: 'recent.429', kind: 'UNKNOWN', checkedAt: new Date() },
    })
    answers.set('recent.429', brand('recent.429'))

    const held = await autoResolveBrands()
    expect(calls).toEqual([])
    // Reported, not silent: a number that quietly rises is the failure found late every time.
    expect(held.backingOff).toBe(1)

    // The SAME row, now older than the window. Nothing else changed.
    await prisma.brandLookup.update({
      where: { handle: 'recent.429' },
      data: { checkedAt: new Date(Date.now() - (UNKNOWN_RETRY_AFTER_MS + 60_000)) },
    })

    const retried = await autoResolveBrands()
    expect(calls).toEqual(['recent.429'])
    expect(retried.decided).toBe(1)
    expect(retried.backingOff).toBe(0)
  })

  /** The per-pass bound still holds, and still counts LOOKUPS rather than creations. */
  it('keeps the per-pass bound with the new ordering', async () => {
    await addSender('madaboutmarketingg')
    await addCampaign('LV5', 'With @o.1 @o.2 @o.3 @o.4 @o.5 @o.6', channelId)
    for (const h of ['o.1', 'o.2', 'o.3', 'o.4', 'o.5', 'o.6']) {
      answers.set(h, { kind: 'PERSON', handle: h, category: 'Artist' })
    }

    const out = await autoResolveBrands({ maxLookups: 3 })

    expect(out.looked).toBe(3)
    expect(calls).toHaveLength(3)
    // The three eligible handles that were not reached are VISIBLE, not silently dropped.
    expect(out.unreached).toBe(3)
  })

  /**
   * The ordering rule itself, as a pure function, driven on `checkedAt` explicitly.
   * `orderForLookup` is exported so the head-of-queue rule is testable without a database —
   * the same reason `pacing.ts` and `gate.ts` are pure.
   */
  describe('orderForLookup', () => {
    const at = (ms: number | null) => (ms === null ? null : new Date(ms))

    it('puts never-looked handles before every handle already tried', () => {
      const order = orderForLookup([
        { handle: 'tried.old', checkedAt: at(1_000) },
        { handle: 'never', checkedAt: at(null) },
        { handle: 'tried.recent', checkedAt: at(9_000) },
      ])
      expect(order.map((c) => c.handle)).toEqual(['never', 'tried.old', 'tried.recent'])
    })

    it('puts the most recently tried handle last — the livelock rule', () => {
      const order = orderForLookup([
        { handle: 'just.failed', checkedAt: at(9_999) },
        { handle: 'ages.ago', checkedAt: at(1) },
        { handle: 'a.while.ago', checkedAt: at(500) },
      ])
      expect(order.map((c) => c.handle)).toEqual(['ages.ago', 'a.while.ago', 'just.failed'])
    })

    /**
     * TOTAL, so the order is the same on every pass. A nondeterministic order would make this
     * livelock reappear intermittently rather than reliably, which is far harder to see.
     */
    it('breaks ties on the handle so the order is deterministic', () => {
      const same = 5_000
      const first = orderForLookup([
        { handle: 'zebra', checkedAt: at(same) },
        { handle: 'alpha', checkedAt: at(same) },
      ])
      const second = orderForLookup([
        { handle: 'alpha', checkedAt: at(same) },
        { handle: 'zebra', checkedAt: at(same) },
      ])
      expect(first.map((c) => c.handle)).toEqual(['alpha', 'zebra'])
      expect(second.map((c) => c.handle)).toEqual(['alpha', 'zebra'])
    })

    it('does not mutate its input', () => {
      const input = [
        { handle: 'b', checkedAt: at(9) },
        { handle: 'a', checkedAt: at(1) },
      ]
      orderForLookup(input)
      expect(input.map((c) => c.handle)).toEqual(['b', 'a'])
    })
  })
})

/**
 * ── THE TEST THIS TASK EXISTS FOR ─────────────────────────────────────────
 *
 * In the spirit of `tests/one-judging-path.test.ts`. MEASURED 2026-08-08: 166 cover frames
 * were saved in one day and NONE were read, because the only frame-aware code lived behind
 * `scripts/ocr.ts --reclassify`. **A feature that works only when someone runs a command is
 * not running.**
 *
 * Brand resolution is now in exactly that position: `decideBrand` and
 * `applyModelToUnresolved` were built by earlier tasks and, without a caller on the automatic
 * path, would only ever run when somebody typed `pnpm ig:brands --run`. A behavioural test
 * cannot fail for a call nobody wrote, so this reads the source — the only check that fails
 * on REMOVAL rather than on modification.
 */
describe('brand resolution actually runs on the automatic path', () => {
  const pipeline = readFileSync(join(process.cwd(), 'src/detection/pipeline.ts'), 'utf8')

  it('the detection pipeline calls autoResolveBrands', () => {
    expect(
      /autoResolveBrands\s*\(/.test(pipeline),
      'src/detection/pipeline.ts must call autoResolveBrands(). Without it, brand resolution ' +
        'only happens when a person runs `pnpm ig:brands --run` — which is the "built but ' +
        'never runs" failure that left 166 cover frames unread for a day.',
    ).toBe(true)
  })

  it('a failure there cannot take the detection pass down with it', () => {
    /**
     * Decision 5: a monitoring subsystem must never be able to silence the thing it
     * monitors. A scarce third-party endpoint failing must not cost us the posts already
     * read and stored, so the call is caught.
     */
    expect(
      /autoResolveBrands\(\)[\s\S]{0,120}?\.catch\(/.test(pipeline),
      'the autoResolveBrands call must be `.catch`-ed — a brand-lookup failure must never ' +
        'discard a detection pass that already read and stored posts',
    ).toBe(true)
  })

  it('the outcome is reported rather than logged and forgotten', () => {
    // A number that silently falls as the endpoint degrades is the failure this project
    // keeps finding late, so the summary carries it to the caller.
    expect(pipeline).toMatch(/brandsResolved/)
  })
})

/**
 * ONE CREATOR, TWO CALLERS. `tests/one-route-rule.test.ts` guards pair creation; this guards
 * the rest of what makes a new prospect safe. `ig:brands` held a private copy of this block
 * until 2026-08-08, and a copy is how the other five rules in this codebase drifted.
 */
describe('one place creates a brand target', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it.each(['src/scripts/brands.ts', 'src/detection/autoResolve.ts'])(
    '%s creates brands through createBrandTarget',
    (file) => {
      const source = read(file)
      expect(source).toMatch(/createBrandTarget\s*\(/)
      expect(
        /prisma\.targetAccount\.create\s*\(/.test(source),
        `${file} creates a TargetAccount directly instead of asking brandTarget.ts — that is ` +
          `the sixth diverging copy this suite exists to prevent`,
      ).toBe(false)
    },
  )
})

/**
 * ── THE HANDLES INSTAGRAM ALREADY GAVE US, WHICH DISCOVERY NEVER READ ──────
 *
 * MEASURED 2026-08-17: **135 of 286 in-window CAMPAIGN posts (47%) carry no caption
 * @mention at all**, and 134 of those name a brand. Discovery read @mentions and nothing
 * else, so nearly half of every paid post it found produced no prospect.
 *
 * The obvious fix — take the extracted brand NAME and construct a handle — was probed live
 * and is unsafe: there is no anonymous name→handle search (401/404, while the per-handle
 * verifier answers 200 in the same run), and constructing a handle was wrong 4 times in 10
 * with **3 of the 4 wrong handles EXISTING**, so an existence check passes on the wrong
 * account. `@philips` is the global HQ; `@philipsindia` ran the campaign.
 *
 * So this reads `taggedAccounts` and `collabHandles` — facts Instagram asserts about the
 * post, stored since the beginning and read by nothing in discovery.
 */
describe('media tags are a discovery source, ordered behind caption mentions', () => {
  it('extracts tagged accounts and co-authors, and ignores a malformed column', () => {
    expect(taggedHandlesIn('["@philipsindia","sonytvofficial"]', null)).toEqual(['philipsindia', 'sonytvofficial'])
    expect(taggedHandlesIn('[]', '{"collabHandles":["redchilliesent"]}')).toEqual(['redchilliesent'])
    // Both sources, de-duplicated, with Instagram furniture dropped.
    expect(taggedHandlesIn('["instagram","zee5"]', '{"collabHandles":["zee5","tseries.official"]}')).toEqual([
      'zee5',
      'tseries.official',
    ])
    // A malformed column must never fail a detection pass (decision 5, one layer on).
    expect(taggedHandlesIn('not json', 'also not json')).toEqual([])
    expect(taggedHandlesIn('', null)).toEqual([])
  })

  /**
   * The bound is a LOOKUP budget, so a weaker candidate taking a slot is a stronger one not
   * taken. A tag is weaker than a caption mention — @bollywoodchronicle tags someone in
   * 46.3% of ORGANIC posts against 20.0% of CAMPAIGN posts, so the correlation inverts —
   * and must therefore be asked about second.
   */
  it('asks about caption mentions before media tags', () => {
    const ordered = orderForLookup([
      { handle: 'fromtag', checkedAt: null, source: 'tag' as const },
      { handle: 'zzz_frommention', checkedAt: null, source: 'mention' as const },
    ])
    expect(ordered.map((c) => c.handle)).toEqual(['zzz_frommention', 'fromtag'])
  })

  /** A candidate with no source sorts as a mention — the direction that favours the budget. */
  it('treats an unsourced candidate as a mention', () => {
    const ordered = orderForLookup([
      { handle: 'aaa_tag', checkedAt: null, source: 'tag' as const },
      { handle: 'zzz_unsourced', checkedAt: null },
    ])
    expect(ordered.map((c) => c.handle)).toEqual(['zzz_unsourced', 'aaa_tag'])
  })
})
