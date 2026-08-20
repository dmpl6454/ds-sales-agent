/**
 * PURE: which live prospects deserve a second human look (Tabish, 2026-08-19: "targets
 * identified should not be faulty"; 2026-08-20: "are we sending them to authentic users").
 *
 * ── CORRECTED 2026-08-20 AFTER MEASURING THE DATA IT ACTUALLY GETS ──────────
 *
 * The first version leaned on `followerCount`, and **that field is null almost everywhere**:
 * `enrichHandle` reads the anonymous FEED endpoint, whose user object carries
 * `is_verified` and `full_name` but **no follower count at all** — probed live on three
 * handles, null every time. Follower data exists only in `BrandLookup`, from the profile
 * endpoint that 429s on the server and 400s on Meta's deleted category schema: 55 rows of
 * 438. So two of the four original flags could never fire, and `admitsAsTalent`'s size arm
 * and `isOfficialMatch`'s size arm were dead with them.
 *
 * A guard nobody can trigger is not a guard — this codebase's signature failure, shipped
 * here by me one day earlier. So the rules now key on what is RELIABLY known (verified
 * badge, category) and the follower rules stay only because the caller now feeds them from
 * `BrandLookup` where it has a value. The caller must also REPORT how many rows it could
 * not judge, because "no flags" and "no data" look identical otherwise.
 *
 * The rule FLAGS, it never retires — the `usableName` lesson is that a plausible predicate
 * over the real population refuses rows it must not, so every flag lands in front of a
 * person with the evidence beside it (`pnpm ig:audit-targets`).
 *
 * NULL facts never flag: "never looked" must not harden into a verdict. Absence of data is
 * not a negative answer, this codebase's most-repeated trap.
 */
import { isPersonRoleCategory } from '@/detection/resolveBrand'

export type AuditWhy =
  /** The handle no longer resolves. Wrong beyond argument. */
  | 'gone'
  /** Instagram names a PROFESSION. A person misfiled as a company. */
  | 'person-role-category'
  /** Unverified AND Instagram tells us nothing about what it is. Cannot confirm it is a real company. */
  | 'unconfirmed-identity'
  /** Unverified and demonstrably tiny. Only reachable where follower data exists. */
  | 'tiny-unverified'

export type TargetAudit = { flag: false } | { flag: true; why: AuditWhy }

export function auditTarget(t: {
  brandCategory: string | null
  isVerified: boolean | null
  followerCount: number | null
  exists: boolean
  campaignTalent: boolean
}): TargetAudit {
  if (!t.exists) return { flag: true, why: 'gone' }
  // Deliberately-admitted campaign talent is audited by its own bar (verified-or-size at
  // admission, workstream E), not by the brand-shaped rules below.
  if (t.campaignTalent) return { flag: false }
  if (isPersonRoleCategory(t.brandCategory)) return { flag: true, why: 'person-role-category' }
  if (t.isVerified === false && t.followerCount !== null && t.followerCount < 1_000)
    return { flag: true, why: 'tiny-unverified' }
  /**
   * THE lego.mybrickhouse CASE, and the reason this rule needs no follower count.
   *
   * MEASURED 2026-08-20: `@lego.mybrickhouse` ("My Brickhouse") was messaged from a revenue
   * account two minutes after the real `@legoindia_official` ("LEGO India", verified). It is
   * a business-type account with NO category and NO badge — which `classifyProfile` reads as
   * BRAND, because a professional account with nothing else known falls to the business
   * branch. That is absence-of-data becoming a positive verdict, one door along.
   *
   * Deliberately worded as UNCONFIRMED rather than faulty: real Indian brands without a blue
   * tick sit here too (Senco Gold, Shiprocket, Wildstone), and this is a review queue, not a
   * retirement list. Both readings are for a person.
   */
  if (t.isVerified !== true && t.brandCategory === null) return { flag: true, why: 'unconfirmed-identity' }
  return { flag: false }
}

/** Can this row be judged at all, or are we short of the facts? Reported, never silent. */
export function auditIsJudgeable(t: { isVerified: boolean | null; brandCategory: string | null }): boolean {
  return t.isVerified !== null || t.brandCategory !== null
}

export const AUDIT_WHY_SENTENCE: Record<AuditWhy, string> = {
  gone: 'the handle no longer resolves on Instagram',
  'person-role-category': 'Instagram lists a profession, not a company — a person misfiled as a brand',
  'unconfirmed-identity':
    'no verified badge and no category — we cannot confirm this is the company’s official page rather than a fan or reseller account',
  'tiny-unverified': 'unverified with under 1,000 followers — unlikely to be a media buyer',
}

/**
 * May a PERSON tagged on a CAMPAIGN post become a messageable target? (Tabish,
 * 2026-08-19: "send messages to celebrities as well if they are part of the paid
 * campaign … which is a legitimate and verified (sometimes might not be the case)
 * account" — the badge admits, and for the unverified the bar is size,
 * `celebrityMinFollowers`, default 500k.)
 *
 * NULL follower counts never admit — absence of size is not size. NOTE, measured
 * 2026-08-20: the feed endpoint returns no follower count, so in practice the size arm
 * fires only for handles `BrandLookup` already holds a count for. That makes this
 * effectively verified-only today, which is the SAFE direction — but it is narrower than
 * it reads, and nobody should assume the size arm is doing work.
 */
export function admitsAsTalent(
  e: { isVerified: boolean | null; followerCount: number | null },
  minFollowers: number,
): boolean {
  if (e.isVerified === true) return true
  return e.followerCount !== null && e.followerCount >= minFollowers
}
