import { describe, expect, it } from 'vitest'

import { brandStringsNameProspect } from '../src/outreach/materialAllowance'

/**
 * AN OFFICIAL PAGE IS THE BRAND'S NAME PLUS A REGION, AND EXACT EQUALITY MISSED THAT.
 *
 * `@primevideoin` was already a verified PROSPECT when a @naughtyworld paid post named
 * "Prime Video" in its caption. Squashed that is `primevideo` against a handle of
 * `primevideoin`, exact equality said no, and the post unlocked nothing — so the column
 * Tabish was reading stayed silent about a lead we already owned.
 *
 * The widening is a CLOSED ALLOWLIST of suffixes, applied ASYMMETRICALLY, and both halves
 * of that carry weight. The measurement that forced the asymmetry is in the third block.
 */
const prospect = (handle: string, displayName: string | null = null) => ({ handle, displayName })

describe('brandStringsNameProspect', () => {
  it('credits an official regional page for its own brand name', () => {
    expect(brandStringsNameProspect('["Prime Video"]', prospect('primevideoin'))).toBe(true)
    expect(brandStringsNameProspect('["KFC"]', prospect('kfcindia'))).toBe(false) // stem too short
    expect(brandStringsNameProspect('["Nutella"]', prospect('nutellaindia'))).toBe(true)
    expect(brandStringsNameProspect('["Netflix"]', prospect('netflix_in'))).toBe(true)
    expect(brandStringsNameProspect('["T-Series"]', prospect('tseries.official'))).toBe(true)
  })

  it('still credits on exact equality, which is all it ever did before', () => {
    expect(brandStringsNameProspect('["VIBE"]', prospect('vibe', 'VIBE'))).toBe(true)
    expect(brandStringsNameProspect('["Amazon MGM Studios India"]', prospect('x', 'Amazon MGM Studios India'))).toBe(true)
  })

  /**
   * THE FALSE POSITIVE THAT MEASURING BOTH WAYS CAUGHT, BEFORE IT SHIPPED.
   *
   * The first version stripped `in` from the BRAND side too — and `in` there is the English
   * PREPOSITION. "Vanshika Dhir in" squashed to `vanshikadhirin`, stemmed to `vanshikadhir`,
   * and credited the actress @vanshika.dhir for 20 posts that merely used her name in a
   * sentence. @aanandlrai gained 20 the same way and @yamigautam 17 — every one a person,
   * every one wrong, inside a run whose headline (+170 credits) looked like a success.
   */
  it('never strips the English preposition "in" from a caption brand string', () => {
    expect(brandStringsNameProspect('["Vanshika Dhir in"]', prospect('vanshika.dhir', 'Vanshika Dhir'))).toBe(false)
    expect(brandStringsNameProspect('["Aanand L Rai in"]', prospect('aanandlrai', 'Aanand L Rai'))).toBe(false)
  })

  /**
   * THE @philips TRAP, which is a permanent fixture in this codebase and must keep failing
   * in this direction: the GLOBAL page must never be credited for the INDIA campaign.
   */
  it('refuses the global page for a regional brand name, and allows the reverse', () => {
    expect(brandStringsNameProspect('["Philips India"]', prospect('philips', 'Philips'))).toBe(false)
    // The reverse IS correct — Philips India is the account that ran the campaign.
    expect(brandStringsNameProspect('["Philips"]', prospect('philipsindia', 'Philips India'))).toBe(true)
  })

  it('cannot be matched by a publisher series code or a too-short stem', () => {
    expect(brandStringsNameProspect('["fg6"]', prospect('filmygyan', 'Filmygyan'))).toBe(false)
    // "berlin" minus "in" is "berl" — the stem floor exists so that can never match a
    // four-letter brand string.
    expect(brandStringsNameProspect('["berl"]', prospect('berlin', 'Berlin'))).toBe(false)
  })
})
