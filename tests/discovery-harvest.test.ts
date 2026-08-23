import { describe, expect, it } from 'vitest'

import { harvestBrandNames, type HarvestPost } from '../src/detection/officialDiscovery'

/**
 * A PAID POST'S BRAND NAMES SURVIVE THE POST ALSO TAGGING SOMEBODY.
 *
 * Tabish, 2026-08-23, from the /paid-posts column: *"paid post detection is missing targets
 * from clear paid posts ... the column only shows fukra insaan and vibe as the targets ...
 * traitors is also a target, its a prime tv show among other things, and the other one
 * kitkat possibly."*
 *
 * He was right, and the cause was a filter: discovery only read the `brands` column of
 * posts that asserted NO handle at all. MEASURED that morning — 385 of 638 in-window
 * CAMPAIGN posts carrying brand names asserted at least one handle and were skipped whole.
 *
 * The first fixture is his actual @naughtyworld post.
 */
const post = (over: Partial<HarvestPost>): HarvestPost => ({
  id: 'c1',
  shortcode: 'DcVg8pch_WC',
  caption: 'Fukra insaan #TheTraitorsOnPrime',
  taggedAccounts: '[]',
  rawPayload: null,
  brands: '[]',
  frameText: null,
  target: { handle: 'naughtyworld' },
  ...over,
})

describe('harvestBrandNames', () => {
  it("keeps the brand names of a post that ALSO tags an account (Tabish's example)", () => {
    const h = harvestBrandNames(
      [post({ taggedAccounts: '["fukra_insaan"]', brands: '["Prime Video","The Traitors"]' })],
      new Set<string>(),
    )

    // The regression: before the fix this post contributed nothing at all.
    expect([...h.names.keys()].sort()).toEqual(['prime video', 'the traitors'])
    // It asserts a handle, so it is NOT anonymous — but it is still worked.
    expect(h.anonymousPosts).toBe(0)
    expect(h.postsWithNames).toBe(1)
  })

  it('ranks a name asserted on many paid posts above one asserted once', () => {
    const h = harvestBrandNames(
      [
        post({ id: 'a', shortcode: 's1', brands: '["Prime Video"]' }),
        post({ id: 'b', shortcode: 's2', brands: '["Prime Video"]' }),
        post({ id: 'c', shortcode: 's3', brands: '["Some One Off"]' }),
      ],
      new Set<string>(),
    )

    expect(h.names.get('prime video')?.posts).toBe(2)
    expect(h.names.get('some one off')?.posts).toBe(1)
  })

  it("never spends the budget on the publisher's own name or series code", () => {
    // `fg9` is @filmygyan's own internal series code and `rvcjinsta` is the publisher
    // itself — both were being offered a scarce lookup. `ownMarks` stopped them reaching a
    // VERDICT long ago; it had never reached discovery.
    const h = harvestBrandNames(
      [
        post({ target: { handle: 'filmygyan' }, brands: '["fg9","Zee5"]' }),
        post({ id: 'r', shortcode: 's9', target: { handle: 'rvcjinsta' }, brands: '["rvcjinsta"]' }),
      ],
      new Set<string>(),
    )

    expect(h.names.has('fg9')).toBe(false)
    expect(h.names.has('rvcjinsta')).toBe(false)
    // The control: a real advertiser on the same post must survive, or the rule is a
    // recall regression wearing a tidy-up's clothes.
    expect(h.names.has('zee5')).toBe(true)
  })

  it('still counts a post that asserts nobody as anonymous, and still reads its names', () => {
    const h = harvestBrandNames([post({ brands: '["KitKat","Vibe"]' })], new Set<string>())
    expect(h.anonymousPosts).toBe(1)
    expect(h.names.has('kitkat')).toBe(true)
  })
})
