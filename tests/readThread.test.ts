import { describe, it, expect } from 'vitest'
import { assessRead } from '@/outreach/browser/readThread'
import { isOneOfOurs } from '@/outreach/matching'

/**
 * ── a read can SUCCEED and still not have seen the conversation ────────────
 *
 * MEASURED LIVE 2026-08-05. Two consecutive reads of the same thread returned "1 message, no
 * reply" and then "6 messages, they replied twice". The truth was two replies.
 *
 * Instrumenting the page explained it: after clicking Message the composer becomes visible at
 * ~1528 ms with all six bubbles present, and at ~2528 ms the DOM RESTRUCTURES so that exactly
 * one bubble still matches the selector — permanently, and scrolling does not recover them.
 * `openAndReadThread` slept `jitter(2000, 3500)` before reading, so the read landed either
 * side of that boundary depending on a random number.
 *
 * **The completeness of the hardest safety guard in the system was decided by a jitter**, and
 * the losing side is the silent, permissive one: a thread showing only our own newest message
 * reports "no reply", `replyCheckedAt` is stamped as verified silence, and the next follow-up
 * fires into a live conversation.
 *
 * Note the shape — it is not that the read FAILED. It succeeded and returned a truthful
 * subset. `unreadable` was carefully designed against; this walked straight around it.
 *
 * So completeness is checked, and checked against something we already know: which bodies we
 * delivered to this pair.
 */

const OURS_A = [
  'Hi Bollywood Chronicle,',
  '',
  'I run a network of two hundred entertainment pages with sixty million followers combined.',
  '',
  'Looking forward to connecting.',
].join('\n')

const OURS_B = [
  'Hi Bollywood Chronicle,',
  '',
  'Following up: we can put an annual calendar together across the whole owned network.',
  '',
  'Looking forward to connecting.',
].join('\n')

const THEIRS = 'Hi'

const bubble = (text: string, ourBodies: readonly string[]) => ({ text, ours: isOneOfOurs(text, ourBodies) })

describe('assessRead', () => {
  it('is complete when every message we sent is visible', () => {
    const ours = [OURS_A, OURS_B]
    const messages = [bubble(OURS_A, ours), bubble(THEIRS, ours), bubble(OURS_B, ours)]
    const r = assessRead(messages, ours)
    expect(r.foundOurs).toBe(2)
    expect(r.expectedOurs).toBe(2)
    expect(r.complete).toBe(true)
  })

  /**
   * THE EXACT LIVE FAILURE. Four messages sent, one bubble rendered — our newest — and it
   * contains no reply. The old code reported "no reply" and vouched for the silence.
   */
  it('is INCOMPLETE when only our newest message rendered', () => {
    const ours = [OURS_A, OURS_B]
    const messages = [bubble(OURS_B, ours)]
    const r = assessRead(messages, ours)
    expect(r.foundOurs).toBe(1)
    expect(r.expectedOurs).toBe(2)
    expect(r.complete).toBe(false)
    // And the dangerous part: nothing in the messages looks like a reply.
    expect(messages.filter((m) => !m.ours)).toHaveLength(0)
  })

  it('is complete for a first touch with nothing sent yet', () => {
    const r = assessRead([], [])
    expect(r.complete).toBe(true)
    expect(r.expectedOurs).toBe(0)
  })

  /**
   * Counted per body, not by comparing lengths. A read showing one of our two messages plus a
   * reply has three... no: two bubbles for two expected, which a length comparison would pass
   * while the older of our messages — and anything around it — was never seen.
   */
  it('does not accept a reply bubble as evidence that our message rendered', () => {
    const ours = [OURS_A, OURS_B]
    const messages = [bubble(OURS_B, ours), bubble(THEIRS, ours)]
    expect(messages.length).toBeGreaterThanOrEqual(ours.length) // a length check would pass
    expect(assessRead(messages, ours).complete).toBe(false) // this does not
  })

  it('counts a truncated bubble as ours when it is a prefix of what we sent', () => {
    const ours = [OURS_A]
    // Instagram hides long messages behind "… see more", so a bubble can be a prefix.
    const truncated = OURS_A.slice(0, 60)
    const r = assessRead([bubble(truncated, ours)], ours)
    expect(r.complete).toBe(true)
  })

  it('does not credit a greeting alone as one of our messages', () => {
    const ours = [OURS_A]
    // The greeting renders in the thread header whether anything was delivered or not.
    const r = assessRead([bubble('Hi Bollywood Chronicle,', ours)], ours)
    expect(r.complete).toBe(false)
    expect(r.foundOurs).toBe(0)
  })

  /** Duplicated bubbles must not inflate the count past what was actually found. */
  it('never reports more found than expected', () => {
    const ours = [OURS_A]
    const r = assessRead([bubble(OURS_A, ours), bubble(OURS_A, ours)], ours)
    expect(r.foundOurs).toBe(1)
    expect(r.complete).toBe(true)
  })
})
