import { describe, it, expect } from 'vitest'
import { exactHandleMatcher } from '@/outreach/browser/messageEntry'

/**
 * The one correctness property inside `openThreadViaInbox` (blocker 4, the inbox-compose
 * fallback): the To:-search result it clicks must be the EXACT account, because that click
 * is the only step in the whole send path that can reach a WRONG PERSON from a fuzzy match.
 *
 * "Existence is not identity" is a measured rule in this repo — a guessed handle was the
 * right company only 6 times in 10. Here the risk is worse than a guess: Instagram's search
 * offers @crocsindia when you type @crocs, so a substring match would DM a different company
 * from a revenue account. This matcher is what refuses that.
 */
describe('exactHandleMatcher — the wrong-account guard for blocker 4', () => {
  /**
   * CASE-SENSITIVE SINCE 2026-10-09 (audit C1). This test used to pin
   * `exactHandleMatcher('idfreshfood').test('IDFreshFood') === true` as correct — and that is
   * the defect: a search result's DISPLAY NAME satisfied the matcher, and @tips and @tips_india
   * both display "TIPS". Usernames are lower case and render lower case on the result's
   * username line, so the handle is lower-cased once and matched without the `i` flag.
   */
  it('matches the handle itself — the lower-case username line', () => {
    expect(exactHandleMatcher('idfreshfood').test('idfreshfood')).toBe(true)
  })

  it('REFUSES a display name in capitals — the @tips / @tips_india "TIPS" case', () => {
    expect(exactHandleMatcher('tips').test('tips')).toBe(true)
    expect(exactHandleMatcher('tips').test('TIPS')).toBe(false)
    expect(exactHandleMatcher('tips').test('Tips')).toBe(false)
    expect(exactHandleMatcher('idfreshfood').test('IDFreshFood')).toBe(false)
  })

  it('a stored handle with capitals still matches the lower-case username line', () => {
    expect(exactHandleMatcher('IDFreshFood').test('idfreshfood')).toBe(true)
    expect(exactHandleMatcher('IDFreshFood').test('IDFreshFood')).toBe(false)
  })

  it('REFUSES a longer handle that merely contains it — the @crocs / @crocsindia case', () => {
    expect(exactHandleMatcher('crocs').test('crocsindia')).toBe(false)
    expect(exactHandleMatcher('crocs').test('crocs_official')).toBe(false)
  })

  it('REFUSES a shorter handle it is contained in', () => {
    expect(exactHandleMatcher('crocsindia').test('crocs')).toBe(false)
  })

  it('treats a dot as a literal, not a wildcard — @audionirvana.in is legal', () => {
    const m = exactHandleMatcher('audionirvana.in')
    expect(m.test('audionirvana.in')).toBe(true)
    // The dot must NOT match any character: this is the injection direction.
    expect(m.test('audionirvanaXin')).toBe(false)
    expect(m.test('audionirvana_in')).toBe(false)
  })

  it('anchors both ends — no leading or trailing text sneaks a different account past', () => {
    const m = exactHandleMatcher('idfreshfood')
    expect(m.test('xidfreshfood')).toBe(false)
    expect(m.test('idfreshfoodx')).toBe(false)
    expect(m.test('the idfreshfood account')).toBe(false)
  })

  it('neutralises regex metacharacters a handle could never legitimately contain', () => {
    // A handle can only be [a-z0-9._], but the escape must hold even if a bad value arrives,
    // because the alternative is a crafted string compiling into a matcher that matches too
    // much. `.*` must be literal text, not "anything".
    const m = exactHandleMatcher('a.*b')
    expect(m.test('a.*b')).toBe(true)
    expect(m.test('axxxb')).toBe(false)
  })
})
