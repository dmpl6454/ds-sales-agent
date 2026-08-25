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
import { candidateHandlesFor, isOfficialMatch, duplicatesExistingProspect } from './officialHandle'
import { brandCandidatesFor, excludedHandles } from './brandCandidates'
import { createFailureMemory } from './lookupCooldown'
import { isOwnMark } from './ownMarks'
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

/** Failure memory for candidate HANDLES. See `lookupCooldown.ts` — third module to need it. */
const unreachable = createFailureMemory()

/**
 * AND A SECOND MEMORY, FOR CANDIDATES THAT ANSWERED AND DID NOT MATCH (2026-08-24).
 *
 * ── THE FOURTH LIVELOCK, AND THE COOLDOWN COVERED THE WRONG HALF ───────────
 *
 * `lookupCooldown.ts` records the signature to look for — *identical summary numbers on
 * consecutive passes of a bounded queue* — and this pass was showing it again, one branch
 * over from the fix that was supposed to end it. MEASURED on the live agent log, 61 passes
 * since 23 Aug: **855 lookups spent, 3 prospects created**, and
 * `coolingOff=60 looked=15 created=0 needsHuman=15` byte-identical across four consecutive
 * passes, with the needsHuman line itself byte-identical across eight:
 *
 *     "prime video" → @prime_video (Rosiane Silva, verified=false)
 *                   | @primevideoindia (MEMENAUTIX, verified=false)
 *                   | @primevideo.official (—, verified=false)
 *
 * The cause is that `unreachable` only remembers a candidate that DID NOT ANSWER. A
 * candidate that answers and then fails `isOfficialMatch` was `clear()`ed — correctly, as far
 * as reachability goes — and `known` is per-pass, and this pass never persists a candidate to
 * `BrandLookup`. So the name queue, sorted by how many paid posts assert each name, kept
 * "prime video" at the front permanently and re-resolved the same three wrong accounts every
 * thirty minutes. `looked=15` with `needsHuman=15` is 100% of the budget going to candidates
 * that were already resolved and rejected on the previous pass, while the 1,025 harvested
 * names behind the stuck front were never reached at all.
 *
 * TWO MEMORIES, NOT ONE, because they answer different questions and a reachable answer must
 * still clear the unreachability memory without also forgetting the rejection — the same
 * discipline that keeps `not-in-thread` out of the provably-undelivered class, and that
 * `ThreadBodies` applied when one input was serving two questions with opposite safe
 * directions.
 *
 * IN-PROCESS AND TIME-BASED, like its sibling: a rejection is a verdict about the profile as
 * it reads TODAY, and a page can be verified or renamed tomorrow. Persisting it would make
 * `known` exclude that handle forever, which is absence-of-a-match hardening into a permanent
 * refusal — this codebase's most-repeated defect. A restart costs one pass of relearning.
 */
const rejected = createFailureMemory()

/** Test seam: module state would otherwise leak between cases in one suite process. */
export function resetOfficialDiscoveryMemory(): void {
  unreachable.reset()
  rejected.reset()
}

export interface HarvestPost {
  id: string
  shortcode: string
  caption: string
  taggedAccounts: string
  rawPayload: string | null
  brands: string
  frameText: string | null
  target: { handle: string }
}

export interface BrandNameHarvest {
  names: Map<string, { source: 'caption' | 'frame'; shortcode: string; campaignId: string; posts: number }>
  anonymousPosts: number
  postsWithNames: number
}

/**
 * ── EVERY PAID POST'S BRAND NAMES, NOT ONLY THOSE OF POSTS THAT NAME NOBODY ──────
 *
 * PURE, and exported so the regression below is testable without a database.
 *
 * The caller used to filter to `brandCandidatesFor(...).length === 0` before reading the
 * `brands` column, so a post that asserted ONE handle had ALL of its other brand names
 * discarded — permanently, because nothing else reads that column for discovery.
 *
 * MEASURED 2026-08-23, the morning Tabish reported "paid posts are blatantly missing
 * company tags": of 638 in-window CAMPAIGN posts carrying brand names, **385 asserted at
 * least one handle and were skipped entirely** — 60% of the population. His own examples
 * are exactly this: a @naughtyworld post tagging @fukra_insaan carried the brands "Prime
 * Video" and "The Traitors", and neither was ever looked up because that one tag
 * disqualified the whole row.
 *
 * The tag and the brand name are DIFFERENT ADVERTISERS as often as not — the tag is usually
 * the talent in shot, the brand name is who paid. Treating the presence of one as evidence
 * about the other is the same shape as the bugs this file already guards against.
 *
 * Widening is safe by construction: `isOfficialMatch` is unchanged, so a junk name still
 * cannot auto-create anything. The worst a bad name costs is one bounded lookup and a
 * printed line for a person.
 *
 * FREQUENCY is the ranking signal, and it is the honest one: a brand named on five separate
 * paid posts is a far better lead than one named once, and junk (a publisher's series code,
 * an OCR fragment) is almost always named once. The budget is small, so what it is spent on
 * FIRST is the whole game.
 */
export function harvestBrandNames(
  posts: readonly HarvestPost[],
  excluded: Parameters<typeof brandCandidatesFor>[1],
): BrandNameHarvest {
  let anonymousPosts = 0
  const names: BrandNameHarvest['names'] = new Map()

  for (const p of posts) {
    const assertsNobody =
      brandCandidatesFor(
        { caption: p.caption, taggedAccounts: p.taggedAccounts, rawPayload: p.rawPayload },
        excluded,
      ).length === 0
    if (assertsNobody) anonymousPosts += 1

    let fromCaption: string[] = []
    try {
      fromCaption = (JSON.parse(p.brands) as string[]).filter(
        (b) =>
          typeof b === 'string' &&
          b.length >= 3 &&
          // A publisher's own name or series code is not a third party. `ownMarks` already
          // stops these reaching a VERDICT; it never reached discovery, so `fg9` and
          // `rvcjinsta` were still being offered a scarce lookup budget.
          !isOwnMark(b, { handle: p.target.handle, displayName: null }),
      )
    } catch {
      /* a malformed brands column is that row's problem, not the pass's */
    }

    const list: Array<{ name: string; source: 'caption' | 'frame' }> =
      fromCaption.length > 0
        ? fromCaption.map((name) => ({ name, source: 'caption' as const }))
        : frameBrandTokens(p.frameText).map((name) => ({ name, source: 'frame' as const }))

    for (const { name, source } of list) {
      const key = name.toLowerCase()
      const seen = names.get(key)
      if (seen) seen.posts += 1
      else names.set(key, { source, shortcode: p.shortcode, campaignId: p.id, posts: 1 })
    }
  }

  return { names, anonymousPosts, postsWithNames: posts.length }
}

export interface OfficialDiscoverySummary {
  /** In-window CAMPAIGN posts carrying at least one brand NAME — the population worked. */
  postsWithNames: number
  /** Of those, the ones that assert no handle at all. Reported for continuity. */
  anonymousPosts: number
  /** Distinct brand names extracted from them. */
  names: number
  /** Candidate handles held back by an unexpired failure cooldown. Never silent. */
  coolingOff: number
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
    postsWithNames: 0,
    anonymousPosts: 0,
    coolingOff: 0,
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
    prisma.targetAccount.findMany({ select: { handle: true, displayName: true, role: true, optedOut: true } }),
    prisma.senderAccount.findMany({ select: { handle: true } }),
    prisma.brandLookup.findMany({ select: { handle: true } }),
  ])

  /**
   * Everything already answered is skipped BEFORE the budget, never refused after it —
   * the endpoint is the scarce thing, and `tests/auto-resolve.test.ts` asserts that shape
   * for the sibling pass.
   */
  /* Live prospects only: a retired row must not block re-acquiring the brand properly, which
     is the whole reason retirement never deletes (see the VERIFIED ONLY rule in CLAUDE.md). */
  const liveProspects = targets.filter((t) => t.role === 'PROSPECT' && !t.optedOut)

  const known = new Set<string>([
    ...targets.map((t) => t.handle.toLowerCase()),
    ...senders.map((s) => s.handle.toLowerCase()),
    ...looked.map((l) => l.handle.toLowerCase()),
    ...excluded,
  ])

  const harvest = harvestBrandNames(posts, excluded)
  const names = harvest.names
  out.anonymousPosts = harvest.anonymousPosts
  out.names = names.size
  out.postsWithNames = harvest.postsWithNames

  /**
   * Caption names before OCR tokens — the trustworthy source spends the budget first — and
   * within each source, the name asserted on the MOST paid posts first.
   */
  const ordered = [...names.entries()].sort((a, b) => {
    if (a[1].source !== b[1].source) return a[1].source === 'caption' ? -1 : 1
    return b[1].posts - a[1].posts
  })

  /* Fairness, shared with the badge door (`lookupCooldown.ts`). The queue here is over
     NAMES but a failure belongs to a candidate HANDLE, so the cooldown is applied inside
     the loop: a candidate that just failed is skipped WITHOUT a lookup, which is what stops
     dead handles consuming a 5-lookup budget every pass. That was this pass's actual state,
     measured as `names=304 looked=5 created=0 needsHuman=1` repeating byte-identically
     across six consecutive passes. */
  outer: for (const [name, info] of ordered) {
    for (const candidate of candidateHandlesFor(name)) {
      if (known.has(candidate)) continue
      /* Did not answer last time, or answered and was not this brand's official page. Either
         way it must not spend a lookup this pass. Both are COUNTED, never silently dropped. */
      if (unreachable.isCoolingOff(candidate) || rejected.isCoolingOff(candidate)) {
        out.coolingOff += 1
        continue
      }
      if (out.looked >= maxLookups) break outer
      const e = await enrichHandle(candidate)
      out.looked += 1
      known.add(candidate)
      await new Promise((r) => setTimeout(r, LOOKUP_SPACING_MS))

      if (!e.reachable) {
        // A refusal to answer is never a verdict — but it IS a reason to stop spending the
        // front of every pass on this candidate. Sent to the back for a day.
        unreachable.note(candidate)
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

      unreachable.clear(candidate)

      if (isOfficialMatch({ brandName: name, fullName: e.fullName, isVerified: e.isVerified })) {
        /**
         * ONE MORE QUESTION BEFORE MINTING: do we already own this brand's page?
         *
         * A one-token brand name makes `nameMatches` vacuous — see the docblock on
         * `duplicatesExistingProspect`. @tips_india (a paramedical college) passed both of
         * this bar's questions while @tips (the real label, 1.1M followers) had been a live
         * prospect for thirteen days. Reported for a person, never guessed at.
         */
        const dup = duplicatesExistingProspect(e.fullName, candidate, liveProspects)
        if (dup !== null) {
          rejected.note(candidate)
          out.needsHuman.push(
            `"${name}" → @${candidate} (${e.fullName ?? '—'}) — we already have @${dup} under that name; a second account for one brand is a duplicate lead`,
          )
          continue outer
        }
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
      /* It answered and it is not them. Report it for a person (`--accept` is the deliberate
         door), and send it to the back for a day so the next pass reaches a NEW name instead
         of re-resolving this one. Without this line the front of the queue never moves. */
      rejected.note(candidate)
      out.needsHuman.push(`"${name}" → @${candidate} (${e.fullName ?? '—'}, verified=${e.isVerified ?? '?'})`)
    }
  }

  log.info('official-page discovery pass', {
    postsWithNames: out.postsWithNames,
    anonymousPosts: out.anonymousPosts,
    names: out.names,
    coolingOff: out.coolingOff,
    looked: out.looked,
    created: out.created,
    needsHuman: out.needsHuman.length,
    haltedEarly: out.haltedEarly,
  })
  return out
}
