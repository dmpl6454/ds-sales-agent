import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * ── AUTOPILOT OFF MUST DRIVE NO BROWSER AT ALL ────────────────────────────
 *
 * OBSERVED BY TABISH, 2026-08-20: he switched autopilot off and Chrome kept opening on his
 * revenue accounts. Every layer was "correct" — the dispatcher held with `autopilot-off` on
 * every tick and ZERO messages were delivered after the switch — and the reply sweep drove a
 * real browser into a real account every thirty minutes anyway, because reading is not
 * sending and nothing asked the switch.
 *
 * The one control the product offers has to mean *stop touching my accounts*.
 *
 * ── WHY THIS IS BEHAVIOURAL AND NOT A SOURCE GREP ──────────────────────────
 *
 * It WAS a grep — "the switch is read before the thread read" — and mutation-testing it
 * killed it: deleting the early return left `autopilotEnabled` sitting above
 * `checkForReplies`, so the grep passed against the one edit that reopens the hole. A grep
 * proves a fact is consulted; only calling the function proves it gates. So this drives
 * `replyPass` and asserts `checkForReplies` is never reached.
 */

const getSettings = vi.fn()
const checkForReplies = vi.fn()
const withSendLock = vi.fn()

vi.mock('@/lib/settings', () => ({ getSettings: (...a: unknown[]) => getSettings(...a) }))
vi.mock('@/outreach/replyCheck', () => ({ checkForReplies: (...a: unknown[]) => checkForReplies(...a) }))
vi.mock('@/outreach/dispatcher', () => ({
  dispatchTick: vi.fn(),
  withSendLock: (...a: unknown[]) => withSendLock(...a),
}))
// The agent imports these at module scope; none of them are exercised by `replyPass`.
vi.mock('@/lib/db', () => ({ prisma: { senderAccount: { findMany: vi.fn() }, setting: { findUnique: vi.fn(), upsert: vi.fn() } } }))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: () => ({ hasSession: false, dir: '', initialised: false }) }))
vi.mock('@/agent/reconcile', () => ({ reconcileSessionRecords: vi.fn() }))
vi.mock('@/detection/autoResolve', () => ({ autoResolveBrands: vi.fn() }))
vi.mock('@/detection/officialDiscovery', () => ({ discoverOfficialPages: vi.fn() }))

const { replyPass } = await import('@/agent/index')

beforeEach(() => {
  getSettings.mockReset()
  checkForReplies.mockReset().mockResolvedValue({ checked: 0, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0 })
  // The real wrapper runs its callback; this stands in for it so the test measures the
  // GATE rather than the lock.
  /**
   * `withSendLock(what, { isSend }, fn)` since 2026-08-21 — the send/read distinction is a
   * REQUIRED field so the compiler names every call site, and it named this mock: with the
   * old two-argument shape the callback landed in the options slot and the sweep silently
   * never ran. Asserting `isSend: false` here is the point rather than an aside — a reply
   * READ must not stamp the fleet's pace clock and cost a send's worth of spacing.
   */
  withSendLock
    .mockReset()
    .mockImplementation(async (_label: string, kind: { isSend: boolean }, fn: () => Promise<unknown>) => {
      expect(kind.isSend, 'the reply sweep is a READ — it must not stamp the send pace clock').toBe(false)
      return fn()
    })
})

describe('the reply sweep and the autopilot switch', () => {
  it('opens NO browser when autopilot is off', async () => {
    getSettings.mockResolvedValue({ autopilotEnabled: false })
    await replyPass()
    expect(checkForReplies, 'the sweep read threads with the switch off — Chrome would open on a revenue account').not.toHaveBeenCalled()
    expect(withSendLock, 'it took the send lock before even asking the switch').not.toHaveBeenCalled()
  })

  /** The permitting direction, or the gate could be an outage wearing caution's clothes. */
  it('reads threads when autopilot is on', async () => {
    getSettings.mockResolvedValue({ autopilotEnabled: true })
    await replyPass()
    expect(checkForReplies, 'the sweep never ran with the switch ON — replies would go undetected').toHaveBeenCalledTimes(1)
  })

  /**
   * FAILS CLOSED. "We could not read the switch" must not authorise a browser — the same
   * direction as `identify()`'s `no-answer`, which this codebase paid for once by recording
   * a live revenue session as dead.
   */
  it('stays put when the switch cannot be read at all', async () => {
    getSettings.mockRejectedValue(new Error('database unreachable'))
    await expect(replyPass()).resolves.toBeUndefined()
    expect(checkForReplies, 'an unreadable switch was treated as permission').not.toHaveBeenCalled()
  })
})

/**
 * A DIFFERENT QUESTION from the tests above, which is why it is a source check and not a
 * behavioural one: has a NEW browser driver appeared on the agent that nobody gated? The
 * reply sweep arrived exactly that way — added in a later session, correct on its own
 * terms, and never asked the switch. No behavioural test can fail for a caller that does
 * not exist yet.
 */
describe('no ungated browser driver may be added to the agent', () => {
  it('the agent reaches Chrome only through the two callers that ask the switch', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    // `dispatchTick` asks the switch itself (inside `decideDispatch`); `checkForReplies`
    // is gated by `replyPass`, asserted above. Anything else that launches a profile is
    // a new decision and must be gated and listed here.
    for (const driver of ['launchProfile', 'browserSender', 'openAndReadThread', 'sendDm', 'connectAccount']) {
      expect(
        src.includes(driver),
        `${driver} is now called from the device agent. If it drives a browser it must ask ` +
          `autopilotEnabled first, fail closed, and be covered by a behavioural test like the ones above.`,
      ).toBe(false)
    }
  })
})
