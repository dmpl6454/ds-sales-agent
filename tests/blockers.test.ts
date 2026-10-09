import { describe, it, expect } from 'vitest'
import { rankBlockers, blockersSummary, type BlockerInput } from '../src/app/view-model/blockers'

/**
 * The ORDER is the feature, so it is what gets tested.
 *
 * "What is stopping it" ranks by what cannot be recovered, and that ranking is not
 * intuitive: a held draft is the loudest thing on the page (three cards, a body, a Send
 * button) and the least urgent, while watch health is one sentence and the only item that
 * is losing something permanently. A list that put drafts first would look completely
 * reasonable and would be wrong, which is exactly the kind of mistake a test has to hold.
 */

const CLEAR: BlockerInput = {
  watch: { severity: 'ok', neverRun: false, postsLost: 0, downtimeHours: 0, survivalHours: 18 },
  breaker: null,
  pausedBy: null,
  repliesWaiting: 0,
  replyHalt: { scope: 'pair', resumeHours: 168 },
  draftsWaiting: 0,
  topRefusal: null,
}

const EVERYTHING: BlockerInput = {
  watch: { severity: 'losing-posts', neverRun: false, postsLost: 62, downtimeHours: 21, survivalHours: 18 },
  breaker: { reason: 'An account was questioned by Instagram in the last 24 hours.' },
  pausedBy: null,
  repliesWaiting: 1,
  replyHalt: { scope: 'pair', resumeHours: 168 },
  draftsWaiting: 3,
  topRefusal: {
    detail: 'This account has no working Instagram session.',
    count: 3,
    remedy: { label: 'Sign this account in', href: '/senders' },
  },
}

describe('what is stopping it', () => {
  it('ranks the unrecoverable thing first, and drafts last', () => {
    const keys = rankBlockers(EVERYTHING).map((b) => b.key)
    expect(keys).toEqual(['watch', 'breaker', 'replies', 'drafts'])
  })

  it('says nothing at all when every check is clear', () => {
    expect(rankBlockers(CLEAR)).toEqual([])
  })

  /**
   * The distinction this whole page exists to preserve. An empty blocker list with the
   * switch OFF does not mean "nothing is stopping it" — it means every other condition is
   * clear while the one control that matters is off. Rendering the confident sentence over
   * a fleet that cannot send a single message is the failure mode, not a wording nit.
   */
  it('does not claim "nothing is stopping it" while autopilot is off', () => {
    const off = blockersSummary([], { kind: 'switch-off' })
    const on = blockersSummary([], { kind: 'moving', mac: 'Studio' })

    expect(off).not.toMatch(/nothing is stopping it/i)
    expect(off).toMatch(/autopilot itself is off/i)
    expect(on).toMatch(/nothing is stopping it/i)
  })

  /**
   * AND "ON" IS NOT "MOVING" (audit H8). With the switch ON and no Mac chosen, or the chosen Mac
   * asleep, the switch card directly above says nothing sends — so an empty list must not say
   * "nothing is stopping it" under it. Keyed on `motion.kind !== 'switch-off'` this fails.
   */
  it.each([
    [{ kind: 'no-mac' } as const, /no Mac is selected/],
    [{ kind: 'mac-offline', mac: 'Studio' } as const, /Studio — the sending Mac — is not online/],
    [{ kind: 'no-account-ready', mac: 'Studio' } as const, /no account is ready/],
  ])('says nothing goes out, and why, when the switch is ON but the queue cannot move (%o)', (motion, reason) => {
    const s = blockersSummary([], motion)
    expect(s).not.toMatch(/nothing is stopping it/i)
    expect(s).toMatch(/nothing goes out/i)
    expect(s).toMatch(reason)
  })

  /**
   * WHAT A REPLY PAUSES IS THE SCOPE'S (audit H9). Under `pair` — Tabish's choice since 2026-09-01
   * — only the page they answered stops, and rotation hands the turn on; the verdict said every
   * account stopped for seven days. Both scopes are driven so the switched-off one stays honest.
   */
  it('the reply item says what the halt actually covers, in both scopes, with the window from the Setting', () => {
    const pair = rankBlockers({ ...CLEAR, repliesWaiting: 2, replyHalt: { scope: 'pair', resumeHours: 168 } }).find(
      (b) => b.key === 'replies',
    )!
    expect(pair.verdict).toMatch(/only the page/)
    expect(pair.verdict).not.toMatch(/every account|every one of our pages/i)
    expect(pair.headline).not.toMatch(/are on hold$/)
    expect(pair.verdict).toMatch(/seven days/)

    const target = rankBlockers({ ...CLEAR, repliesWaiting: 2, replyHalt: { scope: 'target', resumeHours: 48 } }).find(
      (b) => b.key === 'replies',
    )!
    expect(target.verdict).toMatch(/every one of our pages/)
    expect(target.verdict).toMatch(/two days/)
    expect(target.verdict).not.toMatch(/seven days/)
  })

  it('the breaker headline is the same in both scopes — it IS fleet-wide', () => {
    const breaker = { reason: 'An account was questioned by Instagram.' }
    const a = rankBlockers({ ...CLEAR, breaker, replyHalt: { scope: 'pair', resumeHours: 168 } })[0]!
    const b = rankBlockers({ ...CLEAR, breaker, replyHalt: { scope: 'target', resumeHours: 168 } })[0]!
    expect(a.headline).toBe('Every account is halted, not just one')
    expect(b.headline).toBe(a.headline)
  })

  it('carries the gate’s refusal through verbatim, never re-worded', () => {
    const detail = 'This account shares its signature with another sending account.'
    const [drafts] = rankBlockers({ ...CLEAR, draftsWaiting: 2, topRefusal: { detail, count: 2, remedy: null } })
    expect(drafts?.verdict).toBe(detail)
  })

  /**
   * `neverRun` is the case that reads as good news if you derive tone from the numbers:
   * `postsLost` is 0 because nothing was COUNTED, not because nothing was lost. Painting
   * the most serious state in the system green is the specific bug this guards.
   */
  it('treats "never run" as the worst state, not a healthy one', () => {
    const [first] = rankBlockers({
      ...CLEAR,
      watch: { severity: 'losing-posts', neverRun: true, postsLost: 0, downtimeHours: 0, survivalHours: 18 },
    })
    expect(first?.key).toBe('watch')
    expect(first?.tone).toBe('bad')
    expect(first?.verdict).toMatch(/no estimate/i)
    // It must NOT print a reassuring zero.
    expect(first?.headline).not.toMatch(/\b0 posts\b/)
  })

  /** At-risk is recoverable and must not be dressed as loss — the difference is the point. */
  it('separates at-risk from losing-posts', () => {
    const [atRisk] = rankBlockers({
      ...CLEAR,
      watch: { severity: 'at-risk', neverRun: false, postsLost: 0, downtimeHours: 4, survivalHours: 18 },
    })
    expect(atRisk?.tone).toBe('warn')
    expect(atRisk?.verdict).toMatch(/gets it all back/i)
  })

  /** Every blocker's copy has to say this, because the alarm is not about sending. */
  it('says watch health is not about sending', () => {
    for (const severity of ['losing-posts', 'at-risk'] as const) {
      const [b] = rankBlockers({
        ...CLEAR,
        watch: { severity, neverRun: false, postsLost: 5, downtimeHours: 20, survivalHours: 18 },
      })
      expect(b?.key).toBe('watch')
    }
    const [never] = rankBlockers({
      ...CLEAR,
      watch: { severity: 'losing-posts', neverRun: true, postsLost: 0, downtimeHours: 0, survivalHours: 18 },
    })
    expect(never?.verdict).toMatch(/not about sending/i)
  })

  /**
   * The breaker halts EVERY account. Listing three held drafts above the reason all three
   * are going nowhere would be a correctly-populated list that answers the wrong question.
   */
  it('puts a fleet-wide halt above anything that only affects one draft', () => {
    const keys = rankBlockers({
      ...CLEAR,
      breaker: { reason: 'A rising rate of sends that never appeared.' },
      draftsWaiting: 5,
      topRefusal: { detail: 'Held.', count: 5, remedy: null },
    }).map((b) => b.key)
    expect(keys.indexOf('breaker')).toBeLessThan(keys.indexOf('drafts'))
  })

  it('names who paused sending, and says so when no reason was recorded', () => {
    const [b] = rankBlockers({ ...CLEAR, pausedBy: { at: '12 Aug 14:02', by: 'tabish@dashmani.com' } })
    expect(b?.key).toBe('paused')
    expect(b?.headline).toContain('tabish@dashmani.com')
    expect(b?.verdict).toMatch(/no reason was recorded/i)
  })

  /** A remedy with no destination is a real answer, and must not become a dead link. */
  it('drops a remedy that has nowhere to point', () => {
    const [drafts] = rankBlockers({
      ...CLEAR,
      draftsWaiting: 1,
      topRefusal: { detail: 'Held.', count: 1, remedy: { label: 'Nowhere', href: null } as never },
    })
    expect(drafts?.remedy).toBeNull()
  })
})
