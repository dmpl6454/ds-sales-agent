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

/**
 * Pick a chunk of a message unlikely to appear anywhere else on the page.
 *
 * Deliberately avoids the ends. The greeting repeats the contact's name, which
 * also renders in the thread header; the signature carries the phone number and
 * email, which can appear in profile chrome. A mid-body line is the part that
 * only exists because we wrote it.
 */
export function distinctiveSlice(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 40)

  if (lines.length === 0) {
    // No long line: fall back to the longest thing available, if it is usable.
    const longest = body
      .split('\n')
      .map((l) => l.trim())
      .sort((a, b) => b.length - a.length)[0]
    return longest && longest.length >= 15 ? longest.slice(0, 60) : null
  }

  const candidate = lines[Math.floor(lines.length / 2)] ?? lines[0]!
  return candidate.slice(0, 60)
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
