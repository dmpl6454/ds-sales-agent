import { describe, it, expect } from 'vitest'
import {
  renderMessage,
  buildGreeting,
  buildHookLine,
  prettifyBrand,
  validatePersona,
} from '@/outreach/render'
import { MESSAGE_VARIANTS } from '../prisma/variants'

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60001 89766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const MOM = {
  handle: 'madovermarketing_mom',
  displayName: 'Mad Over Marketing (M.O.M)',
  contactFirstName: null,
}

describe('greeting', () => {
  it('uses the real first name when we have one', () => {
    expect(buildGreeting({ ...MOM, contactFirstName: 'Sumeet' })).toBe('Hi Sumeet,')
  })

  it('addresses the publication rather than guessing a person', () => {
    // "Sumeet" in the original brief was a placeholder. Inventing a name is
    // worse than addressing the brand.
    expect(buildGreeting(MOM)).toBe('Hi Mad Over Marketing (M.O.M) team,')
  })

  it('treats whitespace as absent', () => {
    expect(buildGreeting({ ...MOM, contactFirstName: '   ' })).toContain('team,')
  })
})

describe('hook line', () => {
  it('names the detected brand', () => {
    const line = buildHookLine({ brands: '["RoyalCanin"]', postedAt: new Date(), verdict: 'CAMPAIGN' })
    expect(line).toBe('I noticed your recent branded collaboration with Royal Canin — nicely executed.')
  })

  it('lists two brands naturally', () => {
    // extractBrands upgrades "@theleela" to the caption's "#TheLeela" casing,
    // so this is the shape the renderer actually receives.
    const line = buildHookLine({ brands: '["Tilara","TheLeela"]', postedAt: new Date(), verdict: 'CAMPAIGN' })
    expect(line).toContain('Tilara and The Leela')
  })

  it('at least capitalises a handle that had no cased hashtag to upgrade from', () => {
    // Best effort: we cannot know "theleela" is two words. What matters is that
    // no message ever reads "collaboration with theleela".
    const line = buildHookLine({ brands: '["@someagency"]', postedAt: new Date(), verdict: 'CAMPAIGN' })
    expect(line).toContain('Someagency')
  })

  it('returns null when there is nothing concrete to say', () => {
    // An invented hook is worse than none — the message simply omits the line.
    expect(buildHookLine(null)).toBeNull()
    expect(buildHookLine({ brands: '[]', postedAt: new Date(), verdict: 'CAMPAIGN' })).toBeNull()
  })

  it('never hooks on an UNCLASSIFIED post', () => {
    // Viral Bhayani posts are unclassified by design; claiming to have noticed
    // "their campaign" would be a guess.
    expect(buildHookLine({ brands: '["JanaNayagan"]', postedAt: new Date(), verdict: 'UNCLASSIFIED' })).toBeNull()
  })
})

describe('prettifyBrand', () => {
  it('splits CamelCase into words', () => {
    expect(prettifyBrand('RoyalCanin')).toBe('Royal Canin')
    expect(prettifyBrand('TheLeela')).toBe('The Leela')
  })

  it('leaves single words and acronyms alone', () => {
    expect(prettifyBrand('Tilara')).toBe('Tilara')
    expect(prettifyBrand('SKF')).toBe('SKF')
  })

  it('strips the @, normalises separators and title-cases the result', () => {
    expect(prettifyBrand('@royal_canin')).toBe('Royal Canin')
    expect(prettifyBrand('@tilara')).toBe('Tilara')
  })
})

describe('persona validation', () => {
  it('accepts a correct Indian mobile', () => {
    expect(validatePersona(PERSONA)).toEqual([])
  })

  it('rejects the 11-digit number from the original brief', () => {
    // "+91 60000 189766" has 11 digits after the country code. This guard is why
    // a wrong number blocks the send instead of appearing in every message.
    const problems = validatePersona({ ...PERSONA, personaPhone: '+91 60000 189766' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('not a valid Indian mobile')
  })

  it('rejects a mobile starting with an invalid digit', () => {
    expect(validatePersona({ ...PERSONA, personaPhone: '+91 12345 67890' })).toHaveLength(1)
  })

  it('rejects a malformed email', () => {
    expect(validatePersona({ ...PERSONA, personaEmail: 'kapil@' })).toHaveLength(1)
  })
})

describe('renderMessage', () => {
  const variant = MESSAGE_VARIANTS[0]!.body

  it('reproduces the persona block verbatim', () => {
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    expect(body).toContain('Kapil Jain')
    expect(body).toContain('Co-founder, Bollywood Society')
    expect(body).toContain('+91 60001 89766')
    expect(body).toContain('kapil@digitalsukoon.com')
  })

  it('uses "of" in the opening line and a comma in the signature', () => {
    // Role and brand are stored separately for exactly this reason. A single
    // pre-joined title yields "I'm Kapil Jain, Co-founder, Bollywood Society."
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    expect(body).toContain("I'm Kapil Jain, Co-founder of Bollywood Society.")
    expect(body).not.toContain("I'm Kapil Jain, Co-founder, Bollywood Society")
  })

  it('ends with the signature block in order', () => {
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    const tail = body.trimEnd().split('\n').slice(-4)
    expect(tail).toEqual([
      'Kapil Jain',
      'Co-founder, Bollywood Society',
      '+91 60001 89766',
      'kapil@digitalsukoon.com',
    ])
  })

  it('includes the hook line when a campaign was detected', () => {
    const { body, hookLine } = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: variant,
      hook: { brands: '["Tilara"]', postedAt: new Date(), verdict: 'CAMPAIGN' },
    })
    expect(hookLine).toContain('Tilara')
    expect(body).toContain('Tilara')
  })

  it('omits the hook line cleanly when detection found nothing', () => {
    // Outreach is never blocked on detection — a quiet day still sends.
    const { body, hookLine } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    expect(hookLine).toBeNull()
    expect(body).not.toContain('I noticed your recent')
    expect(body).not.toMatch(/\n{3,}/)
  })

  it('substitutes {{brand}} and {{channel}}', () => {
    const { body } = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'A note about {{brand}} for {{channel}}.',
      hook: { brands: '["RoyalCanin"]', postedAt: new Date(), verdict: 'CAMPAIGN' },
    })
    expect(body).toContain('A note about Royal Canin for Mad Over Marketing (M.O.M).')
  })

  it('degrades {{brand}} gracefully with no hook', () => {
    const { body } = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'A note about {{brand}}.',
      hook: null,
    })
    expect(body).toContain('A note about your brand partners.')
  })
})

describe('the twelve variants', () => {
  it('are all present and distinct', () => {
    expect(MESSAGE_VARIANTS).toHaveLength(12)
    expect(new Set(MESSAGE_VARIANTS.map((v) => v.label)).size).toBe(12)
    expect(new Set(MESSAGE_VARIANTS.map((v) => v.body)).size).toBe(12)
  })

  it('never embed the signature — renderMessage owns that', () => {
    // Duplicated signatures were the failure mode when variants were free text.
    for (const v of MESSAGE_VARIANTS) {
      expect(v.body, v.label).not.toContain('Kapil Jain')
      expect(v.body, v.label).not.toContain('digitalsukoon.com')
      expect(v.body, v.label).not.toMatch(/^Hi /m)
      expect(v.body, v.label).not.toContain('Looking forward to connecting')
    }
  })

  it('all make the 20-minute ask', () => {
    for (const v of MESSAGE_VARIANTS) {
      expect(v.body.toLowerCase(), v.label).toContain('20 minutes')
    }
  })

  it('render into plausible DM-length messages', () => {
    for (const v of MESSAGE_VARIANTS) {
      const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: v.body, hook: null })
      expect(body.length, v.label).toBeGreaterThan(300)
      expect(body.length, v.label).toBeLessThan(1400)
    }
  })
})
