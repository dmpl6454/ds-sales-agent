/**
 * WHY WAS THIS MESSAGE SENT TO THIS COMPANY? — one answer, from stored facts only.
 *
 * ── THE GAP THIS CLOSES (Tabish, 2026-08-31) ────────────────────────────────
 *
 * *"Nowhere does a person looking at the dashboard know why that particular message was
 * sent to that person, for which paid post specifically."* He is right, and it was the
 * last unexplained thing on the screen: every REFUSAL names its own rule in the refusing
 * rule's words, and a message that actually went out named nothing at all.
 *
 * ── IT IS A LOOKUP, NEVER AN INFERENCE, AND THAT IS THE WHOLE DESIGN ────────
 *
 * Two columns already hold the answer and neither was ever drawn:
 *
 *   `OutreachAttempt.campaignId`   what `pickHook` CLAIMED for this message — the newest
 *                                  paid post naming this recipient that this pair had not
 *                                  been written about yet. Under `singleTemplate` the body
 *                                  never mentions it, and compose.ts records it anyway
 *                                  precisely because the new-material rule is derived from
 *                                  it. So it is not decoration: it is the post that MADE
 *                                  this message permissible.
 *   `TargetAccount.discoveredFromCampaignId`
 *                                  the paid post that minted this company as a prospect.
 *
 * MEASURED over the newest 60 deliveries on 2026-08-31: **60 of 60 attributable** — 24 by
 * the claim, 36 by discovery, 0 needing a guess. Fleet-wide the two columns are populated
 * on 771 of 2,199 delivered messages and 770 of 773 prospects respectively.
 *
 * **NOTHING IS RECONSTRUCTED.** The tempting third source is "search the corpus for paid
 * posts naming this recipient before the send" — and it is refused here. That set is what
 * the ALLOWANCE counts, not what any one message was sent for, so picking a member of it
 * would put a specific claim on screen that no stored fact supports. When neither column
 * answers, this says so and the screen renders an em-dash. Absence of data must not
 * harden into a verdict, and a provenance line is exactly where a plausible-looking guess
 * would never be questioned.
 *
 * ── THE TWO BASES ARE NOT THE SAME SENTENCE, DELIBERATELY ───────────────────
 *
 * "the post this message was claimed against" and "the post that found this company" are
 * different facts about different moments, and collapsing them would make a first touch
 * look like a follow-up. They are ordered claim-first because the claim is about THIS
 * message while discovery is about the recipient's existence.
 */

export type ProvenanceBasis = 'claimed' | 'discovered' | 'unknown'

/** The minimum a screen needs to name a paid post and link to it. */
export interface ProvenancePost {
  shortcode: string
  /** The watched page that published it — "@viralbhayani". */
  channelHandle: string
  postedAt: Date
}

export interface MessageProvenance {
  basis: ProvenanceBasis
  post: ProvenancePost | null
  /**
   * One sentence, in the words the fact actually supports. Empty when nothing is known —
   * the caller renders an em-dash rather than prose about our own uncertainty (the
   * 2026-08-25 rule: the column is the answer, never a narration of the search).
   */
  sentence: string
}

/**
 * `claimed` is the post `attempt.campaignId` points at; `discovered` is the post
 * `target.discoveredFromCampaignId` points at. Either may be null.
 */
export function provenanceFor(input: {
  claimed: ProvenancePost | null
  discovered: ProvenancePost | null
}): MessageProvenance {
  if (input.claimed) {
    return {
      basis: 'claimed',
      post: input.claimed,
      sentence: `Sent for this paid post on @${input.claimed.channelHandle} — it named this company and no message had gone out about it yet.`,
    }
  }
  if (input.discovered) {
    return {
      basis: 'discovered',
      post: input.discovered,
      sentence: `This company was found in this paid post on @${input.discovered.channelHandle}, and this was the first message to them.`,
    }
  }
  return { basis: 'unknown', post: null, sentence: '' }
}

/**
 * The compact label for a table cell: the channel and the post's date.
 *
 * Kept beside the resolver so the two cannot drift, and deliberately NOT the shortcode —
 * a reader recognises "@viralbhayani, 29 Aug" and cannot recognise "DcnUhAMKUO8". The
 * shortcode travels on the link.
 */
export function provenanceLabel(post: ProvenancePost, dayLabel: string): string {
  return `@${post.channelHandle} · ${dayLabel}`
}
