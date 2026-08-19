/**
 * The talent bar (Tabish, 2026-08-19): a PERSON on a CAMPAIGN post's Instagram-asserted
 * evidence becomes a messageable target when verified or truly big — and ONLY rows
 * created that way pass the person guard. The guard's original job (refusing ACCIDENTAL
 * people, like a celebrity whose vanity category reads "Private Investigator") is
 * unchanged, and the test drives both directions of both halves.
 */
import { describe, expect, it, vi } from 'vitest'

// The import chains reach @/lib/db at module scope; stub it so the pure rules are
// testable regardless of which provider the generated client currently carries.
vi.mock('@/lib/db', () => ({ prisma: {} }))

import { admitsAsTalent } from '@/outreach/targetAudit'
import { checkRecipientIsNotAPerson } from '@/outreach/brandGuards'

describe('admitsAsTalent', () => {
  it('a verified badge admits, whatever the size', () => {
    expect(admitsAsTalent({ isVerified: true, followerCount: 1_200 }, 500_000)).toBe(true)
  })

  it('an unverified person admits only at or above the follower bar', () => {
    expect(admitsAsTalent({ isVerified: false, followerCount: 500_000 }, 500_000)).toBe(true)
    expect(admitsAsTalent({ isVerified: false, followerCount: 499_999 }, 500_000)).toBe(false)
  })

  it('NULL facts never admit — absence of size is not size', () => {
    expect(admitsAsTalent({ isVerified: null, followerCount: null }, 500_000)).toBe(false)
    expect(admitsAsTalent({ isVerified: false, followerCount: null }, 500_000)).toBe(false)
  })
})

describe('the person guard with campaignTalent', () => {
  it('admits a deliberately-created talent row despite a person-role category', () => {
    const r = checkRecipientIsNotAPerson({
      targetKind: 'BRAND',
      brandCategory: 'Artist',
      handle: 'a-verified-celebrity',
      campaignTalent: true,
    })
    expect(r.ok).toBe(true)
  })

  it('still refuses the identical row WITHOUT the flag — accidental people stay refused', () => {
    const r = checkRecipientIsNotAPerson({
      targetKind: 'BRAND',
      brandCategory: 'Artist',
      handle: 'a-vanity-category-brand',
      campaignTalent: false,
    })
    expect(r.ok).toBe(false)
  })

  it('the standing fixture holds: @ananyapanday-as-"Private Investigator" is still refused', () => {
    const r = checkRecipientIsNotAPerson({
      targetKind: 'BRAND',
      brandCategory: 'Private Investigator',
      handle: 'ananyapanday',
      campaignTalent: false,
    })
    expect(r.ok).toBe(false)
  })
})
