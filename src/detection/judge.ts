import { readFrameText, frameTextSummaryLine } from './ocr'
import { applyFrameSignal } from './frameSignal'
import { modelVerdictToStored, classifyCaption } from './detectors/semantic'
import type { Verdict } from '@/lib/constants'

/**
 * THE ONE PLACE A POST IS JUDGED — caption first, then the footage.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Three callers ran their own version of this and they had already diverged:
 *
 *   | caller                  | caption | frame |
 *   |-------------------------|---------|-------|
 *   | `pipeline.ts`           | yes     | **NO** |
 *   | `scripts/ocr.ts`        | yes     | yes   |
 *   | `scripts/classify.ts`   | yes     | **NO** |
 *
 * MEASURED 2026-08-08, and it is the finding that made this urgent rather than tidy:
 * **166 posts detected that day had a cover frame on disk that nothing had read.** The
 * pipeline saves the frame and then classifies the caption alone, so the Thane class of
 * paid post — the entire reason the OCR work was done — was still being missed in normal
 * operation. `DbtNU9UzWYU` was only ever escalated because a person typed
 * `pnpm ig:ocr --reclassify` by hand.
 *
 * A feature that works only when someone runs a command is not running. This is the
 * fourth time in this codebase that one rule with several callers has drifted — `gate.ts`
 * (deliverWaiting checked eight conditions, sendNow three), `readThread.ts` (the CLI kept
 * a private copy while the docblock claimed "one implementation, two callers"), and the
 * two Connect buttons (one never polled, so a real login went unrecorded). Each time the
 * fix landed in one caller and not the other. Extracting it is what stops `classify.ts`
 * becoming the fourth.
 *
 * ── THE ORDER IS LOAD-BEARING: CAPTION FIRST, ALONE ─────────────────────────
 *
 * Reading the frame first and passing its text into a single call is cheaper and wrong
 * three ways, all found by adversarial review and all recorded in CLAUDE.md:
 *
 *   1. **It fails open.** A second call establishes what the caption ALONE would have
 *      said; when that call fails, the code assumes the frame agreed — so a CAMPAIGN
 *      produced entirely by frame text gets asserted. A network blip was enough.
 *   2. **It lets frame text name BRANDS, and brands become message copy.** Executed
 *      against the real salon control it produced the DM sentence *"I noticed your recent
 *      branded collaboration with Dessange Paris and Kerastase"* — to a prospect, about
 *      signage behind a celebrity. Brands come from the caption-only call, always.
 *   3. It makes the guard against a frame CLEARING a post unreachable.
 *
 * Caption first fixes all three by construction, and costs ~2.8 cents across the corpus.
 *
 * ── THE FOOTAGE MAY ONLY ESCALATE ───────────────────────────────────────────
 *
 * `applyFrameSignal` is the permission table and it is not re-implemented here: a frame
 * may turn a caption ORGANIC into REVIEW so a person looks, and nothing else. It can
 * never mint a CAMPAIGN, overturn one, clear one, or give an UNCLASSIFIED post a verdict.
 * The reason is honest rather than cautious — `ig:accuracy`'s labels are caption-derived,
 * so a frame-driven CAMPAIGN is measured by nothing that exists.
 */

/** What the caller must supply. Deliberately not a Prisma row: this stays testable. */
export interface JudgeInput {
  shortcode: string
  caption: string
  /**
   * Is this target one we would ever MESSAGE? Frames are still saved for everyone —
   * they are the labelled set any future measurement needs — but reading and re-judging
   * one costs CPU and a model call.
   *
   * MEASURED: 64% of OCR runs were against our own RETIRED pages. We watch those for
   * ground truth, which is worth doing; spending a classifier call to decide whether a
   * page we will never write to ran a paid campaign is not.
   */
  optedOut: boolean
  /** Only the semantic detector's channels can be re-judged; a rule detector's verdict is a LABEL. */
  frameJudgingSupported: boolean
  /**
   * The post's tags and co-authors, ALREADY FENCED by `tagsForPrompt`, exactly as the
   * caption verdict was reached with.
   *
   * ── WHY THIS IS PASSED IN RATHER THAN BUILT HERE ───────────────────────────
   *
   * `captionOnly` was produced by a call that had this block. The call below adds the
   * FRAME, and `applyFrameSignal` then attributes any difference between the two verdicts
   * to the footage. If this call saw different tags — or none — a tag-driven disagreement
   * would be recorded as `frame:disagreed-higher`, which is the single number saying
   * whether reading video earns its keep. So the caller supplies the same string it used,
   * rather than a second construction of it that could drift.
   *
   * Optional, because a backfill over stored rows may genuinely not have it, and absent
   * must stay distinguishable from empty.
   */
  tagText?: string | null
}

export type JudgeReason =
  | 'judged'
  /** The target is retired — we save the frame but do not spend a call on it. */
  | 'opted-out'
  /** This channel has no classifier that could use frame text. */
  | 'unsupported'
  /** The caption verdict already settles it; a frame cannot move a CAMPAIGN either way. */
  | 'caption-decisive'
  /** A person has answered this one. Their answer outranks any model. */
  | 'human-labelled'

export interface JudgeResult {
  verdict: Verdict
  signals: string[]
  /** The frame's text, for storage and for showing on /paid-posts. Null when unread. */
  frameText: string | null
  /** One line an operator can read: what the footage actually said. */
  frameSummary: string | null
  /** Which OCR engine answered. NEVER compare verdicts across engines without this. */
  engine: string | null
  /** Did the footage change the answer? The only thing that identifies a frame-driven call. */
  changedByFrame: boolean
  /** Why the frame was or was not consulted. Rendered, never swallowed. */
  reason: JudgeReason
}

/**
 * Given a caption verdict already in hand, decide whether the footage changes it.
 *
 * `captionOnly` is passed in rather than recomputed because every post in the corpus
 * ALREADY carries its caption-only verdict — it was stored before frame text existed. So
 * a backfill needs no second call to know what the caption alone said, which is the whole
 * reason a pass over stored posts is affordable.
 */
export async function judgeWithFrame(
  input: JudgeInput,
  captionOnly: Verdict,
  opts: { humanLabelled?: boolean } = {},
): Promise<JudgeResult> {
  const base: JudgeResult = {
    verdict: captionOnly,
    signals: [],
    frameText: null,
    frameSummary: null,
    engine: null,
    changedByFrame: false,
    reason: 'judged',
  }

  /**
   * A person's answer outranks every model, and re-judging one would overwrite the only
   * labels that can ever measure recall on video-only placements. Checked FIRST so no
   * other branch can reach past it.
   */
  if (opts.humanLabelled) return { ...base, reason: 'human-labelled' }

  if (input.optedOut) return { ...base, reason: 'opted-out' }
  if (!input.frameJudgingSupported) return { ...base, reason: 'unsupported' }

  /**
   * Only a caption the classifier called ORDINARY can be moved by its footage.
   * `applyFrameSignal` would refuse to move anything else, so calling the model for a
   * CAMPAIGN is spending money to be told no.
   */
  if (captionOnly !== 'ORGANIC') {
    return { ...base, reason: 'caption-decisive' }
  }

  /**
   * `readFrameText` returns the prompt block, the EVIDENCE STATE and the parsed text
   * together, and that grouping is load-bearing: a caller holding only the prompt string
   * cannot tell "the frame has no text" from "there is no frame" from "this machine has
   * no OCR engine". Collapsing those into a null is exactly how absence of data becomes a
   * claim about the post — the bug this codebase has produced four times.
   */
  const frame = await readFrameText(input.shortcode)
  const engine = frame.text?.engine ?? null

  /**
   * No prompt means nothing to add to the caption. The verdict is re-derived through
   * `applyFrameSignal` ANYWAY, passing the caption verdict as both arguments, so the
   * signal recording WHY the footage did not speak is produced by the permission table
   * rather than invented here. One writer of that reasoning, not two.
   */
  if (!frame.prompt) {
    const outcome = applyFrameSignal(captionOnly, captionOnly, frame.evidence)
    return { ...base, verdict: outcome.verdict, signals: outcome.signals, engine }
  }

  const withFrameCall = await classifyCaption(input.caption, input.shortcode, frame.prompt, input.tagText ?? null)

  /**
   * A FAILED CALL IS NOT A VERDICT. Without an answer we cannot know what the classifier
   * would have said WITH the frame, so the caption's verdict stands unchanged and the
   * signal records that the footage went unjudged. Treating a failure as agreement is the
   * fail-open direction that adversarial review caught in the first design.
   */
  const summary = frameTextSummaryLine(frame.text)

  if (!withFrameCall) {
    return {
      ...base,
      signals: ['frame:call-failed'],
      frameText: summary,
      frameSummary: summary,
      engine,
    }
  }

  /**
   * The model's answer as a stored verdict. `REVIEW` — the model's word for "genuinely
   * ambiguous" — becomes CAMPAIGN, because there is no ambiguous state any more and a paid
   * post filed as ordinary is the one error this project refuses to make. The confidence
   * downgrade that used to sit here is gone with REVIEW; see `modelVerdictToStored`.
   */
  const withFrame: Verdict = modelVerdictToStored(withFrameCall.verdict)

  const outcome = applyFrameSignal(captionOnly, withFrame, frame.evidence)

  return {
    verdict: outcome.verdict,
    signals: outcome.signals,
    frameText: summary,
    frameSummary: summary,
    engine,
    changedByFrame: outcome.verdict !== captionOnly,
    reason: 'judged',
  }
}
