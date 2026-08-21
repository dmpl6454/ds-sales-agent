import { describe, it, expect } from 'vitest'
import { materialAllowance, materialAllowanceDetail, brandStringsNameProspect, campaignsNamingHandle, mentionsHandleExactly } from '@/outreach/materialAllowance'

/**
 * ONE MESSAGE PER DETECTED PAID POST — Tabish, 2026-08-21.
 *
 * *"If only a single paid post is detected for say a paid post done by sony … then we send a
 * message to the brand only once unless we detect another paid post made that same day or by
 * another channel."*
 *
 * MEASURED before this existed: **133 recipients had heard from more than one of our pages**,
 * many from all five. @indiagatefoods received five messages from five pages inside twelve
 * hours off ONE paid post — the ring rule working exactly as specified on 2026-08-19, which is
 * what he is now replacing.
 *
 * The mechanism was a SCOPE, not a missing rule: `NO_NEW_MATERIAL` already said this, but
 * `unusedCampaignCount` is per PAIR (so one post reads as unused for all five senders) and the
 * check only runs when `touchesSoFar > 0` (so each sender's own first touch is exempt).
 */
describe('materialAllowance', () => {
  it('one paid post buys exactly one message', () => {
    expect(materialAllowance({ campaignsInWindow: 1, deliveredInWindow: 0 }).held).toBe(false)
    const second = materialAllowance({ campaignsInWindow: 1, deliveredInWindow: 1 })
    expect(second.held).toBe(true)
  })

  /** The @indiagatefoods case, exactly: one post, five pages. Only the first may write. */
  it('refuses the second through fifth page on a single paid post', () => {
    for (const delivered of [1, 2, 3, 4]) {
      expect(materialAllowance({ campaignsInWindow: 1, deliveredInWindow: delivered }).held, `after ${delivered}`).toBe(true)
    }
  })

  /** "unless we detect another paid post made that same day or by another channel." */
  it('each additional paid post earns exactly one more message', () => {
    expect(materialAllowance({ campaignsInWindow: 3, deliveredInWindow: 2 }).held).toBe(false)
    expect(materialAllowance({ campaignsInWindow: 3, deliveredInWindow: 3 }).held).toBe(true)
  })

  /**
   * THE EDGE THAT WOULD HAVE BEEN AN OUTAGE. A prospect can arrive with no campaign at all —
   * a hand import, or `discoverOfficialPages` resolving a post that named nobody. Without the
   * `max(1, …)` floor they would be unreachable forever: absence of data hardening into a
   * permanent refusal, presenting as "the queue never drains".
   */
  it('a prospect with no detected paid post is still reachable ONCE', () => {
    expect(materialAllowance({ campaignsInWindow: 0, deliveredInWindow: 0 }).held).toBe(false)
    expect(materialAllowance({ campaignsInWindow: 0, deliveredInWindow: 1 }).held).toBe(true)
  })

  it('reports the numbers it decided on, so a screen never re-derives them', () => {
    const v = materialAllowance({ campaignsInWindow: 2, deliveredInWindow: 2 })
    expect(v).toEqual({ held: true, allowance: 2, delivered: 2, campaigns: 2 })
  })
})

describe('materialAllowanceDetail', () => {
  it('says nothing when nothing is held', () => {
    expect(materialAllowanceDetail(materialAllowance({ campaignsInWindow: 1, deliveredInWindow: 0 }))).toBeNull()
  })

  /** The sentence has to name what it is waiting FOR, or it reads as a fault. */
  it('names the paid post it is waiting for, in both the singular and the plural', () => {
    const one = materialAllowanceDetail(materialAllowance({ campaignsInWindow: 1, deliveredInWindow: 1 }))!
    expect(one).toContain('one paid post')
    expect(one).toContain('waits for the next paid post')

    const many = materialAllowanceDetail(materialAllowance({ campaignsInWindow: 3, deliveredInWindow: 3 }))!
    expect(many).toContain('3 paid posts')
  })

  /** And the no-campaign case must not claim a post exists. */
  it('does not invent a paid post for a hand-added prospect', () => {
    const none = materialAllowanceDetail(materialAllowance({ campaignsInWindow: 0, deliveredInWindow: 1 }))!
    expect(none).toContain('no paid post of theirs has been detected')
  })
})

/**
 * ── THE BRAND-STRING ARM (2026-08-21) ───────────────────────────────────────
 *
 * MEASURED the night it shipped: 45 in-window paid posts named an existing VERIFIED
 * prospect in their `brands` strings without tagging them ("Amazon MGM Studios",
 * "JioHotstar") and unlocked nothing. The arm credits ONLY an existing prospect, ONLY on
 * exact squashed-name equality — the original reason strings were excluded (junk like
 * `fg6` stored as a brand name) cannot pass an exact match against a verified prospect's
 * name, so minting stays string-free while crediting stops being blind.
 */
describe('brandStringsNameProspect', () => {
  const amazon = { handle: 'amazonmgmstudios', displayName: 'Amazon MGM Studios' }

  it('an exact display-name match credits — the measured case', () => {
    expect(brandStringsNameProspect('["Amazon MGM Studios"]', amazon)).toBe(true)
  })

  it('case and separators do not defeat it', () => {
    expect(brandStringsNameProspect('["amazon mgm studios"]', amazon)).toBe(true)
    expect(brandStringsNameProspect('["Zee5"]', { handle: 'zee5', displayName: 'ZEE5' })).toBe(true)
  })

  it('a squashed-handle match credits when the display name is just the handle', () => {
    expect(brandStringsNameProspect('["India Gate Foods"]', { handle: 'indiagatefoods', displayName: 'indiagatefoods' })).toBe(true)
  })

  it('a DIFFERENT company sharing words does not credit — exact equality only', () => {
    expect(brandStringsNameProspect('["Amazon"]', amazon)).toBe(false)
    expect(brandStringsNameProspect('["Amazon MGM Studios India"]', amazon)).toBe(false)
  })

  it('junk codes can never credit anybody — the fg6 class', () => {
    expect(brandStringsNameProspect('["fg6","bs2"]', amazon)).toBe(false)
  })

  it('names shorter than four squashed characters never match — too little identity', () => {
    expect(brandStringsNameProspect('["Vibe"]', { handle: 'io', displayName: 'io' })).toBe(false)
  })

  it('unreadable JSON decides nothing', () => {
    expect(brandStringsNameProspect('not json', amazon)).toBe(false)
  })
})

describe('campaignsNamingHandle counts the brand-string arm', () => {
  const rows = [
    { caption: 'no mention here', taggedAccounts: '[]', brands: '["Amazon MGM Studios"]' },
    { caption: 'with @amazonmgmstudios tagged', taggedAccounts: '[]', brands: '[]' },
    { caption: 'unrelated', taggedAccounts: '[]', brands: '["JioHotstar"]' },
  ]
  const stub = { detectedCampaign: { findMany: async () => rows } }

  it('a string-named post and a mentioned post both count; an unrelated one does not', async () => {
    const n = await campaignsNamingHandle(stub as never, { handle: 'amazonmgmstudios', displayName: 'Amazon MGM Studios' }, new Date(0))
    expect(n).toBe(2)
  })

  it('a null displayName still credits the string row — the squashed HANDLE is a name too', async () => {
    /* "Amazon MGM Studios" squashes to exactly the handle, so even a prospect whose stored
       displayName is missing links to a post that names it. Both rows count. */
    const n = await campaignsNamingHandle(stub as never, { handle: 'amazonmgmstudios', displayName: null }, new Date(0))
    expect(n).toBe(2)
  })

  it('a null displayName with a NON-matching handle counts mentions alone', async () => {
    const n = await campaignsNamingHandle(stub as never, { handle: 'amazonmgm', displayName: null }, new Date(0))
    expect(n).toBe(0) // no mention of @amazonmgm, and "Amazon MGM Studios" ≠ "amazonmgm"
  })

  it('mentionsHandleExactly is unchanged by the new arm — zee5 never credits zee5_marathi', () => {
    expect(mentionsHandleExactly({ caption: 'watch @zee5_marathi now', taggedAccounts: '[]' }, 'zee5')).toBe(false)
  })
})
