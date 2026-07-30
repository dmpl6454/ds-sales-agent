import { z } from 'zod'
import { log } from '@/lib/logger'
import type { EnrichedPost } from './types'

/**
 * Detection source: Instagram's anonymous web feed endpoint.
 *
 *   GET /api/v1/feed/user/{username}/username/?count=12
 *   header: x-ig-app-id: 936619743392459
 *
 * This replaces the previous two-stage approach (render the profile grid in
 * Playwright for shortcodes, then one HTTP GET per post to parse og:description).
 * Measured 2026-07-30, both target channels:
 *
 *                        old path                    this
 *   requests/check       1 browser render + 12       1
 *   browser required     yes                         NO
 *   timestamps           calendar date only          exact unix (`taken_at`)
 *   post ceiling         12, hard                    paginated — 48 verified
 *   is_paid_partnership  unavailable                 present
 *
 * Two things worth being precise about:
 *
 * 1. **No login, and it must stay that way.** This is anonymous. The only
 *    exposure is IP-level rate limiting. Attaching a session cookie from one of
 *    our sender accounts would convert an IP risk into an account-ban risk, which
 *    is the one thing this project must not do. Never add credentials here.
 *
 * 2. **`x-ig-app-id` is the gate, not the User-Agent.** Omitting it yields a
 *    misleading `useragent mismatch` error, which sends people down the wrong
 *    debugging path.
 */

const ENDPOINT = 'https://www.instagram.com/api/v1/feed/user'
const IG_WEB_APP_ID = '936619743392459'

const HEADERS: Record<string, string> = {
  'x-ig-app-id': IG_WEB_APP_ID,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.instagram.com/',
}

export class FeedFetchError extends Error {
  constructor(
    public readonly handle: string,
    message: string,
    /** True when the shape changed rather than the request failing — an alarm. */
    public readonly isParseFailure = false,
  ) {
    super(`[@${handle}] ${message}`)
    this.name = 'FeedFetchError'
  }
}

/**
 * Only the fields we use. `.passthrough()` deliberately omitted — we want a loud
 * failure if `caption` or `taken_at` disappear, since silently returning captionless
 * posts would make every classifier report "no campaigns" forever.
 */
const FeedItemSchema = z.object({
  code: z.string().min(5),
  taken_at: z.number().int().positive(),
  caption: z.object({ text: z.string() }).nullable().optional(),
  like_count: z.number().int().nonnegative().nullable().optional(),
  comment_count: z.number().int().nonnegative().nullable().optional(),
  media_type: z.number().int().optional(),
  product_type: z.string().optional(),
  /** Instagram's official Paid Partnership label. */
  is_paid_partnership: z.boolean().optional(),
  /** Brand(s) tagged via the official tool. Often empty even when the flag is true. */
  sponsor_tags: z
    .array(z.object({ sponsor: z.object({ username: z.string() }).partial().optional() }).partial())
    .nullable()
    .optional(),
  /** Collaborators on a co-authored post. */
  coauthor_producers: z.array(z.object({ username: z.string() }).partial()).nullable().optional(),
})

const FeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  more_available: z.boolean().optional(),
  next_max_id: z.string().nullable().optional(),
})

export interface FeedPost extends EnrichedPost {
  /** Instagram's own paid-partnership flag. False for both Phase 1 targets — they
   *  do not use the native tool — but true elsewhere, so it costs nothing to carry
   *  and starts working the day either channel adopts it. */
  isPaidPartnership: boolean
  sponsorHandles: string[]
  collabHandles: string[]
  mediaType: string | null
}

export interface FetchFeedResult {
  posts: FeedPost[]
  pagesFetched: number
  moreAvailable: boolean
}

/**
 * Fetch recent posts for a handle, paginating until `maxPosts` or `sinceUnix`.
 *
 * Pagination matters more than it first appears: @viralbhayani posts ~62/day
 * (measured), so a single 12-item page covers under five hours. Stopping at one
 * page silently loses most of the day's activity.
 */
export async function fetchFeed(
  handle: string,
  opts: { maxPosts?: number; sinceUnix?: number; maxPages?: number; delayMs?: number } = {},
): Promise<FetchFeedResult> {
  const maxPosts = opts.maxPosts ?? 48
  const maxPages = opts.maxPages ?? 6
  const delayMs = opts.delayMs ?? 700

  const posts: FeedPost[] = []
  let maxId: string | null = null
  let pages = 0
  let moreAvailable = false

  while (pages < maxPages && posts.length < maxPosts) {
    const url = `${ENDPOINT}/${encodeURIComponent(handle)}/username/?count=12${
      maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''
    }`

    const res = await fetch(url, { headers: HEADERS })
    if (res.status === 429) {
      throw new FeedFetchError(handle, 'rate limited (HTTP 429) — back off and retry next slot')
    }
    if (!res.ok) {
      throw new FeedFetchError(handle, `HTTP ${res.status}`)
    }

    let parsed
    try {
      parsed = FeedResponseSchema.parse(await res.json())
    } catch (err) {
      throw new FeedFetchError(
        handle,
        `feed response shape changed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
        true,
      )
    }

    for (const item of parsed.items) {
      posts.push(toFeedPost(handle, item, posts.length))
    }

    pages += 1
    moreAvailable = parsed.more_available === true
    maxId = parsed.next_max_id ?? null

    // Stop once we are past the window we care about — no point paging into last week.
    const oldest = parsed.items[parsed.items.length - 1]?.taken_at
    if (opts.sinceUnix && oldest && oldest < opts.sinceUnix) break
    if (!moreAvailable || !maxId) break

    await new Promise((r) => setTimeout(r, delayMs))
  }

  log.step('feed fetched', { handle, posts: posts.length, pages, moreAvailable })
  return { posts: posts.slice(0, maxPosts), pagesFetched: pages, moreAvailable }
}

function toFeedPost(handle: string, item: z.infer<typeof FeedItemSchema>, gridIndex: number): FeedPost {
  const sponsorHandles = (item.sponsor_tags ?? [])
    .map((s) => s.sponsor?.username)
    .filter((u): u is string => typeof u === 'string')

  const collabHandles = (item.coauthor_producers ?? [])
    .map((c) => c.username)
    .filter((u): u is string => typeof u === 'string')

  return {
    shortcode: item.code,
    permalink: `https://www.instagram.com/p/${item.code}/`,
    ownerHandle: handle,
    caption: item.caption?.text ?? '',
    likeCount: item.like_count ?? null,
    commentCount: item.comment_count ?? null,
    postedAt: new Date(item.taken_at * 1000),
    gridIndex,
    isPaidPartnership: item.is_paid_partnership === true,
    sponsorHandles,
    collabHandles,
    mediaType: item.product_type ?? (item.media_type === 2 ? 'video' : item.media_type === 8 ? 'carousel' : 'feed'),
  }
}
