import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prioritiseConversations, type ConversationCandidate } from '@/outreach/replyCheck'

/**
 * Phase 6 — the reply guard at fleet scale.
 *
 * The sweep's capacity is a CONSTANT (8 conversations a day) and the number of
 * conversations is not, so its coverage falls as the fleet grows — silently, because "no
 * reply recorded" looks identical whether we read the thread yesterday or never. Two
 * things answer that, and both are tested here: the order a limited budget is spent in,
 * and the just-in-time read that makes coverage of what MATTERS independent of scale.
 */

const at = (iso: string | null) => (iso === null ? null : new Date(iso))

function candidate(over: Partial<ConversationCandidate> = {}): ConversationCandidate {
  return {
    attemptId: 'att',
    pairId: 'pair',
    senderId: 'send',
    senderHandle: 'alpha',
    targetId: 'targ',
    targetHandle: 'target',
    replyCheckedAt: at('2026-08-01T00:00:00Z'),
    sentAt: at('2026-08-01T00:00:00Z'),
    hasWaitingDraft: false,
    ...over,
  }
}

describe('prioritiseConversations', () => {
  /**
   * THE POINT OF THE ORDERING.
   *
   * A cap forces a choice and the old one made it on fairness — oldest checked first.
   * Fairness is the wrong criterion for a safety guard: the conversation where a missed
   * reply does real damage is the one about to be written into again, because that is the
   * repeated unwanted contact Meta penalises, aimed at the person who engaged.
   */
  it('puts a pair with a draft waiting ahead of a staler one with nothing waiting', () => {
    const ordered = prioritiseConversations([
      candidate({ pairId: 'stale-idle', replyCheckedAt: at('2026-07-01T00:00:00Z') }),
      candidate({ pairId: 'fresh-waiting', replyCheckedAt: at('2026-08-04T00:00:00Z'), hasWaitingDraft: true }),
    ])
    expect(ordered[0]!.pairId).toBe('fresh-waiting')
  })

  it('puts a never-checked conversation ahead of any checked one', () => {
    const ordered = prioritiseConversations([
      candidate({ pairId: 'checked', replyCheckedAt: at('2026-07-01T00:00:00Z') }),
      candidate({ pairId: 'never', replyCheckedAt: null }),
    ])
    expect(ordered[0]!.pairId).toBe('never')
  })

  it('but a waiting draft still outranks a never-checked idle conversation', () => {
    const ordered = prioritiseConversations([
      candidate({ pairId: 'never-idle', replyCheckedAt: null }),
      candidate({ pairId: 'waiting', replyCheckedAt: at('2026-08-04T00:00:00Z'), hasWaitingDraft: true }),
    ])
    expect(ordered[0]!.pairId).toBe('waiting')
  })

  it('orders stalest-first within the same band', () => {
    const ordered = prioritiseConversations([
      candidate({ pairId: 'b', replyCheckedAt: at('2026-08-03T00:00:00Z') }),
      candidate({ pairId: 'a', replyCheckedAt: at('2026-07-20T00:00:00Z') }),
      candidate({ pairId: 'c', replyCheckedAt: at('2026-08-04T00:00:00Z') }),
    ])
    expect(ordered.map((c) => c.pairId)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a tie on the most recent send — where a reply is likeliest', () => {
    const same = '2026-08-01T00:00:00Z'
    const ordered = prioritiseConversations([
      candidate({ pairId: 'old-send', replyCheckedAt: at(same), sentAt: at('2026-07-02T00:00:00Z') }),
      candidate({ pairId: 'new-send', replyCheckedAt: at(same), sentAt: at('2026-08-01T00:00:00Z') }),
    ])
    expect(ordered[0]!.pairId).toBe('new-send')
  })

  it('does not mutate its input', () => {
    const input = [candidate({ pairId: 'a' }), candidate({ pairId: 'b', hasWaitingDraft: true })]
    const copy = input.map((c) => c.pairId)
    prioritiseConversations(input)
    expect(input.map((c) => c.pairId)).toEqual(copy)
  })

  it('handles an empty list', () => {
    expect(prioritiseConversations([])).toEqual([])
  })
})

// ── the just-in-time check ──────────────────────────────────────────────────

const findFirst = vi.fn()
const findMany = vi.fn()
const hasSession = vi.fn()
const openAndReadThread = vi.fn()
const markChallenged = vi.fn()
const attemptUpdate = vi.fn()
const transaction = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    outreachAttempt: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    auditLog: { create: vi.fn() },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: (...a: unknown[]) => hasSession(...a) }))
vi.mock('@/outreach/browser/readThread', () => ({
  openAndReadThread: (...a: unknown[]) => openAndReadThread(...a),
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: (...a: unknown[]) => markChallenged(...a) }))

const { ensureConversationChecked } = await import('@/outreach/replyCheck')

const NOW = new Date('2026-08-05T12:00:00Z')

const args = {
  senderId: 'send_1',
  senderHandle: 'alpha',
  targetId: 'targ_1',
  targetHandle: 'viralbhayani',
  attemptId: 'att_1',
  touchNumber: 2,
  now: NOW,
}

beforeEach(() => {
  findFirst.mockReset().mockResolvedValue(null)
  findMany.mockReset().mockResolvedValue([])
  attemptUpdate.mockReset().mockResolvedValue({})
  transaction.mockReset().mockResolvedValue([])
  markChallenged.mockReset().mockResolvedValue(undefined)
  hasSession.mockReset().mockReturnValue({ dir: '/tmp/p', hasSession: true })
  openAndReadThread.mockReset().mockResolvedValue({ ok: true, messages: [], url: 'https://x' })
})

describe('ensureConversationChecked — the guarantee the sweep cannot give', () => {
  /**
   * A first touch has NO conversation to read. `openAndReadThread` on a profile that has
   * never been messaged finds no thread, which is indistinguishable from an unreadable
   * one — so without this exemption a fail-closed guard would refuse every first touch
   * forever, and the reply guard has nothing to say about someone never contacted.
   */
  it('exempts a first touch WITHOUT opening a browser', async () => {
    const r = await ensureConversationChecked({ ...args, touchNumber: 1 })
    expect(r).toEqual({ ok: true, reason: 'fresh' })
    expect(openAndReadThread).not.toHaveBeenCalled()
  })

  it('skips the read when this thread was checked recently', async () => {
    findFirst.mockResolvedValue({ replyCheckedAt: new Date('2026-08-05T06:00:00Z') }) // 6h ago
    const r = await ensureConversationChecked(args)
    expect(r).toEqual({ ok: true, reason: 'fresh' })
    expect(openAndReadThread).not.toHaveBeenCalled()
  })

  it('DOES read when the last check is older than the freshness window', async () => {
    findFirst.mockResolvedValue({ replyCheckedAt: new Date('2026-08-03T12:00:00Z') }) // 48h ago
    const r = await ensureConversationChecked(args)
    expect(openAndReadThread).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: true, reason: 'checked-now' })
  })

  it('reads when the thread has never been checked at all', async () => {
    findFirst.mockResolvedValue(null)
    await ensureConversationChecked(args)
    expect(openAndReadThread).toHaveBeenCalledOnce()
  })

  /**
   * FRESHNESS IS PER PAIR, NOT PER TARGET.
   *
   * Instagram DMs are per account pair, so a check made through another sender read a
   * different thread entirely and cannot vouch for this one. Asserted on the QUERY because
   * that is where the mistake would live — a `where` scoped to the target alone would make
   * every sender inherit every other sender's check and look completely correct.
   */
  it('measures freshness on this sender AND this target', async () => {
    await ensureConversationChecked(args)
    const where = (findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.senderId).toBe('send_1')
    expect(where.targetId).toBe('targ_1')
  })

  it('HOLDS the send when the thread cannot be read', async () => {
    openAndReadThread.mockResolvedValue({ ok: false, reason: 'unreadable' })
    const r = await ensureConversationChecked(args)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('unreadable')
  })

  /** And it must NOT have stamped a check for a thread it could not read. */
  it('does not record a check after an unreadable thread', async () => {
    openAndReadThread.mockResolvedValue({ ok: false, reason: 'unreadable' })
    await ensureConversationChecked(args)
    expect(attemptUpdate).not.toHaveBeenCalled()
  })

  it('HOLDS the send and halts the account on a checkpoint', async () => {
    openAndReadThread.mockRejectedValue(new Error('checkpoint detected at /challenge'))
    const r = await ensureConversationChecked(args)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('checkpoint')
    expect(markChallenged).toHaveBeenCalledOnce()
  })

  it('HOLDS the send when a reply is found, and records it', async () => {
    openAndReadThread.mockResolvedValue({
      ok: true,
      messages: [{ text: 'sure, send over the deck', ours: false }],
      url: 'https://x',
    })
    const r = await ensureConversationChecked(args)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('reply-found')
    expect(transaction).toHaveBeenCalledOnce()
  })

  it('permits when the thread is readable and silent', async () => {
    openAndReadThread.mockResolvedValue({
      ok: true,
      messages: [{ text: 'our pitch', ours: true }],
      url: 'https://x',
    })
    const r = await ensureConversationChecked(args)
    expect(r).toEqual({ ok: true, reason: 'checked-now' })
  })

  /**
   * Not connected means the thread cannot be read, so it is a HOLD — not a pass.
   *
   * The permissive reading ("we cannot check, so carry on") is the exact failure this
   * whole module exists to prevent, and it is the one an omission would produce.
   */
  it('holds when the account has no session to read with', async () => {
    hasSession.mockReturnValue({ dir: '/tmp/p', hasSession: false })
    const r = await ensureConversationChecked(args)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('no-session')
    expect(openAndReadThread).not.toHaveBeenCalled()
  })
})
