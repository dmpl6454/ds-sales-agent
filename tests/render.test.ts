import { describe, it, expect } from 'vitest'
import {
  renderMessage,
  buildGreeting,
  buildHookLine,
  prettifyBrand,
  validatePersona,
  greetableName,
  operatorName,
} from '@/outreach/render'
import { MESSAGE_VARIANTS } from '../prisma/variants'
import { BRAND_MESSAGE_VARIANTS } from '../prisma/brandVariants'

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
  contactFirstName: null,
  kind: 'CHANNEL',
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

  it('accepts the confirmed 11-digit number', () => {
    // Kapil's number carries an extra digit and was confirmed correct as written.
    expect(validatePersona({ ...PERSONA, personaPhone: '+91 60000 189766' })).toEqual([])
  })

  it('still rejects a number that is too short', () => {
    // The guard is relaxed on length, not removed — this value appears in every
    // outgoing message, so a genuine typo must still block the send.
    expect(validatePersona({ ...PERSONA, personaPhone: '+91 60000' })).toHaveLength(1)
  })

  it('still rejects a number that is far too long', () => {
    expect(validatePersona({ ...PERSONA, personaPhone: '+91 600001897667788' })).toHaveLength(1)
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

  it('reproduces the signature block verbatim — channel name and contact details only', () => {
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    expect(body).toContain('Bollywood Society')
    expect(body).toContain('+91 60000 189766')
    expect(body).toContain('kapil@digitalsukoon.com')
  })

  /**
   * Tabish, 2026-08-07: the persona is ONLY the channel name. No person is introduced and
   * no name or role is signed — both directions asserted, because "we removed the line"
   * is only true if nothing else still emits it.
   */
  it('renders NO intro line and NO personal name or role anywhere', () => {
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    expect(body).not.toContain("I'm Kapil Jain")
    expect(body).not.toContain('Kapil Jain')
    expect(body).not.toContain('Co-founder')
  })

  it('ends with the signature block in order', () => {
    const { body } = renderMessage({ persona: PERSONA, target: MOM, variantBody: variant, hook: null })
    const tail = body.trimEnd().split('\n').slice(-3)
    expect(tail).toEqual(['Bollywood Society', '+91 60000 189766', 'kapil@digitalsukoon.com'])
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

describe('greetableName — Instagram display names are marketing strings, not names', () => {
  it('drops a trailing location after a comma', () => {
    // Real value from the live DB. Produced "Hi Milano Ice Cream, Bangalore team," —
    // ungrammatical in the first line a prospect reads.
    expect(greetableName('Milano Ice Cream, Bangalore')).toBe('Milano Ice Cream')
  })

  it('drops taglines after a separator', () => {
    expect(greetableName('KALKI Fashion | Ethnic Wear')).toBe('KALKI Fashion')
    expect(greetableName('Tilara • Roofing')).toBe('Tilara')
    expect(greetableName('Some Brand – Official Store')).toBe('Some Brand')
  })

  it('KEEPS a name that is already clean, including a country suffix', () => {
    // "Amazon India" is the brand as people say it. Trimming it would be a worse guess.
    expect(greetableName('Amazon India')).toBe('Amazon India')
    expect(greetableName('Royal Canin India')).toBe('Royal Canin India')
    expect(greetableName('Mad Over Marketing')).toBe('Mad Over Marketing')
  })

  it('falls back to the original rather than returning something empty', () => {
    // A bad greeting beats "Hi  team,".
    expect(greetableName(', Bangalore')).toBe(', Bangalore')
    expect(greetableName('X, Bangalore')).toBe('X, Bangalore')
  })

  it('collapses runs of whitespace', () => {
    expect(greetableName('Double  Spaced  Brand')).toBe('Double Spaced Brand')
  })
})

describe('operatorName — our own bookkeeping must not read as the recipient’s name', () => {
  /**
   * Every value here was on the live dashboard on 2026-08-06. The headline read
   * "Burner (test target) replied" and an account row read "Tabish (trial)".
   */
  it('strips the annotations that were actually leaking', () => {
    expect(operatorName('Bollywood Chronicle (test target)')).toBe('Bollywood Chronicle')
    expect(operatorName('Bollywood Society (rehearsal target)')).toBe('Bollywood Society')
    expect(operatorName('Burner (test target)')).toBe('Burner')
    expect(operatorName('Tabish (trial)')).toBe('Tabish')
  })

  it('matches the FORM, not a list of words we thought of', () => {
    // A vocabulary list ("test", "trial", "demo") fails silently on the first word
    // nobody enumerated — the same shape as the quality gate's figures allowlist
    // matching digits and so passing "eighty million followers".
    expect(operatorName('Some Channel (do not use)')).toBe('Some Channel')
    expect(operatorName('Some Channel [internal]')).toBe('Some Channel')
  })

  it('KEEPS everything greetableName would have cut, because a handle is always beside it', () => {
    // This is the whole reason the two functions are separate. On screen the location
    // is information; before the word "team" in a real pitch it is a defect.
    expect(operatorName('Milano Ice Cream, Bangalore')).toBe('Milano Ice Cream, Bangalore')
    expect(operatorName('KALKI Fashion | Ethnic Wear')).toBe('KALKI Fashion | Ethnic Wear')
    expect(greetableName('Milano Ice Cream, Bangalore')).toBe('Milano Ice Cream')
  })

  it('leaves a clean name untouched', () => {
    expect(operatorName('Mad Over Marketing')).toBe('Mad Over Marketing')
    expect(operatorName('Royal Canin India')).toBe('Royal Canin India')
    expect(operatorName('Amazon India')).toBe('Amazon India')
  })

  it('only strips at the END — a parenthetical mid-name is part of the name', () => {
    expect(operatorName('Zee5 (India) Originals')).toBe('Zee5 (India) Originals')
  })

  it('falls back to the original rather than returning something empty or absurd', () => {
    // A label with our annotation still in it beats a blank row.
    expect(operatorName('(test target)')).toBe('(test target)')
    expect(operatorName('X (trial)')).toBe('X (trial)')
  })

  it('collapses runs of whitespace', () => {
    expect(operatorName('Double  Spaced  Channel')).toBe('Double Spaced Channel')
  })

  /**
   * The one live value that is NOT an annotation, asserted deliberately.
   *
   * "(M.O.M)" is part of how that publisher writes its own name, and this strips it. That
   * is an accepted trade, not an oversight: on screen the handle @madovermarketing_mom is
   * always beside it, and the alternative is a vocabulary list that fails on new words.
   * Message copy is unaffected — `buildGreeting` still produces the full string, and there
   * is a test above asserting exactly that.
   */
  it('also strips a genuine parenthetical, which is the accepted cost of the rule', () => {
    expect(operatorName('Mad Over Marketing (M.O.M)')).toBe('Mad Over Marketing')
    expect(buildGreeting(MOM)).toBe('Hi Mad Over Marketing (M.O.M) team,')
  })
})

describe('buildGreeting for brands', () => {
  it('addresses a company as a team, not as a person', () => {
    // contactFirstName is null for brands: we do not know who runs the account, and
    // "Hi Amazon India," addresses a corporation as an individual.
    expect(
      buildGreeting({ handle: 'amazondotin', displayName: 'Amazon India', contactFirstName: null, kind: 'BRAND' }),
    ).toBe('Hi Amazon India team,')
  })

  it('uses a real contact name when one is known', () => {
    expect(
      buildGreeting({ handle: 'x', displayName: 'Some Brand', contactFirstName: 'Priya', kind: 'BRAND' }),
    ).toBe('Hi Priya,')
  })

  it('produces a grammatical greeting from a messy display name', () => {
    expect(
      buildGreeting({
        handle: 'milano_icecream_bangalore',
        displayName: 'Milano Ice Cream, Bangalore',
        contactFirstName: null,
        kind: 'BRAND',
      }),
    ).toBe('Hi Milano Ice Cream team,')
  })
})

/**
 * ── `{{brand}}` means two different things, and one rule served both ───────
 *
 * CHANNEL pool: we write TO a publisher ABOUT its sponsors, so `{{brand}}` is the sponsor
 * detected in their paid post. BRAND pool: we write TO the company itself, so `{{brand}}`
 * is THE RECIPIENT — `prisma/brandVariants.ts` says so in as many words and nothing
 * implemented it.
 *
 * FOUND BY RENDERING THE REAL MESSAGE TO A REAL PROSPECT, 2026-08-05. Tests asserted 18
 * properties of the brand pitch and could not catch either of these, because a test asserts
 * what you thought to assert.
 */
describe('{{brand}} resolves per pool, not per hook', () => {
  const ROYAL_CANIN = {
    handle: 'royalcanin.india',
    displayName: 'Royal Canin India',
    contactFirstName: null,
    kind: 'BRAND',
  }
  const A_DIFFERENT_COMPANY = {
    brands: JSON.stringify(['AmazonDotIn', 'Kalkifashion']),
    postedAt: new Date('2026-08-03'),
    verdict: 'CAMPAIGN',
  }
  const ASK = 'Could I send a short plan with indicative numbers for {{brand}}?'

  it('names the RECIPIENT in a brand pitch, not "your brand partners"', () => {
    const { body } = renderMessage({ persona: PERSONA, target: ROYAL_CANIN, variantBody: ASK, hook: null })
    expect(body).toContain('indicative numbers for Royal Canin India?')
    expect(body).not.toContain('your brand partners')
  })

  /**
   * THE ONE THAT MATTERS MOST. With a hook present the old rule substituted whatever brand
   * the campaign named — so a pitch to Royal Canin asked for "indicative numbers for Amazon
   * Dot In". A different company, plausibly a competitor, in the closing ask.
   */
  it('never names a DIFFERENT company in a brand pitch', () => {
    const { body } = renderMessage({
      persona: PERSONA,
      target: ROYAL_CANIN,
      variantBody: ASK,
      hook: A_DIFFERENT_COMPANY,
    })
    expect(body).toContain('indicative numbers for Royal Canin India?')
    expect(body).not.toContain('Amazon')
    expect(body).not.toContain('Kalki')
  })

  /** The permitting direction: a CHANNEL pitch still names the sponsor we detected. */
  it('still names the detected sponsor in a channel pitch', () => {
    const { body } = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'How did the {{brand}} placement land?',
      hook: A_DIFFERENT_COMPANY,
    })
    expect(body).toContain('How did the Amazon Dot In placement land?')
  })

  /** ...and still falls back for a channel when no sponsor is known. */
  it('still falls back to "your brand partners" for a channel with no hook', () => {
    const { body } = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'How did the {{brand}} placement land?',
      hook: null,
    })
    expect(body).toContain('your brand partners')
  })

  /**
   * `{{channel}}` must use the same name as the greeting. Its fallback was the raw
   * `displayName` while the greeting used `greetableName`, so the two disagreed for every
   * recipient with no `contactFirstName` — which is every BRAND by design.
   */
  it('uses the greetable name inside the body, matching the greeting', () => {
    const MILANO = {
      handle: 'milano_icecream_bangalore',
      displayName: 'Milano Ice Cream, Bangalore',
      contactFirstName: null,
      kind: 'BRAND',
    }
    const { body } = renderMessage({
      persona: PERSONA,
      target: MILANO,
      variantBody: 'A rolling calendar for {{channel}} across our network.',
      hook: null,
    })
    expect(body).toContain('Hi Milano Ice Cream team,')
    expect(body).toContain('A rolling calendar for Milano Ice Cream across our network.')
    expect(body).not.toContain('Milano Ice Cream, Bangalore across')
  })

  /** Every brand variant must render without leaving a placeholder or a stranger's name. */
  it('leaves no placeholder and no foreign company in ANY brand variant', () => {
    for (const v of BRAND_MESSAGE_VARIANTS) {
      const { body } = renderMessage({
        persona: PERSONA,
        target: ROYAL_CANIN,
        variantBody: v.body,
        hook: A_DIFFERENT_COMPANY,
      })
      expect(body, v.label).not.toMatch(/\{\{\s*\w+\s*\}\}/)
      expect(body, v.label).not.toContain('your brand partners')
      expect(body, v.label).not.toContain('Amazon')
      expect(body, v.label).not.toContain('Kalki')
    }
  })
})

/**
 * The hook line is a CHANNEL sentence. "I noticed your recent branded collaboration with X"
 * tells the reader they are a publisher and X paid them — false, and insultingly so, when
 * said to X's competitor. Unreachable today because `pipeline.ts` scrapes `kind: 'CHANNEL'`
 * only, so no BRAND row has a campaign; asserted anyway, because that is a property of
 * which rows the scraper visits rather than a rule, and this codebase has already lost one
 * implicit safety property that way.
 */
describe('a brand never receives a channel hook line', () => {
  const HOOK = {
    brands: JSON.stringify(['AmazonDotIn']),
    postedAt: new Date('2026-08-03'),
    verdict: 'CAMPAIGN',
  }

  it('omits the hook line entirely for a BRAND recipient', () => {
    const out = renderMessage({
      persona: PERSONA,
      target: { handle: 'royalcanin.india', displayName: 'Royal Canin India', contactFirstName: null, kind: 'BRAND' },
      variantBody: 'A short media-buying proposition.',
      hook: HOOK,
    })
    expect(out.hookLine).toBeNull()
    expect(out.body).not.toContain('branded collaboration')
    expect(out.body).not.toContain('Amazon')
  })

  /** The permitting direction: a CHANNEL recipient still gets it. */
  it('still renders the hook line for a CHANNEL recipient', () => {
    const out = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'A short partnership proposition.',
      hook: HOOK,
    })
    expect(out.hookLine).toContain('branded collaboration')
    expect(out.body).toContain('Amazon Dot In')
  })
})
