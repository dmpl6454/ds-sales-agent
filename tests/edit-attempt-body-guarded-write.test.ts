import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── THE EDIT'S WRITE IS ITS GUARD (Stage 1.3, audit M11) ────────────────────────────────────
 *
 * `editAttemptBody` read the status, validated, and wrote in a SEPARATE statement. Between the
 * read and the write the dispatcher could claim the draft and a browser start pasting the old
 * body — and the new one was then stored under a row that is SENDING, an audit trail describing a
 * message nobody received. The update now carries `status IN (READY, QUEUED)` in its own `where`
 * and the COUNT is the answer.
 *
 * Driven against an in-memory row whose status the fake `updateMany` honours, so the race is the
 * real shape: the first read says READY, and by the time the write arrives the row has moved.
 * The read that stays at the top is for the MESSAGE (a draft already SENDING hears that before
 * it hears its body is too short); it decides nothing, which is what the second case proves.
 *
 * MUTATION, applied by hand to `src/app/actions.ts`, seen red, restored: turning the guarded
 * `updateMany` back into `update({ where: { id: attemptId }, data: { renderedBody: next } })`
 * fails "a draft claimed between the read and the write is NOT overwritten" — the body is
 * overwritten and `ok: true` comes back.
 */

const state = vi.hoisted(() => ({
  row: { status: 'READY', renderedBody: 'old body' } as { status: string; renderedBody: string },
  /** Run between the first read and the write: the dispatcher claiming the draft. */
  raceBeforeWrite: null as null | (() => void),
}))

const auditCreate = vi.fn()
const updateManyCalls: unknown[] = []

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    outreachAttempt: {
      findUniqueOrThrow: async () => ({
        id: 'att_1',
        status: state.row.status,
        renderedBody: state.row.renderedBody,
        pair: { sender: { handle: 'bollywoodchronicle' }, target: { handle: 'tips' } },
      }),
      findUnique: async () => ({ status: state.row.status }),
      updateMany: async (a: { where: { status?: { in?: string[] } }; data: { renderedBody?: string } }) => {
        updateManyCalls.push(a)
        state.raceBeforeWrite?.()
        if (a.where.status?.in && !a.where.status.in.includes(state.row.status)) return { count: 0 }
        if (a.data.renderedBody !== undefined) state.row.renderedBody = a.data.renderedBody
        return { count: 1 }
      },
      // The OLD write. If the action ever goes back to it, it overwrites regardless of status.
      update: async (a: { data: { renderedBody?: string } }) => {
        if (a.data.renderedBody !== undefined) state.row.renderedBody = a.data.renderedBody
        return {}
      },
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}))
vi.mock('@/lib/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))

const { editAttemptBody } = await import('@/app/actions')

/** A body the send guards can verify: a greeting line, and a line of 40+ characters of its own wording. */
const GOOD = 'Hi,\nWe would like to talk about the campaign you ran last week with a partner of ours.'

beforeEach(() => {
  state.row = { status: 'READY', renderedBody: 'old body' }
  state.raceBeforeWrite = null
  updateManyCalls.length = 0
  auditCreate.mockReset().mockResolvedValue({})
})

describe('editAttemptBody: the write carries the status condition', () => {
  it('saves a waiting draft, and the update names READY and QUEUED in its own where', async () => {
    const res = await editAttemptBody('att_1', GOOD)
    expect(res).toEqual({ ok: true, message: `Saved. ${GOOD.length} characters.` })
    expect(state.row.renderedBody).toBe(GOOD)
    expect(updateManyCalls).toHaveLength(1)
    expect((updateManyCalls[0] as { where: unknown }).where).toEqual({ id: 'att_1', status: { in: ['READY', 'QUEUED'] } })
    expect(auditCreate).toHaveBeenCalledOnce()
    expect(auditCreate.mock.calls[0]![0].data.action).toBe('attempt.edited')
  })

  it('a QUEUED draft is editable too', async () => {
    state.row.status = 'QUEUED'
    expect((await editAttemptBody('att_1', GOOD)).ok).toBe(true)
  })

  it('a draft claimed between the read and the write is NOT overwritten, and the sentence is the SENDING one', async () => {
    // The first read saw READY; the dispatcher claims the draft before the write lands.
    state.raceBeforeWrite = () => {
      state.row.status = 'SENDING'
    }
    const res = await editAttemptBody('att_1', GOOD)
    expect(res).toEqual({ ok: false, message: 'That message is being sent right now — too late to edit.' })
    expect(state.row.renderedBody, 'the body of a message a browser is pasting was overwritten').toBe('old body')
    expect(auditCreate, 'an audit row says an edit that did not happen').not.toHaveBeenCalled()
  })

  it('and one that was SENT in that window says what it is now', async () => {
    state.raceBeforeWrite = () => {
      state.row.status = 'SENT'
    }
    const res = await editAttemptBody('att_1', GOOD)
    expect(res).toEqual({ ok: false, message: 'That message is already sent and cannot be changed.' })
    expect(state.row.renderedBody).toBe('old body')
  })
})

describe('editAttemptBody: every sentence it had is still the sentence', () => {
  it('a draft already SENDING hears that before anything about its body — and nothing is written', async () => {
    state.row.status = 'SENDING'
    // An empty body would otherwise be refused first; the status sentence still leads.
    expect(await editAttemptBody('att_1', '   ')).toEqual({ ok: false, message: 'That message is being sent right now — too late to edit.' })
    expect(updateManyCalls).toHaveLength(0)
  })

  it('a draft already SENT', async () => {
    state.row.status = 'SENT'
    expect(await editAttemptBody('att_1', GOOD)).toEqual({ ok: false, message: 'That message is already sent and cannot be changed.' })
  })

  it('an empty body, one too long, one the guards cannot verify, and no change at all', async () => {
    expect(await editAttemptBody('att_1', '  \r\n ')).toEqual({ ok: false, message: 'A message cannot be empty. Discard it instead.' })
    expect(await editAttemptBody('att_1', 'x'.repeat(4001))).toEqual({ ok: false, message: 'That is 4001 characters; the limit is 4000.' })
    expect((await editAttemptBody('att_1', 'one short line')).message).toMatch(/^That message is too short to verify on screen before sending\./)
    state.row.renderedBody = GOOD
    expect(await editAttemptBody('att_1', GOOD)).toEqual({ ok: true, message: 'No changes.' })
    expect(updateManyCalls).toHaveLength(0)
  })
})
