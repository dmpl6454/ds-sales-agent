import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── THE SEND BUTTON CLAIMS INSIDE THE LOCK (Stage 1.3, audit M4) ─────────────────────────────
 *
 * `sendNow` flipped the draft READY→SENDING BEFORE it asked for the fleet lock and flipped it
 * back when the lock was refused. So "Another message is being sent right now" was a sentence
 * about a draft the very same call had just claimed and un-claimed — and on the hosted dashboard,
 * whose lock is ALWAYS refused (`SEND_ENABLED=false`), every click wrote SENDING and READY to the
 * database for nothing. The same transient claim is the only reason `parkOrphanedSending` needs a
 * twelve-second dwell to tell a live press from a corpse.
 *
 * Both callers claim inside the lock now. This drives the real `sendNow` (and through it the real
 * `deliverOne`) against an in-memory row whose status is only ever changed by the conditional
 * writes the code makes, and a lock stand-in that knows whether it is being HELD, so the
 * assertions are about state and time rather than about call counts:
 *
 *   - a refused lock leaves the row READY and never writes SENDING at all;
 *   - the claim, the allowance claim and the drive all happen WHILE the lock is held;
 *   - a throw while TAKING the lock answers with the database sentence and claims nothing;
 *   - a throw out of the drive propagates and leaves the row SENDING — the recipient may hold
 *     the message, so it is the orphan sweep's, never reverted here;
 *   - the gate's own sentence still wins over "another message is being sent", because the first
 *     refusal is asked before the lock.
 *
 * MUTATIONS, each applied by hand, seen red, restored:
 *   - in `sendNow`, calling `deliverOne` OUTSIDE `withSendLock` (awaiting it before the lock call)
 *     fails "the claim, the allowance and the drive all happen while the lock is held";
 *   - re-adding a `prisma.outreachAttempt.updateMany({ …status: 'SENDING' })` before the lock in
 *     `sendNow` fails "a refused lock leaves the draft READY and never writes SENDING";
 *   - deleting `sendNow`'s first-refusal `recheckBeforeSend` fails "the gate's own sentence wins";
 *   - turning the `if (mode.unattended) {` around the thread read in `deliverOne` into
 *     `if (true) {` (so the button reads too) fails three cases here and three in
 *     tests/recipient-unconfirmed-send-now.test.ts — the `ensureConversationChecked` stand-in below
 *     THROWS, because the Send button must not make that browser drive. 6 red across the two files.
 */

const state = vi.hoisted(() => ({
  row: { status: 'READY' as string },
  writes: [] as { status: unknown; holding: boolean }[],
  holding: false,
  lock: 'run' as 'run' | 'busy' | 'throw',
  heldAt: {} as Record<string, boolean>,
}))

const findUniqueOrThrow = vi.fn()
const attemptUpdate = vi.fn()
const settleClaims = vi.fn()
const revertUndrivenClaim = vi.fn()
const claimForAttempt = vi.fn()
const sendDm = vi.fn()
const recheck = vi.fn()
const recordSendStarted = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    outreachAttempt: {
      findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrow(...a),
      findUnique: async () => ({ status: state.row.status }),
      updateMany: async (a: { where: { status?: unknown }; data: { status?: string } }) => {
        const accepts = (w: unknown): boolean =>
          typeof w === 'string' ? w === state.row.status : Array.isArray((w as { in?: string[] })?.in) && (w as { in: string[] }).in.includes(state.row.status)
        state.writes.push({ status: a.data.status, holding: state.holding })
        if (a.where.status !== undefined && !accepts(a.where.status)) return { count: 0 }
        if (a.data.status === 'SENDING') state.heldAt.claim = state.holding
        if (a.data.status !== undefined) state.row.status = a.data.status
        return { count: 1 }
      },
      update: (...a: unknown[]) => attemptUpdate(...a),
    },
    senderAccount: { findUnique: async () => ({ status: 'ACTIVE' }) },
    auditLog: { create: async () => ({}) },
  },
}))
vi.mock('@/lib/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/settings')>()),
  getSettings: async () => ({ maxPerPairPerDay: 5, fleetMaxPerDay: null }),
}))
vi.mock('@/outreach/gate', async (orig) => ({
  ...(await orig<typeof import('@/outreach/gate')>()),
  recheckBeforeSend: (...a: unknown[]) => recheck(...a),
}))
vi.mock('@/outreach/reservations', async (orig) => ({
  ...(await orig<typeof import('@/outreach/reservations')>()),
  claimForAttempt: (...a: unknown[]) => {
    state.heldAt.allowance = state.holding
    return claimForAttempt(...a)
  },
  settleClaims: (...a: unknown[]) => settleClaims(...a),
}))
vi.mock('@/outreach/recordSend', async (orig) => ({
  ...(await orig<typeof import('@/outreach/recordSend')>()),
  revertUndrivenClaim: (...a: unknown[]) => revertUndrivenClaim(...a),
}))
vi.mock('@/outreach/dispatcher', async (orig) => ({
  ...(await orig<typeof import('@/outreach/dispatcher')>()),
  /** `busy` = refused (somebody else sending, or this machine may not); `throw` = taking it failed; `run` = held while `fn` runs. */
  withSendLock: async (_what: string, fn: () => Promise<unknown>) => {
    if (state.lock === 'busy') return null
    if (state.lock === 'throw') throw new Error("Can't reach database server")
    state.holding = true
    try {
      return await fn()
    } finally {
      state.holding = false
    }
  },
}))
vi.mock('@/outreach/challenge', async (orig) => ({ ...(await orig<typeof import('@/outreach/challenge')>()), markChallenged: async () => undefined }))
vi.mock('@/outreach/sessionHealth', async (orig) => ({
  ...(await orig<typeof import('@/outreach/sessionHealth')>()),
  markSessionInvalid: async () => undefined,
  clearSessionInvalid: async () => undefined,
}))
vi.mock('@/outreach/browser/sendDm', () => ({
  sendDm: (...a: unknown[]) => {
    state.heldAt.drive = state.holding
    state.heldAt.statusAtDrive = state.row.status === 'SENDING'
    return sendDm(...a)
  },
}))
vi.mock('@/outreach/paceClock', async (orig) => ({
  ...(await orig<typeof import('@/outreach/paceClock')>()),
  recordSendStarted: (...a: unknown[]) => recordSendStarted(...a),
}))
vi.mock('@/outreach/browser/profile', () => ({
  profileStatus: () => ({ dir: '/tmp/p', hasSession: true }),
  ensureProfileDir: () => '/tmp/p',
}))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/outreach/activeDevice', () => ({ thisMacRole: async () => ({ active: true, selected: 'this-mac', thisDevice: 'this-mac' }) }))
// THROWS, never answers `fresh`: the thread read is the dispatcher's alone (a real browser drive the
// Send button must not make), so a press that reaches it fails every test here.
vi.mock('@/outreach/replyCheck', () => ({
  ensureConversationChecked: async () => {
    throw new Error('the Send button must not read the conversation — that is a browser drive the refactor may not add')
  },
}))
vi.mock('@/detection/exists', () => ({ probeHandle: async () => ({ check: 'unknown', facts: null }) }))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))

const { sendNow } = await import('@/app/actions')

const BUSY = 'Another message is being sent right now. Nothing was sent — try again in a minute.'
const DB = 'Nothing was sent — the database did not answer before the send could start. The message is back in the queue; try again in a minute.'

beforeEach(() => {
  state.row.status = 'READY'
  state.writes.length = 0
  state.holding = false
  state.lock = 'run'
  state.heldAt = {}
  findUniqueOrThrow.mockReset().mockResolvedValue({
    id: 'att_1',
    pairId: 'pair_1',
    variantId: 'var_1',
    senderId: 'send_1',
    targetId: 'targ_a',
    touchNumber: 1,
    attempts: 0,
    renderedBody: 'Hi,the standard message body that is long enough to carry a needle',
    pair: { sender: { id: 'send_1', handle: 'bollywoodchronicle', status: 'ACTIVE' }, target: { id: 'targ_a', handle: 'tips' } },
  })
  attemptUpdate.mockReset().mockResolvedValue({})
  settleClaims.mockReset().mockResolvedValue(undefined)
  revertUndrivenClaim.mockReset().mockResolvedValue(true)
  claimForAttempt.mockReset().mockResolvedValue({ ok: true, held: [{ id: 'res_1', seq: 1 }] })
  sendDm.mockReset().mockResolvedValue({ ok: true, threadUrl: 'https://www.instagram.com/direct/t/1' })
  recheck.mockReset().mockResolvedValue({ ok: true })
  recordSendStarted.mockReset().mockResolvedValue(undefined)
})

describe('the Send button claims INSIDE the fleet lock', () => {
  it('a refused lock leaves the draft READY and never writes SENDING — and the sentence is a statement about the lock', async () => {
    state.lock = 'busy'
    const res = await sendNow('att_1')
    expect(res).toEqual({ ok: false, message: BUSY })
    expect(state.row.status).toBe('READY')
    expect(state.writes, 'a refused lock wrote to the row — a claim was made before it').toEqual([])
    expect(claimForAttempt).not.toHaveBeenCalled()
    expect(settleClaims).not.toHaveBeenCalled()
    expect(revertUndrivenClaim).not.toHaveBeenCalled()
    expect(sendDm).not.toHaveBeenCalled()
  })

  it('the claim, the allowance claim and the drive all happen while the lock is held', async () => {
    const res = await sendNow('att_1')
    expect(res).toEqual({ ok: true, message: 'Sent to @tips from @bollywoodchronicle.' })
    expect(state.heldAt.claim, 'READY→SENDING was written outside the lock').toBe(true)
    expect(state.heldAt.allowance, 'the allowance was claimed outside the lock').toBe(true)
    expect(state.heldAt.drive, 'the drive started outside the lock').toBe(true)
    expect(state.heldAt.statusAtDrive, 'the row was not SENDING when the browser opened').toBe(true)
    // Exactly one claim write, and it is the only status the button ever wrote before the outcome.
    expect(state.writes.map((w) => w.status)).toEqual(['SENDING'])
  })

  it('a throw while TAKING the lock answers with the database sentence and has nothing to give back', async () => {
    state.lock = 'throw'
    const res = await sendNow('att_1')
    expect(res).toEqual({ ok: false, message: DB })
    expect(state.row.status).toBe('READY')
    expect(state.writes).toEqual([])
    expect(revertUndrivenClaim).not.toHaveBeenCalled()
  })

  it('a throw out of the DRIVE propagates and leaves the row SENDING — the orphan sweep\'s, never reverted here', async () => {
    // `browserSender.send` turns a failure INSIDE the drive into a FAILED outcome; what escapes it
    // is a throw from its own preamble — here the pace clock's write — and that is exactly the
    // case the old `driveStarted` flag existed for: the drive began, so nothing may be reverted.
    recordSendStarted.mockRejectedValue(new Error("Can't reach database server"))
    await expect(sendNow('att_1')).rejects.toThrow()
    expect(state.row.status).toBe('SENDING')
    expect(revertUndrivenClaim).not.toHaveBeenCalled()
  })

  it("a database error between the claim and the drive puts the draft back, with the button's own sentence", async () => {
    claimForAttempt.mockRejectedValue(new Error("Can't reach database server"))
    const res = await sendNow('att_1')
    expect(res).toEqual({ ok: false, message: DB })
    expect(revertUndrivenClaim).toHaveBeenCalledOnce()
    expect(sendDm).not.toHaveBeenCalled()
  })
})

describe('the gate\'s own sentence wins over "another message is being sent"', () => {
  it('a draft the gate refuses is answered with the gate\'s words even when the lock is refused too', async () => {
    state.lock = 'busy'
    recheck.mockResolvedValue({ ok: false, reason: 'target-replied', detail: '@tips replied to @bollywoodchronicle' })
    const res = await sendNow('att_1')
    expect(res).toEqual({ ok: false, message: '@bollywoodchronicle: @tips replied to @bollywoodchronicle.' })
    expect(res.message).not.toBe(BUSY)
  })

  it('and a no-session refusal keeps the Connect hint', async () => {
    state.lock = 'busy'
    recheck.mockResolvedValue({ ok: false, reason: 'no-session', detail: 'account is not connected' })
    const res = await sendNow('att_1')
    expect(res.message).toBe(
      '@bollywoodchronicle: account is not connected. Press Connect on its row, and log in in the Chrome window that opens.',
    )
  })

  it('a gate refusal INSIDE the lock (the state moved after the first ask) is worded the same way', async () => {
    recheck.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'no-session', detail: 'account is not connected' })
    const res = await sendNow('att_1')
    expect(res.message).toBe(
      '@bollywoodchronicle: account is not connected. Press Connect on its row, and log in in the Chrome window that opens.',
    )
    expect(state.row.status).toBe('READY')
    expect(sendDm).not.toHaveBeenCalled()
  })
})
