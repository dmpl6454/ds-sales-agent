import { isClosingLine, isEnvelopeLine } from '@/outreach/render'

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
 *
 * What counts as ENVELOPE lives in `render.ts`, because that is the file that emits it.
 * Importing it costs a dependency and buys the guarantee that the two cannot drift —
 * the alternative is a second list here that goes stale the first time a line is added
 * to a message, silently, in the direction that weakens both send guards.
 */

/**
 * A needle shorter than this is too generic to prove anything.
 *
 * Raised from 20 to 40 on 2026-08-04. 20 admitted `"Co-founder, Bollywood Society"`
 * (29 chars) and `"Looking forward to connecting."` (30) — both byte-identical in every
 * message this sender writes.
 */
export const MIN_NEEDLE_CHARS = 40

/** The longest needle worth carrying; Instagram truncates long messages behind "see more". */
const MAX_NEEDLE_CHARS = 60

/**
 * The lines of a message that only exist because we wrote THIS one.
 *
 * Two rules, and they are deliberately belt and braces, because this function has now
 * been wrong twice in the same way and each time the miss looked like a small gap:
 *
 *  1. STRUCTURAL — everything from the closing line onward is the signature block
 *     (name, title, phone, email), and the first line is the greeting. Both are dropped
 *     by position, which needs no pattern to be right.
 *  2. BY SHAPE — `isEnvelopeLine` recognises what `renderMessage` adds, wherever it
 *     sits. Position alone was never enough: the persona intro and the hook line are
 *     INTERIOR lines, so every positional rule ever written here walked straight past
 *     them.
 *
 * Dropping a prose line by mistake is safe (another is chosen, or null is returned and
 * the send is refused). Keeping an envelope line is not. So both rules err loose.
 */
export function proseLines(body: string): string[] {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  // A single line has no envelope structure to strip; it is all we have.
  if (lines.length < 2) return lines.filter((l) => !isEnvelopeLine(l))

  const closingAt = lines.findIndex(isClosingLine)

  // Drop the signature block. When the closing line is present that boundary is exact.
  // When it is absent — an edited body, which is the only way that happens — fall back
  // to dropping the last line, which is what this function has always done.
  let kept = closingAt === -1 ? lines : lines.slice(0, closingAt)
  kept = kept.slice(1) // the greeting
  if (closingAt === -1 && kept.length >= 3) kept = kept.slice(0, -1)

  return kept.filter((l) => !isEnvelopeLine(l))
}

/**
 * Pick a chunk of a message unlikely to appear anywhere else — on the page, OR in
 * another message from the same sender.
 *
 * That second clause is the whole point and it is what was missing. The needle is what
 * both send guards search for: the composer read-back before Enter, and the thread
 * confirmation after it. If the needle also occurs in a different message from this
 * sender then neither guard can fail, and the failure is invisible because the guards
 * still return true on the happy path.
 *
 * VERIFIED BY EXECUTION, 2026-08-04, twice over:
 *
 *   - a body whose prose lines are all short yielded the persona intro,
 *     `"I'm Kapil Jain, Co-founder of Bollywood Society."` (48 chars — it cleared the
 *     old 20-char minimum comfortably), which matched an unrelated second body;
 *   - with a hook present it yielded
 *     `"I noticed your recent branded collaboration with Royal Canin"` (60 chars),
 *     identical in every message about that campaign from any sender.
 *
 * CLAUDE.md recorded this bug as fixed *for the greeting* with a 20-character minimum.
 * A minimum cannot fix it: envelope lines are not short, they are shared. The fix is
 * which lines are ELIGIBLE, and there is now exactly one selection path — the previous
 * version had a primary path that excluded the ends and a fallback that did not, which
 * is how a fix and its own reintroduction shipped in the same function.
 *
 * Returning null is the safe outcome — callers treat it as "not a match", so a send is
 * refused rather than falsely confirmed. `editAttemptBody` refuses to save a body that
 * yields null, so the operator hears about it at the edit rather than at the send.
 */
export function distinctiveSlice(body: string): string | null {
  const candidates = proseLines(body).filter((l) => l.length >= MIN_NEEDLE_CHARS)
  if (candidates.length === 0) return null
  return candidates[Math.floor(candidates.length / 2)]!.slice(0, MAX_NEEDLE_CHARS)
}

/** Whitespace-insensitive, case-insensitive containment. */
export function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * How many times `needle` occurs in `haystack`, normalised, counting non-overlapping hits.
 *
 * Exists for `bodyAppearedSince` below, which needs a COUNT rather than a boolean. Kept
 * separate and exported so the counting itself is testable — `indexOf` in a loop without
 * advancing past the match is an infinite loop, and an off-by-one here would silently
 * weaken the strongest post-send guard in the system.
 */
export function countOccurrences(haystack: string, needle: string): number {
  const h = normalise(haystack)
  const n = normalise(needle)
  if (n.length === 0) return 0
  let from = 0
  let seen = 0
  for (;;) {
    const at = h.indexOf(n, from)
    if (at === -1) return seen
    seen += 1
    from = at + n.length
  }
}

/**
 * Did OUR message NEWLY appear in the thread — comparing the thread before we typed
 * anything against the thread after pressing Enter?
 *
 * ── WHY A DELTA AND NOT `messageMatchesOurs` ──────────────────────────────
 *
 * The post-send confirmation used `messageMatchesOurs(wholePage, body)`, i.e. *is the
 * needle present*. Presence is a property of the whole conversation, and the conversation
 * already holds everything we sent before. So an earlier message of ours carrying the SAME
 * needle satisfies the check on its own, and the guard cannot fail — the message may never
 * have appeared and we record SENT.
 *
 * That is the identical mistake this file has now made twice, one level up each time:
 *
 *   1st  the check read the whole page, and our text sits in the COMPOSER whether Enter
 *        worked or not. Fixed by also requiring the composer to clear.
 *   2nd  the check reads the whole page, and our text sits in an EARLIER BUBBLE whenever a
 *        needle repeats. Fixed here.
 *
 * Both times the lesson was the one in CLAUDE.md: *check the thing that changes, not the
 * thing that is there either way.* A count that must increase is a delta and cannot be
 * satisfied by history.
 *
 * VERIFIED BY EXECUTION, 2026-08-05, against the live database. Variants are chosen by an
 * LRU scoped to the SENDER, so nothing stops one pair being handed the same variant twice:
 * **8 of 11 pairs had already reused one**, one of them five times. Building a thread out
 * of an earlier attempt alone and asking the old guard about a LATER attempt returned
 * `true` — a confirmed delivery for a message that was not there. The two bodies were not
 * even identical (different hook lines); a shared needle is enough.
 *
 * It is LATENT rather than live today: only 6 messages have ever been delivered, and no
 * delivered message yet shares a needle with a later one on the same pair (measured: 0).
 * The reuse is in SKIPPED drafts, which never reach a thread. It becomes live on the first
 * follow-up that repeats a needle, which is why it is fixed before the fleet grows.
 *
 * ── THE DIRECTIONS, BOTH DELIBERATE ───────────────────────────────────────
 *
 * A body with no needle returns false — refuse rather than falsely confirm, exactly as
 * `messageMatchesOurs` does, and the reason `distinctiveSlice` returning null is safe.
 *
 * If the composer already held a stale draft when `threadBefore` was read, its text is
 * counted there, so `before` is one too high and this returns false. That is the safe
 * direction: the send parks as `not-in-thread`, which is VISIBLE on `/messages` with the
 * two buttons that settle it, rather than being recorded as delivered.
 */
export function bodyAppearedSince(threadBefore: string, threadAfter: string, ourBody: string): boolean {
  const needle = distinctiveSlice(ourBody)
  if (!needle) return false
  return countOccurrences(threadAfter, needle) > countOccurrences(threadBefore, needle)
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

/**
 * Is this ONE BUBBLE in a thread something we sent?
 *
 * ── WHY THIS IS NOT `matchesAnyOfOurs`, WHICH IS WHAT IT USED TO BE ───────
 *
 * `messageMatchesOurs` answers with a needle, and returns false when a body yields none.
 * For the SEND guards that is the safe direction and the whole design: a body we cannot
 * verify must not be sent, so `null` means refuse.
 *
 * Reading a thread asks the same question with the safe direction REVERSED. "Not ours"
 * there means "the recipient said this", so an unverifiable body becomes a REPLY — which
 * halts every sender to that target. One function was serving two callers whose failure
 * directions are opposites, and it silently gave one of them the wrong default.
 *
 * OBSERVED IN PRODUCTION 2026-08-05, not reasoned about. The automatic reply check read
 * @tabishmukaddam1's thread with @bollywoodchronicle and recorded a reply of:
 *
 *     "Hi Bollywood Chronicle,\n\nThis is a test message."
 *
 * — byte-identical to our own `renderedBody` on the attempt it then marked REPLIED. The
 * body has two lines; `distinctiveSlice` excludes the ends and requires 40 characters, so
 * it returned null, so `messageMatchesOurs(body, body)` was **false**. A message did not
 * match itself, and outreach to that target was halted by our own words.
 *
 * ── WHAT THIS DOES INSTEAD ────────────────────────────────────────────────
 *
 * Here we hold BOTH complete strings, so exact normalised equality is available and is
 * strictly stronger evidence than a needle. The needle exists because a thread bubble may
 * not render byte-for-byte; it is kept as the last resort rather than the only one.
 *
 * The prefix rule carries a 40-character floor for the reason the greeting keeps teaching
 * this codebase: a bubble containing only "Hi Bollywood Chronicle," must never count as
 * one of our messages, because that text is present whether anything was delivered or not.
 */
export function isOneOfOurs(bubbleText: string, ourBodies: readonly string[]): boolean {
  const bubble = normalise(bubbleText)
  if (bubble.length === 0) return false

  return ourBodies.some((body) => {
    const ours = normalise(body)
    if (ours.length === 0) return false

    // 1. The same message. Available here and not in the send guards, and conclusive.
    if (ours === bubble) return true
    // 2. The bubble carries our body plus surrounding chrome (a timestamp, "Sent").
    if (bubble.includes(ours)) return true
    // 3. Instagram truncated it behind "… see more", so the bubble is a PREFIX of ours.
    //    Floored at 40 characters so a greeting alone can never satisfy it.
    if (bubble.length >= MIN_NEEDLE_CHARS && ours.startsWith(bubble)) return true
    // 4. Last resort: a distinctive mid-body line survived a rendering we did not expect.
    return messageMatchesOurs(bubbleText, body)
  })
}
