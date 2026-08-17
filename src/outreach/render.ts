import { readStringArray } from '@/lib/json'
import { usableBrandName } from './usableName'

/**
 * Message rendering.
 *
 * Two hard rules:
 *
 *  1. The signature block (channel name, phone, email) is reproduced verbatim in
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

/**
 * The signature block — the whole identity a message carries, since 2026-08-07.
 *
 * Tabish: the persona is ONLY the channel name, with the contact details under it. The
 * previous shape introduced a person ("I'm Kapil Jain, Co-founder of Bollywood Society.")
 * and signed with their name and role; both are gone. Messages now open with the greeting
 * and sign off as the page itself:
 *
 *     Bollywood Society
 *     +91 60000 189766
 *     kapil@digitalsukoon.com
 *
 * ONE writer, and the gate's staleness probe uses THIS function — computed with the same
 * function that wrote the lines, never by comparing fields (the `checkPersonaDistinct`
 * lesson). `personaName`/`personaRole` still exist as columns and are deliberately no
 * longer rendered anywhere; a field the recipient never sees is also excluded from
 * `personaFingerprint` for the same reason.
 *
 * Typed as a Pick so a caller holding only the three rendered fields can probe without
 * inventing values for two fields the block does not use.
 */
export function signatureBlock(
  p: Pick<RenderPersona, 'personaName' | 'personaRole' | 'personaBrand' | 'personaPhone' | 'personaEmail'>,
): string {
  /**
   * ── THE NAME IS BACK (2026-08-17, Tabish's copy) ──────────────────────────
   *
   * On 2026-08-07 Tabish asked that "the persona needs to only be channel name", and the
   * name and role lines were removed. The standard message he supplied on 2026-08-17 signs
   * off with them again:
   *
   *     Kapil Jain
   *     Co-founder, {Sending Channel}
   *     +91 60000 189766
   *     kapil@digitalsukoon.com
   *
   * A recorded reversal, not a regression. Two consequences applied the same day so they
   * cannot drift:
   *
   *   - `personaFingerprint` takes `personaName` and `personaRole` back, because its own
   *     contract is that it "excludes nothing that appears in the message and includes
   *     nothing that does not". All four accounts share the name, so this does not weaken
   *     distinctness — the page name is still what separates them.
   *   - `validatePersona` checks the name and role again. A guard about a field no
   *     recipient sees is a guard about nothing; a field every recipient reads is the
   *     opposite.
   *
   * Still ONE writer, and the gate's staleness probe and the quality gate both call it, so
   * writer and probe share bytes.
   */
  return `${p.personaName}\n${p.personaRole}, ${p.personaBrand}\n${p.personaPhone}\n${p.personaEmail}`
}

export interface RenderTarget {
  handle: string
  displayName: string
  contactFirstName: string | null
  /**
   * Which pool this recipient's variant came from — and therefore what `{{brand}}` MEANS.
   *
   * Required rather than optional, so the compiler names every call site instead of one
   * silently defaulting to channel behaviour. That default is precisely the bug: see
   * `renderMessage` below.
   *
   * Typed `string` and not `TargetKind` for the same reason `ComposablePair` is: SQLite has
   * no enum, Prisma hands this column back as a plain string, and narrowing it here would
   * put a cast at every database boundary. A cast is the worse trade — it silences the
   * compiler permanently where the comparison below is a value check either way.
   */
  kind: string
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

/** The sign-off `renderMessage` appends. Everything after it is the signature block. */
export const CLOSING_LINE = 'Looking forward to connecting.'

/**
 * The lines `renderMessage` wraps around the prose — the ENVELOPE.
 *
 * Why this lives here rather than in `matching.ts`: this file is what emits them, so
 * this is the only place that can be authoritative. `distinctiveSlice` picks the needle
 * both send guards search for, and a needle taken from the envelope proves nothing —
 * every message from this sender carries the same intro, closing and signature, and
 * every message about one campaign carries the same hook line. Measured 2026-08-04: with
 * a short prose body the needle became `"I'm Kapil Jain, Co-founder of Bollywood
 * Society."` and matched a *different* message from the same sender, so the composer
 * read-back and the thread confirmation both became unfailable.
 *
 * **Err loose, never tight.** Wrongly classifying a prose line as envelope costs a
 * needle — `distinctiveSlice` picks another line, or returns null and the send is
 * refused. Missing an envelope line reinstates the tautology. The two directions are not
 * symmetric, so a pattern that is slightly greedy is the correct kind of wrong.
 *
 * If you add a line to `renderMessage`, add its pattern here. `tests/matching.test.ts`
 * renders a real message and asserts every envelope line it produced is recognised, so
 * forgetting fails the suite rather than silently weakening a guard.
 */
/**
 * A line that is a GREETING AND NOTHING ELSE — "Hi Sumeet," / "Hi Amazon India team,".
 *
 * Named and exported rather than left inline because `staleTemplate.ts` needs exactly this
 * question, and a second copy of the pattern is how one rule with several readers drifts —
 * the failure this codebase has now had four times (`gate.ts`, `readThread.ts`, the two
 * Connect buttons, `judge.ts`).
 *
 * Anchored on the trailing comma, which is what makes it usable as a staleness probe: the
 * CURRENT opener continues into `introLine` and ends in a full stop, so it cannot match. A
 * line that matches is therefore a greeting the old `[greeting, '', body]` join left standing
 * on its own — regardless of whether that greeting is still the one we would build today,
 * which matters because `usableBrandName` changed several of them.
 */
const GREETING_ONLY = /^(hi|hello|hey|dear|greetings|namaste)\b.{0,60},$/i

/** True when this line is a greeting standing alone, carrying no other prose. */
export function isGreetingOnlyLine(line: string): boolean {
  return GREETING_ONLY.test(line.trim())
}

const ENVELOPE_PATTERNS: readonly RegExp[] = [
  // buildGreeting — "Hi Sumeet," / "Hi Amazon India team,". Also renders in the thread
  // header, so it is present whether or not anything was delivered. Alternatives are
  // listed because an edited body may not use ours.
  GREETING_ONLY,
  // The RETIRED intro line — "I'm Kapil Jain, Co-founder of Bollywood Society." Dropped
  // from renderMessage 2026-08-07 (the persona is only the channel name now), and the
  // pattern is KEPT deliberately: messages already delivered and drafts written before
  // the change still carry it, and the rule above is err loose, never tight. Anchored on
  // the comma AND " of ", so prose openers such as "I'm reaching out to explore a
  // long-term strategic partnership..." (variant 1, which has no comma) are left alone.
  /^i'?m\s[^,]{2,60},\s.{2,60}\sof\s.{2,80}\.$/i,
  // buildHookLine — identical for every message about this campaign, from any sender.
  /^i noticed your recent branded collaboration with\b/i,
  // The closing line.
  /^looking forward to connecting\.?$/i,
  // Signature phone — seven or more digits and not a single letter. Written as
  // "no letters" rather than a list of allowed separators so an unfamiliar dash or
  // bracket cannot quietly turn a phone number back into a candidate needle.
  /^(?=(?:\D*\d){7})[^\p{L}]+$/u,
  // Signature email.
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
]

/** True when this line is something `renderMessage` added rather than prose. */
export function isEnvelopeLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  return ENVELOPE_PATTERNS.some((p) => p.test(trimmed))
}

/** True for the sign-off line, whichever casing or trailing punctuation it carries. */
export function isClosingLine(line: string): boolean {
  return /^looking forward to connecting\.?$/i.test(line.trim())
}

/**
 * "I'm Kapil Jain, Co-founder of Bollywood Chronicle." — the opener, restored 2026-08-17.
 *
 * It was dropped on 2026-08-07 when the persona became the page name alone, and Tabish's
 * standard message brings it back as the first thing after the greeting. It is joined ONTO
 * the greeting line rather than placed under it, so the recipient's inbox preview carries
 * who is writing and what page they are from.
 *
 * Its retired standalone form is still in `ENVELOPE_PATTERNS`, which is correct and must
 * stay: messages delivered before 2026-08-07 carry it on its own line forever, and envelope
 * matching errs loose. The merged line does not match that pattern (it is anchored on `^i'm`
 * and this line starts with the greeting) and does not need to — `proseLines` drops the
 * first line positionally, which is the rule that "needs no pattern to be right".
 */
export function introLine(p: Pick<RenderPersona, 'personaName' | 'personaRole' | 'personaBrand'>): string {
  return `I'm ${p.personaName}, ${p.personaRole} of ${p.personaBrand}.`
}

/** "Hi Sumeet," when we know the name, otherwise address the publication. */
export function buildGreeting(target: RenderTarget): string {
  const name = target.contactFirstName?.trim()
  if (name) return `Hi ${name},`

  /**
   * A HANDLE MUST NOT BE GREETED. `greetableName` trims a display name down to something
   * sayable — "Milano Ice Cream, Bangalore" → "Milano Ice Cream" — and it cannot help here,
   * because there is nothing wrong with the SHAPE of `agoracitycentre`. It is the wrong
   * STRING: `brandTarget.ts` stores the handle as the display name whenever Instagram
   * returns no full name, and 21 of the 68 live BRAND rows are in that state.
   *
   * MEASURED in a real waiting draft: **"Hi agoracitycentre team,"** — the first line the
   * prospect reads.
   *
   * "Hi there," rather than a guess. The alternative — inventing a company name from the
   * handle — is the same class of mistake as inventing a persona: plausible, wrong, and
   * addressed to the people most certain to notice.
   */
  const usable = usableBrandName(target.displayName, target.handle)
  if (usable === null) return 'Hi there,'

  return `Hi ${greetableName(usable)} team,`
}

/**
 * Trims an Instagram display name down to something that reads correctly before "team".
 *
 * Instagram display names are marketing strings, not names: "Milano Ice Cream, Bangalore"
 * produced **"Hi Milano Ice Cream, Bangalore team,"** — ungrammatical, and visibly
 * machine-generated in the first line a prospect reads.
 *
 * Rules, each from a real value observed in the live database:
 *
 *   comma      "Milano Ice Cream, Bangalore" -> "Milano Ice Cream". A comma in a display
 *              name is almost always a location or a tagline appended to the brand.
 *   separators "KALKI Fashion | Ethnic Wear" -> "KALKI Fashion". Same reasoning for
 *              pipes, en/em dashes and bullets.
 *   suffixes   a trailing "Official" / "India" is kept — "Amazon India" is the brand as
 *              people say it, and trimming it would be a worse guess than leaving it.
 *
 * Falls back to the original string when trimming would leave nothing usable: a bad
 * greeting is better than an empty one.
 */
export function greetableName(displayName: string): string {
  const first = displayName
    .split(/\s*[,|•·]\s*|\s+[–—]\s+/)[0]
    ?.trim()
    .replace(/\s{2,}/g, ' ')

  if (!first || first.length < 2) return displayName.trim()
  return first
}

/**
 * The same display name, cleaned for OUR OWN SCREEN. A different job from `greetableName`,
 * which is why it sits directly beneath it rather than reusing it.
 *
 * `displayName` is an internal label and always has been — CLAUDE.md records `{{channel}}`
 * putting "Bollywood Chronicle (test target)" into a message body for exactly this reason.
 * The same strings then leaked onto the dashboard, where the live values are:
 *
 *     "Bollywood Chronicle (test target)"        a channel we own, added to rehearse against
 *     "Bollywood Society (rehearsal target)"     ditto
 *     "Burner (test target)"                     the throwaway recipient
 *     "Tabish (trial)"                           a SENDING account
 *
 * So the dashboard read "Burner (test target) replied" in its headline and "Tabish (trial)"
 * beside a Send button. Bookkeeping we wrote for ourselves, presented as though it were the
 * recipient's name.
 *
 * ── WHY THIS IS NOT `greetableName` ─────────────────────────────────────────
 *
 * The two rules differ, and the difference is not stylistic:
 *
 *   `greetableName` must produce something grammatical before the word "team" in a message
 *   a stranger reads, with no handle beside it to fall back on. So it also cuts at a comma:
 *   "Milano Ice Cream, Bangalore" -> "Milano Ice Cream", because "Hi Milano Ice Cream,
 *   Bangalore team," is visibly machine-generated in the first line of a pitch.
 *
 *   On screen the handle is ALWAYS rendered next to the name, so "Milano Ice Cream,
 *   Bangalore" is simply the truth about that account and trimming its location would throw
 *   away real information for no benefit.
 *
 * Hence: this strips the annotation and nothing else. Calling one from the other would make
 * one of the two rules wrong.
 *
 * ── WHY ANY PARENTHETICAL, NOT A LIST OF KNOWN WORDS ────────────────────────
 *
 * Matching "test", "trial", "rehearsal", "burner", "demo" would be more conservative and
 * would fail silently the first time someone types "(do not use)" — the same shape as the
 * quality gate's figures allowlist, which matched digits and so passed "eighty million
 * followers". Enumerate the FORM, not the vocabulary.
 *
 * The cost of over-trimming is genuinely near zero here because the handle is always
 * adjacent: "Mad Over Marketing (M.O.M)" renders as "Mad Over Marketing" beside
 * @madovermarketing_mom, which loses nothing a reader needs.
 *
 * Falls back to the trimmed original when stripping would leave nothing, for the same
 * reason `greetableName` does: a label with our annotation still in it beats an empty one.
 */
export function operatorName(displayName: string): string {
  const stripped = displayName
    .replace(/\s*[([][^()[\]]*[)\]]\s*$/, '')
    .trim()
    .replace(/\s{2,}/g, ' ')

  if (stripped.length < 2) return displayName.trim()
  return stripped
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
  const isBrand = target.kind === 'BRAND'

  /**
   * The hook line is a CHANNEL sentence and must never be addressed to a BRAND.
   *
   * *"I noticed your recent branded collaboration with X"* says: you are a publisher, and X
   * paid you. Said to X's competitor it is a claim about the recipient's own marketing that
   * we invented, sent to the one audience certain to know it is false. Rendering the real
   * message to Royal Canin with a campaign naming Amazon produced exactly that, followed by
   * *"indicative numbers for Amazon Dot In?"*.
   *
   * A brand's first touch already has its own opening — `brandPitch.ts` names the placement
   * we genuinely saw, on the PUBLISHER's feed, which is a different sentence for a reason.
   * A brand FOLLOW-UP gets no hook line rather than a wrong one, exactly as
   * `buildHookLine` returns null rather than inventing a hook it does not have.
   *
   * This is unreachable today — `pickHook` queries campaigns by the RECIPIENT's `targetId`
   * and `pipeline.ts` scrapes `kind: 'CHANNEL'` only, so a BRAND row has no campaigns. It
   * is written down anyway: "no brand hook exists" is currently a property of which rows the
   * scraper happens to visit, and this codebase has already been bitten by an implicit
   * safety property (never DMing at 4 a.m. was an accident of the slot list until Phase 5
   * made it a rule). A property nothing states is one a refactor can drop silently.
   */
  const hookLine = isBrand ? null : buildHookLine(hook)

  const brands = hook && !isBrand ? readStringArray(hook.brands).map((b) => prettifyBrand(b)) : []
  const firstBrand = brands[0] ?? null

  /**
   * `{{channel}}` is what the recipient is called INSIDE the message, so it must use
   * the same name as the greeting — not `displayName`, which is our internal label
   * and can carry anything the operator typed. Adding a target called "Bollywood
   * Chronicle (test target)" produced the line "...I'd like to discuss with Bollywood
   * Chronicle (test target): an annual collaboration", which is how an internal note
   * ends up in a stranger's inbox.
   *
   * And the fallback must be `greetableName(displayName)`, not `displayName` — because that
   * is what `buildGreeting` uses. This comment already asserted "the same name as the
   * greeting" while the code used the raw string, so the two disagreed for every recipient
   * with no `contactFirstName`, which is every BRAND by design: "Milano Ice Cream,
   * Bangalore" mid-sentence, the same ungrammatical string `greetableName` exists to stop
   * appearing in the first line. A comment stating a property is not the property.
   */
  const channelName = target.contactFirstName?.trim() || greetableName(target.displayName)

  /**
   * `{{brand}}` MEANS TWO DIFFERENT THINGS, and this substitution implemented only one.
   *
   *   CHANNEL pool  we are writing TO a publisher ABOUT its sponsors, so `{{brand}}` is the
   *                 sponsor detected in their paid post. "your brand partners" when we do
   *                 not know it. (`prisma/variants.ts`.)
   *   BRAND pool    we are writing TO the company itself, so `{{brand}}` is THE RECIPIENT.
   *                 `prisma/brandVariants.ts` states this outright — *"{{brand}} becomes
   *                 the recipient's own name"* — and nothing implemented it.
   *
   * One rule served both, and it was the channel one. FOUND BY RENDERING THE REAL MESSAGE
   * TO A REAL PROSPECT, 2026-08-05, which is the only way any of these have been found:
   *
   *   reachable today   a media-buying pitch to Royal Canin ended *"indicative numbers for
   *                     YOUR BRAND PARTNERS?"* — addressing a buyer as though it were a
   *                     publisher with sponsors, in the message's closing ask.
   *   latent, worse     with a hook present it becomes a DIFFERENT COMPANY'S name:
   *                     *"indicative numbers for Amazon Dot In?"* sent to Royal Canin,
   *                     under a hook line claiming Royal Canin collaborated with them. That
   *                     is an invented claim about the recipient's own marketing, addressed
   *                     to the people who would know it is false. Not reachable right now
   *                     only because `pipeline.ts` scrapes `kind: 'CHANNEL'` alone, so no
   *                     BRAND target has a campaign to draw a hook from.
   *
   * Fixing the substitution rather than the copy is deliberate: the wording is Tabish's and
   * it is already correct — it is the token underneath it that was lying.
   *
   * ── AND IT MUST ASK `usableBrandName`, WHICH IT DID NOT UNTIL 2026-08-17 ──
   *
   * FOUND BY RENDERING THE REAL MESSAGE, which is the only way any of these have been found.
   * The 2026-08-13 fix established that a stored `displayName` is often just the handle and
   * must never be put in front of a prospect, and it was applied at TWO of the three places
   * that speak the name: `buildGreeting` above, and `brandFirstTouch` in brandPitch.ts. This
   * line — the `{{brand}}` token in the BRAND variant pool — was missed, so the greeting
   * degraded correctly to "Hi there," while the body two paragraphs down still read:
   *
   *     I would like to propose an annual plan for agoracitycentre rather than another
   *     one-off, priced as media buying rather than influencer fees.
   *
   * A half-applied rule reads as fixed, which is worse than an unfixed one: the screen that
   * would have shown the defect (the greeting) is exactly the part that was repaired.
   *
   * "your brand" rather than a guess, and rather than "you", because one of the six live
   * contexts is POSSESSIVE — *"a plan built around {{brand}}'s next few months"* — and it is
   * the only phrasing that stays grammatical across all six. Same degrade-honestly rule as
   * the greeting: name nothing rather than invent a company name from a handle.
   */
  const brandToken =
    target.kind === 'BRAND'
      ? (() => {
          const usable = usableBrandName(target.displayName, target.handle)
          return usable === null ? 'your brand' : greetableName(usable)
        })()
      : (firstBrand ?? 'your brand partners')

  const body = variantBody
    .replace(/\{\{\s*brand\s*\}\}/g, brandToken)
    .replace(/\{\{\s*channel\s*\}\}/g, channelName)
    .trim()

  /**
   * ── THE OPENER RUNS INTO THE GREETING (2026-08-17, Tabish) ────────────────
   *
   * *"No space to be given after 'Hi' as that obscures the message in Instagram DMs … no
   * space and new line after hi this ruins it."*
   *
   * This array used to hold a bare `''` between the greeting and the body, and
   * `parts.join('\n')` turned it into a blank line:
   *
   *     Hi Crocs India team,
   *                              ← this
   *     You are investing in placement on entertainment publishers…
   *
   * Instagram's inbox list previews only the FIRST line of a message, so every recipient's
   * preview read "Hi Crocs India team," and nothing else — the pitch was invisible until
   * they opened it. One empty string, and it cost every message its opening.
   *
   * The greeting and the introduction are now ONE line. Note what this does downstream:
   * `proseLines` drops line 1 BY POSITION, so the merged opener can never be the needle, and
   * everything the send guards have to work with comes from the template's own paragraphs.
   * MEASURED, the surviving requirement is one paragraph over 40 characters — see the
   * constraint note on `SINGLE_TEMPLATE_MIDDLE`, which spells out which shapes return null.
   */
  const opener = `${buildGreeting(target)} ${introLine(persona)}`

  const parts = [
    opener,
    ...(hookLine ? ['', hookLine] : []),
    '',
    body,
    '',
    CLOSING_LINE,
    '',
    // The whole signature comes from ONE function, because the gate's staleness probe
    // calls the same one — writer and probe sharing bytes is what makes the probe honest.
    signatureBlock(persona),
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
  /**
   * Only what RENDERS is validated, and on 2026-08-17 that grew back.
   *
   * `personaName`/`personaRole` stopped appearing in messages on 2026-08-07, and this note
   * correctly said blocking a send on a field nobody sees would be a guard about nothing.
   * Tabish's standard message puts both back — in the opening line AND in the signature —
   * so the same reasoning now requires them to be checked. An empty `personaName` would
   * render *"I'm , Co-founder of Bollywood Chronicle."* as the first line a prospect reads.
   */
  if (p.personaBrand.trim().length < 2) problems.push('personaBrand is empty')
  if (p.personaName.trim().length < 2) problems.push('personaName is empty, and it opens every message')
  if (p.personaRole.trim().length < 2) problems.push('personaRole is empty, and it opens every message')

  return problems
}
