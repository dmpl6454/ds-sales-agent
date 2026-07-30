import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { writeStringArray } from '@/lib/json'
import { fetchFeed, FeedFetchError, type FeedPost } from './feed'
import { getDetector } from './detectors'
import { hoursAgo } from '@/lib/time'

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

export interface ChannelOutcome {
  handle: string
  fetched: number
  alreadyKnown: number
  stored: number
  campaigns: number
  unclassified: number
  organic: number
  officiallyPaid: number
  pagesFetched: number
  error?: string
  parseFailure?: boolean
}

export interface DetectionSummary {
  channels: ChannelOutcome[]
  postsSeen: number
  newPosts: number
  detected: number
  hadParseFailure: boolean
  hadError: boolean
}

/** How far back to look. Generous enough to survive a missed slot. */
const LOOKBACK_HOURS = 36

export async function runDetection(): Promise<DetectionSummary> {
  const targets = await prisma.targetAccount.findMany({
    where: { kind: 'CHANNEL' },
    orderBy: { handle: 'asc' },
  })

  const channels: ChannelOutcome[] = []
  const sinceUnix = Math.floor(hoursAgo(LOOKBACK_HOURS).getTime() / 1000)

  for (const target of targets) {
    const outcome: ChannelOutcome = {
      handle: target.handle,
      fetched: 0,
      alreadyKnown: 0,
      stored: 0,
      campaigns: 0,
      unclassified: 0,
      organic: 0,
      officiallyPaid: 0,
      pagesFetched: 0,
    }

    try {
      const { posts, pagesFetched } = await fetchFeed(target.handle, { maxPosts: 48, sinceUnix })
      outcome.fetched = posts.length
      outcome.pagesFetched = pagesFetched

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
        select: { shortcode: true },
      })
      const knownSet = new Set(known.map((k) => k.shortcode))
      outcome.alreadyKnown = knownSet.size

      const fresh = posts.filter((p) => !knownSet.has(p.shortcode))
      const detector = getDetector(target.detectorKey)

      for (const post of fresh) {
        const cls = detector.classify(post)

        // Instagram's own Paid Partnership label overrides any heuristic. Neither
        // Phase 1 target uses it today, but when one does this becomes the truth.
        const officiallyPaid = post.isPaidPartnership
        if (officiallyPaid) outcome.officiallyPaid += 1

        const verdict = officiallyPaid ? 'CAMPAIGN' : cls.verdict
        const confidence = officiallyPaid ? 100 : cls.confidence
        const signals = officiallyPaid ? [...cls.signals, 'official:is_paid_partnership'] : cls.signals
        const brands = dedupe([
          ...post.sponsorHandles.map((h) => `@${h}`),
          ...post.collabHandles.map((h) => `@${h}`),
          ...cls.brands,
        ])

        if (verdict === 'CAMPAIGN') outcome.campaigns += 1
        else if (verdict === 'UNCLASSIFIED') outcome.unclassified += 1
        else outcome.organic += 1

        await persist(target.id, post, verdict, confidence, signals, brands)
        outcome.stored += 1
      }

      log.info('channel done', {
        handle: target.handle,
        detector: detector.key,
        fetched: posts.length,
        new: outcome.stored,
        campaigns: outcome.campaigns,
        officiallyPaid: outcome.officiallyPaid,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.error = message
      if (err instanceof FeedFetchError && err.isParseFailure) {
        outcome.parseFailure = true
        log.alarm('feed shape changed — detection is blind until fixed', { handle: target.handle, message })
      } else {
        log.error('channel failed', { handle: target.handle, error: message })
      }
    }

    channels.push(outcome)
  }

  return {
    channels,
    postsSeen: channels.reduce((n, c) => n + c.fetched, 0),
    newPosts: channels.reduce((n, c) => n + c.stored, 0),
    detected: channels.reduce((n, c) => n + c.campaigns, 0),
    hadParseFailure: channels.some((c) => c.parseFailure === true),
    hadError: channels.some((c) => c.error !== undefined),
  }
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
    rawPayload: JSON.stringify({
      isPaidPartnership: post.isPaidPartnership,
      sponsorHandles: post.sponsorHandles,
      collabHandles: post.collabHandles,
    }),
  }

  await prisma.detectedCampaign.upsert({
    where: { shortcode: post.shortcode },
    // Re-observing refreshes engagement and classification, but never overwrites a
    // human's REVIEW-queue label.
    update: {
      likeCount: data.likeCount,
      commentCount: data.commentCount,
      confidence: data.confidence,
      verdict: data.verdict,
      signals: data.signals,
      brands: data.brands,
    },
    create: { ...data, shortcode: post.shortcode },
  })
}
