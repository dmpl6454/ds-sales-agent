import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Page } from 'patchright'

/**
 * AUDIT C1 (2026-10-09): THE INBOX ROUTE COULD MESSAGE THE WRONG ACCOUNT.
 *
 * Blocker 4's route — inbox → compose → type the handle → click the result → Chat — clicked a
 * result row matched case-INsensitively, so a display name satisfied it (@tips and @tips_india
 * both display "TIPS"), and nothing between that click and `return true` read who had been
 * selected. Every later guard is blind to the recipient under the single template, so the
 * pitch, a request Accept, and the stored thread URL could all land on a stranger.
 *
 * The fix asks the opened conversation WHO it is with, twice in a row, and refuses unless it
 * names exactly this recipient. Everything that decides is PURE and tested here in both
 * directions; the page read is driven through a fake page, because the order inside the
 * refusal — a checkpoint outranks "could not confirm" — is a property no grep can prove.
 */

const log = vi.hoisted(() => ({ info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() }))
vi.mock('@/lib/logger', () => ({ log }))

const {
  threadUrlOk,
  profileHandleFromHref,
  requestPanelHandle,
  decideThreadRecipient,
  firstStableVerdict,
  RecipientUnconfirmedError,
  confirmInboxThreadRecipient,
  requireConfirmedRecipient,
  CONFIRM_MAX_MS,
  CONFIRM_POLL_MS,
} = await import('@/outreach/browser/messageEntry')
const { CheckpointError, NotLoggedInError, WrongAccountError } = await import('@/outreach/browser/session')
type RecipientEvidence = import('@/outreach/browser/messageEntry').RecipientEvidence
type ThreadRecipient = import('@/outreach/browser/messageEntry').ThreadRecipient

const THREAD = 'https://www.instagram.com/direct/t/123/'
const pane = (hrefs: string[], url = THREAD): RecipientEvidence => ({ url, kind: 'pane', hrefs })
const request = (prose: string[], url = THREAD): RecipientEvidence => ({ url, kind: 'request', prose })

beforeEach(() => {
  for (const f of Object.values(log)) f.mockReset()
})

describe('threadUrlOk — the conversation-page gate', () => {
  it('accepts /direct/t/<digits> on Instagram itself, with or without the trailing slash', () => {
    expect(threadUrlOk('https://www.instagram.com/direct/t/123/')).toBe(true)
    expect(threadUrlOk('https://www.instagram.com/direct/t/18098292211925958')).toBe(true)
    expect(threadUrlOk('https://instagram.com/direct/t/1/')).toBe(true)
  })

  /**
   * THE CHIP-OVERLAY CASE. The target's own PROFILE carrying a `next=` parameter contains the
   * thread path as a substring; an unanchored regex accepts it, and a profile page is full of
   * links to its owner — it would confirm whoever's profile it is.
   */
  it('REFUSES the target profile whose query string merely contains /direct/t/<id>', () => {
    expect(threadUrlOk('https://www.instagram.com/tips/?next=/direct/t/123')).toBe(false)
  })

  it('refuses everything else that is not exactly a conversation page', () => {
    expect(threadUrlOk('https://www.instagram.com/tips/')).toBe(false)
    expect(threadUrlOk('https://www.instagram.com/direct/inbox/')).toBe(false)
    expect(threadUrlOk('https://www.instagram.com/direct/t/abc/')).toBe(false)
    expect(threadUrlOk('https://www.instagram.com/direct/t/123/extra/')).toBe(false)
    expect(threadUrlOk('https://evil.example/direct/t/123/')).toBe(false)
    expect(threadUrlOk('not a url')).toBe(false)
    expect(threadUrlOk('')).toBe(false)
  })
})

describe('profileHandleFromHref — a link to a PROFILE, and nothing else', () => {
  it('reads a relative or absolute one-segment profile link, lower-cased', () => {
    expect(profileHandleFromHref('/tips_india/')).toBe('tips_india')
    expect(profileHandleFromHref('https://www.instagram.com/Tips/')).toBe('tips')
    expect(profileHandleFromHref('/audionirvana.in/?hl=en')).toBe('audionirvana.in')
  })

  it("refuses posts, sections, threads and anything deeper than one segment", () => {
    expect(profileHandleFromHref('/p/DcyE65LPYMj/')).toBeNull()
    expect(profileHandleFromHref('/explore/')).toBeNull()
    expect(profileHandleFromHref('/direct/t/123/')).toBeNull()
    expect(profileHandleFromHref('/direct/')).toBeNull()
    expect(profileHandleFromHref('/challenge/')).toBeNull()
    expect(profileHandleFromHref('/tips/reels/')).toBeNull()
    expect(profileHandleFromHref('/')).toBeNull()
  })

  it('refuses another host, and a segment no username could be', () => {
    expect(profileHandleFromHref('https://evil.example/tips/')).toBeNull()
    expect(profileHandleFromHref('/tips-india/')).toBeNull()
    expect(profileHandleFromHref('/' + 'a'.repeat(31) + '/')).toBeNull()
  })
})

describe('requestPanelHandle — the OBSERVED request prose names the username', () => {
  it('reads the username from the parentheses', () => {
    expect(requestPanelHandle('Accept message request from Soham Rockstar Entertainment (sohamrockstrent)?')).toBe(
      'sohamrockstrent',
    )
  })

  /** A display name is free text; the username is the LAST group before the "?". */
  it('the LAST parenthesised group wins, so a display name cannot spoof the username', () => {
    expect(requestPanelHandle('Accept message request from TIPS (tips) (tips_india)?')).toBe('tips_india')
  })

  it('reads nothing from prose that does not end in a parenthesised username', () => {
    expect(requestPanelHandle('Accept message request from TIPS?')).toBeNull()
    expect(requestPanelHandle('TIPS (tips)?')).toBeNull()
    expect(requestPanelHandle('Accept message request from TIPS (tips)? Block Delete Accept')).toBeNull()
  })
})

describe('decideThreadRecipient — exactly this recipient, or a refusal', () => {
  it('confirms a conversation whose only profile link is the recipient', () => {
    expect(decideThreadRecipient(pane(['/tips/']), 'tips', 'bollywoodchronicle')).toEqual({ kind: 'confirmed' })
    // A stored handle with capitals is the same account.
    expect(decideThreadRecipient(pane(['/tips/']), 'Tips', 'bollywoodchronicle')).toEqual({ kind: 'confirmed' })
  })

  /** THE C1 CASE: the conversation names somebody else entirely. */
  it('a conversation naming only someone else is a MISMATCH', () => {
    expect(decideThreadRecipient(pane(['/tips_india/']), 'tips', 's')).toEqual({ kind: 'mismatch', seen: ['tips_india'] })
  })

  /** A partial view must never confirm: the target AND someone else is not "the target". */
  it('the recipient beside someone else is AMBIGUOUS, never confirmed', () => {
    expect(decideThreadRecipient(pane(['/tips/', '/xyz/']), 'tips', 's')).toEqual({ kind: 'ambiguous', seen: ['tips', 'xyz'] })
  })

  it('no profile link at all is UNKNOWN — `every()` over nothing is not a confirmation', () => {
    expect(decideThreadRecipient(pane([]), 'tips', 's').kind).toBe('unknown')
    expect(decideThreadRecipient(pane(['/p/abc/', '/explore/']), 'tips', 's').kind).toBe('unknown')
  })

  it('our own page is not evidence about the recipient — and a pane naming only us is unknown', () => {
    expect(decideThreadRecipient(pane(['/bollywoodchronicle/', '/tips/']), 'tips', 'bollywoodchronicle')).toEqual({
      kind: 'confirmed',
    })
    expect(decideThreadRecipient(pane(['/s/']), 's_target', 's').kind).toBe('unknown')
    expect(decideThreadRecipient(pane(['/bollywoodchronicle/']), 'tips', 'BollywoodChronicle').kind).toBe('unknown')
  })

  /** The URL gate runs FIRST: a profile page full of the target's own links confirms nothing. */
  it('a page that is not a conversation is UNKNOWN however its links read', () => {
    const v = decideThreadRecipient(pane(['/tips/'], 'https://www.instagram.com/tips/?next=/direct/t/123'), 'tips', 's')
    expect(v.kind).toBe('unknown')
  })

  it('a request panel is judged from its prose', () => {
    expect(decideThreadRecipient(request(['Accept message request from TIPS (tips)?']), 'tips', 's')).toEqual({ kind: 'confirmed' })
    expect(decideThreadRecipient(request(['Accept message request from TIPS (tips_india)?']), 'tips', 's')).toEqual({
      kind: 'mismatch',
      seen: ['tips_india'],
    })
    expect(decideThreadRecipient(request(['Accept message request from TIPS (tips) (tips_india)?']), 'tips', 's').kind).toBe(
      'mismatch',
    )
    expect(decideThreadRecipient(request(['Accept message request from TIPS']), 'tips', 's').kind).toBe('unknown')
  })

  it('no evidence is unknown, carrying the reason', () => {
    expect(decideThreadRecipient({ url: THREAD, kind: 'none', why: 'no composer and no request panel' }, 'tips', 's')).toEqual({
      kind: 'unknown',
      why: 'no composer and no request panel',
    })
  })
})

describe('firstStableVerdict — one reading never confirms', () => {
  const C: ThreadRecipient = { kind: 'confirmed' }
  const U: ThreadRecipient = { kind: 'unknown', why: 'x' }
  const M = (seen: string[]): ThreadRecipient => ({ kind: 'mismatch', seen })

  it('a single confirmed reading is not enough', () => {
    expect(firstStableVerdict([C]).kind).toBe('unknown')
    expect(firstStableVerdict([]).kind).toBe('unknown')
  })

  it('two readings that disagree settle nothing', () => {
    expect(firstStableVerdict([C, M(['tips_india'])]).kind).toBe('unknown')
    expect(firstStableVerdict([M(['a']), M(['b'])]).kind).toBe('unknown')
    expect(firstStableVerdict([C, U, C]).kind).toBe('unknown')
  })

  it('two consecutive identical readings settle it', () => {
    expect(firstStableVerdict([U, C, C])).toEqual(C)
    expect(firstStableVerdict([C, M(['x']), M(['x'])])).toEqual(M(['x']))
  })
})

describe('RecipientUnconfirmedError', () => {
  /**
   * `replyCheck.ts` regex-tests a thrown message for /checkpoint|challenge|suspend/i to decide
   * whether to HALT AN ACCOUNT. Any handle — ours, the target's, one seen in the thread — can
   * contain those words, so the message names nobody.
   */
  it('carries a FIXED message that names nobody and cannot read as a checkpoint', () => {
    const e = new RecipientUnconfirmedError({ kind: 'mismatch', seen: ['challenge.suspend', 'checkpoint.page'] })
    expect(e.message).not.toMatch(/checkpoint|challenge|suspend/i)
    expect(e.message).not.toMatch(/@/)
    expect(e.verdict).toEqual({ kind: 'mismatch', seen: ['challenge.suspend', 'checkpoint.page'] })
  })

  /** browser.ts maps both of these to `sessionInvalid: true` — a dead SENDER session. */
  it('is not a session error, so it can never mark the sender logged out', () => {
    const e = new RecipientUnconfirmedError({ kind: 'unknown', why: 'x' })
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(WrongAccountError)
    expect(e).not.toBeInstanceOf(NotLoggedInError)
    expect(e).not.toBeInstanceOf(CheckpointError)
  })
})

// ── the page read, through a fake page ──────────────────────────────────────

/**
 * Just what `confirmInboxThreadRecipient` and `assertNoEnforcement` touch: the URL, one
 * `evaluate` per reading (scripted), a wait that resolves at once, and the dialog/alert
 * locators the enforcement check reads.
 */
function fakePage(opts: { url?: string; readings: RecipientEvidence[]; dialogText?: string }) {
  let i = 0
  const page = {
    url: () => opts.url ?? THREAD,
    evaluate: vi.fn(async () => opts.readings[Math.min(i++, opts.readings.length - 1)]),
    waitForTimeout: async () => undefined,
    locator: (sel: string) => ({
      count: async () => (opts.dialogText !== undefined && sel === '[role="dialog"]' ? 1 : 0),
      nth: () => ({ textContent: async () => opts.dialogText ?? '' }),
    }),
  }
  return page as typeof page & Page
}

describe('confirmInboxThreadRecipient — polls until two readings agree, bounded', () => {
  it('confirms after two agreeing readings, and stops reading', async () => {
    const page = fakePage({ readings: [pane(['/tips/']), pane(['/tips/']), pane(['/xyz/'])] })
    const r = await confirmInboxThreadRecipient(page, 'tips', 's')
    expect(r.verdict).toEqual({ kind: 'confirmed' })
    expect(page.evaluate).toHaveBeenCalledTimes(2)
  })

  it('a reading that confirms and then changes does not confirm', async () => {
    const page = fakePage({ readings: [pane(['/tips/']), pane(['/tips/', '/xyz/']), pane(['/tips/', '/xyz/'])] })
    const r = await confirmInboxThreadRecipient(page, 'tips', 's')
    expect(r.verdict.kind).toBe('ambiguous')
  })

  /** A page whose waits resolve instantly must not spin forever: the count bounds it. */
  it('gives up as unknown after a bounded number of readings', async () => {
    const page = fakePage({ readings: [{ url: THREAD, kind: 'none', why: 'no composer and no request panel' }] })
    const r = await confirmInboxThreadRecipient(page, 'tips', 's')
    expect(r.verdict.kind).toBe('unknown')
    expect(r.evidence.kind).toBe('none')
    expect(page.evaluate.mock.calls.length).toBeLessThanOrEqual(Math.ceil(CONFIRM_MAX_MS / CONFIRM_POLL_MS) + 1)
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(2)
  })
})

describe('requireConfirmedRecipient — the refusal, and what outranks it', () => {
  it('returns quietly when the conversation names exactly the recipient', async () => {
    const page = fakePage({ readings: [pane(['/tips/'])] })
    await expect(requireConfirmedRecipient(page, 'tips', 's')).resolves.toBeUndefined()
    expect(log.alarm).not.toHaveBeenCalled()
  })

  it('THROWS RecipientUnconfirmedError on a mismatch, and alarms with the evidence', async () => {
    const page = fakePage({ readings: [pane(['/tips_india/', '/p/abc/'])] })
    const err = await requireConfirmedRecipient(page, 'tips', 's').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipientUnconfirmedError)
    expect((err as InstanceType<typeof RecipientUnconfirmedError>).verdict).toEqual({ kind: 'mismatch', seen: ['tips_india'] })
    expect(log.alarm).toHaveBeenCalledOnce()
    const fields = log.alarm.mock.calls[0]![1] as Record<string, string>
    // The evidence a first live refusal must leave behind: where it was and what it saw.
    expect(fields.path).toBe('/direct/t/123/')
    expect(fields.hrefs).toContain('/tips_india/')
  })

  /** A correct thread whose card links a mutual follower must not raise a wrong-account alarm. */
  it('an ambiguous or unknown verdict refuses with a WARNING, not a wrong-account alarm', async () => {
    const amb = await requireConfirmedRecipient(fakePage({ readings: [pane(['/tips/', '/xyz/'])] }), 'tips', 's').catch((e: unknown) => e)
    expect(amb).toBeInstanceOf(RecipientUnconfirmedError)
    const unk = await requireConfirmedRecipient(fakePage({ readings: [pane([])] }), 'tips', 's').catch((e: unknown) => e)
    expect(unk).toBeInstanceOf(RecipientUnconfirmedError)
    expect(log.alarm).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect((log.warn.mock.calls[1]![1] as Record<string, string>).path).toBe('/direct/t/123/')
  })

  /**
   * THE ORDER INSIDE THE REFUSAL. A /challenge/ redirect after Chat fails the URL gate and reads
   * as "unknown"; filed as recipient-unconfirmed it would release the reservation, never mark
   * the account, and the next tick would drive the flagged account again — a retry into a
   * checkpoint. The session's own error must come out instead.
   */
  it('a checkpoint URL OUTRANKS "could not confirm"', async () => {
    const url = 'https://www.instagram.com/challenge/AbC123/'
    const err = await requireConfirmedRecipient(fakePage({ url, readings: [pane(['/tips/'], url)] }), 'tips', 's').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckpointError)
    expect(err).not.toBeInstanceOf(RecipientUnconfirmedError)
  })

  it('an in-page enforcement notice OUTRANKS it too', async () => {
    const page = fakePage({ readings: [pane([])], dialogText: 'Action Blocked — we restrict certain activity' })
    const err = await requireConfirmedRecipient(page, 'tips', 's').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckpointError)
  })

  it('and so does a login form where a session was expected', async () => {
    const url = 'https://www.instagram.com/accounts/login/?next=/direct/t/123/'
    const err = await requireConfirmedRecipient(fakePage({ url, readings: [pane([], url)] }), 'tips', 's').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotLoggedInError)
  })
})
