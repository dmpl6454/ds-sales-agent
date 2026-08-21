import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { decideDispatch, FLEET_MIN_GAP_MINUTES, GAP_MEASURED_FROM_SEND_START } from '@/outreach/pacing'
import { gapClock } from '@/outreach/dispatcher'

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
   * ── THE STAMP BELONGS TO THE DRIVE, NOT TO THE LOCK (2026-08-21, evening) ──
   *
   * The lock-level stamp shipped that morning and was measured wrong the same day: a
   * dispatch tick acquires the lock BEFORE it knows whether any draft passes the gate, so
   * on a drained queue every passing tick stamped the clock — watch.log read "the last
   * message went out 0 minute(s) ago" for TWELVE consecutive minutes with zero sends
   * (17:07–17:18 IST), and a newly-cleared draft waits up to a full gap period behind
   * stamps from ticks that delivered nothing.
   *
   * So the stamp lives in `browserSender.send` now: the ONE implementation every delivered
   * message passes through (deliverWaiting and the operator send both call it, both under
   * the send lock), still BEFORE the browser moves so the gap stays a period. Written after
   * `sendDm`, it is the completion clock again under a new name — the original defect,
   * restored.
   */
  it('browserSender stamps the start before the drive begins', () => {
    const sender = read('src/outreach/senders/browser.ts')
    const body = sender.slice(sender.indexOf('async send(req'), sender.indexOf('catch (err)'))
    expect(body).toMatch(/await recordSendStarted\(new Date\(\)\)/)
    expect(body.indexOf('recordSendStarted')).toBeLessThan(body.indexOf('await sendDm('))
  })

  it('the lock does NOT stamp — a tick that delivers nothing must not reset the clock', () => {
    const lock = src.slice(src.indexOf('heldInThisProcess = true'), src.indexOf('} finally {'))
    expect(lock).not.toMatch(/recordSendStarted/)
    /* And nothing reintroduces an isSend flag whose only meaning was the deleted stamp. */
    expect(src).not.toMatch(/SendLockKind/)
  })

  it('the sender is the only writer of the pace clock', () => {
    /* The reply sweep and the pruner never reach browserSender, so a read structurally
       cannot cost a send's worth of spacing — the property the deleted flag protected. */
    const files = execSync(
      `grep -rln "recordSendStarted(" src --include='*.ts'`,
      { cwd: root, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort()
    expect(files).toEqual(['src/outreach/paceClock.ts', 'src/outreach/senders/browser.ts'])
  })
})

/**
 * ── THE FALLBACK THAT SWALLOWED THE FIX ───────────────────────────────────
 *
 * The first version of `lastSendStartedAt` returned `max(started, completed)` — "the later of
 * the two clocks is safer". It is not: a send COMPLETES ~47s after that same send STARTS, so
 * the max is the completion every single time, and the fix silently reinstated the behaviour
 * it removed. It was DEPLOYED, the agent restarted, and the measured period came back **106.8s
 * against a 107s baseline** — no change at all — while every source-grep above passed, because
 * the caller really did read the new function.
 *
 * A grep cannot see which branch of a comparison returns. So the comparison is its own pure
 * function now, driven in the direction that failed.
 */
describe('gapClock — which clock wins', () => {
  const start = new Date('2026-08-21T05:41:48.000Z')
  const completedLater = new Date('2026-08-21T05:42:34.000Z') // the same send, 46s later

  it('the START wins even though the completion is LATER — the exact bug', () => {
    expect(gapClock(start, completedLater)).toBe(start)
  })

  it('falls back to the completion only when there is no stamp', () => {
    expect(gapClock(null, completedLater)).toBe(completedLater)
  })

  it('a fleet that has never sent has no clock at all', () => {
    expect(gapClock(null, null)).toBeNull()
  })
})
