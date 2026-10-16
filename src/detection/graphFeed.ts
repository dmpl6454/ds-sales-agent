/**
 * graphFeed.ts — AN OFFICIAL READ PATH, DORMANT UNTIL A PERSON SUPPLIES A TOKEN (15 Oct 2026).
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * On 15 Oct the landing page read "no paid posts are being found since 1348 min ago": the
 * Linode worker AND the Mac's failover had read nothing for ~22.5 hours, and every read this
 * system makes is the ANONYMOUS Instagram feed (feed.ts). When that one door is shut there is
 * no second one. This is the second one: Meta's Instagram Graph API **Business Discovery**,
 *
 *   GET https://graph.facebook.com/<version>/<OUR_IG_USER_ID>
 *       ?fields=business_discovery.username(<target>){username,media.limit(N){…}}
 *       &access_token=<token>
 *
 * which reads another professional account's recent media AS one of our own professional
 * accounts. The business owns a live Meta app ("Post Automation 2", app id 298449321694397)
 * with instagram_basic, instagram_manage_insights and pages_read_engagement at ADVANCED access
 * — measured that day through Meta's developer tools — which is the App Review half CLAUDE.md
 * ("No other data source helps", August) recorded as the obstacle. The other half of that entry
 * is still TRUE and is the cost of this path: **the API returns no tags, no collaborators, no
 * sponsor tags and no paid-partnership flag**, and it reads only Business/Creator accounts.
 *
 * ── AND THE CAPTION COMES WITHOUT ITS @MENTIONS (review, 15 Oct 2026) ─────────────────────
 *
 * Meta's IG Media reference says of `caption`: "The @ symbol is excluded, unless the app user can
 * perform admin-equivalent tasks on the Facebook Page connected to the Instagram account used to
 * create the caption." Business Discovery reads OTHER accounts, so every caption it returns is the
 * stripped form. FROM META'S DOCUMENTATION, NOT SEEN IN A REAL ANSWER — no call has been made. It
 * matters because brand discovery, the mention rules and the M.O.M brand extraction all key on "@":
 * a post stored from here mints nothing from its caption either. The caption is stored as given;
 * the pipeline re-judges and rewrites the post (caption, brands, verdict) the first time the
 * anonymous feed returns it whole, inside that pass's lookback (pipeline.ts) — older ones stay as
 * they are, which docs/DEPLOY.md states.
 *
 * ── WHAT IS MEASURED AND WHAT IS NOT ──────────────────────────────────────────────────
 *
 * NOT ONE CALL HAS BEEN MADE. The machine this was written on has no token and cannot reach
 * graph.facebook.com (DNS fails). Every response shape below — the media fields, the
 * `paging.cursors.after` cursor, the `+0000` timestamp, the `{error:{message,type,code,
 * error_subcode,fbtrace_id}}` envelope and the error codes — is FROM META'S DOCUMENTATION, and
 * the not-a-professional-account codes (110, subcode 2207013) are from Meta's docs and
 * developer reports rather than an observed answer. The first real call is `ig:probe --graph`
 * on the box (docs/DEPLOY.md); treat anything it shows that disagrees with this file as the truth.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────────────────
 *
 * It is not an Instagram web session and attaches no cookie: it is an authenticated API with a
 * token a person mints through the business's own app. Decision 4 ("detection never logs in")
 * is about the anonymous feed, and stays true for it — this file never touches `anonGate`'s
 * state and never sends `FEED_HEADERS`. Turning it on (two lines in the BOX's `.env`) is
 * Tabish's decision, because it trades an anonymous read for an authenticated one and loses the
 * tag evidence prospects are minted from. A Mac never holds the token; its failover never asks.
 *
 * ── THE TOKEN ─────────────────────────────────────────────────────────────────────────
 *
 * Goes in the URL query and nowhere else. `buildBusinessDiscoveryUrl` never sees it (so the URL
 * it builds can be printed and tested), every message this file throws or logs is built from
 * the CLASSIFIED answer and passed through `scrub` (the literal token, its URL-encoded form and
 * feedEvidence's token shapes all redacted), and recorded evidence goes through the same scrub.
 *
 * ── VOLUME ────────────────────────────────────────────────────────────────────────────
 *
 * One call is one page of one channel. The pipeline caps calls per pass (GRAPH_MAX_CALLS_PER_PASS)
 * and the steady state is one call a channel. Meta documents a per-user budget of roughly 200
 * calls an hour; a rate-limit answer (codes 4, 17, 32, 613, 80000-80014) pauses this path for 30
 * minutes, IN PROCESS — a restart forgets it and spends one call to learn it again, which is the
 * whole cost (the anonymous gate persists because forgetting it meant hammering; here it does not).
 */
import { igGet } from './igHttp'
import { FeedFetchError, type FeedPost, type FetchFeedResult } from './feed'
import { anonGateHost } from './anonGate'
import { evidenceHead, recordFeedAnswer, type FeedAnswer, type FeedAnswerKind } from './feedEvidence'
import { log } from '@/lib/logger'

// ── Configuration ────────────────────────────────────────────────────────────────────

export const GRAPH_HOST = 'https://graph.facebook.com'
export const DEFAULT_GRAPH_VERSION = 'v25.0'

export interface GraphConfig {
  token: string
  igUserId: string
  version: string
}

/**
 * Read where it is used, like DEEPSEEK_API_KEY — so a test can switch it with `vi.stubEnv` and
 * the token is held in one place. `src/lib/env.ts` validates the same keys at startup and refuses
 * to start with only one of the two set; this re-checks the shape so a malformed id can never
 * reach a URL even when something bypassed the startup check.
 */
export function graphConfig(): GraphConfig | null {
  const token = process.env.META_GRAPH_TOKEN?.trim() ?? ''
  const igUserId = process.env.META_IG_USER_ID?.trim() ?? ''
  if (!token || !/^\d+$/.test(igUserId)) return null
  const v = process.env.META_GRAPH_VERSION?.trim()
  return { token, igUserId, version: v && /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION }
}

/** Is the official read path configured on this host? False everywhere until a person sets both keys. */
export function graphConfigured(): boolean {
  return graphConfig() !== null
}

/** The only header this path sends. Never FEED_HEADERS: that is the anonymous app identity, and this is not it. */
export const GRAPH_HEADERS: Readonly<Record<string, string>> = { Accept: 'application/json' }

// ── The URL (PURE, no token) ─────────────────────────────────────────────────────────

/** The media fields asked for — every one documented on the IG Media node. */
export const GRAPH_MEDIA_FIELDS = [
  'id',
  'caption',
  'timestamp',
  'permalink',
  'media_type',
  'media_product_type',
  'media_url',
  'thumbnail_url',
  'like_count',
  'comments_count',
] as const

/** Graph's documented default page size: fewer calls than the anonymous path's 12 when a gap needs paging. */
export const GRAPH_PAGE_LIMIT = 25

/**
 * ── THE OFFICIAL READ HAS ITS OWN REQUEST BOUND, AND ONE RETRY (16 Oct 2026) ─────────────────
 *
 * It borrowed the anonymous feed's `REQUEST_TIMEOUT_MS` (12 s, sized for a 1,090 ms median), and
 * that is the wrong number for a different request: Business Discovery assembles a page of 25
 * media nodes with their URLs on Meta's side. MEASURED in the box's first backfill: two channels
 * lost whole — @rvcjinsta in the dry run and @instantbollywood (42.8M followers) in `--run` — each
 * on one `timed out after 12000 ms`, with every other page of every other channel answering. And a
 * thrown page discards the pages already read for that channel, so one slow page cost a channel's
 * whole backfill and a re-run of it.
 *
 * 30 s for an answer, and a transport failure (a timeout, a reset — never an ANSWER: a 4xx, a 5xx,
 * an error envelope or a rate limit is Meta speaking, and is never re-asked here) is tried ONCE more
 * on the same page after the read's own page spacing. The anonymous feed retries four times; the
 * official read is a scarcer budget (200 calls an hour per token), so once. The retry is a real call
 * and is charged to the call budget, and it is not made when the budget has nothing left.
 *
 * The cost, stated: a host on which every request hangs waits about a minute a channel here (30 s,
 * the page spacing, 30 s) instead of 12 s. A dead network DOES reach this read: with the anonymous
 * gate closed — the walled steady state since 15 Oct — and in every backfill, `fetchChannelFeed`
 * goes to the official read first, without an anonymous request (feedSource.ts). That is about what
 * the anonymous door already spends on a dead network (four 12 s tries plus backoff, ~54 s a
 * channel); at 17 channels a blackholed pass runs ~18 minutes, past the 15-minute clock, and the
 * scheduler's no-overlap skips the next pass rather than stacking it. Nothing is read either way.
 */
export const GRAPH_REQUEST_TIMEOUT_MS = 30_000
/** Transport failures on one page tried again, at most. See `GRAPH_REQUEST_TIMEOUT_MS`. */
export const GRAPH_TRANSPORT_RETRIES = 1

/** An Instagram username. Anything else must never be spliced into a field expression. */
const USERNAME = /^[A-Za-z0-9._]{1,30}$/
/** A paging cursor may not carry the field-expression syntax it is spliced into. */
const CURSOR = /^[^\s(){},]{1,1024}$/

/**
 * PURE. The Business Discovery URL for one page of one account's media — WITHOUT the token,
 * which the caller appends, so this URL can be logged, printed by a probe and asserted in a test.
 *
 * `username` is requested beside the media so the answer can be checked to be the account asked
 * about: existence is not identity (CLAUDE.md, `enrichHandle`), and a page of someone else's
 * posts filed under a watched channel would be worse than no page.
 *
 * Throws on a value that cannot be a username, an account id, a version or a cursor — a typed
 * refusal, never a request with a mangled expression.
 */
export function buildBusinessDiscoveryUrl(
  handle: string,
  o: { igUserId: string; version: string; limit: number; after?: string | null },
): string {
  if (!USERNAME.test(handle)) throw new Error(`not an Instagram username: ${JSON.stringify(handle.slice(0, 40))}`)
  if (!/^\d+$/.test(o.igUserId)) throw new Error('the account id is not numeric')
  if (!/^v\d+\.\d+$/.test(o.version)) throw new Error(`not a Graph API version: ${JSON.stringify(o.version.slice(0, 12))}`)
  if (o.after != null && !CURSOR.test(o.after)) throw new Error('the paging cursor is not one the API issues')
  const limit = Math.max(1, Math.min(100, Math.floor(o.limit)))
  const media = o.after ? `media.after(${o.after}).limit(${limit})` : `media.limit(${limit})`
  const fields = `business_discovery.username(${handle}){username,${media}{${GRAPH_MEDIA_FIELDS.join(',')}}}`
  return `${GRAPH_HOST}/${o.version}/${o.igUserId}?fields=${encodeURIComponent(fields)}`
}

// ── The answer (PURE) ────────────────────────────────────────────────────────────────

/**
 * PURE. The shortcode inside a permalink — `/p/<code>/`, `/reel/<code>/` or `/tv/<code>/` — which
 * is the same string the anonymous feed calls `code`, so a post read here and the same post read
 * there land on ONE row (`DetectedCampaign.shortcode @unique`). Null when there is none.
 */
export function shortcodeFromPermalink(permalink: unknown): string | null {
  if (typeof permalink !== 'string') return null
  const m = permalink.match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,})(?:[/?#]|$)/)
  return m ? m[1]! : null
}

/**
 * PURE. Graph's media type → the string feed.ts STORES. The anonymous path stores Instagram's
 * `product_type` almost always ('clips' for a reel, 'carousel_container', 'feed' — the column's
 * own documented values), so these map to those, not to toFeedPost's rarely-taken fallback words.
 * `media_product_type` (FEED / REELS / STORY / AD) is the analogue of `product_type`.
 */
export function graphMediaType(mediaType: string | null, productType: string | null): string {
  if (productType === 'REELS') return 'clips'
  if (mediaType === 'CAROUSEL_ALBUM') return 'carousel_container'
  return 'feed'
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/** One item → a FeedPost, or null when it carries no usable shortcode or date. */
function toGraphPost(handle: string, m: Record<string, unknown>, gridIndex: number): FeedPost | null {
  const shortcode = shortcodeFromPermalink(m.permalink)
  // Graph's documented format is "2017-08-31T18:10:00+0000"; V8 parses it (checked on Node here).
  const at = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : Number.NaN
  if (!shortcode || !Number.isFinite(at)) return null
  const mediaType = str(m.media_type)
  const mediaUrl = str(m.media_url)
  return {
    shortcode,
    // The anonymous path's own permalink form, so the two sources write byte-identical rows.
    permalink: `https://www.instagram.com/p/${shortcode}/`,
    ownerHandle: handle,
    caption: str(m.caption) ?? '',
    likeCount: count(m.like_count),
    commentCount: count(m.comments_count),
    postedAt: new Date(at),
    gridIndex,
    // NOT REPORTED BY THE API — and `false` here is the conservative direction: it never makes
    // a post "officially paid". The stored payload records it as unknown (evidence.ts).
    isPaidPartnership: false,
    sponsorHandles: [],
    collabHandles: [],
    taggedAccounts: [],
    mediaType: graphMediaType(mediaType, str(m.media_product_type)),
    // A video's cover is `thumbnail_url`; an image is its own cover. A carousel's `media_url`
    // may be a VIDEO (its first child), so it is not taken as a frame — no cover beats a
    // video file saved as one. A CAROUSEL therefore gets no frame at all (inferred from the
    // documentation; asking for its `children{…}` would fix that and is not built), and is judged
    // on its caption alone until the anonymous feed re-reads it.
    //
    // THE FULL-SIZE FRAME — MEASURED IN PRODUCTION, 16 Oct 2026, and handled. Both URLs here are
    // FULL-SIZE files, not the ~480 px thumbnail the anonymous path picks, and the box's backfill
    // log showed `saveFrame`'s 512 KB cap refusing most of them (`bytes=1052612 / 748357 / 591056 /
    // 870691 / 571895`), so those posts were judged on their caption alone. `saveFrame` now
    // shrinks an over-size IMAGE to fit 720 x 1280 and saves that (media.ts; `frameShrinkTool` in
    // lib/platform.ts picks the tool), and `rejudgeUnusedEvidence` re-judges a post stored
    // `frame:not-saved` once its frame is on disk. Not yet measured: the size a shrunk Graph frame
    // comes to (the worker logs it) and OCR recall on one.
    thumbnailUrl: str(m.thumbnail_url) ?? (mediaType === 'IMAGE' ? mediaUrl : null),
    videoUrl: mediaType === 'VIDEO' ? mediaUrl : null,
    videoDurationSeconds: null,
    evidenceIncomplete: true,
  }
}

export type GraphParse =
  | {
      ok: true
      posts: FeedPost[]
      /** The next page's cursor, or null when there is none (or the page was empty). */
      after: string | null
      /** Items that carried no shortcode or no date — counted, never silently lost. */
      dropped: number
      /** Always true: this source never reports tag, collaborator or sponsor evidence. */
      evidenceIncomplete: true
    }
  | { ok: false; why: string }

/**
 * PURE. One Business Discovery answer → posts, the next cursor, and the INCOMPLETE flag.
 *
 * Shape (documented, not observed): `{ business_discovery: { username, id, media: { data: [...],
 * paging: { cursors: { before, after } } } }, id }`. A missing `media` edge reads as an empty page
 * rather than a changed shape — an account with no posts is a fact, and the pipeline already
 * alarms on a channel that returns none. A `username` naming a DIFFERENT account is refused.
 */
export function parseBusinessDiscovery(json: unknown, handle: string, gridOffset = 0): GraphParse {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, why: 'the answer is not a JSON object' }
  const bd = (json as Record<string, unknown>).business_discovery
  if (!bd || typeof bd !== 'object' || Array.isArray(bd)) return { ok: false, why: 'the answer has no business_discovery object' }
  const b = bd as Record<string, unknown>
  if (typeof b.username === 'string' && b.username.toLowerCase() !== handle.toLowerCase()) {
    return { ok: false, why: `the answer describes @${b.username.slice(0, 30)}, not @${handle}` }
  }
  const media = b.media
  if (media === undefined || media === null) return { ok: true, posts: [], after: null, dropped: 0, evidenceIncomplete: true }
  if (typeof media !== 'object' || Array.isArray(media)) return { ok: false, why: 'business_discovery.media is not an object' }
  const data = (media as Record<string, unknown>).data
  if (!Array.isArray(data)) return { ok: false, why: 'business_discovery.media.data is not a list' }

  const posts: FeedPost[] = []
  let dropped = 0
  for (const item of data) {
    const post = item && typeof item === 'object' && !Array.isArray(item) ? toGraphPost(handle, item as Record<string, unknown>, gridOffset + posts.length) : null
    if (post) posts.push(post)
    else dropped += 1
  }
  const paging = (media as Record<string, unknown>).paging as Record<string, unknown> | undefined
  const cursors = paging && typeof paging === 'object' ? (paging.cursors as Record<string, unknown> | undefined) : undefined
  const raw = cursors && typeof cursors === 'object' ? str(cursors.after) : null
  // No posts means no next page, whatever cursor rode along; a cursor we could not splice safely is no cursor.
  const after = data.length > 0 && raw !== null && CURSOR.test(raw) ? raw : null
  return { ok: true, posts, after, dropped, evidenceIncomplete: true }
}

// ── Errors (PURE) ────────────────────────────────────────────────────────────────────

export type GraphErrorKind = Extract<FeedAnswerKind, 'graph-token' | 'graph-rate-limit' | 'graph-not-professional' | 'graph-error'>

export interface GraphErrorVerdict {
  kind: GraphErrorKind
  code: number | null
  subcode: number | null
  /** Meta's own words, redacted and cut — never anything from the URL. */
  message: string
  /**
   * `all`: the answer is about our token, our account or our budget, so every further call this
   * pass would get the same answer. `channel`: it is about the account asked for.
   */
  scope: 'all' | 'channel'
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613])

/**
 * PURE. What a Graph error answer means. FROM META'S DOCUMENTATION, except three answers MEASURED on
 * the box on 15 Oct 2026 with curl (the rows marked "measured" in tests/graph-feed.test.ts): 110 /
 * 2207013 "Invalid user id" for @marketingmentalist, a personal account; 100 / 33 "Unsupported get
 * request" when OUR account id was empty; 2500 "An active access token must be used" when the token
 * was empty. The other 13 of 14 watched pages answered with media, so the table below is right for
 * the cases that have happened and documented for the rest:
 *
 *   190                         the token is invalid or expired                       all
 *   4, 17, 32, 613, 80000-80014 rate limited (app / user / page / custom / business)  all
 *   10, 200-299                 a permission is missing                               all
 *   100 + subcode 33, or        "Unsupported get request. Object with ID … does not   all
 *     "Unsupported get request"  exist" — OUR account id is wrong, not theirs
 *   110, subcode 2207013, or    the username is not a Business/Creator account, or    channel
 *     100 + "invalid user id" /  does not exist
 *     "cannot find user" / "does not exist"
 *   anything else               an error to show a person                             channel
 *
 * The ordering is the safety argument: the subcode-33 case says "does not exist" too, and filing
 * it as one channel's problem would spend a call on every channel, every pass, against a wrong id.
 */
export function classifyGraphError(status: number, json: unknown): GraphErrorVerdict {
  const err =
    json && typeof json === 'object' && !Array.isArray(json) && (json as Record<string, unknown>).error
      ? ((json as Record<string, unknown>).error as Record<string, unknown>)
      : null
  const code = err && typeof err.code === 'number' ? err.code : null
  const subcode = err && typeof err.error_subcode === 'number' ? err.error_subcode : null
  const words = err && typeof err.message === 'string' ? err.message : ''
  const message = evidenceHead(code !== null ? `(#${code}) ${words}` : words || `HTTP ${status}`, 200) ?? `HTTP ${status}`
  const v = (kind: GraphErrorKind, scope: 'all' | 'channel'): GraphErrorVerdict => ({ kind, code, subcode, message, scope })

  if (code === 190) return v('graph-token', 'all')
  // 2500 is OAuthException's catch-all, measured on the box 15 Oct 2026 with an EMPTY token: "An
  // active access token must be used to query information about the current user." It is also what
  // Meta answers for a malformed path ("Unknown path components"). Either way it is true of every
  // channel, so it stops the pass rather than costing one call per channel.
  if (code === 2500) return v(/access token/i.test(words) ? 'graph-token' : 'graph-error', 'all')
  if ((code !== null && (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014))) || (code === null && status === 429)) {
    return v('graph-rate-limit', 'all')
  }
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return v('graph-error', 'all')
  if ((code === 100 && subcode === 33) || /unsupported get request/i.test(words)) return v('graph-error', 'all')
  if (code === 110 || subcode === 2207013) return v('graph-not-professional', 'channel')
  if (code === 100 && /invalid user id|cannot find user|does not exist|not a (business|professional|creator)/i.test(words)) {
    return v('graph-not-professional', 'channel')
  }
  return v('graph-error', 'channel')
}

/** What failed, carried on the thrown error so the pipeline can tell it from an anonymous failure. */
// `cap-reached`: an official-only read (feedSource.ts, `pnpm ig:backfill`) whose pass had spent its call cap.
export type GraphFailure = GraphErrorKind | 'transport' | 'shape' | 'paused' | 'invalid-handle' | 'not-configured' | 'cap-reached'

/**
 * A failure of THE OFFICIAL PATH. A FeedFetchError (so every existing catch still holds), but a
 * distinct class, because two of its fields mean something else here: `isThrottle` is the GRAPH
 * cooldown, which must never be written into `detectThrottledUntil` (that stamp is the anonymous
 * gate's, and the banner reads it as such).
 */
export class GraphFeedError extends FeedFetchError {
  /** The anonymous failure that sent this channel here, set by feedSource.ts. */
  public anonymousError: FeedFetchError | null = null
  constructor(
    handle: string,
    public readonly graphKind: GraphFailure,
    message: string,
    opts: { isParseFailure?: boolean; isThrottle?: boolean; until?: Date | null; isTransport?: boolean } = {},
  ) {
    super(handle, `official API: ${message}`, opts.isParseFailure ?? false, opts.isThrottle ?? false, opts.until ?? null, opts.isTransport ?? false)
    this.name = 'GraphFeedError'
  }
}

// ── The cooldown (in process) ─────────────────────────────────────────────────────────

/** A rate-limit answer pauses this path this long. Meta's own window is an hour; half of it, then one call to ask. */
export const GRAPH_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000
/**
 * A token, permission or account-id answer pauses it this long. Nothing but a person editing the
 * box's `.env` and restarting can fix those, and a restart clears this — so the pause only saves
 * the ~19 calls a pass would spend learning the same thing, and it re-asks once an hour in case
 * the answer was transient.
 */
export const GRAPH_STOPPED_RETRY_MS = 60 * 60_000

let clock: () => number = () => Date.now()
let paused: { until: number; kind: GraphErrorKind } | null = null
let tokenAlarmed = false

/** Tests inject a clock; production never calls this. */
export function setGraphClockForTests(fn?: () => number): void {
  clock = fn ?? (() => Date.now())
}

/** Tests only: forget the pause and the one-alarm-per-process latch. */
export function resetGraphStateForTests(): void {
  paused = null
  tokenAlarmed = false
}

export type GraphCooldown = { open: true } | { open: false; until: Date; kind: GraphErrorKind }

/** Ask before spending a call. A timestamp, not a flag: it reopens by itself. */
export function graphCooldown(): GraphCooldown {
  if (paused && clock() < paused.until) return { open: false, until: new Date(paused.until), kind: paused.kind }
  return { open: true }
}

// ── Redaction, evidence ───────────────────────────────────────────────────────────────

/**
 * Every string that leaves this file passes here: the literal token, its URL-encoded form, then
 * feedEvidence's token shapes. A transport error does not normally echo the URL — but "normally"
 * is not a guarantee anyone can test for every Node version, and a token in a Setting row every
 * dashboard reads would be a credential handed to every viewer.
 */
export function scrub(text: string | null | undefined, token: string, max = 200): string | null {
  if (!text) return null
  let s = text
  if (token) {
    for (const t of [token, encodeURIComponent(token)]) s = s.split(t).join('[redacted]')
  }
  return evidenceHead(s, max)
}

function note(handle: string, a: Pick<FeedAnswer, 'kind' | 'status' | 'contentType' | 'head' | 'items'> & { until?: string | null }): void {
  void recordFeedAnswer({ at: new Date(clock()).toISOString(), host: anonGateHost(), source: 'graph', handle, ...a })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err)
}

// ── The read ──────────────────────────────────────────────────────────────────────────

/** A per-pass call budget, shared across channels by the pipeline. `dropped` counts channels the cap cost. */
export interface GraphBudget {
  remaining: number
  used: number
  dropped: number
}

/**
 * Read one channel through Business Discovery, paginating like `fetchFeed`: until `maxPosts`,
 * `maxPages`, a page older than `sinceUnix`, the last cursor, or the call budget.
 *
 * Throws a `GraphFeedError` on every failure, records a `source: 'graph'` FeedAnswer on every
 * exit (the first page's ok or empty, every failure), and returns posts flagged INCOMPLETE.
 */
export async function fetchFeedViaGraph(
  handle: string,
  opts: {
    maxPosts?: number
    sinceUnix?: number
    maxPages?: number
    delayMs?: number
    budget?: GraphBudget
    /**
     * `false` for a PERSON's probe (`ig:probe --graph`): it reports what came back and must not
     * speak for the detection pass — a one-off probe overwriting the row the landing page reads
     * would put a person's single request in front of the operator as "what the server got".
     * Default `true`: every pass records.
     */
    record?: boolean
  } = {},
): Promise<FetchFeedResult> {
  const say = (a: Parameters<typeof note>[1]): void => {
    if (opts.record !== false) note(handle, a)
  }
  const maxPosts = opts.maxPosts ?? 48
  const maxPages = opts.maxPages ?? 6
  const delayMs = opts.delayMs ?? 2500
  const cfg = graphConfig()
  if (!cfg) throw new GraphFeedError(handle, 'not-configured', 'the official read fallback is not configured on this host — no request made')

  const cd = graphCooldown()
  if (!cd.open) {
    throw new GraphFeedError(handle, 'paused', `paused on this host until ${cd.until.toISOString()} (${cd.kind}) — no request made`, {
      isThrottle: cd.kind === 'graph-rate-limit',
      until: cd.until,
    })
  }

  const posts: FeedPost[] = []
  let after: string | null = null
  let pages = 0
  let moreAvailable = false
  let dropped = 0

  while (pages < maxPages && posts.length < maxPosts) {
    if (opts.budget && opts.budget.remaining <= 0) {
      // The pass's cap, reached mid-channel. What was read is kept; the pipeline logs the cap.
      moreAvailable = true
      break
    }
    let url: string
    try {
      url = buildBusinessDiscoveryUrl(handle, { igUserId: cfg.igUserId, version: cfg.version, limit: GRAPH_PAGE_LIMIT, after })
    } catch (err) {
      throw new GraphFeedError(handle, 'invalid-handle', `${scrub(describe(err), cfg.token) ?? 'the request could not be built'} — no request made`)
    }
    if (opts.budget) {
      opts.budget.remaining -= 1
      opts.budget.used += 1
    }

    let res
    for (let attempt = 0; ; attempt++) {
      try {
        res = await igGet(`${url}&access_token=${encodeURIComponent(cfg.token)}`, { headers: { ...GRAPH_HEADERS }, timeoutMs: GRAPH_REQUEST_TIMEOUT_MS })
        break
      } catch (err) {
        const why = scrub(describe(err), cfg.token) ?? 'no answer at all'
        // ONE more try of this page (GRAPH_REQUEST_TIMEOUT_MS), charged like any call, never past the budget.
        if (attempt < GRAPH_TRANSPORT_RETRIES && !(opts.budget && opts.budget.remaining <= 0)) {
          log.warn('the official API did not answer — trying the same page once more', { handle, page: pages + 1, why })
          if (opts.budget) {
            opts.budget.remaining -= 1
            opts.budget.used += 1
          }
          await new Promise((r) => setTimeout(r, delayMs))
          continue
        }
        const tries = attempt + 1
        say({ kind: 'transport', status: null, contentType: null, head: why, items: null })
        throw new GraphFeedError(handle, 'transport', `could not be reached${tries > 1 ? ` after ${tries} tries` : ''}: ${why}`, { isTransport: true })
      }
    }

    const body = await res.text().catch(() => '')
    const contentType = res.contentType ?? null
    let json: unknown
    try {
      json = JSON.parse(body) as unknown
    } catch {
      json = undefined
    }
    const isErrorEnvelope =
      json !== undefined && json !== null && typeof json === 'object' && !Array.isArray(json) && 'error' in (json as object)

    if (!res.ok || isErrorEnvelope) {
      const v = classifyGraphError(res.status, json)
      const message = scrub(v.message, cfg.token) ?? `HTTP ${res.status}`
      let until: Date | null = null
      if (v.kind === 'graph-rate-limit') {
        until = new Date(clock() + GRAPH_RATE_LIMIT_COOLDOWN_MS)
        paused = { until: until.getTime(), kind: v.kind }
        log.warn('the official API asked this host to slow down — pausing it', { code: v.code, until: until.toISOString() })
      } else if (v.scope === 'all') {
        until = new Date(clock() + GRAPH_STOPPED_RETRY_MS)
        paused = { until: until.getTime(), kind: v.kind }
        if (v.kind === 'graph-token') {
          if (!tokenAlarmed) {
            tokenAlarmed = true
            log.alarm('the official read token is invalid or expired — a person must mint a new one', { code: v.code, subcode: v.subcode })
          }
        } else {
          log.alarm('the official API refused this host — it pauses until a person looks', { code: v.code, subcode: v.subcode, until: until.toISOString() })
        }
      }
      // An error envelope is Meta's sentence; anything else (a proxy's HTML 502) is kept as its own head.
      const head = isErrorEnvelope ? message : (scrub(body, cfg.token, 240) ?? message)
      say({ kind: v.kind, status: res.status, contentType, head, items: null, until: until?.toISOString() ?? null })
      const sentence =
        v.kind === 'graph-token'
          ? `the read token is invalid or expired (${message})`
          : v.kind === 'graph-rate-limit'
            ? `rate limited (${message}) — this path pauses until ${until!.toISOString()}`
            : v.kind === 'graph-not-professional'
              ? `@${handle} is not a Business or Creator account, or does not exist (${message})`
              : `refused the read (HTTP ${res.status}, ${message})`
      throw new GraphFeedError(handle, v.kind, sentence, { isThrottle: v.kind === 'graph-rate-limit', until })
    }

    if (json === undefined) {
      say({ kind: 'not-json', status: res.status, contentType, head: scrub(body, cfg.token, 240), items: null })
      throw new GraphFeedError(handle, 'shape', `answered HTTP ${res.status} with something that is not JSON${contentType ? ` (${contentType})` : ''}`, { isParseFailure: true })
    }
    const page = parseBusinessDiscovery(json, handle, posts.length)
    if (!page.ok) {
      say({ kind: 'shape', status: res.status, contentType, head: scrub(page.why, cfg.token), items: null })
      throw new GraphFeedError(handle, 'shape', `answer changed shape: ${scrub(page.why, cfg.token)}`, { isParseFailure: true })
    }
    if (pages === 0) {
      say({ kind: page.posts.length === 0 ? 'empty' : 'ok', status: res.status, contentType, head: null, items: page.posts.length })
    }
    dropped += page.dropped
    posts.push(...page.posts)
    pages += 1
    after = page.after
    moreAvailable = after !== null

    // The API documents newest-first; the oldest is taken by value, not position, so an unexpected order cannot page forever.
    const oldest = page.posts.reduce<number | null>((min, p) => {
      const s = Math.floor(p.postedAt.getTime() / 1000)
      return min === null || s < min ? s : min
    }, null)
    if (opts.sinceUnix && oldest !== null && oldest < opts.sinceUnix) break
    if (!moreAvailable) break
    await new Promise((r) => setTimeout(r, delayMs))
  }

  if (dropped > 0) log.warn('official API items without a shortcode or date were not stored', { handle, dropped })
  log.step('official feed fetched', { handle, posts: posts.length, pages, moreAvailable })
  return { posts: posts.slice(0, maxPosts), pagesFetched: pages, moreAvailable, evidenceIncomplete: true }
}

/**
 * ONE page of one account, for a person checking the fallback on the box (`ig:probe --graph`,
 * docs/DEPLOY.md). A plain sentence either way, never the URL, never the token. Respects the
 * pause: a person probing must not be the reason a rate limit gets worse. Records NOTHING
 * (`record: false`, 15 Oct 2026): the evidence row is the detection pass's, and the probe's
 * answer is printed to the person who asked rather than shown to everyone as the server's.
 */
export async function probeOfficialRead(handle: string): Promise<{ ok: boolean; sentence: string }> {
  if (!graphConfigured()) {
    return { ok: false, sentence: 'The official read fallback is not configured on this host: META_GRAPH_TOKEN and META_IG_USER_ID are not both set.' }
  }
  try {
    // `record: false`: a person's probe reports, it does not write the evidence row the pass owns.
    const r = await fetchFeedViaGraph(handle, { maxPages: 1, maxPosts: GRAPH_PAGE_LIMIT, delayMs: 0, record: false })
    const newest = r.posts[0]?.postedAt.toISOString() ?? null
    return {
      ok: r.posts.length > 0,
      sentence:
        r.posts.length > 0
          ? `The official API read ${r.posts.length} post(s) from @${handle}; the newest is from ${newest}. They carry no tag data.`
          : `The official API answered for @${handle} with no posts in it.`,
    }
  } catch (err) {
    return { ok: false, sentence: `The official API did not read @${handle}: ${err instanceof Error ? err.message.replace(/^\[@[^\]]+\]\s*/, '') : String(err)}` }
  }
}
