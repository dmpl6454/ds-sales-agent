import { describe, it, expect } from 'vitest'
import { distinctiveSlice, messageMatchesOurs, matchesAnyOfOurs, normalise } from '@/outreach/matching'
import { renderMessage } from '@/outreach/render'
import { MESSAGE_VARIANTS } from '../prisma/variants'

/**
 * These two functions decide whether a send is recorded and whether outreach
 * halts. Both failure directions are expensive:
 *
 *   false positive on "this is ours"  → a real reply is missed, and we keep
 *                                       pitching someone who already answered
 *   false negative on "this is ours"  → our own message is read as a reply, and
 *                                       outreach halts for no reason
 *
 * The second is the safer way to be wrong, and the design leans that way.
 */

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}
const MOM = {
  handle: 'madovermarketing_mom',
  displayName: 'Mad Over Marketing (M.O.M)',
  contactFirstName: 'Mad Over Marketing',
}

const realMessage = renderMessage({
  persona: PERSONA,
  target: MOM,
  variantBody: MESSAGE_VARIANTS[0]!.body,
  hook: null,
}).body

describe('distinctiveSlice', () => {
  it('avoids the greeting, which also appears in the thread header', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice).not.toContain('Hi Mad Over Marketing')
  })

  it('avoids the signature, which contains contact details rendered elsewhere', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice).not.toContain('+91')
    expect(slice).not.toContain('digitalsukoon')
  })

  it('returns a substantial chunk of real body text', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice.length).toBeGreaterThan(30)
    expect(realMessage).toContain(slice)
  })

  it('produces something usable for every variant', () => {
    for (const v of MESSAGE_VARIANTS) {
      const body = renderMessage({ persona: PERSONA, target: MOM, variantBody: v.body, hook: null }).body
      const slice = distinctiveSlice(body)
      expect(slice, v.label).not.toBeNull()
      expect(body, v.label).toContain(slice!)
    }
  })

  it('falls back gracefully on a short message', () => {
    expect(distinctiveSlice('Hi there, following up on this.')).toBe('Hi there, following up on this.')
  })

  it('returns null when there is nothing to match on', () => {
    expect(distinctiveSlice('')).toBeNull()
    expect(distinctiveSlice('ok')).toBeNull()
  })

  /**
   * The gap that let both send guards become tautologies.
   *
   * The "falls back gracefully" test above uses a SINGLE-line body, so the fallback
   * returns the whole string and the bug is invisible. A short MULTI-line body - which
   * is exactly what the dashboard's edit box produces - fell back to the greeting: the
   * one thing this function's own docblock says to avoid, because it also renders in
   * the thread header.
   */
  it('never returns the greeting, even when it is the longest line', () => {
    const edited = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const needle = distinctiveSlice(edited)
    expect(needle).not.toBeNull()
    expect(needle).not.toContain('Hi Bollywood Chronicle')
    expect(needle).toBe('This is a test message.')
  })

  it('never returns the greeting for a three-line body either', () => {
    const needle = distinctiveSlice('Hi Priyanshu,\n\nShort note about the campaign here.\n\nThanks')
    expect(needle).not.toContain('Hi Priyanshu')
  })

  it('returns null rather than the greeting when no body line is usable', () => {
    expect(distinctiveSlice('Hi Bollywood Chronicle,\n\nok')).toBeNull()
  })

  it('still returns the whole thing for a single-line body', () => {
    expect(distinctiveSlice('Hi there, following up on this.')).toBe('Hi there, following up on this.')
  })
})

describe('messageMatchesOurs', () => {
  it('recognises our own message read back verbatim', () => {
    expect(messageMatchesOurs(realMessage, realMessage)).toBe(true)
  })

  it('survives the whitespace collapsing Instagram applies', () => {
    // The DOM yields one run-on string with newlines flattened to spaces.
    const flattened = realMessage.replace(/\s+/g, ' ')
    expect(messageMatchesOurs(flattened, realMessage)).toBe(true)
  })

  it('survives surrounding chrome in the message row', () => {
    const withChrome = `Kapil Jain 14:22 ${realMessage.replace(/\s+/g, ' ')} Seen`
    expect(messageMatchesOurs(withChrome, realMessage)).toBe(true)
  })

  /**
   * With the needle taken from the greeting, a page holding only thread chrome
   * satisfied the post-send check - so the guard could not fail - and a paste that
   * lost everything after the greeting satisfied the composer read-back.
   */
  it('does NOT report a short edited message as delivered from thread chrome alone', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const chromeOnly = 'Bollywood Chronicle  bollywoodchronicle  Active now  Hi Bollywood Chronicle,  Message'
    expect(messageMatchesOurs(chromeOnly, body)).toBe(false)
  })

  it('does NOT accept a paste that lost everything after the greeting', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    expect(messageMatchesOurs('Hi Bollywood Chronicle,', body)).toBe(false)
  })

  it('still matches when the real short body IS present', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const delivered = 'Bollywood Chronicle  Hi Bollywood Chronicle, This is a test message.  Message'
    expect(messageMatchesOurs(delivered, body)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(messageMatchesOurs(realMessage.toUpperCase(), realMessage)).toBe(true)
  })

  it('does NOT match a genuine reply', () => {
    // The case that matters most: this is what triggers the halt.
    const reply = 'Hi Kapil, thanks for reaching out. Can you share a deck and rates?'
    expect(messageMatchesOurs(reply, realMessage)).toBe(false)
  })

  it('does not match a reply that quotes our signature', () => {
    // Someone replying may quote the contact block. That is still their message,
    // and slicing from mid-body rather than the signature is what protects us.
    const reply = 'Thanks Kapil Jain, Co-founder, Bollywood Society — will revert.'
    expect(messageMatchesOurs(reply, realMessage)).toBe(false)
  })

  it('does not match a short pleasantry', () => {
    expect(messageMatchesOurs('Sure', realMessage)).toBe(false)
    expect(messageMatchesOurs('👍', realMessage)).toBe(false)
  })
})

describe('matchesAnyOfOurs', () => {
  const variantA = renderMessage({
    persona: PERSONA,
    target: MOM,
    variantBody: MESSAGE_VARIANTS[0]!.body,
    hook: null,
  }).body
  const variantB = renderMessage({
    persona: PERSONA,
    target: MOM,
    variantBody: MESSAGE_VARIANTS[5]!.body,
    hook: null,
  }).body

  it('recognises any prior message on the thread, not just the latest', () => {
    // Variants rotate, so the last message we sent may be any of them.
    expect(matchesAnyOfOurs(variantA, [variantA, variantB])).toBe(true)
    expect(matchesAnyOfOurs(variantB, [variantA, variantB])).toBe(true)
  })

  it('still identifies a reply when several of ours precede it', () => {
    expect(matchesAnyOfOurs('Interested — what are your rates?', [variantA, variantB])).toBe(false)
  })

  it('treats an empty history as "not ours"', () => {
    // Fails toward halting rather than toward continuing to message.
    expect(matchesAnyOfOurs('anything at all', [])).toBe(false)
  })
})

describe('normalise', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalise('  Hello   \n  World ')).toBe('hello world')
  })
})
