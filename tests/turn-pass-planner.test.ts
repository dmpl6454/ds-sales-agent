import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import {
  openOutreachDb,
  seedSender,
  seedTarget,
  seedPair,
  seedVariants,
  seedDelivery,
  seedReply,
  seedDraft,
  seedPark,
  seedPost,
  seedCategory,
  setSetting,
  senderId,
  targetId,
  pairId,
} from './helpers/outreach-db'

/**
 * ── THE TURN PASS, AGAINST THE REAL PLANNER (17 Nov 2026) ─────────────────────
 *
 * Production, 17 Nov: nothing delivered for 14.6 days, every live recipient already messaged,
 * the planner writing nothing — the page rotation elected had written before and had nothing new
 * to say, while a page that never wrote could have sent the standard introduction. The pass
 * (`TurnPass`, rotation.ts) hands the turn to that page. These scenarios drive `runOutreach`
 * itself over a real SQLite file, each from an empty database, and pin both directions: the
 * introduction is written where the rule says, and nowhere else.
 *
 * Four fleet pages, cohort 1, so the fleet ring is alpha → bravo → charlie → delta. The usual
 * shape: bravo wrote 20 days ago, alpha 10 days ago — both outside the 7-day allowance window, so
 * one message is allowed — and nobody else wrote. alpha wrote last, so bravo is elected; bravo
 * has nothing new to say; charlie never wrote.
 *
 * Nothing in a planning pass may reach the network; the planner-golden mocks are repeated here.
 */

vi.mock('@/detection/igHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/igHttp')>()),
  igGet: async () => {
    throw new Error('turn-pass: igGet reached the network')
  },
}))
vi.mock('@/detection/enrichHandle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/enrichHandle')>()),
  enrichHandle: async () => {
    throw new Error('turn-pass: enrichHandle reached the network')
  },
}))
vi.mock('@/detection/exists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/exists')>()),
  probeHandle: async () => {
    throw new Error('turn-pass: probeHandle reached the network')
  },
  handleExists: async () => {
    throw new Error('turn-pass: handleExists reached the network')
  },
}))
vi.mock('@/outreach/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/generate')>()),
  generateMessageBody: async () => {
    throw new Error('turn-pass: generateMessageBody reached the network')
  },
}))
vi.mock('@/outreach/browser/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/profile')>()),
  profileStatus: (handle: string) => ({ handle, dir: `/tmp/profiles/${handle}`, initialised: true, hasSession: true }),
}))
vi.stubGlobal('fetch', () => {
  throw new Error('turn-pass: global fetch reached the network')
})

process.env.DRY_RUN = 'false'
process.env.MAX_TOTAL_SENDS = 'unlimited'
process.env.DEFAULT_COOLDOWN_DAYS = '7'
process.env.HOOK_MAX_AGE_HOURS = '72'
process.env.MAX_PER_PAIR_PER_DAY = '5'
process.env.AUTOPILOT_ENABLED = 'false'
process.env.SEND_ENABLED = 'true'
process.env.DETECTION_CUTOFF = ''

const db = await openOutreachDb('turn-pass')
const ANCHOR = new Date('2026-11-17T05:00:00.000Z')
vi.setSystemTime(ANCHOR)

const { prisma } = await import('@/lib/db')
const { runOutreach } = await import('@/outreach/plan')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')
const { buildRestTally } = await import('@/app/view-model/rest-tally')
const { buildProspectsPage } = await import('@/app/view-model/prospects-page')
const { SKIP_REASONS } = await import('@/outreach/governor')

afterAll(async () => {
  vi.useRealTimers()
  await db.close(prisma)
})

const d = (days: number) => new Date(ANCHOR.getTime() - days * 86_400_000)
const h = (hours: number) => new Date(ANCHOR.getTime() - hours * 3_600_000)
const PAGES = ['alpha', 'bravo', 'charlie', 'delta'] as const
const S = Object.fromEntries(PAGES.map((p) => [p, senderId(p)])) as Record<(typeof PAGES)[number], string>
const CO = targetId('co')
const WATCH = targetId('viralbhayani')
const FOLLOW_UP_BODY = `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`

async function wipe(): Promise<void> {
  await prisma.outreachAttempt.deleteMany({})
  await prisma.dailyReservation.deleteMany({})
  await prisma.auditLog.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.categoryTarget.deleteMany({})
  await prisma.categorySender.deleteMany({})
  await prisma.category.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.brandLookup.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})
}

/** The four pages, a WATCH channel, the recipient `co`, and a route from every page. */
async function seedFleet(opts: { unsignedIn?: readonly string[]; displayName?: string } = {}): Promise<void> {
  for (const p of PAGES) {
    await seedSender(prisma, { handle: p, ...(opts.unsignedIn?.includes(p) ? { sessionPath: null } : {}) })
    await seedVariants(prisma, S[p])
  }
  await seedTarget(prisma, { handle: 'viralbhayani', role: 'WATCH', kind: 'CHANNEL', displayName: 'Viral Bhayani' })
  await seedTarget(prisma, { handle: 'co', ...(opts.displayName ? { displayName: opts.displayName } : {}) })
  for (const p of PAGES) await seedPair(prisma, S[p], CO)
}

/**
 * A delivery, and — unless `read: null` — a vouched read of that conversation an hour ago, after
 * the 16 Nov window fix and after the delivery. Rule 5 of `TurnPass` holds the pass until every
 * page that wrote has had its conversation read since it wrote, so the scenarios that are about
 * something else start from conversations that have been read; the ones about the read say so.
 */
async function deliver(
  page: (typeof PAGES)[number],
  daysAgo: number,
  opts: { read?: Date | null } = {},
): Promise<{ id: string }> {
  const row = await seedDelivery(prisma, { pairId: pairId(S[page], CO), sentAt: d(daysAgo), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
  const read = opts.read === undefined ? h(1) : opts.read
  if (read !== null) await prisma.outreachAttempt.update({ where: { id: row.id }, data: { replyCheckedAt: read } })
  return row
}

async function plan() {
  const summary = await runOutreach()
  const byPair = new Map(summary.outcomes.map((o) => [o.pairKey, o]))
  const drafts = await prisma.outreachAttempt.findMany({
    where: { targetId: CO, status: { in: ['QUEUED', 'READY', 'SENDING'] } },
    select: { senderId: true, touchNumber: true, renderedBody: true, campaignId: true, status: true },
  })
  return { summary, byPair, drafts }
}

const key = (page: string) => `${page}→co`

beforeEach(async () => {
  await wipe()
})

describe('the pass fires: an elected page with nothing new hands the turn to a page that never wrote', () => {
  it('writes charlie’s introduction, and only that; a second pass writes nothing more', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 10)

    const first = await plan()
    expect(first.drafts).toHaveLength(1)
    expect(first.drafts[0]).toMatchObject({
      senderId: S.charlie,
      touchNumber: 1,
      renderedBody: SINGLE_TEMPLATE_MIDDLE.trim(),
      campaignId: null,
    })
    expect(first.byPair.get(key('bravo'))).toMatchObject({ skipReason: SKIP_REASONS.NO_NEW_MATERIAL })
    expect(first.byPair.get(key('alpha'))).toMatchObject({ skipReason: SKIP_REASONS.NO_NEW_MATERIAL })
    const delta = first.byPair.get(key('delta'))
    expect(delta).toMatchObject({ skipReason: 'not-this-senders-turn' })
    /* scripts/diagnose-send-gap.sh parses the "@x is next in" prefix — it must survive. */
    expect(delta?.skipDetail).toMatch(/^@charlie is next in the fleet rotation — @bravo has written to them before/)

    /* The turn stays passed while charlie's draft waits: no second introduction from delta. */
    const second = await plan()
    expect(second.drafts.map((x) => x.senderId)).toEqual([S.charlie])
    expect(second.byPair.get(key('delta'))?.skipDetail).toMatch(/^@charlie is next in/)
  })

  it('does not depend on the order pairs are walked in: the never-wrote page that sorts FIRST is not the one passed to', async () => {
    await seedFleet()
    await deliver('charlie', 20)
    await deliver('bravo', 10)
    /* bravo wrote last → charlie elected (wrote, nothing new) → walk on: delta never wrote.
       alpha also never wrote and is the FIRST pair the planner walks, so rotation is asked there. */
    const r = await plan()
    expect(r.drafts.map((x) => x.senderId)).toEqual([S.delta])
    expect(r.byPair.get(key('alpha'))?.skipDetail).toMatch(/^@delta is next in the fleet rotation — @charlie has/)
  })

  it('applies inside a GROUP ring too, in that ring’s own order', async () => {
    await seedFleet()
    await setSetting(prisma, 'templateBody:marketing', `Hi,We’re the Mad About Marketing network, reaching 300M+ marketers and buyers every day across our pages. Let’s connect - +916000189766 - Kapil`)
    /* Ring order delta, charlie, bravo, alpha. delta wrote last → charlie elected (wrote) → bravo. */
    await seedCategory(prisma, 'marketing', { senders: [S.delta, S.charlie, S.bravo, S.alpha], targets: [CO] })
    await deliver('charlie', 20)
    await deliver('delta', 10)
    const r = await plan()
    expect(r.drafts.map((x) => x.senderId)).toEqual([S.bravo])
  })
})

describe('the pass does NOT fire', () => {
  it('when switched off — the turn waits on bravo, as before', async () => {
    await seedFleet()
    await setSetting(prisma, 'passTurnWhenNothingNew', 'false')
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))).toMatchObject({ skipReason: 'not-this-senders-turn', skipDetail: '@bravo is next in the fleet rotation' })
  })

  it('when a reply sits on a SUPERSEDED draft rather than a delivered row — dated or not', async () => {
    // recordReplyOnPair can put a reply on a waiting draft it supersedes to SKIPPED; the loader
    // and the tally must read replies on every row, not only on deliveries.
    for (const replyPostedAt of [null, d(9)]) {
      await wipe()
      await seedFleet()
      await deliver('bravo', 20)
      await deliver('alpha', 10)
      const skipped = await seedDraft(prisma, { pairId: pairId(S.alpha, CO), status: 'SKIPPED', touchNumber: 2, body: 'x'.repeat(60), queuedAt: d(9) })
      await prisma.outreachAttempt.update({ where: { id: skipped.id }, data: { repliedAt: d(9), replyPostedAt, replyText: 'Hi' } })
      const r = await plan()
      expect(r.drafts).toHaveLength(0)
      const tally = await buildRestTally(ANCHOR)
      expect(tally.turnPassNothingNew.has(CO)).toBe(false)
    }
  })

  it('when they replied — even an UNDATED reply, which isFollowUp alone would not count', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    const a = await deliver('alpha', 10)
    await seedReply(prisma, { attemptId: a.id, repliedAt: d(9), replyPostedAt: null, replyText: 'Hi' })
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))?.skipDetail).toBe('@bravo is next in the fleet rotation')
  })

  it('when there is something new to say — bravo writes its follow-up, charlie waits', async () => {
    await seedFleet({ displayName: 'BoroPlus' })
    await setSetting(prisma, 'followUpBody', FOLLOW_UP_BODY)
    await seedPost(prisma, { shortcode: 'BP1', channelId: WATCH, postedAt: h(12), caption: 'with @co', brands: JSON.stringify(['BoroPlus Cream']) })
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const r = await plan()
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0]).toMatchObject({ senderId: S.bravo, touchNumber: 2 })
    expect(r.byPair.get(key('charlie'))?.skipDetail).toBe('@bravo is next in the fleet rotation')
  })

  it('when every page that never wrote cannot send — nothing is written, and it is not "rotation stuck"', async () => {
    await seedFleet({ unsignedIn: ['charlie', 'delta'] })
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('bravo'))).toMatchObject({ skipReason: SKIP_REASONS.NO_NEW_MATERIAL })
    for (const o of r.summary.outcomes) expect(o.skipReason).not.toBe('all-unavailable')
  })

  it('when the 7-day allowance holds them — a pass never buys a second message in the window', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 2)
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))).toMatchObject({ skipReason: SKIP_REASONS.MATERIAL_EXHAUSTED })
  })
})

describe('the pass waits until every page that wrote has had its conversation read since (rule 5)', () => {
  it('holds while alpha’s conversation is unread, names it, and passes once it has been read', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    const a = await deliver('alpha', 10, { read: null })

    const held = await plan()
    expect(held.drafts).toHaveLength(0)
    expect(held.byPair.get(key('charlie'))?.skipDetail).toMatch(
      /^@bravo is next in the fleet rotation — it has nothing new to say, and a page that never wrote takes over once @alpha has had the conversation with them read since writing/,
    )

    /* The sweep reads alpha's thread and vouches for the silence → the next pass hands the turn on. */
    await prisma.outreachAttempt.update({ where: { id: a.id }, data: { replyCheckedAt: h(0.5) } })
    const passed = await plan()
    expect(passed.drafts.map((x) => x.senderId)).toEqual([S.charlie])
  })

  it('a read from BEFORE the 16 Nov window fix is not a read', async () => {
    await seedFleet()
    await deliver('bravo', 20, { read: d(5) })
    await deliver('alpha', 10)
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))?.skipDetail).toMatch(/takes over once @bravo has had the conversation/)
  })

  it('counts a page outside the ring too — a reply to a retired page is still a reply', async () => {
    await seedFleet()
    await seedSender(prisma, { handle: 'retired', fleetMember: false })
    await seedVariants(prisma, senderId('retired'))
    await seedPair(prisma, senderId('retired'), CO)
    await seedDelivery(prisma, { pairId: pairId(senderId('retired'), CO), sentAt: d(30), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))?.skipDetail).toMatch(/takes over once @retired has had/)
  })

  it('switched off (passTurnOnlyAfterRead=false), our record of replies alone decides', async () => {
    await seedFleet()
    await setSetting(prisma, 'passTurnOnlyAfterRead', 'false')
    await deliver('bravo', 20, { read: null })
    await deliver('alpha', 10, { read: null })
    const r = await plan()
    expect(r.drafts.map((x) => x.senderId)).toEqual([S.charlie])
  })

  it('a delivery with no recorded time still counts as a page that wrote — planner and screens agree', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const untimed = await seedDelivery(prisma, { pairId: pairId(S.delta, CO), sentAt: d(15), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
    await prisma.outreachAttempt.update({ where: { id: untimed.id }, data: { sentAt: null } })
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('charlie'))?.skipDetail).toMatch(/takes over once @delta has had the conversation/)
    const row = (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!
    expect(row.nextSenderSentence).toMatch(/takes over once @delta has had the conversation/)
    const tally = await buildRestTally(ANCHOR)
    expect(tally.clear).toBe(0)
  })

  it('/targets says what the recipient is waiting for, and the rest tally does not claim a pass', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 10, { read: null })
    /* The tally mirrors the planner: bravo stays elected and is held by its own rule. */
    const tally = await buildRestTally(ANCHOR)
    expect(tally.byReason.find((r) => r.reason === SKIP_REASONS.NO_NEW_MATERIAL)?.count).toBe(1)
    expect(tally.clear).toBe(0)
    const row = (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!
    expect(row.nextSenderSentence).toMatch(
      /^Next message comes from @bravo — it has nothing new to say; a page that never wrote to them takes over once @alpha has had the conversation with them read since writing/,
    )
  })
})

describe('a passed turn stays passed while its introduction is OUT (review of fa0c635)', () => {
  it('a not-in-thread park counts as out: the next pass does not hand delta the same introduction', async () => {
    // charlie's passed introduction cleared the composer and never showed in the thread — parked,
    // and the company may have it. It is neither waiting nor delivered, and its route is blocked;
    // the first version therefore passed the turn to delta, which drafted the byte-identical
    // introduction minutes later.
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    await seedPark(prisma, { pairId: pairId(S.charlie, CO), failureCode: 'not-in-thread', queuedAt: h(1), body: SINGLE_TEMPLATE_MIDDLE })
    const r = await plan()
    expect(r.drafts).toHaveLength(0)
    expect(r.byPair.get(key('delta'))?.skipDetail).toBe('@bravo is next in the fleet rotation')
    const tally = await buildRestTally(ANCHOR)
    expect(tally.clear).toBe(0)
  })

  it('an UNAVAILABLE holder still holds it: no second introduction from another page (review of 3e03c67)', async () => {
    await seedFleet({ unsignedIn: ['charlie'] })
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    await seedDraft(prisma, { pairId: pairId(S.charlie, CO), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(1) })
    const r = await plan()
    expect(r.drafts.map((x) => x.senderId)).toEqual([S.charlie])
    expect(r.byPair.get(key('delta'))?.skipDetail).toBe('@bravo is next in the fleet rotation')
  })

  it('new material after the introduction was written does not put bravo’s follow-up beside it', async () => {
    await seedFleet({ displayName: 'BoroPlus' })
    await setSetting(prisma, 'followUpBody', FOLLOW_UP_BODY)
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    await seedDraft(prisma, { pairId: pairId(S.charlie, CO), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(1) })
    await seedPost(prisma, { shortcode: 'BP2', channelId: WATCH, postedAt: h(2), caption: 'with @co', brands: JSON.stringify(['BoroPlus Cream']) })
    const r = await plan()
    expect(r.drafts.map((x) => x.senderId)).toEqual([S.charlie])
    expect(r.byPair.get(key('bravo'))?.skipDetail).toMatch(/^@charlie is next in the fleet rotation — @bravo/)
  })
})

describe('the screens say what the planner does', () => {
  it('the rest tally does not file them under "nothing new", and /targets names the page that will write', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 10)

    const tally = await buildRestTally(ANCHOR)
    expect(tally.byReason.find((r) => r.reason === SKIP_REASONS.NO_NEW_MATERIAL)).toBeUndefined()
    expect(tally.clear).toBe(1)
    expect(tally.turnPassNothingNew.get(CO)).toBe(true)

    const row = (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!
    expect(row.nextSenderWillWrite).toBe(true)
    expect(row.nextSenderSentence).toMatch(/^Next message comes from @charlie — @bravo has written to them before and has nothing new to say/)
  })

  it('switched off, both screens keep naming bravo and its rest', async () => {
    await seedFleet()
    await setSetting(prisma, 'passTurnWhenNothingNew', 'false')
    await deliver('bravo', 20)
    await deliver('alpha', 10)
    const tally = await buildRestTally(ANCHOR)
    expect(tally.byReason.find((r) => r.reason === SKIP_REASONS.NO_NEW_MATERIAL)?.count).toBe(1)
    expect(tally.turnPassNothingNew.size).toBe(0)
    const row = (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!
    expect(row.nextSenderSentence).toMatch(/^Next message comes from @bravo,/)
  })

  it('when the allowance holds them, the screens pass no turn (the planner never reaches rotation)', async () => {
    await seedFleet()
    await deliver('bravo', 20)
    await deliver('alpha', 2)
    const tally = await buildRestTally(ANCHOR)
    expect(tally.turnPassNothingNew.has(CO)).toBe(false)
    const row = (await buildProspectsPage()).prospects.find((p) => p.handle === 'co')!
    expect(row.nextSenderSentence).toMatch(/^Next message comes from @bravo,/)
  })
})
