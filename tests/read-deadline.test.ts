/**
 * THE REPLY READ HAS A DEADLINE, AND WHAT IT MUST NOT BE MISTAKEN FOR.
 *
 * MEASURED 2026-08-20: one conversation read hung 88 minutes while the database tunnel
 * dropped, and because the sweep holds the fleet-wide send lock for its whole duration,
 * the entire fleet stopped sending for those 88 minutes with every screen healthy.
 *
 * Two properties carry the safety here, and neither is about the timeout working:
 *
 *   1. A deadline expiry must NOT match the checkpoint pattern. `checkConversation` tests
 *      the thrown message against /checkpoint|challenge|suspend/i and marks the account
 *      CHALLENGED — which halts the WHOLE FLEET through the circuit breaker. A stalled
 *      network flagging a healthy revenue account would be far worse than the hang.
 *   2. It must surface as `unreadable`, never as "no reply" — otherwise a timeout becomes
 *      an assertion of verified silence and releases the hardest guard in the system.
 *
 * A SOURCE READ for the wiring, because the failure mode is a future edit that "tidies"
 * the catch branch, and no behavioural test can drive a real 6-minute browser hang.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'src/outreach/browser/readThread.ts'), 'utf8')

/** The exact sentence the deadline throws, kept in sync with the source by the test below. */
const DEADLINE_MESSAGE = 'reply read abandoned after 6 minutes — thread could not be read in time'

describe('the reply-read deadline', () => {
  it('is a real bound: minutes, not hours, and not so short it fires on a healthy read', () => {
    const m = /export const READ_DEADLINE_MS = (\d+) \* 60 \* 1000/.exec(src)
    expect(m, 'READ_DEADLINE_MS is gone or no longer expressed in minutes').not.toBeNull()
    const minutes = Number(m![1])
    // A healthy read is 30-60s; the hang this exists for was 88 minutes.
    expect(minutes).toBeGreaterThanOrEqual(2)
    expect(minutes).toBeLessThanOrEqual(15)
  })

  it('NEVER reads as a checkpoint — a timeout must not flag a revenue account', () => {
    expect(
      /checkpoint|challenge|suspend/i.test(DEADLINE_MESSAGE),
      'the deadline message now matches the checkpoint pattern, so a stalled network would ' +
        'mark a healthy sending account CHALLENGED and the circuit breaker would halt the ' +
        'entire fleet on no evidence at all',
    ).toBe(false)
  })

  it('the message the source throws is the one asserted above', () => {
    expect(src).toContain('reply read abandoned after ${READ_DEADLINE_MS / 60_000} minutes')
  })

  it('closing the CONTEXT is the interrupt — never an abandoned promise', () => {
    // Racing the read and walking away would leave a live context on a profile a send
    // could pick up seconds later, and two contexts on one profile is how device
    // identity dies. The bomb must close, and the finally must still close.
    expect(src).toContain('void context.close()')
    expect(src).toMatch(/finally \{[\s\S]*clearTimeout\(deadline\)/)
    expect(src).toMatch(/finally \{[\s\S]*context\.close\(\)/)
  })

  it('throws rather than returning ok — a timed-out read must not report success', () => {
    // The catch converts the expiry to a throw so checkConversation's existing
    // `unreadable` branch handles it and no `replyCheckedAt` is stamped.
    expect(src).toMatch(/if \(deadlineFired\) \{\s*throw new Error/)
  })
})
