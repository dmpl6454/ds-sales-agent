import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'

/**
 * ── ONE DELIVERY FUNCTION, TWO CALLERS (Stage 1.3) ───────────────────────────────────────────
 *
 * `deliverWaiting` (the dispatcher's loop) and `sendNow` (the dashboard's Send button) each used
 * to carry their own "claim, drive, file the outcome", and the copies had drifted: the button
 * claimed before the lock and never asked the anonymous probe. They call `deliverOne` now, and the
 * only thing allowed to differ is `mode`.
 *
 * This file drives `deliverOne` ITSELF in both modes against the same recorded fakes and asserts
 * the things the refactor exists to guarantee:
 *
 *   1. THE SAME GUARDS IN THE SAME ORDER. Every fake writes its name into one ordered tape, and
 *      the two tapes are pinned LITERALLY. They differ by exactly four things, all documented in
 *      the header of `deliverOne.ts`: the autopilot-switch asks (a person substitutes for the
 *      switch), the Send button's start-of-drive audit row, and the dispatcher's thread read with
 *      the gate it re-runs afterwards (the button opens NO browser to read — a drive HEAD's button
 *      never made). A guard added to one mode and not the other, or moved relative to the claim,
 *      fails here.
 *   2. THE SEND BUTTON NEVER READS THE CONVERSATION, even when a read would have held it.
 *   3. EVERY ASK IS A RESULT, NOT A CEREMONY. The switch, the shutdown flag and the sending Mac are
 *      each asked early (before the read) and last (immediately before the claim). Each is driven
 *      to refuse at each of its two points, in both modes where it applies, and the call must stop
 *      with nothing claimed, probed or sent. The first version of this file only drove shutdown,
 *      and only before the run, so the early ask shadowed the late one and a late ask that was
 *      CALLED but whose answer was ignored stayed green in every test.
 *   4. A DRAFT THAT MOVED WHILE THE READ RAN IS NOT WRITTEN BACK. The unreadable-read ladder is a
 *      conditional write; a draft discarded during the minute-long read stays discarded.
 *   5. EVERYTHING MODE-DEPENDENT COMES FROM `mode` ALONE: the allowance claim's `attended` flag,
 *      the statuses the claim accepts, `sentBy`, the audit rows' actor and action, the failure
 *      ladder's cap and queue move. Each is asserted per mode, in both directions.
 *
 * The collaborators are faked at their module boundaries (the sender, the probe, the thread
 * read, the gate, the reservations) so what is under test is deliverOne's ORDER and ARGUMENTS —
 * the real gate and the real reservations have their own suites.
 *
 * MUTATIONS, each applied by hand to `src/outreach/deliverOne.ts`, seen red, restored (the red is
 * what was OBSERVED, case names as vitest prints them):
 *   - deleting the early `thisMacRole()` ask before `ensureConversationChecked` fails both tape
 *     cases (the tape loses a `role`), the dispatcher's "EARLY ask refuses" case for the sending
 *     Mac, and both "LAST ask refuses" cases for it (the Nth-ask bookkeeping shifts) — 5 red;
 *   - "ask kept, result ignored": keeping each of the six asks' calls and turning its
 *     `return stop(...)` into `void stop(...)` fails exactly that ask's cases in "a permission
 *     withdrawn mid-call stops the call" and nothing else: the early switch ask fails only the
 *     unattended EARLY case, the late switch ask only the unattended LAST case, and each of the
 *     shutdown flag and the sending Mac fails its two EARLY cases or its two LAST cases
 *     (unattended and attended) — 1 or 2 red apiece;
 *   - turning the guard around the thread read into `if (true)` (so the button reads too) fails
 *     the attended tape, both "the Send button never reads the conversation" cases and both
 *     attended "LAST ask refuses" cases — 5 red;
 *   - passing `attended: true` for the unattended caller fails "the allowance claim skips the
 *     hour bucket for the button only";
 *   - making the retryable ladder park for both modes, or park for the button instead of the
 *     dispatcher, fails the one case "the Send button's retryable failure stays READY even at the
 *     cap; the dispatcher's parks" — that case holds both halves;
 *   - changing the claim's `status: mode.unattended ? 'READY' : { in: [...] }` to READY for both
 *     fails "the claim accepts a QUEUED draft from the Send button only";
 *   - turning the unreadable-read ladder's `updateMany` back into a plain `update` by id fails
 *     "a draft discarded while the read ran is not written back to READY…" and its control here,
 *     and the two unreadable cases in tests/deliver-challenged.test.ts that pin the write's shape.
 */

const tape: string[] = []
const note = (s: string) => {
  tape.push(s)
}

const senderFindUnique = vi.fn()
const attemptUpdateMany = vi.fn()
const attemptUpdate = vi.fn()
const attemptFindUnique = vi.fn()
const auditCreate = vi.fn()
const send = vi.fn()
const recheck = vi.fn()
const claimForAttempt = vi.fn()
const settleClaims = vi.fn()
const recordDelivered = vi.fn()
const markChallenged = vi.fn()
const markSessionInvalid = vi.fn()
const clearSessionInvalid = vi.fn()
const ensureConversationChecked = vi.fn()
const revertUndrivenClaim = vi.fn()
const randomInt = vi.fn()
const getSettingsFn = vi.fn()
const probeHandle = vi.fn()
/**
 * What each of the three permissions answers, as a SEQUENCE — the Nth ask gets the Nth answer and
 * the last answer repeats. A permission withdrawn mid-call is exactly "yes at the first ask, no at
 * the second", which a flag set before the run cannot say. `asked` counts the asks so a test can
 * tell an EARLY refusal (one ask made) from a LATE one (two).
 */
const ctl = vi.hoisted(() => ({
  /** answers to `browserShutdownRequested()`; true = the agent was told to stop */
  shutdown: [false] as boolean[],
  /** answers to `thisMacRole().active`; false = another Mac is the sending Mac */
  roleActive: [true] as boolean[],
  /** answers to `(await getSettings()).autopilotEnabled`; false = the switch was flipped off */
  autopilot: [true] as boolean[],
  asked: { shutdown: 0, role: 0, autopilot: 0 },
}))
const nth = (seq: readonly boolean[], n: number) => seq[Math.min(n, seq.length - 1)]!

vi.mock('@/outreach/shutdown', () => ({
  browserShutdownRequested: () => {
    note('shutdown')
    return nth(ctl.shutdown, ctl.asked.shutdown++)
  },
}))
vi.mock('@/outreach/activeDevice', () => ({
  thisMacRole: async () => {
    note('role')
    return nth(ctl.roleActive, ctl.asked.role++)
      ? { active: true, selected: 'this-mac', thisDevice: 'this-mac' }
      : {
          active: false,
          selected: 'other-mac',
          thisDevice: 'this-mac',
          reason: 'another-mac',
          detail: 'other-mac is the selected sending Mac — this Mac holds everything',
        }
  },
}))
vi.mock('@/detection/exists', () => ({ probeHandle: (h: string) => probeHandle(h) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: (...a: unknown[]) => senderFindUnique(...a) },
    outreachAttempt: {
      updateMany: (...a: unknown[]) => attemptUpdateMany(...a),
      update: (...a: unknown[]) => attemptUpdate(...a),
      findUnique: (...a: unknown[]) => attemptFindUnique(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/settings', () => ({ getSettings: (...a: unknown[]) => getSettingsFn(...a) }))
vi.mock('@/lib/env', () => ({ env: { DRY_RUN: false, SEND_JITTER_MIN_SECONDS: 1, SEND_JITTER_MAX_SECONDS: 2 } }))
vi.mock('@/lib/time', () => ({ randomInt: (...a: unknown[]) => randomInt(...a) }))
vi.mock('@/outreach/senders/browser', () => ({
  browserSender: {
    send: (...a: unknown[]) => {
      note('send')
      return send(...a)
    },
  },
}))
vi.mock('@/outreach/browser/profile', () => ({
  profileStatus: () => {
    note('profile')
    return { dir: '/tmp/p', hasSession: true }
  },
}))
// `isOverridable` is the real whitelist's shape: only the reply halt may be crossed.
vi.mock('@/outreach/gate', () => ({
  recheckBeforeSend: (...a: unknown[]) => {
    note('gate')
    return recheck(...a)
  },
  isOverridable: (reason: string) => reason === 'target-replied',
}))
vi.mock('@/outreach/recordSend', () => ({
  recordDelivered: (...a: unknown[]) => {
    note('record')
    return recordDelivered(...a)
  },
  revertUndrivenClaim: (...a: unknown[]) => revertUndrivenClaim(...a),
}))
vi.mock('@/outreach/reservations', () => ({
  claimForAttempt: (...a: unknown[]) => {
    note('allowance')
    return claimForAttempt(...a)
  },
  settleClaims: (...a: unknown[]) => {
    note('settle')
    return settleClaims(...a)
  },
}))
vi.mock('@/outreach/challenge', () => ({ markChallenged: (...a: unknown[]) => markChallenged(...a) }))
vi.mock('@/outreach/sessionHealth', () => ({
  markSessionInvalid: (...a: unknown[]) => markSessionInvalid(...a),
  clearSessionInvalid: (...a: unknown[]) => clearSessionInvalid(...a),
}))
vi.mock('@/outreach/replyCheck', () => ({
  ensureConversationChecked: (...a: unknown[]) => {
    note('read')
    return ensureConversationChecked(...a)
  },
}))

const { deliverOne } = await import('@/outreach/deliverOne')
type Mode = Parameters<typeof deliverOne>[0]['mode']

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: 'att_1',
    pairId: 'pair_1',
    variantId: 'var_1',
    senderId: 'send_1',
    targetId: 'targ_a',
    renderedBody: 'body one',
    touchNumber: 2,
    attempts: 0,
    pair: {
      sender: { id: 'send_1', handle: 'bollywoodsocietyy', status: 'ACTIVE' },
      target: { id: 'targ_a', handle: 'target_a' },
    },
    ...over,
  } as never
}

const UNATTENDED: Mode = { unattended: true }
const ATTENDED: Mode = { unattended: false, operator: 'tester@dashmani.com' }

async function run(mode: Mode, over: { attempt?: Record<string, unknown>; spaceBeforeDrive?: boolean } = {}) {
  return deliverOne({
    attempt: attemptRow(over.attempt),
    settings: { maxPerPairPerDay: 5, fleetMaxPerHour: 3, fleetMaxPerDay: 9, autopilotEnabled: true } as never,
    mode,
    challengedThisRun: new Set<string>(),
    spaceBeforeDrive: over.spaceBeforeDrive,
  })
}

beforeEach(() => {
  tape.length = 0
  ctl.shutdown = [false]
  ctl.roleActive = [true]
  ctl.autopilot = [true]
  ctl.asked = { shutdown: 0, role: 0, autopilot: 0 }
  senderFindUnique.mockReset().mockImplementation(async () => {
    note('live-status')
    return { status: 'ACTIVE' }
  })
  attemptUpdateMany.mockReset().mockImplementation(async (a: { data?: { status?: string } }) => {
    if (a.data?.status === 'SENDING') note('claim')
    return { count: 1 }
  })
  attemptUpdate.mockReset().mockResolvedValue({})
  attemptFindUnique.mockReset().mockResolvedValue({ status: 'SENDING' })
  auditCreate.mockReset().mockImplementation(async (a: { data: { action: string } }) => {
    if (a.data.action.startsWith('attempt.send.start')) note('audit:start')
    return {}
  })
  recheck.mockReset().mockResolvedValue({ ok: true })
  claimForAttempt.mockReset().mockResolvedValue({ ok: true, held: [{ id: 'res_1', seq: 1 }] })
  settleClaims.mockReset().mockResolvedValue(undefined)
  recordDelivered.mockReset().mockResolvedValue(undefined)
  markChallenged.mockReset().mockResolvedValue(undefined)
  markSessionInvalid.mockReset().mockResolvedValue(undefined)
  clearSessionInvalid.mockReset().mockResolvedValue(undefined)
  revertUndrivenClaim.mockReset().mockResolvedValue(true)
  ensureConversationChecked.mockReset().mockResolvedValue({ ok: true, reason: 'checked-now' })
  randomInt.mockReset().mockReturnValue(0)
  getSettingsFn.mockReset().mockImplementation(async () => {
    note('autopilot')
    return { autopilotEnabled: nth(ctl.autopilot, ctl.asked.autopilot++) }
  })
  probeHandle.mockReset().mockImplementation(async () => {
    note('probe')
    return { check: 'unknown', facts: null }
  })
  send.mockReset().mockResolvedValue({ status: 'SENT', threadUrl: 'https://x/t/1' })
})

/** The tape with the two mode-only entries taken out: the switch asks and the Send button's audit row. */
const withoutModeOnly = (t: readonly string[]) => t.filter((x) => x !== 'autopilot' && x !== 'audit:start')

/**
 * `profile` appears twice: the disk check up front, and the session path handed to the drive.
 * The dispatcher's read is a `checked-now`, so the gate is asked a SECOND time after it — the
 * whole point of re-gating: the read may have recorded a reply the first verdict predates.
 */
const EXPECTED_UNATTENDED = [
  'live-status', // 2  the account row, read now
  'profile', //     3  the disk
  'gate', //        4  every rule
  'shutdown', //    5  the asks, early — before a read that is itself a drive
  'role',
  'read', //        6  the thread (the dispatcher only)
  'gate', //           and the gate again, because the read may have recorded a reply
  'shutdown', //    7  the asks, last — immediately before the claim
  'role',
  'claim', //       8  READY → SENDING
  'allowance', //   9  claimForAttempt
  'probe', //      11  one anonymous request
  'profile', //    12  the drive's session path
  'send',
  'settle', //     13  the claims are settled, then the delivery recorded
  'record',
]

/**
 * The button's order is the dispatcher's with the read AND its re-gate removed — no browser opens
 * to read a thread. The early asks stay (a duplicate directly before the late ones: one query that
 * can only refuse earlier), so the two orders are one shape.
 */
const EXPECTED_ATTENDED = EXPECTED_UNATTENDED.filter((_, i) => i !== 5 && i !== 6)

describe('both callers run the same guards in the same order', () => {
  it('the two literal orders differ by exactly the read and the gate it re-runs', () => {
    expect(EXPECTED_ATTENDED).toEqual([
      'live-status', 'profile', 'gate', 'shutdown', 'role', 'shutdown', 'role',
      'claim', 'allowance', 'probe', 'profile', 'send', 'settle', 'record',
    ])
    // What was taken out is the read (index 5) and the gate that follows it (index 6), and nothing else.
    expect(EXPECTED_UNATTENDED.slice(5, 7)).toEqual(['read', 'gate'])
    expect(EXPECTED_UNATTENDED.length - EXPECTED_ATTENDED.length).toBe(2)
  })

  it('unattended: the full sequence, with the switch re-asked at both ask points', async () => {
    const r = await run(UNATTENDED)
    expect(r.kind).toBe('sent')
    // The autopilot switch sits with the shutdown and role asks, twice: before the read, and
    // immediately before the claim.
    expect(tape.filter((x) => x === 'autopilot')).toHaveLength(2)
    const at = (i: number) => tape.indexOf('autopilot', i)
    expect(at(0)).toBeLessThan(tape.indexOf('read'))
    expect(at(tape.indexOf('read'))).toBeLessThan(tape.indexOf('claim'))
    expect(withoutModeOnly(tape)).toEqual(EXPECTED_UNATTENDED)
  })

  it('attended: no switch asks (a person substitutes), no READ, one extra audit row — nothing else', async () => {
    const r = await run(ATTENDED)
    expect(r.kind).toBe('sent')
    expect(tape, 'the Send button asked the autopilot switch').not.toContain('autopilot')
    expect(tape, 'the Send button opened a browser to read the conversation').not.toContain('read')
    expect(tape.filter((x) => x === 'gate'), 'the gate is asked once: nothing was read, so nothing to re-gate').toHaveLength(1)
    expect(tape.filter((x) => x === 'audit:start'), 'the start-of-drive audit row is written once').toHaveLength(1)
    // The start audit sits INSIDE the guarded window, as the last thing before the drive: after the
    // allowance claim and the probe (so a dead page leaves no "start" row for a send that never
    // began), before the send.
    expect(tape.indexOf('audit:start')).toBeGreaterThan(tape.indexOf('allowance'))
    expect(tape.indexOf('audit:start')).toBeGreaterThan(tape.indexOf('probe'))
    expect(tape.indexOf('audit:start')).toBeLessThan(tape.indexOf('send'))
    expect(withoutModeOnly(tape)).toEqual(EXPECTED_ATTENDED)
  })

  it('nothing that drives a browser sits between the last ask and the claim, in either mode', async () => {
    for (const mode of [UNATTENDED, ATTENDED]) {
      tape.length = 0
      await run(mode)
      const lastRoleBeforeClaim = tape.lastIndexOf('role', tape.indexOf('claim'))
      const between = tape.slice(lastRoleBeforeClaim, tape.indexOf('claim'))
      expect(between.filter((x) => x === 'send' || x === 'probe' || x === 'read')).toEqual([])
    }
  })
})

describe('the Send button never reads the conversation — a browser drive the refactor must not add', () => {
  /**
   * `ensureConversationChecked` is rigged to HOLD (a reply it would find) and to fail loudly if it
   * is ever called. For the dispatcher it holds the draft; for the button it must not be called at
   * all and the press goes through to the drive, exactly as HEAD's `sendNow` did. The cost is the
   * documented one: a reply nobody has swept yet does not hold a press.
   */
  it('a stale follow-up that the dispatcher would hold on its read is not read, and not held, for the button', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'reply-found', detail: '@target_a replied' })
    const a = await run(ATTENDED, { attempt: { touchNumber: 3 } })
    expect(ensureConversationChecked).not.toHaveBeenCalled()
    expect(a).toMatchObject({ kind: 'sent', drives: 1 })
    expect(send).toHaveBeenCalledOnce()

    tape.length = 0
    send.mockClear()
    const u = await run(UNATTENDED, { attempt: { touchNumber: 3 } })
    expect(ensureConversationChecked).toHaveBeenCalledOnce()
    expect(u).toMatchObject({ kind: 'held', reason: 'reply-found', drives: 1 })
    expect(send).not.toHaveBeenCalled()
  })

  it('and it counts one drive — the send — never two', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    expect((await run(ATTENDED)).drives).toBe(1)
  })
})

/**
 * ── EVERY ASK IS A RESULT, NOT A CEREMONY ────────────────────────────────────────────────────
 *
 * Three permissions are asked twice each: EARLY (before the thread read, which is itself a
 * drive) and LAST (immediately before the claim). Each ask is driven to REFUSE at each of its
 * two points. `asked` tells the two apart: an early refusal is the FIRST ask, a late one the
 * SECOND. Every refusal must stop the call with nothing claimed, allowance-claimed, probed or
 * sent — and, for an early one, before the read opened a browser (`drives: 0`).
 *
 * The switch is the dispatcher's alone, so it has no attended row; `asked.autopilot` stays 0 there.
 */
type Refusal = {
  name: string
  why: 'shutdown' | 'role-changed' | 'autopilot-off'
  /** program the sequence: `ok` answers that pass, then one that refuses, then (repeating) refuse */
  refuseAfter: (passes: number) => void
  askedKey: 'shutdown' | 'role' | 'autopilot'
  modes: Mode[]
}
const REFUSALS: Refusal[] = [
  {
    name: 'the shutdown flag',
    why: 'shutdown',
    askedKey: 'shutdown',
    refuseAfter: (n) => { ctl.shutdown = [...Array<boolean>(n).fill(false), true] },
    modes: [UNATTENDED, ATTENDED],
  },
  {
    name: 'the sending Mac',
    why: 'role-changed',
    askedKey: 'role',
    refuseAfter: (n) => { ctl.roleActive = [...Array<boolean>(n).fill(true), false] },
    modes: [UNATTENDED, ATTENDED],
  },
  {
    name: 'the autopilot switch',
    why: 'autopilot-off',
    askedKey: 'autopilot',
    refuseAfter: (n) => { ctl.autopilot = [...Array<boolean>(n).fill(true), false] },
    modes: [UNATTENDED],
  },
]

describe('a permission withdrawn mid-call stops the call — the asks are results, not ceremonies', () => {
  const NEVER_AFTER_A_REFUSAL = ['claim', 'allowance', 'probe', 'send', 'settle', 'record']

  describe.each(REFUSALS)('$name', (ask) => {
    it.each(ask.modes.map((m) => [m.unattended ? 'unattended' : 'attended', m] as const))(
      'the EARLY ask refuses — %s — before any read opens a browser',
      async (_label, mode) => {
        ask.refuseAfter(0)
        const r = await run(mode)
        expect(r).toMatchObject({ kind: 'stop-tick', why: ask.why, drives: 0 })
        expect(ctl.asked[ask.askedKey], 'refused at the first ask, so it was asked once').toBe(1)
        expect(tape).not.toContain('read')
        for (const step of NEVER_AFTER_A_REFUSAL) expect(tape, `${step} ran after the early refusal`).not.toContain(step)
        expect(ensureConversationChecked).not.toHaveBeenCalled()
      },
    )

    it.each(ask.modes.map((m) => [m.unattended ? 'unattended' : 'attended', m] as const))(
      'the LAST ask refuses — %s — after the early one passed, with nothing claimed',
      async (_label, mode) => {
        ask.refuseAfter(1)
        const r = await run(mode)
        // The dispatcher's read opened Chrome between the two asks, and says so; the button opened nothing.
        expect(r).toMatchObject({ kind: 'stop-tick', why: ask.why, drives: mode.unattended ? 1 : 0 })
        expect(ctl.asked[ask.askedKey], 'passed once, refused at the second ask').toBe(2)
        expect(tape.includes('read'), 'only the dispatcher reads').toBe(mode.unattended)
        for (const step of NEVER_AFTER_A_REFUSAL) expect(tape, `${step} ran after the last ask refused`).not.toContain(step)
        // …and the row was never touched: the claim is an `updateMany` to SENDING.
        expect(attemptUpdateMany.mock.calls.some((c) => (c[0] as { data: { status?: string } }).data.status === 'SENDING')).toBe(false)
        expect(claimForAttempt).not.toHaveBeenCalled()
      },
    )
  })

  it('the Send button never asks the switch, so a flipped-off switch cannot stop a person', async () => {
    ctl.autopilot = [false]
    const r = await run(ATTENDED)
    expect(r.kind).toBe('sent')
    expect(ctl.asked.autopilot).toBe(0)
  })
})

describe('a draft that moved while the dispatcher\'s read ran is not written back', () => {
  /**
   * The unreadable-read ladder is the one status write on a row that is still WAITING, landing after
   * a read that can run a minute. `discardAttempt` carries `status IN (READY, QUEUED)` in its own
   * `where` and takes no lock, so a draft a person discards during the read is SKIPPED when the read
   * comes back `unreadable`. As a plain `update` by id the ladder wrote READY over it and the
   * dispatcher then sent a message a person had cancelled.
   */
  const unreadable = () =>
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'unreadable', detail: 'the conversation could not be read' })
  const ladderWrites = () =>
    attemptUpdateMany.mock.calls
      .map((c) => c[0] as { where: { id: string; status: unknown }; data: { status: string } })
      .filter((c) => c.data.status !== 'SENDING')

  it('control: a draft still waiting goes to the back of the queue, by a write conditional on READY', async () => {
    unreadable()
    const r = await run(UNATTENDED)
    expect(r).toMatchObject({ kind: 'failed', ladder: 'read-unreadable', parked: false, attempts: 1, drives: 1 })
    expect(ladderWrites()).toHaveLength(1)
    expect(ladderWrites()[0]!.where).toEqual({ id: 'att_1', status: 'READY' })
    expect(ladderWrites()[0]!.data).toMatchObject({ status: 'READY', failureCode: 'unreadable', attempts: { increment: 1 } })
    expect(attemptUpdate, 'the ladder went back to a plain update by id').not.toHaveBeenCalled()
  })

  it('a draft discarded while the read ran is not written back to READY — and nothing is parked, logged or claimed', async () => {
    unreadable()
    // The write matches no row: it was SKIPPED during the read.
    attemptUpdateMany.mockImplementation(async (a: { data?: { status?: string } }) => {
      if (a.data?.status === 'SENDING') note('claim')
      return { count: 0 }
    })
    attemptFindUnique.mockResolvedValue({ status: 'SKIPPED' })
    const r = await run(UNATTENDED)
    // Held, not failed: the row is no longer this call's to speak for. The read DID open Chrome, so it counts.
    expect(r).toEqual({ kind: 'held', reason: 'claim-lost', detail: 'already skipped', drives: 1 })
    expect(attemptUpdate, 'the ladder wrote over a discarded draft with a plain update').not.toHaveBeenCalled()
    expect(tape).not.toContain('claim')
    expect(tape).not.toContain('send')
    // …and the same at the retry cap, where the write would have PARKED it (FAILED) over the discard.
    tape.length = 0
    const atCap = await run(UNATTENDED, { attempt: { attempts: MAX_DELIVERY_ATTEMPTS - 1 } })
    expect(atCap).toMatchObject({ kind: 'held', reason: 'claim-lost', detail: 'already skipped' })
  })
})

describe('everything mode-dependent comes from mode alone', () => {
  it('the allowance claim skips the hour bucket for the button only', async () => {
    await run(UNATTENDED)
    expect(claimForAttempt.mock.calls.at(-1)![0]).toMatchObject({ attended: false, pairId: 'pair_1', maxPerPairPerDay: 5, fleetMaxPerHour: 3, fleetMaxPerDay: 9 })
    claimForAttempt.mockClear()
    await run(ATTENDED)
    expect(claimForAttempt.mock.calls.at(-1)![0]).toMatchObject({ attended: true, pairId: 'pair_1', maxPerPairPerDay: 5, fleetMaxPerDay: 9 })
  })

  it('the claim accepts a QUEUED draft from the Send button only', async () => {
    await run(UNATTENDED)
    const unattendedClaim = attemptUpdateMany.mock.calls.find((c) => (c[0] as { data: { status: string } }).data.status === 'SENDING')![0]
    expect(unattendedClaim.where).toEqual({ id: 'att_1', status: 'READY' })
    attemptUpdateMany.mockClear()
    await run(ATTENDED)
    const attendedClaim = attemptUpdateMany.mock.calls.find((c) => (c[0] as { data: { status: string } }).data.status === 'SENDING')![0]
    expect(attendedClaim.where).toEqual({ id: 'att_1', status: { in: ['READY', 'QUEUED'] } })
  })

  it('sentBy and the delivered-message audit row: the dispatcher is "autopilot", the button is the person', async () => {
    await run(UNATTENDED)
    expect(recordDelivered.mock.calls.at(-1)![0]).toMatchObject({
      attemptId: 'att_1',
      variantId: 'var_1',
      sentBy: 'autopilot:bollywoodsocietyy',
      threadUrl: 'https://x/t/1',
      audit: {
        actor: 'autopilot',
        action: 'attempt.sent.autopilot',
        entity: 'OutreachAttempt:att_1',
        detail: 'bollywoodsocietyy→target_a — https://x/t/1',
      },
    })
    await run(ATTENDED)
    expect(recordDelivered.mock.calls.at(-1)![0]).toMatchObject({
      sentBy: 'operator:bollywoodsocietyy',
      audit: { actor: 'tester@dashmani.com', action: 'attempt.sent.auto', entity: 'OutreachAttempt:att_1', detail: 'https://x/t/1' },
    })
  })

  it('an overridden send is legible as one — and only a WHITELISTED override is ever recorded as crossed', async () => {
    await run({ unattended: false, operator: 'tester@dashmani.com', overrides: ['target-replied', 'sender-not-active'] })
    // The gate is handed what the caller sent (it applies the whitelist itself)…
    expect(recheck.mock.calls[0]![1]).toEqual({ unattended: false, overrides: ['target-replied', 'sender-not-active'] })
    // …but the record carries only what the whitelist let through.
    expect(recordDelivered.mock.calls.at(-1)![0]).toMatchObject({
      sentBy: 'override(target-replied):bollywoodsocietyy',
      audit: { action: 'attempt.sent.override' },
    })
    const start = auditCreate.mock.calls.map((c) => (c[0] as { data: { action: string; detail: string } }).data).find((d) => d.action === 'attempt.send.start.override')
    expect(start?.detail).toContain('crossed: target-replied')
    expect(start?.detail).not.toContain('sender-not-active')
  })

  it('the unattended caller hands the gate NO overrides, whatever else is true', async () => {
    await run(UNATTENDED)
    expect(recheck.mock.calls[0]![1]).toEqual({ unattended: true, overrides: undefined })
  })

  it('spacing is the CALLER\'s decision: asked for, it sleeps before the probe; not asked, it does not', async () => {
    await run(UNATTENDED, { spaceBeforeDrive: false })
    expect(randomInt).not.toHaveBeenCalled()
    await run(UNATTENDED, { spaceBeforeDrive: true })
    expect(randomInt).toHaveBeenCalledWith(1, 2)
  })

  describe('the failure ladder', () => {
    const fail = (over: Record<string, unknown> = {}) =>
      send.mockResolvedValue({ status: 'FAILED', error: 'paste did not land', failureCode: 'composer-mismatch', ...over })
    const stateWrite = () => (attemptUpdate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data
    const audits = () => auditCreate.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action)

    it('a retryable failure goes to the BACK of the queue for the dispatcher, and stays put for the button', async () => {
      fail()
      const u = await run(UNATTENDED)
      expect(u).toMatchObject({ kind: 'failed', ladder: 'retry', parked: false })
      expect(stateWrite()).toMatchObject({ status: 'READY', attempts: { increment: 1 } })
      expect(stateWrite().queuedAt).toBeInstanceOf(Date)
      expect(audits()).not.toContain('attempt.send.failed')

      attemptUpdate.mockClear()
      auditCreate.mockClear()
      const a = await run(ATTENDED)
      expect(a).toMatchObject({ kind: 'failed', ladder: 'retry', parked: false, detail: 'paste did not land' })
      expect(stateWrite()).toEqual({ status: 'READY', error: 'paste did not land', failureCode: 'composer-mismatch', attempts: { increment: 1 } })
      expect(audits()).toContain('attempt.send.failed')
    })

    it('the Send button\'s retryable failure stays READY even at the cap; the dispatcher\'s parks', async () => {
      fail()
      const atCap = { attempts: MAX_DELIVERY_ATTEMPTS - 1 }
      const u = await run(UNATTENDED, { attempt: atCap })
      expect(u).toMatchObject({ kind: 'failed', ladder: 'retry', parked: true, attempts: MAX_DELIVERY_ATTEMPTS })
      expect(stateWrite()).toMatchObject({ status: 'FAILED' })
      expect(stateWrite()).not.toHaveProperty('queuedAt')

      const a = await run(ATTENDED, { attempt: atCap })
      expect(a).toMatchObject({ kind: 'failed', ladder: 'retry', parked: false })
      expect(stateWrite()).toMatchObject({ status: 'READY' })
    })

    it('a checkpoint halts through the one writer, attributed to whoever was driving', async () => {
      fail({ error: 'Instagram checkpoint', failureCode: 'enforcement', challenged: true })
      await run(UNATTENDED)
      expect(markChallenged.mock.calls.at(-1)![0]).toMatchObject({ senderId: 'send_1', actor: 'autopilot' })
      await run(ATTENDED)
      expect(markChallenged.mock.calls.at(-1)![0]).toMatchObject({ senderId: 'send_1', actor: 'tester@dashmani.com' })
    })

    it('a logged-out account is recorded through the one writer, attributed the same way', async () => {
      fail({ error: 'not logged in', failureCode: 'logged-out', sessionInvalid: true })
      await run(UNATTENDED)
      expect(markSessionInvalid.mock.calls.at(-1)![0]).toMatchObject({ actor: 'autopilot' })
      await run(ATTENDED)
      expect(markSessionInvalid.mock.calls.at(-1)![0]).toMatchObject({ actor: 'tester@dashmani.com' })
    })

    it('not-in-thread parks for both; only the button writes the "uncertain" audit row', async () => {
      fail({ error: 'never appeared', failureCode: 'not-in-thread' })
      await run(UNATTENDED)
      expect(stateWrite()).toMatchObject({ status: 'FAILED', attempts: { increment: 1 } })
      expect(audits()).not.toContain('attempt.send.uncertain')
      attemptUpdate.mockClear()
      auditCreate.mockClear()
      await run(ATTENDED)
      expect(stateWrite()).toMatchObject({ status: 'FAILED', attempts: { increment: 1 } })
      expect(audits()).toContain('attempt.send.uncertain')
    })

    it('a drive-found dead page parks for the dispatcher only — the difference nobody designed, preserved', async () => {
      fail({ error: 'page gone', failureCode: 'profile-gone' })
      const u = await run(UNATTENDED)
      expect(u).toMatchObject({ kind: 'failed', ladder: 'drive-gone', parked: true })
      expect(stateWrite()).toMatchObject({ status: 'FAILED', attempts: MAX_DELIVERY_ATTEMPTS })
      const a = await run(ATTENDED)
      expect(a).toMatchObject({ kind: 'failed', ladder: 'retry', parked: false })
      expect(stateWrite()).toMatchObject({ status: 'READY', attempts: { increment: 1 } })
    })

    it('the anonymous probe parks a dead page for BOTH callers, before any drive', async () => {
      probeHandle.mockResolvedValue({ check: 'missing', facts: null })
      for (const mode of [UNATTENDED, ATTENDED]) {
        tape.length = 0
        send.mockClear()
        const r = await run(mode)
        expect(r).toMatchObject({ kind: 'failed', ladder: 'probe-gone', parked: true, failureCode: 'profile-gone' })
        expect(send).not.toHaveBeenCalled()
        expect(tape).not.toContain('send')
      }
    })
  })
})

describe('a refused allowance claim: a fleet refusal ends the tick and its log line says which kind', () => {
  /**
   * `claimForAttempt` reports a CONTENDED claim (every race lost, the cap NOT reached) under the
   * same bucket reason as a reached cap, so `deliverOne`'s routing does not move: a fleet bucket
   * stops the tick either way, a pair bucket holds one draft. What separates the two is the log
   * line — and until these cases nothing pinned it, so a contended fleet claim could have gone on
   * logging "fleet pacing reached" (the cap's sentence over a cap with room) and every test passed.
   *
   * MUTATIONS, each applied by hand once to `src/outreach/deliverOne.ts`, seen red, restored:
   *   - the log's `claim.contended ? 'fleet claim contended …' : 'fleet pacing reached …'` replaced
   *     by its second arm alone → the three `contended: true` cases go red (both unattended buckets
   *     and the Send button's);
   *   - replaced by its first arm alone → the two `contended: false` cases go red;
   *   - routing a fleet refusal through `held(...)` instead of `stop('fleet-pace', ...)` → all five
   *     fleet cases go red (`kind` is `held`), and the pair control stays green;
   *   - making the SENDING → READY put-back fleet-only (wrapped in `if (claim.reason ===
   *     'fleet-hourly-pace' || claim.reason === 'fleet-daily-cap')`, so a pair refusal leaves the
   *     row SENDING) → the pair control goes red, and the four unattended fleet cases stay green.
   */
  const CONTENDED_LINE = 'fleet claim contended — the cap is not reached; the rest wait for the next tick'
  const REACHED_LINE = 'fleet pacing reached — the rest wait for the next tick'
  const stepLines = async () => {
    const { log } = await import('@/lib/logger')
    return vi.mocked(log.step).mock.calls.map((c) => c[0] as string)
  }
  const clearSteps = async () => {
    const { log } = await import('@/lib/logger')
    vi.mocked(log.step).mockClear()
  }

  it.each([
    ['fleet-daily-cap', true],
    ['fleet-hourly-pace', true],
    ['fleet-daily-cap', false],
    ['fleet-hourly-pace', false],
  ] as const)('%s, contended %s: stop-tick on fleet-pace, the row put back, and the right line', async (reason, contended) => {
    const detail = contended ? 'contended: too many sends are being claimed at once' : 'the fleet has already sent 9 message(s) today (limit 9)'
    claimForAttempt.mockResolvedValue({ ok: false, reason, contended, detail })
    await clearSteps()

    const r = await run(UNATTENDED)

    // Both kinds stop the tick: the next draft would meet the same bucket.
    expect(r).toMatchObject({ kind: 'stop-tick', why: 'fleet-pace', detail })
    expect(send).not.toHaveBeenCalled()
    expect(tape).not.toContain('probe')
    // The claim's READY → SENDING is undone, conditionally, because nothing was sent.
    expect(attemptUpdateMany.mock.calls.map((c) => c[0])).toContainEqual({ where: { id: 'att_1', status: 'SENDING' }, data: { status: 'READY' } })

    const lines = await stepLines()
    expect(lines).toContain(contended ? CONTENDED_LINE : REACHED_LINE)
    expect(lines, 'the other kind\'s sentence was logged').not.toContain(contended ? REACHED_LINE : CONTENDED_LINE)
    const { log } = await import('@/lib/logger')
    const call = vi.mocked(log.step).mock.calls.find((c) => c[0] === (contended ? CONTENDED_LINE : REACHED_LINE))!
    expect(call[1]).toEqual({ reason, contended })
  })

  it('the Send button meets the same branch: a contended fleet day claim stops with the contended line', async () => {
    claimForAttempt.mockResolvedValue({ ok: false, reason: 'fleet-daily-cap', contended: true, detail: 'contended: x' })
    await clearSteps()
    const r = await run(ATTENDED)
    expect(r).toMatchObject({ kind: 'stop-tick', why: 'fleet-pace', detail: 'contended: x', drives: 0 })
    expect(await stepLines()).toContain(CONTENDED_LINE)
  })

  it('control: a PAIR refusal, contended or not, holds this one draft, puts the row back, and logs neither fleet line', async () => {
    for (const contended of [true, false]) {
      claimForAttempt.mockResolvedValue({ ok: false, reason: 'pair-daily-cap', contended, detail: 'pair detail' })
      await clearSteps()
      // Per iteration, so the first pass's put-back cannot satisfy the second pass's assertion.
      attemptUpdateMany.mockClear()
      const r = await run(UNATTENDED)
      expect(r).toMatchObject({ kind: 'held', reason: 'pair-daily-cap', detail: 'pair detail' })
      // Nothing was sent, so the claim's READY → SENDING is undone, conditionally — a held draft
      // left SENDING would be parked by the orphan sweep as possibly delivered, holding the pair.
      expect(attemptUpdateMany.mock.calls.map((c) => c[0])).toContainEqual({
        where: { id: 'att_1', status: 'SENDING' },
        data: { status: 'READY' },
      })
      const lines = await stepLines()
      expect(lines).not.toContain(CONTENDED_LINE)
      expect(lines).not.toContain(REACHED_LINE)
    }
  })
})

describe('the drives it reports', () => {
  it('a send alone is one drive; a read that opened Chrome plus a send is two', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'fresh' })
    expect((await run(UNATTENDED)).drives).toBe(1)
    ensureConversationChecked.mockResolvedValue({ ok: true, reason: 'checked-now' })
    expect((await run(UNATTENDED)).drives).toBe(2)
  })

  it.each([
    ['checked-now', true],
    ['reply-found', false],
    ['unreadable', false],
    ['incomplete', false],
    ['checkpoint', false],
  ] as const)('a %s read opened a browser, so it counts', async (reason, ok) => {
    ensureConversationChecked.mockResolvedValue(ok ? { ok, reason } : { ok, reason, detail: 'x' })
    recheck.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'target-replied', detail: 'replied' })
    const r = await run(UNATTENDED)
    expect(r.drives).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('a read that never launched Chrome costs nothing: `no-session` and `fresh` are not drives', async () => {
    ensureConversationChecked.mockResolvedValue({ ok: false, reason: 'no-session', detail: 'no session on disk' })
    const r = await run(UNATTENDED)
    expect(r).toMatchObject({ kind: 'held', reason: 'no-session', drives: 0 })
  })
})
