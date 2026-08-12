import { log } from '@/lib/logger'
import { recordModelCall } from '@/lib/modelCall'
import { guardDecisionSubject } from './reasonSubject'
import type { BrandVerdict } from './resolveBrand'

/**
 * Decides what Instagram's category endpoint cannot: is this @mention a COMPANY that
 * buys media placements, or a person / agency / publisher?
 *
 * WHY THIS EXISTS AT ALL. Meta deleted the `ig_business_category_subvertical` schema,
 * so `web_profile_info` returns HTTP 400 for accounts that HAVE a business sub-category
 * — precisely the accounts most likely to be brands. @adidas, @crocsindia and
 * @bonkerscorner are all unreadable through it, and every one of them showed on the
 * dashboard as "could not read this account" with manual buttons beside it. Tabish:
 * "How can adidas not be recognized as anything? I do not want this option to select
 * manually, correct it."
 *
 * WHY A MODEL AND NOT A RULE. Measured 2026-08-03 and recorded in three docblocks:
 * @tilara.india (a brand) and @adityathackeray (a politician) are byte-identical on
 * every field we can read anonymously. What separates them is WORLD KNOWLEDGE
 * (@adidas is a sportswear company; Aditya Thackeray is a politician) plus the caption
 * context — exactly the judgement the caption classifier already makes one modality
 * over. A rule over the readable fields would message the politician.
 *
 * THE SAFE DIRECTION IS SILENCE. 'unsure' and anything under the floor stays
 * UNRESOLVED: never messaged, never queued for a human (one-switch decision,
 * 2026-08-08), retried only when new evidence arrives. A wrong 'company' sends a
 * sales pitch to a person; a wrong skip costs one prospect. Asymmetric, so the floor
 * is high and 'unsure' is honoured regardless of the confidence number.
 *
 * A FAILED CALL IS NEVER A VERDICT. `decideBrand` returns null on every failure — no
 * key, HTTP error, malformed JSON, an unrecognised `kind` — and `interpretDecision`
 * turns null into null rather than into a negative answer. Same contract as
 * `classifyCaption`, and for the same reason: this codebase has produced
 * "absence of data hardens into a negative verdict" four times, and here the negative
 * verdict would be cached forever against a real prospect.
 */

/**
 * `deepseek-v4-flash`, non-thinking — the same model, the same reasons as
 * `detectors/semantic.ts`. Flash over pro: this is a one-line classification and pro
 * costs 3x on a cache miss for no benefit on a task this shaped.
 *
 * THINKING MODE IS OFF DELIBERATELY. It is ENABLED BY DEFAULT at effort `high` and
 * would bill a chain of thought at $0.28/1M before every one-line verdict.
 */
const MODEL = 'deepseek-v4-flash'
const API_URL = 'https://api.deepseek.com/chat/completions'

/**
 * Confidence below which NOTHING is decided.
 *
 * High on purpose, and the asymmetry is not close: a wrong "company" puts a
 * media-buying pitch in a private person's DMs from a revenue account — the
 * "repeated unwanted contact" pattern this whole fleet design exists to avoid — while
 * a wrong skip costs one prospect out of dozens a week, visibly, retryably.
 */
export const RESOLVE_CONFIDENCE_FLOOR = 90

/**
 * The system prompt is a CONSTANT and must stay byte-identical between calls.
 *
 * DeepSeek's caching is prefix-based and automatic, but a hit needs the prefix to match
 * in FULL. Cache-hit input is $0.0028/1M against $0.14/1M — 50x — so interpolating
 * ANYTHING here (a handle, a date, a caption) would destroy the cache on every future
 * call, silently and forever. Per-handle facts go in the USER message, never here.
 */
const SYSTEM_PROMPT = `You classify Instagram accounts that were @-mentioned in a paid post's caption.
The decisive question: is this account a COMPANY whose team BUYS advertising placement
on entertainment publisher pages? A consumer brand, retailer, streaming service, app,
film studio's corporate account, or venue chain is a company. A person is not — actor,
director, musician, politician, athlete, influencer, however famous or verified.
A marketing / PR / talent agency, or another publisher or media page, is "not-a-prospect":
it is the other side of the table, never a buyer of placements.
Use what you reliably know about famous handles. If the handle is obscure and the facts
given do not settle it, answer "unsure" — unsure is safe; a wrong "company" answer sends
a sales pitch to a person.
Judge ONLY the handle given in the user message. Never answer about any other account,
company or person, however similar the name looks or whatever the caption mentions.
Your "reason" MUST NAME that handle, or the company or person it belongs to, so it is
plain which account you judged.
If the facts are thin and you do not reliably recognise the handle, answer "unsure".
Never guess by association with a similar-sounding or unrelated account — a guess of that
kind is worse than "unsure", because a real company filed as a person is never retried.
Reply with JSON only: {"kind":"company"|"person"|"not-a-prospect"|"unsure","confidence":0-100,"reason":"one short sentence"}`

export interface BrandDecision {
  kind: 'company' | 'person' | 'not-a-prospect' | 'unsure'
  confidence: number
  reason: string
}

const DECISION_KINDS: BrandDecision['kind'][] = ['company', 'person', 'not-a-prospect', 'unsure']

export interface DecideInput {
  handle: string
  displayName?: string | null
  followers?: number | null
  isVerified?: boolean | null
  reachable?: boolean | null
  enrichment?: string | null
  /** The caption sentence(s) around the @mention — context the endpoint never had. */
  captionContext?: string | null
}

/**
 * PURE half: a decision (or a failed call) → a BrandVerdict, or null when nothing was
 * decided. Pure so both directions are testable without a network — the same reason
 * `classifyProfile` and `interpretLookupFailure` were extracted from `resolveBrand`,
 * where the two classification bugs of 2026-08-03 shipped precisely because the logic
 * sat inside an `await fetch()` and therefore had no tests at all.
 */
export function interpretDecision(input: { handle: string; decision: BrandDecision | null }): BrandVerdict | null {
  const { handle, decision } = input
  if (!decision) return null // a failed call is never a verdict — resolveBrand keeps its own answer

  /**
   * `unsure` is honoured REGARDLESS of the confidence number: a model claiming 99%
   * certainty that it is uncertain is still uncertain, and reading the number instead
   * of the answer would let a formatting quirk decide a prospect.
   *
   * A sub-floor `person` lands here too, not in PERSON. PERSON is a cached ANSWER that
   * never retries, so filing a low-confidence guess there would permanently discard a
   * real prospect on evidence the model itself did not trust.
   */
  if (decision.kind === 'unsure' || decision.confidence < RESOLVE_CONFIDENCE_FLOOR) {
    return { kind: 'UNRESOLVED', handle, reason: `model not confident (${decision.kind} ${decision.confidence}%)` }
  }

  if (decision.kind === 'company') {
    /**
     * `displayName` falls back to the handle and `category`/`followers` are null: this
     * resolver answers ONE question — is this a buyer — and it has no profile to read
     * the rest from, because the endpoint that serves them is the thing that failed.
     * Inventing a category here would put a model's guess in a column every other
     * reader treats as Instagram's own fact.
     */
    return { kind: 'BRAND', handle, displayName: handle, category: null, followers: null }
  }

  // person and not-a-prospect both mean: never messaged. Same filing the category
  // rule uses for agencies (see NOT_A_PROSPECT_CATEGORIES in resolveBrand.ts).
  return { kind: 'PERSON', handle, category: null }
}

/**
 * One decision call. Returns null on ANY failure — never a fabricated verdict.
 *
 * Facts go in the USER message so the cached prefix survives. `captionContext` is the
 * evidence the endpoint never had: the sentence the handle was mentioned in, which is
 * what separates "@x, the brand whose product this is" from "@x, credited for the
 * photo".
 */
export async function decideBrand(input: DecideInput): Promise<BrandDecision | null> {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return null

  const facts = [
    `handle: @${input.handle}`,
    input.displayName ? `display name: ${input.displayName}` : null,
    input.followers != null ? `followers: ${input.followers}` : null,
    input.isVerified != null ? `verified: ${input.isVerified}` : null,
    input.reachable === false ? `note: profile could not be read anonymously` : null,
    input.enrichment ? `profile facts: ${input.enrichment}` : null,
    input.captionContext ? `mentioned in this paid-post caption: ${input.captionContext.slice(0, 500)}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const startedAt = Date.now()
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        // OFF. See the note on MODEL — on by default, and it would bill a chain of
        // thought before a one-line verdict.
        thinking: { type: 'disabled' },
        // Constrains the reply to parseable JSON rather than hoping the prose is clean.
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0,
        messages: [
          // System FIRST and constant: this is the cacheable prefix.
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: facts },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      log.warn('brand decision request failed', { handle: input.handle, status: res.status, body })
      throw new Error(`HTTP ${res.status}`)
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number }
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    const parsed = JSON.parse(cleaned) as BrandDecision
    if (!DECISION_KINDS.includes(parsed.kind)) throw new Error(`unrecognised kind ${JSON.stringify(parsed.kind)}`)

    void recordModelCall({
      purpose: 'resolve',
      model: MODEL,
      subject: `@${input.handle}`,
      ms: Date.now() - startedAt,
      ok: true,
      cachedInputTokens: json.usage?.prompt_cache_hit_tokens ?? 0,
      inputTokens: json.usage?.prompt_cache_miss_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    })

    const decision: BrandDecision = {
      kind: parsed.kind,
      /**
       * Clamped, and `Number(...) || 0` floors a missing or non-numeric confidence at
       * ZERO rather than NaN. A NaN would fail every `<` comparison, so the floor check
       * in `interpretDecision` would pass it through — a malformed reply becoming a
       * confident BRAND is the one failure mode this whole file is built against.
       */
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
      reason: String(parsed.reason ?? '').slice(0, 200),
    }

    /**
     * THE SUBSTITUTED-SUBJECT GUARD, and it is applied HERE so no caller can miss it.
     *
     * MEASURED 2026-08-11: asked about @crocs the model answered "instylemagazine is a
     * publisher/media page"; asked about @titaneyeplus it answered "Vikas Khanna is a
     * famous Indian chef". Both real consumer brands, both filed PERSON at 95% — above
     * `RESOLVE_CONFIDENCE_FLOOR`, so the floor could not catch it, and PERSON is a cached
     * answer that never retries. The prompt now forbids it; a prompt is not a guarantee,
     * which is why the mechanical half exists and is the important one.
     *
     * It sits on the RETURN of `decideBrand` rather than in `interpretDecision` because
     * this is a property of what the MODEL said, not of how a decision maps to a verdict:
     * `interpretDecision` is also driven from tests with hand-written decisions, and a
     * guard there would silently rewrite those. Every path to a real model answer goes
     * through this return — one rule, one place, the drift this repo has recorded five
     * times.
     */
    const guarded = guardDecisionSubject(input.handle, decision)
    if (guarded.kind !== decision.kind) {
      log.warn('brand decision answered about a different account — degraded to unsure', {
        handle: input.handle,
        said: decision.kind,
        confidence: decision.confidence,
        reason: decision.reason,
      })
    }
    return guarded
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.warn('brand decision call threw', { handle: input.handle, error: message })
    void recordModelCall({
      purpose: 'resolve',
      model: MODEL,
      subject: `@${input.handle}`,
      ms: Date.now() - startedAt,
      ok: false,
      error: message,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    return null // never a fabricated verdict
  }
}
