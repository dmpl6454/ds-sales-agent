/**
 * Name → official page, with the measured trap as a permanent fixture: a handle
 * constructed from a name was wrong 4/10, and 3 of the 4 wrong handles EXIST —
 * `@philips` (global HQ, verified) for a "Philips India" campaign. Existence is not
 * identity; only a verified badge + covering name, or size + exact name, may pass.
 */
import { describe, expect, it } from 'vitest'
import { candidateHandlesFor, nameMatches, isOfficialMatch, duplicatesExistingProspect } from '@/detection/officialHandle'

describe('candidateHandlesFor', () => {
  it('generates the normalisations an Indian advertiser actually uses', () => {
    const c = candidateHandlesFor('Royal Canin')
    for (const expected of ['royalcanin', 'royalcanin.india', 'royalcanin_india', 'royalcaninindia', 'royalcanin.official']) {
      expect(c, expected).toContain(expected)
    }
  })

  it('drops OCR noise: empty and too-short names yield nothing usable', () => {
    expect(candidateHandlesFor('')).toEqual([])
    expect(candidateHandlesFor('%%')).toEqual([])
    expect(candidateHandlesFor('LG').every((h) => h.length >= 3)).toBe(true)
  })
})

describe('nameMatches — subset direction carries the safety', () => {
  it('profile "Royal Canin India" covers brand "Royal Canin"', () => {
    expect(nameMatches('Royal Canin', 'Royal Canin India')).toBe(true)
  })

  it('THE PHILIPS TRAP: profile "Philips" does NOT cover brand "Philips India"', () => {
    expect(nameMatches('Philips India', 'Philips')).toBe(false)
  })

  it('null and empty never match', () => {
    expect(nameMatches('Sony', null)).toBe(false)
    expect(nameMatches('', 'Sony')).toBe(false)
  })
})

describe('isOfficialMatch — VERIFIED ONLY since 2026-08-20', () => {
  const base = { brandName: 'Royal Canin' }

  it('accepts a verified account whose name covers the brand', () => {
    expect(isOfficialMatch({ ...base, fullName: 'Royal Canin India', isVerified: true })).toBe(true)
  })

  it('REJECTS a verified account with the wrong name — a badge on the wrong account is the trap', () => {
    expect(isOfficialMatch({ ...base, fullName: 'Ryan Canin', isVerified: true })).toBe(false)
  })

  /**
   * THE SIZE ARM IS GONE (Tabish: "No message is to be sent to any target that are
   * unverified"). It was already unreachable — the feed endpoint returns no follower count
   * — so these cases assert the bar is now a single question, not two.
   */
  it('REJECTS an unverified account however large or exactly-named', () => {
    expect(isOfficialMatch({ ...base, fullName: 'Royal Canin', isVerified: false })).toBe(false)
  })

  it('REJECTS an unknown badge state — never looked is not verified', () => {
    expect(isOfficialMatch({ ...base, fullName: 'Royal Canin', isVerified: null })).toBe(false)
  })

  it('THE PHILIPS TRAP, end to end: verified @philips never passes for "Philips India"', () => {
    expect(isOfficialMatch({ brandName: 'Philips India', fullName: 'Philips', isVerified: true })).toBe(false)
  })
})

/**
 * ── @tips_india: A ONE-TOKEN BRAND NAME MAKES THE NAME TEST VACUOUS ─────────
 *
 * The live case, 2026-08-25. `@tips` — "TIPS", 1,147,014 followers, category Publishers —
 * had been a live prospect since 12 August and is the account the post's own caption linked.
 * `@tips_india` is the Tripura Institute of Paramedical Sciences: 2,863 followers, verified,
 * display name "TIPS". It cleared BOTH of `isOfficialMatch`'s questions and received four
 * media-buying pitches before anyone noticed.
 *
 * The first two cases below pin that `isOfficialMatch` still passes it — the vacuous match
 * is a property of one-token names and is NOT what was changed — and the rest pin the guard
 * that now stops it. Mutation-tested: making `duplicatesExistingProspect` return null always
 * fails exactly the two refusal cases and leaves every admit case green.
 */
describe('duplicatesExistingProspect — we already own this brand', () => {
  const live = [
    { handle: 'tips', displayName: 'TIPS' },
    { handle: 'primevideoin', displayName: 'Prime Video' },
    { handle: 'philipsindia', displayName: 'Philips India' },
  ]

  it('the badge bar still passes the college — the guard is what refuses it, not the bar', () => {
    expect(isOfficialMatch({ brandName: 'Tips', fullName: 'TIPS', isVerified: true })).toBe(true)
  })

  it('candidateHandlesFor("Tips") really does generate tips_india', () => {
    expect(candidateHandlesFor('Tips')).toContain('tips_india')
  })

  it('refuses a second account wearing a name we already hold', () => {
    expect(duplicatesExistingProspect('TIPS', 'tips_india', live)).toBe('tips')
  })

  it('is case- and separator-insensitive, because a display name is free text', () => {
    expect(duplicatesExistingProspect('prime video', 'primevideo', live)).toBe('primevideoin')
  })

  it('never refuses the row it IS — re-resolving our own prospect is not a duplicate', () => {
    expect(duplicatesExistingProspect('TIPS', 'tips', live)).toBeNull()
  })

  it('admits a brand we do not already hold', () => {
    expect(duplicatesExistingProspect('Lufthansa', 'lufthansa', live)).toBeNull()
  })

  it('the @philips direction still resolves by NAME, so the trap fixture is untouched', () => {
    // "Philips" is not the same name as "Philips India" — a global page is not a duplicate
    // of the Indian subsidiary, and must still be judged on its own by isOfficialMatch.
    expect(duplicatesExistingProspect('Philips', 'philips', live)).toBeNull()
  })

  it('a two-character "name" is OCR wreckage and never matches', () => {
    expect(duplicatesExistingProspect('TI', 'ti', [{ handle: 'x', displayName: 'TI' }])).toBeNull()
  })

  it('a null display name on either side cannot match', () => {
    expect(duplicatesExistingProspect(null, 'anything', live)).toBeNull()
    expect(duplicatesExistingProspect('TIPS', 'tips_india', [{ handle: 'q', displayName: null }])).toBeNull()
  })
})

describe('nameMatches — the same name with and without a space (2026-09-02)', () => {
  it('accepts a verified page whose full name is the brand name squashed into one token', () => {
    // Measured live: "Jio Star" was the brand string, the verified page is named "JioStar";
    // the token-subset test refused the correct advertiser.
    expect(nameMatches('Jio Star', 'JioStar')).toBe(true)
    expect(nameMatches('JioHotstar', 'Jio Hotstar')).toBe(true)
  })
  it('is EQUALITY of squashed names, never containment — the @philips trap still holds', () => {
    expect(nameMatches('Philips India', 'Philips')).toBe(false)
    expect(nameMatches('Star', 'JioStar')).toBe(false)
    expect(nameMatches('Tips', 'Tips India')).toBe(true) // subset rule, unchanged
  })
})
