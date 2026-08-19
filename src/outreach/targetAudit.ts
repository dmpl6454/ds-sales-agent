/**
 * PURE: which live prospects deserve a second human look (Tabish, 2026-08-19: "remove
 * targets that are undesired and faulty").
 *
 * The rule FLAGS, it never retires — the `usableName` lesson is that a plausible
 * predicate run over the real population refuses rows it must not, so every flag lands
 * in front of a person with the evidence beside it (`pnpm ig:audit-targets`), and
 * retirement stays a deliberate act through the existing audited path.
 *
 * NULL verification facts never flag: "never looked" must not harden into "tiny" —
 * absence of data is not a negative verdict, this codebase's most-repeated trap.
 */
import { isPersonRoleCategory } from '@/detection/resolveBrand'

export type TargetAudit =
  | { flag: false }
  | { flag: true; why: 'gone' | 'person-role-category' | 'tiny-unverified' | 'no-category-thin' }

export function auditTarget(t: {
  brandCategory: string | null
  isVerified: boolean | null
  followerCount: number | null
  exists: boolean
  campaignTalent: boolean
}): TargetAudit {
  if (!t.exists) return { flag: true, why: 'gone' }
  // Deliberately-admitted campaign talent is audited by its own bar (verified-or-size
  // at admission, workstream E), not by the brand-shaped rules below.
  if (t.campaignTalent) return { flag: false }
  if (isPersonRoleCategory(t.brandCategory)) return { flag: true, why: 'person-role-category' }
  if (t.isVerified === false && t.followerCount !== null && t.followerCount < 1_000)
    return { flag: true, why: 'tiny-unverified' }
  if (t.brandCategory === null && t.isVerified !== true && t.followerCount !== null && t.followerCount < 5_000)
    return { flag: true, why: 'no-category-thin' }
  return { flag: false }
}

export const AUDIT_WHY_SENTENCE: Record<Exclude<TargetAudit, { flag: false }>['why'], string> = {
  gone: 'the handle no longer resolves on Instagram',
  'person-role-category': 'Instagram lists a profession, not a company — a person misfiled as a brand',
  'tiny-unverified': 'unverified with under 1,000 followers — unlikely to be a media buyer',
  'no-category-thin': 'no category, unverified, small — nothing says this is a real company',
}

/**
 * May a PERSON tagged on a CAMPAIGN post become a messageable target? (Tabish,
 * 2026-08-19: "send messages to celebrities as well if they are part of the paid
 * campaign … which is a legitimate and verified (sometimes might not be the case)
 * account" — the badge admits, and for the unverified the bar is size,
 * `celebrityMinFollowers`, default 500k.)
 *
 * NULL follower counts never admit — absence of size is not size.
 */
export function admitsAsTalent(
  e: { isVerified: boolean | null; followerCount: number | null },
  minFollowers: number,
): boolean {
  if (e.isVerified === true) return true
  return e.followerCount !== null && e.followerCount >= minFollowers
}
