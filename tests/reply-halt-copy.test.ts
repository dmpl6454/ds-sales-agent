import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  replyHaltSpan,
  replyHaltRule,
  replyAlarmHeadline,
  replyFeedSentence,
  replyLede,
  replyBlockerCopy,
  prospectReplyNote,
  prospectTargetHaltSentence,
  replyHeldDetail,
  replyRouteReason,
  replyQueueHold,
  restReplyLabel,
  replyBlocksEveryPage,
} from '../src/outreach/replyHaltCopy'

/**
 * EVERY REPLY SENTENCE, IN BOTH SCOPES — audit H9.
 *
 * Under `pair` (Tabish's choice, 2026-09-01) a reply pauses only the page it reached, and rotation
 * hands the turn on. Every screen said the opposite, and every one hard-coded "seven days" while the
 * window is a Setting. Both scopes are driven, so the one switched off stays honest — the same
 * discipline `crossPageGapHours` at 0 and the active-hours window at 0/0 have.
 */

const FLEET_WIDE = /every (account|one of our pages)|all outreach|outreach to them is/i
const HOURS = 168

describe('the window, in words, for every value the Setting accepts', () => {
  it.each([
    [1, '1 hour'],
    [5, '5 hours'],
    [24, 'one day'],
    [36, '36 hours'],
    [48, 'two days'],
    [168, 'seven days'],
    [240, 'ten days'],
    [264, '11 days'],
    [8760, '365 days'],
  ])('%i hours → %s', (h, words) => {
    expect(replyHaltSpan(h)).toBe(words)
  })
})

describe('pair scope never says every page pauses; target scope always does', () => {
  const pairOut = [
    replyHaltRule('pair', HOURS),
    replyAlarmHeadline('pair', { count: 1, name: 'Nykaa' }),
    replyAlarmHeadline('pair', { count: 3, name: 'Nykaa' }),
    replyFeedSentence('pair', { target: 'Nykaa', senderHandle: 'pap', state: 'holding', hours: HOURS }),
    replyLede('pair'),
    replyBlockerCopy('pair', 1, HOURS).headline,
    replyBlockerCopy('pair', 2, HOURS).verdict,
    prospectReplyNote('pair', { senderHandles: ['pap'], freesIst: '16 Oct 2026, 10:00' }, true)!,
    replyQueueHold('pair', HOURS),
    restReplyLabel('pair', HOURS),
  ]
  const targetOut = [
    replyHaltRule('target', HOURS),
    replyAlarmHeadline('target', { count: 1, name: 'Nykaa' }),
    replyFeedSentence('target', { target: 'Nykaa', senderHandle: 'pap', state: 'holding', hours: HOURS }),
    replyLede('target'),
    replyBlockerCopy('target', 2, HOURS).verdict,
    prospectReplyNote('target', { senderHandles: ['pap'], freesIst: '16 Oct 2026, 10:00' }, true)!,
    restReplyLabel('target', HOURS),
  ]

  it.each(pairOut.map((s) => [s]))('pair: %s', (s) => {
    expect(s).not.toMatch(FLEET_WIDE)
  })
  it.each(targetOut.map((s) => [s]))('target: %s', (s) => {
    expect(s).toMatch(FLEET_WIDE)
  })

  it('pair names what IS paused', () => {
    expect(replyHaltRule('pair', HOURS)).toMatch(/only the page it was sent to/)
    expect(replyLede('pair')).toMatch(/Only the page they answered/)
    expect(replyFeedSentence('pair', { target: 'Nykaa', senderHandle: 'pap', state: 'holding', hours: HOURS })).toContain('@pap')
  })

  /** The fallback direction: an unreadable scope reads as `target` at the gate, so it does on screen. */
  it('anything but "pair" gets the WIDER sentence', () => {
    expect(replyBlocksEveryPage('pair')).toBe(false)
    expect(replyBlocksEveryPage('target')).toBe(true)
    expect(replyBlocksEveryPage('targt')).toBe(true)
    expect(replyHaltRule('targt', HOURS)).toMatch(FLEET_WIDE)
  })
})

describe('the window is the Setting, never a literal', () => {
  it.each([
    ['rule', (h: number) => replyHaltRule('pair', h)],
    ['blocker', (h: number) => replyBlockerCopy('target', 1, h).verdict],
    ['feed (released)', (h: number) => replyFeedSentence('pair', { target: 'X', senderHandle: 'a', state: 'released', hours: h })],
    ['route reason', (h: number) => replyRouteReason(h)],
    ['queue hold', (h: number) => replyQueueHold('pair', h)],
    ['rest label', (h: number) => restReplyLabel('target', h)],
  ])('%s', (_name, f) => {
    expect(f(48)).toContain('two days')
    expect(f(48)).not.toContain('seven days')
    expect(f(36)).toContain('36 hours')
  })
})

describe('the sentences that must not over-claim', () => {
  /** An undated reply halts NOTHING (replyHalt.ts) — "the pause has since released" would invent one. */
  it('an undated reply never says a pause released', () => {
    const s = replyFeedSentence('pair', { target: 'X', senderHandle: 'a', state: 'undated', hours: HOURS })
    expect(s).not.toMatch(/released|pause has/)
    expect(s).toMatch(/no date/)
  })

  /** With one page in the ring, the same /targets row says "Nothing will be written". */
  it('/targets says other pages may still write ONLY when this row’s own turn says one will', () => {
    const replies = { senderHandles: ['pap'], freesIst: '16 Oct 2026, 10:00' }
    expect(prospectReplyNote('pair', replies, true)).toMatch(/other pages may still write/)
    expect(prospectReplyNote('pair', replies, false)).not.toMatch(/other pages may still write/)
    expect(prospectReplyNote('pair', null, true)).toBeNull()
  })

  it('/targets names every page a reply reached, and when the last frees', () => {
    const note = prospectReplyNote('pair', { senderHandles: ['a', 'b'], freesIst: '16 Oct 2026, 10:00' }, false)!
    expect(note).toMatch(/@a and @b — those pages are paused until 16 Oct 2026, 10:00 IST/)
    expect(prospectTargetHaltSentence('16 Oct 2026, 10:00')).toMatch(/every page/)
  })

  /** The gate's detail reaches `/` through the dispatcher's hold reasons; true under BOTH scopes. */
  it('the gate’s detail speaks for this page only, and promises no person', () => {
    const d = replyHeldDetail('2026-10-09T10:00:00.000Z')
    expect(d).toContain('2026-10-09T10:00:00.000Z')
    expect(d).toMatch(/this page's messages/)
    expect(d).not.toMatch(FLEET_WIDE)
    expect(d).not.toMatch(/take over/)
  })
})

describe('the copy owner is safe to import from a client component', () => {
  it('imports types only', () => {
    const src = readFileSync(join(__dirname, '../src/outreach/replyHaltCopy.ts'), 'utf8')
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l))
    expect(imports.length).toBeGreaterThan(0)
    for (const l of imports) expect(l).toMatch(/^\s*import type /)
  })
})
