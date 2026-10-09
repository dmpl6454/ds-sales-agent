import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * AUDIT C1 (2026-10-09): A REFUSED DOOR MUST NOT STARVE THE REPLY SWEEP.
 *
 * When the inbox route cannot confirm who a conversation is with, the read refuses and never
 * stamps `replyCheckedAt` — correctly. But the sweep re-selects every never-checked pair on
 * every run and ranks them first, and its budget is four reads a run every half hour. A
 * door-less recipient the ring fanned out to four or five pages would therefore hold the whole
 * budget forever: zero real reply reads, and dozens of inbox-route drives a day from revenue
 * accounts. Rules 26/36 — a guard that yields to the work it guards starves — one door along.
 *
 * So a refused pair rests a day (the shared `lookupCooldown` memory), is COUNTED in `deferred`
 * while it rests, and is forgotten by its next successful read. Driven here through the real
 * `checkForReplies` with the database and the browser mocked at the module boundary.
 */

const openAndReadThread = vi.fn()
const findMany = vi.fn()
const update = vi.fn()

vi.mock('@/lib/env', () => ({ env: { SEND_ENABLED: true } }))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true }) }))
vi.mock('@/outreach/shutdown', () => ({ browserShutdownRequested: () => false }))
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))
vi.mock('@/outreach/browser/readThread', () => ({ openAndReadThread: (...a: unknown[]) => openAndReadThread(...a) }))
vi.mock('@/outreach/browser/inboxScan', () => ({ scanInbox: vi.fn() }))
vi.mock('@/outreach/challenge', () => ({ markChallenged: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    // No sender to scan an inbox for, so the inbox phase is a no-op and this is about the threads.
    senderAccount: { findMany: async () => [] },
    targetAccount: { findMany: async () => [] },
    outreachAttempt: {
      findMany: (...a: unknown[]) => findMany(...a),
      findFirst: async () => null,
      update: (...a: unknown[]) => update(...a),
      updateMany: async () => ({ count: 0 }),
    },
    auditLog: { create: vi.fn() },
    $transaction: async () => [],
  },
}))

const { checkForReplies, resetReplySweepMemory } = await import('@/outreach/replyCheck')

/** Two never-read conversations; the door-less one was written to more recently, so it ranks first. */
function row(pairId: string, target: string, sentAt: string) {
  return {
    id: `att_${pairId}`,
    pairId,
    replyCheckedAt: null,
    sentAt: new Date(sentAt),
    pair: { senderId: 'send_1', targetId: `targ_${pairId}`, sender: { handle: 'bollywoodchronicle' }, target: { handle: target } },
  }
}
const ROWS = [row('P', 'doorless', '2026-10-08T10:00:00Z'), row('Q', 'normal', '2026-10-08T09:00:00Z')]

let doorOpens = false
const readTargets = () => openAndReadThread.mock.calls.map((c) => c[1] as string)

beforeEach(() => {
  resetReplySweepMemory()
  doorOpens = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T06:00:00Z'))
  findMany.mockReset().mockImplementation(async (q: { where: Record<string, unknown> }) =>
    // `openConversations`: delivered, no reply, never or long ago checked.
    q.where.repliedAt === null && 'OR' in q.where ? ROWS : [],
  )
  update.mockReset().mockResolvedValue({})
  openAndReadThread.mockReset().mockImplementation(async (_sender: string, target: string) =>
    target === 'doorless' && !doorOpens
      ? { ok: false, reason: 'unreadable', detail: 'door refused', doorRefused: true }
      : { ok: true, messages: [], url: 'https://x' },
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a pair whose door refused rests a day, counted, then competes again', () => {
  it('is not read again inside the day, and is counted as deferred while it rests', async () => {
    const first = await checkForReplies()
    expect(readTargets()).toEqual(['doorless', 'normal'])
    expect(first.unreadable).toBe(1)

    openAndReadThread.mockClear()
    vi.setSystemTime(new Date('2026-10-09T06:30:00Z'))
    const second = await checkForReplies()
    // The refused pair does not take a budget slot; the healthy one is still read.
    expect(readTargets()).toEqual(['normal'])
    // Reported, never silent.
    expect(second.deferred).toBe(1)
  })

  it('is retried once the day has passed, and a successful read forgets the refusal', async () => {
    await checkForReplies()

    // A day and an hour later the cooldown has expired: retried, but behind pairs that never failed.
    openAndReadThread.mockClear()
    vi.setSystemTime(new Date('2026-10-10T07:00:00Z'))
    doorOpens = true
    const third = await checkForReplies()
    expect(readTargets()).toEqual(['normal', 'doorless'])
    expect(third.deferred).toBe(0)

    // That read succeeded, so the pair is back in its own priority order — first.
    openAndReadThread.mockClear()
    vi.setSystemTime(new Date('2026-10-10T07:30:00Z'))
    await checkForReplies()
    expect(readTargets()).toEqual(['doorless', 'normal'])
  })

  /** An ordinary unreadable read is not a door refusal and must not rest the pair. */
  it('an unreadable read WITHOUT doorRefused does not rest the pair', async () => {
    openAndReadThread.mockImplementation(async () => ({ ok: false, reason: 'unreadable', detail: 'layout changed' }))
    await checkForReplies()
    openAndReadThread.mockClear()
    const second = await checkForReplies()
    expect(readTargets()).toEqual(['doorless', 'normal'])
    expect(second.deferred).toBe(0)
  })
})
