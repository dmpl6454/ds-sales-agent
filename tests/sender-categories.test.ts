import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CATEGORY_SLUG,
  MARKETING_CATEGORY_SLUG,
  MARKETING_CHANNEL_HANDLES,
  effectiveCategories,
  sameCategory,
  crossCategoryDetail,
} from '@/outreach/senderCategories'
import { mayRouteExist } from '@/outreach/routes'
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'

/**
 * TWO FLEETS, AND THEY NEVER WRITE TO EACH OTHER'S COMPANIES — 2026-08-25.
 *
 * Tabish: *"brand category senders must never send messages to targets … discovered via
 * bollywood categories' monitoring targets and vice versa"*, with his own exception —
 * *"unless they are present common elsewhere"*.
 *
 * The load-bearing decision is that an ABSENT membership means the DEFAULT category rather
 * than "unrestricted". That is what lets today's five senders and 500 recipients keep routing
 * to each other with **no migration** — and it is also the thing most likely to be
 * "simplified" into `if (targetCats.length === 0) return true`, which would let a marketing
 * page write to every bollywood company. Both directions are pinned below.
 */

describe('effectiveCategories — an absent membership is the default, not a wildcard', () => {
  it('reads an empty list as the default category', () => {
    expect(effectiveCategories([])).toEqual([DEFAULT_CATEGORY_SLUG])
  })

  it('leaves an explicit membership alone', () => {
    expect(effectiveCategories([MARKETING_CATEGORY_SLUG])).toEqual([MARKETING_CATEGORY_SLUG])
  })

  it('normalises case and blanks, so a hand-typed slug cannot split a fleet in two', () => {
    expect(effectiveCategories(['  Marketing ', '', 'marketing'])).toEqual(['marketing'])
  })
})

describe('sameCategory — the six cases that define the rule', () => {
  const B: string[] = []
  const M = [MARKETING_CATEGORY_SLUG]
  const BOTH = [DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG]

  it("today's fleet keeps writing to today's recipients", () => {
    expect(sameCategory(B, B)).toBe(true)
  })

  it('a marketing page may not write to a bollywood company', () => {
    expect(sameCategory(M, B)).toBe(false)
  })

  it('a bollywood page may not write to a marketing company', () => {
    expect(sameCategory(B, M)).toBe(false)
  })

  it('a marketing page writes to marketing companies', () => {
    expect(sameCategory(M, M)).toBe(true)
  })

  it('"unless they are present common elsewhere" — a company in BOTH is reachable by both', () => {
    expect(sameCategory(B, BOTH)).toBe(true)
    expect(sameCategory(M, BOTH)).toBe(true)
  })

  it('a third fleet is refused by both existing ones with no code change', () => {
    expect(sameCategory(['events'], B)).toBe(false)
    expect(sameCategory(['events'], M)).toBe(false)
    expect(sameCategory(['events'], ['events'])).toBe(true)
  })
})

describe('the rule is enforced at BOTH ends', () => {
  const route = (senderCategories: string[], targetCategories: string[]) =>
    mayRouteExist({
      senderHandle: 'somesender',
      targetHandle: 'somebrand',
      senderCategories,
      targetCategories,
      ourHandles: new Set<string>(),
      senderIsFleetMember: true,
      targetOptedOut: false,
      targetIsWatchOnly: false,
    })

  it('routes.ts refuses to CREATE a cross-fleet pair', () => {
    expect(route([MARKETING_CATEGORY_SLUG], []).allowed).toBe(false)
    expect(route([], [MARKETING_CATEGORY_SLUG]).allowed).toBe(false)
  })

  it('routes.ts still creates the ordinary pair — the refusals above are not vacuous', () => {
    expect(route([], []).allowed).toBe(true)
    expect(route([MARKETING_CATEGORY_SLUG], [MARKETING_CATEGORY_SLUG]).allowed).toBe(true)
  })

  const gate = (senderCategories: string[], targetCategories: string[]) =>
    evaluateResend({
      attemptStatus: 'READY',
      unattended: false,
      senderStatus: 'ACTIVE',
      senderHasSession: true,
      parkedFailureCode: null,
      material: { held: false, allowance: 1, delivered: 0 },
      targetOptedOut: false,
      targetIsWatchOnly: false,
      senderCategories,
      targetCategories,
      targetIsVerified: true,
      targetRepliedAt: null,
      pairSentTodayCount: 0,
      maxPerPairPerDay: 5,
      crossSpacing: { held: false },
    } as Parameters<typeof evaluateResend>[0])

  it('gate.ts refuses to SEND one written before the rule', () => {
    const r = gate([MARKETING_CATEGORY_SLUG], [])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(RESEND_BLOCKS.DIFFERENT_CATEGORY)
  })

  it('gate.ts permits the ordinary case — so the refusal above is not vacuous', () => {
    expect(gate([], []).ok).toBe(true)
  })

  it('is NOT crossable by a human acknowledgement — it is about WHICH FLEET, not WHEN', () => {
    /*
      Every stop a person may cross is about TIMING. A recipient that genuinely belongs to
      both fleets is put in BOTH categories, which is the supported answer — not an override.
    */
    expect(OVERRIDABLE_BLOCKS).not.toContain(RESEND_BLOCKS.DIFFERENT_CATEGORY)
  })

  it('names both fleets in the refusal, so the sentence is actionable', () => {
    const detail = crossCategoryDetail([MARKETING_CATEGORY_SLUG], [])
    expect(detail).toContain(MARKETING_CATEGORY_SLUG)
    expect(detail).toContain(DEFAULT_CATEGORY_SLUG)
  })
})

describe('the channel list Tabish gave', () => {
  it('carries all five, with the handle we actually watch for M.O.M', () => {
    expect(MARKETING_CHANNEL_HANDLES).toContain('madovermarketing_mom')
    expect(MARKETING_CHANNEL_HANDLES).toContain('socialsamosa')
    expect(MARKETING_CHANNEL_HANDLES).toContain('afaqs')
    expect(MARKETING_CHANNEL_HANDLES).toContain('exchange4media')
    expect(MARKETING_CHANNEL_HANDLES).toContain('marketingmentalist')
  })
})

/**
 * And every creator must ASK — the missing-caller failure this repo keeps producing. A
 * behavioural test cannot fail for a call site nobody has written.
 */
describe('every route creator passes the categories', () => {
  const root = join(import.meta.dirname, '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  it.each([
    'src/outreach/plan.ts',
    'src/outreach/brandTarget.ts',
    'src/outreach/importProspects.ts',
    'src/app/actions.ts',
  ])('%s passes senderCategories and targetCategories', (file) => {
    const src = read(file)
    expect(src, 'must load the memberships once, never per pair').toContain('readCategoryMemberships')
    expect(src).toMatch(/senderCategories: categoriesFor\(/)
    expect(src).toMatch(/targetCategories: categoriesFor\(/)
  })

  it('the gate loads them too', () => {
    const src = read('src/outreach/gate.ts')
    expect(src).toContain('readCategoryMemberships')
    expect(src).toMatch(/senderCategories: categoriesFor\(/)
  })
})
