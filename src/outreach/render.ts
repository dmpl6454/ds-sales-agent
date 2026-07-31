import { readStringArray } from '@/lib/json'

/**
 * Message rendering.
 *
 * Two hard rules:
 *
 *  1. The persona block (name, title, phone, email) is reproduced verbatim in
 *     every message. It is who we are; it never varies.
 *  2. Everything else varies. Twelve hand-written variants are rotated
 *     least-recently-used, because identical bodies sent from three accounts are
 *     both a duplicate-content signal to Meta and visibly clumsy when one
 *     recipient receives two of them.
 *
 * The greeting name is per-recipient. There is no shared fallback first name —
 * "Sumeet" in the original draft was a placeholder, and guessing a real person's
 * name is worse than addressing the brand.
 */

export interface RenderPersona {
  personaName: string
  personaRole: string
  personaBrand: string
  personaPhone: string
  personaEmail: string
}

/** "Kapil Jain, Co-founder of Bollywood Society" — the opening line. */
export function introLine(p: RenderPersona): string {
  return `I'm ${p.personaName}, ${p.personaRole} of ${p.personaBrand}.`
}

/** "Co-founder, Bollywood Society" — the signature line. */
export function signatureTitle(p: RenderPersona): string {
  return `${p.personaRole}, ${p.personaBrand}`
}

export interface RenderTarget {
  handle: string
  displayName: string
  contactFirstName: string | null
}

export interface RenderHookSource {
  /** JSON string[] as stored on DetectedCampaign.brands */
  brands: string
  postedAt: Date
  verdict: string
}

export interface RenderResult {
  body: string
  hookLine: string | null
}

/** "Hi Sumeet," when we know the name, otherwise address the publication. */
export function buildGreeting(target: RenderTarget): string {
  const name = target.contactFirstName?.trim()
  if (name) return `Hi ${name},`
  return `Hi ${target.displayName} team,`
}

/**
 * A single line referencing what we actually observed on their feed. This is the
 * difference between a cold pitch and an informed one, and it is the entire
 * reason detection exists in Phase 1.
 *
 * Returns null when there is nothing concrete to say — an invented hook is worse
 * than none, so the message simply omits the line.
 */
export function buildHookLine(hook: RenderHookSource | null): string | null {
  if (!hook || hook.verdict !== 'CAMPAIGN') return null

  const brands = readStringArray(hook.brands)
    .map((b) => b.replace(/^@/, ''))
    .filter((b) => b.length > 1)

  if (brands.length === 0) return null

  const named = brands.slice(0, 2).map(prettifyBrand)
  const list = named.length === 2 ? `${named[0]} and ${named[1]}` : named[0]

  return `I noticed your recent branded collaboration with ${list} — nicely executed.`
}

/**
 * "RoyalCanin" -> "Royal Canin" · "TheLeela" -> "The Leela" · "Tilara" -> "Tilara"
 *
 * Handles that survive as all-lowercase (no properly-cased hashtag existed in
 * the caption to upgrade from) are at least capitalised, so a message never
 * reads "collaboration with theleela".
 */
export function prettifyBrand(raw: string): string {
  let cleaned = raw.replace(/^@/, '').replace(/[._]+/g, ' ').trim()
  if (cleaned.length === 0) return cleaned

  // Brands glue connectives into CamelCase: "BlackandWhiteNonAlc". Split a
  // lowercase connective that sits between a lowercase letter and a capital, so
  // it becomes "Black and White Non Alc" rather than "Blackand White Non Alc".
  // Anchoring on the following capital keeps "FanStandardTime" ("St-and-ard")
  // and "Brandon" safe.
  cleaned = cleaned.replace(/([a-z])(and|of|the|for|with)([A-Z])/g, '$1 $2 $3')

  if (cleaned.includes(' ')) {
    return cleaned
      .split(/\s+/)
      .map((w) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // Interior connectives read better lowercase: "Black and White", not
      // "Black And White". Never the first word.
      .replace(/(?!^)\b(And|Of|The|For|With)\b/g, (m) => m.toLowerCase())
  }
  // Leave all-caps acronyms (SKF, HDFC) intact.
  if (/^[A-Z0-9]+$/.test(cleaned)) return cleaned
  if (!/[A-Z]/.test(cleaned)) return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return cleaned.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/**
 * Assemble the final message.
 *
 * `variantBody` is hand-written prose stored in MessageVariant. It may contain
 * {{brand}} which is substituted when a hook brand is known and stripped
 * gracefully when it is not.
 */
export function renderMessage(args: {
  persona: RenderPersona
  target: RenderTarget
  variantBody: string
  hook: RenderHookSource | null
}): RenderResult {
  const { persona, target, variantBody, hook } = args
  const hookLine = buildHookLine(hook)

  const brands = hook ? readStringArray(hook.brands).map((b) => prettifyBrand(b)) : []
  const firstBrand = brands[0] ?? null

  /**
   * `{{channel}}` is what the recipient is called INSIDE the message, so it must use
   * the same name as the greeting — not `displayName`, which is our internal label
   * and can carry anything the operator typed. Adding a target called "Bollywood
   * Chronicle (test target)" produced the line "...I'd like to discuss with Bollywood
   * Chronicle (test target): an annual collaboration", which is how an internal note
   * ends up in a stranger's inbox.
   *
   * `displayName` stays the fallback for the case where no greeting name was given.
   */
  const channelName = target.contactFirstName?.trim() || target.displayName

  const body = variantBody
    .replace(/\{\{\s*brand\s*\}\}/g, firstBrand ?? 'your brand partners')
    .replace(/\{\{\s*channel\s*\}\}/g, channelName)
    .trim()

  const parts = [
    buildGreeting(target),
    '',
    introLine(persona),
    ...(hookLine ? [hookLine] : []),
    '',
    body,
    '',
    'Looking forward to connecting.',
    '',
    persona.personaName,
    signatureTitle(persona),
    persona.personaPhone,
    persona.personaEmail,
  ]

  return { body: parts.join('\n').replace(/\n{3,}/g, '\n\n'), hookLine }
}

/**
 * Guards against a malformed persona reaching a real recipient. The phone number
 * in the original brief was 11 digits ("+91 60000 189766") where Indian mobiles
 * are 10 — the kind of error that would otherwise appear in every single message.
 */
export function validatePersona(p: RenderPersona): string[] {
  const problems: string[] = []

  const digits = p.personaPhone.replace(/\D/g, '')
  // +91 followed by a national number starting 6–9.
  //
  // 10 digits is the standard Indian mobile length. 11 is also accepted because
  // Kapil's number (+91 60000 189766) was confirmed correct as written — some
  // virtual/business numbers carry an extra digit. Anything shorter, longer, or
  // starting outside 6–9 is a typo and still blocks the send, because this value
  // is reproduced in every outgoing message.
  if (!/^91[6-9]\d{9,10}$/.test(digits)) {
    problems.push(
      `personaPhone "${p.personaPhone}" is not a valid Indian number (+91 then 10-11 digits starting 6-9); got ${digits.length} digits after the country code`,
    )
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.personaEmail)) {
    problems.push(`personaEmail "${p.personaEmail}" is not a valid email`)
  }
  if (p.personaName.trim().length < 2) problems.push('personaName is empty')
  if (p.personaRole.trim().length < 2) problems.push('personaRole is empty')
  if (p.personaBrand.trim().length < 2) problems.push('personaBrand is empty')

  return problems
}
