import { describe, it, expect } from 'vitest'
import { usableBrandName } from '@/outreach/usableName'
import { brandFirstTouch } from '@/outreach/brandPitch'
import { buildGreeting } from '@/outreach/render'

/**
 * `usableBrandName` — may this stored display name be put in front of a prospect?
 *
 * ── DRIVEN WITH THE REAL DATA, NOT INVENTED FIXTURES ──────────────────────
 *
 * Both tables below are transcribed from the live 68 BRAND rows on 2026-08-13. That matters
 * more than usual here, because the obvious implementation of this rule — normalise both
 * sides and compare — matches 47 of those 68, and most of the 47 are perfectly good names.
 * A test written against invented fixtures would have passed for that implementation and
 * degraded 26 real pitches for no reason.
 *
 * So the second table is the one carrying the weight: names that MUST survive.
 */

/** Live rows where the stored display name really is the handle. These must be refused. */
const HANDLE_SHAPED: [handle: string, displayName: string][] = [
  ['agoracitycentre', 'agoracitycentre'],
  ['ahambysenco', 'ahambysenco'],
  ['netflix_in', 'netflix_in'],
  ['jiohotstar', 'jiohotstar'],
  ['dharmaticent', 'dharmaticent'],
  ['theleela', 'theleela'],
  ['sonymax', 'sonymax'],
  ['lego.mybrickhouse', 'lego.mybrickhouse'],
  ['tseries.official', 'tseries.official'],
  ['godrejindustriesgroup', 'godrejindustriesgroup'],
  ['danubeproperties', 'danubeproperties'],
  ['vivo_india', 'vivo_india'],
]

/**
 * Live rows that normalise to their handle and are NEVER the less good for it.
 *
 * Every one of these would be thrown away by a normalise-and-compare rule.
 */
const REAL_NAMES: [handle: string, displayName: string][] = [
  ['amazonmgmstudios', 'Amazon MGM Studios'],
  ['crocsindia', 'Crocs India'],
  ['kalkifashion', 'KALKI Fashion'],
  ['royalcanin.india', 'Royal Canin India'],
  ['banijayasia', 'Banijay Asia'],
  ['luxindia', 'LUX India'],
  ['idfreshfood', 'iD Fresh Food'],
  ['universalmusicgroup', 'Universal Music Group'],
  ['safadryfruitsandspices', 'Safa Dry Fruits and Spices'],
  ['milano_icecream_bangalore', 'Milano Ice Cream, Bangalore'],
  ['shalini.passi', 'Shalini Passi'],
  ['tips', 'TIPS'],
]

describe('usableBrandName', () => {
  it.each(HANDLE_SHAPED)('refuses @%s whose display name is just the handle', (handle, displayName) => {
    expect(usableBrandName(displayName, handle)).toBeNull()
  })

  it.each(REAL_NAMES)('keeps @%s → "%s", which a normalise-and-compare rule would destroy', (handle, displayName) => {
    expect(usableBrandName(displayName, handle)).toBe(displayName)
  })

  it('refuses an empty or whitespace-only name', () => {
    expect(usableBrandName('', 'crocsindia')).toBeNull()
    expect(usableBrandName('   ', 'crocsindia')).toBeNull()
    expect(usableBrandName(null, 'crocsindia')).toBeNull()
    expect(usableBrandName(undefined, 'crocsindia')).toBeNull()
  })

  it('refuses a name byte-identical to the handle even if the handle had capitals', () => {
    expect(usableBrandName('CrocsIndia', 'CrocsIndia')).toBeNull()
  })

  it('keeps a genuinely different lower-case name', () => {
    // Not the handle at all — no reason to refuse it just because it is lower case.
    expect(usableBrandName('crocs', 'crocsindia')).toBe('crocs')
  })
})

describe('the guard holds AT THE BOUNDARY, not at the call site', () => {
  const base = {
    publisherName: 'Viral Bhayani',
    postedAt: new Date('2026-08-04T12:00:00Z'),
    now: new Date('2026-08-13T12:00:00Z'),
  }

  it('a handle passed in as the brand name never reaches the body', () => {
    /**
     * The whole point of asking inside `brandFirstTouch`: a future second caller cannot
     * reintroduce the defect by forgetting to filter. This passes the exact value the live
     * `compose.ts` was passing on 2026-08-13.
     */
    const body = brandFirstTouch({ ...base, brandName: 'agoracitycentre', handle: 'agoracitycentre' })
    expect(body).not.toContain('agoracitycentre')
  })

  it('degrades to the opening that names no placement, rather than a half-sentence', () => {
    const body = brandFirstTouch({ ...base, brandName: 'agoracitycentre', handle: 'agoracitycentre' })
    expect(body).not.toContain('I saw')
    expect(body).not.toContain('placement with')
    // and does not claim we watched them reach an audience
    expect(body).not.toContain('you just reached')
    // still a complete, sendable message
    expect(body).toContain('Digital Sukoon')
    expect(body).toContain('Could I send a short plan')
    expect(body.length).toBeGreaterThan(200)
  })

  it('leaves no placeholder, dangling apostrophe or double space behind', () => {
    const body = brandFirstTouch({ ...base, brandName: 'ahambysenco', handle: 'ahambysenco' })
    expect(body).not.toMatch(/\bundefined\b|\bnull\b|NaN|\{\{/)
    expect(body).not.toMatch(/ {2}/)
    expect(body).not.toMatch(/\n{3,}/)
    expect(body).not.toMatch(/\s's\b/)
  })

  it('a real name still gets the specific claim — the fix must not flatten every pitch', () => {
    const body = brandFirstTouch({ ...base, brandName: 'Crocs India', handle: 'crocsindia' })
    expect(body).toContain("I saw Crocs India's placement with Viral Bhayani")
    expect(body).toContain('you just reached')
  })
})

describe('the greeting', () => {
  const target = (handle: string, displayName: string) => ({
    handle,
    displayName,
    contactFirstName: null,
    kind: 'BRAND',
  })

  it('never greets a handle — MEASURED live as "Hi agoracitycentre team,"', () => {
    expect(buildGreeting(target('agoracitycentre', 'agoracitycentre'))).toBe('Hi there,')
    expect(buildGreeting(target('ahambysenco', 'ahambysenco'))).toBe('Hi there,')
  })

  it('still greets a real company by name', () => {
    expect(buildGreeting(target('crocsindia', 'Crocs India'))).toBe('Hi Crocs India team,')
  })

  it('still trims a display name that carries a location', () => {
    // The `greetableName` behaviour must survive: "Hi Milano Ice Cream, Bangalore team," was
    // its own defect, found by reading a rendered message.
    expect(buildGreeting(target('milano_icecream_bangalore', 'Milano Ice Cream, Bangalore'))).toBe(
      'Hi Milano Ice Cream team,',
    )
  })

  it('an explicit contact first name always wins', () => {
    expect(
      buildGreeting({ handle: 'agoracitycentre', displayName: 'agoracitycentre', contactFirstName: 'Priya', kind: 'BRAND' }),
    ).toBe('Hi Priya,')
  })
})
