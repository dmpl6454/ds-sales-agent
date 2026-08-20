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
