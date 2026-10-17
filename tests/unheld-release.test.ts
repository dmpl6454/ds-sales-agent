import { describe, it, expect, afterAll } from 'vitest'
import { openOutreachDb, seedSender, seedTarget, seedPair, seedVariants, seedDraft, seedPark, senderId, targetId, pairId } from './helpers/outreach-db'

/**
 * THE RELEASE OF AN UNHELD ACCOUNT'S DRAFTS, AND THE WRITER IT GOES THROUGH — driven directly
 * (review, 17 Oct 2026). The planner test covers the live wedge end to end; these pin the three
 * narrowings a refactor could lose without the planner test noticing:
 *
 *   1. ONLY `NOT_HELD_BY_AN_ONLINE_MAC` releases — a flagged, logged-out, paused or never-signed-in
 *      account keeps its queue (its drafts are re-judged by the Mac's gate the moment it is fixed).
 *   2. The two holds: no history yet (never on one snapshot), and no fleet page can send (the
 *      release would free the depth for nobody and reverse queue-and-send-on-return).
 *   3. `discardAttempt({ onlyWaiting: true })` refuses a FAILED park and a SENDING row — the race
 *      where a draft read as READY becomes a park before the release writes. No other caller passes
 *      the flag, so without these nothing pins it.
 */

const db = await openOutreachDb('unheld-release-direct')
const { prisma } = await import('@/lib/db')
const { releaseDraftsNoOnlineMacHolds } = await import('@/outreach/unheldRelease')
const { discardAttempt } = await import('@/outreach/discard')
const { NOT_HELD_BY_AN_ONLINE_MAC } = await import('@/outreach/availability')

afterAll(async () => {
  await db.close(prisma)
})

const T0 = new Date('2026-10-17T00:00:00.000Z')
const body = 'Hi, a standard message long enough for every send guard to verify it end to end.'
const statusOf = async (id: string) => (await prisma.outreachAttempt.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const skips = async (id: string) => prisma.auditLog.count({ where: { entity: `OutreachAttempt:${id}`, action: 'attempt.skipped' } })

const HANDLES = ['able', 'gone', 'loggedout', 'flagged', 'paused', 'never'] as const
const draft = {} as Record<(typeof HANDLES)[number], string>

for (const handle of HANDLES) {
  await seedSender(prisma, {
    handle,
    status: handle === 'flagged' ? 'CHALLENGED' : handle === 'paused' ? 'PAUSED' : 'ACTIVE',
    sessionInvalidAt: handle === 'loggedout' ? T0 : null,
    sessionPath: handle === 'never' ? null : undefined,
  })
  await seedVariants(prisma, senderId(handle))
  await seedTarget(prisma, { handle: `t_${handle}` })
  await seedPair(prisma, senderId(handle), targetId(`t_${handle}`))
  draft[handle] = (
    await seedDraft(prisma, { pairId: pairId(senderId(handle), targetId(`t_${handle}`)), status: 'READY', touchNumber: 1, body, queuedAt: T0 })
  ).id
}

/** Every account but `able` unavailable, each with ITS OWN reason — as `readSenderAvailability` would say. */
const unavailable = new Map<string, string>([
  [senderId('gone'), NOT_HELD_BY_AN_ONLINE_MAC],
  [senderId('loggedout'), 'logged out — needs signing in again'],
  [senderId('flagged'), 'flagged by Instagram'],
  [senderId('paused'), 'paused'],
  [senderId('never'), 'never signed in'],
])

describe('the holds', () => {
  it('no history yet: nothing released on the first snapshot', async () => {
    const r = await releaseDraftsNoOnlineMacHolds({ unavailable, actor: 'planner', hadHistory: false })
    expect(r.heldBack).toBe('no-history')
    expect(r.released).toEqual([])
    expect(await statusOf(draft.gone)).toBe('READY')
  })

  it('no fleet page can send: nothing released, whatever the history says', async () => {
    const all = new Map(unavailable)
    all.set(senderId('able'), NOT_HELD_BY_AN_ONLINE_MAC)
    const r = await releaseDraftsNoOnlineMacHolds({ unavailable: all, actor: 'planner', hadHistory: true })
    expect(r.heldBack).toBe('no-page-can-send')
    expect(r.released).toEqual([])
    for (const h of HANDLES) expect(await statusOf(draft[h])).toBe('READY')
  })
})

describe('only the not-held reason releases', () => {
  it('releases the unheld account and NOTHING of the four unavailable for another reason', async () => {
    const r = await releaseDraftsNoOnlineMacHolds({ unavailable, actor: 'planner', hadHistory: true })
    expect(r.heldBack).toBeNull()
    expect(r.released).toEqual([{ handle: 'gone', count: 1 }])
    expect(await statusOf(draft.gone)).toBe('SKIPPED')
    for (const h of ['able', 'loggedout', 'flagged', 'paused', 'never'] as const) {
      expect(await statusOf(draft[h]), h).toBe('READY')
      expect(await skips(draft[h]), h).toBe(0)
    }
  })
})

describe('discardAttempt({ onlyWaiting }) — the narrowing the release depends on', () => {
  const pair = () => pairId(senderId('able'), targetId('t_able'))

  it('a FAILED park (no-composer) is refused with onlyWaiting, stays FAILED, and writes no audit row', async () => {
    const park = await seedPark(prisma, { pairId: pair(), failureCode: 'no-composer', queuedAt: T0 })
    const r = await discardAttempt({ attemptId: park.id, reason: 'release', actor: 'planner', onlyWaiting: true })
    expect(r.ok).toBe(false)
    expect(await statusOf(park.id)).toBe('FAILED')
    expect(await skips(park.id)).toBe(0)
    /* …and the same row IS discardable by a person (the landing page's control), which is the contrast. */
    const byHand = await discardAttempt({ attemptId: park.id, reason: 'by hand', actor: 'tabish@dashmani.com' })
    expect(byHand.ok).toBe(true)
    expect(await statusOf(park.id)).toBe('SKIPPED')
  })

  it('a SENDING row is refused both ways', async () => {
    const sending = await seedDraft(prisma, { pairId: pair(), status: 'SENDING', touchNumber: 1, body, queuedAt: T0 })
    expect((await discardAttempt({ attemptId: sending.id, reason: 'x', actor: 'planner', onlyWaiting: true })).ok).toBe(false)
    expect((await discardAttempt({ attemptId: sending.id, reason: 'x', actor: 'planner' })).ok).toBe(false)
    expect(await statusOf(sending.id)).toBe('SENDING')
    expect(await skips(sending.id)).toBe(0)
  })

  it('a READY draft is discarded with onlyWaiting', async () => {
    const ready = await seedDraft(prisma, { pairId: pair(), status: 'QUEUED', touchNumber: 2, body, queuedAt: T0 })
    expect((await discardAttempt({ attemptId: ready.id, reason: 'x', actor: 'planner', onlyWaiting: true })).ok).toBe(true)
    expect(await statusOf(ready.id)).toBe('SKIPPED')
  })
})
