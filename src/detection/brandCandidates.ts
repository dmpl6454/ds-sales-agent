import { prisma } from '@/lib/db'
import { mentionsIn, taggedHandlesIn } from './resolveBrand'

/**
 * WHICH HANDLES A PAID POST OFFERS AS BRAND CANDIDATES — the ONE definition, two callers.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────
 *
 * There are two sources and they were assembled in two places. `autoResolveBrands` read
 * captions AND tags; `pnpm ig:brands` read captions only, and skipped a post entirely when
 * its caption carried no mention.
 *
 * MEASURED, and it is the reason this file exists rather than a comment: **51% of in-window
 * CAMPAIGN posts carry no usable caption @mention.** So the CLI could not see half of every
 * paid post — exactly the half the tag source was added for — while the pass that COULD see
 * them is 429'd on the Linode on its first lookup of every pass. The feature was reachable
 * from neither path in production.
 *
 * This is the fifth time one rule with several callers has drifted here, after `gate.ts`,
 * `readThread.ts`, the two Connect buttons and `judge.ts`. `tests/brand-candidates.test.ts`
 * greps the call sites, because the failure mode is a caller nobody has written yet.
 *
 * PURE. The exclusion set is passed in, because who we own and who we watch is a database
 * fact and this file must stay testable without one.
 */

export interface BrandCandidate {
  handle: string
  /**
   * WHERE THE HANDLE CAME FROM, and it decides priority rather than merely recording it.
   *
   * The bound on a pass is a LOOKUP budget, so a weaker candidate taking a slot is a
   * stronger one not taken. A caption @mention is the publisher writing the advertiser's
   * name; a TAG is Instagram saying an account appears in the media, which is true of the
   * celebrity as often as the buyer. MEASURED, the correlation even INVERTS on one channel:
   * @bollywoodchronicle tags someone in 46.3% of ORGANIC posts against 20.0% of CAMPAIGN.
   *
   * So a mention is always offered before a tag. `orderForLookup` ranks on this first.
   */
  source: 'mention' | 'tag'
}

export interface PostEvidence {
  caption: string | null
  /** `DetectedCampaign.taggedAccounts` — a JSON array string. */
  taggedAccounts: string
  /** `DetectedCampaign.rawPayload`, which also carries `collabHandles`. */
  rawPayload: string | null
}

/**
 * Candidates for one post, mentions first, de-duplicated, with anything that can never be
 * a prospect removed.
 *
 * ── THE EXCLUSION HAPPENS HERE, BEFORE THE BUDGET, NOT AFTER IT ──────────
 *
 * @viralbhayani and @bollywoodpap appear in their own posts' tags, and our own sending
 * accounts appear in ours. `routes.ts` would refuse the route anyway — but only AFTER the
 * lookup had been spent, and the endpoint is the scarce thing. `tests/auto-resolve.test.ts`
 * asserts `looked: 0` for one of our own senders for exactly this reason; it used to assert
 * `looked: 1`, which was a refusal that had already paid for itself.
 */
export function brandCandidatesFor(
  post: PostEvidence,
  neverAProspect: ReadonlySet<string>,
): BrandCandidate[] {
  const seen = new Set<string>()
  const out: BrandCandidate[] = []

  const offer = (handle: string, source: BrandCandidate['source']) => {
    const h = handle.toLowerCase()
    if (neverAProspect.has(h)) return
    if (seen.has(h)) return
    seen.add(h)
    out.push({ handle: h, source })
  }

  // Mentions FIRST, so a handle carried by both sources is recorded as the stronger one.
  for (const h of mentionsIn(post.caption ?? '')) offer(h, 'mention')
  for (const h of taggedHandlesIn(post.taggedAccounts, post.rawPayload)) offer(h, 'tag')

  return out
}

/**
 * The handles that must never cost a lookup — THE DATABASE HALF, kept beside the pure
 * function for the same reason `cohorts.ts` keeps its reader beside the ladder.
 *
 * Our own sending pages, and every publisher we WATCH. @viralbhayani and @bollywoodpap
 * appear in their own posts' media tags, and a watched publisher is a COMPETITOR rather
 * than a prospect. `routes.ts` refuses those routes anyway — but only after the endpoint
 * has been spent, and the endpoint is the scarce thing here.
 *
 * Shared by the automatic pass and by `pnpm ig:brands`, so the two cannot disagree about
 * who is excluded. They assembled this separately until 2026-08-17 and the CLI's copy did
 * not exist at all, because the CLI had no tag path to exclude anything from.
 */
export async function excludedHandles(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const t of await prisma.targetAccount.findMany({ where: { role: 'WATCH' }, select: { handle: true } })) {
    out.add(t.handle.toLowerCase())
  }
  for (const s of await prisma.senderAccount.findMany({ select: { handle: true } })) {
    out.add(s.handle.toLowerCase())
  }
  return out
}
