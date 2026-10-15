import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * ── THE BOUND COUNTS DRIVES, AND SPACING FOLLOWS DRIVES (Stage 1.3, audit M2 + M3) ───────────
 *
 * `maxSendsPerTick` exists to bound browser activity against revenue accounts in one tick. Two
 * things were wrong with how the loop applied it, both measured by reading the loop:
 *
 *   M2  It counted `browserSender.send` ALONE. A pre-send thread read that returns `checked-now`,
 *       `unreadable` or `incomplete` is a REAL Chrome drive (deliver.ts said so in its own
 *       docblock), and it was not counted — so a tick whose stale follow-ups each needed a read
 *       drove one profile per draft. Three stale follow-ups, a bound of one: three Chrome windows.
 *   M3  The jitter between consecutive drives was gated on `out.sent > 0`, a message DELIVERED
 *       earlier in the tick. With `maxSendsPerTick` above 1 (a live Setting; one DB row) a FAILED
 *       first drive was followed back-to-back by the second with no spacing at all — two drives
 *       at Instagram, exactly when something was already going wrong.
 *
 * Driven through the real loop (`deliverWaiting`) and the real `deliverOne`, with only the
 * database, the gate, the sender, the thread read and the probe faked.
 *
 * MUTATIONS, each applied by hand, seen red, restored. The red below is what was OBSERVED, and the
 * case names are the ones vitest prints. How `deliverOne` reports each read decides which cases a
 * counting mutation can reach: `checked-now` and `reply-found` come back as `kind: 'held'`, and
 * `unreadable` comes back as `kind: 'failed'` (ladder `read-unreadable`).
 *   - `driven += r.drives` → `driven += r.kind === 'sent' || r.kind === 'failed' ? 1 : 0` (the
 *     send alone, with a failure counted as a drive) fails "three stale follow-ups, a bound of
 *     one" and "and so does a read that FOUND a reply" — the two reads that arrive as `held`,
 *     which this counts as zero. "an UNREADABLE read counts the same" stays GREEN under it: that
 *     read arrives as `failed`, which this mutation already counts as one. It is not evidence for
 *     that case, and the next mutation is the one that is;
 *   - `driven += r.drives` → `driven += r.kind === 'sent' ? 1 : 0` (delivered messages only — the
 *     very first version of the bound, which a run of failures defeated) fails "three stale
 *     follow-ups, a bound of one", "an UNREADABLE read counts the same", "and so does a read that
 *     FOUND a reply" and "a FAILED first drive is spaced from the second" — 4 red;
 *   - dropping `drives += 1` for a `checked-now` read in `deliverOne` fails "three stale
 *     follow-ups, a bound of one" here (the unreadable and reply-found cases stay green — they are
 *     counted by a different line) and, in tests/deliver-one-two-callers.test.ts, "a send alone is
 *     one drive; a read that opened Chrome plus a send is two", "a checked-now read opened a
 *     browser, so it counts" and the three unattended "LAST ask refuses" cases (each asserts
 *     `drives: 1` after a `checked-now` read) — 6 red across the two files;
 *   - `spaceBeforeDrive: driven > 0` → `spaceBeforeDrive: out.sent > 0` in `deliver.ts` fails
 *     "a FAILED first drive is spaced from the second" (the second send starts at once), and
 *     leaves "a first drive that delivered is spaced too" green — which is what shows the
 *     condition, not the sleep, was what changed;
 *   - deleting the sleep itself in `deliverOne` fails both of those two cases.
 */

const senderFindUnique = vi.fn()
const attemptFindMany = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const send = vi.fn()
const recheck = vi.fn()
const claimForAttempt = vi.fn()
const settleClaims = vi.fn()
const ensureConversationChecked = vi.fn()
const randomInt = vi.fn()

vi.mock('@/outreach/shutdown', () => ({ browserShutdownRequested: () => false }))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true, selected: 'this-mac', thisDevice: 'this-mac' }) }))
vi.mock('@/detection/exists', () => ({ probeHandle: async () => ({ check: 'unknown', facts: null }) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: (...a: unknown[]) => senderFindUnique(...a) },
    outreachAttempt: {
      findMany: (...a: unknown[]) => attemptFindMany(...a),
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    auditLog: { create: async () => ({}) },
  },
}))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ autopilotEnabled: true }) }))
vi.mock('@/lib/env', () => ({ env: { DRY_RUN: false, SEND_JITTER_MIN_SECONDS: 4, SEND_JITTER_MAX_SECONDS: 9 } }))
vi.mock('@/lib/time', () => ({ randomInt: (...a: unknown[]) => randomInt(...a) }))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: { send: (...a: unknown[]) => send(...a) } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))
vi.mock('@/outreach/gate', () => ({ recheckBeforeSend: (...a: unknown[]) => recheck(...a), isOverridable: () => false }))
vi.mock('@/outreach/recordSend', () => ({ recordDelivered: async () => undefined, revertUndrivenClaim: async () => true }))
vi.mock('@/outreach/reservations', () => ({
  claimForAttempt: (...a: unknown[]) => claimForAttempt(...a),
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: async () => undefined }))
vi.mock('@/outreach/sessionHealth', () => ({ markSessionInvalid: async () => undefined, clearSessionInvalid: async () => undefined }))
vi.mock('@/outreach/replyCheck', () => ({ ensureConversationChecked: (...a: unknown[]) => ensureConversationChecked(...a) }))

const { deliverWaiting } = await import('@/outreach/deliver')

/** N follow-ups, each to a different recipient from a different page, so nothing else ties them together. */
function followUps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `att_${i + 1}`,
    pairId: `pair_${i + 1}`,
    variantId: `var_${i + 1}`,
    senderId: `send_${i + 1}`,
    targetId: `targ_${i + 1}`,
    renderedBody: `body ${i + 1}`,
    touchNumber: 2,
    attempts: 0,
    pair: {
      sender: { id: `send_${i + 1}`, handle: `page${i + 1}`, status: 'ACTIVE' },
      target: { id: `targ_${i + 1}`, handle: `target_${i + 1}` },
    },
  }))
}

beforeEach(() => {
  senderFindUnique.mockReset().mockResolvedValue({ status: 'ACTIVE' })
  attemptFindMany.mockReset().mockResolvedValue(followUps(3))
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  attemptUpdate.mockReset().mockResolvedValue({})
  recheck.mockReset().mockResolvedValue({ ok: true })
  claimForAttempt.mockReset().mockResolvedValue({ ok: true, held: [{ id: 'res_1', seq: 1 }] })
  settleClaims.mockReset().mockResolvedValue(undefined)
  ensureConversationChecked.mockReset().mockResolvedValue({ ok: true, reason: 'fresh' })
  send.mockReset().mockResolvedValue({ status: 'SENT', threadUrl: 'https://x' })
  randomInt.mockReset().mockReturnValue(7)
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * The gate answers `ok` the first time it is asked about an attempt and refuses the second — which
 * is how a thread read that FOUND a reply looks from outside: the verdict before the read was
 * clear, and the re-gate after it (the read may have recorded something) says no. Every follow-up
 * therefore reads, drives a browser, and is then HELD without being sent.
 */
function gateRefusesAfterTheRead() {
  const seen = new Map<string, number>()
  recheck.mockImplementation(async (attempt: { id: string }) => {
    const n = (seen.get(attempt.id) ?? 0) + 1
    seen.set(attempt.id, n)
    return n === 1 ? { ok: true } : { ok: false, reason: 'target-replied', detail: 'they replied while we were reading' }
  })
}

describe('a pre-send thread read is a browser drive and counts against the bound', () => {
  it('three stale follow-ups, a bound of one: the thread is read ONCE, not three times', async () => {
    gateRefusesAfterTheRead()
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    const out = await deliverWaiting({ maxSends: 1 })
    expect(ensureConversationChecked).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    // The one read held its draft; the other two were never gated, claimed or read.
    expect(out.outcomes).toHaveLength(1)
    expect(out.skipped).toBe(1)
    expect(claimForAttempt).not.toHaveBeenCalled()
  })

  it('an UNREADABLE read counts the same — it opened Chrome and came back with nothing', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'unreadable', detail: 'the conversation could not be read' })
    const out = await deliverWaiting({ maxSends: 1 })
    expect(ensureConversationChecked).toHaveBeenCalledTimes(1)
    expect(out.failed).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('and so does a read that FOUND a reply', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'reply-found', detail: '@target_1 replied' })
    await deliverWaiting({ maxSends: 1 })
    expect(ensureConversationChecked).toHaveBeenCalledTimes(1)
  })

  it('a raised bound is still honoured: the bound is a bound, not a blanket stop', async () => {
    gateRefusesAfterTheRead()
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    await deliverWaiting({ maxSends: 3 })
    expect(ensureConversationChecked).toHaveBeenCalledTimes(3)
  })

  it('a read that never opened Chrome is free: `no-session` drives nothing, so every draft still gets its turn', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'no-session', detail: 'no session on disk' })
    const out = await deliverWaiting({ maxSends: 1 })
    expect(ensureConversationChecked).toHaveBeenCalledTimes(3)
    expect(out.skipped).toBe(3)
  })

  it('and holds that never reached a read do not spend the bound either', async () => {
    // The first two drafts are refused by the gate outright; only the third proceeds to read and send.
    const seen = new Set<string>()
    recheck.mockImplementation(async (attempt: { id: string }) => {
      if (attempt.id === 'att_3') return { ok: true }
      seen.add(attempt.id)
      return { ok: false, reason: 'target-replied', detail: 'held by the gate' }
    })
    const out = await deliverWaiting({ maxSends: 1 })
    expect(seen.size).toBe(2)
    expect(ensureConversationChecked).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(out.sent).toBe(1)
  })
})

describe('the jitter follows DRIVES, not deliveries', () => {
  /**
   * Fake timers so the sleep is a thing the test can see: the second drive must not START until
   * the clock has run for the seconds `randomInt` returned (7).
   */
  it('a FAILED first drive is spaced from the second', async () => {
    vi.useFakeTimers()
    send
      .mockResolvedValueOnce({ status: 'FAILED', error: 'paste did not land', failureCode: 'composer-mismatch' })
      .mockResolvedValue({ status: 'SENT', threadUrl: 'https://x' })
    const p = deliverWaiting({ maxSends: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(send, 'the first drive happens at once').toHaveBeenCalledTimes(1)
    expect(randomInt).toHaveBeenCalledWith(4, 9)
    await vi.advanceTimersByTimeAsync(6_999)
    expect(send, 'the second drive started before the spacing elapsed').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const out = await p
    expect(send).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ sent: 1, failed: 1 })
  })

  it('a first drive that delivered is spaced too — the condition changed, not the sleep', async () => {
    vi.useFakeTimers()
    const p = deliverWaiting({ maxSends: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a first draft that was only HELD is not a drive, so the next one is not made to wait', async () => {
    vi.useFakeTimers()
    // Two drafts only: with a third, the SECOND would be a drive and the third rightly made to wait.
    attemptFindMany.mockResolvedValue(followUps(2))
    recheck.mockImplementation(async (attempt: { id: string }) =>
      attempt.id === 'att_1' ? { ok: false, reason: 'target-replied', detail: 'held' } : { ok: true },
    )
    const p = deliverWaiting({ maxSends: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(send, 'a held draft drove nothing, so nothing is waited for').toHaveBeenCalledTimes(1)
    expect(randomInt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    await p
  })

  it('a read-then-send inside ONE attempt is not spaced from itself', async () => {
    vi.useFakeTimers()
    attemptFindMany.mockResolvedValue(followUps(1))
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    const p = deliverWaiting({ maxSends: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(randomInt).not.toHaveBeenCalled()
    await p
  })
})
