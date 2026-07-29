import { z } from 'zod'
import type { Verdict } from '@/lib/constants'

/** A post shortcode found on a profile grid, with its position (0 = newest slot). */
export interface DiscoveredPost {
  shortcode: string
  gridIndex: number
}

/**
 * A post after enrichment from its own page's `og:description` meta tag.
 *
 * Known limitation: og:description carries only a calendar DATE, not a time.
 * So `postedAt` is day-precision. Ordering within a day therefore falls back to
 * `gridIndex` (grid is newest-first), which is sufficient for picking "the
 * freshest campaign to use as a hook".
 */
export const EnrichedPostSchema = z.object({
  shortcode: z.string().min(5),
  permalink: z.string().url(),
  ownerHandle: z.string().min(1),
  caption: z.string(),
  likeCount: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  postedAt: z.date(),
  gridIndex: z.number().int().nonnegative(),
})
export type EnrichedPost = z.infer<typeof EnrichedPostSchema>

/** Output of a ChannelDetector. `signals` is the human-auditable "why". */
export interface Classification {
  verdict: Verdict
  /** 0–100. Meaningless for UNCLASSIFIED. */
  confidence: number
  /** Rule identifiers that fired, e.g. ["hashtag:collaboration", "mention:@theleela"]. */
  signals: string[]
  /** Brand/sponsor names or handles extracted from the post. */
  brands: string[]
}

/**
 * One detector per target channel, because the two channels behave completely
 * differently: MOM discloses paid posts with #Collaboration, Viral Bhayani never
 * discloses at all. A single shared ruleset would either miss MOM's signal or
 * flag every celebrity spotting on Viral Bhayani.
 */
export interface ChannelDetector {
  /** Matches TargetAccount.detectorKey. */
  key: string
  /** Human-readable note shown in the dashboard next to the target. */
  describe: string
  classify(post: EnrichedPost): Classification
}

export const UNCLASSIFIED: Classification = {
  verdict: 'UNCLASSIFIED',
  confidence: 0,
  signals: [],
  brands: [],
}
