/**
 * Does the model's `reason` talk about the account it was ASKED about?
 *
 * PURE, and the mechanical half of a defect no prompt edit can close on its own.
 *
 * ── WHAT WAS MEASURED ─────────────────────────────────────────────────────
 *
 * The `--stuck` backfill (2026-08-11) offered 30 cached-UNRESOLVED handles to the model.
 * 21 of 23 decided verdicts were excellent. TWO were wrong in the same specific way — the
 * model answered about a DIFFERENT ACCOUNT than the one in the question:
 *
 *   asked @crocs        → person 95%  "instylemagazine is a publisher/media page, not a buyer"
 *   asked @titaneyeplus → person 95%  "Vikas Khanna is a famous Indian chef and author"
 *
 * Crocs is the footwear company; Titan Eye+ is the eyewear retailer. Neither
 * `instylemagazine` nor `Vikas Khanna` appears anywhere in the evidence those calls were
 * given — both rows had `(nothing gathered yet)` as their enrichment, so the user message
 * was little more than the handle. With nothing to go on the model CONFABULATED A SUBJECT
 * rather than answering `unsure`.
 *
 * It is the failure class CLAUDE.md already records twice for message generation — "an
 * invented claim about the RECIPIENT", "an invented claim about US" — and the general case
 * is not mechanically checkable. THIS SHAPE IS, and it must be, because the consequence is
 * a real consumer brand filed PERSON at 95%: above the confidence floor, so the floor
 * cannot catch it, and PERSON is a cached ANSWER that never retries. One confabulated
 * sentence permanently discards a prospect.
 *
 * ── THE DISCRIMINATOR, AND WHY THE OBVIOUS ONE IS WRONG ───────────────────
 *
 * "The subject must match the handle" is the obvious rule and it FAILS on the real data:
 *
 *   asked @iamzahero  → "Sonakshi Sinha is a well-known Indian actress"   CORRECT
 *   asked @nowitsabhi → "Abhishek Banerjee is a well-known Indian actor"  CORRECT
 *
 * Those are the real people behind pseudonymous handles, which is exactly what a `person`
 * verdict SHOULD say, and they are structurally identical to the `Vikas Khanna` mistake:
 * a two-word personal name unrelated to the handle's letters. A naive matcher rejects all
 * four and the guard becomes useless.
 *
 * So the rule turns on WHICH SIDE OF THE TABLE THE HANDLE ITSELF CLAIMS TO BE ON:
 *
 *   1. AN @MENTION in the reason that is not this handle is always a substituted subject.
 *      A verdict about @crocs has no business naming @instylemagazine. No exceptions —
 *      this is the unambiguous half and it needs no judgement.
 *   2. A BARE LOWERCASE handle-shaped subject ("instylemagazine is …") is the same fault
 *      written without the @, and catches the crocs case as it was actually phrased.
 *   3. A NAMED PROPER-NOUN subject not traceable to the handle is rejected, EXCEPT when
 *      the verdict is `person` and the subject is a personal name — a pseudonymous handle
 *      legitimately hides one. That exception is then withdrawn when the HANDLE ITSELF
 *      carries a commercial token (`titaneyeplus` → `eyeplus`, `plus`): a handle claiming
 *      to be a product line, answered with the name of an unrelated private individual,
 *      is the substitution rather than the disclosure.
 *
 * Rule 3's exception is the honest weak point and is stated rather than hidden: a
 * confabulated personal name about a handle with no commercial token still passes. Rules 1
 * and 2 are structural; rule 3 is a heuristic over a 23-row sample. Both measured bad rows
 * are caught by a DIFFERENT rule (2 and 3), so neither carries the guard alone.
 *
 * ── THE SAFE DIRECTION ────────────────────────────────────────────────────
 *
 * A rejection degrades the decision to `unsure`, which `interpretDecision` turns into
 * UNRESOLVED: never messaged, never a prospect, retryable when new evidence arrives. So a
 * FALSE rejection costs one prospect visibly, and a missed substitution files a real brand
 * as a person permanently. Same asymmetry as `RESOLVE_CONFIDENCE_FLOOR`, and it is why the
 * guard may degrade a verdict and may never create or upgrade one.
 *
 * VALIDATED against all 23 real verdicts from that run (`tests/reason-subject.test.ts`
 * drives them from a table): 21 good ones survive, both bad ones are caught, 23/23.
 */

/**
 * Openers that assert NO named subject at all — the model is describing the evidence it
 * was handed ("The display name is a personal name…", "The handle and display name
 * suggest an individual…"). Eight of the 23 real reasons are shaped this way and every
 * one is correct, so a subject extractor that reads "The" as a proper noun would reject
 * them all.
 */
const DESCRIPTIVE_OPENER =
  /^(the\s+(display\s+name|handle|name|profile|account|caption|bio)|this|its|their|it|no|nothing|handle|display\s+name|profile|account|name|both|neither)\b/i

/**
 * Tokens that make a capitalised phrase an ORGANISATION rather than a person, so the
 * "it may be a person's real name" exception cannot be claimed by "InStyle Magazine" or
 * "Netflix India". Deliberately generous: a wrongly-withheld exception rejects a decision,
 * which is the safe direction.
 */
const ORGANISATION_WORD =
  /\b(magazine|media|news|times|post|daily|tv|studios?|films?|productions?|network|group|holdings?|ltd|limited|inc|llc|corp|corporation|company|co|india|official|world|store|shop|agency|pr|brand|retailer|chain)\b/i

/**
 * Commercial tokens that make a HANDLE claim to be a business or product line.
 *
 * `titaneyeplus` carries `eyeplus` and `plus`; `iamzahero` and `nowitsabhi` carry none of
 * these and instead open with a first-person pseudonym. That is the whole separation
 * between the confabulated `Vikas Khanna` and the correct `Sonakshi Sinha`.
 *
 * `india` and `official` are here because a handle carrying either is a regional or
 * verified BUSINESS account by convention — and every `company` verdict in the real data
 * whose handle carries one ALSO names a traceable subject, so this list costs nothing
 * there.
 */
const COMMERCIAL_HANDLE_TOKEN = [
  'eyeplus',
  'plus',
  'store',
  'shop',
  'official',
  'world',
  'wear',
  'mart',
  'cafe',
  'foods',
  'beauty',
  'care',
  'fashion',
  'motors',
  'steel',
  'auto',
  'tech',
  'labs',
  'studio',
  'hotels',
  'resorts',
  'jewels',
  'watches',
  'eyewear',
  'optical',
  'india',
]

/** Lowercase, alphanumerics only — so `tseries.official` and `T-Series` compare equal. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Every @mention in the reason, without its `@`. */
function mentionsIn(reason: string): string[] {
  return [...reason.matchAll(/@([a-z0-9._]+)/gi)].flatMap((m) => (m[1] ? [m[1]] : []))
}

/**
 * The subject the reason opens by making a claim about, or null when it makes none.
 *
 * `bare` distinguishes "instylemagazine is …" (a lowercase handle-shaped token, which can
 * only be another ACCOUNT) from "Vikas Khanna is …" (a proper noun, which may be the real
 * person behind a pseudonymous handle). They get different treatment downstream.
 */
export function reasonSubject(reason: string): { text: string; bare: boolean } | null {
  const trimmed = reason.trim()
  if (trimmed === '') return null

  // A lowercase, handle-shaped token making the claim: only ever another account.
  const bare = trimmed.match(/^([a-z][a-z0-9._]{3,})\s+is\b/)
  if (bare?.[1]) return { text: bare[1], bare: true }

  if (DESCRIPTIVE_OPENER.test(trimmed)) return null

  const proper = trimmed.match(/^((?:[A-Z][\w.&'’-]*)(?:\s+(?:of|the|and|&)?\s*[A-Z][\w.&'’-]*)*)/)
  if (!proper?.[1]) return null
  // "The Leela is a luxury hotel chain" — the article is not part of the name, and
  // keeping it would make the subject untraceable to `theleela`... which it in fact is,
  // but only by accident. Strip it so the comparison is about the name.
  const text = proper[1].trim().replace(/^The\s+/i, '')
  return text === '' ? null : { text, bare: false }
}

/**
 * Could this subject plausibly BE this handle?
 *
 * Substring either way plus token containment, so "Adidas India" ↔ `adidasindia`,
 * "KFC India" ↔ `kfcindia_official` and "Fastrack" ↔ `fastrackworld` all pass. Loose on
 * purpose: a false "traceable" only means the guard stays out of the way, and the
 * confidence floor and the prompt are still in front of it.
 */
export function subjectTraceableToHandle(subject: string, handle: string): boolean {
  const s = normalise(subject)
  const h = normalise(handle.replace(/^@/, ''))
  if (s === '' || h === '') return true
  if (s.includes(h) || h.includes(s)) return true

  const tokens = subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
  if (tokens.length > 0 && tokens.every((t) => h.includes(t))) return true
  // One substantial token in common is enough — "Netflix India" vs `netflix_in`.
  return tokens.filter((t) => t.length >= 4).some((t) => h.includes(t))
}

/** Two or more capitalised words with no organisation word: a human name, probably. */
function looksLikePersonalName(subject: string): boolean {
  if (/^[a-z]/.test(subject)) return false
  const words = subject.split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  if (!words.every((w) => /^[A-Z]/.test(w))) return false
  return !ORGANISATION_WORD.test(subject)
}

/** Does the handle itself claim to be a business or product line? */
export function handleClaimsBusiness(handle: string): boolean {
  const h = normalise(handle.replace(/^@/, ''))
  // `n !== token` so a handle that IS the word (e.g. `plus`) is not read as a compound.
  return COMMERCIAL_HANDLE_TOKEN.some((token) => h.includes(token) && h !== token)
}

/**
 * Why this reason is about a different account — or null when it is not.
 *
 * The string is a fragment for a diagnostic, never operator copy: it lands in
 * `BrandLookup.modelReason`'s neighbourhood and in a log line, so it names the intruding
 * subject because "the model answered about something else" without saying WHAT is the
 * kind of message this repo has repeatedly had to go back and fix.
 */
export function reasonAboutDifferentAccount(input: {
  handle: string
  kind: string
  reason: string
}): string | null {
  const { handle, kind, reason } = input
  if (reason.trim() === '') return null // nothing asserted; the floor and the prompt still apply

  // 1. An @mention that is not this handle. Structural, no judgement, no exception.
  for (const mention of mentionsIn(reason)) {
    if (!subjectTraceableToHandle(mention, handle)) return `names @${mention}`
  }

  const subject = reasonSubject(reason)
  if (!subject) return null
  if (subjectTraceableToHandle(subject.text, handle)) return null

  // 2. A bare lowercase handle-shaped subject can only be another account.
  if (subject.bare) return `names ${subject.text}`

  // 3. A personal name is legitimate for a `person` verdict about a pseudonymous handle —
  //    unless the handle is claiming to be a business, in which case naming an unrelated
  //    individual is the substitution.
  if (kind === 'person' && looksLikePersonalName(subject.text)) {
    if (handleClaimsBusiness(handle)) return `names the person ${subject.text} about a business-shaped handle`
    return null
  }

  return `names ${subject.text}`
}

/**
 * The guard as the decision path uses it: hand it what the model said, get back either the
 * decision unchanged or the same decision degraded to `unsure`.
 *
 * DEGRADED, NOT DISCARDED. `unsure` is a value `interpretDecision` already handles
 * correctly — it yields UNRESOLVED regardless of the confidence number — so a rejection
 * reuses the path that has always been the safe one instead of inventing a second way to
 * refuse. Returning null here would mean "the call failed", which is a DIFFERENT fact:
 * a failed call stays retryable forever, while a substituted subject is an answer the
 * model gave and should not be re-asked on the same thin evidence.
 *
 * The original wording is preserved in the reason so the confabulation is still readable
 * afterwards. Deleting the evidence for a rejection would make the rejection unauditable.
 */
export function guardDecisionSubject<T extends { kind: string; confidence: number; reason: string }>(
  handle: string,
  decision: T,
): T {
  const problem = reasonAboutDifferentAccount({ handle, kind: decision.kind, reason: decision.reason })
  if (!problem) return decision
  return {
    ...decision,
    kind: 'unsure',
    reason: `answered about a different account (${problem}) — original: ${decision.reason}`.slice(0, 200),
  }
}
