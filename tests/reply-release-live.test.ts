import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "I HAVE REPLIED" RELEASES THE HALT IMMEDIATELY — Tabish, 2026-08-19: *"The moment a
 * human clicks on 'I have replied' manually all messages to that account must resume."*
 *
 * ── WHY THIS TEST EXISTS WHEN `replyHalt.test.ts` ALREADY PASSES ────────────
 *
 * `tests/replyHalt.test.ts` covers `replyHaltActive`, the PURE predicate, and it asserts
 * the early release. But **no enforcer calls that predicate.** The gate, the planner and
 * the on-demand dialog each express the halt as a QUERY — `repliedAt: { gte: floor },
 * replyHandledAt: null` — and a query filter is a property of the generated Prisma client,
 * not of a pure function. This repo's first gotcha is `skipDuplicates`, which exists on the
 * Postgres client and not the SQLite one while typecheck was perfectly happy; and
 * `prune-pairs-live.test.ts` exists for exactly this shape of doubt about a relation filter.
 * So the release is executed here, against a real database, through the real
 * `recheckBeforeSend`.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS NOT "ok: true" ─────────────────────────
 *
 * `recheckBeforeSend` reads `profileStatus(handle).hasSession` from the operator's OWN
 * `~/.ds-sales-agent`, and `CREDENTIAL_ROOT` is not overridable — deliberately, it is a
 * credential path. A test must never write there, so a seeded sender can never have a
 * session and the gate can never return `ok: true` here.
 *
 * That does not weaken the test, because TARGET_REPLIED is evaluated BEFORE NO_SESSION
 * (gate.ts:308 before :314). So the release is visible exactly as it matters: before
 * handling the gate refuses **with target-replied**, and after handling that stop is GONE
 * and the refusal has moved on to the next question. Machine-independent, and it fails if
 * `replyHandledAt: null` is dropped from the gate's query — which is the mutation this
 * test is here to catch.
 *
 * The write below is the same one `markReplyHandled` performs (`replyHandledAt: new
 * Date()`); the action itself is unreachable from a test, since it opens with
 * `requireOperator()` and closes with `revalidatePath`.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-reply-release-'))
const dbPath = join(dir, 'release.db')

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

  /**
   * ADDED 2026-08-21 with the recipient's material allowance, which counts paid posts naming
   * the target. Hand-transcribed DDL goes stale the day the schema moves — CLAUDE.md's
   * two-provider trap's cousin — and it went stale the moment the gate learned a new query.
   * Only the columns this gate actually reads.
   */
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


  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { recheckBeforeSend, RESEND_BLOCKS } = await import('@/outreach/gate')

const SENDER = 'seeded_sender'
const TARGET = 'seeded_target'

/** The shape `recheckBeforeSend` needs, as both real callers already fetch it. */
async function attemptForGate(id: string) {
  const row = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id },
    include: { pair: { include: { sender: true, target: true } } },
  })
  return row
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})

  await prisma.senderAccount.create({
    data: {
      id: SENDER,
      handle: SENDER,
      displayName: SENDER,
      // Cohort 1 is the ladder's BASELINE and always passes, so `mayArmAccount` cannot
      // stand in front of the stop under test.
      cohort: 1,
      status: 'ACTIVE',
      personaName: '',
      personaRole: '',
      personaBrand: '',
      personaPhone: '',
      personaEmail: '',
    },
  })
  await prisma.targetAccount.create({
    /**
     * `isVerified: true` is REQUIRED for this fixture to exercise the stop it names.
     * Verified-only (Tabish, 2026-08-20) is checked BEFORE the reply halt, because who the
     * recipient is outranks when we may write — so a seeded target without a badge refuses
     * on `target-not-verified` and this file would silently stop testing the reply release.
     */
    data: { id: TARGET, handle: TARGET, displayName: TARGET, kind: 'BRAND', role: 'PROSPECT', isVerified: true },
  })
  await prisma.outreachPair.create({ data: { id: 'pair', senderId: SENDER, targetId: TARGET } })

  /**
   * TWO detected paid posts for this recipient, so the material allowance (2026-08-21) is not
   * what refuses the send. Without them the allowance is max(1, 0) = 1, the delivered message
   * that GOT the reply spends it, and `material-exhausted` shadows the stop this file is about.
   *
   * That is the rule working correctly, and it is also why the fixture needs them: this test
   * asserts the reply stop RELEASES, and it can only see that if the next stop is the
   * environmental one (a seeded account can never hold a session) rather than a second rule.
   */
  for (const [id, shortcode] of [['dc1', 'AAAAAAAAAAA'], ['dc2', 'BBBBBBBBBBB']]) {
    /* The seed runs before EVERY test in this file, so upsert rather than create. */
    await prisma.detectedCampaign.upsert({
      where: { id: id! },
      update: {},
      create: {
        id: id!,
        targetId: TARGET,
        shortcode: shortcode!,
        permalink: `https://www.instagram.com/p/${shortcode}/`,
        /* The allowance counts campaigns NAMING the recipient (caption @mention or tag), not
           campaigns posted by them — so the fixture must actually mention the handle. */
        caption: `a detected paid post mentioning @${TARGET}`,
        verdict: 'CAMPAIGN',
        postedAt: new Date(),
      },
    })
  }

  // What we delivered, and their answer to it — a reply from ten minutes ago, well inside
  // the reply window (7 days since 2026-08-19), so the halt is genuinely active.
  await prisma.outreachAttempt.create({
    data: {
      id: 'delivered',
      pairId: 'pair',
      senderId: SENDER,
      targetId: TARGET,
      variantId: 'v1',
      touchNumber: 1,
      renderedBody: 'the standard template',
      status: 'REPLIED',
      sentAt: new Date(Date.now() - 60 * 60_000),
      repliedAt: new Date(Date.now() - 10 * 60_000),
      // The halt reads the DATED clock (2026-08-21): a recorded reply seeds both.
      replyPostedAt: new Date(Date.now() - 10 * 60_000),
      replyText: 'Let us connect?',
    },
  })

  // And the next message, waiting. This is the one that must resume.
  await prisma.outreachAttempt.create({
    data: {
      id: 'waiting',
      pairId: 'pair',
      senderId: SENDER,
      targetId: TARGET,
      variantId: 'v2',
      touchNumber: 2,
      renderedBody: 'the standard template',
      status: 'READY',
    },
  })
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('marking a reply handled resumes messaging to that recipient', () => {
  it('BEFORE: a fresh reply halts the waiting message at the gate', async () => {
    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: true })
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unexpected: a fresh unhandled reply must halt')
    expect(gate.reason).toBe(RESEND_BLOCKS.TARGET_REPLIED)
  })

  it('AFTER: the reply stop is gone the moment replyHandledAt is set', async () => {
    await prisma.outreachAttempt.update({
      where: { id: 'delivered' },
      data: { replyHandledAt: new Date(), replyHandledBy: 'tabish@dashmani.com' },
    })

    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: true })
    /**
     * The reply stop has RELEASED. It cannot be `ok: true` in a test — the gate reads the
     * real credential directory for a session and a seeded account has none — but
     * TARGET_REPLIED is asked before NO_SESSION, so its absence here is the release.
     */
    if (gate.ok) throw new Error('unexpected: a session-less seeded account cannot be clear to send')
    expect(gate.reason).not.toBe(RESEND_BLOCKS.TARGET_REPLIED)
    expect(gate.reason).toBe(RESEND_BLOCKS.NO_SESSION)
  })

  it('the record itself survives being handled — history is never erased', async () => {
    await prisma.outreachAttempt.update({
      where: { id: 'delivered' },
      data: { replyHandledAt: new Date(), replyHandledBy: 'tabish@dashmani.com' },
    })
    const row = await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'delivered' } })
    expect(row.repliedAt).not.toBeNull()
    expect(row.replyText).toBe('Let us connect?')
    expect(row.status).toBe('REPLIED')
  })

  it('a reply that is NOT handled and NOT expired still halts — the negative direction', async () => {
    await prisma.outreachAttempt.update({
      where: { id: 'delivered' },
      // Two hours old: inside the 48-hour window, nobody has handled it.
      data: { repliedAt: new Date(Date.now() - 2 * 60 * 60_000), replyPostedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    })
    const gate = await recheckBeforeSend(await attemptForGate('waiting'), { unattended: true })
    if (gate.ok) throw new Error('unexpected: an unhandled fresh reply must halt')
    expect(gate.reason).toBe(RESEND_BLOCKS.TARGET_REPLIED)
  })
})
