import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

/**
 * `readCohortStates` — how the ladder DERIVES `live`, against a real database.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `tests/cohorts.test.ts` tests `mayArmCohort` thoroughly and in both directions, and it can
 * do that because the function is pure: it is handed `live: 0` or `live: 1` as a fixture. So
 * the whole suite asserts what the ladder DOES with `live` and nothing at all asserts what
 * `live` MEANS. That gap is exactly where the one-switch change (Tabish, 2026-08-08) landed:
 *
 *   before   live = autoSendEnabled && hasSession && status === 'ACTIVE'
 *   after    live =                     hasSession && status === 'ACTIVE'
 *
 * Every existing cohort test passes identically under both, because none of them reaches the
 * line that changed. A rule with a well-tested consumer and an untested producer is this
 * codebase's recurring shape — `repliedAt` was read in six places and written in none — so
 * the producer is now driven directly.
 *
 * It touches a database rather than mirroring the filter because `live` is assembled from two
 * sources that a pure test cannot see: a Prisma `select` (which is where the removed column
 * was named, and where a stale name fails at RUNTIME while typecheck passes — see the
 * `skipDuplicates` note in tests/fleet-pairs) and `profileStatus`, a filesystem read. A mirror
 * of the predicate would agree with itself whichever definition shipped.
 *
 * `hasSession` is mocked per handle rather than by writing Chrome profiles to disk: the real
 * function reads `~/.ds-sales-agent/chrome-profiles/<handle>`, and CLAUDE.md is explicit that
 * that directory is a credential file. A test must never write into it.
 *
 * NOTE ON THE DDL BELOW: it is transcribed from `prisma/migrations`, and the first draft was
 * transcribed from the SCHEMA BY EYE and silently omitted `replyHandledBy` — every test using
 * `OutreachAttempt` failed with "the column does not exist". Copy it from the migration, not
 * from a reading of the model.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-cohorts-live-'))
const dbPath = join(dir, 'cohorts.db')

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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key"
    ON "OutreachPair"("senderId", "targetId");

  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
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

  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

/**
 * Which handles hold a session on disk, set per test.
 *
 * The real `profileStatus` reads the credential directory. Mocked so a test can express
 * "signed in" and "never signed in" without going anywhere near it.
 */
const sessions = new Set<string>()
vi.mock('@/outreach/browser/profile', () => ({
  profileStatus: (handle: string) => ({ dir: `/tmp/p/${handle}`, hasSession: sessions.has(handle) }),
}))

const { readCohortStates, mayArmCohort } = await import('@/outreach/cohorts')
const { prisma } = await import('@/lib/db')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

async function addSender(
  handle: string,
  opts: {
    cohort?: number
    status?: string
    hasSession?: boolean
    challengedAt?: Date | null
    /** The session was recorded and Instagram has since revoked it (§3.5). */
    sessionInvalidAt?: Date | null
    /** Whether THIS Mac's disk holds the profile — must not decide `live` (2026-09-10). */
    onThisDisk?: boolean
  } = {},
) {
  const { cohort = 1, status = 'ACTIVE', hasSession = true, challengedAt = null, sessionInvalidAt = null } = opts
  if (opts.onThisDisk ?? hasSession) sessions.add(handle)
  return prisma.senderAccount.create({
    data: {
      id: `s_${handle}`,
      handle,
      displayName: handle,
      cohort,
      status,
      challengedAt,
      sessionPath: hasSession ? `/tmp/p/${handle}` : null,
      sessionInvalidAt,
      ...persona,
    },
  })
}

/** A DELIVERED message, which is what starts a cohort's soak clock. */
async function addDelivered(handle: string, sentAt: Date, status = 'SENT') {
  await prisma.outreachAttempt.create({
    data: {
      id: `a_${handle}_${sentAt.getTime()}`,
      pairId: `p_${handle}`,
      senderId: `s_${handle}`,
      targetId: 't_1',
      variantId: 'v_1',
      touchNumber: 1,
      renderedBody: 'body',
      status,
      sentAt,
    },
  })
}

/**
 * Read the states and return one group, FAILING if it is not there.
 *
 * Not a convenience: `states[0]?.live` would make every assertion below pass vacuously the day
 * the reader returned nothing at all, which is the "a guard nobody can trigger reads as
 * healthy" shape this repo keeps finding. An absent group is a test failure, not a skip.
 */
async function groupState(cohort: number) {
  const states = await readCohortStates()
  const found = states.find((s) => s.cohort === cohort)
  if (!found) throw new Error(`no state for group ${cohort} — readCohortStates returned ${states.length} group(s)`)
  return found
}

beforeEach(async () => {
  await prisma.outreachAttempt.deleteMany()
  await prisma.senderAccount.deleteMany()
  sessions.clear()
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * ── `live` MEANS "CAN SEND", NOT "SOMEBODY ARMED IT" ──────────────────────
 *
 * Rule 2 of the ladder refuses to clear a group while the one before it is not live. What
 * makes an account able to send is a session Instagram still honours and a status that is not
 * halted. Per-account arming used to be part of this and was removed with the one switch; it
 * was never the evidence, and rule 4 (has the group actually DELIVERED anything) is.
 */
describe('readCohortStates derives `live` from ability', () => {
  it('counts a signed-in ACTIVE account as live', async () => {
    await addSender('one', { cohort: 1, hasSession: true, status: 'ACTIVE' })
    const c1 = await groupState(1)
    expect(c1.live).toBe(1)
  })

  /**
   * THE FLEET'S GROUP 1 IS LIVE WHEREVER THE QUESTION IS ASKED (2026-09-10). A second Mac
   * holding one group-2 profile read every group-1 account as signed out — because `live`
   * was `profileStatus(...).hasSession`, THIS Mac's disk — and so could never send: "group 1
   * has no account sending on its own yet" about a group that had delivered all morning.
   */
  it('counts an account signed in on ANOTHER Mac as live — the ladder is a fleet fact', async () => {
    await addSender('elsewhere', { cohort: 1, hasSession: true, onThisDisk: false })
    expect((await groupState(1)).live).toBe(1)
  })

  it('does not count a profile on this disk whose session was never recorded', async () => {
    await addSender('ghost', { cohort: 1, hasSession: false, onThisDisk: true })
    expect((await groupState(1)).live).toBe(0)
  })

  it('does not count a recorded session Instagram has since revoked', async () => {
    await addSender('revoked', { cohort: 1, hasSession: true, sessionInvalidAt: new Date() })
    expect((await groupState(1)).live).toBe(0)
  })

  /**
   * THE CASE THE OLD DEFINITION GOT WRONG, and the reason this is a strengthening rather
   * than a loosening. `autoSendEnabled` defaults to false, so under the old rule a group of
   * genuinely signed-in, healthy, sending-capable accounts counted as `live: 0` until someone
   * flipped a bit — and rule 2 refused the next group on the strength of a missing intention
   * rather than a missing capability. With no arming control left anywhere, the old predicate
   * would have made `live` PERMANENTLY ZERO and frozen the ladder at group 1 forever.
   */
  it('counts an account that can send even though nothing armed it', async () => {
    await addSender('unarmed', { cohort: 1, hasSession: true, status: 'ACTIVE' })
    // Explicit: the column still exists on the row and must have no bearing on the answer.
    await prisma.senderAccount.update({ where: { handle: 'unarmed' }, data: { autoSendEnabled: false } })
    const c1 = await groupState(1)
    expect(c1.live).toBe(1)
  })

  /** No session means it cannot send, whatever any flag says. Fails in the safe direction. */
  it('does NOT count an account with no session on disk', async () => {
    await addSender('sessionless', { cohort: 1, hasSession: false, status: 'ACTIVE' })
    await prisma.senderAccount.update({ where: { handle: 'sessionless' }, data: { autoSendEnabled: true } })
    const c1 = await groupState(1)
    expect(c1.live).toBe(0)
  })

  /** A halted account cannot send either, and CHALLENGED is the halt that matters most. */
  it('does NOT count a CHALLENGED or PAUSED account', async () => {
    await addSender('halted', { cohort: 1, hasSession: true, status: 'CHALLENGED' })
    await addSender('paused', { cohort: 1, hasSession: true, status: 'PAUSED' })
    const c1 = await groupState(1)
    expect(c1.live).toBe(0)
  })

  it('counts only the able ones in a mixed group', async () => {
    await addSender('able', { cohort: 2, hasSession: true, status: 'ACTIVE' })
    await addSender('nosession', { cohort: 2, hasSession: false, status: 'ACTIVE' })
    await addSender('halted', { cohort: 2, hasSession: true, status: 'PAUSED' })
    const c2 = await groupState(2)
    expect(c2.live).toBe(1)
    expect(c2.members).toHaveLength(3)
  })
})

/**
 * ── THE LADDER STILL REFUSES, DRIVEN THROUGH THE REAL READER ──────────────
 *
 * The point of this guard is REFUSING. A suite proving only that it permits would be
 * worthless, so the two ways a group can fail rule 2 and rule 4 are asserted end to end —
 * from database rows, through the derivation that changed, into the verdict.
 */
describe('the ladder blocks an un-soaked group, end to end', () => {
  it('refuses group 2 when group 1 has no account able to send', async () => {
    // Signed in nowhere: group 1 exists on paper and can send nothing.
    await addSender('offline', { cohort: 1, hasSession: false })
    await addSender('newbie', { cohort: 2, hasSession: true })
    const states = await readCohortStates()
    const r = mayArmCohort({ cohort: 2, states, soakDays: 14, now: new Date('2026-09-01T12:00:00Z') })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-not-live' })
  })

  /**
   * ABLE TO SEND IS NOT EVIDENCE OF HAVING SENT. This is the rule that now carries the
   * ladder's whole evidential weight, so it is asserted from real rows: a group that is
   * signed in and healthy but has delivered nothing has been OBSERVED for zero days.
   */
  it('refuses group 2 when group 1 can send but never has', async () => {
    await addSender('ready', { cohort: 1, hasSession: true, status: 'ACTIVE' })
    const states = await readCohortStates()
    const g1 = await groupState(1)
    expect(g1.live).toBe(1) // able…
    expect(g1.soakStartedAt).toBeNull() // …and unobserved
    const r = mayArmCohort({ cohort: 2, states, soakDays: 14, now: new Date('2026-09-01T12:00:00Z') })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-still-soaking' })
  })

  it('refuses group 2 thirteen days into group 1 soak', async () => {
    await addSender('sender', { cohort: 1, hasSession: true })
    await addDelivered('sender', new Date('2026-08-19T12:00:00Z')) // 13 days before NOW
    const states = await readCohortStates()
    const r = mayArmCohort({ cohort: 2, states, soakDays: 14, now: new Date('2026-09-01T12:00:00Z') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('13 of 14 days')
  })

  /** The permitting direction, so none of the refusals above is vacuous. */
  it('permits group 2 once group 1 has sent for long enough', async () => {
    await addSender('sender', { cohort: 1, hasSession: true })
    await addDelivered('sender', new Date('2026-08-01T12:00:00Z')) // 31 days
    const states = await readCohortStates()
    const r = mayArmCohort({ cohort: 2, states, soakDays: 14, now: new Date('2026-09-01T12:00:00Z') })
    expect(r).toEqual({ ok: true, reason: 'previous-cohort-cleared' })
  })

  /**
   * A checkpoint anywhere earlier still stops the ladder, and `challengedAt` outlives the
   * halt being cleared — `everChallenged` is "ever", not "currently". Asserted here too
   * because it is derived in the same mapping as `live`.
   */
  it('refuses when an earlier group was flagged, even with the halt cleared', async () => {
    await addSender('flagged', {
      cohort: 1,
      hasSession: true,
      status: 'ACTIVE', // halt released…
      challengedAt: new Date('2026-08-10T12:00:00Z'), // …but it still happened
    })
    await addDelivered('flagged', new Date('2026-08-01T12:00:00Z'))
    const states = await readCohortStates()
    expect((await groupState(1)).everChallenged).toBe(1)
    const r = mayArmCohort({ cohort: 2, states, soakDays: 14, now: new Date('2026-09-01T12:00:00Z') })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'previous-cohort-flagged' })
  })
})

/**
 * `REPLIED` REPLACES `SENT` rather than adding to it, so a soak clock read from
 * `status: 'SENT'` alone would RESET the moment a prospect answered — the best available
 * outcome silently un-graduating a group. Asserted because the query says
 * `DELIVERED_STATUSES` and a future edit narrowing it would look harmless.
 */
describe('the soak clock counts a REPLIED message as delivered', () => {
  it('starts the soak from a message that has since been answered', async () => {
    await addSender('answered', { cohort: 1, hasSession: true })
    await addDelivered('answered', new Date('2026-08-01T12:00:00Z'), 'REPLIED')
    const c1 = await groupState(1)
    expect(c1.soakStartedAt).toEqual(new Date('2026-08-01T12:00:00Z'))
  })
})
