import { distinctiveSlice } from './matching'
import { MIN_NEEDLE_CHARS } from './matching'
import { FOLLOW_UP_POST_TOKEN, renderFollowUp, SHORTEST_POST_REFERENCE } from './followUpTemplate'

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

/**
 * PURE — may this text become the FOLLOW-UP message? (2026-09-01)
 *
 * A separate function from `checkTemplateBody` rather than a flag on it, because the two
 * disagree about the single most important character in the box: the standard message
 * refuses EVERY `{{token}}` (nothing is substituted into it, so braces would reach a real
 * person as braces), and the follow-up REQUIRES exactly one.
 *
 * Three refusals, and each is a fleet-wide outage this catches at the textarea instead of
 * hours later with nothing on screen pointing at the edit:
 *
 *   no `{{post}}`        every follow-up from a page would carry identical bytes, so
 *                        follow-up #2 would be held by `IDENTICAL_TO_A_SENT_MESSAGE` — the
 *                        exact wall the follow-up exists to release, rebuilt one storey up.
 *   any other brace      literal braces in a stranger's inbox.
 *   no quotable line     `distinctiveSlice` returns null and null refuses EVERY send in the
 *                        system, naming no cause. This is the failure `checkTemplateBody`
 *                        was written for, and "make it shorter" is the direction every
 *                        editor pushes.
 *
 * ── IT VALIDATES THE RENDERED TEXT, AT THE WORST CASE ─────────────────────────
 *
 * Writer and probe share bytes: this runs the REAL `renderFollowUp` and the REAL
 * `distinctiveSlice`, exactly what the composer and the send guards will do. And it renders
 * with `SHORTEST_POST_REFERENCE` on purpose — the needle fails by having no line of 40+
 * characters LEFT, so the shortest substitution is the conservative bound. A body that
 * survives it survives every real post reference.
 */
export function checkFollowUpBody(body: string): TemplateCheck {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The follow-up message is empty. Nothing would be sent.' }
  }

  if (!trimmed.includes(FOLLOW_UP_POST_TOKEN)) {
    return {
      ok: false,
      reason:
        `The follow-up must mention the paid post it is for. Put ${FOLLOW_UP_POST_TOKEN} where the ` +
        `post should be named — it becomes something like “${SHORTEST_POST_REFERENCE.replace('@x', '@viralbhayani')}”. ` +
        `Without it every follow-up from a page is word for word the same, and Instagram silently ` +
        `drops the second one.`,
    }
  }

  /* Every OTHER brace. The token is removed first, so the rule is "exactly this one and no more". */
  const withoutToken = trimmed.split(FOLLOW_UP_POST_TOKEN).join('')
  if (/\{\{|\}\}/.test(withoutToken)) {
    return {
      ok: false,
      reason:
        `${FOLLOW_UP_POST_TOKEN} is the only thing substituted here. Anything else in braces would be ` +
        `sent to a real person exactly as typed.`,
    }
  }

  if (distinctiveSlice(renderFollowUp(trimmed, SHORTEST_POST_REFERENCE)) === null) {
    return {
      ok: false,
      reason:
        `Too short to send safely. At least one line must stay over ${MIN_NEEDLE_CHARS} characters ` +
        `once the post is named — the send guards quote a line back from the conversation to prove ` +
        `a message was delivered, and this text has no line long enough to quote. Saving it would ` +
        `refuse every follow-up in the system.`,
    }
  }

  return { ok: true }
}
