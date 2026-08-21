import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideDispatch, FLEET_MIN_GAP_MINUTES, GAP_MEASURED_FROM_SEND_START } from '@/outreach/pacing'

/**
 * THE FLEET GAP IS A PERIOD, NOT IDLE TIME AFTER A SEND — 2026-08-21.
 *
 * ── THE MEASUREMENT THAT FORCED THIS ──────────────────────────────────────
 *
 * Tabish: *"If we are sending every 1 min or so why are only 25-35/hour being sent?"* Over
 * the flat overnight run — 276 deliveries, IST midnight to 09:00, autopilot on, 80+ drafts
 * waiting, nothing held — the gap between consecutive sends was **min 104s, p50 107s, p90
 * 124s, with 235 of 275 gaps inside a single 15-second bucket.**
 *
 * A distribution that tight is an equation, not jitter. `sentAt` is stamped on COMPLETION and
 * the gap was measured from it, so:
 *
 *     period = gap (60s) + the browser drive (~47s) = 107s = 33.6/hour
 *
 * i.e. the knob could never produce the rate it named, at ANY value. The number on `/rules`
 * and the number in force were different rules — the `MAX_TOTAL_SENDS` failure moved into the
 * pacing layer, where "1 minute" silently meant "1 minute plus however long a send takes".
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
 *
 * The pure decision cannot see WHICH clock it is handed, so the behavioural half asserts the
 * boundary and the structural half asserts the caller reads the start clock. Both are needed:
 * a gap check that is perfect on a clock measured from the wrong event is the bug.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const base = {
  autopilotEnabled: true,
  breaker: { tripped: false as const, detail: null },
  istHour: 14,
  waitingCount: 40,
}

describe('the gap decision, at its boundary', () => {
  it('holds strictly inside the gap and permits the moment it is reached', () => {
    const tooSoon = decideDispatch({ ...base, minutesSinceLastSend: 0, minGapMinutes: 1 })
    expect(tooSoon.action).toBe('hold')
    if (tooSoon.action !== 'hold') throw new Error('unreachable')
    expect(tooSoon.reason).toBe('too-soon')

    expect(decideDispatch({ ...base, minutesSinceLastSend: 1, minGapMinutes: 1 }).action).toBe('send')
  })

  /** Nothing has ever been sent: the gap cannot hold, and must not read as "0 minutes ago". */
  it('a fleet that has never sent is not held by spacing', () => {
    expect(decideDispatch({ ...base, minutesSinceLastSend: null, minGapMinutes: 1 }).action).toBe('send')
  })

  /** The default is the rate Tabish asked for, and it is stated as a constant not a literal. */
  it('the shipped gap is one minute', () => {
    expect(FLEET_MIN_GAP_MINUTES).toBe(1)
    expect(GAP_MEASURED_FROM_SEND_START).toBe(true)
  })
})

describe('the dispatcher measures the gap from the send START', () => {
  const src = read('src/outreach/dispatcher.ts')

  /**
   * The regression in one line. Reading `sentAt` here is what added the drive time to every
   * gap; a behavioural test cannot fail for it because the pure decision is handed a number
   * and cannot know which event produced it.
   */
  it('the tick reads the start clock, not the newest sentAt', () => {
    const window = src.slice(src.indexOf('const [breaker, waitingCount'), src.indexOf('const verdict = decideDispatch'))
    expect(window).toMatch(/lastSendStartedAt\(\)/)
    expect(window).not.toMatch(/orderBy:\s*\{\s*sentAt:\s*'desc'\s*\}/)
  })

  /**
   * The stamp must be written INSIDE the lock and BEFORE the drive. Written after, it is
   * the completion clock again under a new name — the whole defect, restored.
   */
  it('the start is stamped inside the send lock, before deliverWaiting', () => {
    const lock = src.slice(src.indexOf('withSendLock(`dispatch:'), src.indexOf('if (result === null)'))
    expect(lock).toMatch(/recordSendStarted/)
    expect(lock.indexOf('recordSendStarted')).toBeLessThan(lock.indexOf('deliverWaiting'))
  })

  /** A missing row must not read as "never sent" and fire immediately on every deploy. */
  it('falls back to the newest delivery when the row does not exist yet', () => {
    const fn = src.slice(src.indexOf('export async function lastSendStartedAt'), src.indexOf('export const DISPATCH_INTERVAL') > 0 ? src.indexOf('export const DISPATCH_INTERVAL') : src.length)
    expect(fn).toMatch(/sentAt/)
    expect(fn).toMatch(/started > completed \? started : completed/)
  })
})
