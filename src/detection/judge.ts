import { readFrameText, frameTextSummaryLine } from './ocr'
import { stripOwnMarksFromFrame } from './ownMarks'
import { publisherForPrompt } from './publisherContext'
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
   * WHOSE POST THIS IS — required, no default, so the compiler names every caller.
   *
   * Needed because a publisher's own marks are not evidence about the publisher. MEASURED
   * 2026-08-21: the caption classifier called @filmygyan's anniversary post ORGANIC with the
   * reason "Publisher's own anniversary, not a paid promotion", and the FOOTAGE then
   * escalated it to CAMPAIGN on a frame reading `in shot: FILMYGYAN` — the channel's own
   * watermark, burned into every video it posts. @filmygyan produced 42 CAMPAIGN verdicts
   * since 20 August against @viralbhayani's 25.
   *
   * See `ownMarks.ts`, including the control case that proves the stage itself is sound:
   * the same channel's `acerpure | Dolby | 120Hz` frame escalation is CORRECT and survives.
   */
  publisher: { handle: string; displayName: string | null }
  /**
   * Tell the classifier whose feed it is reading? A Setting, off by default until measured —
   * the `tagsAsEvidence` pattern. See `publisherContext.ts` for why this is an INPUT gap
   * rather than a rule gap, and `pnpm ig:accuracy --repeat 3` for the number that decides it.
   */
  publisherAsContext?: boolean
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
  /**
   * WHICH detector produced the caption verdict — judge.ts decides what that permits,
   * so "which detectors support what" has ONE definition instead of one per caller.
   * It was `frameJudgingSupported: boolean`, derived independently at three call sites;
   * adding the M.O.M second look would have meant a fourth derivation at each.
   *
   *   semantic — the caption verdict is the model's own; the frame may escalate it.
   *   mom      — a rule verdict. POSITIVE is a label and is never touched. NEGATIVE is
   *              only "no #Collaboration tag", so it gets the SECOND LOOK below.
   *   anything else — a verdict no model produced and no frame may move.
   */
  detectorKey: string
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

/** Detectors whose verdicts the frame path may act on at all. */
const FRAME_JUDGING_DETECTORS = new Set(['semantic', 'mom'])

/**
 * ── THE M.O.M SECOND LOOK (2026-08-17, Tabish's decision) ─────────────────────────
 *
 * Rule detectors whose NEGATIVE gets re-judged by the semantic model before the frame
 * path runs. The `mom` rule is perfect on its corpus in one direction — 22 in-window
 * posts carry #Collaboration and every one is paid — but its negative means only "no
 * disclosure tag", and MEASURED on 2026-08-17: **61 in-window posts were rule-negative
 * and NOTHING else ever read them.** CLAUDE.md has said since the 13 August audit that
 * an undisclosed M.O.M paid post is missed with certainty and that changing it is its
 * own decision; Tabish made that decision ("make sure paid posts detection is accurate
 * … for both viral bhayani and madabout").
 *
 * The rule POSITIVE is never touched — it is label-grade and stays `rules`. Only the
 * negative is re-asked, so recall can rise and never fall. The known cost is precision
 * on exactly this channel: M.O.M's editorial is commentary about other brands'
 * campaigns, the documented false-alarm class. That trade is acceptable for the same
 * three reasons the frame-escalation trade was: it is the recall-protecting direction,
 * the cross on /paid-posts makes every escalation reversible, and with `singleTemplate`
 * ON a false CAMPAIGN never reaches message copy.
 */
const SECOND_LOOK_DETECTORS = new Set(['mom'])

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
  /**
   * Set when the SECOND LOOK ran — a rule-negative re-judged by the semantic model. The
   * caller needs these to store an honest row: the verdict is now the model's, so
   * `verdictSource`, confidence and the reason must be the model's too, not the rule's.
   * Null when the second look did not run or its call failed (a failed call is never a
   * verdict, and the rule's own answer stands).
   */
  secondLook: { confidence: number; reason: string; brands: string[] } | null
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
    secondLook: null,
  }

  /**
   * A person's answer outranks every model, and re-judging one would overwrite the only
   * labels that can ever measure recall on video-only placements. Checked FIRST so no
   * other branch can reach past it.
   */
  if (opts.humanLabelled) return { ...base, reason: 'human-labelled' }

  /**
   * WHOSE FEED THIS IS — derived ONCE and passed to BOTH classifier calls below.
   *
   * The both-or-neither rule that `tagText` documents applies identically: the post is judged
   * on its caption and again with its frame, and `applyFrameSignal` attributes any difference
   * to THE FOOTAGE. A publisher block reaching only one call would record a publisher-driven
   * change as a frame-driven one, corrupting the single number that says whether reading video
   * earns its keep. `tests/publisher-context.test.ts` greps both call sites for this.
   */
  const publisherText = input.publisherAsContext ? publisherForPrompt(input.caption, input.publisher) : null

  if (input.optedOut) return { ...base, reason: 'opted-out' }
  if (!FRAME_JUDGING_DETECTORS.has(input.detectorKey)) return { ...base, reason: 'unsupported' }

  /**
   * THE SECOND LOOK — see SECOND_LOOK_DETECTORS above. A rule-negative is re-asked of
   * the semantic model, caption first and ALONE (no frame prompt), exactly as a
   * semantic channel's caption verdict is produced — so the frame flow below then
   * differs from this call in exactly one input, which is what `applyFrameSignal`
   * attributes the difference to. The same tag block reaches both calls, per the
   * ordering constraint on `tagEvidence`.
   *
   * A failed call decides nothing: the rule's ORGANIC stands, and the signal names the
   * failure so the backfill can re-offer the post rather than filing it as judged —
   * `frame:call-failed` taught that lesson at a cost of 83 posts.
   */
  let secondLook: JudgeResult['secondLook'] = null
  const extraSignals: string[] = []
  if (SECOND_LOOK_DETECTORS.has(input.detectorKey) && captionOnly === 'ORGANIC') {
    const call = await classifyCaption(input.caption, input.shortcode, null, input.tagText ?? null, publisherText)
    if (call) {
      captionOnly = modelVerdictToStored(call.verdict)
      secondLook = { confidence: call.confidence, reason: call.reason, brands: call.brands }
      extraSignals.push('second-look:judged')
    } else {
      extraSignals.push('second-look:call-failed')
    }
    base.verdict = captionOnly
    base.secondLook = secondLook
    base.signals = extraSignals
  }

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
   * THE PUBLISHER'S OWN WATERMARK IS REMOVED BEFORE THE FOOTAGE BECOMES EVIDENCE.
   *
   * Applied to the PROMPT, so the classifier never sees the channel's own logo presented as
   * a brand in shot — and applied here rather than in `ocr.ts` so the stored `frameText`
   * still records everything that was actually read. What we READ and what we treat as
   * EVIDENCE are different facts, and this repo has paid for collapsing them before.
   *
   * When nothing survives the strip there is no footage evidence at all, so the flow takes
   * the same path as a frame with no text — through `applyFrameSignal`, which is the one
   * writer of the reasoning about why the footage did not speak.
   */
  const evidencePrompt = frame.prompt ? stripOwnMarksFromFrame(frame.prompt, input.publisher) : frame.prompt

  /**
   * No prompt means nothing to add to the caption. The verdict is re-derived through
   * `applyFrameSignal` ANYWAY, passing the caption verdict as both arguments, so the
   * signal recording WHY the footage did not speak is produced by the permission table
   * rather than invented here. One writer of that reasoning, not two.
   */
  if (!evidencePrompt) {
    const outcome = applyFrameSignal(captionOnly, captionOnly, frame.evidence)
    /**
     * `frame:only-own-marks` when the frame HAD text and all of it was the publisher's own.
     * Distinct from "no text found", because they are different facts with different
     * meanings — the five-states lesson from `framesRead`, one modality along.
     */
    const stripped = frame.prompt ? ['frame:only-own-marks'] : []
    return {
      ...base,
      verdict: outcome.verdict,
      signals: [...extraSignals, ...outcome.signals, ...stripped],
      frameText: frameTextSummaryLine(frame.text),
      frameSummary: frameTextSummaryLine(frame.text),
      engine,
    }
  }

  const withFrameCall = await classifyCaption(input.caption, input.shortcode, evidencePrompt, input.tagText ?? null, publisherText)

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
      signals: [...extraSignals, 'frame:call-failed'],
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
    signals: [...extraSignals, ...outcome.signals],
    frameText: summary,
    frameSummary: summary,
    engine,
    changedByFrame: outcome.verdict !== captionOnly,
    reason: 'judged',
    secondLook,
  }
}
