import { normalise } from './matching'
import type { InboxRow } from './browser/inboxScan'

/**
 * WHO WROTE LAST? — PURE interpretation of an inbox row, kept out of the browser module
 * so the decision that halts a recipient is testable without a browser, the same split
 * as `assessRead` / `collectMessages`.
 *
 * The signals, all OBSERVED on @bollywoodchronicle's live inbox (2026-08-21):
 *
 *   ours last     "You sent an attachment."  /  "You: …"  — the You-prefix
 *   theirs last   the reply text itself ("Thank you for sharing your details…"),
 *                 "<FirstName> sent an attachment.", or "2 new messages" + Unread
 *
 * The expensive error direction is a FALSE REPLY — it halts every sender to that target
 * for seven days — so two guards sit in front of 'theirs-last':
 *
 *   1. The You-prefix test.
 *   2. A body-prefix test: a snippet that begins one of OUR delivered bodies is ours
 *      even without the prefix, in case Instagram ever renders our text sends as bare
 *      text. Costs nothing when the prefix test already answered.
 *
 * What this deliberately does NOT do: treat "theirs-last" as proof of a NEW reply. The
 * caller still skips rows whose reply is already recorded; this only reads the row.
 */

export type InboxRowVerdict = 'ours-last' | 'theirs-last' | 'noise'

/**
 * Instagram's own furniture, rendered where a snippet renders. Each of these was either
 * OBSERVED on the first live run (the "can't receive" notice was recorded as a reply for
 * @rajnieshduggall before this list existed) or is the same class one variant over. A
 * system notice is nobody's words: not ours, not theirs, never a reply.
 */
const SYSTEM_SNIPPETS: readonly RegExp[] = [
  /can't receive your message/i,
  /can't reply to this conversation/i,
  /can't message this account/i,
  /^invite sent$/i,
  /^active\b/i, // presence; also filtered at collection, kept here as the backstop
  /^\d+\s*[smhdw]$/i, // an age that slipped into the snippet slot
]

export function triageInboxRow(row: InboxRow, ourBodies: readonly string[]): InboxRowVerdict {
  const snippet = row.snippet.trim()
  if (snippet.length === 0) return 'noise'
  if (SYSTEM_SNIPPETS.some((p) => p.test(snippet))) return 'noise'
  if (/^you\b/i.test(snippet)) return 'ours-last'

  /* A snippet that IS the opening of one of our delivered bodies is ours, whatever the
     prefix fashion of the week. Compared normalised, prefix-wise, because snippets
     truncate: the snippet must open the body, not equal it. */
  const snipNorm = normalise(snippet.replace(/[…]+$/, ''))
  if (snipNorm.length >= 20) {
    for (const body of ourBodies) {
      if (normalise(body).startsWith(snipNorm)) return 'ours-last'
    }
  }
  return 'theirs-last'
}

/**
 * Is this snippet the reply's actual words, worth storing as `replyText`?
 * "2 new messages" and "<Name> sent an attachment." are STATES, not words — storing
 * them as the recipient's words would put system furniture in the one column that
 * exists to preserve what a human said. Those rows record a reply with NULL text and
 * the next full thread read backfills it (that path already exists).
 */
export function snippetIsReplyText(snippet: string): boolean {
  const t = snippet.trim()
  if (t.length === 0) return false
  if (/^\d+ new messages?$/i.test(t)) return false
  if (/sent an attachment\.?$/i.test(t)) return false
  if (/^liked a message$/i.test(t)) return false
  if (/reacted (to|with) /i.test(t)) return false
  return true
}

export interface TargetRef {
  id: string
  handle: string
  displayName: string | null
}

/**
 * Which target is this row's conversation with?
 *
 * Handle match first (some rows title the raw handle), then display name — and a
 * display-name match must be UNIQUE: two prospects sharing "LEGO" must not have one
 * halted on the other's reply. Ambiguity returns null and the row is reported for a
 * person instead of guessed at — existence is not identity, one screen over.
 */
export function matchInboxRowToTarget(displayName: string, targets: readonly TargetRef[]): TargetRef | null {
  const wanted = normalise(displayName)
  if (wanted.length === 0) return null

  const byHandle = targets.filter((t) => normalise(t.handle) === wanted)
  if (byHandle.length === 1) return byHandle[0]!

  const byName = targets.filter((t) => t.displayName != null && normalise(t.displayName) === wanted)
  if (byName.length === 1) return byName[0]!

  /**
   * The inbox titles rows with Instagram's REAL display name while many stored
   * `displayName`s are just the handle (the documented usableBrandName gap) — so
   * "India Gate Foods" failed both tests above against a row whose handle IS
   * `indiagatefoods`. Stripping separators from the title and demanding EXACT equality
   * with a handle is still an identity claim, not a guess: "Kama Ayurveda" does NOT
   * match `kamaayurvedaindia` and stays unmatched for a person, which is the
   * existence-is-not-identity direction.
   */
  const squashed = wanted.replace(/[\s._-]+/g, '')
  if (squashed.length >= 5) {
    const bySquashedHandle = targets.filter((t) => normalise(t.handle).replace(/[\s._-]+/g, '') === squashed)
    if (bySquashedHandle.length === 1) return bySquashedHandle[0]!
  }
  return null
}
