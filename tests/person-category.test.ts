import { describe, it, expect } from 'vitest'
import { isPersonRoleCategory, classifyProfile } from '@/detection/resolveBrand'
import { checkRecipientIsNotAPerson, BRAND_BLOCKS } from '@/outreach/brandGuards'

/**
 * "Is this category a PROFESSION or a BUSINESS?" — the rule that decides whether a media
 * -buying pitch reaches a company or a private individual.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `PERSON_CATEGORIES` was a `Set` compared with exact equality and it contained
 * `'director'`, `'producer'` and `'artist'`. Instagram returns `"Film Director"`,
 * `"Film Producer"` and `"Creators & Celebrities"`. None of them ever matched, and the set
 * read as thorough — forty entries and a comment naming the fashion-designer bug it had
 * already been extended for. That earlier fix worked only because "Fashion Designer" is
 * exactly one of Instagram's labels.
 *
 * MEASURED on the live 68 BRAND targets, 2026-08-13: 8 human beings queued for a
 * media-buying pitch from a revenue account.
 *
 * ── EVERY STRING BELOW IS A REAL ONE ──────────────────────────────────────
 *
 * Both tables are `TargetAccount.brandCategory` values read from the live database. The
 * COMPANY table is the one carrying the weight: a rule that matched person-words as bare
 * substrings would file "Broadcasting & media production company" as a person on
 * "production", and every one of these is a genuine prospect that must survive.
 */

/** Live categories that name a profession. A pitch to these reaches a person. */
const PEOPLE: [category: string, handle: string][] = [
  ['Film Director', 'ksubbaraj'],
  ['Film Director', 'devrukhkar.vishal'],
  ['Film Producer', 'fragrantnaturefilmcreationsofc'],
  ['Creators & Celebrities', 'rahuldevofficial'],
  ['Creators & Celebrities', 'shalini.passi'],
  // Already covered by the old exact-match set; kept so the fix cannot lose them.
  ['Artist', 'elvish_yadav'],
  ['Fashion Designer', 'bharat_reshma'],
  ['Public Figure', 'adityathackeray'],
]

/** Live categories that name a business. Every one must survive the rule. */
const COMPANIES: [category: string, handle: string][] = [
  ['Personal Goods & General Merchandise Stores', 'amazondotin'],
  ['Grocery & Convenience Stores', 'royalcanin.india'],
  ['Broadcasting & media production company', 'banijayasia'],
  ['Movie/television studio', 'excelmovies'],
  ['Health Food Store', 'safadryfruitsandspices'],
  ['Publishers', 'universalmusicgroup'],
  ['Brand', 'gulfoil.india'],
  ['Product/service', 'idfreshfood'],
  ['Clothing (Brand)', 'kalkifashion'],
  ['Ice Cream Shop', 'milano_icecream_bangalore'],
  ['Food & Personal Goods', 'nutellaindia'],
]

describe('isPersonRoleCategory', () => {
  it.each(PEOPLE)('"%s" is a profession (@%s)', (category) => {
    expect(isPersonRoleCategory(category)).toBe(true)
  })

  it.each(COMPANIES)('"%s" is a business (@%s)', (category) => {
    expect(isPersonRoleCategory(category)).toBe(false)
  })

  it('does not match a person-word buried inside another word', () => {
    // "production" must not match "producer"; "modelling" must not match "model".
    expect(isPersonRoleCategory('Media production company')).toBe(false)
    expect(isPersonRoleCategory('Modelling agency')).toBe(false)
  })

  it('an absent category is NOT evidence of anything', () => {
    // Absence of data must never harden into a verdict — this codebase's signature failure.
    expect(isPersonRoleCategory(null)).toBe(false)
    expect(isPersonRoleCategory(undefined)).toBe(false)
    expect(isPersonRoleCategory('')).toBe(false)
    expect(isPersonRoleCategory('   ')).toBe(false)
  })
})

describe('classifyProfile now files a film director as a PERSON', () => {
  const pro = { isBusinessAccount: true, isProfessionalAccount: true, followers: 100_000 }

  it.each(PEOPLE)('"%s" → PERSON even though the account is a business account', (category, handle) => {
    expect(classifyProfile({ handle, category, ...pro }).kind).toBe('PERSON')
  })

  it.each(COMPANIES)('"%s" → BRAND (@%s)', (category, handle) => {
    expect(classifyProfile({ handle, category, fullName: 'Some Co', ...pro }).kind).toBe('BRAND')
  })
})

describe('the planner refuses a recipient already filed as a BRAND but categorised as a person', () => {
  /**
   * A classification fix does not reclassify rows already written. These 8 exist with pair
   * rows today, so the protection has to be in the path — a report nobody runs is not
   * protection, which is the lesson of the 166 cover frames saved and never read.
   */
  it.each(PEOPLE)('holds a draft to @%s… ', (category, handle) => {
    const r = checkRecipientIsNotAPerson({ targetKind: 'BRAND', brandCategory: category, handle })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(BRAND_BLOCKS.RECIPIENT_IS_A_PERSON)
    // The refusal names the category, so an operator can see what to correct.
    expect(r.ok === false && r.detail).toContain(category)
  })

  it.each(COMPANIES)('permits a draft to a "%s" (@%s)', (category, handle) => {
    expect(checkRecipientIsNotAPerson({ targetKind: 'BRAND', brandCategory: category, handle }).ok).toBe(true)
  })

  it('says nothing about CHANNELS — this guard is brand-only, like the other two', () => {
    expect(
      checkRecipientIsNotAPerson({ targetKind: 'CHANNEL', brandCategory: 'Film Director', handle: 'viralbhayani' }).ok,
    ).toBe(true)
  })

  it('permits a brand with no category at all rather than refusing on absence', () => {
    // 38 of the 68 live BRAND rows have no category. Refusing them would retire more than
    // half the prospect list on the basis of missing data.
    expect(checkRecipientIsNotAPerson({ targetKind: 'BRAND', brandCategory: null, handle: 'agoracitycentre' }).ok).toBe(
      true,
    )
  })
})
