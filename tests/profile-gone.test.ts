import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/*
 * The browser seam for the dead-page tests at the bottom: the session never launches Chrome,
 * and the profile doors (`clickMessageEntry`) are shut, so each path reaches exactly the branch
 * that decides between "dead page" and "try the inbox route". Everything else in messageEntry
 * is the real implementation. The other tests in this file touch none of these modules.
 */
const browser = vi.hoisted(() => ({
  context: null as unknown,
  clickMessageEntry: vi.fn(),
  openThreadViaInbox: vi.fn(),
}))
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/outreach/browser/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/session')>()),
  launchProfile: async () => browser.context,
  assertNoCheckpoint: () => undefined,
  assertLoggedInAs: async () => undefined,
  assertNoEnforcement: async () => undefined,
}))
vi.mock('@/outreach/browser/messageEntry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/messageEntry')>()),
  clickMessageEntry: browser.clickMessageEntry,
  openThreadViaInbox: browser.openThreadViaInbox,
  dismissBlockingDialog: async () => false,
  passBusinessInterstitial: async () => undefined,
  acceptMessageRequest: async () => false,
  jitter: async () => undefined,
}))

import { splitParks, PROFILE_GONE_RECHECK_DAYS } from '../src/outreach/parkedRows'
import { FAILURE_CODES } from '../src/lib/constants'
import { shouldReleaseOnFailure } from '../src/outreach/reservations'

/**
 * @hemantpandeyji (9 Sept 2026): a verified prospect whose page vanished; four senders each drove
 * Chrome at it three times. A gone page is a fact about the RECIPIENT, so it must stop every pair,
 * be recognised before a drive, and be parked on first sight rather than retried.
 */
const day = 86_400_000
const now = new Date('2026-09-09T07:00:00Z')
const row = (senderId: string, failureCode: string, agoMs: number) => ({ failureCode, queuedAt: new Date(now.getTime() - agoMs), pair: { senderId } })

describe('splitParks — one query, two facts', () => {
  it("a profile-gone park from ANOTHER sender stops this pair too", () => {
    const r = splitParks([row('b', 'profile-gone', 2 * day)], 'a', now)
    expect(r.targetProfileGoneAt).toEqual(new Date(now.getTime() - 2 * day))
    expect(r.parkedFailureCode).toBeNull()
  })
  it('the pair-level park is still only this pair\'s, in the old order (failureCode asc, newest first)', () => {
    const r = splitParks([row('b', 'no-composer', day), row('a', 'not-in-thread', day), row('a', 'no-composer', 3 * day)], 'a', now)
    expect(r.parkedFailureCode).toBe('no-composer')
    expect(r.targetProfileGoneAt).toBeNull()
  })
  it('a profile-gone park older than the window has expired — the recipient is asked about again', () => {
    const r = splitParks([row('b', 'profile-gone', (PROFILE_GONE_RECHECK_DAYS + 1) * day)], 'a', now)
    expect(r.targetProfileGoneAt).toBeNull()
  })
  it('an unreadable read never counts as a park', () => {
    expect(splitParks([row('a', 'unreadable', day)], 'a', now).parkedFailureCode).toBeNull()
  })
})

describe('profile-gone is a failure code that releases its reservation', () => {
  it('is in the vocabulary and definitely not delivered', () => {
    expect(FAILURE_CODES).toContain('profile-gone')
    expect(shouldReleaseOnFailure('profile-gone')).toBe(true)
  })
})

describe('the delivery path asks before it drives, and parks on first sight', () => {
  const src = readFileSync('src/outreach/deliver.ts', 'utf8')
  it('probeHandle runs BEFORE browserSender.send', () => {
    const probe = src.indexOf('await probeHandle(target.handle)')
    const drive = src.indexOf('await browserSender.send({')
    expect(probe).toBeGreaterThan(0)
    expect(drive).toBeGreaterThan(probe)
  })
  it("a 'profile-gone' outcome parks FAILED without a retry", () => {
    const branch = src.indexOf("if (failureCode === 'profile-gone')")
    const park = src.indexOf("status: 'FAILED'", branch)
    const next = src.indexOf("if (failureCode === 'not-in-thread')")
    expect(branch).toBeGreaterThan(0)
    expect(park).toBeGreaterThan(branch)
    expect(park).toBeLessThan(next)
  })
})

/**
 * A DEAD PAGE NEVER REACHES THE INBOX ROUTE — driven, not grepped.
 *
 * For a deleted or renamed handle the exact username can no longer exist in the inbox's To:
 * search, so only OTHER accounts can be offered there: going to the inbox route at all clicks
 * into a stranger's conversation before the recipient check can refuse it (audit C1, which
 * added the READ path's copy of the guard), and on the send path it is a minute of browser
 * activity from a revenue account for nothing (twelve drives at @hemantpandeyji).
 *
 * These used to be `indexOf` greps on raw source, and they could not fail: the first "Sorry,
 * this page isn't available" in sendDm.ts is a COMMENT, so deleting the real check left the
 * test green, and on the read path `const gone = false && …` kept the string and disabled the
 * guard. Both mutations were run against the old tests and passed. So each path is now DRIVEN
 * through a fake page with the profile doors mocked shut, and the assertion is the behaviour
 * itself: with the dead-page text on screen, `openThreadViaInbox` is never called. Each has a
 * control with the text absent, which must reach the inbox route — otherwise "never called"
 * would pass vacuously on a fake that stopped short of the branch.
 */
describe('a dead page never reaches the inbox route, on either path', () => {
  const DEAD = "Sorry, this page isn't available"
  const SENDER = 'bollywoodchronicle'
  const TARGET = 'hemantpandeyji'

  /** Just what both paths touch before the inbox route: navigation, a scroll, one text lookup. */
  function fakeContext(deadPageShown: boolean) {
    const page = {
      goto: vi.fn(async () => null),
      url: () => `https://www.instagram.com/${TARGET}/`,
      mouse: { wheel: vi.fn(async () => undefined) },
      getByText: vi.fn((text: string) => ({
        first: () => ({ isVisible: async () => deadPageShown && text === DEAD }),
      })),
    }
    const context = { pages: () => [page], newPage: async () => page, close: vi.fn(async () => undefined) }
    browser.context = context
    return { page, context }
  }

  /**
   * sendDm keeps its own human-pause `jitter` (real setTimeouts, seconds long), so time is
   * faked and advanced. The reader's jitter comes from the mocked messageEntry and resolves at
   * once; its six-minute deadline timer is cleared by its `finally` long before 2 minutes.
   */
  async function drive<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const p = run()
      await vi.advanceTimersByTimeAsync(120_000)
      return await p
    } finally {
      vi.useRealTimers()
    }
  }

  beforeEach(() => {
    browser.clickMessageEntry.mockReset().mockResolvedValue({ ok: false })
    browser.openThreadViaInbox.mockReset().mockResolvedValue(false)
  })

  it('send path: the dead page parks as profile-gone and the inbox route is never opened', async () => {
    const { page, context } = fakeContext(true)
    const { sendDm } = await import('../src/outreach/browser/sendDm')
    const r = await drive(() => sendDm({ senderHandle: SENDER, targetHandle: TARGET, body: 'hi', dryRun: true }))
    expect(browser.clickMessageEntry).toHaveBeenCalledOnce()
    expect(page.getByText).toHaveBeenCalledWith(DEAD, { exact: false })
    expect(browser.openThreadViaInbox).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, failureCode: 'profile-gone' })
    expect(context.close).toHaveBeenCalled()
  })

  it('send path control: a live page with no door DOES take the inbox route', async () => {
    const { page } = fakeContext(false)
    const { sendDm } = await import('../src/outreach/browser/sendDm')
    const r = await drive(() => sendDm({ senderHandle: SENDER, targetHandle: TARGET, body: 'hi', dryRun: true }))
    expect(browser.openThreadViaInbox).toHaveBeenCalledExactlyOnceWith(page, TARGET, SENDER)
    expect(r).toMatchObject({ ok: false, failureCode: 'no-message-button' })
  })

  it('read path: the dead page is unreadable and the inbox route is never opened', async () => {
    const { page, context } = fakeContext(true)
    const { openAndReadThread } = await import('../src/outreach/browser/readThread')
    const r = await drive(() => openAndReadThread(SENDER, TARGET, { expected: ['hi'], allOurs: ['hi'] }))
    expect(browser.clickMessageEntry).toHaveBeenCalledOnce()
    expect(page.getByText).toHaveBeenCalledWith(DEAD, { exact: false })
    expect(browser.openThreadViaInbox).not.toHaveBeenCalled()
    // Unreadable, never "no reply": a dead page must not vouch for silence.
    expect(r).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(context.close).toHaveBeenCalled()
  })

  it('read path control: a live page with no door DOES take the inbox route', async () => {
    const { page } = fakeContext(false)
    const { openAndReadThread } = await import('../src/outreach/browser/readThread')
    const r = await drive(() => openAndReadThread(SENDER, TARGET, { expected: ['hi'], allOurs: ['hi'] }))
    expect(browser.openThreadViaInbox).toHaveBeenCalledExactlyOnceWith(page, TARGET, SENDER)
    expect(r).toEqual({ ok: false, reason: 'no-message-button' })
  })
})

/**
 * Audit C1: the inbox route opened a conversation that names somebody ELSE. Parked on FIRST sight
 * by both delivery paths — the generic branch would put it back in READY, and the dispatcher
 * would drive the same search again within ~30 s.
 *
 * Reviewed the same day: only a MISMATCH. An `unknown` or `ambiguous` refusal is what a transient
 * miss at the profile door looks like and arrives flagged `recipientRetryable`, which both paths
 * must read as an OPT-IN (`=== true`) so that a refusal without the flag still parks. The retry
 * behaviour itself is driven end to end in tests/recipient-unconfirmed-retry.test.ts and
 * tests/recipient-unconfirmed-send-now.test.ts.
 */
const OPT_IN = /const recipientRetryable = outcome\.status === 'FAILED' && outcome\.recipientRetryable === true/
describe('a recipient-unconfirmed MISMATCH parks on first sight, on both send paths', () => {
  it('deliver.ts parks it FAILED at the cap, before the not-in-thread branch', () => {
    const src = readFileSync('src/outreach/deliver.ts', 'utf8')
    expect(src).toMatch(OPT_IN)
    const branch = src.indexOf("if (failureCode === 'recipient-unconfirmed' && !recipientRetryable)")
    const next = src.indexOf("if (failureCode === 'not-in-thread')")
    expect(branch).toBeGreaterThan(0)
    expect(next).toBeGreaterThan(branch)
    const body = src.slice(branch, next)
    expect(body).toMatch(/status: 'FAILED'/)
    expect(body).toMatch(/attempts: MAX_DELIVERY_ATTEMPTS/)
    expect(body).toMatch(/continue/)
  })

  it("actions.ts sendNow parks it before its generic return-to-READY branch", () => {
    const src = readFileSync('src/app/actions.ts', 'utf8')
    const fnStart = src.indexOf('export async function sendNow(')
    const fnEnd = src.indexOf('\nexport ', fnStart + 1)
    const fn = src.slice(fnStart, fnEnd)
    expect(fn).toMatch(OPT_IN)
    const branch = fn.indexOf("if (failureCode === 'recipient-unconfirmed' && !recipientRetryable)")
    const generic = fn.indexOf('// Everything else: leave the draft intact')
    expect(branch).toBeGreaterThan(0)
    expect(generic).toBeGreaterThan(branch)
    const body = fn.slice(branch, generic)
    expect(body).toMatch(/status: 'FAILED'/)
    expect(body).toMatch(/attempts: MAX_DELIVERY_ATTEMPTS/)
    expect(body).toMatch(/return \{/)
  })
})
