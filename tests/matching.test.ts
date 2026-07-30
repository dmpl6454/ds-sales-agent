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
