import { describe, it, expect } from 'vitest'
import { materialAllowance, materialAllowanceDetail } from '@/outreach/materialAllowance'

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
