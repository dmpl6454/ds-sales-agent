import { prisma } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { log } from '@/lib/logger'
import { writeStringArray } from '@/lib/json'
import { FeedFetchError, type FeedPost } from './feed'
import { fetchChannelFeed, officialReadAvailability, type FeedSourceName, type OfficialReadAvailability } from './feedSource'
import { graphConfigured, graphCooldown, GraphFeedError, type GraphBudget, type GraphErrorKind, type GraphFailure } from './graphFeed'
import { anonGateCheck, hydrateAnonGate, DETECT_FEED_OK_KEY, DETECT_THROTTLED_KEY } from './anonGate'
import { getDetector } from './detectors'
import { setChannelVocabulary } from './detectors/semantic'
import { buildVocabulary } from './detectors/novelty'
import { saveFrame } from './media'
import { buildRawPayload, evidenceRefresh, EVIDENCE_INCOMPLETE_MARKER } from './evidence'
import { tagsForPost } from './tagEvidence'
import { publisherForPrompt } from './publisherContext'
import type { ModelInputs } from './types'
import { judgeWithFrame } from './judge'
import { hoursAgo } from '@/lib/time'
import { DETECT_CATCHUP_LOOKBACK_HOURS, DETECT_LOOKBACK_HOURS } from './cadence'
import {
  GRAPH_BACKFILL_CALL_CAP,
  WATCHED_CHANNEL_WHERE,
  gapStartUnix,
  hoursBackTo,
  isValidBackfillHours,
  officialReachFor,
  officialShortfall,
  unreadStretch,
  type OfficialShortfall,
} from './officialReach'
import { autoResolveBrands, type AutoResolveSummary } from './autoResolve'
import { rejudgeUnusedEvidence, type RejudgeSummary } from './rejudge'

/**
 * Detection: read each watched channel's recent posts and classify them.
 *
 * One anonymous HTTP request per page, no browser, no credentials. See feed.ts
 * for why that matters — anything that attaches a session here would turn an
 * IP-level risk into an account-ban risk.
 *
 * Idempotency comes free from `DetectedCampaign.shortcode @unique`: four checks a
 * day means each post is seen repeatedly, so known shortcodes are filtered before
 * any work and the rest are upserted. Re-running a slot is safe.
 */

/**
 * The model inputs for one live post besides its caption: who it tags, and whose feed it is.
 *
 * ── BUILT ONCE, HANDED TO BOTH CALLS (2026-10-09) ────────────────────────────────────
 *
 * A post reaches the model twice — its caption alone in the detector, then caption plus frame
 * in `judgeWithFrame` — and `applyFrameSignal` blames any difference between the two answers
 * on THE FOOTAGE. Each side used to build its own blocks, and they had drifted: the detector
 * named the publisher `@filmygyan` (it held no display name) while judge named it
 * `@filmygyan ("F I L M Y G Y A N")`. Built here, from the target row that carries the display
 * name, and passed unchanged to both, the two calls differ in exactly one input by
 * construction.
 *
 * The display name is not decoration: `publisherForPrompt` fires when the caption names the
 * publisher by its handle OR its display name, so a caption saying "RVCJ Media" on @rvcjinsta
 * gets the block only when the name is supplied. Exported so the composition test drives this
 * builder rather than a copy of it.
 */
export async function modelInputsFor(
  post: Pick<FeedPost, 'shortcode' | 'caption' | 'taggedAccounts' | 'collabHandles' | 'isPaidPartnership'>,
  target: { handle: string; displayName: string | null },
  publisherAsContext: boolean,
): Promise<ModelInputs> {
  return {
    tagText: await tagsForPost(
      {
        taggedAccounts: post.taggedAccounts,
        collabHandles: post.collabHandles,
        isPaidPartnership: post.isPaidPartnership,
      },
      post.shortcode.slice(0, 6),
    ),
    publisherText: publisherAsContext
      ? publisherForPrompt(post.caption, { handle: target.handle, displayName: target.displayName })
      : null,
  }
}

export interface ChannelOutcome {
  handle: string
  fetched: number
  alreadyKnown: number
  stored: number
  campaigns: number
  unclassified: number
  organic: number
  officiallyPaid: number
  /**
   * Posts whose FOOTAGE changed the answer — a caption that read ordinary, raised to
   * REVIEW because the frame's text said otherwise. Counted separately because it is the
   * only number that says whether reading the video is earning its keep, and because a
   * frame-driven judgement is measured by nothing in `ig:accuracy` (its labels are
   * caption-derived), so it must stay visible as its own thing rather than merge into
   * the campaign count.
   */
  frameFlagged: number
  /**
   * Posts already stored whose TAGS, COLLABORATORS or sponsor flag had changed since we
   * captured them. Counted rather than merged into `stored`, because a post editing itself
   * after publication is a different event from a post arriving, and the number is the only
   * evidence that refreshing is worth doing at all — a permanent zero would say the
   * comparison is buying nothing, which is a finding rather than a quiet success.
   */
  evidenceRefreshed: number
  pagesFetched: number
  error?: string
  parseFailure?: boolean
  /**
   * Not read at all this pass. `throttled`: Instagram had told this host to stop (anonGate.ts).
   * `official-rate-limited`: the anonymous feed failed and the official API had just asked this
   * host to slow down (graphFeed.ts) — a different cooldown, never counted as the anonymous one.
   */
  skipped?: 'throttled' | 'official-rate-limited'
  /** Which door served this channel, when one did (feedSource.ts). */
  servedBy?: FeedSourceName
  /**
   * Set only when this channel's OFFICIAL read was asked to reach further back than the routine
   * read — the gap rule or `pnpm ig:backfill` (officialReach.ts) — and the official API served it:
   * the floor it was asked for, and whether it got there. `ig:backfill` reads it to name every
   * channel the run did not finish; the pass logs a shortfall by name. Absent on every other read.
   */
  officialReach?: { sinceUnix: number } & OfficialShortfall
  /**
   * Why the official read could not serve a channel the closed anonymous gate skipped — set only
   * where the fallback is configured for this pass, so `ig:backfill` can say "the call cap was spent"
   * or "the official API is paused" instead of a bare "throttled".
   */
  officialUnavailable?: Exclude<OfficialReadAvailability, 'available'>
  /**
   * Which answer paused the official read, when `officialUnavailable` is `paused` — a rate limit
   * clears itself within the hour, a token error never does until a person mints a new one, so
   * `ig:backfill` must not tell a person to "re-run after an hour" about the second.
   */
  officialPausedBy?: GraphErrorKind
  /** What the official read itself failed with, when it was asked and threw (graphFeed.ts `graphKind`). */
  officialFailure?: GraphFailure
  /**
   * NO SILENT CAPS (review, 16 Oct 2026): a stretch of this channel the pass KNOWS it left unread —
   * from `sinceUnix` (the start of a real gap, or a deepened read's floor) back past what the read
   * reached (`reachedBackTo`, null when it read nothing). `because` says what stopped it: the call
   * cap, the per-channel bound, the gap rule's 36-hour clamp, the hours a backfill was asked for, or
   * the anonymous door's window. Logged by name with the `ig:backfill` line that reads it.
   */
  unreadStretch?: { sinceUnix: number; reachedBackTo: number | null; because: UnreadBecause }
}

/** What stopped a read short of a stretch the channel is missing — see `ChannelOutcome.unreadStretch`. */
export type UnreadBecause = 'call-cap' | 'channel-bound' | 'catch-up-clamp' | 'backfill-hours' | 'anonymous-window'

export interface DetectionSummary {
  channels: ChannelOutcome[]
  postsSeen: number
  newPosts: number
  detected: number
  hadParseFailure: boolean
  hadError: boolean
  /** Set when the host is in an anonymous-read cooldown; the pass read nothing after it began. */
  throttledUntil: Date | null
  /** Channels this pass did not read because of that cooldown. */
  channelsUnread: number
  pagesFetched: number
  /**
   * What the automatic brand resolver did in this pass — lookups spent, prospects created,
   * and whether a throttle cut it short.
   *
   * Surfaced rather than logged, because a number that silently falls as the endpoint
   * degrades is exactly the failure this project keeps finding late. `haltedEarly` in
   * particular is the difference between "no new brands today" and "we have been blocked
   * and have found nothing since".
   */
  brandsResolved: AutoResolveSummary
  /**
   * Channels served by each door this pass (feedSource.ts). `graph` is 0 wherever the official
   * read is not configured — which is everywhere, until a person decides otherwise.
   */
  servedBy: Record<FeedSourceName, number>
  /**
   * The official read's calls this pass against its cap — present only where the fallback is
   * configured for this pass. `ig:backfill --run` prints it; the log line below says the same.
   */
  officialCalls?: { used: number; cap: number; dropped: number }
}

/**
 * THE OFFICIAL READ'S CALL CAP, PER PASS (15 Oct 2026). One call is one page of one channel, so
 * the steady state is one call a channel (~19 a pass); 60 leaves room for a gap that needs a
 * second page on most channels. STATED, NOT HIDDEN: at four passes an hour a full 60 every pass
 * would be 240 calls an hour against Meta's documented ~200 a user — the cap bounds a pass, and
 * a rate-limit answer (graphFeed.ts) is what bounds the hour. A channel the cap costs is counted
 * and logged, never silently dropped.
 */
export const GRAPH_MAX_CALLS_PER_PASS = 60
// AND IT IS PER `runDetection` CALL, NOT PER HOST (review, 15 Oct 2026): each call builds its own
// budget, and the 30-minute pause after a rate-limit answer lives in one PROCESS's memory. Passes
// that overlap — the 15-minute cron and an IST slot's catch-up collide four times a day, and the
// dashboard's "Check now" is a third caller in another process — each get their own 60. The
// rate-limit pause, not this number, is what bounds the hour when they do.

/**
 * How far back to look. The DEFAULT is the fast-cadence window; a catch-up pass after a
 * restart passes the longer one explicitly. See src/detection/cadence.ts for both, and
 * for why detection no longer runs on the sending schedule.
 */
export async function runDetection(
  opts: {
    lookbackHours?: number
    channelSpacingMs?: number
    role?: DetectionRole
    /**
     * `pnpm ig:backfill --hours N --run` ONLY (16 Oct 2026, officialReach.ts). Every channel's
     * OFFICIAL read reaches back N hours, ignoring the newest stored post, with the backfill's page
     * bound and its call cap (`GRAPH_BACKFILL_CALL_CAP`) in place of the pass's. The pass reads
     * through the official API ONLY (`officialOnly`, below): the anonymous door is neither deepened
     * nor asked. Storage is this pass's own: a backfilled post is persisted, judged and marked
     * incomplete exactly as any official read stores it — only the window asked for is stored.
     */
    officialBackfillHours?: number
    /**
     * `pnpm ig:backfill --channel <handle>` ONLY: read just these watched channels. A run the call
     * cap cut short is finished by naming its unfinished channels, because a bare re-run reads in
     * the same order and spends the same calls on the same head (officialReach.ts). A handle that
     * is not a watched channel is simply not read — the command refuses one before it gets here.
     */
    onlyChannels?: readonly string[]
  } = {},
): Promise<DetectionSummary> {
  const role: DetectionRole = opts.role ?? 'primary'
  const lookbackHours = opts.lookbackHours ?? DETECT_LOOKBACK_HOURS
  const backfillHours = opts.officialBackfillHours
  if (backfillHours !== undefined && !isValidBackfillHours(backfillHours)) {
    // A programming error, not an operator's: the command refuses a bad --hours before it gets here.
    throw new Error(`officialBackfillHours must be a whole number of hours from 1 to 168 (was ${String(backfillHours)})`)
  }
  if (backfillHours !== undefined && !(role === 'primary' && graphConfigured())) {
    // A backfill IS the official read; without it this would be a routine pass wearing the name.
    throw new Error('officialBackfillHours needs the official read: a primary pass with META_GRAPH_TOKEN and META_IG_USER_ID set')
  }
  // A restart must not forget a cooldown (pm2 recycles the worker on its memory ceiling),
  // or the pass resumes the exact hammering the cooldown exists to stop.
  await hydrateAnonGate()
  /**
   * Only channels we have chosen to WATCH.
   *
   * Reading a feed and messaging an account became separate decisions in Phase 7. Four
   * pages per target per slot is 16 requests at four channels — measured healthy, 48/48
   * HTTP 200 — and ~240 a slot once a provided prospect list lands, against an anonymous
   * endpoint whose only risk is IP rate limiting. A cold first touch does not need a hook
   * from the recipient's own feed, so that cost buys almost nothing.
   *
   * `watchEnabled` defaults TRUE, so every channel that was being read still is. It is
   * imported prospects that arrive unwatched, and turning one on is one toggle.
   */
  const targets = await prisma.targetAccount.findMany({
    // officialReach.ts holds the one definition, so `ig:backfill`'s dry run reads the same channels.
    where: opts.onlyChannels ? { ...WATCHED_CHANNEL_WHERE, handle: { in: [...opts.onlyChannels] } } : WATCHED_CHANNEL_WHERE,
    orderBy: { handle: 'asc' },
  })

  /**
   * ROTATE the start so a pass cut short by a throttle does not read the same alphabetical
   * head every time and never reach @viralbhayani. MEASURED 7 Sept 2026: under the throttle
   * the only channel ever fetched was one, and it was the same one all day.
   */
  const offset = targets.length > 0 ? passCounter++ % targets.length : 0
  const ordered = [...targets.slice(offset), ...targets.slice(0, offset)]
  /**
   * ONE page per channel in the steady state. Paging stops at the newest post we already
   * hold (plus a minute of overlap), so a channel whose 12 newest posts we have costs one
   * request. Only a channel with a real gap — nothing stored inside the lookback — pages
   * deeper. Volume is what earned the throttle; this roughly halves it.
   */
  const newestStored = new Map<string, number>()
  for (const row of await prisma.detectedCampaign.groupBy({ by: ['targetId'], _max: { postedAt: true } })) {
    const at = row._max.postedAt
    if (at) newestStored.set(row.targetId, Math.floor(at.getTime() / 1000))
  }
  // One clock reading for the pass, so the routine floor and the official reach agree on "now".
  const nowMs = Date.now()
  const nowUnix = Math.floor(nowMs / 1000)
  const floorUnix = Math.floor(hoursAgo(lookbackHours, new Date(nowMs)).getTime() / 1000)
  /**
   * ── AND POSTS THE OFFICIAL API STORED ARE REACHED BACK FOR (review, 15 Oct 2026) ─────────
   *
   * `newestStored` counts every row, including the ones the official read fallback stored — so
   * after a long stretch of the fallback the anonymous feed, back at last, would read one page and
   * stop at the newest of THEM, leaving every older one with no tags, no collaborators and an
   * @-less caption for good (a 22-hour stretch is ~57 @viralbhayani posts; one page is 12). So a
   * channel holding such rows inside THIS PASS's own lookback pages back to the oldest of them.
   *
   * Bounded by the window the pass already pages to for a channel with a real gap (the lookback,
   * plus fetchFeed's own 48-post / 6-page caps), and only while such rows exist: once the read
   * completes them they no longer match, and a dormant fallback has none, so the query finds
   * nothing and the pass is today's. One extra grouped query per pass. A row older than the
   * lookback stays incomplete — stated in docs/DEPLOY.md rather than chased forever, because a
   * post past the feed's reach would otherwise cost extra pages on every pass.
   */
  const oldestIncomplete = new Map<string, number>()
  for (const row of await prisma.detectedCampaign.groupBy({
    by: ['targetId'],
    where: { postedAt: { gte: new Date(floorUnix * 1000) }, rawPayload: { contains: EVIDENCE_INCOMPLETE_MARKER } },
    _min: { postedAt: true },
  })) {
    const at = row._min?.postedAt
    if (at) oldestIncomplete.set(row.targetId, Math.floor(at.getTime() / 1000))
  }
  const spacingMs = opts.channelSpacingMs ?? DETECT_CHANNEL_SPACING_MS
  let requestsMade = 0
  let throttledUntil: Date | null = null
  /**
   * A cooldown that ends a second after the cron fires would otherwise cost a whole extra
   * pass: the 15-minute steps and the 15-minute cron share a grid. MEASURED on the first
   * live pass — until=07:30:00.571Z against a cron at 07:30:00.000Z. If the gate reopens
   * within two minutes, wait for it; two minutes of patience against fifteen of blindness.
   */
  // A backfill reads only through the official API, so the anonymous cooldown is not worth waiting for.
  const early = anonGateCheck()
  if (!early.ok && backfillHours === undefined) {
    const waitMs = early.until.getTime() - Date.now()
    if (waitMs > 0 && waitMs <= GATE_REOPEN_WAIT_MAX_MS) {
      log.step('the anonymous-read cooldown ends shortly — waiting for it before reading', { waitSeconds: Math.ceil(waitMs / 1000) })
      await new Promise((r) => setTimeout(r, waitMs + 500))
    }
  }

  const channels: ChannelOutcome[] = []

  /**
   * THE OFFICIAL READ, PRIMARY ONLY (15 Oct 2026). The token lives on the server; a Mac's failover
   * pass must read exactly as it always has, so it never even asks whether the fallback exists.
   * `officialOn` is false on every host until a person configures it, and then every new branch
   * below is skipped — the pass is today's pass.
   */
  const allowGraph = role === 'primary'
  const officialOn = allowGraph && graphConfigured()
  // A backfill run has its own cap — one hour of Meta's documented budget (officialReach.ts).
  const callCap = backfillHours !== undefined ? GRAPH_BACKFILL_CALL_CAP : GRAPH_MAX_CALLS_PER_PASS
  const graphBudget: GraphBudget = { remaining: callCap, used: 0, dropped: 0 }
  const servedBy: Record<FeedSourceName, number> = { anonymous: 0, graph: 0 }
  /**
   * A BACKFILL ASKS THE OFFICIAL API ONLY (review, 16 Oct 2026). Trying the anonymous feed first
   * meant a backfill worked only while that feed was refused: the day it answers again, it would
   * serve every channel its routine 48 posts, nothing would be backfilled, and the dry run (which
   * reads through Business Discovery directly) would have predicted a run that never happens. The
   * anonymous door is not deepened by this — it is not asked at all, so no anonymous request is
   * spent; the worker's own passes read it as before. `officialOn` is true here by the check above.
   */
  const officialOnly = backfillHours !== undefined
  /** Record why the official read cannot serve a channel, with WHICH pause when it is paused. */
  const officialUnavailable = (outcome: ChannelOutcome, why: Exclude<OfficialReadAvailability, 'available'>): void => {
    outcome.officialUnavailable = why
    const cd = graphCooldown()
    if (why === 'paused' && !cd.open) outcome.officialPausedBy = cd.kind
  }

  let feedAliveStamped = false
  for (const target of ordered) {
    const outcome: ChannelOutcome = {
      handle: target.handle,
      fetched: 0,
      alreadyKnown: 0,
      stored: 0,
      campaigns: 0,
      unclassified: 0,
      organic: 0,
      officiallyPaid: 0,
      frameFlagged: 0,
      evidenceRefreshed: 0,
      pagesFetched: 0,
    }

    const gate = anonGateCheck()
    if (officialOnly) {
      // The gate is the anonymous door's and this pass does not use it. What can stop a channel
      // here is the official read itself — said as such, never as "Instagram is refusing anonymous
      // reads", which would be the wrong door's story and the wrong remedy.
      const official = officialReadAvailability({ allowGraph, graphBudget })
      if (official !== 'available') {
        if (official === 'cap-reached') graphBudget.dropped += 1
        officialUnavailable(outcome, official)
        outcome.error =
          official === 'cap-reached'
            ? `the official read's call cap (${callCap}) was spent before this channel — no request made`
            : official === 'paused'
              ? `the official read is paused on this host (${outcome.officialPausedBy ?? 'unknown'}) — no request made`
              : 'the official read is not usable by this pass — no request made'
        channels.push(outcome)
        continue
      }
    } else if (!gate.ok) {
      throttledUntil = gate.until
      /**
       * A closed anonymous gate is no longer the end of the channel when the official read can
       * serve it: `fetchChannelFeed` goes straight there without spending an anonymous request.
       * When it cannot (not configured, paused, cap spent — the cap counted in feedSource.ts),
       * this is exactly the skip it always was. `throttledUntil` keeps meaning the ANONYMOUS
       * cooldown either way; the official API's own pause never touches it.
       */
      const official = officialOn ? officialReadAvailability({ allowGraph, graphBudget }) : 'off'
      if (official !== 'available') {
        if (official === 'cap-reached') graphBudget.dropped += 1
        if (officialOn) officialUnavailable(outcome, official)
        // No request is made. Every remaining channel lands here until the cooldown ends.
        outcome.skipped = 'throttled'
        outcome.error = `throttled until ${gate.until.toISOString()}`
        channels.push(outcome)
        continue
      }
    }
    if (requestsMade > 0 && spacingMs > 0) {
      // Space channels out instead of a 19-request burst — bursts are what a throttle counts.
      await new Promise((r) => setTimeout(r, spacingMs + Math.floor(Math.random() * spacingMs)))
    }
    try {
      const newest = newestStored.get(target.id)
      const sinceUnix = Math.max(floorUnix, (newest ?? 0) - 60)
      const incomplete = oldestIncomplete.get(target.id)
      const completeSinceUnix = incomplete !== undefined && incomplete - 60 < sinceUnix ? incomplete - 60 : undefined
      /**
       * ── AND A GAP IS READ BACK THROUGH THE OFFICIAL DOOR (16 Oct 2026, officialReach.ts) ─────
       *
       * `sinceUnix` stops at the newest stored post, and for a channel with nothing stored inside the
       * lookback that is the lookback itself — so the first pass after a blind stretch read 6 hours
       * of it, and every later pass stopped at what that one stored. The official read pages back
       * through a channel's whole history, so for a REAL gap it reaches back to the newest stored
       * post (at most the 36-hour catch-up) with a larger page bound; `ig:backfill` reaches back N
       * hours on every channel. Official-only fields: the anonymous door's options below are the
       * routine ones in every case, and with the fallback off nothing is added at all.
       */
      const reach = officialOn ? officialReachFor({ sinceUnix, floorUnix, newestStoredUnix: newest, nowUnix, backfillHours }) : null
      requestsMade += 1
      /**
       * WHICH DOOR (feedSource.ts). With the official read not configured — or on a Mac's
       * failover, `allowGraph: false` — this is `fetchFeed` exactly: same request, same answer,
       * same error. The budget is the pass's, shared across channels.
       */
      const served = await fetchChannelFeed(target.handle, {
        maxPosts: 48,
        sinceUnix,
        ...(completeSinceUnix !== undefined ? { completeSinceUnix } : {}),
        ...(reach ?? {}),
        ...(officialOnly ? { officialOnly: true } : {}),
        allowGraph,
        graphBudget,
      })
      const { posts, pagesFetched } = served
      outcome.fetched = posts.length
      outcome.pagesFetched = pagesFetched
      outcome.servedBy = served.source
      servedBy[served.source] += 1
      if (served.source === 'graph') {
        // Kept loud: a channel read through the official API carries no tag evidence, and the
        // reason the anonymous feed did not serve it is the outage worth reading in the log.
        log.warn('read through the official API instead of the anonymous feed', {
          handle: target.handle,
          because: served.fallbackReason ?? 'unknown',
          posts: posts.length,
          ...(reach ? { reachingBackTo: new Date(reach.officialSinceUnix * 1000).toISOString() } : {}),
        })
        if (reach) {
          const result = officialShortfall(served, reach, graphBudget.remaining)
          outcome.officialReach = { sinceUnix: reach.officialSinceUnix, ...result }
        }
      }
      /**
       * ── NO SILENT CAPS: A STRETCH THIS READ KNOWS IT LEFT UNREAD IS NAMED (review, 16 Oct 2026) ──
       *
       * What this channel is missing starts at the older of the deepened official floor and the start
       * of a real gap. A read can stop before it in four ways — the call cap, the per-channel bound,
       * the gap rule's own 36-hour clamp (a gap 50 hours old is read back 36), or the anonymous door's
       * window when IT served a gapped channel (it is never deepened) — and every one leaves the OLDEST
       * part, which no later pass can see once the newest posts are stored. `unreadStretch` is exact
       * about it: a read that got past the gap's start, or read the whole feed, names nothing, so a
       * dormant channel is not named every fifteen minutes. Only where the official read is configured
       * (the remedy is `ig:backfill`, which needs it), and the remedy is the DRY RUN for this channel —
       * it prints the line that stores, after a person has seen what it would read.
       */
      const gapStart = officialOn ? gapStartUnix(newest, floorUnix) : null
      const wantedUnix =
        served.source === 'graph' && reach ? Math.min(reach.officialSinceUnix, gapStart ?? Number.POSITIVE_INFINITY) : served.source === 'anonymous' ? gapStart : null
      const stretch = wantedUnix !== null ? unreadStretch(served, wantedUnix) : null
      if (wantedUnix !== null && stretch) {
        const short = outcome.officialReach && !outcome.officialReach.reached ? outcome.officialReach.short : null
        const because: UnreadBecause =
          served.source === 'anonymous'
            ? 'anonymous-window'
            : short ?? (backfillHours !== undefined ? 'backfill-hours' : 'catch-up-clamp')
        outcome.unreadStretch = { sinceUnix: wantedUnix, reachedBackTo: stretch.oldestUnix, because }
        // How far back the official read was sent, in whole hours — the clamp it met, said as a number.
        const readHours = reach ? Math.round((nowUnix - reach.officialSinceUnix) / 3600) : 0
        const said: Record<UnreadBecause, string> = {
          'call-cap': `the official read's call cap (${callCap}) was spent`,
          'channel-bound': `the per-channel bound (${reach?.officialMaxPosts ?? 0} posts)`,
          'catch-up-clamp': `the gap is older than the ${readHours} hours the automatic rule reads back (the ${DETECT_CATCHUP_LOOKBACK_HOURS}-hour catch-up, or the pass's own lookback)`,
          'backfill-hours': `the gap is older than the ${readHours} hours this backfill read back`,
          'anonymous-window': 'the anonymous feed served it, and its read is never deepened (a 48-post window)',
        }
        log.warn('part of what this channel is missing was not read — the oldest part of that stretch is unread', {
          handle: target.handle,
          missingSince: new Date(wantedUnix * 1000).toISOString(),
          reachedBackTo: stretch.oldestUnix !== null ? new Date(stretch.oldestUnix * 1000).toISOString() : 'nothing',
          because: said[because],
          // As of the pass's clock: run later, add the hours since, or the oldest end stays unread.
          remedy: `pnpm ig:backfill --hours ${hoursBackTo(wantedUnix, nowUnix)} --channel ${target.handle} (as of ${new Date(nowMs).toISOString()}; add the hours since)`,
        })
      }
      // THE PASS SAYS IT IS ALIVE ON ITS FIRST PAGE, NOT ONLY AT ITS END (8 Sept 2026). `detectFeedOkAt`
      // was stamped by recordDetectionOutput when the pass FINISHED, so a slow pass — 30 minutes on 8
      // Sept while OCR crawled on a squeezed box — looked to the Mac's failover exactly like a blind
      // server (its threshold is 20 minutes), and the Mac re-read and re-judged the same channels.
      // One cheap write per pass, primary only: a failover pass must not speak for the server.
      //
      // A page with NO posts does not stamp it (review, 15 Oct 2026): "HTTP 200 with no posts in it"
      // is an outage shape, and a pass whose every channel answered empty used to keep this stamp
      // fresh — detection read as healthy while it read nothing, and the empty-feed sentence on the
      // landing page could never appear. A real watched channel always has posts.
      if (role === 'primary' && pagesFetched > 0 && posts.length > 0 && !feedAliveStamped) {
        feedAliveStamped = true
        const value = new Date().toISOString()
        void prisma.setting
          .upsert({ where: { key: DETECT_FEED_OK_KEY }, update: { value }, create: { key: DETECT_FEED_OK_KEY, value } })
          .catch(() => undefined)
      }

      if (posts.length === 0) {
        // The endpoint returned 200 with nothing. Either the account is empty or
        // the response shape changed — both warrant a shout, because "0 posts" is
        // indistinguishable from "quiet day" downstream.
        outcome.parseFailure = true
        log.alarm('feed returned zero posts — shape change or blocked', { handle: target.handle })
        channels.push(outcome)
        continue
      }

      const known = await prisma.detectedCampaign.findMany({
        where: { shortcode: { in: posts.map((p) => p.shortcode) } },
        /**
         * The stored EVIDENCE comes back with the shortcode, so a re-observation can tell
         * whether anything actually moved. Two extra columns on a query that already runs
         * every pass; no extra round trip.
         */
        select: { shortcode: true, taggedAccounts: true, rawPayload: true, verdictSource: true, humanLabel: true },
      })
      const knownSet = new Set(known.map((k) => k.shortcode))
      const storedByShortcode = new Map(known.map((k) => [k.shortcode, k]))
      outcome.alreadyKnown = knownSet.size

      /**
       * ── A POST THE OFFICIAL API STORED IS JUDGED AGAIN WHEN THE FEED SHOWS IT WHOLE ──────────
       * (review, 15 Oct 2026)
       *
       * The official API serves a post with no tags, no collaborators, no sponsors, no paid flag —
       * and, per Meta's documentation (not yet seen in a real answer), a caption with every @
       * removed. Its verdict and brands were formed from that, and refreshing only the tag column
       * would leave the caption mention-less and the verdict and brands as they were, for good: the
       * caption is written only on create. So when the ANONYMOUS feed returns such a post, it goes
       * through the fresh path below — the same judging, the same `persist` — and `persist`'s update
       * branch rewrites caption, brands, tags, payload and verdict from the complete read.
       *
       * Never a post a person has labelled: a human answer outranks any model, so that row only has
       * its evidence completed (the known-post loop below). Bounded by what the pass fetched — each
       * such post costs the classifier calls it would have cost had the anonymous feed served it.
       */
      const rejudge = new Set(
        posts
          .filter((p) => {
            const stored = storedByShortcode.get(p.shortcode)
            return (
              !p.evidenceIncomplete &&
              stored !== undefined &&
              (stored.rawPayload ?? '').includes(EVIDENCE_INCOMPLETE_MARKER) &&
              stored.humanLabel === null &&
              stored.verdictSource !== 'human'
            )
          })
          .map((p) => p.shortcode),
      )

      /**
       * A BACKFILL STORES WHAT IT WAS ASKED FOR (review, 16 Oct 2026). Business Discovery returns its
       * whole last page, so a read to `now - N h` also hands back up to a page of posts older than
       * that — and each one stored is a frame read and two classifier calls on a 961 MB box. The dry
       * run counts the window; the run stores the window, so the two agree. A routine read keeps every
       * post it fetched, as always (older posts on its last page are mostly known anyway).
       */
      const backfillFloor = officialOnly && served.source === 'graph' && reach ? reach.officialSinceUnix : null
      const beyondBackfill = (p: FeedPost) => backfillFloor !== null && Math.floor(p.postedAt.getTime() / 1000) < backfillFloor
      const fresh = posts.filter((p) => (!knownSet.has(p.shortcode) || rejudge.has(p.shortcode)) && !beyondBackfill(p))
      const beyond = posts.filter((p) => !knownSet.has(p.shortcode) && beyondBackfill(p)).length
      if (beyond > 0) log.step('posts older than the backfill window were read on its last page and not stored', { handle: target.handle, posts: beyond })
      const detector = getDetector(target.detectorKey)

      /**
       * KNOWN posts can still be missing their FRAME — everything detected before the
       * frame store existed (2026-08-07), plus any save that failed. This re-observation
       * carries the only thumbnail URL that is still alive, so bank the bytes now:
       * `saveFrame` is idempotent (a frame already on disk costs one stat()) and never
       * throws. This is how `DbtNU9UzWYU`'s class of post stays re-examinable after its
       * CDN URL rotates — the corpus keeps the evidence, not a pointer to it.
       *
       * ── AND THE TAGS ARE REFRESHED HERE, FOR THE SAME REASON THE FRAME IS ──
       *
       * Tags and collaborators are stored at first sighting and were never looked at
       * again, because `persist` is reached only for posts in `fresh`. A publisher can add
       * a brand tag AFTER posting — that is an ordinary thing for a paid placement whose
       * paperwork lands late — and until now that edit was invisible to us forever.
       *
       * `evidenceRefresh` is PURE and returns null when nothing moved, which is nearly
       * always. Without that comparison this loop would write ~18,000 rows a day to record
       * that nothing had happened. A change is LOGGED, because a row that rewrites itself
       * with no explanation is a row nobody can audit — and because a tag appearing on a
       * post we already judged ORGANIC is exactly the event worth seeing.
       */
      for (const post of posts) {
        const stored = storedByShortcode.get(post.shortcode)
        // A post being re-judged is written whole by `persist` in the fresh loop, frame included.
        if (!stored || rejudge.has(post.shortcode)) continue
        await saveFrame(post.shortcode, post.thumbnailUrl)

        // A post the OFFICIAL API served reports no tags at all, and comparing that would erase
        // the real ones — `evidenceRefresh` returns null for it by its own first line (the one
        // comparison, so the one guard; tests/official-read-pipeline.test.ts drives it here).
        const refreshed = evidenceRefresh(stored, post, new Date())
        if (!refreshed) continue
        await prisma.detectedCampaign.update({
          where: { shortcode: post.shortcode },
          data: {
            taggedAccounts: refreshed.taggedAccounts,
            rawPayload: refreshed.rawPayload,
            // A labelled post the official API stored: its caption came without its @mentions, and the
            // complete one is evidence the person's answer does not depend on — so it is written too.
            ...(refreshed.changed.includes('completed') ? { caption: post.caption } : {}),
          },
        })
        outcome.evidenceRefreshed += 1
        log.step('a stored post changed its own evidence', {
          shortcode: post.shortcode,
          handle: target.handle,
          changed: refreshed.changed.join(', '),
        })
      }

      /**
       * The channel's own hashtag history, so stage 1 can tell "unusual for THIS
       * channel" from "unusual in general". Built from everything stored for this
       * target — which is exactly what the 690-post corpus was accumulated for.
       *
       * Only for the semantic detector; the rule-based ones ignore it. Cleared in the
       * `finally` so one channel's vocabulary can never be applied to another's posts.
       */
      if (detector.key === 'semantic') {
        const captions = await prisma.detectedCampaign.findMany({
          where: { targetId: target.id },
          select: { caption: true },
        })
        setChannelVocabulary(buildVocabulary(captions.map((c) => c.caption)))
      }

      for (const post of fresh) {
        /**
         * SAVE THE COVER FRAME FIRST — before classification, because the classifier now
         * READS it (src/detection/ocr.ts runs local OCR and hands the frame's text to the
         * same model that reads the caption). Ordering these the other way round would
         * leave every first sighting judged on its caption alone, and a post is only
         * classified once.
         *
         * It is also the only reliable moment to save it at all: the thumbnail is a CDN URL
         * with a lifetime, and a post that scrolls out of the feed window can never be
         * re-fetched. Saved for EVERY channel, including the ones whose frames are never
         * used for a verdict — @madovermarketing_mom's disclosed posts are exactly the
         * labelled set any measurement of frame reading has to be built from.
         *
         * `saveFrame` never throws: a frame that fails to save costs one piece of evidence,
         * never a detection pass.
         */
        await saveFrame(post.shortcode, post.thumbnailUrl)

        /**
         * The per-post model inputs, built ONCE here and handed UNCHANGED to the detector's
         * caption call and to `judgeWithFrame`'s frame call — see `modelInputsFor`. The
         * Setting is read per post, like everywhere else in detection, so flipping it takes
         * effect on the next post rather than at the next restart.
         */
        const settings = await getSettings()
        const inputs = await modelInputsFor(post, target, settings.publisherAsContext)

        // Awaited: the semantic detector calls a model. Rule detectors return
        // synchronously and `await` on a non-promise costs a microtask.
        const cls = await detector.classify(post, inputs)

        // Instagram's own Paid Partnership label overrides any heuristic. Neither
        // Phase 1 target uses it today, but when one does this becomes the truth.
        const officiallyPaid = post.isPaidPartnership
        if (officiallyPaid) outcome.officiallyPaid += 1

        const captionVerdict = officiallyPaid ? 'CAMPAIGN' : cls.verdict
        const confidence = officiallyPaid ? 100 : cls.confidence
        const captionSignals = officiallyPaid ? [...cls.signals, 'official:is_paid_partnership'] : cls.signals

        /**
         * NOW READ THE FOOTAGE — and this is the fix for a feature that was built and
         * then never ran.
         *
         * MEASURED 2026-08-08: 166 posts detected that day had a cover frame sitting on
         * disk that nothing had read. This loop saved the frame (above) and classified
         * the CAPTION ALONE, while the only frame-aware code lived in
         * `scripts/ocr.ts --reclassify`. So the Thane class of paid post — the entire
         * reason the OCR work exists — was still being missed in normal operation, and
         * `DbtNU9UzWYU` was escalated only because a person ran a command by hand.
         *
         * `judgeWithFrame` is the ONE judging path, shared with the backfill and the
         * classify CLI. It decides on its own whether a call is worth making (retired
         * target, unsupported detector, a caption verdict a frame cannot move) and the
         * footage may only ever raise ORGANIC to CAMPAIGN.
         *
         * It is also the ONLY place the footage is read. The semantic detector had its own
         * frame stage until 2026-10-09 — so an ORGANIC post was read twice and judged with
         * the frame twice, and the detector's copy never stripped the publisher's own
         * watermark, so `cls.verdict` arrived here already escalated on @filmygyan's logo and
         * this call returned 'caption-decisive' without running its strip at all.
         */
        const judged = await judgeWithFrame(
          {
            shortcode: post.shortcode,
            caption: post.caption,
            /**
             * Retired channels still get their FRAME SAVED above — those are the labelled
             * set any future measurement is built from — but not a classifier call.
             * MEASURED: 64% of OCR runs were against our own retired pages.
             */
            optedOut: target.optedOut,
            /* Whose post this is — a publisher's own watermark is not evidence about it. */
            publisher: { handle: target.handle, displayName: target.displayName },
            publisherAsContext: settings.publisherAsContext,
            // judge.ts owns what each detector permits — including the M.O.M second look.
            detectorKey: detector.key,
            /**
             * The SAME tag and publisher blocks the caption verdict was reached with — the
             * very strings the detector was handed above, not a second construction of them —
             * so the frame call differs from the caption call in exactly one thing, the
             * frame, which is what `applyFrameSignal` is about to attribute the difference to.
             * The M.O.M second look uses them too, so its caption call matches as well.
             */
            tagText: inputs.tagText,
            publisherText: inputs.publisherText,
          },
          captionVerdict,
        )

        const verdict = judged.verdict
        const signals = [...captionSignals, ...judged.signals]
        if (judged.secondLook) {
          log.step('the second look re-judged a rule-negative', {
            shortcode: post.shortcode,
            channel: target.handle,
            verdict,
          })
        }
        if (judged.changedByFrame) {
          outcome.frameFlagged += 1
          log.step('the footage changed the answer', {
            shortcode: post.shortcode,
            from: captionVerdict,
            to: verdict,
            footage: judged.frameSummary ?? '',
          })
        }

        const brands = dedupe([
          ...post.sponsorHandles.map((h) => `@${h}`),
          ...post.collabHandles.map((h) => `@${h}`),
          ...cls.brands,
          // Caption-derived only: the second look's caption call may name brands, its
          // frame call never does — "brands come from the caption-only call, always".
          ...(judged.secondLook?.brands ?? []),
        ])

        // A re-judged official-API post is not a NEW post: it was counted when it was stored, and
        // counting it again would inflate `newPosts`/`detected`. It is an evidence refresh.
        const completing = rejudge.has(post.shortcode)
        if (completing) {
          outcome.evidenceRefreshed += 1
          log.step('a post the official API stored was read whole by the feed — judged again', {
            shortcode: post.shortcode,
            handle: target.handle,
            verdict,
          })
        } else if (verdict === 'CAMPAIGN') outcome.campaigns += 1
        else if (verdict === 'UNCLASSIFIED') outcome.unclassified += 1
        else outcome.organic += 1

        await persist(target.id, post, verdict, judged.secondLook?.confidence ?? confidence, signals, brands, {
          // Instagram's own label is a fact, not a judgement, so it is recorded as
          // 'rules' regardless of which detector ran. When the SECOND LOOK ran, the
          // verdict is the model's and the row must say so — filing a semantic answer
          // under 'rules' would make it label-grade for every future measurement.
          verdictSource: officiallyPaid ? 'rules' : judged.secondLook ? 'semantic' : cls.verdictSource,
          classifierModel: judged.secondLook ? 'deepseek-v4-flash' : (cls.classifierModel ?? null),
          classifierReason: judged.secondLook?.reason ?? cls.classifierReason ?? null,
          taggedAccounts: post.taggedAccounts ?? [],
          /**
           * What the footage said, from the ONE writer of that sentence
           * (`frameTextSummaryLine`). The screen and the stored record must not be able to
           * describe the same evidence differently — and no detector reads the footage any
           * more, so there is nothing else to fall back to.
           */
          frameText: judged.frameText ?? null,
        })
        if (!completing) outcome.stored += 1
      }

      log.info('channel done', {
        handle: target.handle,
        detector: detector.key,
        fetched: posts.length,
        new: outcome.stored,
        campaigns: outcome.campaigns,
        officiallyPaid: outcome.officiallyPaid,
        ...(served.source === 'graph' ? { source: 'official API' } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.error = message
      if (err instanceof GraphFeedError) {
        /**
         * THE OFFICIAL READ FAILED TOO — first, because a GraphFeedError IS a FeedFetchError and
         * the branches below would misfile it: its `isThrottle` is the official API's pause, and
         * reading it as the anonymous one would write that pause into `detectThrottledUntil`.
         */
        const anonymous = err.anonymousError?.message ?? null
        outcome.error = anonymous ? `${anonymous}; then ${message}` : message
        outcome.officialFailure = err.graphKind
        if (err.graphKind === 'paused' || err.graphKind === 'cap-reached') officialUnavailable(outcome, err.graphKind)
        if (err.isParseFailure) {
          outcome.parseFailure = true
          log.alarm('the official API answered in a shape the reader does not expect', { handle: target.handle, message, anonymous })
        } else if (err.isThrottle) {
          outcome.skipped = 'official-rate-limited'
        } else {
          log.error('channel failed', { handle: target.handle, error: message, anonymous })
        }
      } else if (err instanceof FeedFetchError && err.isParseFailure) {
        outcome.parseFailure = true
        log.alarm('feed shape changed — detection is blind until fixed', { handle: target.handle, message })
      } else if (err instanceof FeedFetchError && err.isThrottle) {
        // The gate has already alarmed once; here we only record that this channel was cut.
        outcome.skipped = 'throttled'
        throttledUntil = err.until
      } else {
        log.error('channel failed', { handle: target.handle, error: message })
      }
      /**
       * An anonymous failure the official read could not catch — gate open, the feed refused, and the
       * fallback was paused or its cap spent (feedSource.ts rethrows then). Say which, as the closed-
       * gate branch above does, or the channel reads as a bare "throttled" and `ig:backfill` has
       * nothing to name.
       */
      if (officialOn && !(err instanceof GraphFeedError)) {
        const official = officialReadAvailability({ allowGraph, graphBudget })
        if (official !== 'available') officialUnavailable(outcome, official)
      }
    } finally {
      // Never let one channel's vocabulary leak into the next channel's scoring.
      setChannelVocabulary(null)
    }

    /**
     * With the official read on, an anonymous refusal no longer ENDS a channel in the throttle
     * branch above (the channel went to the official API instead), so the anonymous cooldown is
     * read off the gate itself — the same value that branch would have recorded.
     */
    if (officialOn) {
      const after = anonGateCheck()
      if (!after.ok) throttledUntil = after.until
    }

    channels.push(outcome)
  }

  if (officialOn && (servedBy.graph > 0 || graphBudget.dropped > 0)) {
    log.info('detection pass sources', { servedBy, officialCalls: graphBudget.used, officialCallCap: callCap })
  }
  if (graphBudget.dropped > 0) {
    // NO SILENT CAPS: the channels the cap cost, by count, every pass it happens.
    log.warn('the official read call cap was reached this pass — some channels were not read through it', {
      cap: callCap,
      channelsNotRead: graphBudget.dropped,
    })
  }
  const officialCalls = officialOn ? { officialCalls: { used: graphBudget.used, cap: callCap, dropped: graphBudget.dropped } } : {}

  /**
   * RESOLVE THE BRANDS IN WHAT WE JUST CLASSIFIED — the step that makes brand discovery
   * something that RUNS rather than something a command can do.
   *
   * After classification, deliberately: a CAMPAIGN verdict written moments ago is what makes
   * its caption's @mentions worth a lookup, and `autoResolveBrands` reads the verdict from
   * the database rather than from this loop's state.
   *
   * NEVER FATAL. Detection must never gate on brand resolution — decision 5 in CLAUDE.md is
   * that a monitoring subsystem must not be able to silence the thing it monitors, and the
   * same reasoning applies one layer along: a scarce third-party endpoint failing must not
   * cost us the posts we already read and stored. Every lookup is cached UNKNOWN and the
   * next pass retries.
   */
  const pagesFetched = channels.reduce((n, c) => n + c.pagesFetched, 0)
  // Only pages that carried posts prove a read — see the first-page stamp above.
  const pagesWithPosts = channels.filter((c) => c.fetched > 0).reduce((n, c) => n + c.pagesFetched, 0)
  const channelsUnread = channels.filter((c) => c.skipped === 'throttled').length
  if (channelsUnread > 0) {
    log.alarm('detection halted early — Instagram is refusing anonymous reads from this host', {
      channelsUnread,
      channelsRead: channels.length - channelsUnread,
      resumesAt: throttledUntil?.toISOString() ?? 'unknown',
    })
  }
  await recordDetectionOutput({ pagesWithPosts, throttledUntil, role })
  /**
   * A FAILOVER pass (an operator's Mac reading because the server cannot) stops here: brand
   * discovery and the frame re-judge run on that machine's own timers already, and the
   * evidence they need — frames on disk, a classifier key — is the server's. Doubling the
   * lookups from a home IP is how that IP gets throttled too.
   */
  if (role === 'failover') {
    return {
      channels,
      throttledUntil,
      channelsUnread,
      pagesFetched,
      postsSeen: channels.reduce((n, c) => n + c.fetched, 0),
      newPosts: channels.reduce((n, c) => n + c.stored, 0),
      detected: channels.reduce((n, c) => n + c.campaigns, 0),
      hadParseFailure: channels.some((c) => c.parseFailure === true),
      hadError: channels.some((c) => c.error !== undefined),
      brandsResolved: { looked: 0, decided: 0, skippedUnsure: 0, haltedEarly: false, unreached: 0, backingOff: 0, awaitingRetry: 0 },
      servedBy,
      ...officialCalls,
    }
  }
  const brandsResolved = await autoResolveBrands().catch((err): AutoResolveSummary => {
    log.warn('brand auto-resolve failed — next pass retries', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      looked: 0,
      decided: 0,
      skippedUnsure: 0,
      haltedEarly: false,
      unreached: 0,
      backingOff: 0,
      awaitingRetry: 0,
    }
  })

  /**
   * ── AND EVIDENCE THAT WAS READ BUT NEVER REACHED A VERDICT (repair plan 6.4) ─────────
   *
   * MEASURED: 65 in-window posts carry `frame:call-failed` — the footage was read, the
   * words extracted, and the classifier call that would have folded them in failed. Correct
   * at the time (*a failed call is never recorded as a verdict*), and wrong forever after,
   * because nothing tried again. Bounded per pass, never overriding a human answer, and
   * only ever through `judgeWithFrame` so the permission table still applies.
   *
   * Caught separately from the brand resolver and from detection itself: this is the least
   * urgent thing in the pass, and a post that scrolls out of the feed window can never be
   * re-scraped, so it must not be able to take the run down with it.
   */
  const rejudged = await rejudgeUnusedEvidence().catch((err): RejudgeSummary => {
    log.warn('re-judging unused evidence failed — next pass retries', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { examined: 0, changed: 0, remaining: 0, skippedNoEvidence: 0, skippedCallFailed: 0, proposals: [] }
  })
  // `remaining` is in the condition too: a drained backlog must go quiet, and a STUCK one
  // must not — examined=0 with remaining>0 is the state worth a line.
  if (rejudged.examined > 0 || rejudged.remaining > 0) {
    log.info('re-judged evidence read earlier', {
      examined: rejudged.examined,
      changed: rejudged.changed,
      // Named, because "examined 10, changed 0" on a host with no frame store is a
      // different fact from "examined 10, changed 0" on the host that has them.
      //
      // TWO NUMBERS, NOT ONE. This line used to print `noFrameHere` for BOTH skip reasons,
      // and on 2026-08-17 it read `noFrameHere=10 remaining=83` on the very host holding
      // all 83 frames — a counter asserting a cause that was false, which sent a diagnosis
      // through the OCR engine, the frames directory and the API key before the real cause
      // (the classifier was never asked) turned up. A number that names a reason must be
      // true about that reason.
      noFrameHere: rejudged.skippedNoEvidence,
      callDidNotAnswer: rejudged.skippedCallFailed,
      remaining: rejudged.remaining,
    })
  }

  /**
   * `awaitingRetry` is in the CONDITION as well as the body, deliberately: a pass that looked
   * at nothing because every candidate is backing off is precisely the state worth a line, and
   * `looked > 0` alone would render it as silence — the same shape as a stale latch reporting
   * nothing four times an hour.
   */
  if (
    brandsResolved.looked > 0 ||
    brandsResolved.awaitingRetry > 0 ||
    brandsResolved.backingOff > 0 ||
    brandsResolved.unreached > 0
  ) {
    /**
     * `unreached` and `backingOff` are in the CONDITION as well as the body, for the same
     * reason `awaitingRetry` already was: the state worth a line is a pass that looked at
     * almost nothing because a queue is stuck behind a halt, and `looked > 0` alone rendered
     * exactly that as `looked=1 haltedEarly=true` — four times an hour, for hours, while one
     * handle held the head of the queue and nothing else was ever asked about.
     */
    log.info('brand auto-resolve', {
      looked: brandsResolved.looked,
      created: brandsResolved.decided,
      needsAHuman: brandsResolved.skippedUnsure,
      // Eligible and not asked about this pass. A halt with a backlog behind it is a
      // problem; a halt with nothing behind it is an ordinary quiet pass.
      unreached: brandsResolved.unreached,
      backingOff: brandsResolved.backingOff,
      awaitingRetry: brandsResolved.awaitingRetry,
      haltedEarly: brandsResolved.haltedEarly,
    })
  }

  return {
    channels,
    throttledUntil,
    channelsUnread,
    pagesFetched,
    postsSeen: channels.reduce((n, c) => n + c.fetched, 0),
    newPosts: channels.reduce((n, c) => n + c.stored, 0),
    detected: channels.reduce((n, c) => n + c.campaigns, 0),
    hadParseFailure: channels.some((c) => c.parseFailure === true),
    hadError: channels.some((c) => c.error !== undefined),
    brandsResolved,
    servedBy,
    ...officialCalls,
  }
}

/**
 * Who is running the pass. The PRIMARY is the server's worker; a FAILOVER pass is an
 * operator's Mac reading because the server cannot (src/detection/failover.ts). The
 * distinction matters for one write: `detectThrottledUntil` describes the SERVER's cooldown
 * and only the server may set or clear it — a Mac writing its own cooldown there would tell
 * the dashboard the wrong host's story, and a Mac clearing it would hide a server still
 * being refused, which is exactly the condition that makes the Mac's reading necessary.
 */
export type DetectionRole = 'primary' | 'failover'

/** Rotates the channel order between passes — see the note in `runDetection`. */
let passCounter = 0

/** Gap between channel fetches within one pass, plus up to the same again as jitter. */
export const DETECT_CHANNEL_SPACING_MS = 2500

/** Wait for a cooldown that ends this soon rather than skipping the pass — see `runDetection`. */
export const GATE_REOPEN_WAIT_MAX_MS = 2 * 60_000

/**
 * What the dashboard reads to tell "the pass ran" from "the pass READ something".
 * `detectLastOkAt` is stamped when the pass does not throw, and a pass refused on every
 * channel does not throw — that is how three blind days looked healthy (4-7 Sept 2026).
 * Best-effort like every other stamp: recording output must never fail the pass.
 */
async function recordDetectionOutput(input: {
  /** Pages that carried at least one post. An all-empty pass is not a read (see the first-page stamp). */
  pagesWithPosts: number
  throttledUntil: Date | null
  role: DetectionRole
}): Promise<void> {
  const writes: Promise<unknown>[] = []
  if (input.pagesWithPosts > 0) {
    const value = new Date().toISOString()
    writes.push(
      prisma.setting.upsert({ where: { key: DETECT_FEED_OK_KEY }, update: { value }, create: { key: DETECT_FEED_OK_KEY, value } }),
    )
  }
  if (input.role !== 'primary') {
    // A failover pass reports what it READ and nothing about the server's cooldown.
  } else if (input.throttledUntil) {
    const value = input.throttledUntil.toISOString()
    writes.push(
      prisma.setting.upsert({ where: { key: DETECT_THROTTLED_KEY }, update: { value }, create: { key: DETECT_THROTTLED_KEY, value } }),
    )
  } else {
    writes.push(prisma.setting.deleteMany({ where: { key: DETECT_THROTTLED_KEY } }))
  }
  await Promise.all(writes.map((w) => w.catch(() => undefined)))
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const k = v.toLowerCase().replace(/^[@#]/, '')
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out.slice(0, 6)
}

async function persist(
  targetId: string,
  post: FeedPost,
  verdict: string,
  confidence: number,
  signals: string[],
  brands: string[],
  provenance: {
    verdictSource: string
    classifierModel: string | null
    classifierReason: string | null
    taggedAccounts: string[]
    /** What OCR read off the cover frame, or null when no frame was read. */
    frameText: string | null
  },
): Promise<void> {
  const data = {
    targetId,
    permalink: post.permalink,
    postedAt: post.postedAt,
    caption: post.caption,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    mediaType: post.mediaType,
    brands: writeStringArray(brands),
    signals: writeStringArray(signals),
    confidence,
    verdict,
    verdictSource: provenance.verdictSource,
    classifierModel: provenance.classifierModel,
    classifierReason: provenance.classifierReason,
    taggedAccounts: writeStringArray(provenance.taggedAccounts),
    /**
     * MEDIA URLS ARE STORED HERE, and the reason is that they EXPIRE.
     *
     * `rawPayload` rather than new columns, deliberately: this is captured evidence about
     * one observation, it is not queried, and no guard reads it — exactly what this
     * column already holds.
     *
     * ── AND THE URL IS NOT THE EVIDENCE. THE BYTES ARE ─────────────────────
     *
     * This docblock used to claim these URLs were "REFRESHED on every re-observation", so
     * that "the newest sighting carries the only ones still fetchable". THAT WAS NEVER
     * TRUE. `persist` is reached only from `for (const post of fresh)`, and `fresh`
     * excludes every shortcode already stored — so the `update:` branch below has never
     * run for a re-observed post in normal operation, and the refresh never happened.
     * MEASURED on the live database: 48 of 1,310 in-window posts hold a thumbnail URL,
     * while 156 frames are on disk. The claim was "verified" by checking that NEW posts
     * carried URLs, which cannot test a claim about re-observation.
     *
     * That is why the frame is now saved as BYTES at scrape time
     * (`src/detection/media.ts`), before classification, on every channel. A stored URL is
     * a promise that something else will still be there later; the file is the evidence.
     * The URLs stay because they cost nothing and record what the CDN offered.
     *
     * The SHAPE is built by `buildRawPayload` (src/detection/evidence.ts) rather than
     * inline here, because the known-post loop now refreshes this same payload when a
     * publisher edits its tags — and two object literals producing one shape is exactly
     * how the seven keys and the `taggedAccounts` column came to disagree.
     */
    rawPayload: buildRawPayload(post, new Date()),
    frameText: provenance.frameText,
  }

  await prisma.detectedCampaign.upsert({
    where: { shortcode: post.shortcode },
    /**
     * NOT DEAD CODE, and this was measured before anyone deleted it: the update branch
     * fired 16 times on 2026-08-07 alone.
     *
     * Callers filter known shortcodes out before getting here, so it looks unreachable —
     * but the four IST slots run detection at minute 0, always a multiple of 15, so they
     * COLLIDE with the 15-minute detect cron four times a day. `noOverlap` is per-task and
     * the slot lock is slot-vs-slot, so nothing stops the two overlapping; both passes
     * compute their known-set before either writes, both see a post as fresh, and the
     * loser lands here. This branch is the reconciler that makes that safe, which is also
     * why `pnpm ig:detect` alongside the scheduler is safe.
     *
     * Never overwrites a human's REVIEW-queue label.
     *
     * `taggedAccounts` is in here now. It was the one captured field the reconciler left
     * behind, so a post that landed on this branch kept whichever tags the losing pass had
     * — a silent, invisible divergence between the column and the payload beside it.
     *
     * The judgement's PROVENANCE (`verdictSource`, model, reason) and the caption are written with
     * the verdict now (review, 15 Oct 2026): writing a verdict without its source left rows reading
     * `verdictSource: 'rules'` beside a model's answer, and the caption is what a re-judge of a post
     * the official API stored exists to replace (see the fresh-path note in `runDetection`).
     *
     * ── AND NOTHING BUT THE COUNTS FROM A POST THE OFFICIAL API SERVED (15 Oct 2026) ───────
     *
     * Its tags, collaborators and sponsors are EMPTY because the API does not report them, its
     * caption has no @mentions, its paid flag is a placeholder, and a carousel has no frame — so
     * its verdict, brands, signals and frame text were all formed from LESS evidence than the row
     * may already hold. This branch is reached routinely, not only in the slot/cron collision: while
     * the server reads through the API it still records the anonymous cooldown, which starts the
     * Mac's failover, so the two read the same channels in the same quarter-hour and either can
     * persist second. An incomplete read landing second must never downgrade a complete row (a
     * Mac's paid CAMPAIGN to a caption-only verdict, its frame text to null), so it updates the
     * like and comment counts and nothing else. MUTATION (applied by hand, saw red, restored):
     * writing the full update for an incomplete post fails tests/official-read-pipeline.test.ts
     * "the reconciler keeps the evidence a concurrent anonymous pass captured".
     */
    update: post.evidenceIncomplete
      ? { likeCount: data.likeCount, commentCount: data.commentCount }
      : {
          likeCount: data.likeCount,
          commentCount: data.commentCount,
          caption: data.caption,
          confidence: data.confidence,
          verdict: data.verdict,
          verdictSource: data.verdictSource,
          classifierModel: data.classifierModel,
          classifierReason: data.classifierReason,
          signals: data.signals,
          brands: data.brands,
          taggedAccounts: data.taggedAccounts,
          rawPayload: data.rawPayload,
          frameText: data.frameText,
        },
    create: { ...data, shortcode: post.shortcode },
  })
}
