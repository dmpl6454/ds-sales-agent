import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ── ONE PAID POST FUNDS ONE MESSAGE TO ONE RECIPIENT (2026-09-01) ─────────────
 *
 * THE SCREENSHOT. Tabish, from the live `/paid-posts`: @dorothy shown messaged FOUR times
 * under ONE @instantbollywood post. Measured against the live database, it is neither a
 * column bug nor an allowance breach — @dorothy is named on four SYNDICATED copies of one
 * campaign (@varindertchawla, @viralbhayani, @voompla, @instantbollywood, all 29 Aug
 * 10:22-10:49), her allowance was 4, and exactly 4 went out.
 *
 * What was wrong is that **all four CLAIMED the same newest copy**: `pickHook` excluded
 * campaigns used by THIS PAIR, so a post used by page A stayed "fresh" for pages B, C and
 * D, and newest-first handed all four the same one. The provenance column then stacked four
 * claims under one post and drew em-dashes under its three siblings — truthfully.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL AND AGAINST A REAL DATABASE ─────────────────
 *
 * The exclusion is a QUERY, and a query filter is a property of the generated Prisma client
 * rather than of a pure function — this repo's first gotcha is `skipDuplicates`, which
 * exists on the Postgres client and not the SQLite one while `pnpm typecheck` was perfectly
 * happy. `tests/compose.test.ts` mocks `outreachAttempt.findMany` with ONE spy, so the
 * pair-scoped read and the recipient-scoped read are indistinguishable there: it can prove
 * the union is applied, and it cannot prove the two arms select different rows. This can.
 *
 * MUTATION-TESTED by hand, both directions: scoping `claimedCampaignIds` back to the pair
 * makes "the second page claims the second post" fail, and removing the pair arm makes the
 * release case fail.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-claim-ledger-'))
const dbPath = join(dir, 'ledger.db')

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

  CREATE TABLE "DetectedCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL UNIQUE,
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
    "frameText" TEXT
  );

  CREATE TABLE "MessageVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { freshCampaignsFor, composeForPair } = await import('@/outreach/compose')
const { templateForSettings } = await import('@/outreach/fleetTemplate')
const { followUpForSettings } = await import('@/outreach/followUpTemplate')

const FLEET_TEMPLATE = templateForSettings({ singleTemplateBody: null, fleetTemplateBodies: new Map() }, [], [])
const FOLLOW_UP = followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], [])

/** The recipient every post below names, and the four pages that could write to them. */
const RECIPIENT = 'dorothy'
const PAGES = ['pageone', 'pagetwo']
const NOW = new Date('2026-08-30T06:00:00.000Z')

/** Two syndicated copies of one campaign, minutes apart — the @dorothy shape, in miniature. */
const POSTS = [
  { id: 'camp_older', shortcode: 'AAA', postedAt: new Date('2026-08-29T04:52:00.000Z'), channel: 'viralbhayani' },
  { id: 'camp_newer', shortcode: 'BBB', postedAt: new Date('2026-08-29T05:19:00.000Z'), channel: 'instantbollywood' },
]

async function seed() {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  for (const handle of PAGES) {
    await prisma.senderAccount.create({
      data: {
        id: handle,
        handle,
        displayName: handle,
        personaName: '',
        personaRole: '',
        personaBrand: handle,
        personaPhone: '',
        personaEmail: '',
      },
    })
    await prisma.messageVariant.create({
      data: { id: `var_${handle}`, senderId: handle, targetKind: 'BRAND', label: 'v1', body: 'unused' },
    })
  }

  await prisma.targetAccount.create({
    data: { id: 'targ_dorothy', handle: RECIPIENT, displayName: 'Dorothy', kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })

  for (const p of POSTS) {
    /* The PUBLISHING channel is a real row: `pickHook` includes it, because the follow-up
       body names the post by the page that published it. */
    await prisma.targetAccount.upsert({
      where: { handle: p.channel },
      update: {},
      create: { id: `chan_${p.channel}`, handle: p.channel, displayName: p.channel, kind: 'CHANNEL', role: 'WATCH' },
    })
    await prisma.detectedCampaign.create({
      data: {
        id: p.id,
        targetId: `chan_${p.channel}`,
        shortcode: p.shortcode,
        permalink: `https://instagram.com/p/${p.shortcode}/`,
        postedAt: p.postedAt,
        /* Instagram-asserted evidence: the caption @-mentions the recipient, which is the
           arm `campaignsNamingHandleRows` matches on. */
        caption: `a paid placement with @${RECIPIENT}`,
        verdict: 'CAMPAIGN',
      },
    })
  }

  for (const handle of PAGES) {
    await prisma.outreachPair.create({ data: { id: `pair_${handle}`, senderId: handle, targetId: 'targ_dorothy' } })
  }
}

/** What one page would claim right now. */
async function claimFor(page: string): Promise<string[]> {
  const rows = await freshCampaignsFor({
    target: { handle: RECIPIENT, displayName: 'Dorothy' },
    targetId: 'targ_dorothy',
    pairId: `pair_${page}`,
    now: NOW,
  })
  return rows.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()).map((r) => r.id)
}

/** The claim a page's first message would actually record, through the real composer. */
async function composeClaimFor(page: string): Promise<string | null> {
  const pair = await prisma.outreachPair.findUniqueOrThrow({
    where: { id: `pair_${page}` },
    include: { sender: true, target: true },
  })
  const composed = await composeForPair({
    pair,
    senderHandle: page,
    touchNumber: 1,
    fleetTemplate: FLEET_TEMPLATE,
    followUpTemplate: FOLLOW_UP,
    now: NOW,
  })
  await prisma.outreachAttempt.create({
    data: {
      id: `att_${page}`,
      pairId: pair.id,
      senderId: pair.senderId,
      targetId: pair.targetId,
      campaignId: composed.campaignId,
      variantId: composed.variantId,
      touchNumber: 1,
      renderedBody: composed.body,
      status: 'READY',
    },
  })
  return composed.campaignId
}

beforeEach(seed)
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a paid post may fund one message per recipient, across the whole fleet', () => {
  /**
   * THE @dorothy CASE, reproduced. Before the ledger this returned `camp_newer` twice; the
   * whole defect was that the second page could not see the first page's claim.
   */
  it('the second page to write claims the SECOND post, not the same one again', async () => {
    const first = await composeClaimFor('pageone')
    expect(first, 'newest-first is unchanged: the first page takes the newest copy').toBe('camp_newer')

    const second = await composeClaimFor('pagetwo')
    expect(second, 'the second page claimed a post another of our pages already had').toBe('camp_older')
  })

  /** And the recipient's own view: two messages, two distinct posts, nothing double-counted. */
  it('two messages to one recipient cite two different posts', async () => {
    await composeClaimFor('pageone')
    await composeClaimFor('pagetwo')
    const claims = (
      await prisma.outreachAttempt.findMany({ select: { campaignId: true }, orderBy: { id: 'asc' } })
    ).map((a) => a.campaignId)
    expect(new Set(claims).size, 'two messages stacked under one post — the ledger has collapsed').toBe(2)
  })

  /**
   * THE EXHAUSTION DIRECTION, so none of the above is vacuous: with both copies claimed a
   * THIRD page has nothing left to cite. This is the ledger binding rather than merely
   * ordering, and it is what makes `NO_NEW_MATERIAL` mean something fleet-wide.
   */
  it('runs out when every copy is claimed', async () => {
    await composeClaimFor('pageone')
    await composeClaimFor('pagetwo')
    expect(await claimFor('pageone')).toEqual([])
    expect(await claimFor('pagetwo')).toEqual([])
  })

  /**
   * ── AND A DISCARDED DRAFT RELEASES ITS CLAIM ──────────────────────────────
   *
   * `IN_FLIGHT_STATUSES`, the same set `usedCampaignIds` has always used, and for the same
   * measured reason one rule over: counting SKIPPED rows burned a campaign every time a
   * draft was regenerated, so four discards exhausted the pool and the pair fell through to
   * `no-new-material` with four good campaigns sitting unused. A per-RECIPIENT ledger makes
   * that worse rather than the same — one page's discards would retire posts for every
   * page — so the release is asserted here as well as there.
   */
  it('a discarded draft frees the post it had claimed, for every page', async () => {
    await composeClaimFor('pageone')
    expect(await claimFor('pagetwo'), 'the live claim is not holding the post').toEqual(['camp_older'])

    await prisma.outreachAttempt.update({ where: { id: 'att_pageone' }, data: { status: 'SKIPPED' } })
    expect(
      await claimFor('pagetwo'),
      'a discarded draft is still holding a paid post hostage across the fleet',
    ).toEqual(['camp_newer', 'camp_older'])
  })

  /**
   * A DELIVERED claim holds forever, which is the whole point: the post has been spent.
   * SENT is in `IN_FLIGHT_STATUSES`; so is REPLIED, and a reply must never release a post
   * for another page to reuse — that would be "a reply loosens a guard", the exact shape
   * `DELIVERED_STATUSES` exists to prevent.
   */
  it.each(['SENT', 'REPLIED'])('a %s claim keeps the post spent', async (status) => {
    await composeClaimFor('pageone')
    await prisma.outreachAttempt.update({ where: { id: 'att_pageone' }, data: { status } })
    expect(await claimFor('pagetwo')).toEqual(['camp_older'])
  })

  /**
   * THE PAIR ARM IS STILL THERE. A claim by THIS pair excludes the post for THIS pair too —
   * the per-pair new-material rule is not weakened by the recipient-level one, it is joined
   * by it. Driven through a row that belongs to `pageone` alone.
   */
  it('a pair still cannot write about the same post twice', async () => {
    await composeClaimFor('pageone')
    expect(await claimFor('pageone')).toEqual(['camp_older'])
  })

  /**
   * ── AND THE PAIR ARM IS NOT MERELY REDUNDANT ──────────────────────────────
   *
   * MEASURED by mutation: deleting `usedCampaignIds` from the union breaks nothing else in
   * this file, because every attempt carrying a pair also carries that pair's `targetId`.
   * `OutreachAttempt.targetId` is a DENORMALISED copy, though, and `pairId` is the row's own
   * foreign key — so this drives the one state where the two disagree and asserts the older,
   * more fundamental rule survives it: no pair writes about one post twice, even when the
   * denormalised recipient column is wrong.
   *
   * Without this the pair arm would be a query nothing can justify, and the honest response
   * to that is to delete it rather than to keep it for symmetry.
   */
  it('holds a pair to its own claim even when the denormalised recipient column is wrong', async () => {
    await composeClaimFor('pageone')
    await prisma.outreachAttempt.update({
      where: { id: 'att_pageone' },
      /* The row still belongs to pair_pageone; only the copy is wrong. */
      data: { targetId: 'targ_somebody_else' },
    })

    expect(
      await claimFor('pageone'),
      'the pair arm is gone — a pair can now write about a post it has already claimed',
    ).toEqual(['camp_older'])
    /* And the recipient arm has genuinely lost sight of it, which is what makes the above
       an assertion about the pair arm rather than about the recipient one. */
    expect(await claimFor('pagetwo')).toEqual(['camp_newer', 'camp_older'])
  })
})
