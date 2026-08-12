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

  /**
   * How this verdict was reached: "rules" | "semantic" | "none".
   *
   * Carried so the two can never be presented as the same claim. A #Collaboration
   * hashtag is a fact read off the payload; a language model's opinion about a
   * caption is a judgement that can be wrong. A dashboard that shows both as "paid
   * campaigns found" is overstating one of them, and the operator has no way to tell
   * which number to trust.
   */
  verdictSource: 'rules' | 'semantic' | 'none'
  /** Model identifier when verdictSource is "semantic". */
  classifierModel?: string
  /** One line of reasoning, for the review queue. Never sent to anyone. */
  classifierReason?: string

  /**
   * What OCR read off the post's cover frame, as one line — the evidence a person needs
   * when a post is flagged because of its FOOTAGE rather than its caption.
   *
   * Null when no frame was read, which is not the same as a frame with no text; the
   * `frame:*` entries in `signals` keep those states apart. Never sent to a recipient:
   * this is text off a stranger's video and it has no business in message copy.
   */
  frameText?: string | null
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
  /**
   * Async because a semantic detector calls a model over the network. Rule-based
   * detectors simply return; the cost of the wider signature is one `await` at the
   * single call site in `pipeline.ts`.
   */
  classify(post: EnrichedPost): Promise<Classification> | Classification

  /**
   * Is this detector actually able to do its job right now?
   *
   * Exists because a detector that needs configuration it does not have must be able
   * to SAY so. The semantic classifier without an API key would otherwise return
   * UNCLASSIFIED for every post — indistinguishable, on screen, from a channel that
   * genuinely published nothing commercial. That is the shape of failure this project
   * keeps producing: the quiet path and the broken path render identically.
   */
  readiness?(): { ready: boolean; reason?: string }
}

export const UNCLASSIFIED: Classification = {
  verdict: 'UNCLASSIFIED',
  confidence: 0,
  signals: [],
  brands: [],
  verdictSource: 'none',
}
