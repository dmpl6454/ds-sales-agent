/**
 * feedSource.ts — WHICH DOOR A CHANNEL IS READ THROUGH. The one function the pipeline calls per
 * channel (15 Oct 2026).
 *
 * Two doors: the anonymous feed (feed.ts) and, only where a person has configured it, the official
 * Graph API (graphFeed.ts). The order, and why each row is the way it is:
 *
 *   official read     anonymous     what happens
 *   ─────────────     ─────────     ─────────────────────────────────────────────────────────────
 *   not usable        —             EXACTLY TODAY: `fetchFeed`, its answer or its error, untouched.
 *   (off, not          ↑            "Not usable" is: this pass may not use it (a Mac's failover),
 *    configured,                    no token on this host, paused after a rate limit or a token
 *    paused, or                     error, or this pass's call cap spent (that last one counted).
 *    cap spent)
 *   usable            gate open     `fetchFeed` first. On a refusal (a throttle, the login wall) or
 *                                   any other ANSWERED failure (a 400, a web page, a changed shape)
 *                                   → the official API for this channel. On a TRANSPORT failure →
 *                                   re-thrown: a host that cannot reach the network will not reach
 *                                   graph.facebook.com either, and the second try would be a call
 *                                   spent to learn nothing.
 *   usable            gate open,    the official API too. A real watched channel never has zero
 *                     0 posts       posts, and "HTTP 200 with no posts in it" is one of the
 *                                   outage shapes feedEvidence.ts names — so an empty first page
 *                                   is not taken as the answer while a second door exists.
 *   usable            gate CLOSED   straight to the official API, WITHOUT an anonymous request. A
 *                                   closed gate must never be spent: every request into it only
 *                                   extends the cooldown (anonGate.ts).
 *
 * And one row outside the table: `officialOnly` (`pnpm ig:backfill --run` only) asks the official
 * API and never the anonymous feed, gate open or closed; unusable, it throws with no request made.
 *
 * With the official read unusable the module is a pass-through, and `tests/feed-source.test.ts`
 * proves it byte for byte — same requests, same errors — because "dormant" is a claim about
 * behaviour, and only a test of behaviour can hold it.
 */
import { anonGateCheck } from './anonGate'
import { fetchFeed, FeedFetchError, type FetchFeedResult } from './feed'
import { fetchFeedViaGraph, graphConfigured, graphCooldown, GraphFeedError, type GraphBudget } from './graphFeed'

export type FeedSourceName = 'anonymous' | 'graph'

export interface ChannelFeedResult extends FetchFeedResult {
  /** Which door served this channel. */
  source: FeedSourceName
  /**
   * Why the anonymous feed did not serve it, in words, when the official API did — for the log.
   * Null when the anonymous feed served it.
   */
  fallbackReason: string | null
  /** The anonymous failure itself, when there was one (a closed gate makes no request, so has none). */
  anonymousError: FeedFetchError | null
}

export interface ChannelFeedOptions {
  maxPosts?: number
  sinceUnix?: number
  /**
   * How far back the ANONYMOUS read should page, when that is further than `sinceUnix` — set by the
   * pipeline only for a channel holding posts the official API stored without their evidence, so
   * the anonymous feed reaches back and completes them (review, 15 Oct 2026). The official API
   * never uses it: paging it deeper would re-read posts it can never complete, and spend calls to
   * do so. Absent (every channel, until the fallback has served one) means `sinceUnix`, so the
   * pass-through below is unchanged.
   */
  completeSinceUnix?: number
  maxPages?: number
  delayMs?: number
  /**
   * OFFICIAL-ONLY — the mirror of `completeSinceUnix` (16 Oct 2026, officialReach.ts). How far back,
   * and how deep, the OFFICIAL read reaches when that is further than the routine read: set by the
   * pipeline for a channel with a real gap (nothing stored inside the lookback) and by
   * `pnpm ig:backfill --run` for every channel. `viaGraph` uses each in place of `sinceUnix` /
   * `maxPosts` / `maxPages`; `fetchFeed` never sees them — the anonymous door's throttle is what
   * volume earned, and its 48-post window could not reach that far anyway. Absent (every channel
   * without a gap, and every host without the fallback) means the routine values, byte for byte.
   */
  officialSinceUnix?: number
  officialMaxPosts?: number
  officialMaxPages?: number
  /**
   * OFFICIAL-ONLY READ: `pnpm ig:backfill --run` and nothing else (review, 16 Oct 2026). The
   * official API is asked directly and the anonymous feed NOT AT ALL — so a channel the anonymous
   * feed would answer is still backfilled (its 48-post window could never reach a blind stretch;
   * Business Discovery can), the run reads through the same door as its dry run, and no anonymous
   * request is spent from a gate that refuses on volume. When the official read is unusable it
   * throws a `GraphFeedError` naming why and makes NO request of either door. Absent, or false,
   * is the table at the top of this file, unchanged.
   */
  officialOnly?: boolean
  /**
   * May THIS PASS use the official API? The pipeline sets it from `role === 'primary'`: the token
   * lives on the server only, and a Mac's failover pass must behave exactly as it always has.
   */
  allowGraph: boolean
  /** The pass's call budget. Omitted means unbounded — only the probe and tests do that. */
  graphBudget?: GraphBudget
}

export type OfficialReadAvailability = 'available' | 'off' | 'paused' | 'cap-reached'

/** Can the official API serve the next channel, and if not, why not. */
export function officialReadAvailability(o: Pick<ChannelFeedOptions, 'allowGraph' | 'graphBudget'>): OfficialReadAvailability {
  if (!o.allowGraph || !graphConfigured()) return 'off'
  if (!graphCooldown().open) return 'paused'
  if (o.graphBudget && o.graphBudget.remaining <= 0) return 'cap-reached'
  return 'available'
}

/**
 * Is the official API the reason a channel can still be read? Counts a channel the CAP cost —
 * the pipeline logs `dropped`, because a silent cap is a channel nobody knows was skipped.
 */
function canFallBack(o: ChannelFeedOptions): boolean {
  const a = officialReadAvailability(o)
  if (a === 'cap-reached' && o.graphBudget) o.graphBudget.dropped += 1
  return a === 'available'
}

async function viaGraph(
  handle: string,
  o: ChannelFeedOptions,
  fallbackReason: string,
  anonymousError: FeedFetchError | null,
): Promise<ChannelFeedResult> {
  try {
    const r = await fetchFeedViaGraph(handle, {
      // The official-only reach when the pipeline set one (a gap, or a backfill); otherwise exactly today's.
      maxPosts: o.officialMaxPosts ?? o.maxPosts,
      sinceUnix: o.officialSinceUnix ?? o.sinceUnix,
      maxPages: o.officialMaxPages ?? o.maxPages,
      delayMs: o.delayMs,
      budget: o.graphBudget,
    })
    return { ...r, source: 'graph', fallbackReason, anonymousError }
  } catch (err) {
    // The pipeline must see BOTH failures: why the anonymous feed was left, and why this failed.
    if (err instanceof GraphFeedError) err.anonymousError = anonymousError
    throw err
  }
}

/** The ONE function the pipeline calls per channel. See the table at the top of this file. */
export async function fetchChannelFeed(handle: string, opts: ChannelFeedOptions): Promise<ChannelFeedResult> {
  const feedOpts = stripUndefined({
    maxPosts: opts.maxPosts,
    sinceUnix: opts.completeSinceUnix ?? opts.sinceUnix,
    maxPages: opts.maxPages,
    delayMs: opts.delayMs,
  })
  /**
   * ONE check decides whether the official API is in play — `officialReadAvailability`, asked
   * through `canFallBack` at each of the three places a channel could go there. Not configured,
   * or not this pass's to use, it answers 'off' everywhere and every line below is `fetchFeed`
   * and its own answer. (`anonGateCheck` is a read with no side effect; `fetchFeed` asks it too.)
   */
  if (opts.officialOnly) return officialOnlyRead(handle, opts)
  const gate = anonGateCheck()
  if (!gate.ok && canFallBack(opts)) {
    return viaGraph(handle, opts, `anonymous reads are paused on this host until ${gate.until.toISOString()} — no anonymous request made`, null)
  }

  let anon: FetchFeedResult
  try {
    // A closed gate with no usable fallback lands here and throws its own "no request made"
    // error, exactly as today.
    anon = await fetchFeed(handle, feedOpts)
  } catch (err) {
    if (!(err instanceof FeedFetchError) || err.isTransport || !gate.ok) throw err
    if (!canFallBack(opts)) throw err
    return viaGraph(handle, opts, err.message.replace(/^\[@[^\]]+\]\s*/, ''), err)
  }
  if (anon.posts.length === 0 && anon.pagesFetched > 0 && canFallBack(opts)) {
    return viaGraph(handle, opts, 'the anonymous feed answered with no posts', null)
  }
  return { ...anon, source: 'anonymous', fallbackReason: null, anonymousError: null }
}

/**
 * The backfill's read: the official API or nothing. `canFallBack` is the one availability check
 * (it counts a channel the cap cost, as everywhere else); an unusable official read throws without
 * a request of either door, carrying the reason, so the pipeline files it as the official read's
 * failure and never as an anonymous one.
 */
async function officialOnlyRead(handle: string, opts: ChannelFeedOptions): Promise<ChannelFeedResult> {
  const why = officialReadAvailability(opts)
  if (canFallBack(opts)) return viaGraph(handle, opts, 'an official-only read (pnpm ig:backfill) — no anonymous request made', null)
  const cd = graphCooldown()
  const paused = why === 'paused' && !cd.open ? cd : null
  throw new GraphFeedError(
    handle,
    why === 'off' ? 'not-configured' : why === 'cap-reached' ? 'cap-reached' : 'paused',
    why === 'off'
      ? 'this read is official-only and the official read is not usable by this pass — no request made'
      : why === 'cap-reached'
        ? "this pass's official call cap is spent — no request made"
        : `paused on this host until ${paused?.until.toISOString() ?? 'unknown'} (${paused?.kind ?? 'unknown'}) — no request made`,
    { isThrottle: paused?.kind === 'graph-rate-limit', until: paused?.until ?? null },
  )
}

/**
 * `fetchFeed` reads `opts.x ?? default`, so an explicit `undefined` and an absent key already mean
 * the same thing — this keeps the argument the pipeline passes identical in shape to what it
 * passed before, which is what the pass-through test compares.
 */
function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
