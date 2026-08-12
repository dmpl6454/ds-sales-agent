import type { ChannelDetector, Classification, EnrichedPost } from '../types'
import { extractBrands } from './mom'

/**
 * Detector for @viralbhayani — and for any channel that does not disclose.
 *
 * It deliberately classifies NOTHING. Every post is stored with its caption and
 * marked UNCLASSIFIED.
 *
 * Why, grounded in real posts captured 2026-07-29. Viral Bhayani carries no
 * disclosure of any kind, yet roughly half their output is commercial:
 *
 *   PAID (no tag)  "Blockbuster #JanaNayagan is running successfully in cinemas now"
 *   PAID (no tag)  "ASAMBHAUUU — Get ready for a heartwarming tale packed with love"
 *   PAID (no tag)  "Dr L H Hiranandani Hospital, Powai invites you to a FREE ... Program"
 *   ORGANIC        "The ageless diva #malaikaarora spotted with her mystery friend"
 *   ORGANIC        "#athiyashetty who went to the airport to receive her husband #klrahul"
 *
 * No hashtag, flag, or label separates row 1 from row 4 — only the meaning of the
 * words does. That needs a language model, which costs money and can be wrong.
 *
 * In Phase 1 it would buy nothing: the prospect list is two hardcoded handles and
 * outreach rate is set by the cooldown governor, not by how many campaigns we
 * detected. Meanwhile every stored caption builds the labelled corpus needed to
 * construct AND validate the semantic classifier in Phase 1.5 — rather than
 * guessing at prompts on day one.
 *
 * Brand candidates are still extracted opportunistically: when a caption happens
 * to @mention a studio or brand it is free signal, useful for the dashboard and
 * for seeding brand targets later. It does not affect the verdict.
 */
export const passthroughDetector = {
  key: 'passthrough',
  describe:
    'Records every post without judging it. Nothing here decides whether a post is paid — use the semantic detector for a channel that does not disclose.',

  /**
   * Reports NOT ready, deliberately, even though nothing is broken.
   *
   * `readiness()` answers "can this detector do the job the dashboard implies", and
   * the honest answer here is no — it stores and judges nothing, so a channel using
   * it contributes a silent 0 to "paid campaigns spotted".
   *
   * Saying so here rather than leaving the dashboard to special-case
   * `key === 'passthrough'` matters: a hardcoded check in the view is a fact stated
   * in the wrong place, and it silently stops being true the moment a third
   * non-judging detector is added. The detector knows what it does; it should say so.
   */
  readiness() {
    return {
      ready: false,
      reason: 'Posts are recorded but never judged — this channel has no classifier set up.',
    }
  },

  classify(post: EnrichedPost): Classification {
    return {
      verdict: 'UNCLASSIFIED',
      confidence: 0,
      signals: ['detector:passthrough'],
      brands: extractBrands(post.caption),
      // Never claims to have judged anything. That is the entire point of this
      // detector, and it is what distinguishes it from the semantic one failing.
      verdictSource: 'none',
    }
  },
} satisfies ChannelDetector
