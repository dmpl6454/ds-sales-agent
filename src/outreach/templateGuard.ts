import { renderMessage } from './render'
import { distinctiveSlice } from './matching'
import { MIN_NEEDLE_CHARS } from './matching'

/**
 * PURE — may this text become the standard message's middle?
 *
 * The standard template is editable from /settings since 2026-08-17 (Tabish asked for a
 * template editor). That makes the mechanical floor documented on `SINGLE_TEMPLATE_MIDDLE`
 * REACHABLE FROM A TEXTAREA: `proseLines` drops the first line by position and
 * `distinctiveSlice` needs a surviving line of MIN_NEEDLE_CHARS, and null from it refuses
 * EVERY send in the system. "Make it shorter" — the direction every editor pushes — is
 * exactly the direction that trips it, and it would present as a sending outage rather
 * than a copy change, hours later, with nothing on screen pointing at the edit.
 *
 * So the floor is checked AT SAVE, by rendering a real sample body through the SAME
 * `renderMessage` the composer uses and asking the SAME `distinctiveSlice` the send
 * guards ask. Writer and probe share bytes; a re-implementation here (count paragraphs,
 * measure lengths) would be a second copy of the rule, and the documented table exists
 * precisely because the obvious re-implementation gets it wrong — the property is line
 * LENGTH after position-based drops, not paragraph count.
 *
 * The persona and target below are FIXTURES, not real rows: rendering needs shapes, and
 * the floor is a property of the template, not of who it is addressed to. The BRAND kind
 * is used because brand rendering adds no hook line — the barest render this template
 * will ever get, so a template that passes here passes everywhere.
 */
const SAMPLE_PERSONA = {
  personaName: '',
  personaRole: '',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const SAMPLE_TARGET = {
  handle: 'crocsindia',
  displayName: 'Crocs India',
  contactFirstName: null,
  kind: 'BRAND',
}

export type TemplateCheck = { ok: true } | { ok: false; reason: string }

export function checkTemplateBody(middle: string): TemplateCheck {
  const trimmed = middle.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The message is empty. Nothing would be sent.' }
  }

  /**
   * The single template is PLAIN TEXT by contract — exactly two things vary per message
   * (the recipient's name and the sending page's name) and both are added by the
   * renderer, not typed here. A `{{token}}` in this box would reach a recipient as
   * literal braces: the quality gate that catches surviving placeholders guards
   * GENERATED copy, not this path.
   */
  if (/\{\{|\}\}/.test(trimmed)) {
    return {
      ok: false,
      reason:
        'No {{placeholders}} here — the recipient\'s name and your page name are added ' +
        'automatically, and anything in braces would be sent to a real person as-is.',
    }
  }

  const { body } = renderMessage({
    persona: SAMPLE_PERSONA,
    target: SAMPLE_TARGET,
    variantBody: trimmed,
    hook: null,
  })

  if (distinctiveSlice(body) === null) {
    return {
      ok: false,
      reason:
        `Too short to send safely. At least one paragraph must stay over ` +
        `${MIN_NEEDLE_CHARS} characters — the send guards quote a line back from the ` +
        `conversation to prove a message was delivered, and this text has no line long ` +
        `enough to quote. Saving it would refuse every send in the system.`,
    }
  }

  return { ok: true }
}
