import { prisma } from '@/lib/db'
import type { ProvenancePost } from '@/outreach/messageProvenance'

/**
 * The paid posts a page's delivered messages point at — ONE batched read, both columns.
 *
 * ── WHY THIS IS SHARED, AND WHY IT IS ONE QUERY ─────────────────────────────
 *
 * Two screens answer "why was this message sent" (`/analytics`'s history and the landing
 * page's newest sends), and both need the same two lookups: the post the message CLAIMED
 * (`attempt.campaignId`) and the post its recipient was DISCOVERED from
 * (`target.discoveredFromCampaignId`). One loader so they cannot drift, and because the
 * first version of this cost real headroom.
 *
 * MEASURED 2026-08-31: resolving the claim through a Prisma `include` (with its own nested
 * `target` select) and the discovery through a second query cost **four** queries per page
 * and took `/` to 158 against a 160 budget — two spare on a page this file's own history
 * records drifting by more than that between days. Collecting BOTH id sets and asking once
 * costs two, and `/` returns to 156. A budget is a ceiling over a bounded design; the fix
 * for approaching one is never to raise it.
 *
 * `discoveredFromCampaignId` is deliberately still a bare scalar with no relation declared:
 * adding one would put a foreign key on a live Postgres that has no `_prisma_migrations`
 * table, which this repo refuses.
 */
export async function loadProvenancePosts(
  rows: readonly { campaignId: string | null; target: { discoveredFromCampaignId: string | null } }[],
): Promise<Map<string, ProvenancePost>> {
  const provenanceIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.campaignId, r.target.discoveredFromCampaignId])
        .filter((id): id is string => id !== null),
    ),
  ]
  if (provenanceIds.length === 0) return new Map()

  const posts = await prisma.detectedCampaign.findMany({
    where: { id: { in: provenanceIds } },
    select: { id: true, shortcode: true, postedAt: true, target: { select: { handle: true } } },
  })
  return new Map(
    posts.map((p) => [p.id, { shortcode: p.shortcode, channelHandle: p.target.handle, postedAt: p.postedAt }]),
  )
}
