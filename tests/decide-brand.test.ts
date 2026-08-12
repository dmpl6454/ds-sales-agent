import { describe, expect, it } from 'vitest'
import { interpretDecision, RESOLVE_CONFIDENCE_FLOOR } from '@/detection/decideBrand'

/**
 * The PURE half of the model resolver, both directions.
 *
 * WHY THE POLITICIAN IS THE REQUIRED FIXTURE. Three docblocks in this repo record the
 * same measurement: @tilara.india (a brand) and @adityathackeray (a politician) are
 * byte-identical on every field we can read anonymously, so no rule over the readable
 * fields can separate them. What separates them is world knowledge. If this file ever
 * files him BRAND, a media-buying pitch goes to a politician from a revenue account.
 *
 * The other half of the safety property is SILENCE: `unsure` and anything under the
 * floor must decide NOTHING. A wrong "company" sends a sales pitch to a person; a
 * wrong skip costs one prospect. Asymmetric, so both are asserted.
 */
describe('interpretDecision (pure half)', () => {
  it('a confident company becomes BRAND', () => {
    const v = interpretDecision({
      handle: 'adidas',
      decision: { kind: 'company', confidence: 98, reason: 'global sportswear brand' },
    })
    expect(v).toMatchObject({ kind: 'BRAND', handle: 'adidas' })
  })

  it('a confident person/politician becomes PERSON — never a prospect', () => {
    const v = interpretDecision({
      handle: 'adityathackeray',
      decision: { kind: 'person', confidence: 97, reason: 'politician' },
    })
    expect(v).toMatchObject({ kind: 'PERSON' })
  })

  it('an agency is filed PERSON-side (not a prospect), like the existing category rule', () => {
    const v = interpretDecision({
      handle: 'mind_shifters',
      decision: { kind: 'not-a-prospect', confidence: 95, reason: 'marketing agency' },
    })
    expect(v).toMatchObject({ kind: 'PERSON' })
  })

  it('below the floor NOTHING is decided — unsure stays UNRESOLVED and is never messaged', () => {
    const v = interpretDecision({
      handle: 'somelocalshop',
      decision: { kind: 'company', confidence: 70, reason: 'maybe a shop' },
    })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })

  it('unsure stays UNRESOLVED whatever the confidence claims', () => {
    const v = interpretDecision({ handle: 'x', decision: { kind: 'unsure', confidence: 99, reason: '?' } })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })

  it('a failed call decides nothing (null in → null out)', () => {
    expect(interpretDecision({ handle: 'x', decision: null })).toBeNull()
  })

  /**
   * THE BOUNDARY, both sides. The floor is a safety threshold, so which side of it
   * `=== RESOLVE_CONFIDENCE_FLOOR` lands on is a decision and not an implementation
   * detail — `<` vs `<=` is one character and changes what gets messaged. Asserted
   * against the exported constant rather than the literal 90, so raising the floor
   * cannot silently make this test describe a different boundary than the code's.
   */
  it('exactly at the floor is confident enough — the bound is inclusive', () => {
    const v = interpretDecision({
      handle: 'crocsindia',
      decision: { kind: 'company', confidence: RESOLVE_CONFIDENCE_FLOOR, reason: 'footwear brand' },
    })
    expect(v).toMatchObject({ kind: 'BRAND', handle: 'crocsindia' })
  })

  it('one point under the floor decides nothing', () => {
    const v = interpretDecision({
      handle: 'crocsindia',
      decision: { kind: 'company', confidence: RESOLVE_CONFIDENCE_FLOOR - 1, reason: 'probably footwear' },
    })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })

  /**
   * A sub-floor PERSON is also UNRESOLVED, not PERSON. It reads like the safe direction
   * to file an unsure person as PERSON — it is never messaged either way — but PERSON is
   * a cached ANSWER that never retries, so a low-confidence guess would permanently
   * discard a real prospect on evidence the model itself did not trust. That is
   * "absence of data hardening into a negative verdict" one door along, and this repo
   * has produced that shape four times.
   */
  it('a sub-floor person is UNRESOLVED, not a cached PERSON answer', () => {
    const v = interpretDecision({
      handle: 'obscurehandle',
      decision: { kind: 'person', confidence: 55, reason: 'might be someone' },
    })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })

  /** The floor is high on purpose. A pitch to a private person is the failure it prevents. */
  it('the floor is high — a coin flip can never decide a prospect', () => {
    expect(RESOLVE_CONFIDENCE_FLOOR).toBeGreaterThanOrEqual(80)
  })

  /** The reason travels, so an operator can see WHY nothing was decided. */
  it('an UNRESOLVED verdict says what the model actually answered', () => {
    const v = interpretDecision({
      handle: 'x',
      decision: { kind: 'unsure', confidence: 40, reason: 'no idea' },
    })
    expect(v?.kind).toBe('UNRESOLVED')
    if (v?.kind !== 'UNRESOLVED') throw new Error('narrowing')
    expect(v.reason).toContain('unsure')
    expect(v.reason).toContain('40')
  })
})
