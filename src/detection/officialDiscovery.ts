/**
 * DISCOVERING THE ADVERTISER BEHIND A PAID POST THAT NAMES NOBODY — automatically.
 *
 * ── WHY THIS EXISTS AS A FUNCTION AND NOT ONLY AS A COMMAND ────────────────
 *
 * Tabish, 2026-08-20: *"we cannot lose leads in posts with no tags, so we discover valid
 * verified instagram accounts and add them as target and message them."* MEASURED the same
 * morning: **172 in-window CAMPAIGN posts assert no handle at all** — no caption mention,
 * no media tag, no collaborator — and by design each yielded NO prospect. That is the
 * population this closes.
 *
 * It is a FUNCTION shared with `pnpm ig:find-official` rather than logic living in the
 * script, because this repo's most expensive recurring lesson is that **a feature which
 * works only when someone runs a command is not running** — 166 cover frames were saved in
 * one day and none were read for exactly that reason. The device agent calls this on its
 * brand-discovery timer, so untagged posts produce prospects with nobody present.
 *
 * ── THE BAR IS THE BADGE, AND NOTHING ELSE ────────────────────────────────
 *
 * `isOfficialMatch`: Instagram shows the verified badge AND the profile name covers every
 * token of the brand name. No follower fallback, no "it exists so it must be them".
 * Constructing a handle from a name was measured wrong 4 times in 10 with 3 of the 4 wrong
 * handles EXISTING — `@philips` is the global HQ and `@philipsindia` ran the campaign — so
 * existence proves nothing and only the badge plus the name is allowed to auto-create.
 *
 * Anything that resolves but fails the bar is REPORTED for a person (`--accept`), never
 * guessed at: a wrong "official page" is a media-buying pitch to a stranger from a revenue
 * account.
 */
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { detectionCutoff } from '@/lib/cutoff'
import { enrichHandle } from './enrichHandle'
import { candidateHandlesFor, isOfficialMatch } from './officialHandle'
import { brandCandidatesFor, excludedHandles } from './brandCandidates'
import { createBrandTarget } from '@/outreach/brandTarget'

/** 6s apart, like every other use of this endpoint: politeness against an undocumented API. */
const LOOKUP_SPACING_MS = 6_000

const OCR_STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'NEW', 'FIRST', 'INSIDE', 'VIEW', 'LIVE', 'NOW', 'OUT', 'JAN', 'FEB',
  'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'MON', 'TUE', 'WED',
  'THU', 'FRI', 'SAT', 'SUN', 'INDIA', 'OFFICIAL', 'EPISODE', 'SEASON', 'TRAILER', 'TEASER',
])

/**
 * OCR frame text → candidate brand-name tokens. Deliberately crude: nothing here
 * auto-creates on its own, so a junk token costs a bounded lookup and a printed line,
 * never a message. PURE, so the noisy cases are testable.
 */
export function frameBrandTokens(frameText: string | null): string[] {
  if (frameText === null) return []
  const out = new Set<string>()
  for (const raw of frameText.split(/[|•·\n\r,;:!?"“”]+/)) {
    const t = raw.trim()
    if (/^[A-Za-z][A-Za-z0-9&.' -]{2,24}$/.test(t) && !OCR_STOPWORDS.has(t.toUpperCase()) && !/^\d/.test(t)) {
      out.add(t)
    }
  }
  return [...out].slice(0, 3)
}

export interface OfficialDiscoverySummary {
  /** CAMPAIGN posts in the window that name nobody — the population being worked. */
  anonymousPosts: number
  /** Distinct brand names extracted from them. */
  names: number
  looked: number
  created: number
  /** Resolved, but failed the badge bar. Reported, never created. */
  needsHuman: string[]
  haltedEarly: boolean
}

export async function discoverOfficialPages(
  opts: { maxLookups?: number; dryRun?: boolean } = {},
): Promise<OfficialDiscoverySummary> {
  const maxLookups = opts.maxLookups ?? 10
  const dryRun = opts.dryRun ?? false
  const out: OfficialDiscoverySummary = {
    anonymousPosts: 0,
    names: 0,
    looked: 0,
    created: 0,
    needsHuman: [],
    haltedEarly: false,
  }

  const [posts, excluded, targets, senders, looked] = await Promise.all([
    prisma.detectedCampaign.findMany({
      where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() } },
      select: {
        id: true,
        shortcode: true,
        caption: true,
        taggedAccounts: true,
        rawPayload: true,
        brands: true,
        frameText: true,
        target: { select: { handle: true } },
      },
      orderBy: { postedAt: 'desc' },
    }),
    excludedHandles(),
    prisma.targetAccount.findMany({ select: { handle: true } }),
    prisma.senderAccount.findMany({ select: { handle: true } }),
    prisma.brandLookup.findMany({ select: { handle: true } }),
  ])

  /**
   * Everything already answered is skipped BEFORE the budget, never refused after it —
   * the endpoint is the scarce thing, and `tests/auto-resolve.test.ts` asserts that shape
   * for the sibling pass.
   */
  const known = new Set<string>([
    ...targets.map((t) => t.handle.toLowerCase()),
    ...senders.map((s) => s.handle.toLowerCase()),
    ...looked.map((l) => l.handle.toLowerCase()),
    ...excluded,
  ])

  const anonymous = posts.filter(
    (p) =>
      brandCandidatesFor(
        { caption: p.caption, taggedAccounts: p.taggedAccounts, rawPayload: p.rawPayload },
        excluded,
      ).length === 0,
  )
  out.anonymousPosts = anonymous.length

  const names = new Map<string, { source: 'caption' | 'frame'; shortcode: string; campaignId: string }>()
  for (const p of anonymous) {
    let fromCaption: string[] = []
    try {
      fromCaption = (JSON.parse(p.brands) as string[]).filter((b) => typeof b === 'string' && b.length >= 3)
    } catch {
      /* a malformed brands column is that row's problem, not the pass's */
    }
    const list: Array<{ name: string; source: 'caption' | 'frame' }> =
      fromCaption.length > 0
        ? fromCaption.map((name) => ({ name, source: 'caption' as const }))
        : frameBrandTokens(p.frameText).map((name) => ({ name, source: 'frame' as const }))
    for (const { name, source } of list) {
      const key = name.toLowerCase()
      if (!names.has(key)) names.set(key, { source, shortcode: p.shortcode, campaignId: p.id })
    }
  }
  out.names = names.size

  /** Caption names before OCR tokens: the trustworthy source spends the budget first. */
  const ordered = [...names.entries()].sort((a, b) =>
    a[1].source === b[1].source ? 0 : a[1].source === 'caption' ? -1 : 1,
  )

  outer: for (const [name, info] of ordered) {
    for (const candidate of candidateHandlesFor(name)) {
      if (known.has(candidate)) continue
      if (out.looked >= maxLookups) break outer
      const e = await enrichHandle(candidate)
      out.looked += 1
      known.add(candidate)
      await new Promise((r) => setTimeout(r, LOOKUP_SPACING_MS))

      if (!e.reachable) {
        /**
         * A REAL THROTTLE STOPS THE PASS. Continuing after being told to stop is what turns
         * throttling into an IP block — the same split `interpretLookupFailure` owns for the
         * sibling pass, where reading a per-handle failure as a run-wide one cost three
         * consecutive zero-progress runs.
         */
        if ((e.reason ?? '').includes('429')) {
          out.haltedEarly = true
          break outer
        }
        continue
      }

      if (isOfficialMatch({ brandName: name, fullName: e.fullName, isVerified: e.isVerified })) {
        if (!dryRun) {
          const outcome = await createBrandTarget(
            { kind: 'BRAND', handle: candidate, displayName: e.fullName ?? name, category: null, followers: e.followers, isVerified: e.isVerified },
            { id: info.campaignId, shortcode: info.shortcode },
            'brand.discovered',
            'official-discovery',
            { isVerified: e.isVerified, followerCount: e.followers },
          )
          if (outcome === 'created') out.created += 1
        } else {
          out.created += 1
        }
        continue outer // one official page per brand name is the whole point
      }
      out.needsHuman.push(`"${name}" → @${candidate} (${e.fullName ?? '—'}, verified=${e.isVerified ?? '?'})`)
    }
  }

  log.info('official-page discovery pass', {
    anonymousPosts: out.anonymousPosts,
    names: out.names,
    looked: out.looked,
    created: out.created,
    needsHuman: out.needsHuman.length,
    haltedEarly: out.haltedEarly,
  })
  return out
}
