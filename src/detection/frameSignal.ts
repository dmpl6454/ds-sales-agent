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
 * The consequence when this was written: a caption ORGANIC that the frame turned
 * commercial landed in REVIEW — surfaced on `/paid-posts` for a person, nothing asserted.
 *
 * SUPERSEDED 2026-08-17: Tabish removed the third state ("either a post is paid or
 * unpaid/ordinary, no in between"), so the escalation now lands on CAMPAIGN, and the cross on
 * `/paid-posts` — which writes a human ORGANIC through `labelPost` — is the corrective that
 * shipped with it. The reasoning is at the CAMPAIGN case below. What has NOT changed is the
 * direction: the footage may raise a caption ORGANIC, and may never clear, overturn or mint
 * anything else. And `judge.ts` is the only caller, so this table runs once per post.
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
      /**
       * ── THE THANE PATH, AND IT NOW LANDS ON CAMPAIGN (2026-08-17) ────────
       *
       * This returned REVIEW — "surfaced for a person rather than asserted, because no
       * harness measures a frame-driven CAMPAIGN yet". That caution was right while there
       * was a queue to surface into. Tabish removed the queue: *"either a post is paid or
       * unpaid/ordinary, no in between."*
       *
       * So the footage now MINTS a paid post, which is the one thing this table was
       * originally written to forbid. Three things make that the right trade rather than a
       * loosening, and they should be checked before anyone tightens it back:
       *
       *  1. It is the direction this project always picks. A missed paid post is invisible
       *     and unappealable; a false alarm is a row a person crosses off in one click.
       *  2. The corrective SHIPPED WITH IT. The cross on `/paid-posts` writes a human
       *     ORGANIC through `labelPost`, so a wrong escalation is one click from settled —
       *     which is exactly what the old REVIEW queue was for, minus the third state.
       *  3. The evidence is real. **18 of the 26 live REVIEW rows existed only because of
       *     this path**, including both founding cases — the Thane bus, whose frame reads
       *     `SWITCH` across the bumper, and the Sony game-show card. Sending those to
       *     ORGANIC instead would have thrown away the entire reason the OCR work exists.
       *
       * What is still true, and still measured by nothing: `ig:accuracy`'s labels are
       * caption-derived, so a frame-driven CAMPAIGN is scored by no harness. That is why
       * the signal below stays distinct — `frame:says-campaign` on a row whose caption said
       * ORGANIC is queryable, and it is the population any future measurement starts from.
       */
      return captionOnly === 'ORGANIC'
        ? { verdict: 'CAMPAIGN', signals: ['frame:escalated-to-campaign', 'frame:says-campaign'] }
        : { verdict: captionOnly, signals: ['frame:says-campaign'] }
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
