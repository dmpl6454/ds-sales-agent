import { distinctiveSlice, messageMatchesOurs } from './matching'
import { buildGreeting, signatureBlock, CLOSING_LINE, type RenderPersona, type RenderTarget } from './render'

/**
 * The mechanical gate a GENERATED message must pass before anyone may send it.
 *
 * ── WHY MECHANICAL, AND WHY THIS IS THE HALF THAT MATTERS ─────────────────
 *
 * Phase 8 lets a model write the body. That is a real change in what reaches a prospect, and
 * the honest way to make it is to be explicit about what a machine can and cannot check.
 *
 * It CAN check: no placeholder survived, the length is in the range the hand-written copy
 * occupies, the persona block is exactly ours and appears exactly once, the greeting is the
 * one `buildGreeting` would have produced, every figure claimed is one we actually claim, and
 * the body is verifiable by `distinctiveSlice` — including that its needle does not also match
 * a message this recipient already has.
 *
 * It CANNOT check whether the prose is any good, and it CANNOT reliably check whether a
 * sentence about the recipient is true. That second limit is the important one and it is not
 * theoretical: a real generated message told Royal Canin *"your team already buys placement
 * across pet-focused pages"* — fluent, plausible, entirely invented, and containing no number
 * for a figure rule to catch. `PRIOR_KNOWLEDGE_PATTERNS` below catches the common shape of it
 * and will not catch a determined paraphrase.
 *
 * Nor can it check a claim about US. A second real generated message said *"we run a network of
 * owned pages in the pet and general interest space"* — to a pet-food brand, from a Bollywood
 * and entertainment network. Fluent, flattering, false, and containing nothing a rule can key
 * on. The figures are guarded because they are enumerable; what the network IS is not.
 *
 * So this is a FLOOR, not an endorsement. Generated copy still needs a person to read it
 * before `generateMessages` is turned on, and that is why `pnpm ig:generate` prints the whole
 * message rather than a verdict.
 *
 * ── EVERY BOUND HERE WAS MEASURED, NOT CHOSEN ─────────────────────────────
 *
 * Against the 25 hand-written bodies that already ship (12 channel variants, 6 brand
 * variants, 4 bespoke first touches, 2026-08-05):
 *
 *     middle    348-1031 chars, 3-4 non-empty lines, 58-181 words
 *     rendered  537-1220 chars
 *     needles   25 of 25 have one, and 0 cross-match another body from the same sender
 *
 * That last figure is what makes the needle checks satisfiable rather than aspirational:
 * good copy already passes them.
 *
 * ── NO VERDICT MEANS NO SEND ──────────────────────────────────────────────
 *
 * Every failure returns problems and the caller falls back to a hand-written variant. There is
 * deliberately no "warn and send anyway": a generated body that cannot be checked is exactly
 * the thing this gate exists to keep out of someone's inbox.
 */

/**
 * Figures we are entitled to claim, from the agency deck. Compared after normalising case and
 * internal spacing.
 *
 * THE MOST IMPORTANT CHECK IN THIS FILE. A model that writes "500+ pages" or "80M followers"
 * produces prose that reads perfectly and is a lie told to a prospect, and no length or
 * placeholder rule touches it. Every one of these appears in the hand-written copy today; the
 * list is derived from that copy rather than invented, so widening it is a deliberate act.
 */
export const APPROVED_FIGURES: readonly string[] = [
  '200+', // pages in the network
  '200',
  '100+',
  '169.2m', // followers, combined
  '75.6m', // instagram
  '93.6m', // facebook
  '300m', // views per day
  '30 crore', // the same figure in Indian units
  '10 billion', // views per month
]

/**
 * A number is a CLAIM when it carries a scale marker, or when it is large enough that it
 * cannot be a duration or a count of campaigns.
 *
 * "20 minutes" and "4 campaigns" appear in the hand-written copy and are not claims about
 * reach, so bare numbers under 1000 pass. Anything with M / K / crore / billion / % / + is a
 * claim and must be on the list.
 */
const CLAIM_PATTERN = /\d[\d,.]*\s*(?:%|\+|m\b|k\b|million|billion|crore|lakh)/gi
const BARE_NUMBER = /\b\d[\d,]*(?:\.\d+)?\b/g

/**
 * A scale word and whatever precedes it. THIS CLOSES THE HOLE THAT DIGITS LEFT OPEN.
 *
 * FOUND BY READING THE REAL GENERATED OUTPUT, 2026-08-05. Every figure rule above matches
 * DIGITS, so a claim spelled in words walked straight through the most important check in this
 * file. Verified by execution, all four of these passed a gate that was supposed to stop
 * exactly them:
 *
 *     "five hundred pages"        "eighty million followers"
 *     "two billion views a day"   "fifty crore views"
 *
 * What made it visible was a real message saying "under fifteen minutes" — harmless in itself,
 * and the reason to go and check whether the rule could see words at all. It could not. This
 * is the third time in this session that reading the rendered output found something no
 * assertion did.
 *
 * The rule: EVERY use of a scale word must, together with the token before it, be an approved
 * figure. "30 crore" and "10 billion" are; "eighty million" is not, because "eighty" is not a
 * digit and no approved figure spells its number out.
 */
const SCALE_WORD_CLAIM = /(\S+)\s+(hundred|thousand|million|billion|crore|lakh)\b/gi

/**
 * Placeholders a template or a model can leave behind.
 *
 * Checked against the RENDERED message, not the generated middle. `{{brand}}` and
 * `{{channel}}` are LEGITIMATE in a hand-written variant — that is what they are for, and
 * `renderMessage` substitutes them. Checking the middle would reject all 18 shipping variants
 * while a model's own `{{foo}}`, which no substitution knows about, sailed through rendering
 * into someone's inbox. Checking the output catches an unfilled placeholder whatever wrote it.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]*\}\}/, // {{brand}} — ours
  /\{[A-Za-z_][\w\s]*\}/, // {name} — single-brace templating
  /\[(?:insert|name|brand|channel|company|handle|your|x)\b[^\]]*\]/i, // [INSERT BRAND]
  /<(?:insert|name|brand|channel|company|placeholder)\b[^>]*>/i,
  /\b(?:TODO|TBD|XXX|LOREM IPSUM)\b/,
]

/**
 * Preambles a chat model emits around the thing it was asked for. Anchored to the start,
 * because "Here is" mid-body is ordinary English.
 */
const PREAMBLE_PATTERNS: readonly RegExp[] = [
  // Conversational openers. `\b` is safe here because each ends in a letter.
  /^\s*(?:sure|certainly|of course|okay|ok|as requested|absolutely|got it)\b/i,
  /^\s*here(?:'s|\u2019s| is| are)\b/i,
  /^\s*i(?:'ve|\u2019ve| have) (?:written|drafted|prepared)\b/i,
  // Labels. A trailing `\b` after a colon never matches — ':' and ' ' are both non-word
  // characters, so there is no boundary between them. Found by running the tests.
  /^\s*(?:draft|message|body|subject|response|output)\s*:/i,
]

export interface QualityProblem {
  code: string
  detail: string
}

export interface QualityVerdict {
  ok: boolean
  problems: QualityProblem[]
}

/**
 * Phrases that ASSERT WE KNOW SOMETHING about the recipient's business.
 *
 * FOUND BY READING A REAL GENERATED MESSAGE, 2026-08-05. Given `Observation: none. Do not
 * reference anything specific about them.` and the display name "Royal Canin India", the model
 * wrote:
 *
 *     "Your team already buys placement across pet-focused pages and lifestyle feeds to
 *      reach owners."
 *
 * Plausible, fluent, unsupported, and addressed to the people who would know. The prompt
 * already said *never guess at their business*; it guessed anyway, which is the whole reason a
 * mechanical check has to exist beside the instruction.
 *
 * These are only refused when there is NO observation. With one, a claim of prior knowledge is
 * grounded — the hand-written brand copy opens "You are already investing in placement on
 * entertainment publishers", which is true by construction for a brand we found inside a paid
 * post. The rule is not "never claim knowledge", it is "never claim knowledge you were not
 * given".
 *
 * A narrow phrase list catches the common shape and cannot catch the general case. That
 * limitation is stated in the module docblock rather than papered over.
 */
const PRIOR_KNOWLEDGE_PATTERNS: readonly RegExp[] = [
  /\byou(?:r team)?\s+(?:already|currently)\b/i,
  /\byou\s+are\s+already\b/i,
  /\b(?:i|we)\s+(?:noticed|saw|have seen|see that|understand that|know that)\b/i,
  /\byour\s+(?:recent|current|latest|ongoing)\b/i,
  /\bhaving\s+seen\b/i,
]

export interface QualityGateInput {
  /** The model's generated MIDDLE — the prose, before `renderMessage` wraps it. */
  generated: string
  /** What `renderMessage` produced from it. The thing that would actually be sent. */
  rendered: string
  persona: RenderPersona
  target: RenderTarget
  /**
   * Bodies this RECIPIENT already has. The needle must not match any of them, or the
   * post-send thread confirmation cannot tell the new message from the old one — the defect
   * measured and fixed on 2026-08-05, checked here so generation cannot reintroduce it.
   */
  priorBodies?: readonly string[]
  /**
   * Whether the generator was given a real observation about this recipient.
   *
   * When false, any claim of prior knowledge in the body was INVENTED, and this is the only
   * mechanical handle on the highest-risk category of invention. Defaults false — the safe
   * direction, so a caller that forgets it gets the stricter check.
   */
  hasObservation?: boolean
}

export const MIN_GENERATED_CHARS = 200
export const MAX_GENERATED_CHARS = 1400
export const MIN_GENERATED_LINES = 2
export const MAX_GENERATED_LINES = 8

export function checkGeneratedMessage(input: QualityGateInput): QualityVerdict {
  const { generated, rendered, persona, target, priorBodies = [], hasObservation = false } = input
  const problems: QualityProblem[] = []
  const add = (code: string, detail: string) => problems.push({ code, detail })

  const body = generated.trim()
  const lines = body.split('\n').filter((l) => l.trim().length > 0)

  // ── 1. shape ────────────────────────────────────────────────────────────
  if (body.length < MIN_GENERATED_CHARS) {
    add('too-short', `${body.length} characters; the hand-written bodies are 348-1031`)
  }
  if (body.length > MAX_GENERATED_CHARS) {
    add('too-long', `${body.length} characters; the hand-written bodies are 348-1031`)
  }
  if (lines.length < MIN_GENERATED_LINES || lines.length > MAX_GENERATED_LINES) {
    add('bad-shape', `${lines.length} paragraphs; the hand-written bodies have 3-4`)
  }

  // ── 2. nothing unfilled reaches the recipient ───────────────────────────
  for (const p of PLACEHOLDER_PATTERNS) {
    const m = rendered.match(p)
    if (m) add('placeholder', `left a placeholder: ${JSON.stringify(m[0].slice(0, 40))}`)
  }

  // ── 3. it is a message, not a chat reply about a message ────────────────
  if (PREAMBLE_PATTERNS.some((p) => p.test(body))) {
    add('preamble', `opens with a chat preamble: ${JSON.stringify(body.slice(0, 40))}`)
  }

  // ── 4. the persona is OURS, appears once, and the model did not write its own ──
  // Since 2026-08-07 the identity is the signature block alone — channel name, phone,
  // email — asked of the SAME function that renders it, so this check cannot drift from
  // what a recipient actually sees.
  const sigBlock = signatureBlock(persona)
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

  if (occurrences(rendered, sigBlock) !== 1) {
    add('persona-signature', `the rendered message contains the signature block ${occurrences(rendered, sigBlock)} times, expected exactly 1`)
  }
  if (occurrences(rendered, persona.personaPhone) !== 1) {
    add('persona-phone', `the phone number appears ${occurrences(rendered, persona.personaPhone)} times, expected exactly 1`)
  }
  if (occurrences(rendered, persona.personaEmail) !== 1) {
    add('persona-email', `the email appears ${occurrences(rendered, persona.personaEmail)} times, expected exactly 1`)
  }

  /**
   * The generated body is the MIDDLE only — `prisma/brandVariants.ts` says so to a human, and
   * this says it to a machine. A model asked for a DM will very often add its own sign-off,
   * and the result is two signatures, or worse a second contact detail that is not ours.
   */
  if (body.includes(persona.personaPhone)) add('body-has-phone', 'the generated body writes its own phone number')
  if (body.includes(persona.personaEmail)) add('body-has-email', 'the generated body writes its own email')
  if (body.toLowerCase().includes(CLOSING_LINE.toLowerCase())) {
    add('body-has-closing', 'the generated body writes its own closing line')
  }
  if (/^\s*(?:best|regards|thanks|sincerely|warm regards|cheers)\b/im.test(body)) {
    add('body-has-signoff', 'the generated body writes its own sign-off')
  }
  // The retired "I'm <name>, <role> of <brand>." shape — renderMessage stopped emitting
  // it on 2026-08-07, so a model writing one is inventing an identity we no longer use.
  if (/^i'?m\s[^,]{2,60},\s.{2,60}\sof\s.{2,80}\.$/im.test(body)) {
    add('body-has-intro', 'the generated body writes its own introduction line')
  }

  // ── 5. the greeting is the one buildGreeting would produce ──────────────
  const expectedGreeting = buildGreeting(target)
  if (!rendered.startsWith(expectedGreeting)) {
    add('greeting', `the message must open with ${JSON.stringify(expectedGreeting)}`)
  }
  /**
   * A company addressed as an individual is the defect that reached the live database once
   * already ("Hi Amazon India,"). The model must not write a greeting at all.
   */
  if (/^\s*(?:hi|hello|hey|dear|greetings|namaste)\b/i.test(body)) {
    add('body-has-greeting', 'the generated body writes its own greeting; renderMessage supplies it')
  }

  // ── 6. every figure claimed is one we claim ─────────────────────────────
  const normaliseFigure = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const approved = new Set(APPROVED_FIGURES.map(normaliseFigure))
  for (const m of body.matchAll(CLAIM_PATTERN)) {
    if (!approved.has(normaliseFigure(m[0]))) {
      add('unapproved-figure', `claims ${JSON.stringify(m[0].trim())}, which is not one of our figures`)
    }
  }
  /** A bare number in the thousands cannot be a duration; treat it as a claim too. */
  for (const m of body.matchAll(BARE_NUMBER)) {
    const value = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(value) && value >= 1000 && !approved.has(normaliseFigure(m[0]))) {
      add('unapproved-figure', `claims the figure ${JSON.stringify(m[0])}, which is not one of our figures`)
    }
  }
  /**
   * ...and the same claim spelled in WORDS, which every rule above is blind to.
   * "eighty million followers" was measured passing this gate before this check existed.
   */
  for (const m of body.matchAll(SCALE_WORD_CLAIM)) {
    const phrase = `${m[1]} ${m[2]}`
    if (!approved.has(normaliseFigure(phrase))) {
      add('unapproved-figure', `claims ${JSON.stringify(phrase)}, which is not one of our figures`)
    }
  }

  // ── 7. it claims to know nothing it was not told ────────────────────────
  if (!hasObservation) {
    for (const p of PRIOR_KNOWLEDGE_PATTERNS) {
      const m = body.match(p)
      if (m) {
        add(
          'unsupported-claim',
          `asserts prior knowledge of the recipient (${JSON.stringify(m[0])}) with no observation behind it`,
        )
        break
      }
    }
  }

  // ── 8. the send guards can verify it ────────────────────────────────────
  const needle = distinctiveSlice(rendered)
  if (needle === null) {
    /**
     * Both send guards search the page for this needle. No needle means the composer
     * read-back and the thread confirmation cannot fail, so the message must not exist.
     */
    add('unverifiable', 'no line is distinctive enough for the send guards to verify — the message could not be confirmed delivered')
  } else {
    for (const prior of priorBodies) {
      if (messageMatchesOurs(prior, rendered)) {
        add(
          'needle-collides',
          `its distinctive line also appears in a message this recipient already has, so the post-send check could match the older one`,
        )
        break
      }
    }
  }

  return { ok: problems.length === 0, problems }
}
