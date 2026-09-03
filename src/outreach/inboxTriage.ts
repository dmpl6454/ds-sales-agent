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

/**
 * PURE. May this row record a reply, given what this PAIR already has recorded?
 *
 * The inbox row describes ONE sender's thread. The first version attached each sighting
 * to "the newest delivered attempt for the TARGET with no reply yet" — so a state row
 * like "MedLinks sent an attachment." re-recorded on EVERY sweep, walking down the
 * target's attempt list one per run (measured across two live runs, 2026-08-21:
 * @medlinkstrichology went from 3 genuine thread-records to 5). The rule:
 *
 *   - a pair with NO recorded reply records (first sighting of this thread's state);
 *   - a pair that HAS one records again only for genuinely NEW TEXT — a fresh message,
 *     not the same state re-observed. State snippets ("2 new messages", "…sent an
 *     attachment") can never be "new" twice.
 */
export function shouldRecordInboxReply(args: {
  snippet: string
  /** replyText of every reply already recorded on THIS (sender → target) pair. */
  pairReplyTexts: readonly (string | null)[]
}): boolean {
  if (args.pairReplyTexts.length === 0) return true
  if (!snippetIsReplyText(args.snippet)) return false
  const snip = normalise(args.snippet.replace(/[…]+$/, ''))
  if (snip.length === 0) return false
  return !args.pairReplyTexts.some((t) => {
    const kn = normalise(t ?? '')
    return kn.length > 0 && (kn.startsWith(snip) || snip.startsWith(kn))
  })
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

/**
 * The thread id inside any `/direct/t/<id>` URL — relative (`/direct/t/123/`) or absolute
 * (`https://www.instagram.com/direct/t/123`), trailing slash or not. `sendDm` stores
 * `page.url()` and the inbox row carries an href, so the two spellings differ and only the
 * id is comparable. Null for anything that is not a thread URL.
 */
export function threadIdFrom(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /\/direct\/t\/(\d+)/.exec(url)
  return m ? m[1]! : null
}

/**
 * Which target is this row's conversation with — BY THE THREAD FIRST, then by name.
 *
 * The thread id is the conversation's identity: `byThreadId` is built from this sender's
 * own delivered messages (`OutreachAttempt.threadUrl`), so a hit is the exact pair we wrote
 * to, whatever the row is titled. MEASURED 2026-09-03: 84 live prospects store the raw
 * handle as `displayName`, so "Nykaa" (@mynykaa) and "Maybelline New York - India"
 * (@maybelline_ind) failed every name test above while their replies sat unread for a week;
 * all 172 messages delivered to those 84 carry a threadUrl. A row with no link, or a link we
 * never wrote to, falls back to the name rules — a stranger's inbound row is still reported
 * for a person rather than guessed at.
 */
export function matchInboxRow(
  row: { displayName: string; threadUrl: string | null },
  targets: readonly TargetRef[],
  byThreadId: ReadonlyMap<string, TargetRef>,
): TargetRef | null {
  const id = threadIdFrom(row.threadUrl)
  if (id) {
    const hit = byThreadId.get(id)
    if (hit) return hit
  }
  return matchInboxRowToTarget(row.displayName, targets)
}
