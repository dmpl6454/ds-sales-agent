import { describe, it, expect, vi, afterAll } from 'vitest'
import {
  openOutreachDb,
  seedSender,
  seedTarget,
  seedPair,
  seedVariants,
  seedDraft,
  seedPark,
  setSetting,
  senderId,
  targetId,
  pairId,
} from './helpers/outreach-db'

/**
 * THE LIVE WEDGE OF 17 OCTOBER 2026, REPRODUCED AND RELEASED, against the real `runOutreach`.
 *
 * Measured on the box: @bollywoodchronicle's only profile was on a Mac that no longer exists;
 * its 147 waiting first touches filled the fleet-wide waiting depth (`maxWaitingNewBrandDrafts`)
 * and every page the sending Mac DOES hold read `new-brand-daily-cap`, `queued=0`, for a day.
 *
 * The scenario, small: `alpha` is the page the Studio holds; `charlie` is held only by a Mac gone
 * for a month. The depth is 4 and is full — charlie's three waiting first touches (one of them
 * hand-edited) and one rehearsal draft from the burner, which is outside the fleet. Passes in
 * one database: first with NO presence row (the legacy deployment — the rule must be inert, and
 * the wedge is visible); then the Studio's presence row appears — the holder history is SEEDED
 * from that one snapshot and the release waits (never decided on one read, review 17 Oct); then
 * the release, and alpha writes in the same pass; then nothing more.
 *
 * Two more fleet pages pin that ONLY the not-held reason releases (review): `bravo` (logged out)
 * and `delta` (CHALLENGED) are both LISTED by the Studio, so the presence rule does not touch them,
 * and each owns one planner-written READY first touch that no pass may SKIP. Widening the release
 * filter to "any unavailable account" fails here. And a last pass with every Mac gone for four days
 * pins the other hold: when no fleet page can send, nothing is released (review).
 *
 * Nothing in a planning pass may reach the network; the planner-golden mocks are repeated here.
 */

vi.mock('@/detection/igHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/igHttp')>()),
  igGet: async () => {
    throw new Error('unheld-release: igGet reached the network')
  },
}))
vi.mock('@/detection/enrichHandle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/enrichHandle')>()),
  enrichHandle: async () => {
    throw new Error('unheld-release: enrichHandle reached the network')
  },
}))
vi.mock('@/outreach/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/generate')>()),
  generateMessageBody: async () => {
    throw new Error('unheld-release: generateMessageBody reached the network')
  },
}))
vi.mock('@/outreach/browser/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/profile')>()),
  profileStatus: (handle: string) => ({ handle, dir: `/tmp/profiles/${handle}`, initialised: true, hasSession: true }),
}))
vi.stubGlobal('fetch', () => {
  throw new Error('unheld-release: global fetch reached the network')
})

process.env.DRY_RUN = 'false'
process.env.MAX_TOTAL_SENDS = 'unlimited'
process.env.DEFAULT_COOLDOWN_DAYS = '7'
process.env.HOOK_MAX_AGE_HOURS = '72'
process.env.MAX_PER_PAIR_PER_DAY = '5'
process.env.AUTOPILOT_ENABLED = 'false'
process.env.SEND_ENABLED = 'true'
process.env.DETECTION_CUTOFF = ''

const db = await openOutreachDb('unheld-release')
const ANCHOR = new Date('2026-10-17T00:10:00.000Z')
vi.setSystemTime(ANCHOR)

const { prisma } = await import('@/lib/db')
const { runOutreach } = await import('@/outreach/plan')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')

afterAll(async () => {
  vi.useRealTimers()
  await db.close(prisma)
})

const h = (hours: number) => new Date(ANCHOR.getTime() - hours * 3_600_000)
const ALPHA = senderId('alpha')
const CHARLIE = senderId('charlie')
const BURNER = senderId('tabishmukaddam1')

const BRAVO = senderId('bravo')
const DELTA = senderId('delta')

type Row = 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'b1' | 'd1'
const ids = {} as Record<Row, string>

async function seed(): Promise<void> {
  for (const handle of ['alpha', 'charlie']) {
    await seedSender(prisma, { handle })
    await seedVariants(prisma, senderId(handle))
  }
  await seedSender(prisma, { handle: 'tabishmukaddam1', fleetMember: false })
  await seedVariants(prisma, BURNER)
  /* Held by the Studio, unavailable for ANOTHER reason — their drafts are re-judged by the Mac's gate. */
  await seedSender(prisma, { handle: 'bravo', sessionInvalidAt: h(5) })
  await seedVariants(prisma, BRAVO)
  await seedSender(prisma, { handle: 'delta', status: 'CHALLENGED', challengedAt: h(5 * 24) })
  await seedVariants(prisma, DELTA)
  await setSetting(prisma, 'maxWaitingNewBrandDrafts', '6')

  /* `aaa_new` sorts first, so it is the first pair the planner walks — no draft for anyone yet. */
  for (const t of ['aaa_new', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'b1', 'd1']) await seedTarget(prisma, { handle: t })

  /* charlie's waiting first touches: two the planner wrote, one a person edited. */
  for (const t of ['c1', 'c2', 'c3']) await seedPair(prisma, CHARLIE, targetId(t))
  ids.c1 = (await seedDraft(prisma, { pairId: pairId(CHARLIE, targetId('c1')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(48) })).id
  ids.c2 = (await seedDraft(prisma, { pairId: pairId(CHARLIE, targetId('c2')), status: 'QUEUED', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(47) })).id
  ids.c3 = (await seedDraft(prisma, { pairId: pairId(CHARLIE, targetId('c3')), status: 'READY', touchNumber: 1, body: `${SINGLE_TEMPLATE_MIDDLE} (edited)`, queuedAt: h(46) })).id
  await prisma.auditLog.create({
    data: { actor: 'tabish@dashmani.com', action: 'attempt.edited', entity: `OutreachAttempt:${ids.c3}`, detail: '@charlie → @c3' },
  })

  /* charlie's rows that must NEVER be released: one mid-send, two parks. */
  for (const t of ['c4', 'c5', 'c6']) await seedPair(prisma, CHARLIE, targetId(t))
  ids.c4 = (await seedDraft(prisma, { pairId: pairId(CHARLIE, targetId('c4')), status: 'SENDING', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(45) })).id
  ids.c5 = (await seedPark(prisma, { pairId: pairId(CHARLIE, targetId('c5')), failureCode: 'no-composer', queuedAt: h(44) })).id
  ids.c6 = (await seedPark(prisma, { pairId: pairId(CHARLIE, targetId('c6')), failureCode: 'not-in-thread', queuedAt: h(43) })).id

  /* The burner, outside the fleet and held by no Mac either: its rehearsal draft is a person's. */
  await seedPair(prisma, BURNER, targetId('c7'))
  ids.c7 = (await seedDraft(prisma, { pairId: pairId(BURNER, targetId('c7')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(42) })).id

  /* bravo's and delta's planner-written first touches — no audit row a person left on either. */
  await seedPair(prisma, BRAVO, targetId('b1'))
  ids.b1 = (await seedDraft(prisma, { pairId: pairId(BRAVO, targetId('b1')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(41) })).id
  await seedPair(prisma, DELTA, targetId('d1'))
  ids.d1 = (await seedDraft(prisma, { pairId: pairId(DELTA, targetId('d1')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(40) })).id
}

const statusOf = async (id: string) => (await prisma.outreachAttempt.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const skipsBy = async (id: string) => prisma.auditLog.count({ where: { entity: `OutreachAttempt:${id}`, action: 'attempt.skipped' } })

await seed()

describe('pass 1 — no presence row: the rule is inert, and the wedge is the live one', () => {
  it('nothing of charlie is released, and the first new recipient is refused on the full depth', async () => {
    const summary = await runOutreach()
    expect(summary.queued).toBe(0)
    for (const k of ['c1', 'c2', 'c3'] as const) expect(await statusOf(ids[k])).not.toBe('SKIPPED')
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(0)

    const newRecipient = summary.outcomes.filter((o) => o.pairKey.endsWith('→aaa_new'))
    expect(newRecipient.some((o) => o.skipReason === 'new-brand-daily-cap')).toBe(true)
    expect(newRecipient.some((o) => o.attemptId !== undefined)).toBe(false)
  })
})

const STUDIO_PRESENCE = () =>
  JSON.stringify([
    { device: 'tabish-mac', at: h(30 * 24).toISOString(), handles: ['alpha', 'bravo', 'charlie', 'delta', 'tabishmukaddam1'] },
    { device: 'DMPLs Mac Studio', at: h(0.01).toISOString(), handles: ['alpha', 'bravo', 'delta'] },
  ])

describe('pass 2 — the Studio row appears: the history is seeded from ONE read, so the release waits', () => {
  it('rotation already skips charlie, but nothing is SKIPPED on a single snapshot', async () => {
    await setSetting(prisma, 'devicePresence', STUDIO_PRESENCE())
    const summary = await runOutreach()
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(0)
    for (const k of ['c1', 'c2'] as const) expect(await statusOf(ids[k])).not.toBe('SKIPPED')
    expect(summary.outcomes.filter((o) => o.pairKey.startsWith('charlie→') && o.attemptId !== undefined)).toHaveLength(0)
    /* the history row now exists, written by the planner, and lists only the Studio's handles. */
    const seen = await prisma.setting.findUniqueOrThrow({ where: { key: 'sessionHolderSeen' } })
    expect(Object.keys(JSON.parse(seen.value)).sort()).toEqual(['alpha', 'bravo', 'delta'])
  })
})

describe('pass 3 — charlie is released, alpha writes in the same pass', () => {
  it('releases, keeps what it must, and the depth it freed is spent on a page that can send', async () => {
    await setSetting(prisma, 'devicePresence', STUDIO_PRESENCE())
    const summary = await runOutreach()
    /* charlie's planner-written drafts are released, through the one writer, audited. */
    expect(await statusOf(ids.c1)).toBe('SKIPPED')
    expect(await statusOf(ids.c2)).toBe('SKIPPED')
    expect(await skipsBy(ids.c1)).toBe(1)
    expect(await skipsBy(ids.c2)).toBe(1)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: `OutreachAttempt:${ids.c1}`, action: 'attempt.skipped' } })
    expect(audit.actor).toBe('planner')
    expect(audit.detail).toContain('no Mac that has been online in the last 3 days')

    /* the hand-edited one stays; SENDING and both parks are untouched; the burner's is a person's. */
    expect(await statusOf(ids.c3)).toBe('READY')
    expect(await statusOf(ids.c4)).toBe('SENDING')
    expect(await statusOf(ids.c5)).toBe('FAILED')
    expect(await statusOf(ids.c6)).toBe('FAILED')
    expect(await statusOf(ids.c7)).toBe('READY')
    /* ONLY the not-held reason releases: a logged-out and a flagged page keep their drafts. */
    expect(await statusOf(ids.b1)).toBe('READY')
    expect(await statusOf(ids.d1)).toBe('READY')
    for (const k of ['c3', 'c4', 'c5', 'c6', 'c7', 'b1', 'd1'] as const) expect(await skipsBy(ids[k])).toBe(0)

    /* charlie is never elected again, and alpha gets the first new recipient in this same pass. */
    expect(summary.outcomes.filter((o) => o.pairKey.startsWith('charlie→') && o.attemptId !== undefined)).toHaveLength(0)
    const written = await prisma.outreachAttempt.findMany({
      where: { senderId: ALPHA, status: { in: ['READY', 'QUEUED'] } },
      select: { targetId: true, touchNumber: true },
    })
    expect(written.map((w) => w.targetId)).toContain(targetId('aaa_new'))
    /* the depth: 6, minus the edited draft, the burner's, bravo's and delta's = room for exactly two. */
    expect(written).toHaveLength(2)
    expect(summary.queued).toBe(2)
  })

  it('a fourth pass releases nothing more and writes nothing new — the depth is full of drafts that CAN send', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })
    const summary = await runOutreach()
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(before)
    expect(summary.queued).toBe(0)
  })
})

describe('pass 5 — every Mac gone four days: no fleet page can send, so NOTHING is released', () => {
  it('alpha is unheld too, but its waiting drafts are kept for when a Mac returns', async () => {
    const later = new Date(ANCHOR.getTime() + 96 * 3_600_000)
    vi.setSystemTime(later)
    /* The Studio's entry froze when its lid closed; the history ages past the window with it. */
    await setSetting(prisma, 'devicePresence', STUDIO_PRESENCE())
    const alphaWaiting = await prisma.outreachAttempt.findMany({
      where: { senderId: ALPHA, status: { in: ['READY', 'QUEUED'] } },
      select: { id: true },
    })
    expect(alphaWaiting).toHaveLength(2)
    const before = await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })
    await runOutreach()
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(before)
    for (const a of alphaWaiting) expect(await statusOf(a.id)).not.toBe('SKIPPED')
  })
})
