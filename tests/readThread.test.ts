import { describe, it, expect } from 'vitest'
import { assessRead, type ThreadMessage } from '@/outreach/browser/readThread'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'

/** The real shipped template — the byte-identical body all five pages deliver. */
const standardBody = SINGLE_TEMPLATE_MIDDLE
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

const bubble = (text: string, ourBodies: readonly string[]) => ({ text, ours: isOneOfOurs(text, ourBodies), approxAt: null })

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

  /**
   * ── THE SINGLE-TEMPLATE CASE, WHICH USED TO PASS FROM ONE BUBBLE ──────────
   *
   * Every message is now the SAME standard template, so a pair's bodies are byte-identical.
   * The old check asked `messages.some(...)` per body — membership, which is a property of
   * the whole thread — so ONE visible bubble answered for all three, `complete` came back
   * true, and the caller stamped verified silence over a conversation it had not seen.
   *
   * This is the assertion that fails if the claim is ever relaxed back to membership. It is
   * mutation-tested: replacing the body of `assessRead` with the old
   * `ourBodies.filter((b) => messages.some((m) => isOneOfOurs(m.text, [b]))).length`
   * makes the first expectation read 3 and the test fails.
   */
  it('does not let one bubble vouch for three identical messages', () => {
    const ours = [OURS_A, OURS_A, OURS_A]
    const oneVisible = assessRead([bubble(OURS_A, ours)], ours)
    expect(oneVisible.foundOurs).toBe(1)
    expect(oneVisible.complete).toBe(false)

    const twoVisible = assessRead([bubble(OURS_A, ours), bubble(OURS_A, ours)], ours)
    expect(twoVisible.foundOurs).toBe(2)
    expect(twoVisible.complete).toBe(false)

    // And the honest positive direction: all three present reads as complete.
    const allVisible = assessRead([bubble(OURS_A, ours), bubble(OURS_A, ours), bubble(OURS_A, ours)], ours)
    expect(allVisible.foundOurs).toBe(3)
    expect(allVisible.complete).toBe(true)
  })

  /**
   * The failure this guard exists for, with identical bodies: a partial read that also
   * hides a reply must not report complete. If it did, `replyCheckedAt` would be stamped
   * and the next follow-up would fire into a live conversation.
   */
  it('holds when identical messages are partly visible and a reply is present', () => {
    const ours = [OURS_A, OURS_A]
    const r = assessRead([bubble(OURS_A, ours), bubble(THEIRS, ours)], ours)
    expect(r.foundOurs).toBe(1)
    expect(r.complete).toBe(false)
  })
})

/**
 * ── THE COMPLETENESS BAR IS THE PAIR'S, NOT THE FLEET'S (2026-08-21) ────────
 *
 * MEASURED live, and it is the worst near-miss in this repo's history. Every sweep read from
 * ~03:39 reported `incomplete=4`: the ring fan-out had delivered the SAME template to one
 * recipient from five different pages, `ourBodies` was gathered fleet-wide, and a thread holds
 * ONE pair's conversation — so `expectedOurs` was 5 in a thread that can only ever show 1.
 * Structurally unsatisfiable, for every fanned-out recipient, forever.
 *
 * The guard's own fail-closed design did what it promised: incomplete never vouches for
 * silence, so `replyCheckedAt` was never stamped. The cost was that it could never vouch for
 * ANYTHING — and @taniya_chatterjee's rate negotiation ("Hi, this will cost you 8k per post",
 * "10 posts deal lelo", a phone number) sat unrecorded in a thread the sweep had "read",
 * while other pages kept messaging her. A fail-closed guard with an unsatisfiable
 * precondition is a blindfold wearing a seatbelt.
 *
 * The 2026-08-17 occurrence-counting fix ("each sent body claims its own bubble") was and is
 * correct — for one pair's thread. The fan-out (2026-08-18/19) moved the copies into OTHER
 * pairs' threads, which its fixture never modelled. These do.
 */
describe('completeness on a fanned-out recipient', () => {
  const TEMPLATE = standardBody

  /** The taniya thread, shaped exactly: 8 of theirs, ONE of ours, five pages' worth fleet-wide. */
  it('one pair-delivered bubble plus their replies is COMPLETE, and the replies are theirs', () => {
    const messages: ThreadMessage[] = [
      { text: '?', ours: false, approxAt: null },
      { text: 'please message', ours: false, approxAt: null },
      { text: 'Hi, this will cost you 8k per post', ours: false, approxAt: null },
      { text: '10 posts deal lelo', ours: false, approxAt: null },
      { text: TEMPLATE, ours: true, approxAt: null },
    ]
    /* Five identical deliveries exist FLEET-WIDE; this pair delivered ONE. */
    const read = assessRead(messages, [TEMPLATE])
    expect(read.complete).toBe(true)
    expect(read.foundOurs).toBe(1)
    /* The old bar, for contrast: fleet-wide expectations can never be met in one thread. */
    const oldBar = assessRead(messages, [TEMPLATE, TEMPLATE, TEMPLATE, TEMPLATE, TEMPLATE])
    expect(oldBar.complete).toBe(false)
  })

  /** The direction the 17 Aug fix exists for is UNCHANGED: two sends by THIS pair need two bubbles. */
  it('a pair that delivered twice is still incomplete when only one bubble is visible', () => {
    const read = assessRead([{ text: TEMPLATE, ours: true, approxAt: null }], [TEMPLATE, TEMPLATE])
    expect(read.complete).toBe(false)
    expect(read.foundOurs).toBe(1)
  })
})

describe('the two body sets cannot be silently conflated again', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/outreach/browser/readThread.ts'), 'utf8')
  const check = readFileSync(join(import.meta.dirname, '..', 'src/outreach/replyCheck.ts'), 'utf8')

  it('openAndReadThread takes named fields, not one array for both jobs', () => {
    expect(src).toMatch(/export interface ThreadBodies/)
    expect(src).toMatch(/bodies: ThreadBodies/)
    /* Classification stays fleet-wide; completeness is the pair's. */
    expect(src).toMatch(/isOneOfOurs\(text, bodies\.allOurs\)/)
    expect(src).toMatch(/assessRead\(messages, bodies\.expected\)/)
  })

  it('the sweep builds expected from THIS pair and allOurs from the fleet', () => {
    expect(check).toMatch(/a\.senderId === senderId/)
    expect(check).toMatch(/\{ expected, allOurs \}/)
  })
})
