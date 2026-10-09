import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `handOffWaitingDrafts` — removing a sender must never cost a recipient (Tabish,
 * 2026-08-19), driven through the REAL Prisma client against a temporary SQLite file,
 * exactly like tests/fleet-pairs.test.ts and for the same reason: the behaviour under
 * test is a chain of `where` clauses and conditional writes, which a pure mirror of the
 * logic would agree with either way.
 *
 * ── RELEASED, NEVER RE-POINTED (2026-10-09) ───────────────────────────────
 *
 * Until now this file asserted that a waiting draft MOVED — `pairId`, `senderId` and
 * `touchNumber` rewritten onto rotation's choice — and its last test pinned a first touch
 * renumbered touch 2 onto a page that had already written, which is a draft the gate holds
 * forever as identical and nothing replaces. Moving the bytes made a follow-up into another
 * page's FIRST message and an introduction into a stalled duplicate; `handOff.ts` records the
 * whole reproduction. The properties now:
 *
 *   - a waiting draft is RELEASED through the one discard writer: SKIPPED on the pair it was
 *     written for, its post claim freed, so the planner writes the elected page's OWN message
 *   - a recipient another account covers — including one being SENT to right now — gets its
 *     duplicate discarded, not doubled
 *   - a retired recipient's draft is discarded
 *   - `not-in-thread` and `profile-gone` rows are UNTOUCHED
 *   - a draft claimed SENDING after the hand-off read the queue is left exactly where it is
 *   - with no other page able to write to the recipient, the draft stays put and says so
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

  /*
    THE CATEGORY TABLES (2026-08-25). routes.ts now asks which fleet a sender and a recipient
    belong to, and readCategoryMemberships reads these two join tables on every creator path —
    so a temp database without them throws before any assertion runs. This is the
    hand-transcribed-DDL trap CLAUDE.md records: the suite failed 102 tests the last time a
    column was added and these blocks were not updated. Left EMPTY on purpose, which is the
    default category on both sides, so every assertion in this file still means what it meant.
  */
  CREATE TABLE "Category" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL UNIQUE,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategorySender" (
    "id" TEXT PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategoryTarget" (
    "id" TEXT PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
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

  CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  /*
    The hand-off itself reads no setting. \`whoseTurn\` does — \`readBlockedRoutes\` asks the reply
    halt's scope — and the tests below ask it who the planner will elect after a release, which
    is the property that matters: no draft may be left on a route rotation would not choose.
  */
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { handOffWaitingDrafts } = await import('@/outreach/handOff')
const { whoseTurn } = await import('@/outreach/categories')
const { claimedCampaignIds } = await import('@/outreach/compose')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')

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
      // `whoseTurn` is asked about a fleet that can actually send.
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
  touchNumber?: number
  body?: string
  campaignId?: string | null
  sentAt?: Date | null
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
      touchNumber: args.touchNumber ?? 1,
      renderedBody: args.body ?? SINGLE_TEMPLATE_MIDDLE,
      status: args.status ?? 'READY',
      failureCode: args.failureCode ?? null,
      attempts: args.attempts ?? 0,
      campaignId: args.campaignId ?? null,
      sentAt: args.sentAt ?? (args.status === 'SENT' ? new Date() : null),
    },
  })
}

/** What `removeSender` does first — the hand-off is always called on a page already out. */
async function takeOut(id: string) {
  await prisma.senderAccount.update({ where: { id }, data: { fleetMember: false } })
}

const handOff = () => handOffWaitingDrafts({ senderId: 'leaving', senderHandle: 'leaving', actor: 'test' })

/** Every draft waiting to go to this recipient, from anyone. */
async function waitingFor(targetId: string) {
  return prisma.outreachAttempt.findMany({ where: { targetId, status: { in: ['READY', 'QUEUED'] } } })
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await prisma.auditLog.deleteMany({})
  await prisma.setting.deleteMany({})
  await prisma.categorySender.deleteMany({})
  await prisma.categoryTarget.deleteMany({})
  await prisma.category.deleteMany({})
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
  it('RELEASES a waiting draft — never re-points it — through the one discard writer', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('beta')
    await seedTarget('t_brand')
    await seedDraft({ id: 'd1', senderId: 'leaving', targetId: 't_brand' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1, discarded: 0, kept: 0 })

    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd1' } })
    expect(row.status).toBe('SKIPPED')
    // The route it was written for, unchanged — an attempt's route never changes.
    expect(row.pairId).toBe('pair_leaving_t_brand')
    expect(row.senderId).toBe('leaving')
    expect(row.touchNumber).toBe(1)

    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'attempt.transferred.handoff' } })).toBe(0)
    // Nothing is left waiting for them: the planner's next pass writes the elected page's own.
    expect(await waitingFor('t_brand')).toHaveLength(0)
  })

  /**
   * THE AUDIT'S CASE, reproduced at the base commit: @leaving had written once and its
   * follow-up was waiting; @alpha had never written. The move renumbered it touch 1, so the
   * gate read it as alpha's introduction — every follow-up rule skipped, the pre-send thread
   * read skipped — and alpha's FIRST message to them was a follow-up citing a post.
   */
  it("a follow-up never becomes another page's first message, and its post claim is freed", async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t')
    await seedDraft({ id: 'first', senderId: 'leaving', targetId: 't', status: 'SENT', touchNumber: 1 })
    await seedDraft({
      id: 'follow',
      senderId: 'leaving',
      targetId: 't',
      touchNumber: 2,
      campaignId: 'c1',
      body: 'Hi,We saw your Toxic placement on 30 Aug — we can put that same campaign in front of 300M+ views a day.',
    })
    await takeOut('leaving')
    expect(await claimedCampaignIds('t')).toContain('c1')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1 })
    expect(await waitingFor('t'), 'a follow-up must not be waiting under a page that never wrote').toHaveLength(0)
    expect(
      await claimedCampaignIds('t'),
      'the released draft must give its post back, or the next page has nothing to cite',
    ).not.toContain('c1')
    // The delivered history is untouched.
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'first' } })).status).toBe('SENT')
  })

  /**
   * REPLACES the test that pinned the wedge. The old assertion was that a first touch moved to
   * @beta — which had already delivered the identical template — became touch 2. The gate then
   * holds it forever as `identical-to-a-message-they-already-have`, and because the planner's
   * pending check is per pair, nothing ever replaces it: the recipient stalls.
   */
  it('a first touch is never renumbered onto a page that already wrote to them', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('beta')
    await seedTarget('t_history')
    await seedDraft({ id: 'old_beta', senderId: 'beta', targetId: 't_history', status: 'SENT' })
    await prisma.outreachAttempt.update({ where: { id: 'old_beta' }, data: { sentAt: new Date('2026-08-01T10:00:00Z') } })
    await seedDraft({ id: 'old_alpha', senderId: 'alpha', targetId: 't_history', status: 'SENT' })
    await prisma.outreachAttempt.update({ where: { id: 'old_alpha' }, data: { sentAt: new Date('2026-08-10T10:00:00Z') } })
    await seedDraft({ id: 'd_next', senderId: 'leaving', targetId: 't_history' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1, kept: 0 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_next' } })
    expect(row.status).toBe('SKIPPED')
    expect(row.touchNumber).toBe(1)
    expect(
      await prisma.outreachAttempt.count({ where: { targetId: 't_history', status: 'READY', touchNumber: 2 } }),
      'an introduction renumbered as a follow-up is a draft the gate holds forever',
    ).toBe(0)
  })

  /**
   * R1. The hand-off's own election skipped `readBlockedRoutes`: @beta delivered last, so its
   * "next" was @alpha — whose route to this recipient is PARKED on an uncertain send. The draft
   * landed there, the gate holds it for as long as the park stands, and `whoseTurn` (the
   * planner's elector) chose @beta and wrote it a SECOND draft. Releasing leaves the planner as
   * the only elector.
   */
  it('never strands a draft on a route rotation would skip', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('beta')
    await seedTarget('t')
    await seedDraft({ id: 'beta_sent', senderId: 'beta', targetId: 't', status: 'SENT' })
    await seedDraft({
      id: 'alpha_park',
      senderId: 'alpha',
      targetId: 't',
      status: 'FAILED',
      failureCode: 'not-in-thread',
      attempts: 1,
    })
    await seedDraft({ id: 'd', senderId: 'leaving', targetId: 't' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1, kept: 0 })
    expect(
      await prisma.outreachAttempt.count({ where: { pairId: 'pair_alpha_t', status: { in: ['READY', 'QUEUED'] } } }),
      'a draft on a parked route is held for as long as the park stands',
    ).toBe(0)

    const turn = await whoseTurn({ targetId: 't' })
    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.senderId, 'the planner elects past the parked route').toBe('beta')
  })

  /**
   * R2. A recipient in a GROUP is rotated by that group's `CategorySender.position`, while the
   * hand-off sorted the fleet by cohort then handle. The two disagreed, so the hand-off put the
   * draft on one page and the planner wrote another a second one.
   */
  it('a group-ring recipient is not handed to a page the group ring would not elect', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedSender('zeta')
    await prisma.category.create({ data: { id: 'c_grp', name: 'Marketing', slug: 'marketing' } })
    await prisma.categorySender.create({ data: { id: 'cs_z', categoryId: 'c_grp', senderId: 'zeta', position: 0 } })
    await prisma.categorySender.create({ data: { id: 'cs_a', categoryId: 'c_grp', senderId: 'alpha', position: 1 } })
    await prisma.categorySender.create({ data: { id: 'cs_l', categoryId: 'c_grp', senderId: 'leaving', position: 2 } })
    await seedTarget('tm')
    await prisma.categoryTarget.create({ data: { id: 'ct', categoryId: 'c_grp', targetId: 'tm' } })
    await seedDraft({ id: 'd', senderId: 'leaving', targetId: 'tm' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1, kept: 0 })
    expect(await waitingFor('tm'), 'no page may hold a draft the group ring did not elect').toHaveLength(0)
    // Both group pages have a route, so the planner has somewhere to write.
    expect(await prisma.outreachPair.count({ where: { targetId: 'tm', senderId: { in: ['alpha', 'zeta'] } } })).toBe(2)
  })

  /**
   * THE RACE, driven. The dispatcher claims READY→SENDING between the hand-off's read and its
   * write. The re-point had no status condition, so it rewrote a row mid-paste to READY under
   * another page; the delivery was then recorded on a pair that never sent it, and a failure
   * left it READY for a second send. `discardAttempt` refuses a SENDING row inside its update.
   */
  it('a draft claimed for sending after the hand-off read the queue is left alone', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t')
    await seedDraft({ id: 'd', senderId: 'leaving', targetId: 't' })
    await takeOut('leaving')

    const real = prisma.outreachAttempt.findMany.bind(prisma.outreachAttempt)
    let claimed = false
    vi.spyOn(prisma.outreachAttempt, 'findMany').mockImplementation((async (args: Parameters<typeof real>[0]) => {
      const rows = await real(args)
      const where = (args as { where?: { senderId?: unknown; OR?: unknown } } | undefined)?.where
      if (where?.senderId === 'leaving' && where?.OR) {
        // The dispatcher's claim, verbatim in shape.
        const c = await prisma.outreachAttempt.updateMany({ where: { id: 'd', status: 'READY' }, data: { status: 'SENDING' } })
        claimed = c.count === 1
      }
      return rows
    }) as never)

    const summary = await handOff()
    vi.restoreAllMocks()
    expect(claimed, 'fixture bug: the race never happened').toBe(true)

    expect(summary).toMatchObject({ released: 0, discarded: 0, kept: 1 })
    expect(summary.details[0]).toContain('being sent right now')
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd' } })
    expect(row.status).toBe('SENDING')
    expect(row.senderId).toBe('leaving')
    expect(row.pairId).toBe('pair_leaving_t')
    expect(await prisma.auditLog.count({ where: { entity: 'OutreachAttempt:d' } })).toBe(0)
  })

  it('discards the duplicate when another account already has a draft for the recipient', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_covered')
    await seedDraft({ id: 'theirs', senderId: 'alpha', targetId: 't_covered' })
    await seedDraft({ id: 'ours', senderId: 'leaving', targetId: 't_covered' })

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 1, kept: 0 })

    const ours = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'ours' } })
    expect(ours.status).toBe('SKIPPED')
    // The other account's draft is untouched.
    const theirs = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'theirs' } })
    expect(theirs.status).toBe('READY')
    expect(theirs.senderId).toBe('alpha')
  })

  /** SENDING is in the planner's own pending set, so it covers the recipient too. */
  it("another page's SENDING draft covers the recipient", async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t')
    await seedDraft({ id: 'theirs', senderId: 'alpha', targetId: 't', status: 'SENDING' })
    await seedDraft({ id: 'ours', senderId: 'leaving', targetId: 't' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 1 })
    expect(summary.details[0]).toContain('already')
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'theirs' } })).status).toBe('SENDING')
  })

  it('discards a draft to a retired recipient', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_retired', { optedOut: true })
    await seedDraft({ id: 'd_retired', senderId: 'leaving', targetId: 't_retired' })

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 1 })
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

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 0, kept: 0 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_maybe' } })
    expect(row.status).toBe('FAILED')
    expect(row.senderId).toBe('leaving')
    expect(row.failureCode).toBe('not-in-thread')
  })

  /**
   * A `profile-gone` park IS the recipient's 7-day TARGET_UNREACHABLE stop — the planner and the
   * gate read it from FAILED rows. Moving it rewrote it READY with `failureCode: null`; discarding
   * it would write SKIPPED. Either way the stop is gone and a new page drives at a dead profile.
   */
  it('never touches a profile-gone park — it is the recipient-scoped stop', async () => {
    await seedSender('leaving')
    await seedSender('alpha')
    await seedTarget('t_gone')
    await seedDraft({
      id: 'd_gone',
      senderId: 'leaving',
      targetId: 't_gone',
      status: 'FAILED',
      failureCode: 'profile-gone',
      attempts: 1,
    })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 0, kept: 0 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_gone' } })
    expect(row.status).toBe('FAILED')
    expect(row.failureCode).toBe('profile-gone')
    expect(row.senderId).toBe('leaving')
    expect(row.attempts).toBe(1)
  })

  it('releases a parked failure of any other kind — it belonged to a drive from the leaving page', async () => {
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
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_parked' } })
    expect(row.status).toBe('SKIPPED')
    expect(row.senderId).toBe('leaving')
  })

  it('keeps drafts in place when no other fleet account exists', async () => {
    await seedSender('leaving')
    await seedSender('burner', { fleetMember: false })
    await seedTarget('t_lonely')
    await seedDraft({ id: 'd_lonely', senderId: 'leaving', targetId: 't_lonely' })

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 0, kept: 1 })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_lonely' } })
    expect(row.status).toBe('READY')
    expect(row.senderId).toBe('leaving')
  })

  /**
   * ── THE RING IS THE RECIPIENT'S OWN, NOT THE WHOLE FLEET'S (2026-09-01) ───
   *
   * MEASURED removing @bachelorssociety: 4 of its 8 movable drafts could not move, all four
   * because the fleet-wide ring elected `@madaboutmarketingg` — the MARKETING page — for
   * BOLLYWOOD companies. A release decides only whether ANYONE is left to write, and the
   * marketing page must not count as someone for a bollywood company; nor may the planner's
   * next turn name it.
   */
  it('releases a bollywood draft, and the planner elects a bollywood page — never the marketing one', async () => {
    await seedSender('leaving')
    await seedSender('bolly')
    await seedSender('mktg')
    await prisma.category.create({ data: { id: 'c_mktg', name: 'Marketing', slug: 'marketing' } })
    await prisma.categorySender.create({ data: { id: 'cs1', categoryId: 'c_mktg', senderId: 'mktg' } })
    /* A DEFAULT-fleet company: no CategoryTarget row, which is what "bollywood" is. */
    await seedTarget('t_bolly')
    /**
     * A DELIVERED message from @bolly, so rotation's starting point is DETERMINISTIC rather than
     * the never-messaged hash: the ring is ordered cohort-then-handle (bolly, mktg), so "the next
     * one after bolly" on a fleet-wide ring is the MARKETING page.
     */
    await seedDraft({ id: 'd_prior', senderId: 'bolly', targetId: 't_bolly', status: 'SENT' })
    await seedDraft({ id: 'd_bolly', senderId: 'leaving', targetId: 't_bolly' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary, 'a bollywood draft was stranded').toMatchObject({ released: 1, kept: 0 })
    const turn = await whoseTurn({ targetId: 't_bolly' })
    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.senderId, 'the marketing page cannot write to a bollywood company').toBe('bolly')
  })

  it('still releases a MARKETING draft to the marketing page — the fix is not "never elect it"', async () => {
    await seedSender('leaving')
    await seedSender('bolly')
    await seedSender('mktg')
    await prisma.category.create({ data: { id: 'c_mktg', name: 'Marketing', slug: 'marketing' } })
    await prisma.categorySender.create({ data: { id: 'cs1', categoryId: 'c_mktg', senderId: 'mktg' } })
    await prisma.categorySender.create({ data: { id: 'cs2', categoryId: 'c_mktg', senderId: 'leaving' } })
    await seedTarget('t_mktg')
    await prisma.categoryTarget.create({ data: { id: 'ct1', categoryId: 'c_mktg', targetId: 't_mktg' } })
    await seedDraft({ id: 'd_mktg', senderId: 'leaving', targetId: 't_mktg' })
    await takeOut('leaving')

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 1, kept: 0 })
    const turn = await whoseTurn({ targetId: 't_mktg' })
    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.senderId, 'only the marketing page may write to a marketing company').toBe('mktg')
  })

  /**
   * And when the recipient's fleet has no OTHER page, the draft stays put and says so. The
   * leaving page is deliberately still `fleetMember: true` here: its own pair is in
   * `fleetRingFor`, and the hand-off must not count the leaving page as someone left to write.
   * A fleet-wide ring (every fleet sender, whatever its fleet) would count @bolly and release.
   */
  it('keeps a draft whose fleet has no other page, naming the fleet', async () => {
    await seedSender('leaving')
    await seedSender('bolly')
    await prisma.category.create({ data: { id: 'c_mktg', name: 'Marketing', slug: 'marketing' } })
    await prisma.categorySender.create({ data: { id: 'cs1', categoryId: 'c_mktg', senderId: 'leaving' } })
    await seedTarget('t_mktg')
    await prisma.categoryTarget.create({ data: { id: 'ct1', categoryId: 'c_mktg', targetId: 't_mktg' } })
    await seedDraft({ id: 'd_mktg', senderId: 'leaving', targetId: 't_mktg' })

    const summary = await handOff()
    expect(summary).toMatchObject({ released: 0, discarded: 0, kept: 1 })
    expect(summary.details[0]).toContain('sends for their fleet')
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'd_mktg' } })).status).toBe('READY')
  })
})
