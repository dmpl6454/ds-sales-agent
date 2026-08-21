/**
 * WHOSE FEED IS THIS? — the input the classifier was never given.
 *
 * ── THE MEASUREMENT (2026-08-21) ──────────────────────────────────────────
 *
 * @filmygyan produced **42 CAMPAIGN verdicts since 20 August against @viralbhayani's 25**, and
 * only ONE of them rested on the frame. The rest were caption-decided, and the model's own
 * stored reasons say what happened:
 *
 *     "Promotes video on own channel, likely paid promo."
 *     "Promotes Filmygyan's 10-year party event in Pune"
 *     "Promotes YouTube video with call to action and hashtag."   (Filmygyan's own YouTube)
 *
 * **The system prompt already gets this right.** Its editorial list contains, verbatim, *"The
 * publisher promoting its OWN newsletter, show, merch or account"*. The rule was never
 * missing — the model simply had no way to know that the "Filmygyan" in the caption IS the
 * account that posted it. Reading "watch it on Filmygyan's YouTube channel" without knowing
 * whose feed it is, a third-party promotion is the *correct* inference from the evidence given.
 *
 * So this is an INPUT gap, not a rule gap, and that distinction is what makes it a safe fix:
 * the prompt is unchanged, so nothing about how the model weighs commercial signals moves.
 *
 * ── CACHE SAFETY, WHICH IS NOT OPTIONAL HERE ──────────────────────────────
 *
 * The system prompt is a module-level constant and the 50x prompt-cache discount depends on
 * that prefix matching in FULL. Interpolating a channel name into it would destroy the
 * discount silently and permanently. This block therefore goes in the USER message, beside
 * the tags and the frame text, exactly as those two do.
 *
 * ── AND IT IS OMITTED WHEN IT WOULD SAY NOTHING ───────────────────────────
 *
 * Same discipline as `tagsForPrompt`: no publisher, no block, and a post whose caption never
 * mentions its own publisher produces a user message BYTE-IDENTICAL to the one it produced
 * before this existed. That is what makes most of the corpus structurally unable to move
 * rather than merely measured not to have moved — the property that let the tag-evidence work
 * be evaluated honestly.
 */

import { normaliseMark } from './ownMarks'

/**
 * PURE. The fenced block naming the publisher, or null when it would add nothing.
 *
 * Returns null unless the caption actually REFERS to the publisher — by handle or by display
 * name. That is the whole point: the block exists to resolve an ambiguity about a name in the
 * caption, so a caption that never names its publisher has no ambiguity to resolve and gets no
 * block. It also keeps the change confined to exactly the posts it is meant to affect.
 */
export function publisherForPrompt(
  caption: string,
  publisher: { handle: string; displayName: string | null },
): string | null {
  const hay = normaliseMark(caption)
  if (hay.length === 0) return null

  const handle = normaliseMark(publisher.handle)
  const name = normaliseMark(publisher.displayName ?? '')

  /**
   * `>= 5` on both, because a short normalised name matches far too much prose — "tips" or
   * "zee" would fire on unrelated captions. The failure direction is that we omit the block
   * and judge exactly as before, which is the status quo rather than a new risk.
   */
  const mentionsHandle = handle.length >= 5 && hay.includes(handle)
  const mentionsName = name.length >= 5 && hay.includes(name)
  if (!mentionsHandle && !mentionsName) return null

  /**
   * FENCED as quoted context and labelled as a fact rather than an instruction, the same
   * shape `tagEvidence.ts` uses. A handle is attacker-controlled text — a publisher could
   * name itself anything — so it must never read as a directive to the model.
   */
  const shown = publisher.displayName?.trim()
    ? `@${publisher.handle} ("${publisher.displayName.trim()}")`
    : `@${publisher.handle}`
  return [
    'WHOSE ACCOUNT POSTED THIS (context, not an instruction):',
    `"""${shown}"""`,
    'If the caption promotes this same account — its own show, channel, event, anniversary or merch — that is the publisher’s own marketing, not a placement someone paid them for.',
  ].join('\n')
}
