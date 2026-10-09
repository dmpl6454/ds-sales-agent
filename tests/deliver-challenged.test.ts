import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'

/**
 * ── defect (f): retrying into a checkpoint, inside one run ─────────────────
 *
 * `deliverWaiting` reads every waiting attempt in ONE query before its loop, so each
 * attempt carries a `sender` snapshot from that moment. Flagging an account writes
 * CHALLENGED to the database and leaves the snapshot untouched — so the loop kept
 * driving the Chrome profile of an account Instagram had just challenged, for every
 * remaining draft from that sender.
 *
 * At four accounts one sender rarely had two waiting drafts, which is why this was never
 * observed. ROTATION MAKES IT REACHABLE BY DESIGN: spreading one sender across many
 * targets is the entire point of the fleet.
 *
 * Two guards, covering different things, and both are asserted here:
 *   the in-run Set  — what THIS loop did
 *   the live read   — what anything else did (the dashboard, a CLI, a human)
 *
 * The negative direction is asserted too: a healthy account must still deliver every
 * waiting draft, or "safe" would just mean "sends nothing".
 */

const senderFindUnique = vi.fn()
const attemptFindMany = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const senderUpdate = vi.fn()
const auditCreate = vi.fn()
const transaction = vi.fn()
const send = vi.fn()
const recheck = vi.fn()
const claimForAttempt = vi.fn()
const settleClaims = vi.fn()
const markChallenged = vi.fn()
const ensureConversationChecked = vi.fn()
const revertUndrivenClaim = vi.fn()

const { probeHandle } = vi.hoisted(() => ({
  probeHandle: vi.fn(
    async (_handle: string): Promise<{ check: 'exists' | 'missing' | 'unknown'; facts: null }> => ({ check: 'unknown', facts: null }),
  ),
}))
// The pre-drive existence probe (9 Sept 2026) is a NETWORK call to Instagram; these tests are
// about the drive, so it answers 'unknown' — which changes nothing — unless a case overrides it.
// This Mac is the selected sending Mac in these fixtures (2026-09-10); the standby rule has tests/active-device.test.ts.
const shutdown = vi.hoisted(() => ({ requested: false }))
vi.mock('@/outreach/shutdown', () => ({ browserShutdownRequested: () => shutdown.requested }))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true, selected: 'this-mac', thisDevice: 'this-mac' }) }))
vi.mock('@/detection/exists', () => ({ probeHandle: (handle: string) => probeHandle(handle) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: (...a: unknown[]) => senderFindUnique(...a), update: (...a: unknown[]) => senderUpdate(...a) },
    outreachAttempt: {
      findMany: (...a: unknown[]) => attemptFindMany(...a),
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ autopilotEnabled: true }) }))
vi.mock('@/lib/env', () => ({
  env: { DRY_RUN: false, SEND_JITTER_MIN_SECONDS: 0, SEND_JITTER_MAX_SECONDS: 0 },
}))
vi.mock('@/lib/time', () => ({ randomInt: () => 0, istDateKey: () => '2026-08-04' }))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: { send: (...a: unknown[]) => send(...a) } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ dir: '/tmp/p', hasSession: true }) }))
vi.mock('@/outreach/gate', () => ({ recheckBeforeSend: (...a: unknown[]) => recheck(...a) }))
vi.mock('@/outreach/recordSend', () => ({
  recordDelivered: async () => undefined,
  revertUndrivenClaim: (...a: unknown[]) => revertUndrivenClaim(...a),
}))
vi.mock('@/outreach/reservations', () => ({
  claimForAttempt: (...a: unknown[]) => claimForAttempt(...a),
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: (...a: unknown[]) => markChallenged(...a) }))
// §3.5 wiring has its own suite (session-invalid.test.ts); mocked here so these tests stay
// about what they were written to assert.
vi.mock('@/outreach/sessionHealth', () => ({
  markSessionInvalid: async () => undefined,
  clearSessionInvalid: async () => undefined,
}))
vi.mock('@/outreach/replyCheck', () => ({
  ensureConversationChecked: (...a: unknown[]) => ensureConversationChecked(...a),
}))

const { deliverWaiting } = await import('@/outreach/deliver')

/**
 * Two waiting drafts from the SAME sender — the shape rotation produces constantly.
 *
 * `touchNumber: 1` by default so these exercise the delivery path itself. Follow-ups take
 * the extra Phase 6 branch (read the conversation first) and have their own tests below;
 * mixing the two here would mean every assertion in this file depended on a browser read
 * that most of them are not about.
 */
function twoDraftsFromOneSender(touchNumber = 1) {
  const sender = { id: 'send_1', handle: 'bollywoodsocietyy', status: 'ACTIVE', autoSendEnabled: true }
  return [
    {
      id: 'att_1',
      variantId: 'var_1',
      renderedBody: 'body one',
      senderId: 'send_1',
      targetId: 'targ_a',
      touchNumber,
      pair: { sender, target: { handle: 'target_a' } },
    },
    {
      id: 'att_2',
      variantId: 'var_2',
      renderedBody: 'body two',
      senderId: 'send_1',
      targetId: 'targ_b',
      touchNumber,
      pair: { sender, target: { handle: 'target_b' } },
    },
  ]
}

beforeEach(() => {
  // ONLY `status` — mirroring what `deliver.ts` selects. Carrying extra fields here would
  // mask a hold reintroduced on one of them, which is the regression below guards against.
  senderFindUnique.mockReset().mockResolvedValue({ status: 'ACTIVE' })
  attemptFindMany.mockReset().mockResolvedValue(twoDraftsFromOneSender())
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  attemptUpdate.mockReset().mockResolvedValue({})
  probeHandle.mockReset().mockResolvedValue({ check: 'unknown', facts: null })
  senderUpdate.mockReset().mockResolvedValue({})
  auditCreate.mockReset().mockResolvedValue({})
  transaction.mockReset().mockResolvedValue([])
  recheck.mockReset().mockResolvedValue({ ok: true })
  claimForAttempt.mockReset().mockResolvedValue({ ok: true, held: [{ id: 'res_1', seq: 1 }] })
  settleClaims.mockReset().mockResolvedValue(undefined)
  markChallenged.mockReset().mockResolvedValue(undefined)
  ensureConversationChecked.mockReset().mockResolvedValue({ ok: true, reason: 'fresh' })
  send.mockReset().mockResolvedValue({ status: 'SENT', threadUrl: 'https://x' })
  revertUndrivenClaim.mockReset().mockResolvedValue(true)
  shutdown.requested = false
})

/**
 * A SIGTERM landing while a tick evaluates must not let that tick START a drive: the shutdown
 * drain would then wait on it and kill it at its deadline, parking a never-confirmed message
 * as "may already have it" (review of 2026-10-09). The draft stays READY for the next process.
 */
describe('the agent stopping', () => {
  it('claims nothing and drives nothing once a shutdown is requested', async () => {
    shutdown.requested = true
    await deliverWaiting({ maxSends: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(attemptUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SENDING' } }))
    expect(claimForAttempt).not.toHaveBeenCalled()
  })

  it('still delivers when no shutdown is requested — the check must not become a blanket stop', async () => {
    await deliverWaiting({ maxSends: 2 })
    expect(send).toHaveBeenCalledTimes(2)
  })
})

/**
 * ── PHASE 6: read the conversation before writing into it again ────────────
 *
 * The gate consults `repliedAt`, which is only as good as the last time anyone looked, and
 * the scheduled sweep's capacity is a constant while conversations grow with the fleet. So
 * a follow-up reads its own thread first. These assert the WIRING — the decision itself is
 * tested in `reply-check.test.ts`, and a guard that is correct but never called is the
 * failure this project has found most often.
 */
describe('a follow-up reads its conversation before it is sent', () => {
  it('does NOT read anything for a first touch', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(1))
    await deliverWaiting()
    expect(ensureConversationChecked).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
  })

  it('reads the conversation for a follow-up, before driving the send', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    await deliverWaiting()
    expect(ensureConversationChecked).toHaveBeenCalledOnce()
    expect(ensureConversationChecked.mock.calls[0]![0]).toMatchObject({
      senderId: 'send_1',
      targetId: 'targ_a',
      touchNumber: 2,
    })
    expect(send).toHaveBeenCalledOnce()
  })

  it('HOLDS the send when the conversation cannot be read', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    ensureConversationChecked.mockResolvedValue({
      ok: false,
      reason: 'unreadable',
      detail: 'the conversation with @target_a could not be read',
    })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.sent).toBe(0)
    expect(out.outcomes[0]!.result).toContain('could not be read')
  })

  /**
   * ── AN UNREADABLE READ IS A BROWSER DRIVE, SO IT COUNTS (2026-09-01) ──────
   *
   * `unreadable`/`incomplete` mean a real Chrome profile was just driven and came back
   * without a usable read. Held in place, the draft kept its queue position and the next
   * tick drove the SAME profile again — MEASURED as @acearteofficial's deleted page and
   * @officialsleepwell's incomplete read, each re-driving a revenue account every ~2
   * minutes forever. So it takes the send-failure discipline: `attempts` incremented,
   * `queuedAt` bumped to the back, parked FAILED at the cap. Mirrors the `no-composer`
   * loop fix of 2026-08-18 on the READ path, where nothing had counted the drives.
   */
  it('increments attempts and bumps an unreadable follow-up to the back of the queue', async () => {
    attemptFindMany.mockResolvedValue([{ ...twoDraftsFromOneSender(2)[0]!, attempts: 0 }])
    ensureConversationChecked.mockResolvedValue({
      ok: false,
      reason: 'unreadable',
      detail: 'the conversation with @target_a could not be read (no-message-button)',
    })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.failed).toBe(1)
    const upd = attemptUpdate.mock.calls[0]![0] as { data: { status: string; attempts: unknown; queuedAt?: Date } }
    expect(upd.data.status).toBe('READY') // back of the queue, not parked yet
    expect(upd.data.attempts).toEqual({ increment: 1 })
    expect(upd.data.queuedAt).toBeInstanceOf(Date)
  })

  it('parks an unreadable follow-up once it has failed the delivery-attempt cap', async () => {
    // One below the cap already, so this read tips it over.
    attemptFindMany.mockResolvedValue([{ ...twoDraftsFromOneSender(2)[0]!, attempts: MAX_DELIVERY_ATTEMPTS - 1 }])
    ensureConversationChecked.mockResolvedValue({
      ok: false,
      reason: 'incomplete',
      detail: 'only part of the conversation with @target_a was visible',
    })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.failed).toBe(1)
    const upd = attemptUpdate.mock.calls[0]![0] as { data: { status: string; queuedAt?: Date } }
    expect(upd.data.status).toBe('FAILED')
    expect(upd.data.queuedAt, 'a parked row keeps its position').toBeUndefined()
  })

  it('a no-session read holds for free — no browser was driven, so nothing is counted', async () => {
    attemptFindMany.mockResolvedValue([{ ...twoDraftsFromOneSender(2)[0]!, attempts: 0 }])
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'no-session', detail: 'no session on disk' })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.failed).toBe(0)
    expect(attemptUpdate).not.toHaveBeenCalled() // a plain hold, not a counted failure
  })

  it('holds the send when a reply is discovered by that read', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    ensureConversationChecked.mockResolvedValue({
      ok: false,
      reason: 'reply-found',
      detail: '@target_a has replied — outreach to them is halted',
    })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.outcomes[0]!.result).toContain('has replied')
  })

  /**
   * Claimed AFTER the read, so a hold leaves nothing to unwind — no SENDING status stuck
   * on the row, and no unit of the recipient's daily allowance consumed by a message that
   * was never sent.
   */
  it('claims nothing when the read holds the send', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'unreadable', detail: 'nope' })
    await deliverWaiting()
    expect(claimForAttempt).not.toHaveBeenCalled()
    expect(attemptUpdateMany).not.toHaveBeenCalled()
  })

  /**
   * A checkpoint during the read halts the account for the rest of this tick, exactly as
   * one during a send does. Reading is lower risk than sending; it is the same account and
   * the same enforcement surface.
   */
  it('stops touching an account challenged during the read', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'checkpoint', detail: 'account halted' })
    const out = await deliverWaiting({ maxSends: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(out.outcomes[1]!.result).toContain('flagged by Instagram earlier in this run')
  })

  /**
   * The gate is re-asked when the thread was actually opened, because that read may have
   * RECORDED a reply and the earlier verdict predates it. Without this, the one code path
   * able to discover a reply mid-delivery would discover it and send anyway.
   */
  it('re-runs the gate after an actual read, not after a freshness shortcut', async () => {
    attemptFindMany.mockResolvedValue(twoDraftsFromOneSender(2))
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    await deliverWaiting()
    expect(recheck).toHaveBeenCalledTimes(2)

    recheck.mockClear()
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'fresh' })
    await deliverWaiting()
    expect(recheck).toHaveBeenCalledOnce()
  })
})

/**
 * ── THE PHASE 5 BOUND ──────────────────────────────────────────────────────
 *
 * `deliverWaiting` used to drain the whole queue. It is now bounded per call, and the
 * tests below that want BOTH drafts delivered pass `{ maxSends: 2 }` explicitly — which is
 * the honest way to keep asserting what they were written to assert, rather than quietly
 * letting the bound stand in for the guard.
 */
describe('deliverWaiting is bounded per call', () => {
  it('delivers ONE message by default, however many are waiting', async () => {
    const out = await deliverWaiting()
    expect(send).toHaveBeenCalledOnce()
    expect(out.sent).toBe(1)
  })

  it('leaves the rest untouched rather than dropping them', async () => {
    const out = await deliverWaiting()
    // The second draft is never gated, claimed or updated — it is simply not this tick's.
    expect(out.outcomes).toHaveLength(1)
    expect(claimForAttempt).toHaveBeenCalledOnce()
  })

  it('honours a raised bound', async () => {
    await deliverWaiting({ maxSends: 2 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  /**
   * The bound counts BROWSER DRIVES, not deliveries.
   *
   * The first version counted delivered messages, so a run of failures drove Instagram
   * once per waiting draft with the counter stuck at zero — an unbounded burst of activity
   * against these accounts, produced by the code meant to bound it. A failed send is
   * exactly as much Instagram activity as a successful one.
   */
  it('counts a FAILED send against the bound', async () => {
    send.mockResolvedValue({ status: 'FAILED', error: 'paste did not land', failureCode: 'composer-mismatch' })
    const out = await deliverWaiting()
    expect(send).toHaveBeenCalledOnce()
    expect(out.failed).toBe(1)
  })
})

describe('deliverWaiting stops touching an account Instagram flagged mid-run', () => {
  it('does not drive the browser a second time after a checkpoint', async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'Instagram checkpoint (challenge) — stopped, not retried',
      failureCode: 'enforcement',
      challenged: true,
    })

    // maxSends: 2 so the BOUND cannot be what stops the second send. Without this the
    // test would pass for the wrong reason and the challenge guard would go unexercised.
    const out = await deliverWaiting({ maxSends: 2 })

    // THE ASSERTION. One send, not two: the second draft from the same sender is held.
    expect(send).toHaveBeenCalledOnce()
    expect(out.failed).toBe(1)
    expect(out.skipped).toBe(1)
    expect(out.outcomes[1]!.result).toContain('flagged by Instagram earlier in this run')
  })

  it('halts the account through the one writer that also stamps challengedAt', async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'Instagram checkpoint (challenge) — stopped, not retried',
      failureCode: 'enforcement',
      challenged: true,
    })
    await deliverWaiting({ maxSends: 2 })

    /**
     * Asserted because the fleet circuit breaker reads `challengedAt`, and four code paths
     * set CHALLENGED. One of them writing the status directly would leave the timestamp
     * null, and the breaker would then read "nothing was flagged" and keep sending — a
     * silent failure in the permissive direction.
     */
    expect(markChallenged).toHaveBeenCalledOnce()
    expect(markChallenged.mock.calls[0]![0]).toMatchObject({
      senderId: 'send_1',
      handle: 'bollywoodsocietyy',
      actor: 'autopilot',
    })
  })

  /** The other direction. A healthy account must still deliver BOTH. */
  it('delivers every waiting draft when nothing is flagged', async () => {
    const out = await deliverWaiting({ maxSends: 2 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(out.sent).toBe(2)
    expect(out.skipped).toBe(0)
  })
})

describe('deliverWaiting re-reads the account status immediately before each send', () => {
  /**
   * The snapshot in `waiting` says ACTIVE. The database says otherwise — because the
   * dashboard, a CLI or a concurrent process changed it after the query. The snapshot
   * must not win.
   */
  it('holds when the live row says CHALLENGED even though the snapshot says ACTIVE', async () => {
    senderFindUnique.mockResolvedValue({ status: 'CHALLENGED' })
    const out = await deliverWaiting({ maxSends: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(out.skipped).toBe(2)
    expect(out.outcomes[0]!.result).toContain('challenged')
  })

  /** PAUSED too — the check is `!== 'ACTIVE'`, not a CHALLENGED comparison. */
  it('holds when the live row says PAUSED', async () => {
    senderFindUnique.mockResolvedValue({ status: 'PAUSED' })
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.outcomes[0]!.result).toContain('paused')
  })

  it('holds when the account was removed entirely', async () => {
    senderFindUnique.mockResolvedValue(null)
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(out.outcomes[0]!.result).toContain('no longer exists')
  })

  it('reads the status fresh for EVERY attempt, not once per run', async () => {
    await deliverWaiting({ maxSends: 2 })
    expect(senderFindUnique).toHaveBeenCalledTimes(2)
  })

  /**
   * ── AND IT RE-READS *ONLY* WHAT CAN CHANGE ────────────────────────────────
   *
   * ONE SWITCH, 2026-08-08. An `autoSendEnabled` hold used to live beside the status
   * check, and it was a PERMISSION decision taken outside `gate.ts`. Removing the switch
   * from the gate without removing this made the two disagree for one commit: the gate
   * can no longer return `auto-send-off`, so `/messages` rendered "Clear to send. Every
   * check passes" over a draft this loop then held forever — with a reason deleted from
   * `REMEDIES` and therefore on no screen anywhere. `autoSendEnabled: false` is the
   * schema default and what `addSender` writes, so that was the COMMON path.
   *
   * These two assert the invariant that makes the dashboard's sentence true, in both
   * directions, and they are what fails if a silent hold is reintroduced here.
   */
  it('attempts every draft the gate permitted, whatever else is on the account row', async () => {
    // The live row carries ONLY what the loop is entitled to re-read. Any extra field
    // this loop grew a hold on would be absent here and read as undefined — falsy —
    // so a reintroduced `if (!live.<field>)` hold fails this test rather than passing.
    senderFindUnique.mockResolvedValue({ status: 'ACTIVE' })
    const out = await deliverWaiting({ maxSends: 2 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(out.sent).toBe(2)
    expect(out.skipped).toBe(0)
  })

  it('holds a draft the gate refused, and reports the gate\'s own words', async () => {
    // The complement: when the gate says no, this loop must not send — so the test above
    // cannot be satisfied by a loop that ignores the gate entirely.
    recheck.mockResolvedValue({ ok: false, reason: 'no-session', detail: 'account is not connected' })
    const out = await deliverWaiting({ maxSends: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(out.skipped).toBe(2)
    expect(out.outcomes[0]!.result).toContain('account is not connected')
  })
})

describe('a not-in-thread failure is recorded as its own kind', () => {
  /**
   * The composer cleared and the message never appeared. Both a shadow-restriction
   * signal AND the one failure where the recipient may already have the message, so it
   * must never be stored as an ordinary failure string.
   */
  it('stores failureCode and counts the attempt', async () => {
    send.mockResolvedValue({
      status: 'FAILED',
      error: 'the composer cleared but the message never appeared in the thread',
      failureCode: 'not-in-thread',
    })
    await deliverWaiting()
    const data = (attemptUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.failureCode).toBe('not-in-thread')
    expect(data.attempts).toEqual({ increment: 1 })
  })

  /**
   * ── THE PHASE 5 CHANGE, AND THE REASON IT IS ITS OWN TEST ────────────────
   *
   * Every other failure returns to READY so it can be retried or sent by hand. This one
   * must NOT, and the difference is the whole point: READY is exactly what the delivery
   * loop picks up, so the previous behaviour re-sent the message to someone who probably
   * already had it, from an account that may be restricted.
   *
   * FAILED parks it where nothing automatic reads it — this loop queries `status: 'READY'`
   * and `evaluateResend` refuses anything else with `not-waiting`, which is not in
   * OVERRIDABLE_BLOCKS. A person resolves it after reading the thread.
   */
  it('parks a not-in-thread attempt in FAILED, NOT back in READY', async () => {
    send.mockResolvedValue({
      status: 'FAILED',
      error: 'the composer cleared but the message never appeared in the thread',
      failureCode: 'not-in-thread',
    })
    const out = await deliverWaiting()
    const data = (attemptUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.status).toBe('FAILED')
    expect(out.outcomes[0]!.result).toContain('needs a human to read the thread')
  })

  /** The other direction: an ordinary failure still comes back for a retry. */
  it('stores an ordinary failure under a different code and DOES return it to READY', async () => {
    send.mockResolvedValue({ status: 'FAILED', error: 'paste did not land', failureCode: 'composer-mismatch' })
    await deliverWaiting()
    const data = (attemptUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.failureCode).toBe('composer-mismatch')
    expect(data.status).toBe('READY')
  })

  /**
   * The reservation is KEPT on not-in-thread, and released on a failure that certainly
   * delivered nothing. Asserted here because `deliver.ts` is what passes the failure code
   * to `settleClaims`, and passing the wrong one would silently invert the asymmetry that
   * stops a second message following one that probably landed.
   */
  it('hands settleClaims the code it needs to keep the reservation', async () => {
    send.mockResolvedValue({
      status: 'FAILED',
      error: 'never appeared',
      failureCode: 'not-in-thread',
    })
    await deliverWaiting()
    expect(settleClaims.mock.calls[0]![1]).toMatchObject({ delivered: false, failureCode: 'not-in-thread' })
  })
})

/**
 * A RECIPIENT WHOSE PAGE IS GONE IS PARKED BEFORE ANY DRIVE (9 Sept 2026). @hemantpandeyji: a
 * verified prospect on 8 Sept whose page had vanished by the 9th — four senders each drove Chrome
 * at it three times before parking. One anonymous probe now asks first; `missing` parks with no
 * browser, `unknown` changes nothing.
 */
describe('a recipient whose page is gone is parked before any browser drive', () => {
  it("parks FAILED 'profile-gone', releases the claim, and never calls the sender", async () => {
    probeHandle.mockResolvedValue({ check: 'missing', facts: null })
    await deliverWaiting({ maxSends: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', failureCode: 'profile-gone' }) }),
    )
    expect(settleClaims).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delivered: false, failureCode: 'profile-gone' }))
  })
  it("an 'unknown' probe (a throttle, a blip) changes nothing — absence of an answer is not a verdict", async () => {
    await deliverWaiting({ maxSends: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

/**
 * AUDIT C1 (2026-10-09): the inbox route opened a conversation that could not be confirmed as
 * the recipient's. Nothing was typed. Parked on FIRST sight — the generic branch would put it
 * back in READY and the next tick would drive the same door, possibly opening a stranger's
 * conversation again — and the account is NOT halted: it is a question about the recipient.
 */
describe('a recipient the inbox route could not confirm is parked after one look', () => {
  it("parks FAILED 'recipient-unconfirmed' at the attempt cap, without halting the account", async () => {
    send.mockResolvedValueOnce({
      status: 'FAILED',
      error: 'the inbox route could not confirm who the opened conversation is with (@target_a)',
      failureCode: 'recipient-unconfirmed',
    })
    await deliverWaiting({ maxSends: 2 })
    const park = attemptUpdate.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === 'att_1',
    )?.[0] as { data: Record<string, unknown> } | undefined
    expect(park?.data).toMatchObject({
      status: 'FAILED',
      failureCode: 'recipient-unconfirmed',
      attempts: MAX_DELIVERY_ATTEMPTS,
    })
    // Not sent to the back of the queue as a retry would be — it is not retried at all.
    expect(park?.data).not.toHaveProperty('queuedAt')
    expect(markChallenged).not.toHaveBeenCalled()
    expect(settleClaims).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delivered: false, failureCode: 'recipient-unconfirmed' }),
    )
    // The loop moves on: the other recipient's draft is still delivered.
    expect(send).toHaveBeenCalledTimes(2)
  })
})

/**
 * ── A DATABASE ERROR BETWEEN THE CLAIM AND THE DRIVE (2026-10-09) ─────────────
 *
 * The claim flips the row to SENDING, then the reservations, the spacing and the anonymous probe
 * run before any browser opens. A throw in there used to escape the loop with the row still
 * SENDING, and the next tick's orphan sweep parked it `not-in-thread` — "may already have it" —
 * which nothing automatic releases. These assert the draft goes back instead, and that no
 * browser is driven on the way.
 */
describe('a database error after the claim puts the draft back, and drives nothing', () => {
  it('reverts when the reservation claim throws', async () => {
    claimForAttempt.mockRejectedValue(new Error("Can't reach database server"))
    const out = await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(revertUndrivenClaim).toHaveBeenCalledOnce()
    expect(revertUndrivenClaim.mock.calls[0]![0]).toBe('att_1')
    // Nothing had been reserved yet, so nothing is handed back to release.
    expect(revertUndrivenClaim.mock.calls[0]![1]).toEqual([])
    // The tick ends rather than claiming the second draft into the same failure.
    expect(claimForAttempt).toHaveBeenCalledOnce()
    expect(out.sent).toBe(0)
  })

  it('hands back the reservations already held when a later step throws', async () => {
    attemptUpdate.mockRejectedValue(new Error('connection terminated'))
    probeHandle.mockResolvedValue({ check: 'missing', facts: null })
    await deliverWaiting()
    expect(send).not.toHaveBeenCalled()
    expect(revertUndrivenClaim).toHaveBeenCalledOnce()
    expect(revertUndrivenClaim.mock.calls[0]![1]).toEqual([{ id: 'res_1', seq: 1 }])
  })
})
