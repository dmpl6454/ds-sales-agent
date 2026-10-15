import { igGet, type IgResponse } from './igHttp'
import { anonGateCheck, anonGateHost, anonGateRecordSuccess, anonGateRecordThrottle } from './anonGate'
import { classifyFeedAnswer, evidenceHead, isRefusalKind, recordFeedAnswer, type FeedAnswer } from './feedEvidence'
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

/**
 * ── THE ANONYMOUS IDENTITY IS THE APP'S, NOT THE WEBSITE'S (8 Sept 2026) ──────────────
 *
 * From 4 Sept every sessionless read presented as the WEB app (`www.instagram.com`, app id
 * 936619743392459, a Chrome User-Agent) was refused with
 * `401 {"message":"Please wait a few minutes…","require_login":true}` — from the Linode, from
 * the office network, from a home network overnight and from a phone hotspot, on the first
 * request each time. Four unrelated IPs cannot all be "our IP being throttled", and it was
 * not: the SAME sessionless request presented as the Instagram ANDROID app (`i.instagram.com`,
 * the app's own id, its User-Agent) returned 200 with 12 items from the very network that had
 * just refused the web form, paginated correctly, and answered the profile endpoint with the
 * badge. The wall keys on the CLIENT IDENTITY. No session, no cookie, no proxy — decision 4
 * stands; only the costume changed.
 *
 * ONE definition, imported everywhere (exists.ts, resolveBrand.ts, enrichHandle.ts), because
 * four copies of an identity are four places for the next such change to be half-applied.
 * MEASURED LIMIT: the profile endpoint still 429s from the Linode under this identity too —
 * lookups stay on the home-IP device agents, exactly as before.
 */
export const IG_HOST = 'https://i.instagram.com'
export const IG_APP_ID = '567067343352427' // Instagram for Android — a public constant, not a credential
const ENDPOINT = `${IG_HOST}/api/v1/feed/user`

/**
 * There is exactly one rule about these headers and it is decision 4: **no credentials,
 * ever.** Attaching a session cookie here converts an IP-level risk into an
 * account-ban risk, which is the one thing this project must not do. One copy of this
 * object is one place for a cookie to be added, and it is grepped for.
 */
export const FEED_HEADERS: Record<string, string> = {
  'X-IG-App-ID': IG_APP_ID,
  'User-Agent':
    'Instagram 361.0.0.46.88 Android (33/13; 420dpi; 1080x2340; samsung; SM-S911B; dm1q; qcom; en_IN; 674675155)',
  Accept: '*/*',
  'Accept-Language': 'en-IN',
}

/** Local alias, so the existing call sites in this file read unchanged. */
const HEADERS = FEED_HEADERS

/**
 * One page of one channel's feed, exactly as `fetchFeed` asks for it. Exported so the identity
 * probe (src/detection/feedProbe.ts) sends the in-use candidate to the SAME URL the pass does —
 * a probe that builds its own copy would be testing a request production never makes.
 */
export function feedPageUrl(handle: string, maxId: string | null = null): string {
  return `${ENDPOINT}/${encodeURIComponent(handle)}/username/?count=12${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`
}

/**
 * ── THE IDENTITY CANDIDATES `pnpm ig:probe` ASKS WITH (15 Oct 2026) ────────────────────────
 *
 * The 4 Sept outage was settled by ONE control probe — the same sessionless request under a
 * different client identity — after a day spent blaming the address. CLAUDE.md's lesson is
 * "vary the CLIENT before blaming the ADDRESS", and on 15 Oct both hosts had read nothing for
 * ~22.5 hours while the identity in use (FEED_HEADERS) was the same two-year-old app build. So a
 * person can now ask Instagram, from the Mac and from the box, with each of these, one request
 * each, and compare what comes back (src/detection/feedProbe.ts does the asking).
 *
 * They live HERE, beside FEED_HEADERS, because tests/one-instagram-identity.test.ts keeps every
 * Instagram identity in this one file: a second file declaring a User-Agent is a second place for
 * the next identity change to be half-applied. Outside this array, feed.ts declares exactly one.
 *
 * DECISION 4 HOLDS FOR EVERY ENTRY: no Cookie, no Authorization, no session or CSRF header of any
 * kind — asserted over every entry, not just the one in use. Only the costume varies.
 *
 * What is known about each, stated:
 *  - the in-use entry is FEED_HEADERS and `feedPageUrl` by reference, so it cannot drift;
 *  - the newer version is a GUESS. Both its version string and its build number were not read off
 *    a device. It changes exactly one thing (the app version) so that "served" against "refused"
 *    tells a version gate from a wall; a person with a current Instagram for Android can pass the
 *    real string with `--ua`;
 *  - the web control carries the retired web identity's HEADERS byte for byte as this file sent
 *    them until 8 Sept (recovered from git history, commit b9e5a44). Only the headers: the
 *    TRANSPORT differs. Until 8 Sept they went out through Node's global fetch (undici), which
 *    adds its own Sec-Fetch-* and connection headers (igHttp.ts); the probe sends them through
 *    `igGet` (node:https), which sends exactly what it is given. It is EXPECTED to be refused, and
 *    if it is served while the app identity is not, that says Instagram is answering the web
 *    identity over node:https again — worth knowing, and not by itself proof that the 8 Sept
 *    switch has reversed.
 */
export interface FeedIdentityProbe {
  name: string
  url: (handle: string) => string
  headers: Readonly<Record<string, string>>
  note: string
}

export const FEED_IDENTITY_PROBES: readonly FeedIdentityProbe[] = [
  {
    name: 'android-app (in use)',
    url: (handle) => feedPageUrl(handle),
    headers: FEED_HEADERS,
    note: 'exactly what every detection pass sends',
  },
  {
    name: 'android-app, newer version',
    url: (handle) => feedPageUrl(handle),
    headers: {
      ...FEED_HEADERS,
      'User-Agent':
        'Instagram 410.0.0.53.71 Android (33/13; 420dpi; 1080x2340; samsung; SM-S911B; dm1q; qcom; en_IN; 846519343)',
    },
    note: 'UNVERIFIED — a guess at a current version, offered only to tell a version gate from a wall',
  },
  {
    name: 'web (walled since 4 Sept — control)',
    url: (handle) => `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(handle)}/username/?count=12`,
    headers: {
      'x-ig-app-id': '936619743392459',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.instagram.com/',
    },
    note: 'the retired web identity (its headers, sent over node:https), expected to be refused — served here while the app is refused is worth knowing, not proof the 8 Sept switch reversed',
  },
]

export class FeedFetchError extends Error {
  constructor(
    public readonly handle: string,
    message: string,
    /** True when the shape changed rather than the request failing — an alarm. */
    public readonly isParseFailure = false,
    /**
     * True when Instagram told THIS HOST to stop (401/429, or any status whose body is the
     * login wall — see anonGate.ts and feedEvidence.ts `isLoginWallBody`). The pipeline
     * halts the whole pass on it rather than trying the next channel: every further request
     * only extends the cooldown. `until` is when the gate reopens.
     */
    public readonly isThrottle = false,
    public readonly until: Date | null = null,
    /**
     * True when no ANSWER arrived at all — DNS, TLS, a reset, a timeout, after every retry.
     * Carried (15 Oct 2026) so the source selector (feedSource.ts) can tell "this host cannot
     * reach the network" from "Instagram answered something else": the first is no reason to
     * try a second endpoint over the same broken network, the second is exactly the reason.
     */
    public readonly isTransport = false,
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
  /**
   * MEDIA URLS — captured 2026-08-07 because a paid placement can live entirely in the
   * FOOTAGE, with an innocuous caption. Tabish's `DbtNU9UzWYU` is the case: a SWITCH
   * (Ashok Leyland EV) double-decker centre-frame with a supplied-looking title card,
   * and a caption that only says a bus arrived in Thane.
   *
   * Stored rather than used, for now: these are CDN URLs that EXPIRE, so a corpus
   * without them cannot be re-examined once anyone decides what to do about video.
   * Optional and nullable throughout — a text post has neither, and a missing field
   * must never fail the parse for every other post on the page.
   */
  image_versions2: z
    .object({
      candidates: z
        .array(z.object({ url: z.string(), width: z.number().int(), height: z.number().int() }).partial())
        .optional(),
    })
    .partial()
    .nullable()
    .optional(),
  video_versions: z
    .array(z.object({ url: z.string(), width: z.number().int(), height: z.number().int() }).partial())
    .nullable()
    .optional(),
  video_duration: z.number().nullable().optional(),
  /** Instagram's official Paid Partnership label. */
  is_paid_partnership: z.boolean().optional(),
  /** Brand(s) tagged via the official tool. Often empty even when the flag is true. */
  sponsor_tags: z
    .array(z.object({ sponsor: z.object({ username: z.string() }).partial().optional() }).partial())
    .nullable()
    .optional(),
  /** Collaborators on a co-authored post. */
  coauthor_producers: z.array(z.object({ username: z.string() }).partial()).nullable().optional(),
  /**
   * Accounts tagged IN the media, as distinct from mentioned in the caption.
   *
   * Carried because it is the one structural signal @viralbhayani actually emits:
   * measured 2026-08-03, 17 tagged accounts across 48 posts, while every disclosure
   * field was empty. It mixes businesses (@redrosemart, @artific.furniture,
   * @tyaanijewellery) with celebrities (@karanjohar, @maheepkapoor), so it is not a
   * verdict on its own — but business-vs-person IS resolvable anonymously from the
   * profile endpoint, which makes it a structural corroborator for a judgement that
   * would otherwise rest entirely on a model's reading of the words.
   */
  usertags: z
    .object({ in: z.array(z.object({ user: z.object({ username: z.string() }).partial() }).partial()).nullable() })
    .partial()
    .nullable()
    .optional(),
})

const FeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  more_available: z.boolean().optional(),
  next_max_id: z.string().nullable().optional(),
})

/**
 * PURE. How many items `fetchFeed` would ACCEPT from this parsed body — `null` when its schema
 * would refuse the shape. The identity probe asks this rather than counting `items` itself, so
 * "served" in the probe's output means what it means to the pass, not merely "had an array".
 */
export function acceptedFeedItems(json: unknown): number | null {
  const r = FeedResponseSchema.safeParse(json)
  return r.success ? r.data.items.length : null
}

export interface FeedPost extends EnrichedPost {
  /** Instagram's own paid-partnership flag. False for both Phase 1 targets — they
   *  do not use the native tool — but true elsewhere, so it costs nothing to carry
   *  and starts working the day either channel adopts it. */
  isPaidPartnership: boolean
  sponsorHandles: string[]
  collabHandles: string[]
  /** Accounts tagged in the media. See `usertags` on the schema for why. */
  taggedAccounts: string[]
  mediaType: string | null
  /**
   * The reel's COVER FRAME, ~480px wide, and the video itself. Both are CDN URLs that
   * expire — carried so the corpus records what the post actually SHOWED, not only what
   * its caption said. Nothing classifies on these yet; see CLAUDE.md, "THE CAPTION IS
   * NOT THE POST".
   */
  thumbnailUrl: string | null
  videoUrl: string | null
  videoDurationSeconds: number | null
  /**
   * SET ONLY BY THE OFFICIAL READ PATH (src/detection/graphFeed.ts, 15 Oct 2026). The Graph
   * API returns no tags, no collaborators, no sponsor tags and no paid-partnership flag, so a
   * post it serves carries EMPTY evidence that is not a fact about the post — and treating
   * "the API did not say" as "the publisher removed every tag" would ERASE real stored tags on
   * every pass (evidence.ts and pipeline.ts both refuse to write tag evidence from such a post).
   * Absent means the anonymous feed served it and the evidence is complete.
   */
  evidenceIncomplete?: true
}

export interface FetchFeedResult {
  posts: FeedPost[]
  pagesFetched: number
  moreAvailable: boolean
  /** True when the posts came from a source that does not report tag evidence — see FeedPost. */
  evidenceIncomplete?: boolean
}

/**
 * How many times a single page request is retried before the channel is given up on.
 *
 * There was no retry at all, and it cost more than it looks. `fetch` throwing is a
 * TRANSPORT failure — DNS, TLS, a reset socket — not an HTTP status, so a single
 * dropped packet made that channel contribute zero posts for the entire four-hour
 * slot and marked the whole run PARTIAL. Measured 2026-08-03: **8 of the 12 preceding
 * slots** failed this way on @bollywoodchronicle and/or @bollywoodsocietyy, while a
 * direct probe of all four channels moments later returned HTTP 200 every time,
 * twice, with clean pagination. The network was fine by the next attempt; there was
 * simply never a next attempt.
 *
 * Deliberately narrow. Only transport errors and 5xx are retried — a 429 is Instagram
 * asking us to stop and is re-thrown immediately, because retrying into a rate limit
 * is the same mistake as retrying into a checkpoint.
 */
const PAGE_RETRIES = 3
const RETRY_BASE_MS = 800

/**
 * How long ONE request may take before it is abandoned.
 *
 * `fetch` has no default timeout. A socket that opens and then never answers hangs
 * forever, and retry-with-backoff makes that worse rather than better: the worst case
 * per slot is `channels x maxPages(6) x attempts(4)` = **216 unbounded requests**.
 *
 * MEASURED from `ScrapeRun`, and this is not hypothetical. Healthy slots finish in
 * 24-81 s. The PARTIAL ones ran 3957 s, 7574 s, 12782 s, 19230 s and **24674 s — 6.85
 * hours**.
 *
 * The second-order consequence is the dangerous one. `SLOT_LOCK_STALE_MS` is 30 minutes
 * and its comment reads "a slot that has not finished in this long is presumed dead, not
 * running". A slot with no request timeout is HUNG BUT ALIVE, so that presumption is
 * false and a second slot claims the lock and runs concurrently with the first. At 65
 * accounts driving Chrome profiles, two live runs could drive the same profile at once.
 * "Freshness is not liveness" — already learned once for the scheduler heartbeat.
 *
 * 12 s matches `exists.ts`, which has always had this. Median response is 1090 ms.
 *
 * EXPORTED since 2026-08-22, because the lesson above reached THIS file and not the other
 * two callers of the same endpoints — `enrichHandle` and `resolveBrand` both awaited a
 * bare `fetch`. MEASURED that morning: the Mac's network dropped, the brand pass's lookup
 * hung, and `brandPassRunning` stayed true for 70+ minutes, so brand discovery AND the
 * badge door were skipped every 30 minutes with the log honestly reporting "still running
 * from the last pass". It recovered only because the network came back and the socket
 * errored; a socket that stalls instead of resetting would have wedged both passes
 * FOREVER, silently. One constant, three callers.
 */
export const REQUEST_TIMEOUT_MS = 12_000

/** Transport-level retry with exponential backoff. Never retries a 429 or a 4xx. */
async function fetchPageWithRetry(url: string, handle: string): Promise<IgResponse> {
  let lastError: unknown

  for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1)
      log.step('feed request failed — retrying', {
        handle,
        attempt,
        of: PAGE_RETRIES,
        waitMs: wait,
        reason: lastError instanceof Error ? lastError.message : String(lastError),
      })
      await new Promise((r) => setTimeout(r, wait))
    }

    try {
      // A timeout surfaces here as a thrown AbortError, i.e. exactly like any other
      // transport failure, so it is retried the same way and bounded the same way.
      const res = await igGet(url, { headers: HEADERS, timeoutMs: REQUEST_TIMEOUT_MS })

      // 429 and 4xx are answers, not failures. Hand them straight back — the caller
      // distinguishes them, and hammering either one makes the situation worse.
      if (res.status === 429 || (res.status >= 400 && res.status < 500)) return res
      if (res.ok) return res

      // 5xx: Instagram's problem, and usually momentary.
      lastError = new Error(`HTTP ${res.status}`)
      if (attempt === PAGE_RETRIES) return res
    } catch (err) {
      // The case that was silently costing whole channels.
      lastError = err
      if (attempt === PAGE_RETRIES) {
        throw new FeedFetchError(
          handle,
          `network error after ${PAGE_RETRIES + 1} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
          false,
          false,
          null,
          true,
        )
      }
    }
  }

  // Unreachable: every path above either returns or throws on the final attempt.
  throw new FeedFetchError(handle, 'exhausted retries', false, false, null, true)
}

/** How much of a redacted body head rides on a thrown `HTTP <status>` message — a log line, not a record. */
const ERROR_HEAD_MAX = 120

/**
 * Put one answer on record for this host (src/detection/feedEvidence.ts). `void`, on purpose:
 * recording is best-effort and must never make a feed read wait on the database, nor fail it.
 */
function recordAnswer(handle: string, a: Pick<FeedAnswer, 'kind' | 'status' | 'contentType' | 'head' | 'items'> & { until?: string | null }): void {
  void recordFeedAnswer({ at: new Date().toISOString(), host: anonGateHost(), source: 'anonymous-app', handle, ...a })
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
  opts: {
    maxPosts?: number
    sinceUnix?: number
    maxPages?: number
    delayMs?: number
    /**
     * `false` when the read is NOT a detection pass (review, 15 Oct 2026) — the dashboard's
     * add-a-channel check, which vets ONE handle a person just typed. Its answer is about that
     * handle, and recorded it would become the server's `detectFeedAnswer` row: a mistyped handle's
     * empty feed would put "Instagram stopped answering the server's feed reads" on the landing
     * page. The gate is unaffected (a refusal still closes it, as it always has). Default `true`.
     */
    record?: boolean
  } = {},
): Promise<FetchFeedResult> {
  const noteAnswer = (h: string, a: Parameters<typeof recordAnswer>[1]): void => {
    if (opts.record !== false) recordAnswer(h, a)
  }
  const maxPosts = opts.maxPosts ?? 48
  const maxPages = opts.maxPages ?? 6
  const delayMs = opts.delayMs ?? 2500 // between pages of one channel — bursts are what earn a throttle

  const posts: FeedPost[] = []
  let maxId: string | null = null
  let pages = 0
  let moreAvailable = false
  const gate = anonGateCheck()
  if (!gate.ok) {
    throw new FeedFetchError(
      handle,
      `anonymous reads are throttled on this host until ${gate.until.toISOString()} — no request made`,
      false,
      true,
      gate.until,
    )
  }

  while (pages < maxPages && posts.length < maxPosts) {
    const url = feedPageUrl(handle, maxId)

    let res: IgResponse
    try {
      res = await fetchPageWithRetry(url, handle)
    } catch (err) {
      // A transport failure after every retry. No status, but the error's words are evidence.
      if (err instanceof FeedFetchError) {
        noteAnswer(handle, { kind: 'transport', status: null, contentType: null, head: evidenceHead(err.message), items: null })
      }
      throw err
    }

    /**
     * THE BODY IS READ ONCE, AS TEXT, AND PARSED HERE (15 Oct 2026) — so whatever happens next,
     * the evidence has the body. `res.json()` used to consume it on the success path and the
     * failure path read it only for the throttle test, then threw it away: a 22-hour outage
     * left nothing on record but `channel failed` lines.
     */
    const body = await res.text().catch(() => '')
    const contentType = res.contentType ?? null
    let json: unknown
    let jsonOk = false
    try {
      json = JSON.parse(body) as unknown
      jsonOk = true
    } catch {
      jsonOk = false
    }
    const schema = jsonOk ? FeedResponseSchema.safeParse(json) : null
    const answer = classifyFeedAnswer({
      status: res.status,
      contentType,
      body,
      parsedItems: !res.ok ? undefined : schema?.success ? schema.data.items.length : null,
    })

    /**
     * A REFUSAL, WHATEVER THE STATUS. A 401/429 always was one; a 200 (or any status) whose body
     * is the login wall now is too, because filing it as a shape change let the pass spend a
     * request on every remaining channel against a host Instagram had just told to wait.
     */
    if (isRefusalKind(answer.kind)) {
      const until = anonGateRecordThrottle('feed', res.status)
      noteAnswer(handle, { kind: answer.kind, status: res.status, contentType, head: answer.head, items: null, until: until.toISOString() })
      throw new FeedFetchError(
        handle,
        `Instagram refused anonymous reads (HTTP ${res.status}) — every lookup on this host halts until ${until.toISOString()}`,
        false,
        true,
        until,
      )
    }
    if (!res.ok) {
      noteAnswer(handle, { kind: answer.kind, status: res.status, contentType, head: answer.head, items: null })
      throw new FeedFetchError(handle, `HTTP ${res.status}${answer.head ? ` — ${answer.head.slice(0, ERROR_HEAD_MAX)}` : ''}`)
    }
    anonGateRecordSuccess('feed')

    if (!schema?.success) {
      noteAnswer(handle, { kind: answer.kind, status: res.status, contentType, head: answer.head, items: null })
      const why = !jsonOk
        ? `the body is not JSON${contentType ? ` (${contentType})` : ''}`
        : schema!.error.message.slice(0, 200)
      throw new FeedFetchError(handle, `feed response shape changed: ${why}`, true)
    }
    const parsed = schema.data

    // The FIRST page of a call says what Instagram answered this channel; later pages add nothing
    // the screen needs, and a write per page would be nineteen-fold noise.
    if (pages === 0) {
      noteAnswer(handle, { kind: answer.kind, status: res.status, contentType, head: answer.head, items: parsed.items.length })
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

/**
 * Which thumbnail size to keep: the SMALLEST at least `MIN_THUMB_WIDTH` wide.
 *
 * Not the largest. Instagram offers 11 candidates up to 1080px; 480px measured ~35 KB and
 * is already legible enough to read a bumper badge or shop signage — which is the only
 * reason we keep it at all (see CLAUDE.md, "THE CAPTION IS NOT THE POST"). At ~60 posts a
 * day from one channel, taking the biggest would make bandwidth a decision someone has to
 * think about, for no gain.
 *
 * Falls back to the LARGEST available when everything on offer is smaller than the floor —
 * a too-small thumbnail is still evidence, and returning null there would throw away the
 * only frame we will ever get for that post.
 *
 * PURE and exported so both directions are testable without a network call.
 */
export const MIN_THUMB_WIDTH = 480

export function pickThumbnail(
  candidates: ReadonlyArray<{ url?: string; width?: number; height?: number } | null | undefined>,
): { url: string; width: number; height: number } | null {
  const usable = candidates
    .filter((c): c is { url: string; width: number; height: number } =>
      typeof c?.url === 'string' && typeof c.width === 'number' && typeof c.height === 'number',
    )
    .sort((a, b) => a.width - b.width)
  if (usable.length === 0) return null
  return usable.find((c) => c.width >= MIN_THUMB_WIDTH) ?? usable[usable.length - 1]!
}

function toFeedPost(handle: string, item: z.infer<typeof FeedItemSchema>, gridIndex: number): FeedPost {
  const sponsorHandles = (item.sponsor_tags ?? [])
    .map((s) => s.sponsor?.username)
    .filter((u): u is string => typeof u === 'string')

  const collabHandles = (item.coauthor_producers ?? [])
    .map((c) => c.username)
    .filter((u): u is string => typeof u === 'string')

  const taggedAccounts = (item.usertags?.in ?? [])
    .map((t) => t?.user?.username)
    .filter((u): u is string => typeof u === 'string')

  const thumb = pickThumbnail(item.image_versions2?.candidates ?? [])
  const video = (item.video_versions ?? []).find((v) => typeof v?.url === 'string') ?? null

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
    taggedAccounts,
    mediaType: item.product_type ?? (item.media_type === 2 ? 'video' : item.media_type === 8 ? 'carousel' : 'feed'),
    thumbnailUrl: thumb?.url ?? null,
    videoUrl: video?.url ?? null,
    videoDurationSeconds: item.video_duration ?? null,
  }
}
