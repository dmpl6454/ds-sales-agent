/**
 * Name → official page, with the measured trap as a permanent fixture: a handle
 * constructed from a name was wrong 4/10, and 3 of the 4 wrong handles EXIST —
 * `@philips` (global HQ, verified) for a "Philips India" campaign. Existence is not
 * identity; only a verified badge + covering name, or size + exact name, may pass.
 */
import { describe, expect, it } from 'vitest'
import { candidateHandlesFor, nameMatches, isOfficialMatch } from '@/detection/officialHandle'

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

describe('isOfficialMatch', () => {
  const base = { brandName: 'Royal Canin', officialMinFollowers: 100_000 }

  it('accepts a verified account whose name covers the brand', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Royal Canin India', isVerified: true, followerCount: 5_000, isBusiness: true }),
    ).toBe(true)
  })

  it('REJECTS a verified account with the wrong name — a badge on the wrong account is the trap', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Ryan Canin', isVerified: true, followerCount: 900_000, isBusiness: true }),
    ).toBe(false)
  })

  it('accepts an unverified account only on size AND exact name AND business', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Royal Canin', isVerified: null, followerCount: 250_000, isBusiness: true }),
    ).toBe(true)
  })

  it('rejects big-but-unverified when the name is not EXACT (covering is not enough without the badge)', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Royal Canin Fan Club', isVerified: false, followerCount: 250_000, isBusiness: true }),
    ).toBe(false)
  })

  it('rejects below the follower floor without a badge', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Royal Canin', isVerified: false, followerCount: 90_000, isBusiness: true }),
    ).toBe(false)
  })

  it('rejects a personal (non-business) account without a badge, whatever its size', () => {
    expect(
      isOfficialMatch({ ...base, fullName: 'Royal Canin', isVerified: false, followerCount: 2_000_000, isBusiness: false }),
    ).toBe(false)
  })

  it('THE PHILIPS TRAP, end to end: verified @philips never passes for "Philips India"', () => {
    expect(
      isOfficialMatch({
        brandName: 'Philips India',
        fullName: 'Philips',
        isVerified: true,
        followerCount: 268_000,
        isBusiness: true,
        officialMinFollowers: 100_000,
      }),
    ).toBe(false)
  })
})
