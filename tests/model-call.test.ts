import { describe, it, expect } from 'vitest'
import { deepseekCostUsd, cacheHitRate, costUsdForModel, DEEPSEEK_FLASH_PRICING } from '@/lib/modelCall'
import type { ModelPurpose } from '@/lib/modelCall'

/**
 * Phase 1 — model spend is recorded rather than remembered.
 *
 * The arithmetic used to live as a bare expression inside `scripts/classify.ts`, so the
 * only caller that reported cost was the one script anybody happened to run. Phase 8
 * generates a message per detected post, which turns "is this getting expensive?" from a
 * question nobody asked into one somebody will.
 */

describe('deepseekCostUsd', () => {
  it('prices a pure cache hit fifty times cheaper than a miss', () => {
    const hit = deepseekCostUsd({ cachedInputTokens: 1_000_000, inputTokens: 0, outputTokens: 0 })
    const miss = deepseekCostUsd({ cachedInputTokens: 0, inputTokens: 1_000_000, outputTokens: 0 })
    expect(hit).toBeCloseTo(DEEPSEEK_FLASH_PRICING.cachedInputPerM, 10)
    expect(miss).toBeCloseTo(DEEPSEEK_FLASH_PRICING.inputPerM, 10)
    expect(miss / hit).toBeCloseTo(50, 0)
  })

  it('adds the three components', () => {
    const cost = deepseekCostUsd({ cachedInputTokens: 500_000, inputTokens: 500_000, outputTokens: 1_000_000 })
    expect(cost).toBeCloseTo(0.0014 + 0.07 + 0.28, 6)
  })

  it('is zero for a call that used nothing', () => {
    expect(deepseekCostUsd({ cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  /**
   * The measured baseline: 62 posts through the classifier cost ~$0.0016 at an 86% cache
   * hit rate. Recomputing it here is a canary — if the prices are edited, this says so.
   */
  it('reproduces the measured 2026-08-03 classifier run to the right order of magnitude', () => {
    const cost = deepseekCostUsd({ cachedInputTokens: 55_000, inputTokens: 9_000, outputTokens: 2_000 })
    expect(cost).toBeGreaterThan(0.0005)
    expect(cost).toBeLessThan(0.005)
  })
})

describe('cacheHitRate', () => {
  /**
   * The number most easily destroyed by accident. Interpolating a date, a channel name or
   * a post count into a system prompt makes every call a miss — forever, silently, at 50x
   * — and nothing else in the system would report it.
   */
  it('reports the share of input served from cache', () => {
    expect(cacheHitRate({ cachedInputTokens: 86, inputTokens: 14, outputTokens: 0 })).toBeCloseTo(0.86, 5)
    expect(cacheHitRate({ cachedInputTokens: 0, inputTokens: 100, outputTokens: 0 })).toBe(0)
    expect(cacheHitRate({ cachedInputTokens: 100, inputTokens: 0, outputTokens: 0 })).toBe(1)
  })

  /** Null, not 0. "No input yet" and "every call missed the cache" are different facts. */
  it('is null rather than zero when there was no input at all', () => {
    expect(cacheHitRate({ cachedInputTokens: 0, inputTokens: 0, outputTokens: 500 })).toBeNull()
  })

  it('ignores output tokens, which are never cached', () => {
    const a = cacheHitRate({ cachedInputTokens: 50, inputTokens: 50, outputTokens: 0 })
    const b = cacheHitRate({ cachedInputTokens: 50, inputTokens: 50, outputTokens: 999_999 })
    expect(a).toBe(b)
  })
})

/**
 * Brand resolution joins the ledger as its OWN purpose.
 *
 * Instagram's category endpoint fails on precisely the accounts most likely to be brands
 * (the deleted-schema bug — @adidas is unreadable), so a model decides instead. Its spend
 * must be broken out in `spendSince` rather than blurred into the caption classifier's
 * bucket: the two answer different questions, and one bucket rising cannot be attributed.
 */
describe('the resolve purpose', () => {
  it('is a member of ModelPurpose', () => {
    // A type-level assertion: this file does not compile if the union rejects it, and
    // `pnpm typecheck` is what runs that check.
    const p: ModelPurpose = 'resolve'
    expect(p).toBe('resolve')
  })

  /**
   * Pricing is BY MODEL, never by purpose — so a new purpose must cost the same as any
   * other flash call. A zero here would read as "brand resolution is free".
   */
  it('prices a resolve call like any flash call', () => {
    expect(costUsdForModel('deepseek-v4-flash', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 50 })).toBeGreaterThan(0)
  })
})
