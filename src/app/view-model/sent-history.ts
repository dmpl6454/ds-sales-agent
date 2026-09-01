import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { istDateKey } from '@/lib/time'
import { postUrl } from '@/lib/urls'
import { provenanceFor, provenanceLabel } from '@/outreach/messageProvenance'
import { loadProvenancePosts } from './provenance-posts'
import type { SentMessage } from './messages-page'

/**
 * THE WHOLE DELIVERED HISTORY, A PAGE AT A TIME.
 *
 * ── WHY THIS EXISTS (2026-08-21) ──────────────────────────────────────────
 *
 * Tabish: *"it should reflect in analytics and autopilot page accurately all the message
 * thread with an ability to go even beyond."* Every list of sends in this product was a
 * fixed `take` — the feed 40, the delivered table 50 — and the fleet now delivers ~280 a
 * day, so the complete record existed only in the CSV export. Worse, `SentList` rendered
 * **"Delivered ({recent.length})"**, i.e. it labelled the size of its own window as the
 * total: the third distinct face of *a bounded list read as a complete record* in three
 * days, after `sentToday` (a `take: 50` filtered into a count) and the activity feed (a
 * `take: 40` whose oldest row read as the day's first send).
 *
 * So the rule this module exists to enforce: **a list states its true total and offers the
 * rest.** `total` is its own `count`, never `rows.length` — deriving it from the page would
 * report "50 of 50" and agree with the truncation, which is a check verifying its own
 * symmetry.
 *
 * Ordered `sentAt desc` with `id` as the tiebreak, because the fleet delivers on a ~1-minute
 * period and two rows CAN share a timestamp to the millisecond under a concurrent claim; an
 * unstable sort silently repeats or skips a row across page boundaries, which is exactly the
 * kind of quiet wrongness a history page must not have.
 */

/** How many rows a page of history shows. Bounded so a page render stays a page render. */
export const SENT_PAGE_SIZE = 50

export interface SentHistory {
  rows: SentMessage[]
  /** 1-based, clamped into range — an out-of-range `?sent=` must not render an empty table. */
  page: number
  pageCount: number
  /** EVERY delivered message, counted independently of the page. */
  total: number
  /** The 1-based inclusive range this page covers, for "showing 51-100 of 280". */
  from: number
  to: number
  /** Filter in force, echoed back so the control can render its own state. */
  senderHandle: string | null
}

export async function buildSentHistory(input: {
  page?: number
  senderHandle?: string | null
}): Promise<SentHistory> {
  const senderHandle = input.senderHandle?.trim() || null
  const where = {
    status: { in: [...DELIVERED_STATUSES] },
    ...(senderHandle ? { sender: { handle: senderHandle } } : {}),
  }

  const total = await prisma.outreachAttempt.count({ where })
  const pageCount = Math.max(1, Math.ceil(total / SENT_PAGE_SIZE))
  /* Clamped rather than trusted: `?sent=999` is a URL anyone can type. */
  const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pageCount)

  const rows = await prisma.outreachAttempt.findMany({
    where,
    include: {
      sender: { select: { handle: true } },
      /**
       * WHY EACH MESSAGE WENT OUT (2026-08-31).
       *
       * `campaign` is a real relation, so the post this message CLAIMED comes back in this
       * same query. `discoveredFromCampaignId` is a bare scalar with no relation declared —
       * and it stays that way: adding one would put a foreign key on a live Postgres that
       * has no `_prisma_migrations` table, which this repo refuses. It is resolved in ONE
       * batched read below instead, never a lookup per row (`buildBrandsPanel`'s lesson;
       * `/analytics` has a budget of 125).
       */
      target: { select: { handle: true, discoveredFromCampaignId: true } },
    },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * SENT_PAGE_SIZE,
    take: SENT_PAGE_SIZE,
  })

  const provPosts = await loadProvenancePosts(rows)

  return {
    rows: rows.map((a) => {
      const prov = provenanceFor({
        claimed: a.campaignId ? (provPosts.get(a.campaignId) ?? null) : null,
        discovered: a.target.discoveredFromCampaignId
          ? (provPosts.get(a.target.discoveredFromCampaignId) ?? null)
          : null,
      })
      return {
        id: a.id,
        senderHandle: a.sender.handle,
        targetHandle: a.target.handle,
        sentAt: a.sentAt,
        sentBy: a.sentBy,
        threadUrl: a.threadUrl,
        replied: a.repliedAt !== null,
        replyHandled: a.replyHandledAt !== null,
        replyText: a.replyText,
        touchNumber: a.touchNumber,
        provenance: prov.post
          ? {
              label: provenanceLabel(prov.post, istDateKey(prov.post.postedAt)),
              url: postUrl(prov.post.shortcode),
              why: prov.sentence,
            }
          : null,
      }
    }),
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : (page - 1) * SENT_PAGE_SIZE + 1,
    to: Math.min(page * SENT_PAGE_SIZE, total),
    senderHandle,
  }
}
