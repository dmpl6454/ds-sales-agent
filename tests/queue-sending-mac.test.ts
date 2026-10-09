import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * THE HOSTED QUEUE, AS THE SENDING MAC WILL WORK IT — audit H8, the real `buildMessagesPage`.
 *
 * The Linode runs with `AUTOPILOT_ENABLED=false` and `SEND_ENABLED=false` by design and holds no
 * Chrome profiles. Its queue used to read the env-floored `settings.autopilotEnabled` (so it said
 * "Autopilot is off" under a card saying ON), asked the gate about THIS disk (so the head row could
 * only say "account is not connected"), and gave ETAs to drafts whose account the sending Mac does
 * not hold — drafts that Mac's dispatcher skips before the gate on every tick (deliver.ts).
 *
 * The fixture is the documented 10 September shape: the Studio is selected and beating and holds
 * ONE account ('a'); the OLDER draft is from an account it does not hold ('b'). So the dispatcher's
 * own order would put 'b' first and skip it — and the queue must say exactly that.
 *
 * The memo is off under VITEST (viewMemo.ts), so each call computes. `@/lib/env` is mocked to the
 * Linode's floor because a developer `.env` may carry AUTOPILOT_ENABLED=true, which would make the
 * "no autopilot flag is read" assertion pass for the wrong reason.
 */

const NOW = Date.now()
const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  presence: [] as { device: string; at: string; handles: string[] }[],
}))

vi.mock('@/lib/env', async (orig) => {
  const m = (await orig()) as { env: Record<string, unknown> }
  return { ...m, env: { ...m.env, AUTOPILOT_ENABLED: false, SEND_ENABLED: false } }
})

/** Two READY drafts in the dispatcher's own order: 'b' queued first, 'a' second. */
const draft = (id: string, sender: string, target: string, minutesAgo: number) => ({
  id,
  status: 'READY',
  queuedAt: new Date(NOW - minutesAgo * 60_000),
  senderId: `s_${sender}`,
  targetId: `t_${target}`,
  pair: {
    id: `p_${sender}_${target}`,
    senderId: `s_${sender}`,
    targetId: `t_${target}`,
    sender: { id: `s_${sender}`, handle: sender, cohort: 1, status: 'ACTIVE' },
    target: { id: `t_${target}`, handle: target, displayName: target, optedOut: false },
  },
})

vi.mock('@/lib/db', () => {
  const empty = { findMany: async () => [], count: async () => 0, groupBy: async () => [], findFirst: async () => null }
  const prisma = new Proxy(
    {
      setting: {
        findMany: async () => [...state.settings].map(([key, value]) => ({ key, value })),
        findUnique: async () => null,
      },
      outreachAttempt: {
        ...empty,
        findMany: async (args: { where?: { status?: unknown } }) =>
          args?.where?.status === 'READY' ? [draft('d_b', 'b', 'tb', 30), draft('d_a', 'a', 'ta', 10)] : [],
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? empty },
  )
  return { prisma }
})

vi.mock('@/app/view-model/presence', () => ({ readPresenceForView: async () => state.presence }))
vi.mock('@/outreach/dispatcher', () => ({
  dispatchStatus: async () => ({
    state: null,
    breaker: { tripped: false },
    usage: { thisHour: 0, today: 0 },
    limits: { perHour: Infinity, perDay: Infinity, minGapMinutes: 1, perTick: 1 },
    waiting: 2,
  }),
  readPause: async () => null,
}))
vi.mock('@/outreach/replyCheck', () => ({ replyCoverage: async () => ({ open: 0, neverRead: 0, stale: 0 }) }))
vi.mock('@/outreach/brandTouchCounts', () => ({ readNewBrandTouchCounts: async () => ({ waiting: 0, delivered: 0 }) }))
vi.mock('@/outreach/availability', () => ({ eligibleFleetSenders: async () => [] }))
vi.mock('@/app/view-model/provenance-posts', () => ({ loadProvenancePosts: async () => new Map() }))
vi.mock('@/outreach/gate', async (orig) => ({
  ...((await orig()) as object),
  predictResendForQueue: vi.fn(async () => ({ ok: true })),
  recheckBeforeSend: vi.fn(async () => ({ ok: false, reason: 'no-session', detail: 'account is not connected' })),
}))

const gate = await import('@/outreach/gate')
const { buildMessagesPage } = await import('@/app/view-model/messages-page')
const { getSettings } = await import('@/lib/settings')

beforeEach(() => {
  vi.mocked(gate.predictResendForQueue).mockClear()
  vi.mocked(gate.recheckBeforeSend).mockClear()
  state.settings = new Map([
    ['autopilotEnabled', 'true'],
    ['activeDevice', 'Studio'],
  ])
  state.presence = [{ device: 'Studio', at: new Date(NOW).toISOString(), handles: ['a'] }]
})

describe('the hosted queue reads the sending Mac, not this host', () => {
  it('PRECONDITION: this host is floored — the enforcement value is false while the fleet switch is ON', async () => {
    const s = await getSettings()
    expect(s.autopilotEnabled, 'without the floor the rest of this file proves nothing').toBe(false)
    expect(s.autopilotFleetWide).toBe(true)
  })

  it('the head row is the draft the sending Mac can drive, cleared by ITS witness, with a countdown', async () => {
    const m = await buildMessagesPage()
    expect(m.upNext.map((r) => r.senderHandle)).toEqual(['a'])
    expect(m.upNext[0]!.clear).toBe(true)
    expect(m.upNext[0]!.note).toBeNull()
    expect(typeof m.upNext[0]!.etaMinutes).toBe('number')

    expect(gate.predictResendForQueue).toHaveBeenCalledTimes(1)
    const [attempt, witness] = vi.mocked(gate.predictResendForQueue).mock.calls[0]!
    expect((attempt as { id: string }).id).toBe('d_a')
    expect(witness).toEqual({ device: 'Studio', handles: ['a'] })
    expect(gate.recheckBeforeSend, 'this disk must never answer for the hosted queue').not.toHaveBeenCalled()
  })

  it('the draft from an account the sending Mac does not hold is RESTING, named, with no clock', async () => {
    const m = await buildMessagesPage()
    const b = m.heldUpNext.find((r) => r.senderHandle === 'b')
    expect(b, 'the dispatcher skips @b before the gate on every tick — the queue must say so').toBeDefined()
    expect(b!.why).toContain('Studio')
    expect(b!.why).toMatch(/not signed in/)
    expect(b!.resumesAt).toBeNull()
    expect(m.heldWaiting).toBe(1)
  })

  it('carries no autopilot flag at all — whether it moves is the screen’s QueueMotion', async () => {
    const m = await buildMessagesPage()
    expect(Object.keys(m)).not.toContain('autopilotOn')
  })

  it('with no sending Mac chosen there is no verdict to predict, and nothing is held for it', async () => {
    state.settings.delete('activeDevice')
    const m = await buildMessagesPage()
    expect(gate.predictResendForQueue).not.toHaveBeenCalled()
    expect(gate.recheckBeforeSend).not.toHaveBeenCalled()
    expect(m.upNext[0]!.note).toBeNull()
    expect(m.upNext[0]!.clear).toBe(false)
    /* The dispatcher's own order, untouched: with no Mac there is no disk to partition by. */
    expect(m.upNext.map((r) => r.senderHandle)).toEqual(['b', 'a'])
  })

  it('a chosen Mac that is not beating is the same: no verdict, no partition', async () => {
    state.presence = []
    const m = await buildMessagesPage()
    expect(gate.predictResendForQueue).not.toHaveBeenCalled()
    expect(m.upNext.map((r) => r.senderHandle)).toEqual(['b', 'a'])
    expect(m.upNext[0]!.clear).toBe(false)
  })
})
