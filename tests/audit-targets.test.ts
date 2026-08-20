/**
 * `auditTarget` — which live prospects deserve a second human look.
 *
 * The rule FLAGS, it never retires: the measured lesson (`usableName`, 2026-08-13) is
 * that an obvious-looking predicate run over the real population refuses rows it must
 * not, so every flag lands in front of a person with the evidence beside it. The
 * survivors matter as much as the flags — a NULL verification fact means "never
 * looked", and absence of data must not harden into a negative verdict about a target.
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * `targetAudit` is pure but its import chain (isPersonRoleCategory lives in
 * resolveBrand.ts) reaches `@/lib/db` at module scope. Stubbed so this file tests the
 * RULE regardless of which provider the generated client currently carries — the
 * two-provider trap otherwise makes this test's outcome depend on what ran before it.
 */
vi.mock('@/lib/db', () => ({ prisma: {} }))

import { auditTarget, auditIsJudgeable } from '@/outreach/targetAudit'

const base = {
  brandCategory: 'Movies' as string | null,
  isVerified: true as boolean | null,
  followerCount: 250_000 as number | null,
  exists: true,
  campaignTalent: false,
}

describe('auditTarget', () => {
  it('passes a verified brand with a real category', () => {
    expect(auditTarget(base)).toEqual({ flag: false })
  })

  it('flags a handle that no longer exists', () => {
    expect(auditTarget({ ...base, exists: false })).toEqual({ flag: true, why: 'gone' })
  })

  it('flags a person-role category even when verified — a celebrity enters via campaignTalent, never by audit pass-through', () => {
    expect(auditTarget({ ...base, brandCategory: 'Artist' })).toEqual({ flag: true, why: 'person-role-category' })
  })

  it('never flags a deliberately-admitted campaignTalent row for being a person', () => {
    expect(auditTarget({ ...base, brandCategory: 'Artist', campaignTalent: true })).toEqual({ flag: false })
  })

  it('flags a tiny unverified account — 800 followers is not a media buyer', () => {
    expect(auditTarget({ ...base, isVerified: false, followerCount: 800 })).toEqual({
      flag: true,
      why: 'tiny-unverified',
    })
  })

  /**
   * THE MEASURED CASE, 2026-08-20: `@lego.mybrickhouse` ("My Brickhouse") was messaged from
   * a revenue account two minutes after the real `@legoindia_official`. Business-type
   * account, NO badge, NO category — which classifyProfile reads as BRAND. Critically this
   * must flag WITHOUT a follower count, because the feed endpoint never returns one.
   */
  it('flags an unverified account with no category, with NO follower data at all', () => {
    expect(auditTarget({ ...base, brandCategory: null, isVerified: false, followerCount: null })).toEqual({
      flag: true,
      why: 'unconfirmed-identity',
    })
  })

  it('does NOT flag on NULL verification facts — never looked is not a verdict', () => {
    expect(auditTarget({ ...base, isVerified: null, followerCount: null })).toEqual({ flag: false })
  })

  it('a verified account with no category is fine — the badge answers the question', () => {
    expect(auditTarget({ ...base, brandCategory: null, isVerified: true, followerCount: null })).toEqual({
      flag: false,
    })
  })

  /**
   * The rules that need follower data must still work where it EXISTS (BrandLookup), and
   * must not be the only protection — that was the bug: two of four flags needed a field
   * that is null almost everywhere, so they reported success while judging nothing.
   */
  it('the tiny-unverified rule still fires where a follower count is known', () => {
    expect(auditTarget({ ...base, brandCategory: 'Brand', isVerified: false, followerCount: 400 })).toEqual({
      flag: true,
      why: 'tiny-unverified',
    })
  })
})

describe('auditIsJudgeable — "no flags" must not be confused with "no facts"', () => {
  it('is false when neither the badge nor the category is known', () => {
    expect(auditIsJudgeable({ isVerified: null, brandCategory: null })).toBe(false)
  })

  it('is true on either fact alone', () => {
    expect(auditIsJudgeable({ isVerified: false, brandCategory: null })).toBe(true)
    expect(auditIsJudgeable({ isVerified: null, brandCategory: 'Brand' })).toBe(true)
  })

})
