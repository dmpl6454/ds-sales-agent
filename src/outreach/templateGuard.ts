import { distinctiveSlice } from './matching'
import { MIN_NEEDLE_CHARS } from './matching'

/**
 * PURE — may this text become the standard message?
 *
 * Since 2026-08-18 the template IS the whole message, verbatim: `composeForPair` sends
 * exactly these bytes with nothing prepended or appended (no greeting, no signature —
 * Tabish's instruction). So the floor is checked against the SAME text the recipient
 * receives, with the SAME `distinctiveSlice` the send guards ask. Writer and probe share
 * bytes; a re-implementation here (count paragraphs, measure lengths) would be a second
 * copy of the rule.
 *
 * The floor is REACHABLE FROM A TEXTAREA: `distinctiveSlice` needs a line of at least
 * `MIN_NEEDLE_CHARS` (40) to build the needle the composer read-back and the thread delta
 * both search for, and null from it refuses EVERY send in the system. "Make it shorter" —
 * the direction every editor pushes — is exactly the direction that trips it, and it would
 * present as a sending outage rather than a copy change, hours later, with nothing on
 * screen pointing at the edit. Hence the check lives at save.
 */
export type TemplateCheck = { ok: true } | { ok: false; reason: string }

export function checkTemplateBody(middle: string): TemplateCheck {
  const trimmed = middle.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The message is empty. Nothing would be sent.' }
  }

  /**
   * The template is PLAIN TEXT by contract — nothing varies per message any more, and
   * nothing is substituted into it. A `{{token}}` in this box would reach a recipient as
   * literal braces: the quality gate that catches surviving placeholders guards
   * GENERATED copy, not this path.
   */
  if (/\{\{|\}\}/.test(trimmed)) {
    return {
      ok: false,
      reason:
        'No {{placeholders}} here — nothing is substituted into the standard message, ' +
        'and anything in braces would be sent to a real person as-is.',
    }
  }

  if (distinctiveSlice(trimmed) === null) {
    return {
      ok: false,
      reason:
        `Too short to send safely. At least one line must stay over ` +
        `${MIN_NEEDLE_CHARS} characters — the send guards quote a line back from the ` +
        `conversation to prove a message was delivered, and this text has no line long ` +
        `enough to quote. Saving it would refuse every send in the system.`,
    }
  }

  return { ok: true }
}
