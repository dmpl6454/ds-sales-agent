import { env } from './env'

/**
 * The date this system starts caring about posts.
 *
 * Tabish, 2026-08-03: *"we do not need to go back several posts or weeks to detect the
 * paid posts. We start only from 1st august posts and onwards."*
 *
 * WHY THIS IS NOT A GLOBAL FILTER, AND MUST NOT BECOME ONE
 *
 * It applies in exactly two places, with different reasons:
 *
 *  1. **The classifier** (`ig:classify`, and the semantic detector) — do not spend money
 *     judging history. A post before the cutoff is simply never sent to the model, and it
 *     stays `UNCLASSIFIED`. That word already means *not judged*; it has never meant
 *     *organic*, and the distinction is one this codebase has broken twice.
 *
 *  2. **`unusedCampaignCount`** in the governor — an old post must not count as "new
 *     material" that unlocks a follow-up. A campaign from last year is not something new
 *     to say.
 *
 * Where it must NOT apply:
 *
 *  - **`buildVocabulary`.** The novelty filter learns how a channel writes from EVERY
 *    stored caption, and that baseline is what makes the free stage work: across 306
 *    @viralbhayani posts there are 262 distinct hashtags, 229 used exactly once.
 *    Restricting the baseline to post-cutoff captions would shrink it, make ordinary
 *    vocabulary look novel, and degrade the filter that saves 54% of the model spend.
 *    History is worth keeping precisely because it is history.
 *  - **Storage.** The pipeline keeps recording everything on every slot. A corpus is cheap
 *    and a missing one cannot be reconstructed.
 *
 * A CORRECTION WORTH KEEPING: at `HOOK_MAX_AGE_HOURS=72` from 3 August, the hook window
 * reaches back to 31 Jul 12:00 UTC — which is EARLIER than the cutoff (31 Jul 18:30 UTC =
 * 1 Aug 00:00 IST). So the cutoff is the BINDING constraint today, not a redundant
 * belt-and-braces check. Reading `hoursAgo(72)` and concluding "the cutoff cannot matter
 * yet" is wrong by six and a half hours, which is precisely the sort of near-miss an IST/UTC
 * boundary produces.
 */

/**
 * 2026-08-01 00:00 IST, expressed as UTC.
 *
 * IST, not UTC, because every other date boundary in this system is IST (`istDayStart`,
 * the slot times, the daily caps). A UTC midnight would put 1 August's small hours IST on
 * the wrong side of the line — a silent 5.5-hour discrepancy nobody would think to check.
 */
export const DETECTION_CUTOFF = new Date('2026-08-01T00:00:00+05:30')

/** Overridable, because a cutoff is a business decision and may move. */
export function detectionCutoff(): Date {
  const raw = process.env.DETECTION_CUTOFF
  if (!raw || raw.trim() === '') return DETECTION_CUTOFF
  const parsed = new Date(raw)
  // A malformed value must not silently become "no cutoff" — that would quietly re-open
  // the whole 399-post history to the classifier and to the new-material rule.
  return Number.isNaN(parsed.getTime()) ? DETECTION_CUTOFF : parsed
}

/** Is this post recent enough to judge, or to count as something new to say? */
export function withinCutoff(postedAt: Date): boolean {
  return postedAt.getTime() >= detectionCutoff().getTime()
}

/**
 * The hook-age floor, as a date, for the governor's new-material query.
 *
 * Returns whichever is LATER: the cutoff, or the hook-age window. Both bound the same
 * question — "is there anything new worth writing about?" — and taking the later of the two
 * means neither can be loosened by the other.
 */
export function newMaterialFloor(now: Date = new Date()): Date {
  const hookFloor = new Date(now.getTime() - env.HOOK_MAX_AGE_HOURS * 3_600_000)
  const cutoff = detectionCutoff()
  return hookFloor.getTime() > cutoff.getTime() ? hookFloor : cutoff
}
