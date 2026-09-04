import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { targetNameClauses } from '@/lib/searchTerms'
import { loadProvenancePosts } from './provenance-posts'

/**
 * "FOR WHICH PAID POST WAS THIS PERSON MESSAGED?" — answerable by search (2026-09-04).
 *
 * ── THE ASK ─────────────────────────────────────────────────────────────────
 *
 * Tabish searched `celina` on `/paid-posts` and could not tell from the result who had been
 * messaged for what. The search read the CAPTION, the brand strings, the tags and the
 * shortcode — everything about the post — and nothing about the messages the post caused.
 * @celinajaitlyofficial ("Celina Jaitly") has two delivered messages, both claiming
 * `Dck0gTgKMNs`; her name is in no caption, so the rows that would have answered him were
 * unreachable from the one box built for the question.
 *
 * ── THE COLUMN IS A PARTITION, AND THE SEARCH MUST FOLLOW THE SAME RULE ────
 *
 * The "Message sent" column attributes every delivered message to exactly ONE post: the one
 * it CLAIMED (`OutreachAttempt.campaignId`), else — only when it claimed nothing — the post
 * its recipient was DISCOVERED from (`TargetAccount.discoveredFromCampaignId`). That is what
 * lets a reader add the column up. So "posts where this person was messaged" is computed
 * here by the SAME rule, over the SAME status set (`DELIVERED_STATUSES`, `sentAt` present),
 * and the search finds exactly the rows the column would show a message on. A search that
 * widened the rule — say, every post naming them — would find rows whose "Message sent"
 * cell reads an em-dash, which is the confusion he started with.
 *
 * ── TWO BOUNDED QUERIES, ONLY WHEN SEARCHING, ZERO PER ROW ─────────────────
 *
 * Both are cheap and both are bounded: the recipient lookup takes at most 100 matches (a
 * search term matching more than 100 accounts is not a search), and the attempt read is
 * keyed on those ids. Neither runs when the box is empty, so the un-searched page costs
 * what it did. `/paid-posts` has a query budget of 120 (`src/scripts/layout.ts`); this adds
 * two to a searched render, never one per row.
 */
export async function attributedPostIdsForRecipients(query: string): Promise<string[]> {
  const targets = await prisma.targetAccount.findMany({
    where: { OR: targetNameClauses(query) },
    select: { id: true, discoveredFromCampaignId: true },
    take: 100,
  })
  if (targets.length === 0) return []
  const discoveredBy = new Map(targets.map((t) => [t.id, t.discoveredFromCampaignId]))

  const attempts = await prisma.outreachAttempt.findMany({
    where: {
      targetId: { in: [...discoveredBy.keys()] },
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { not: null },
    },
    select: { targetId: true, campaignId: true },
  })
  return [...new Set(attempts.map((a) => attributedPostId(a, discoveredBy.get(a.targetId) ?? null)))].filter(
    (id): id is string => id !== null,
  )
}

/**
 * THE ATTRIBUTION RULE, in one place, so the column, the search and the syndication note
 * cannot disagree: the claimed post wins; a message that claimed nothing belongs to the post
 * its recipient was discovered from; a message with neither belongs to no post. Never a
 * reconstruction — see `messageProvenance.ts` for why.
 */
export function attributedPostId(
  attempt: { campaignId: string | null },
  discoveredFromCampaignId: string | null,
): string | null {
  return attempt.campaignId ?? discoveredFromCampaignId
}

/** What the syndication note needs to render: which post, and a link to it. */
export interface MessagedUnder {
  shortcode: string
}

/**
 * "MESSAGED UNDER <another post>" — the note for a syndicated copy (2026-09-04).
 *
 * ── WHY A ROW CAN NAME A RECIPIENT AND SHOW NO MESSAGE ───────────────────────
 *
 * MEASURED 2026-09-03 over 7 days: of 111 posts with a recipient and no attribution, **61
 * recipients had been messaged in-window under ANOTHER post** — syndicated copies. The
 * Toxic cast sits on three copies of one campaign and the message claimed one of them;
 * @celinajaitlyofficial was discovered from `Dckun6zqS6A`, an identical-caption copy of
 * `Dck0gTgKMNs`, and both her messages claimed the latter. So the copy correctly shows an
 * em-dash — and a reader looking at that copy cannot tell "never messaged" from "messaged,
 * under the sibling", which is exactly the question Tabish could not answer.
 *
 * ── IT IS A NOTE, NOT A SECOND ATTRIBUTION — THE PARTITION RULE ─────────────
 *
 * The message is NOT counted again under this row. "Do not fill in the siblings" is the
 * standing rule (CLAUDE.md, 2026-09-03): counting one message against several posts would
 * destroy the one property that makes the column worth having, which is that it adds up.
 * The note is muted prose pointing at the post that carries the attribution, and the cell's
 * own count stays zero. A test asserts the attributed post shows NO note about itself.
 *
 * ── ONE QUERY FOR THE PAGE, JOINED IN JS ─────────────────────────────────────
 *
 * For the recipients of the rows that need a note (has recipients, has no attributed
 * message), ONE `OutreachAttempt` read — delivered statuses, `sentAt` present — selecting
 * the two columns the attribution rule needs. The posts those ids name are resolved through
 * `loadProvenancePosts`, the same batched loader `/analytics` uses, so the shortcode comes
 * back in one more query and `id: { in: provenanceIds }` stays the one carve-out
 * `tests/visible-channels.test.ts` already trusts for a lookup-by-id. In-window is applied
 * in JS on the resolved post's `postedAt`, and our own pages are excluded the way every
 * figure on the screen excludes them — a note may not point at a post the table itself
 * would never show.
 *
 * Zero queries when no row needs a note, and never one per row.
 */
export async function messagedUnderElsewhere(input: {
  /** The rows on this page that name at least one recipient and carry no attributed message. */
  rows: readonly { postId: string; recipientIds: readonly string[] }[]
  /** The detection window's start: a note may not point outside what the table shows. */
  since: Date
  /** Channels whose posts appear on this screen — a note never points at a post that would not. */
  visibleChannelHandles: ReadonlySet<string>
}): Promise<Map<string, MessagedUnder>> {
  const out = new Map<string, MessagedUnder>()
  const recipientIds = [...new Set(input.rows.flatMap((r) => r.recipientIds))]
  if (recipientIds.length === 0) return out

  const attempts = await prisma.outreachAttempt.findMany({
    where: {
      targetId: { in: recipientIds },
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { not: null },
    },
    orderBy: { sentAt: { sort: 'desc', nulls: 'last' } },
    select: { targetId: true, campaignId: true, target: { select: { discoveredFromCampaignId: true } } },
  })
  if (attempts.length === 0) return out

  const posts = await loadProvenancePosts(attempts)

  /** Newest attributed post per recipient, restricted to what this screen would show. */
  const underByRecipient = new Map<string, { postId: string; shortcode: string }>()
  for (const a of attempts) {
    const postId = attributedPostId(a, a.target.discoveredFromCampaignId)
    if (!postId || underByRecipient.has(a.targetId)) continue
    const post = posts.get(postId)
    if (!post || post.postedAt < input.since || !input.visibleChannelHandles.has(post.channelHandle)) continue
    underByRecipient.set(a.targetId, { postId, shortcode: post.shortcode })
  }

  for (const row of input.rows) {
    for (const rid of row.recipientIds) {
      const under = underByRecipient.get(rid)
      /* Never about itself: a row that carries the attribution has a message, not a note. */
      if (!under || under.postId === row.postId) continue
      out.set(row.postId, { shortcode: under.shortcode })
      break
    }
  }
  return out
}