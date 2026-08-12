import type { Verdict } from '@/lib/constants'

/**
 * What reading the FRAME is allowed to do to a post's verdict.
 *
 * PURE, and exhaustive over the verdict union with a `never` binding — because this file
 * is the structural guarantee, not the comment above it. A fall-through return here would
 * turn every future verdict value into a silent permission, which is exactly the
 * `return { ok: true }` bug that made an unreadable conversation authorise a send.
 *
 * ── WHY A FRAME MAY ESCALATE AND MAY NOT DECIDE ─────────────────────────────
 *
 * The caption classifier is MEASURED: 98% correct, 100% recall, 93% precision against
 * @madovermarketing_mom's #Collaboration disclosure (n=51). Frame text is a NEW input to
 * that same classifier, and the harness's labels are caption-derived — so a verdict that
 * only the frame could have produced is covered by no measurement that exists yet.
 *
 * The honest consequence: when the caption alone reads as ordinary and the frame is what
 * turned the verdict commercial, the post lands in REVIEW — visible, on `/paid-posts`,
 * with the frame text quoted so a person can settle it in one look. That answer is then
 * recorded as `humanLabel`, and those answers are the only labels that can ever measure
 * recall on video-only placements. The mechanism produces its own measurement.
 *
 * It is deliberately NOT the more aggressive choice. CLAUDE.md's rule is "protect recall,
 * never trade it for precision — a missed paid post is invisible and unappealable, a false
 * alarm becomes a draft a human reads". REVIEW satisfies both halves: nothing is missed
 * (the post is surfaced) and nothing is asserted (no CAMPAIGN is claimed on unmeasured
 * evidence). Promoting frame-driven verdicts to CAMPAIGN is a decision to take once the
 * human answers exist to justify it, and `pnpm ig:vision-accuracy`'s successor is where
 * that number will come from.
 */

export type FrameEvidence =
  /** OCR ran and the classifier saw the text. `changedVerdict` is the interesting bit. */
  | { kind: 'read'; hadText: boolean }
  /** The frame was never saved — nothing was looked at. */
  | { kind: 'no-frame' }
  /** No OCR engine on this machine — nothing CAN be looked at. */
  | { kind: 'unavailable' }
  /** An engine ran and errored. */
  | { kind: 'failed' }

export interface FrameOutcome {
  verdict: Verdict
  /** Appended to the post's stored signals — the human-auditable "why". */
  signals: string[]
}

/**
 * `captionOnly` is the verdict the caption alone produced; `withFrame` is the verdict the
 * classifier produced having ALSO seen the frame text. Both are needed: the difference is
 * the only thing that identifies a frame-driven judgement, and it costs no extra call
 * because the caption-only verdict is already stored for every post in the corpus.
 */
export function applyFrameSignal(
  captionOnly: Verdict,
  withFrame: Verdict,
  evidence: FrameEvidence,
): FrameOutcome {
  switch (evidence.kind) {
    case 'no-frame':
      return { verdict: captionOnly, signals: ['frame:not-saved'] }
    case 'unavailable':
      return { verdict: captionOnly, signals: ['frame:no-ocr-engine'] }
    case 'failed':
      return { verdict: captionOnly, signals: ['frame:ocr-failed'] }
    case 'read':
      break
    default: {
      const exhaustive: never = evidence
      return exhaustive
    }
  }

  if (!evidence.hadText) {
    // A frame with no readable text is a REAL finding, not a failure — and it is also not
    // evidence of innocence. It simply adds nothing, so the caption verdict stands.
    return { verdict: captionOnly, signals: ['frame:no-text'] }
  }

  if (withFrame === captionOnly) {
    return { verdict: captionOnly, signals: ['frame:read-agreed'] }
  }

  // The frame changed the answer. What it is allowed to change it TO depends on which
  // direction it moved, and only one direction is permitted.
  switch (withFrame) {
    case 'CAMPAIGN':
      // The Thane path. Surfaced for a person rather than asserted, because no harness
      // measures a frame-driven CAMPAIGN yet.
      return captionOnly === 'ORGANIC' || captionOnly === 'REVIEW'
        ? { verdict: 'REVIEW', signals: ['frame:flagged-for-review', 'frame:says-campaign'] }
        : { verdict: captionOnly, signals: ['frame:says-campaign'] }
    case 'REVIEW':
      // Frame text introduced doubt about a post the caption was sure about. Doubt is
      // allowed to surface a post; it is never allowed to clear one.
      return captionOnly === 'ORGANIC'
        ? { verdict: 'REVIEW', signals: ['frame:flagged-for-review', 'frame:says-review'] }
        : { verdict: captionOnly, signals: ['frame:says-review'] }
    case 'ORGANIC':
      /**
       * THE FRAME MAY NEVER CLEAR A POST. Frame text saying "ordinary" about a post the
       * caption called paid is not a correction — it is one weak input disagreeing with a
       * measured one, and acting on it would silently lower recall, which is the one thing
       * this project refuses to trade. Recorded as a disagreement and nothing more.
       */
      return { verdict: captionOnly, signals: ['frame:disagreed-lower'] }
    case 'UNCLASSIFIED':
      // The call failed on the frame-text attempt. Keep what the caption established.
      return { verdict: captionOnly, signals: ['frame:no-verdict'] }
    default: {
      const exhaustive: never = withFrame
      return exhaustive
    }
  }
}
