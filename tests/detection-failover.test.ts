/**
 * When a DEVICE reads the feeds instead of the server (src/detection/failover.ts), both ways,
 * and a grep that the device agent actually schedules it — a built feature that nothing
 * calls is not running (this repo has paid for that three times).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DETECTION_FAILOVER_AFTER_MS, decideDetectionFailover } from '@/detection/failover'

const now = new Date('2026-09-07T08:00:00Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)

describe('decideDetectionFailover', () => {
  it('runs when the server has recorded a cooldown that is still in the future', () => {
    const d = decideDetectionFailover({ feedOkAt: minutesAgo(1), serverThrottledUntil: new Date(now.getTime() + 60_000), thisHostGateOpen: true, now })
    expect(d.run).toBe(true)
  })
  it('an EXPIRED server cooldown is not a reason on its own', () => {
    const d = decideDetectionFailover({ feedOkAt: minutesAgo(1), serverThrottledUntil: minutesAgo(1), thisHostGateOpen: true, now })
    expect(d.run).toBe(false)
  })
  it('runs when no host has fetched a feed page for longer than the threshold', () => {
    const past = new Date(now.getTime() - DETECTION_FAILOVER_AFTER_MS - 1)
    expect(decideDetectionFailover({ feedOkAt: past, serverThrottledUntil: null, thisHostGateOpen: true, now }).run).toBe(true)
    const recent = new Date(now.getTime() - DETECTION_FAILOVER_AFTER_MS + 1)
    expect(decideDetectionFailover({ feedOkAt: recent, serverThrottledUntil: null, thisHostGateOpen: true, now }).run).toBe(false)
  })
  it('NEVER runs while this machine is in its own cooldown — its IP was told to wait too', () => {
    const d = decideDetectionFailover({ feedOkAt: minutesAgo(600), serverThrottledUntil: new Date(now.getTime() + 60_000), thisHostGateOpen: false, now })
    expect(d.run).toBe(false)
    expect(d.reason).toMatch(/this machine/)
  })
  it('"never recorded" is unknown, not blind — a fresh deployment does not double its volume', () => {
    const d = decideDetectionFailover({ feedOkAt: null, serverThrottledUntil: null, thisHostGateOpen: true, now })
    expect(d.run).toBe(false)
    expect(d.reason).toMatch(/unknown/)
  })
})

describe('the device agent schedules it', () => {
  it('calls detectionFailoverPass on an interval and once at startup', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'agent', 'index.ts'), 'utf8')
    expect(src).toMatch(/void detectionFailoverPass\(\)\n\s+const failover = setInterval\(\(\) => void detectionFailoverPass\(\), DETECTION_FAILOVER_INTERVAL_MS\)/)
    expect(src).toMatch(/decideDetectionFailover\(\{/)
    expect(src).toMatch(/thisHostGateOpen: anonGateCheck\(\)\.ok/)
  })
})
