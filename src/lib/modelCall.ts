import { prisma } from './db'
import { log } from './logger'

/**
 * What a model call cost — recorded, not remembered.
 *
 * Until now the only record of model spend was a line `ig:classify` printed and then
 * threw away, so "has generation got expensive?" was unanswerable after the fact. Phase 8
 * generates a message per detected post, which turns a question nobody could answer into
 * one somebody will need to.
 *
 * THE PRICES ARE HERE, ONCE. They were a bare arithmetic expression inside
 * `scripts/classify.ts` and nowhere else, so every other caller either recomputed them or
 * silently reported nothing.
 */

/** DeepSeek v4 flash, USD per 1M tokens. Cached input is FIFTY TIMES cheaper than a miss. */
export const DEEPSEEK_FLASH_PRICING = {
  cachedInputPerM: 0.0028,
  inputPerM: 0.14,
  outputPerM: 0.28,
} as const

/**
 * A DELIBERATELY EXPENSIVE fallback rate, used only when a model this table has never
 * heard of appears in the ledger.
 *
 * There is ONE model in this system today and there is meant to be: a vision API was
 * built here on 2026-08-07 and reverted the next day, because reading the words printed
 * on a video turned out to need no API at all (src/detection/ocr.ts). This row survives
 * that revert on purpose — the moment a second provider is added, its calls must not be
 * silently priced at DeepSeek's rates, and an over-estimate with a warning beats both a
 * silent zero (reads as free) and a silent 50x understatement.
 */
const UNKNOWN_MODEL_PRICING = {
  cachedInputPerM: 0.025,
  inputPerM: 0.1,
  outputPerM: 0.4,
} as const

/**
 * Pricing is BY MODEL, so the ledger cannot misprice a call it does not recognise.
 * A wrong number is worse than no number, in the one table whose job is answering
 * "has this got expensive?".
 */
interface ModelPricing {
  cachedInputPerM: number
  inputPerM: number
  outputPerM: number
}

const PRICING_BY_MODEL: Record<string, ModelPricing> = {
  'deepseek-v4-flash': DEEPSEEK_FLASH_PRICING,
}

/**
 * What a call was FOR, not which model served it. A CLOSED union so a new kind of spend
 * has to be declared here — `spendSince` filters on it, and an undeclared purpose would
 * be spend nobody could break out.
 *
 * `resolve` is brand resolution: Instagram's own category endpoint returns HTTP 400 on
 * precisely the accounts most likely to be brands (Meta's deleted sub-vertical schema —
 * @adidas is unreadable), so a model answers "is this handle a company?" instead. It is
 * its own bucket rather than part of `classify` because the two answer different questions
 * about different subjects, and one bucket rising is unattributable.
 */
export type ModelPurpose = 'classify' | 'generate' | 'quality' | 'resolve'

export interface ModelUsage {
  /** Tokens served from DeepSeek's prompt cache. 50x cheaper — tracked separately for that reason. */
  cachedInputTokens: number
  /** Tokens that missed the cache. */
  inputTokens: number
  outputTokens: number
}

export function deepseekCostUsd(u: ModelUsage): number {
  return costUsdForModel('deepseek-v4-flash', u)
}

/**
 * Cost for a call, priced by the model that actually served it.
 *
 * An UNKNOWN model (a provider added later, or a model name changed upstream) is
 * estimated at the deliberately high fallback rate and logged — an estimate with a
 * warning beats both a silent zero (reads as free) and a silent DeepSeek price (reads as
 * fifty times cheaper than reality could be).
 */
export function costUsdForModel(model: string, u: ModelUsage): number {
  const p = PRICING_BY_MODEL[model]
  if (!p) {
    log.warn('no pricing recorded for this model — estimating high, add it to PRICING_BY_MODEL', { model })
  }
  const rates = p ?? UNKNOWN_MODEL_PRICING
  return (
    (u.cachedInputTokens / 1e6) * rates.cachedInputPerM +
    (u.inputTokens / 1e6) * rates.inputPerM +
    (u.outputTokens / 1e6) * rates.outputPerM
  )
}

/**
 * The share of input tokens that hit the cache, 0–1, or null when there was no input.
 *
 * This is the number that matters most and the one most easily destroyed by accident:
 * interpolating ANYTHING into a system prompt — a date, a channel name, a post count —
 * makes every call a cache miss, forever, silently, at fifty times the price. Nothing
 * else in the system would report it.
 */
export function cacheHitRate(u: ModelUsage): number | null {
  const total = u.cachedInputTokens + u.inputTokens
  return total === 0 ? null : u.cachedInputTokens / total
}

export interface RecordModelCallArgs extends ModelUsage {
  purpose: ModelPurpose
  model: string
  /** What it was about — a shortcode, a handle. For a human; never parsed back into logic. */
  subject?: string | null
  ms: number
  ok?: boolean
  error?: string | null
}

/**
 * Never throws, and never blocks the work it is measuring.
 *
 * A cost row failing to write must not fail a classification or abandon a drafted
 * message. This is instrumentation: the moment it can break the thing it observes, it
 * stops being safe to call from the hot path.
 */
export async function recordModelCall(args: RecordModelCallArgs): Promise<void> {
  try {
    await prisma.modelCall.create({
      data: {
        purpose: args.purpose,
        model: args.model,
        subject: args.subject ?? null,
        inputTokens: args.inputTokens,
        cachedInputTokens: args.cachedInputTokens,
        outputTokens: args.outputTokens,
        costUsd: costUsdForModel(args.model, args),
        ms: args.ms,
        ok: args.ok ?? true,
        error: args.error ?? null,
      },
    })
  } catch (e) {
    log.warn('could not record model call cost', { error: e instanceof Error ? e.message : String(e) })
  }
}

export interface SpendSummary {
  calls: number
  failed: number
  costUsd: number
  cachedInputTokens: number
  inputTokens: number
  outputTokens: number
  /** 0–1, or null when nothing has been spent yet. */
  cacheHitRate: number | null
}

/** What has been spent since `since`, optionally for one purpose. */
export async function spendSince(since: Date, purpose?: ModelPurpose): Promise<SpendSummary> {
  const rows = await prisma.modelCall.findMany({
    where: { at: { gte: since }, ...(purpose ? { purpose } : {}) },
    select: {
      costUsd: true,
      cachedInputTokens: true,
      inputTokens: true,
      outputTokens: true,
      ok: true,
    },
  })

  const totals = rows.reduce(
    (a, r) => ({
      costUsd: a.costUsd + r.costUsd,
      cachedInputTokens: a.cachedInputTokens + r.cachedInputTokens,
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      failed: a.failed + (r.ok ? 0 : 1),
    }),
    { costUsd: 0, cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, failed: 0 },
  )

  return {
    calls: rows.length,
    failed: totals.failed,
    costUsd: totals.costUsd,
    cachedInputTokens: totals.cachedInputTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheHitRate: cacheHitRate(totals),
  }
}
