import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { removalVerdict, removeTargetConfirm, removeTargetResult } from '@/app/remove-target-message'

/**
 * WHAT REMOVE DOES TO A TARGET — the pure rule both the card and `removeTarget` ask
 * (2026-10-09). Remove on a watched channel used to delete its whole stored corpus through a
 * cascade, because the rule read DELIVERED messages and a watched page is never messaged; the
 * card said "deleted outright" from its own copy of that rule. The live half is
 * `tests/remove-target-live.test.ts`.
 */

describe('removalVerdict', () => {
  it('deletes only an EMPTY watched page — the undo of a wrong add', () => {
    expect(removalVerdict({ role: 'WATCH', campaigns: 0, attempts: 0 })).toBe('delete')
  })

  it('retires a watched page that holds anything', () => {
    expect(removalVerdict({ role: 'WATCH', campaigns: 1, attempts: 0 })).toBe('retire')
    expect(removalVerdict({ role: 'WATCH', campaigns: 0, attempts: 1 })).toBe('retire')
    expect(removalVerdict({ role: 'WATCH', campaigns: 1005, attempts: 0 })).toBe('retire')
  })

  /** Strict equality: anything that is not a clean zero keeps the data. */
  it('reads a malformed count as "something is there"', () => {
    expect(removalVerdict({ role: 'WATCH', campaigns: Number.NaN, attempts: 0 })).toBe('retire')
    expect(removalVerdict({ role: 'WATCH', campaigns: undefined as unknown as number, attempts: 0 })).toBe('retire')
    expect(removalVerdict({ role: 'WATCH', campaigns: -1, attempts: 1 })).toBe('retire')
  })

  /**
   * A deleted prospect is not a stopped one: the badge door, official discovery and an import
   * mint a handle with no row, with live routes. So a prospect is retired even when empty.
   */
  it('ALWAYS retires a prospect, or any role it does not recognise, even at zero', () => {
    expect(removalVerdict({ role: 'PROSPECT', campaigns: 0, attempts: 0 })).toBe('retire')
    expect(removalVerdict({ role: '', campaigns: 0, attempts: 0 })).toBe('retire')
    expect(removalVerdict({ role: 'watch', campaigns: 0, attempts: 0 })).toBe('retire')
  })
})

describe('the sentences', () => {
  it('a watched page with posts is told its posts are KEPT — never "deleted outright"', () => {
    const c = removeTargetConfirm({ handle: 'viralbhayani', postsLogged: 1005, attemptsLogged: 0, removal: 'retire' })
    expect(c.text).toContain('1005 stored posts')
    expect(c.text).toContain('kept')
    expect(c.text).not.toContain('deleted outright')
    expect(c.button).toBe('Yes, stop reading')
  })

  /**
   * HONEST ABOUT WHAT RETIRING DOES NOT DO. The stored posts keep counting toward who is
   * messaged until they age out; whether a removed page's posts should stop counting is
   * Tabish's call, and until he makes it the screen must not claim they stop.
   */
  it('says posts already found still count, and that nothing new is read', () => {
    const c = removeTargetConfirm({ handle: 'x', postsLogged: 3, attemptsLogged: 0, removal: 'retire' })
    expect(c.text).toContain('still count toward who we message')
    expect(c.text).toContain('nothing new is read')
    expect(c.text).not.toMatch(/no longer count/i)
    const r = removeTargetResult({ handle: 'x', outcome: 'watch-retired', posts: 3, attempts: 0, delivered: 0 })
    expect(r).toContain('still count toward who we message')
    expect(r).not.toMatch(/no longer count/i)
  })

  it('an empty watched page is deleted outright, and says so', () => {
    const c = removeTargetConfirm({ handle: 'afaqs', postsLogged: 0, attemptsLogged: 0, removal: 'delete' })
    expect(c.text).toContain('deleted outright')
    expect(c.button).toBe('Yes, delete')
  })

  it('a page retired for attempts alone does not claim "0 stored posts are kept"', () => {
    const c = removeTargetConfirm({ handle: 'x', postsLogged: 0, attemptsLogged: 2, removal: 'retire' })
    expect(c.text).not.toContain('0 stored posts')
    expect(c.text).toContain('retired rather than deleted')
    const r = removeTargetResult({ handle: 'x', outcome: 'watch-retired', posts: 0, attempts: 0, delivered: 0 })
    expect(r).not.toContain('0 stored posts')
    expect(r).toContain('retired rather than deleted')
  })

  it('a retired prospect is pointed at the badge re-read, never told it was deleted', () => {
    const r = removeTargetResult({ handle: 'crocsindia', outcome: 'retired', posts: 0, attempts: 2, delivered: 1 })
    expect(r).toContain('never be messaged')
    expect(r).toContain('2 recorded messages (1 delivered)')
    expect(r).toContain('ig:unretire-target')
    expect(r).not.toMatch(/deleted|removed it/)
  })
})

/**
 * THE CARD ASKS THE SAME RULE — source greps, because the failure was a SECOND COPY of the rule
 * in the client (`everContacted`, deliveries only) and the failure mode is that copy coming back.
 */
describe('one rule, two callers', () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'))

  it('the channel card computes its removal with removalVerdict, from one widened attempt query', () => {
    const vm = read('src/app/view-model.ts')
    const start = vm.indexOf('async function buildChannelCards(')
    expect(start).toBeGreaterThan(-1)
    const body = vm.slice(start, vm.indexOf('\n}\n', start))
    expect(body).toContain('removalVerdict(')
    expect(body).not.toContain('everContacted')
    /* Zero extra queries: the replied-only groupBy was widened, not joined by a sixth read. */
    expect(body.match(/prisma\.\w+\.\w+\(/g)?.length, 'buildChannelCards must stay at five queries').toBe(5)
    expect(body).toMatch(/_max:\s*\{\s*repliedAt:\s*true\s*\}/)
  })

  it('the card renders the shared confirmation, and the server words its result from the shared module', () => {
    const card = read('src/app/channels.tsx')
    expect(card).toContain('removeTargetConfirm(')
    expect(card).not.toContain('everContacted')
    expect(card).not.toContain('deleted outright')
    const actions = read('src/app/actions.ts')
    const start = actions.indexOf('export async function removeTarget(')
    const body = actions.slice(start, actions.indexOf('\n}\n', start))
    expect(body).toContain('removalVerdict(')
    expect(body).toContain('removeTargetResult(')
  })
})
