/**
 * Text matching between what we sent and what is on screen.
 *
 * Used by two places that both need the same judgement:
 *   - delivery confirmation — "did the message I typed actually appear?"
 *   - reply detection       — "is the last message in this thread one of mine?"
 *
 * Kept free of any browser dependency so the logic is testable on its own. It is
 * load-bearing for both: a false positive here means recording a send that never
 * happened, and a false negative means pitching someone who already replied.
 */

/** A needle shorter than this is too generic to prove anything. */
const MIN_NEEDLE_CHARS = 20

/**
 * Pick a chunk of a message unlikely to appear anywhere else on the page.
 *
 * Deliberately avoids the ends. The greeting repeats the contact's name, which also
 * renders in the thread header; the signature carries the phone number and email,
 * which can appear in profile chrome. A mid-body line is the part that only exists
 * because we wrote it.
 *
 * THE ENDS ARE EXCLUDED FROM THE FALLBACK TOO. They were not, and that was the whole
 * bug. The primary path correctly skipped the greeting, but any body whose longest
 * line was under 40 characters fell through to "longest line available" — which for a
 * short edited message IS the greeting. Both send guards then compared against text
 * that is on the page whether the message was delivered or not: the post-send check
 * could not fail, and a paste that lost everything after the greeting passed the
 * composer read-back. Reachable through the dashboard's edit box, and the 2026-07-31
 * 12:27 send took exactly that path.
 *
 * Returning null is the safe outcome — callers treat it as "not a match", so a send is
 * refused rather than falsely confirmed. `editAttemptBody` refuses to save a body that
 * yields null, so the operator hears about it at the edit rather than at the send.
 */
export function distinctiveSlice(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  // Which lines are body rather than envelope:
  //   4+ lines — drop the greeting and the last signature line
  //   2-3      — drop the greeting; there is no signature block to speak of
  //   1        — it is all we have, and a single line has no greeting structure
  const interior = lines.length >= 4 ? lines.slice(1, -1) : lines.length >= 2 ? lines.slice(1) : lines

  const long = interior.filter((l) => l.length > 40)
  if (long.length > 0) {
    return long[Math.floor(long.length / 2)]!.slice(0, 60)
  }

  const longest = [...interior].sort((a, b) => b.length - a.length)[0]
  return longest && longest.length >= MIN_NEEDLE_CHARS ? longest.slice(0, 60) : null
}

/** Whitespace-insensitive, case-insensitive containment. */
export function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Whether a block of text taken from the page corresponds to something we sent.
 *
 * Compares on a distinctive slice rather than the whole body: Instagram collapses
 * whitespace, linkifies URLs, and hides long messages behind "see more", any of
 * which breaks exact equality while leaving a mid-body sentence intact.
 */
export function messageMatchesOurs(pageText: string, ourBody: string): boolean {
  const needle = distinctiveSlice(ourBody)
  if (!needle) return false
  return normalise(pageText).includes(normalise(needle))
}

/** True when the page text matches any message we have sent on this thread. */
export function matchesAnyOfOurs(pageText: string, ourBodies: readonly string[]): boolean {
  return ourBodies.some((b) => messageMatchesOurs(pageText, b))
}
