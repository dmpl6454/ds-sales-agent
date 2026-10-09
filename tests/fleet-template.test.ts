import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { templateForRoute, routeFleets, fleetTemplateKey, isStandardMessageBody, SINGLE_TEMPLATE_MIDDLE } from '@/outreach/fleetTemplate'
import { FOLLOW_UP_POST_TOKEN, followUpPostReference, renderFollowUp } from '@/outreach/followUpTemplate'
import { DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG } from '@/outreach/senderCategories'

const ROOT_DIR = resolve(__dirname, '..')

/**
 * A SEPARATE STANDARD MESSAGE PER FLEET, AND AN UNSET ONE REFUSES.
 *
 * The case that carries the weight is `refuses a fleet whose copy is not written yet` and
 * its two negatives directly beneath it. Tabish's instruction was *"keep it empty for
 * now"* WITH autopilot on and a marketing sender about to be connected — so the empty
 * state is not a corner case here, it is the state the system is actually in, and the two
 * ways of getting it wrong (send the other fleet's copy; send nothing) are both silent.
 */

const DEFAULT_BODY = 'Hi,this is the standard bollywood message and it is comfortably long enough.'
const MARKETING_BODY = 'Hi,this is the marketing fleet message and it is also comfortably long enough.'

const NO_BODIES = new Map<string, string | null>()
const WITH_MARKETING = new Map<string, string | null>([[MARKETING_CATEGORY_SLUG, MARKETING_BODY]])

function ask(over: {
  senderCategories?: readonly string[]
  targetCategories?: readonly string[]
  bodies?: ReadonlyMap<string, string | null>
  defaultBody?: string
} = {}) {
  return templateForRoute({
    senderCategories: over.senderCategories ?? [],
    targetCategories: over.targetCategories ?? [],
    defaultBody: over.defaultBody ?? DEFAULT_BODY,
    bodies: over.bodies ?? NO_BODIES,
  })
}

describe('which fleet a route belongs to', () => {
  it('an absent membership on both sides is the DEFAULT fleet, not "any fleet"', () => {
    expect(routeFleets([], [])).toEqual([DEFAULT_CATEGORY_SLUG])
  })

  it('a second-fleet page writing to a second-fleet recipient is that fleet', () => {
    expect(routeFleets(['marketing'], ['marketing'])).toEqual(['marketing'])
  })

  /**
   * Tabish's own exception — *"unless they are present common elsewhere"*. A company BOTH
   * fleets found hears the pitch of whichever page is writing, which is why this is an
   * INTERSECTION and not the recipient's own membership.
   */
  it('a recipient in BOTH fleets takes the WRITING page’s fleet', () => {
    expect(routeFleets(['marketing'], ['bollywood', 'marketing'])).toEqual(['marketing'])
    expect(routeFleets([], ['bollywood', 'marketing'])).toEqual([DEFAULT_CATEGORY_SLUG])
  })

  it('sets that do not meet are empty — the cross-fleet route the category rule refuses', () => {
    expect(routeFleets(['marketing'], [])).toEqual([])
    expect(routeFleets([], ['marketing'])).toEqual([])
  })

  it('normalises case and whitespace on both sides, so a stray capital cannot split a fleet', () => {
    expect(routeFleets([' Marketing '], ['MARKETING'])).toEqual(['marketing'])
  })
})

describe('the standard message a route sends', () => {
  it('today’s fleet gets the default copy, unchanged', () => {
    const t = ask()
    expect(t.ok).toBe(true)
    if (t.ok) {
      expect(t.slug).toBe(DEFAULT_CATEGORY_SLUG)
      expect(t.body).toBe(DEFAULT_BODY)
    }
  })

  it('a second fleet with its own copy written sends THAT copy', () => {
    const t = ask({ senderCategories: ['marketing'], targetCategories: ['marketing'], bodies: WITH_MARKETING })
    expect(t.ok).toBe(true)
    if (t.ok) {
      expect(t.slug).toBe('marketing')
      expect(t.body).toBe(MARKETING_BODY)
    }
  })

  /* ── THE ONE THIS FILE EXISTS FOR ──────────────────────────────────────── */

  it('REFUSES a fleet whose copy is not written yet', () => {
    const t = ask({ senderCategories: ['marketing'], targetCategories: ['marketing'] })
    expect(t.ok).toBe(false)
    if (!t.ok) {
      expect(t.reason).toBe('not-set')
      expect(t.slug).toBe('marketing')
    }
  })

  it('does NOT fall back to the other fleet’s copy — the failure would be invisible', () => {
    const t = ask({ senderCategories: ['marketing'], targetCategories: ['marketing'] })
    expect(t.ok).toBe(false)
    expect(JSON.stringify(t)).not.toContain(DEFAULT_BODY)
  })

  it('does NOT hand back an empty body — that refuses every send with no sentence naming why', () => {
    for (const blank of ['', '   ', '\n\t ']) {
      const t = ask({
        senderCategories: ['marketing'],
        targetCategories: ['marketing'],
        bodies: new Map([['marketing', blank]]),
      })
      expect(t.ok, `a body of ${JSON.stringify(blank)} must not be usable`).toBe(false)
      if (!t.ok) expect(t.reason).toBe('not-set')
    }
  })

  it('an explicit null row is "not written yet" too, not an empty message', () => {
    const t = ask({
      senderCategories: ['marketing'],
      targetCategories: ['marketing'],
      bodies: new Map([['marketing', null]]),
    })
    expect(t.ok).toBe(false)
  })

  /**
   * The asymmetry, pinned. The default fleet has shipped copy in the source, so "no row"
   * there means *nobody has overridden it*. A second fleet has none by construction.
   */
  it('an unwritten SECOND fleet refuses while the DEFAULT fleet with no row still sends', () => {
    expect(ask({ bodies: NO_BODIES }).ok).toBe(true)
    expect(ask({ senderCategories: ['marketing'], targetCategories: ['marketing'], bodies: NO_BODIES }).ok).toBe(false)
  })

  it('a cross-fleet route is refused rather than given somebody’s copy', () => {
    const t = ask({ senderCategories: ['marketing'], targetCategories: [], bodies: WITH_MARKETING })
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.reason).toBe('different-fleet')
  })

  it('a page in two fleets is AMBIGUOUS, and ambiguity is named rather than resolved', () => {
    const t = ask({
      senderCategories: ['bollywood', 'marketing'],
      targetCategories: ['bollywood', 'marketing'],
      bodies: WITH_MARKETING,
    })
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.reason).toBe('ambiguous')
  })

  it('every refusal explains itself in a sentence, with no identifier in it', () => {
    const refusals = [
      ask({ senderCategories: ['marketing'], targetCategories: ['marketing'] }),
      ask({ senderCategories: ['marketing'], targetCategories: [] }),
      ask({ senderCategories: ['bollywood', 'marketing'], targetCategories: ['bollywood', 'marketing'] }),
    ]
    for (const r of refusals) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.detail.length).toBeGreaterThan(20)
        expect(r.detail).not.toMatch(/[a-z]_[a-z]|\b[a-z]+[A-Z][a-z]+\b/)
      }
    }
  })
})

describe('the Setting row a fleet’s copy lives in', () => {
  it('is derived from the slug, so a third fleet costs one row and no code', () => {
    expect(fleetTemplateKey('marketing')).toBe('templateBody:marketing')
    expect(fleetTemplateKey(' Marketing ')).toBe('templateBody:marketing')
  })

  /**
   * The default fleet keeps `singleTemplateBody`. Migrating it would rewrite the one row an
   * operator has already been editing, to gain nothing — and `templateForRoute` never reads
   * `bodies` for the default slug, so a row at this key would be silently ignored.
   */
  it('never collides with the default fleet’s existing key', () => {
    expect(fleetTemplateKey(DEFAULT_CATEGORY_SLUG)).not.toBe('singleTemplateBody')
  })
})

/**
 * ── THE SOURCE GREP, because the failure mode is a CALLER nobody has written ──
 *
 * `composeForPair`'s single-template branch is the one place a body is chosen, and the
 * defect this whole file guards against is that branch reaching for the default copy when
 * the route's own fleet has none. No behavioural test can fail for a fallback somebody adds
 * later, so the shape is asserted directly — the same reason
 * `tests/one-route-rule.test.ts` and `tests/visible-channels.test.ts` are greps.
 */
describe('the composer cannot quietly fall back to the default copy', () => {
  const compose = readFileSync(join(ROOT_DIR, 'src/outreach/compose.ts'), 'utf8')

  it('takes the route’s template as an argument rather than reading the default setting', () => {
    expect(compose).toMatch(/fleetTemplate/)
  })

  it('the shipped copy is referenced only where the DEFAULT fleet’s body is resolved', () => {
    /* `SINGLE_TEMPLATE_MIDDLE` is exported from compose.ts and consumed by settings.ts, which
       is where "no override means the shipped copy" belongs. Inside the single-template
       branch it would be exactly the silent fallback this module refuses. */
    const branch = compose.slice(compose.indexOf('if (settings.singleTemplate)'), compose.indexOf('const brandFirst'))
    expect(branch.length).toBeGreaterThan(100)
    expect(branch, 'the single-template branch reaches for the shipped copy directly').not.toContain(
      'SINGLE_TEMPLATE_MIDDLE',
    )
    expect(branch, 'the single-template branch reads the default override directly').not.toContain(
      'singleTemplateBody',
    )
  })

  it('the shipped copy is still long enough to be sendable — the floor every template has', () => {
    /* Read from source rather than imported: importing compose.ts pulls in the Prisma client,
       and a pure test that opens a database connection to ask a question about a string is the
       trap `tests/pool-bounds.test.ts` was written for. */
    const rule = readFileSync(join(ROOT_DIR, 'src/outreach/fleetTemplate.ts'), 'utf8')
    const m = rule.match(/export const SINGLE_TEMPLATE_MIDDLE = `([^`]+)`/)
    expect(m, 'the shipped standard message is no longer where this test looks for it').toBeTruthy()
    expect(m![1]!.trim().length).toBeGreaterThan(40)
  })
})

/**
 * ── IS THIS STORED BODY OUR INTRODUCTION? (H5, 2026-10-09) ─────────────────
 *
 * The gate and the planner's sweep refuse/discard our introduction to a company that already
 * knows us, and they recognise the introduction BY ITS BYTES: the composer writes a first
 * touch as the fleet's copy verbatim. A SET of every standard message, so a draft written with
 * the shipped copy before an override was saved is still recognised, and so is any fleet's.
 */
describe('isStandardMessageBody', () => {
  const OVERRIDE = 'Hi,An override of the standard message, long enough to be a sendable template.'
  const MARKETING = 'Hi,The marketing fleet’s own standard message, also long enough to be sendable.'
  const none = { singleTemplateBody: null, fleetTemplateBodies: new Map<string, string>() }
  const withOverride = { singleTemplateBody: OVERRIDE, fleetTemplateBodies: new Map([[MARKETING_CATEGORY_SLUG, MARKETING]]) }

  it('the shipped copy is our introduction with no override saved', () => {
    expect(isStandardMessageBody(SINGLE_TEMPLATE_MIDDLE, none)).toBe(true)
  })

  it('the shipped copy is STILL our introduction after an override is saved — a draft written before it carries those bytes', () => {
    expect(isStandardMessageBody(SINGLE_TEMPLATE_MIDDLE, withOverride)).toBe(true)
  })

  it('the override, and another fleet’s copy, are introductions too', () => {
    expect(isStandardMessageBody(OVERRIDE, withOverride)).toBe(true)
    expect(isStandardMessageBody(MARKETING, withOverride)).toBe(true)
  })

  it('surrounding whitespace does not hide one — every writer trims', () => {
    expect(isStandardMessageBody(`\n  ${SINGLE_TEMPLATE_MIDDLE}  \n`, none)).toBe(true)
    expect(isStandardMessageBody(`  ${OVERRIDE}\n`, withOverride)).toBe(true)
  })

  it('a follow-up is never one — its body names a post, and {{post}} is required in that copy', () => {
    const followUp = renderFollowUp(
      `Hi,Following up on ${FOLLOW_UP_POST_TOKEN} — we can put that same campaign in front of 300M+ daily views.`,
      followUpPostReference({ postedAt: new Date('2026-10-08T06:00:00Z'), subject: 'Toxic' }),
    )
    expect(isStandardMessageBody(followUp, withOverride)).toBe(false)
  })

  it('null, empty and an unrelated body are not — absence is not a refusal', () => {
    expect(isStandardMessageBody(null, withOverride)).toBe(false)
    expect(isStandardMessageBody('', withOverride)).toBe(false)
    expect(isStandardMessageBody('   ', withOverride)).toBe(false)
    expect(isStandardMessageBody('a hand-edited message a person chose the words of', withOverride)).toBe(false)
  })

  it('an empty fleet body in the map never makes the empty string a standard message', () => {
    const blank = { singleTemplateBody: null, fleetTemplateBodies: new Map([[MARKETING_CATEGORY_SLUG, '   ']]) }
    expect(isStandardMessageBody('', blank)).toBe(false)
    expect(isStandardMessageBody(' ', blank)).toBe(false)
  })
})
