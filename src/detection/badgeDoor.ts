import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { enrichHandle } from './enrichHandle'
import { brandCandidatesFor, excludedHandles } from './brandCandidates'
import { createBrandTarget } from '@/outreach/brandTarget'
import { admitsAsTalent } from '@/outreach/targetAudit'
import { getSettings } from '@/lib/settings'
import { detectionCutoff } from '@/lib/cutoff'

/**
 * THE BADGE DOOR — every handle a paid post asserts gets its badge actually CHECKED.
 *
 * ── THE MEASUREMENT THAT FORCED THIS (2026-08-21, Tabish's "We message" column) ───
 *
 * Of 280 handles asserted (caption @mentions + media tags) on the 310 in-window CAMPAIGN
 * posts, ZERO were never-looked — the lookup pipeline keeps up — and yet only 74 were
 * messageable prospects. The rest sat in verdicts nothing would ever revisit:
 *
 *   144  PERSON       — including @amazonmgmstudiosin, @zeemarathiofficial, @rkdstudios,
 *                       @1win: obvious companies the model filed as people, PERMANENTLY,
 *                       because PERSON is a cached answer that never retries. And the
 *                       genuine people among them were ALSO stuck: `admitsAsTalent` needs
 *                       the badge, a cached PERSON carries `isVerified: null`, and NOTHING
 *                       EVER FILLED IT IN — so "a cached PERSON flows through the bar on
 *                       every pass" was true and useless, absence of data hardening into a
 *                       permanent refusal inside the door built for Tabish's talent rule.
 *   43   UNRESOLVED    — model-declined once, never re-asked. @dr_pradeep_sethi (the
 *                       Eugenix founder) and a Park Street jeweller were in there.
 *   5    MISSING       — including @colorstv, which plainly exists.
 *
 * Tabish's rule, 2026-08-21, verbatim: *"for a post if several tags are detected then we
 * must message them provided they are not our monitoring target … provided they have
 * verified accounts."* The VERIFIED ONLY rule already says the badge is the bar; this
 * module makes candidates actually REACH the bar.
 *
 * ── WHAT IT DOES, AND THE ONE THING IT DECIDES ────────────────────────────
 *
 * For each asserted-but-unminted handle whose lookup verdict is PERSON / UNRESOLVED /
 * MISSING / UNKNOWN and whose badge is UNKNOWN (`BrandLookup.isVerified` null): one
 * anonymous FEED enrichment (the endpoint that answers on both hosts), persist the badge,
 * and:
 *
 *   badge TRUE   → a prospect, via `createBrandTarget` with `campaignTalent: true` —
 *                  the same door `admitsAsTalent` admissions use. For a company the model
 *                  mis-filed as a person, the flag is harmless (it only exempts the
 *                  person-guard); for a genuine person it is exactly Tabish's rule.
 *   badge FALSE  → persisted, so the row is never enriched again and the screen can say
 *                  "unverified, refused" instead of the false "nobody verified".
 *   unreachable  → left as it was; a network refusal must not become a verdict.
 *
 * Brand-vs-person judgement is NOT re-litigated here — the badge plus Instagram's own
 * assertion on a PAID post is the admission, per the rule above. The verdicts stay in
 * BrandLookup untouched; only the badge fact is added.
 *
 * Runs on the device agent's brand timer (a feature that works only when someone runs a
 * command is not running) and as `pnpm ig:reaudit` for the backlog drain.
 */

const REVISIT_KINDS = new Set(['PERSON', 'UNRESOLVED', 'MISSING', 'UNKNOWN'])

/** 6s, the same politeness every other consumer of this endpoint pays. */
const ENRICH_SPACING_MS = 6_000

export interface BadgeDoorSummary {
  candidates: number
  enriched: number
  admitted: number
  refusedUnverified: number
  unreachable: number
  haltedEarly: boolean
}

export async function badgeDoorPass(opts: { maxEnrichments: number; dryRun?: boolean }): Promise<BadgeDoorSummary> {
  const dryRun = opts.dryRun ?? false
  const excluded = await excludedHandles()
  const settings = await getSettings()

  const posts = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() } },
    orderBy: { postedAt: 'desc' },
    select: { id: true, shortcode: true, caption: true, taggedAccounts: true, rawPayload: true, target: { select: { handle: true } } },
  })

  /** newest campaign per asserted handle — the provenance the prospect will carry. */
  const newestCampaignFor = new Map<string, { id: string; shortcode: string; channelHandle: string }>()
  for (const p of posts) {
    for (const c of brandCandidatesFor({ caption: p.caption, taggedAccounts: p.taggedAccounts, rawPayload: p.rawPayload }, excluded)) {
      if (!newestCampaignFor.has(c.handle)) {
        newestCampaignFor.set(c.handle, { id: p.id, shortcode: p.shortcode, channelHandle: p.target.handle })
      }
    }
  }

  const handles = [...newestCampaignFor.keys()]
  const [targets, lookups] = await Promise.all([
    prisma.targetAccount.findMany({ where: { handle: { in: handles } }, select: { handle: true } }),
    prisma.brandLookup.findMany({
      where: { handle: { in: handles } },
      select: { handle: true, kind: true, isVerified: true, displayName: true, category: true, followers: true },
    }),
  ])
  const minted = new Set(targets.map((t) => t.handle))
  const lookupBy = new Map(lookups.map((l) => [l.handle, l]))

  const queue = handles.filter((h) => {
    if (minted.has(h)) return false
    const l = lookupBy.get(h)
    if (!l) return false // never-looked belongs to autoResolveBrands, which owns fresh handles
    if (!REVISIT_KINDS.has(l.kind)) return false
    /* A badge already learned is settled either way: TRUE admits below without a new
       call; FALSE is a refusal the screen reports and this pass must not re-spend. */
    return l.isVerified !== false
  })

  const summary: BadgeDoorSummary = {
    candidates: queue.length,
    enriched: 0,
    admitted: 0,
    refusedUnverified: 0,
    unreachable: 0,
    haltedEarly: false,
  }

  for (const handle of queue) {
    const lookup = lookupBy.get(handle)!
    let isVerified = lookup.isVerified
    let displayName = lookup.displayName
    let followers = lookup.followers

    if (isVerified == null) {
      if (summary.enriched >= opts.maxEnrichments) {
        summary.haltedEarly = true
        break
      }
      summary.enriched += 1
      const e = await enrichHandle(handle)
      await new Promise((r) => setTimeout(r, ENRICH_SPACING_MS))
      if (!e.reachable) {
        summary.unreachable += 1
        continue // a refusal to answer is never a verdict — retried on a later pass
      }
      isVerified = e.isVerified
      displayName = displayName ?? e.fullName
      followers = followers ?? e.followers
      if (!dryRun && isVerified != null) {
        await prisma.brandLookup.update({
          where: { handle },
          data: { isVerified, displayName: displayName ?? undefined, followers: followers ?? undefined },
        })
      }
    }

    if (!admitsAsTalent({ isVerified: isVerified ?? null, followerCount: followers ?? null }, settings.celebrityMinFollowers)) {
      summary.refusedUnverified += 1
      continue
    }

    if (dryRun) {
      summary.admitted += 1
      log.info('badge door WOULD admit (dry run)', { handle, displayName: displayName ?? handle })
      continue
    }

    const outcome = await createBrandTarget(
      {
        kind: 'BRAND',
        handle,
        displayName: displayName ?? handle,
        category: lookup.category,
        followers: followers ?? null,
        isVerified: true,
      },
      newestCampaignFor.get(handle) ?? null,
      'brand.badge-door',
      'badge-door',
      { campaignTalent: true, isVerified: true, followerCount: followers ?? null },
    )
    if (outcome === 'created') {
      summary.admitted += 1
      log.info('badge door admitted a verified account a paid post asserted', {
        handle,
        via: newestCampaignFor.get(handle)?.shortcode,
      })
    }
  }

  return summary
}
