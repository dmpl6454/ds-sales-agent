import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * AUDIT C2 + H9's PREREQUISITE (2026-10-09): A FRESH REPLY IS RECORDED, AND ON THE RIGHT PAIR.
 *
 * C2. A row with `repliedAt` set and `replyText: null` is a MARKER — an inbox state snippet or a
 * hand record. The thread read used to BACKFILL such a row (any page's — the lookup was
 * target-wide) with the newest bubble's text and return "no reply" before asking whether that
 * bubble was new. A recipient who wrote "what are your rates?" days after a textless marker had
 * the question written onto the old row with the old date; the halt saw nothing new and the
 * follow-up was driven into the answered conversation.
 *
 * H9's prerequisite. A new reply was attached to the newest delivered row FOR THE TARGET, any
 * page's. Under the pair-scoped halt (Tabish, 1 Sept) that halted the page that was not
 * answered and left the answered one writing into the live thread.
 *
 * DRIVEN AGAINST A REAL DATABASE because every rule here is a Prisma `where` — which rows count
 * as known, which row a reply sits on, which rows the halt reads — and a `where` is a property
 * of the generated client, not of a pure function. Only the browser (`openAndReadThread`,
 * `scanInbox`) is mocked, and the halt is asserted with the gate's own query.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-reply-textless-'))
const dbPath = join(dir, 'textless.db')

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
  CREATE TABLE "Category" (
    "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL UNIQUE, "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategorySender" (
    "id" TEXT PRIMARY KEY, "categoryId" TEXT NOT NULL, "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0, "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "CategoryTarget" (
    "id" TEXT PRIMARY KEY, "categoryId" TEXT NOT NULL, "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
process.env.SEND_ENABLED = 'true'

const openAndReadThread = vi.fn()
const scanInbox = vi.fn()

vi.mock('@/outreach/browser/readThread', () => ({ openAndReadThread: (...a: unknown[]) => openAndReadThread(...a) }))
vi.mock('@/outreach/browser/inboxScan', () => ({ scanInbox: (...a: unknown[]) => scanInbox(...a) }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))
vi.mock('@/outreach/challenge', () => ({ markChallenged: vi.fn() }))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true }) }))
vi.mock('@/outreach/shutdown', () => ({ browserShutdownRequested: () => false }))
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() } }))

const { prisma } = await import('@/lib/db')
const { checkConversation, ensureConversationChecked, checkForReplies, resetReplySweepMemory, SUPERSEDED_BY_REPLY, REPLY_TEXT_MAX } =
  await import('@/outreach/replyCheck')
const { replyHaltWhere } = await import('@/outreach/replyHalt')
const { recheckBeforeSend, RESEND_BLOCKS } = await import('@/outreach/gate')

const H = 3_600_000
const D = 24 * H
const ago = (ms: number) => new Date(Date.now() - ms)

const T = 't_target'

async function addSender(id: string) {
  await prisma.senderAccount.create({
    data: { id, handle: id, displayName: id, cohort: 1, status: 'ACTIVE', personaName: '', personaRole: '', personaBrand: '', personaPhone: '', personaEmail: '' },
  })
  await prisma.outreachPair.create({ data: { id: `pair_${id}`, senderId: id, targetId: T } })
}

async function attempt(id: string, senderId: string, over: Record<string, unknown> = {}) {
  await prisma.outreachAttempt.create({
    data: {
      id,
      pairId: `pair_${senderId}`,
      senderId,
      targetId: T,
      variantId: 'v',
      touchNumber: 1,
      renderedBody: `${id} body`,
      status: 'SENT',
      ...over,
    },
  })
}

const row = (id: string) => prisma.outreachAttempt.findUniqueOrThrow({ where: { id } })

/** The gate's own halt query (gate.ts → replyHaltWhere), default pair scope and window. */
async function halted(senderId: string): Promise<boolean> {
  return (await prisma.outreachAttempt.findFirst({ where: replyHaltWhere({ scope: 'pair', senderId, targetId: T, resumeHours: 168 }) })) !== null
}

type Bubble = { text: string; ours: boolean; approxAt?: Date | null }
function complete(messages: Bubble[]) {
  const m = messages.map((b) => ({ approxAt: null, ...b }))
  return { ok: true, url: 'https://www.instagram.com/someone/', messages: m, foundOurs: 1, expectedOurs: 1, complete: true }
}

const ensure = (senderId: string, attemptId: string) =>
  ensureConversationChecked({ senderId, senderHandle: senderId, targetId: T, targetHandle: T, attemptId, touchNumber: 2 })
const check = (senderId: string, fallbackAttemptId: string, fallbackIsDraft: boolean) =>
  checkConversation({ senderId, senderHandle: senderId, targetId: T, targetHandle: T, fallbackAttemptId, fallbackIsDraft })

beforeEach(async () => {
  await prisma.auditLog.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})
  await prisma.targetAccount.create({ data: { id: T, handle: T, displayName: T, kind: 'BRAND', role: 'PROSPECT', isVerified: true } })
  openAndReadThread.mockReset()
  scanInbox.mockReset().mockResolvedValue({ ok: true, rows: [] })
  resetReplySweepMemory()
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('C2 — a textless marker never swallows a fresh reply', () => {
  /**
   * THE AUDIT'S CASE, same pair. A1 is the only delivery and carries an inbox marker from eight
   * days ago; they now write "what are your rates?" in the thread. HEAD backfilled the text onto
   * A1 with A1's old date, reported "no reply", and the follow-up went.
   */
  it('records the question on THIS pair, supersedes the waiting draft, and holds the send', async () => {
    await addSender('s1')
    const marked = ago(8 * D)
    await attempt('a1', 's1', { status: 'REPLIED', sentAt: ago(9 * D), repliedAt: marked, replyPostedAt: marked, renderedBody: 'first touch body' })
    await attempt('d', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up body' })
    const said = ago(H)
    openAndReadThread.mockResolvedValue(complete([{ text: 'first touch body', ours: true }, { text: 'what are your rates?', ours: false, approxAt: said }]))

    const r = await ensure('s1', 'd')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('reply-found')

    const d = await row('d')
    expect(d.status).toBe('SKIPPED')
    expect(d.error).toBe(SUPERSEDED_BY_REPLY)
    expect(d.replyText).toBe('what are your rates?')
    expect(d.replyPostedAt?.getTime()).toBe(said.getTime())
    // Never a fabricated delivery.
    expect(d.sentAt).toBeNull()

    // The marker is left exactly as it was.
    const a1 = await row('a1')
    expect(a1.replyText).toBeNull()
    expect(a1.replyPostedAt?.getTime()).toBe(marked.getTime())
    expect(a1.replyCheckedAt).toBeNull()

    // The gate's own halt query sees it.
    expect(await halted('s1')).toBe(true)

    const actions = (await prisma.auditLog.findMany({ where: { entity: 'OutreachAttempt:d' } })).map((a) => a.action).sort()
    expect(actions).toEqual(['attempt.superseded-by-reply', 'reply.record.auto'])

    // A later read never expects the superseded draft's body to be in the thread.
    await attempt('d2', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'another follow-up' })
    openAndReadThread.mockClear()
    await check('s1', 'd2', true)
    const bodies = openAndReadThread.mock.calls[0]![2] as { expected: string[] }
    expect(bodies.expected).toEqual(['first touch body'])
  })

  it('a textless marker is never written — not even with a text that is already known', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { status: 'REPLIED', sentAt: ago(10 * D), repliedAt: ago(9 * D), replyPostedAt: ago(9 * D) })
    await attempt('a2', 's1', { status: 'REPLIED', sentAt: ago(5 * D), repliedAt: ago(4 * D), replyPostedAt: ago(4 * D), replyText: 'hello there' })
    await attempt('d', 's1', { status: 'READY', touchNumber: 3, renderedBody: 'follow-up body' })
    openAndReadThread.mockResolvedValue(
      complete([{ text: 'a1 body', ours: true }, { text: 'a2 body', ours: true }, { text: 'hello there', ours: false, approxAt: ago(4 * D) }]),
    )

    const r = await check('s1', 'd', true)
    expect(r.status).toBe('no-reply')
    const a1 = await row('a1')
    expect(a1.replyText).toBeNull()
    expect(a1.replyCheckedAt).toBeNull()
    // The only write is the verified-silence stamp on the caller's row.
    expect((await row('d')).replyCheckedAt).not.toBeNull()
    expect((await row('d')).status).toBe('READY')
  })

  /**
   * THE CROSS-PAIR HALF. The old backfill looked the marker up by TARGET: a marker on page S2's
   * row swallowed a reply that arrived in page S1's thread, and stamped S2 as freshly read.
   */
  it('a marker on ANOTHER page neither swallows this reply nor vouches for its own thread', async () => {
    await addSender('s1')
    await addSender('s2')
    await attempt('b1', 's2', { status: 'REPLIED', sentAt: ago(10 * D), repliedAt: ago(9 * D), replyPostedAt: ago(9 * D) })
    await attempt('a1', 's1', { sentAt: ago(3 * D) })
    openAndReadThread.mockResolvedValue(complete([{ text: 'a1 body', ours: true }, { text: 'interested, share details', ours: false, approxAt: ago(2 * H) }]))

    const r = await check('s1', 'a1', false)
    expect(r.status).toBe('reply-found')
    expect(await halted('s1')).toBe(true)
    const b1 = await row('b1')
    expect(b1.replyText).toBeNull()
    expect(b1.replyCheckedAt).toBeNull()

    // S2's next follow-up must read its OWN thread — nothing vouched for it.
    await attempt('d2', 's2', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up from s2' })
    openAndReadThread.mockClear().mockResolvedValue(complete([{ text: 'b1 body', ours: true }]))
    await ensure('s2', 'd2')
    expect(openAndReadThread).toHaveBeenCalledOnce()
    expect(openAndReadThread.mock.calls[0]![0]).toBe('s2')
  })
})

describe('C2 — what counts as known, and which bubble is recorded', () => {
  /**
   * THE INBOX-MISATTRIBUTION VARIANT. The words are already recorded on page S2's row (the
   * inbox parked them there, or the recipient sent one autoresponse to every page). Known texts
   * were TARGET-scoped, so S1's thread could never record them and its follow-up went out.
   */
  it('words recorded on another page still count as NEW in this page’s thread', async () => {
    await addSender('s1')
    await addSender('s2')
    await attempt('b1', 's2', { status: 'REPLIED', sentAt: ago(2 * D), repliedAt: ago(D), replyPostedAt: ago(D), replyText: 'what are your rates?' })
    await attempt('r', 's1', { status: 'REPLIED', sentAt: ago(10 * D), repliedAt: ago(9 * D), replyPostedAt: ago(9 * D) })
    await attempt('d', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up body' })
    const said = ago(20 * H)
    openAndReadThread.mockResolvedValue(complete([{ text: 'r body', ours: true }, { text: 'what are your rates?', ours: false, approxAt: said }]))

    const r = await ensure('s1', 'd')
    expect(r.ok).toBe(false)
    const d = await row('d')
    expect(d.replyText).toBe('what are your rates?')
    expect(d.replyPostedAt?.getTime()).toBe(said.getTime())
    expect(await halted('s1')).toBe(true)
  })

  it('records the newest-DATED fresh bubble, not the last by position', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { sentAt: ago(9 * D) })
    const newer = ago(H)
    openAndReadThread.mockResolvedValue(
      complete([
        { text: 'new words', ours: false, approxAt: newer },
        { text: 'a1 body', ours: true },
        { text: 'old words', ours: false, approxAt: ago(8 * D) },
      ]),
    )
    const r = await check('s1', 'a1', false)
    expect(r.status).toBe('reply-found')
    const a1 = await row('a1')
    expect(a1.replyText).toBe('new words')
    expect(a1.replyPostedAt?.getTime()).toBe(newer.getTime())
    expect(await halted('s1')).toBe(true)
  })

  /**
   * Storage keeps `REPLY_TEXT_MAX` characters and the comparison used to read the whole bubble,
   * so a pasted rate card was new on every read forever — each read holding a follow-up.
   */
  it('a reply longer than the stored maximum is recorded once, then known', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { sentAt: ago(D) })
    const card = `rate card: ${'story 5k, reel 9k, '.repeat(160)}`
    expect(card.length).toBeGreaterThan(REPLY_TEXT_MAX)
    openAndReadThread.mockResolvedValue(complete([{ text: 'a1 body', ours: true }, { text: card, ours: false, approxAt: ago(H) }]))

    const statuses: string[] = []
    for (const id of ['d1', 'd2', 'd3']) {
      await attempt(id, 's1', { status: 'READY', touchNumber: 2, renderedBody: `${id} follow-up` })
      statuses.push((await check('s1', id, true)).status)
    }
    expect(statuses).toEqual(['reply-found', 'no-reply', 'no-reply'])
    const carrying = await prisma.outreachAttempt.findMany({ where: { senderId: 's1', replyText: { not: null } } })
    expect(carrying.map((c) => c.id)).toEqual(['a1'])
    expect(carrying[0]!.replyText!.length).toBe(REPLY_TEXT_MAX)
    expect((await row('d2')).status).toBe('READY')
  })
})

describe('C2 — where a reply is written', () => {
  it('a free delivered row of this pair is used before the waiting draft', async () => {
    await addSender('s1')
    await attempt('a', 's1', { sentAt: ago(10 * D) })
    await attempt('b', 's1', { status: 'REPLIED', sentAt: ago(5 * D), repliedAt: ago(4 * D), replyPostedAt: ago(4 * D), replyText: 'earlier words' })
    await attempt('d', 's1', { status: 'READY', touchNumber: 3, renderedBody: 'follow-up body' })
    openAndReadThread.mockResolvedValue(
      complete([
        { text: 'a body', ours: true },
        { text: 'b body', ours: true },
        { text: 'earlier words', ours: false, approxAt: ago(4 * D) },
        { text: 'new words', ours: false, approxAt: ago(2 * H) },
      ]),
    )
    const r = await ensure('s1', 'd')
    expect(r.ok).toBe(false)
    const a = await row('a')
    expect(a.status).toBe('REPLIED')
    expect(a.replyText).toBe('new words')
    expect((await row('d')).status).toBe('READY')
    expect((await row('b')).replyText).toBe('earlier words')
  })

  /**
   * A REPLIED row with `sentAt: null` is a draft an older reply path flipped to REPLIED — nobody
   * received it. In the completeness bar its body could never be found, so every read of the
   * pair came back incomplete forever.
   */
  it('a never-sent REPLIED row is not in the completeness bar', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { sentAt: ago(3 * D), renderedBody: 'first touch body' })
    await attempt('phantom', 's1', { status: 'REPLIED', sentAt: null, repliedAt: ago(2 * D), replyText: 'old', renderedBody: 'phantom body' })
    openAndReadThread.mockResolvedValue(complete([{ text: 'first touch body', ours: true }]))
    await check('s1', 'a1', false)
    const bodies = openAndReadThread.mock.calls[0]![2] as { expected: string[]; allOurs: string[] }
    expect(bodies.expected).toEqual(['first touch body'])
    // Classification still errs towards "ours".
    expect(bodies.allOurs).toContain('phantom body')
  })

  /**
   * A PARTIAL read that saw a reply records it, and must NOT vouch: a stamp would let the next
   * follow-up skip the read as "fresh" into a conversation the last read provably did not see.
   */
  it('a partial read records the reply but never stamps the conversation as read', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { sentAt: ago(2 * D) })
    await attempt('d', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up body' })
    openAndReadThread.mockResolvedValue({
      ok: false,
      reason: 'incomplete',
      detail: 'saw 0 of 1 messages we sent',
      messages: [{ text: 'please call', ours: false, approxAt: ago(3 * D) }],
    })

    const r = await ensure('s1', 'd')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('reply-found')
    const a1 = await row('a1')
    expect(a1.replyText).toBe('please call')
    // Clamped to the message it answers, never earlier.
    expect(a1.replyPostedAt?.getTime()).toBe((await row('a1')).sentAt!.getTime())
    const stamped = await prisma.outreachAttempt.count({ where: { senderId: 's1', replyCheckedAt: { not: null } } })
    expect(stamped).toBe(0)

    await ensure('s1', 'd')
    expect(openAndReadThread).toHaveBeenCalledTimes(2)
  })

  /**
   * A Send pressed on the dashboard can claim the draft while it is being read. The guarded
   * update then matches nothing (Prisma P2025) and NOTHING is written — the caller still holds.
   * Proves the lost race is recognised through the real client, not just in a mock.
   */
  it('a draft claimed for sending meanwhile is left alone, and the send is still held', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { status: 'REPLIED', sentAt: ago(9 * D), repliedAt: ago(8 * D), replyPostedAt: ago(8 * D), replyText: 'old words' })
    await attempt('d', 's1', { status: 'SENDING', touchNumber: 2, renderedBody: 'follow-up body' })
    openAndReadThread.mockResolvedValue(complete([{ text: 'a1 body', ours: true }, { text: 'old words', ours: false }, { text: 'new words', ours: false, approxAt: ago(H) }]))

    const r = await check('s1', 'd', true)
    expect(r.status).toBe('reply-found')
    const d = await row('d')
    expect(d.status).toBe('SENDING')
    expect(d.replyText).toBeNull()
    expect(await prisma.auditLog.count()).toBe(0)
  })
})

describe('H9 prerequisite — the reply halts the page that was answered', () => {
  /**
   * Fan-out, the normal case: two pages wrote to T, S2 more recently, and T answers S1. The reply
   * used to land on S2's newer row — S2 halted, S1 still writing into the live thread.
   */
  it('lands on S1’s row; S1’s follow-up is held by the gate and S2 is not halted', async () => {
    await addSender('s1')
    await addSender('s2')
    await attempt('a1', 's1', { sentAt: ago(5 * D), renderedBody: 'a1 body' })
    await attempt('b1', 's2', { sentAt: ago(3 * D), renderedBody: 'b1 body' })
    await attempt('da', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up from s1' })
    openAndReadThread.mockResolvedValue(complete([{ text: 'a1 body', ours: true }, { text: 'yes, tell me more', ours: false, approxAt: ago(2 * D) }]))

    expect((await check('s1', 'a1', false)).status).toBe('reply-found')
    const a1 = await row('a1')
    expect(a1.status).toBe('REPLIED')
    expect(a1.replyText).toBe('yes, tell me more')
    expect((await row('b1')).repliedAt).toBeNull()
    expect(await halted('s1')).toBe(true)
    expect(await halted('s2')).toBe(false)

    const gate = await recheckBeforeSend(
      await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: 'da' }, include: { pair: { include: { sender: true, target: true } } } }),
      { unattended: true },
    )
    if (gate.ok) throw new Error('unexpected: the answered page must be held')
    expect(gate.reason).toBe(RESEND_BLOCKS.TARGET_REPLIED)

    // And reading S1's thread again does not report silence and leave it unhalted.
    expect((await check('s1', 'a1', false)).status).toBe('no-reply')
    expect(await halted('s1')).toBe(true)
  })

  it('a dated reply in the window is worded as this page paused until a time; an undated one pauses nothing', async () => {
    const { replyFoundDetail } = await import('@/outreach/replyCheck')
    const now = new Date('2026-10-09T06:00:00Z')
    const held = replyFoundDetail({ targetHandle: 't', senderHandle: 's1', writtenAt: new Date('2026-10-09T05:00:00Z'), resumeHours: 168, now })
    expect(held).toMatch(/@t replied to @s1/)
    expect(held).toMatch(/this page's messages to them are paused until 16 Oct 2026, 10:30 IST/)
    expect(held).not.toMatch(/take over|outreach to them is halted/)

    const undated = replyFoundDetail({ targetHandle: 't', senderHandle: 's1', writtenAt: null, resumeHours: 168, now })
    expect(undated).toMatch(/@t replied to @s1/)
    expect(undated).not.toMatch(/paused|halted/)

    const old = replyFoundDetail({ targetHandle: 't', senderHandle: 's1', writtenAt: new Date('2026-09-01T00:00:00Z'), resumeHours: 168, now })
    expect(old).toMatch(/no automatic pause applies/)
    expect(old).not.toMatch(/paused until/)
  })

  it('the held follow-up names this page and the release time, from the recorded date', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { sentAt: ago(3 * D) })
    await attempt('d', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up body' })
    openAndReadThread.mockResolvedValue(complete([{ text: 'a1 body', ours: true }, { text: 'call me', ours: false, approxAt: ago(H) }]))
    const r = await ensure('s1', 'd')
    if (r.ok) throw new Error('unreachable')
    expect(r.detail).toMatch(/@t_target replied to @s1 — this page's messages to them are paused until .+ IST/)
  })
})

describe('C2 R7 — the inbox scan goes through the same writer', () => {
  const inboxRow = (snippet: string, ageText: string) => ({ displayName: T, snippet, ageText, unread: true, folder: 'primary' as const, threadUrl: null })

  /** The thread loop after the scan is kept out of these cases: it finds nothing to read. */
  beforeEach(() => {
    openAndReadThread.mockResolvedValue({ ok: false, reason: 'unreadable', detail: 'not under test' })
  })

  it('a new reply with no free row SUPERSEDES the pair’s waiting draft, even one read an hour ago', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { status: 'REPLIED', sentAt: ago(12 * D), repliedAt: ago(10 * D), replyPostedAt: ago(10 * D), replyText: 'old words' })
    await attempt('d', 's1', { status: 'READY', touchNumber: 2, renderedBody: 'follow-up body', replyCheckedAt: ago(H) })
    scanInbox.mockImplementation(async (handle: string) => ({ ok: true, rows: handle === 's1' ? [inboxRow('new words please', '2h')] : [] }))

    await checkForReplies()
    const d = await row('d')
    expect(d.status).toBe('SKIPPED')
    expect(d.replyText).toBe('new words please')
    expect(await halted('s1')).toBe(true)
    // Its next follow-up cannot go out as "fresh" on the hour-old stamp: the draft is gone.
    expect((await row('a1')).replyText).toBe('old words')
  })

  /**
   * Every delivered row of the pair already carries a reply and nothing waits: the new one is
   * written FORWARD on the newest row so this pair re-arms from its own date, and the reply it
   * replaces survives verbatim in the audit row (audit H9's recommended option).
   */
  it('with every row already replied, the new reply is written forward and the old words kept in the audit', async () => {
    await addSender('s1')
    await attempt('a1', 's1', { status: 'REPLIED', sentAt: ago(12 * D), repliedAt: ago(10 * D), replyPostedAt: ago(10 * D), replyText: 'first words' })
    scanInbox.mockImplementation(async (handle: string) => ({ ok: true, rows: handle === 's1' ? [inboxRow('second words', '3h')] : [] }))

    await checkForReplies()
    const a1 = await row('a1')
    expect(a1.replyText).toBe('second words')
    expect(await halted('s1')).toBe(true)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'OutreachAttempt:a1', action: 'reply.record.inbox' } })
    expect(audit.detail).toMatch(/first words/)
  })

  /**
   * This page never wrote to them (a name-matched inbound message): the lead stays visible on
   * another page's row, this pair's freshness is cleared so its next follow-up reads the thread,
   * and the same words are not walked down to a third page on the next sweep.
   */
  it('with no row of its own the lead stays visible elsewhere — once — and this pair loses its freshness', async () => {
    await addSender('s1')
    await addSender('s2')
    await addSender('s3')
    await attempt('f1', 's1', { status: 'FAILED', touchNumber: 1, replyCheckedAt: ago(H) })
    await attempt('b2', 's2', { sentAt: ago(3 * D) })
    await attempt('c3', 's3', { sentAt: ago(4 * D) })
    scanInbox.mockImplementation(async (handle: string) => ({ ok: true, rows: handle === 's1' ? [inboxRow('hi, who is this?', '1h')] : [] }))

    await checkForReplies()
    expect((await row('b2')).replyText).toBe('hi, who is this?')
    expect((await row('f1')).replyCheckedAt).toBeNull()

    await checkForReplies()
    expect((await row('c3')).repliedAt).toBeNull()

    // And this pair's next follow-up opens its own thread rather than trusting a stamp.
    openAndReadThread.mockClear()
    await ensure('s1', 'f1')
    expect(openAndReadThread).toHaveBeenCalledOnce()
  })
})

/**
 * SOURCE CHECKS, comments stripped. Each guards a failure mode no SQLite test can see, or a call
 * site nobody has written yet.
 */
describe('the one writer, by construction', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/outreach/replyCheck.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const fnStart = src.indexOf('async function recordReplyOnPair(')
  const fnEnd = src.indexOf('\n}\n', fnStart)

  it('finds the writer it is about to inspect (not vacuous)', () => {
    expect(fnStart).toBeGreaterThan(0)
    expect(fnEnd).toBeGreaterThan(fnStart)
  })

  /** The balanced `{…}` or `(…)` starting at `open`. */
  function balanced(text: string, open: number): string {
    const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}']
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === o) depth++
      else if (text[i] === c && --depth === 0) return text.slice(open, i + 1)
    }
    return ''
  }

  /** Postgres sorts NULL FIRST under DESC; the filters must sit inside the where, not after it. */
  it('the attach query filters sentAt and repliedAt INSIDE its where', () => {
    const body = src.slice(fnStart, fnEnd)
    const call = body.indexOf('const free = await prisma.outreachAttempt.findFirst(')
    expect(call, 'the free-row lookup moved or was renamed').toBeGreaterThan(0)
    const arg = balanced(body, body.indexOf('(', call))
    const whereAt = arg.indexOf('where:')
    expect(whereAt).toBeGreaterThan(0)
    const where = balanced(arg, arg.indexOf('{', whereAt))
    expect(where).toMatch(/\bsenderId\b/)
    expect(where).toMatch(/sentAt: \{ not: null \}/)
    expect(where).toMatch(/repliedAt: null/)
  })

  /** Every `.update(` / `.updateMany(` call, with its whole argument, by balanced parentheses. */
  function updateCalls(text: string): { at: number; arg: string }[] {
    const out: { at: number; arg: string }[] = []
    for (const m of text.matchAll(/\.(update|updateMany)\(/g)) {
      const open = m.index! + m[0].length - 1
      let depth = 0
      let i = open
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')' && --depth === 0) break
      }
      out.push({ at: m.index!, arg: text.slice(open, i + 1) })
    }
    return out
  }

  /**
   * NO OTHER PATH WRITES REPLY TEXT. The deleted backfill was a second writer, and two copies of
   * "which row does a reply sit on" are how the thread read and the inbox drifted apart.
   */
  it('reply text is written only by recordReplyOnPair', () => {
    const calls = updateCalls(src)
    expect(calls.length, 'found no update calls at all — the extractor is broken').toBeGreaterThan(3)
    const outside = calls.filter((c) => c.at < fnStart || c.at > fnEnd)
    expect(outside.filter((c) => /\breplyText\b|\.\.\.reply\b/.test(c.arg)).map((c) => c.arg.slice(0, 120))).toEqual([])
    // Inside, the text travels in ONE object, built once.
    const valueWrites = [...src.matchAll(/\breplyText\s*:(?!\s*(?:true\b|\{\s*not:|string\b))/g)].map((m) => m.index!)
    expect(valueWrites.length).toBe(1)
    expect(valueWrites[0]).toBeGreaterThan(fnStart)
    expect(valueWrites[0]).toBeLessThan(fnEnd)
  })
})
