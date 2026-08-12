import { log } from '@/lib/logger'
import { recordModelCall } from '@/lib/modelCall'
import { renderMessage, type RenderPersona, type RenderTarget } from './render'
import { checkGeneratedMessage, type QualityVerdict } from './qualityGate'

/**
 * Phase 8 — the model writes the body, and a mechanical gate decides whether anyone may
 * send it.
 *
 * ── WHAT THIS CHANGES, STATED PLAINLY ─────────────────────────────────────
 *
 * Until now every word that reached a prospect was hand-written by Tabish: 12 channel
 * variants, 6 brand variants, 4 bespoke first touches. Decision 3 — *every message written
 * from scratch per recipient* — has been satisfied by a rotating pool of human copy plus a
 * campaign reference. This lets a model write the middle instead.
 *
 * The reason to want it is decision 3 taken seriously: at 65 senders and 60 recipients a pool
 * of 12 is not "written from scratch per recipient", it is a template pool being worked
 * through, and Meta's written spam policy penalises repetition specifically. The reason to be
 * careful about it is that a fluent model will happily invent a claim about our own reach and
 * send it to a company that buys media for a living.
 *
 * So the gate is not decoration and it is not optional. See `qualityGate.ts`.
 *
 * ── OFF BY DEFAULT, AND DRY RUN BEFORE THAT ───────────────────────────────
 *
 * `generateMessages` defaults FALSE, so this ships as a NO-OP exactly as Phase 3 did: with it
 * off, `composeForPair` behaves byte-for-byte as it did yesterday. `pnpm ig:generate` is the
 * way to look at real generated messages against real prospects without writing or sending
 * anything, and it is a dry run unless asked otherwise — the convention every money-spending
 * command here already follows.
 *
 * Cost, measured rather than estimated: the classifier averages **$0.000031 per call** across
 * 34 real calls. Generation has a longer output (a ~550-character body against a one-line
 * verdict), so ~$0.0002/message, which is under $10/year even at 65 senders x 60 recipients.
 * Money is not the reason this needs a human decision; a model writing the words is.
 */

/**
 * `deepseek-v4-flash`, non-thinking — the same model and the same three load-bearing choices
 * as the classifier, for the same reasons.
 *
 * THINKING MODE IS OFF DELIBERATELY. It is on by default at effort `high` and would emit a
 * chain of thought before every message, billing output tokens to deliberate about a DM.
 */
const MODEL = 'deepseek-v4-flash'
const API_URL = 'https://api.deepseek.com/chat/completions'

/**
 * THE SYSTEM PROMPT IS A CONSTANT AND MUST STAY BYTE-IDENTICAL BETWEEN CALLS.
 *
 * DeepSeek's caching is automatic and prefix-based, and a hit requires the prefix to match in
 * FULL. Cache-hit input is $0.0028/1M against $0.14/1M on a miss — **50x** — so interpolating
 * anything at all into this string (a handle, a date, a follower count, the recipient's name)
 * would destroy the cache on every call, forever, and do it silently. Per-recipient facts go
 * in the USER message. The classifier measured an 86% hit rate with this discipline; that
 * number is the evidence it works.
 *
 * The rules below are written as constraints on the OUTPUT rather than as advice, because the
 * gate enforces them mechanically and a prompt that disagrees with the gate produces bodies
 * that are rejected and silently replaced by a variant — generation that costs money and
 * changes nothing.
 */
const SYSTEM_PROMPT = `You write the MIDDLE of a short cold Instagram DM from an Indian entertainment media network to a prospective partner or advertiser.

You write ONLY the middle. Something else supplies the greeting, the sender's introduction line, the closing line and the signature block. Never write any of those.

HARD RULES. A message breaking any of these is discarded.
1. No greeting. Do not begin with Hi, Hello, Hey, Dear or a name.
2. No sign-off, no closing line, no name, no phone number, no email address.
3. No preamble. Do not say "Here is", "Sure", "Draft:". Output the message body and nothing else.
4. No placeholders or template tokens of any kind. Write the actual words.
5. Two to four short paragraphs, separated by a blank line. Between 350 and 1000 characters in total.
6. Plain text. No markdown, no bullet points, no emoji, no headings.

THE ONLY FIGURES YOU MAY EVER STATE, exactly as written here:
- 200+ pages in the network
- 169.2M followers combined (75.6M Instagram, 93.6M Facebook)
- 300M views a day (write this EITHER as "300M views a day" OR as "30 crore views a day", never both — stating one figure twice in two units reads like a machine)
- 10 billion views a month
State no other number about reach, size, price, percentage or growth, in digits OR in words. "eighty million" is as forbidden as "80M". Do not derive one figure from another or claim a relationship between them. Invent nothing. If you do not have a figure, make the point without one.

Use at most two of these figures in the whole message. Reciting the deck is not persuasive.

WHAT THE NETWORK IS, AND NOTHING MORE
Indian entertainment: Bollywood, film, music, television and celebrity coverage. That is the whole of it. Never say the network covers a category it does not, and never shape its description around the recipient's industry — a pet-food brand is not a reason to claim pet pages.

Say NOTHING about the audience. Not its age, city, income, education, gender, interests or intent. We have no such data and inventing it is the easiest way to be caught out by someone who does.

WHAT TO SAY
You are a media OWNER, not a broker. The network is owned, so buying from it is buying reach directly rather than through an intermediary.

To a PUBLISHER (another media page): propose a partnership between peers. An ongoing arrangement across their upcoming releases and moments rather than one campaign at a time.

To a BRAND (a company): propose media buying. They already pay publishers for placement; you own comparable inventory and sell it directly, which usually means a better rate per view and one calendar instead of separate negotiations.

TONE
Write like one business person to another who is busy. Specific, unhurried, no hype, no superlatives, no exclamation marks. British spelling. Never flatter. Never claim to be a fan. Never say "I hope this finds you well".

Reference what you are told about the recipient only if it is given to you, and only as a plain observation. Never guess at their business, their audience or their plans. Never claim they did something unless you are told they did.

End with a small, easy ask — a short call, or permission to send a plan.`

export interface GenerateInput {
  persona: RenderPersona
  target: RenderTarget
  /** Which pool this belongs to, so the ask is the right one. */
  targetKind: string
  /** A plain observation about the recipient, or null. NEVER invented downstream. */
  observation: string | null
  /** Bodies this recipient already has, so the model can be told not to repeat them. */
  priorBodies?: readonly string[]
}

export interface GenerateResult {
  /** The generated middle, as returned. Null when there is no verdict at all. */
  generated: string | null
  /** The full message `renderMessage` produced. Null when generation failed. */
  rendered: string | null
  verdict: QualityVerdict | null
  usage: { cachedInputTokens: number; inputTokens: number; outputTokens: number } | null
  /** Why there is no usable body. Null when there is one. */
  failure: string | null
}

/**
 * Everything per-recipient goes HERE, in the user message, never in the system prompt.
 *
 * Kept deliberately terse and factual. A long user message is a cache MISS on its own tokens
 * — cheap, since it is short — but more importantly every sentence here is a sentence the
 * model may repeat to the recipient, so it must contain nothing we are not willing to say out
 * loud.
 */
function userMessage(input: GenerateInput): string {
  const lines = [
    `Recipient: ${input.target.displayName}`,
    `Recipient type: ${input.targetKind === 'BRAND' ? 'BRAND (a company that buys media)' : 'PUBLISHER (a media page)'}`,
  ]
  if (input.observation) lines.push(`Observation you may reference: ${input.observation}`)
  else lines.push(`Observation: none. Do not reference anything specific about them.`)

  /**
   * Telling the model what it must not repeat is a nicety; the gate's needle check is what
   * actually enforces it. Prompt guidance that is not backed by a check is a hope.
   */
  if (input.priorBodies && input.priorBodies.length > 0) {
    lines.push(
      `They have already received ${input.priorBodies.length} message(s) from us. Make a different point this time; do not restate the previous one.`,
    )
  }
  return lines.join('\n')
}

/**
 * Generate one body and gate it.
 *
 * FAILURE NEVER DEGRADES SILENTLY. No API key, a network error, an empty completion, or a
 * body the gate rejects all yield `generated: null` with a stated `failure`. The caller falls
 * back to a hand-written variant — never to "send it anyway", and never to a fabricated body,
 * which is the same rule `verdictSource: 'none'` enforces for the classifier: a failed call
 * must not be indistinguishable later from a real result.
 */
export async function generateMessageBody(input: GenerateInput): Promise<GenerateResult> {
  const empty: GenerateResult = { generated: null, rendered: null, verdict: null, usage: null, failure: null }

  // Read from the environment directly, exactly as the classifier does — the key is
  // optional and its absence is a normal state, not a configuration error to throw on.
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return { ...empty, failure: 'no DEEPSEEK_API_KEY — generation is unavailable' }

  const startedAt = Date.now()
  const fail = (error: string): GenerateResult => {
    void recordModelCall({
      purpose: 'generate',
      model: MODEL,
      subject: input.target.handle,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: Date.now() - startedAt,
      ok: false,
      error,
    })
    return { ...empty, failure: error }
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        // See the note on MODEL: on by default, and would bill reasoning tokens per DM.
        thinking: { type: 'disabled' },
        max_tokens: 600,
        // Not 0. A deterministic body would be identical for every recipient in the same
        // situation, which is the repetition decision 3 exists to prevent — the whole reason
        // to generate rather than template. Low enough to stay on-instruction.
        temperature: 0.8,
        messages: [
          // System FIRST and constant: this is the cacheable prefix.
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage(input) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      log.warn('generation request failed', { status: res.status, body })
      return fail(`HTTP ${res.status}`)
    }

    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number }
    }
    const usage = {
      cachedInputTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
      inputTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    }

    void recordModelCall({
      purpose: 'generate',
      model: MODEL,
      subject: input.target.handle,
      ...usage,
      ms: Date.now() - startedAt,
      ok: true,
    })

    const generated = (payload.choices?.[0]?.message?.content ?? '').trim()
    if (generated.length === 0) return { ...empty, usage, failure: 'the model returned an empty body' }

    const { body: rendered } = renderMessage({
      persona: input.persona,
      target: input.target,
      variantBody: generated,
      // No hook line: the model was given the observation directly and writes it into the
      // prose. Adding `buildHookLine` on top would staple two openings together, which is the
      // same reason a bespoke first touch suppresses it.
      hook: null,
    })

    const verdict = checkGeneratedMessage({
      generated,
      rendered,
      persona: input.persona,
      target: input.target,
      priorBodies: input.priorBodies,
      // The gate's only handle on invented claims about the recipient. Passing the real
      // answer matters in both directions: without an observation a claim of prior knowledge
      // is a fabrication, and with one it is the whole point of the message.
      hasObservation: input.observation !== null,
    })

    if (!verdict.ok) {
      return {
        generated,
        rendered,
        verdict,
        usage,
        failure: `the quality gate refused it: ${verdict.problems.map((p) => p.code).join(', ')}`,
      }
    }

    return { generated, rendered, verdict, usage, failure: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('generation threw', { error: message })
    return fail(message)
  }
}
