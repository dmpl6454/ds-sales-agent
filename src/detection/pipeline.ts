import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { writeStringArray } from '@/lib/json'
import { discoverProfile, DiscoverError } from './discover'
import { enrichAll } from './enrich'
import { getDetector } from './detectors'
import type { EnrichedPost } from './types'

/**
 * The detection half of one slot: for each active target, read the grid, enrich
 * the posts we have not seen, classify them, and store the result.
 *
 * Idempotency comes free from `DetectedCampaign.shortcode @unique`: four scrapes
 * a day means each post is seen ~4x, so we filter known shortcodes before
 * spending HTTP requests and upsert the rest. Re-running a slot is safe.
 */

export interface ChannelOutcome {
  handle: string
  discovered: number
  alreadyKnown: number
  enriched: number
  campaigns: number
  unclassified: number
  organic: number
  enrichFailures: number
  /** Set when the channel failed outright — the run is PARTIAL, not OK. */
  error?: string
  /** True when discovery returned nothing, i.e. the parser broke. Always alarms. */
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

export async function runDetection(): Promise<DetectionSummary> {
  const targets = await prisma.targetAccount.findMany({
    where: { kind: 'CHANNEL' },
    orderBy: { handle: 'asc' },
  })

  const channels: ChannelOutcome[] = []

  for (const target of targets) {
    const outcome: ChannelOutcome = {
      handle: target.handle,
      discovered: 0,
      alreadyKnown: 0,
      enriched: 0,
      campaigns: 0,
      unclassified: 0,
      organic: 0,
      enrichFailures: 0,
    }

    try {
      const discovered = await discoverProfile(target.handle)
      outcome.discovered = discovered.length

      // Skip shortcodes already stored — this is where the 4x/day overlap is paid for.
      const known = await prisma.detectedCampaign.findMany({
        where: { shortcode: { in: discovered.map((d) => d.shortcode) } },
        select: { shortcode: true },
      })
      const knownSet = new Set(known.map((k) => k.shortcode))
      outcome.alreadyKnown = knownSet.size

      const fresh = discovered.filter((d) => !knownSet.has(d.shortcode))
      if (fresh.length === 0) {
        log.step('no new posts', { handle: target.handle, grid: discovered.length })
        channels.push(outcome)
        continue
      }

      const { posts, failures } = await enrichAll(fresh)
      outcome.enriched = posts.length
      outcome.enrichFailures = failures.length

      // Every post in the grid failed to parse while discovery succeeded: the
      // og:description shape has changed. Loud, because the alternative is a
      // system that quietly reports "0 campaigns" forever.
      if (posts.length === 0 && failures.length > 0) {
        outcome.parseFailure = true
        log.alarm('every post failed to enrich — og:description shape has changed', {
          handle: target.handle,
          attempted: failures.length,
          firstReason: failures[0]?.reason,
        })
      }

      const detector = getDetector(target.detectorKey)

      for (const post of posts) {
        const cls = detector.classify(post)
        if (cls.verdict === 'CAMPAIGN') outcome.campaigns += 1
        else if (cls.verdict === 'UNCLASSIFIED') outcome.unclassified += 1
        else outcome.organic += 1

        await persistCampaign(target.id, post, cls.verdict, cls.confidence, cls.signals, cls.brands)
      }

      log.info('channel done', {
        handle: target.handle,
        detector: detector.key,
        new: posts.length,
        campaigns: outcome.campaigns,
        unclassified: outcome.unclassified,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.error = message
      if (err instanceof DiscoverError && err.isParseFailure) {
        outcome.parseFailure = true
        log.alarm('discovery yielded no posts — grid selector or page shape changed', {
          handle: target.handle,
        })
      } else {
        log.error('channel failed', { handle: target.handle, error: message })
      }
    }

    channels.push(outcome)
  }

  return {
    channels,
    postsSeen: channels.reduce((n, c) => n + c.discovered, 0),
    newPosts: channels.reduce((n, c) => n + c.enriched, 0),
    detected: channels.reduce((n, c) => n + c.campaigns, 0),
    hadParseFailure: channels.some((c) => c.parseFailure === true),
    hadError: channels.some((c) => c.error !== undefined),
  }
}

async function persistCampaign(
  targetId: string,
  post: EnrichedPost,
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
    brands: writeStringArray(brands),
    signals: writeStringArray(signals),
    confidence,
    verdict,
    rawPayload: JSON.stringify({ gridIndex: post.gridIndex, ownerHandle: post.ownerHandle }),
  }

  await prisma.detectedCampaign.upsert({
    where: { shortcode: post.shortcode },
    // Re-observing a post refreshes engagement counts but never overwrites a
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
