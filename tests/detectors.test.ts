import { describe, it, expect } from 'vitest'
import {
  momDetector,
  extractBrands,
  countCamelWords,
  looksLikeSlogan,
  normaliseBrandKey,
} from '@/detection/detectors/mom'
import { passthroughDetector } from '@/detection/detectors/passthrough'
import { getDetector } from '@/detection/detectors'
import { MOM_POSTS, VIRALBHAYANI_POSTS, asPost, type PostFixture } from './fixtures/posts'

const enrich = (f: PostFixture, i = 0) => asPost(f, i)

describe('momDetector — precision on real posts', () => {
  const paid = MOM_POSTS.filter((p) => p.truth === 'PAID')
  const organic = MOM_POSTS.filter((p) => p.truth === 'ORGANIC')

  it.each(paid)('flags $shortcode as CAMPAIGN ($note)', (f) => {
    const result = momDetector.classify(enrich(f))
    expect(result.verdict).toBe('CAMPAIGN')
    expect(result.confidence).toBeGreaterThanOrEqual(85)
    expect(result.signals).toContain('hashtag:#collaboration')
  })

  it.each(organic)('leaves $shortcode as ORGANIC ($note)', (f) => {
    const result = momDetector.classify(enrich(f))
    expect(result.verdict).toBe('ORGANIC')
    expect(result.confidence).toBe(0)
    expect(result.signals).toEqual([])
  })

  it('does not fire on hashtags that are merely topical', () => {
    // #Coldplay #ChrisMartin #Music #sustainability #Marketing — none disclose.
    const f = MOM_POSTS.find((p) => p.shortcode === 'Cvg0aZ9ST-P')!
    expect(momDetector.classify(enrich(f)).verdict).toBe('ORGANIC')
  })

  it('does not fire on the word "collaborations" in prose', () => {
    // The Lewis Hamilton post says "big money collaborations!" as editorial copy.
    const f = MOM_POSTS.find((p) => p.shortcode === 'DHIFJQ8y4hI')!
    expect(momDetector.classify(enrich(f)).verdict).toBe('ORGANIC')
  })

  it('detects disclosure phrases that use no hashtag', () => {
    // Take a genuinely organic post and add only a disclosure phrase.
    const base = MOM_POSTS.find((p) => p.shortcode === 'DbXrjZDExLb')!
    const withPhrase = {
      ...base,
      og: base.og.replace('Good ol’ advertising 🤌🏻', 'A new chapter, in association with Acme Corp'),
    }
    const result = momDetector.classify(enrich(withPhrase))
    expect(result.verdict).toBe('CAMPAIGN')
    expect(result.signals).toContain('phrase:in-association-with')
  })
})

describe('brand extraction — one clean brand per real campaign', () => {
  /**
   * The four live MOM collaborations. Each must yield exactly one brand, in a
   * form that reads correctly inside a sales message. This is the assertion that
   * matters most: the output goes verbatim into a DM to a real prospect.
   */
  const expected: Record<string, string> = {
    'DbX5F9FE-_X': 'BlackandWhiteNonAlc',
    DbXfC7Pk7FQ: 'Tilara',
    DbVMqWgTOOg: 'RoyalCanin',
    DbVAgeNE2rE: 'TheLeela',
  }

  it.each(Object.entries(expected))('%s yields exactly [%s]', (shortcode, brand) => {
    const f = MOM_POSTS.find((p) => p.shortcode === shortcode)!
    expect(momDetector.classify(enrich(f)).brands).toEqual([brand])
  })

  it('rejects the two slogans that leaked through on the first live run', () => {
    // #MagicOfSharing and #FanStandardTime sat beside the real brand and were
    // being reported as clients.
    const brands = momDetector.classify(enrich(MOM_POSTS.find((p) => p.shortcode === 'DbX5F9FE-_X')!)).brands
    expect(brands).not.toContain('MagicOfSharing')
    expect(brands).not.toContain('FanStandardTime')
  })

  it('collapses two mentions of the same brand and drops the agency', () => {
    // "@theleelacoorgforestsanctuary @theleela @mind_shifters"
    const brands = momDetector.classify(enrich(MOM_POSTS.find((p) => p.shortcode === 'DbVAgeNE2rE')!)).brands
    expect(brands).toHaveLength(1)
    expect(brands.some((b) => b.toLowerCase().includes('mind_shifters'))).toBe(false)
  })

  it('prefers the clean hashtag over a longer campaign variant', () => {
    // Caption has @tilara.india, #HarRoofTilara and #Tilara.
    const brands = momDetector.classify(enrich(MOM_POSTS.find((p) => p.shortcode === 'DbXfC7Pk7FQ')!)).brands
    expect(brands).toEqual(['Tilara'])
  })

  it('requires @mention corroboration when any mention exists', () => {
    // The brand tags the post; a slogan cannot. So an uncorroborated hashtag is
    // ignored entirely rather than guessed at.
    expect(extractBrands('@realbrand #Collaboration #SomeBigSlogan #RealBrand')).toEqual(['RealBrand'])
  })

  it('falls back to a single hashtag guess when there is no mention at all', () => {
    // Least reliable path: name one brand we might have wrong, never three.
    const brands = extractBrands('#Collaboration #MagicOfSharing #Tilara #SustainableRoofing')
    expect(brands).toEqual(['Tilara'])
  })

  it('drops generic marketing vocabulary', () => {
    expect(extractBrands('#Marketing #Advertising #Branding #Creative')).toEqual([])
  })

  it('counts CamelCase words', () => {
    expect(countCamelWords('Tilara')).toBe(1)
    expect(countCamelWords('RoyalCanin')).toBe(2)
    expect(countCamelWords('WhereStillnessFindsYou')).toBe(4)
  })

  it('identifies slogans by their connective words', () => {
    expect(looksLikeSlogan('MagicOfSharing')).toBe(true)
    expect(looksLikeSlogan('WhereStillnessFindsYou')).toBe(true)
    expect(looksLikeSlogan('UniqueNeedsPreciseNutrition')).toBe(false) // caught by word-count instead
    expect(looksLikeSlogan('RoyalCanin')).toBe(false)
    expect(looksLikeSlogan('TheLeela')).toBe(false) // leading "The" is allowed
  })

  it('normalises handles and hashtags to a comparable key', () => {
    expect(normaliseBrandKey('@tilara.india')).toBe('tilaraindia')
    expect(normaliseBrandKey('#Royal_Canin')).toBe('royalcanin')
  })
})

describe('passthroughDetector — @viralbhayani', () => {
  it.each(VIRALBHAYANI_POSTS)('marks $shortcode UNCLASSIFIED ($note)', (f) => {
    const result = passthroughDetector.classify(enrich(f))
    expect(result.verdict).toBe('UNCLASSIFIED')
    expect(result.signals).toContain('detector:passthrough')
  })

  it('never claims ORGANIC or CAMPAIGN — it has no basis to', () => {
    // This channel discloses nothing, so half of these ARE paid. Guessing with
    // rules would produce confident nonsense; deferring is the honest behaviour.
    const verdicts = new Set(VIRALBHAYANI_POSTS.map((f) => passthroughDetector.classify(enrich(f)).verdict))
    expect([...verdicts]).toEqual(['UNCLASSIFIED'])
  })

  it('still harvests brand candidates for later use', () => {
    const f = VIRALBHAYANI_POSTS.find((p) => p.shortcode === 'DbXtbIoKUhL')!
    expect(passthroughDetector.classify(enrich(f)).brands).toContain('JanaNayagan')
  })
})

describe('detector registry', () => {
  it('routes by key', () => {
    expect(getDetector('mom').key).toBe('mom')
    expect(getDetector('passthrough').key).toBe('passthrough')
  })

  it('falls back to passthrough rather than throwing on an unknown key', () => {
    // A mis-configured target should still have its posts recorded.
    expect(getDetector('nope').key).toBe('passthrough')
    expect(getDetector(null).key).toBe('passthrough')
  })
})
