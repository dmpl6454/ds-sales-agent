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
import { ringMembersFor } from '@/outreach/categories'
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { templateForSettings } from '@/outreach/fleetTemplate'
import { followUpForSettings } from '@/outreach/followUpTemplate'

/** A WRITTEN follow-up message, built by the REAL rule. See tests/follow-up-template.test.ts. */
const FOLLOW_UP_WRITTEN = followUpForSettings(
  { followUpBody: `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`, followUpBodies: new Map() },
  [],
  [],
)


/**
 * The DEFAULT fleet's template, built by the REAL rule rather than written as a literal —
 * a hand-written verdict object goes stale GREEN the day the rule changes shape, which is
 * this suite's own recorded lesson from the `too-soon` fixture.
 */
const DEFAULT_FLEET_TEMPLATE = templateForSettings(
  { singleTemplateBody: null, fleetTemplateBodies: new Map() },
  [],
  [],
)


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
      /* The fleets' own copy is a SEPARATE rule (fleetTemplate.ts) — this file is about the
         category rule alone, so the template is always resolvable here and cannot mask it. */
      repeatsADeliveredBody: false,
      fleetTemplate: templateForSettings(
        { singleTemplateBody: 'a body long enough to satisfy the send guards comfortably.', fleetTemplateBodies: new Map([[MARKETING_CATEGORY_SLUG, 'the marketing fleet body, also long enough to be sendable.']]) },
        senderCategories,
        targetCategories,
      ),
      targetIsVerified: true,
      targetRepliedAt: null,
      pairSentTodayCount: 0,
      maxPerPairPerDay: 5,
      crossSpacing: { held: false },
      /* A first touch, so the follow-up rule cannot mask the category rule under test. */
      isFollowUp: false,
      followUpCitesOnlyADate: false,
      followUpTemplate: FOLLOW_UP_WRITTEN,
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

/**
 * ── A PROSPECT INHERITS ITS CHANNEL'S FLEET, AND IT DOES SO BEFORE THE ROUTES ──
 *
 * MEASURED 2026-08-26, and this is what the test is for. Two prospects — @irctc.official
 * and @sprite_india — were minted from an @exchange4media (marketing) paid post at 17:05
 * IST on 25 August, received NO membership, and were messaged by bollywood pages at 17:19
 * and 17:20. The inheritance rule was committed at 17:56, fifty-one minutes later.
 *
 * THE MEASUREMENT THAT MISSED IT IS THE OTHER HALF OF THE LESSON. That evening's health
 * check read "0 messages to any marketing-fleet target" — over the rows CARRYING the tag.
 * The leak was precisely the rows that failed to be tagged, so the check agreed with
 * itself. A rule measured by the set it maintains cannot see the set it failed to build;
 * the honest question is about PROVENANCE, which is what this rule implements.
 *
 * A SOURCE GREP, because the failure mode is a creator that stops asking — and no
 * behavioural test can fail for a line somebody deletes from one of five discovery paths.
 * The ORDER assertion is the load-bearing one: `routeAllowed` READS the memberships, so a
 * category applied after the pairs are created leaves the new prospect already wired to
 * every sender of the other fleet, and the gate then holds every one of those drafts
 * forever.
 */
describe('a prospect inherits the fleet of the channel whose paid post found it', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/outreach/brandTarget.ts'), 'utf8')

  it('reads the source channel’s categories', () => {
    expect(src, 'the one creator no longer copies the channel’s fleet onto the prospect').toMatch(
      /categories:\s*\{\s*where:\s*\{\s*enabled:\s*true\s*\}/,
    )
    expect(src).toContain('categoryTarget.upsert')
  })

  it('writes the membership BEFORE it creates the routes', () => {
    const membership = src.indexOf('categoryTarget.upsert')
    const routes = src.indexOf('outreachPair.createMany')
    expect(membership, 'the membership write is gone').toBeGreaterThan(-1)
    expect(routes, 'the route creation is gone').toBeGreaterThan(-1)
    expect(
      membership,
      'the fleet is applied AFTER the routes — the new prospect is wired to the other fleet first',
    ).toBeLessThan(routes)
  })

  /**
   * And it is the ONE door. Every discovery path — autoResolve, officialDiscovery,
   * badgeDoor, ig:find-official, ig:brands — goes through `createBrandTarget`, so the rule
   * above covers all of them. A sixth path creating a row itself would bypass it silently.
   */
  it('no discovery path creates a TargetAccount of its own', () => {
    const root = join(import.meta.dirname, '..')
    for (const f of [
      'src/detection/autoResolve.ts',
      'src/detection/officialDiscovery.ts',
      'src/detection/badgeDoor.ts',
      'src/scripts/find-official.ts',
      'src/scripts/brands.ts',
    ]) {
      const s = readFileSync(join(root, f), 'utf8')
      expect(s, `${f} creates a target row directly instead of going through createBrandTarget`).not.toMatch(
        /prisma\.targetAccount\.(create|upsert)\(/,
      )
      expect(s, `${f} no longer uses the one creator`).toContain('createBrandTarget')
    }
  })
})

/**
 * ── ROTATION MUST NOT ELECT A SENDER THE GATE WILL REFUSE ─────────────────
 *
 * MEASURED 2026-08-26, the hour @madaboutmarketingg joined the marketing fleet. It still held
 * **60 pair rows to bollywood companies** from its old life. `routes.ts` refuses to CREATE
 * such a route and `gate.ts` refuses to SEND on one — but the ring is built from the pair rows
 * that EXIST, so it was a ring member for all 60 and rotation had **elected it for 15**
 * (@dharmaticent, @amazonmgmstudios, @universalmusicgroup, …).
 *
 * Rotation elects ONE sender per recipient. So each of those bollywood companies had its turn
 * assigned to a page the gate refuses with `different-category`, every other page was skipped
 * as `not-this-senders-turn`, and the turn only advances on a DELIVERY that can never happen.
 * A self-locking stall — the same one the parked-route fix records, arriving through the fleet
 * rule instead. After the fix: **15 elected → 0**.
 *
 * NOTHING IS WEAKENED. The pair stays refused at both ends; this only stops rotation electing
 * a page that is already forbidden, so the recipient's own fleet takes its turn.
 */
describe('the ring never names a sender that may not write to this recipient', () => {
  const memberships = {
    bySenderHandle: new Map([
      ['madaboutmarketingg', [MARKETING_CATEGORY_SLUG]],
      // bollywood pages carry NO membership — the default, which is the whole scheme.
    ]),
    byTargetHandle: new Map([['amazondotin', [MARKETING_CATEGORY_SLUG]]]),
  }
  const fleet = [
    { id: 's1', handle: 'bollywoodsocietyy', cohort: 1 },
    { id: 's2', handle: 'madaboutmarketingg', cohort: 1 },
  ]

  it('drops the marketing page from a BOLLYWOOD recipient’s ring', () => {
    const ring = ringMembersFor(fleet, 'shashi.official', memberships)
    expect(ring.map((r) => r.handle)).toEqual(['bollywoodsocietyy'])
  })

  it('drops the bollywood pages from a MARKETING recipient’s ring', () => {
    const ring = ringMembersFor(fleet, 'amazondotin', memberships)
    expect(ring.map((r) => r.handle)).toEqual(['madaboutmarketingg'])
  })

  /** And the permitting direction, so neither case above is vacuous. */
  it('keeps every page whose fleet the recipient shares', () => {
    const bollywoodOnly = { bySenderHandle: new Map<string, string[]>(), byTargetHandle: new Map<string, string[]>() }
    expect(ringMembersFor(fleet, 'shashi.official', bollywoodOnly).map((r) => r.handle)).toEqual([
      'bollywoodsocietyy',
      'madaboutmarketingg',
    ])
  })

  /**
   * A recipient BOTH fleets found — Tabish's own "unless they are present common elsewhere".
   * Every page keeps its turn, because each one's fleet intersects the recipient's.
   */
  it('keeps both fleets for a company that belongs to both', () => {
    const both = {
      bySenderHandle: memberships.bySenderHandle,
      byTargetHandle: new Map([['shared.co', [DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG]]]),
    }
    expect(ringMembersFor(fleet, 'shared.co', both).map((r) => r.handle)).toEqual([
      'bollywoodsocietyy',
      'madaboutmarketingg',
    ])
  })

  /**
   * An empty ring is the CORRECT answer when no page may write — `nextSender` refuses with
   * `empty-ring`, which the rest tally renders as "no page sends for their fleet yet".
   * Silently falling back to every sender would be the failure this whole file is about.
   */
  it('returns an empty ring rather than falling back to everybody', () => {
    const noBollywoodPage = { bySenderHandle: memberships.bySenderHandle, byTargetHandle: memberships.byTargetHandle }
    expect(ringMembersFor([fleet[0]!], 'amazondotin', noBollywoodPage)).toEqual([])
  })
})
