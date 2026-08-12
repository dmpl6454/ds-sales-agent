import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── defect (b): a delivered message can be re-sent ─────────────────────────
 *
 * All five send paths recorded SENT inside a `$transaction` together with a variant
 * counter and an audit row. A transaction is all-or-nothing, so a lock timeout on either
 * disposable write rolled back the one that matters — and the recipient then had a
 * message our records say we never sent. Every guard derived from send history (spacing,
 * the unanswered-touch cap, the new-material rule, the daily caps) is computed from that
 * history, so all of them would have been computed from a lie, silently.
 *
 * `journal_mode = delete` with a 5-second busy timeout and three processes sharing the
 * file made `SQLITE_BUSY` genuinely reachable. WAL removes the trigger; this removes the
 * class, and the two are separate fixes on purpose — WAL makes contention rarer, it does
 * not make a rolled-back transaction safe.
 */

const attemptUpdate = vi.fn()
const variantUpdate = vi.fn()
const auditCreate = vi.fn()
const calls: string[] = []

vi.mock('@/lib/db', () => ({
  prisma: {
    outreachAttempt: {
      update: (...a: unknown[]) => {
        calls.push('attempt')
        return attemptUpdate(...a)
      },
    },
    messageVariant: {
      update: (...a: unknown[]) => {
        calls.push('variant')
        return variantUpdate(...a)
      },
    },
    auditLog: {
      create: (...a: unknown[]) => {
        calls.push('audit')
        return auditCreate(...a)
      },
    },
    $transaction: () => {
      throw new Error('recordDelivered must NOT put the SENT write in a transaction')
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))

const { recordDelivered } = await import('@/outreach/recordSend')
const { log } = await import('@/lib/logger')

const REC = {
  attemptId: 'att_1',
  variantId: 'var_1',
  sentBy: 'autopilot:bollywoodsocietyy',
  threadUrl: 'https://www.instagram.com/direct/t/123',
  audit: { actor: 'autopilot', action: 'attempt.sent.autopilot', entity: 'OutreachAttempt:att_1', detail: 'x' },
}

beforeEach(() => {
  calls.length = 0
  attemptUpdate.mockReset().mockResolvedValue({})
  variantUpdate.mockReset().mockResolvedValue({})
  auditCreate.mockReset().mockResolvedValue({})
  vi.mocked(log.warn).mockClear()
  vi.mocked(log.alarm).mockClear()
})

describe('recordDelivered — the SENT row commits alone and first', () => {
  it('writes SENT before any bookkeeping', async () => {
    await recordDelivered(REC)
    expect(calls[0]).toBe('attempt')
    expect(calls).toEqual(['attempt', 'variant', 'audit'])
  })

  it('records exactly what was delivered', async () => {
    await recordDelivered(REC)
    const arg = attemptUpdate.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ id: 'att_1' })
    expect(arg.data.status).toBe('SENT')
    expect(arg.data.sentBy).toBe('autopilot:bollywoodsocietyy')
    expect(arg.data.threadUrl).toBe('https://www.instagram.com/direct/t/123')
    // A prior failure must not survive on a row that now says SENT.
    expect(arg.data.error).toBeNull()
    expect(arg.data.failureCode).toBeNull()
  })

  /** THE FIX. A failing variant bump used to take the SENT row down with it. */
  it('keeps SENT when the variant counter throws', async () => {
    variantUpdate.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
    await expect(recordDelivered(REC)).resolves.toBeUndefined()
    expect(attemptUpdate).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalled()
  })

  it('keeps SENT when the audit row throws', async () => {
    auditCreate.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
    await expect(recordDelivered(REC)).resolves.toBeUndefined()
    expect(attemptUpdate).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalled()
  })

  it('still bumps the variant when the audit row throws, and vice versa', async () => {
    auditCreate.mockRejectedValue(new Error('boom'))
    await recordDelivered(REC)
    expect(variantUpdate).toHaveBeenCalledOnce()

    calls.length = 0
    auditCreate.mockReset().mockResolvedValue({})
    variantUpdate.mockReset().mockRejectedValue(new Error('boom'))
    await recordDelivered(REC)
    expect(auditCreate).toHaveBeenCalledOnce()
  })

  it('omits the audit row when none was asked for', async () => {
    await recordDelivered({ ...REC, audit: undefined })
    expect(calls).toEqual(['attempt', 'variant'])
    expect(auditCreate).not.toHaveBeenCalled()
  })
})

describe('recordDelivered — when the SENT write itself cannot land', () => {
  /**
   * At this point the DM IS delivered. Abandoning the record is not an option, so the
   * one write that matters is retried — and it is idempotent, so a retry is free.
   */
  it('retries a contended SENT write and succeeds', async () => {
    vi.useFakeTimers()
    try {
      attemptUpdate
        .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
        .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
        .mockResolvedValue({})
      const done = recordDelivered(REC)
      await vi.advanceTimersByTimeAsync(60_000)
      await done
      expect(attemptUpdate).toHaveBeenCalledTimes(3)
      expect(log.alarm).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * And when every retry fails: throw, alarm, and leave the row where it is. It will be
   * SENDING, which NO automatic path picks up. Setting READY here would hand a delivered
   * message straight back to the next slot to send a second time.
   */
  it('alarms and throws rather than leaving the attempt re-sendable', async () => {
    vi.useFakeTimers()
    try {
      attemptUpdate.mockRejectedValue(new Error('SQLITE_BUSY'))
      const done = recordDelivered(REC)
      const assertion = expect(done).rejects.toThrow('SQLITE_BUSY')
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
      expect(log.alarm).toHaveBeenCalledOnce()
      expect(String(vi.mocked(log.alarm).mock.calls[0]?.[0])).toContain('DELIVERED BUT NOT RECORDED')
      // No bookkeeping runs, and critically no status is written that could be re-sent.
      expect(variantUpdate).not.toHaveBeenCalled()
      expect(auditCreate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
