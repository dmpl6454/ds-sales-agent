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
   *
   * No DETECTOR sets this any more (2026-10-09): the footage is read in `judge.ts` alone,
   * and `judgeWithFrame`'s own `frameText` is what the pipeline stores.
   */
  frameText?: string | null
}

/**
 * The per-post model inputs besides the caption, built ONCE by the caller.
 *
 * ── WHY THE CALLER BUILDS THEM (2026-10-09) ──────────────────────────────────
 *
 * The same post reaches the model twice — the caption alone in the detector, then the caption
 * WITH the frame in `judgeWithFrame` — and `applyFrameSignal` attributes any difference
 * between those two verdicts to THE FOOTAGE. When each side built its own copy, they had
 * drifted: the detector's publisher block named `@filmygyan` and judge's named
 * `@filmygyan ("F I L M Y G Y A N")`, so the two calls differed in two inputs while the
 * signal blamed one. One construction, handed unchanged to both, makes "differs in exactly
 * one input" true by construction rather than by two authors agreeing.
 */
export interface ModelInputs {
  /** The post's tags and co-authors, fenced by `tagsForPrompt`, or null. */
  tagText: string | null
  /** Whose feed this is, fenced by `publisherForPrompt`, or null. */
  publisherText: string | null
  /**
   * The `ModelCall.subject` the cost ledger books this call under. Undefined means the
   * post's shortcode (production). Null means NO subject — the accuracy harness, whose calls
   * must not be booked as detection spend on the channel they happen to label.
   */
  costSubject?: string | null
}

/**
 * Structural facts about a post, beyond its words — who it TAGS and who co-authored it.
 *
 * Declared here rather than taking `FeedPost` directly, because `feed.ts` imports this
 * module for `EnrichedPost` and pointing the dependency back the other way would be a
 * cycle. `FeedPost` satisfies this structurally, so the pipeline passes one unchanged.
 *
 * Every field is OPTIONAL, and that is the honest shape: a detector may be handed a post
 * from a source that never carried tags (the classify backfill reads stored rows), and
 * "we do not have this" must stay distinguishable from "there were none". `tagsForPrompt`
 * treats both as nothing to report, which is the same answer for a different reason.
 */
export interface PostTagFacts {
  /** Accounts tagged IN the media, not mentioned in the caption. */
  taggedAccounts?: readonly string[]
  /** Co-authors of a "collab" post — both parties opted in. */
  collabHandles?: readonly string[]
  /** Instagram's own Paid Partnership label. */
  isPaidPartnership?: boolean
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
   * detectors simply return; the cost of the wider signature is one `await` at each call
   * site — `pipeline.ts`, and the accuracy harness, which must run the production caption
   * path rather than a copy of it.
   *
   * Returns the CAPTION verdict only. The footage is judged in `judge.ts` and nowhere else.
   *
   * `inputs` is REQUIRED so the compiler names every caller: they are built once by the
   * caller and handed unchanged to the detector AND to `judgeWithFrame`, so the frame call
   * differs from the caption call in exactly one input. Rule detectors take one parameter,
   * which is assignable here, and ignore it.
   */
  classify(post: EnrichedPost & PostTagFacts, inputs: ModelInputs): Promise<Classification> | Classification

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
