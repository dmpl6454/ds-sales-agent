import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memoView, invalidateViews, viewKey, MAX_INFLIGHT_VIEWS } from '@/lib/viewMemo'

/**
 * THE PILE-UP FIX, DRIVEN (2026-09-04). Two OOM kills of the web process against a per-render
 * peak of +22..32 MB meant the memory was CONCURRENT renders, not any one of them. So the two
 * properties below are the whole point and each is tested in the direction that would fail
 * if the mechanism were quietly removed: single-flight (N callers, ONE computation) and
 * admission (never more than MAX_INFLIGHT_VIEWS distinct computations alive). Every case
 * passes `enabled: true` because the suite itself runs under VITEST, where the memo is off
 * by design.
 */
const on = { enabled: true } as const
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('memoView — single-flight', () => {
  it('twenty concurrent callers share ONE computation and the SAME object', async () => {
    invalidateViews()
    let runs = 0
    const fn = async () => {
      runs += 1
      await sleep(20)
      return { at: new Date(), runs }
    }
    const results = await Promise.all(Array.from({ length: 20 }, () => memoView('k:single', fn, on)))
    expect(runs).toBe(1)
    for (const r of results) expect(r).toBe(results[0])
    /* Dates survive: the object is served by reference, never through JSON. */
    expect(results[0]!.at).toBeInstanceOf(Date)
  })

  it('a settled answer is served inside the ttl and recomputed after it', async () => {
    invalidateViews()
    let runs = 0
    const fn = async () => ++runs
    await memoView('k:ttl', fn, { ...on, ttlMs: 40 })
    await memoView('k:ttl', fn, { ...on, ttlMs: 40 })
    expect(runs).toBe(1)
    await sleep(60)
    await memoView('k:ttl', fn, { ...on, ttlMs: 40 })
    expect(runs).toBe(2)
  })

  it('a REJECTED computation is not cached — the next call recomputes', async () => {
    invalidateViews()
    let runs = 0
    const fn = async () => {
      runs += 1
      if (runs === 1) throw new Error('first time fails')
      return 'ok'
    }
    await expect(memoView('k:reject', fn, on)).rejects.toThrow('first time fails')
    await expect(memoView('k:reject', fn, on)).resolves.toBe('ok')
    expect(runs).toBe(2)
  })

  it('invalidateViews() forces a recompute before the ttl', async () => {
    invalidateViews()
    let runs = 0
    const fn = async () => ++runs
    await memoView('k:inv', fn, on)
    invalidateViews()
    await memoView('k:inv', fn, on)
    expect(runs).toBe(2)
  })

  it('is OFF under VITEST by default — every call computes', async () => {
    let runs = 0
    const fn = async () => ++runs
    await memoView('k:off', fn)
    await memoView('k:off', fn)
    expect(runs).toBe(2)
  })

  it('viewKey is stable across key order and serialises a Date to its instant', () => {
    expect(viewKey('x', { a: 1, b: 'two' })).toBe(viewKey('x', { b: 'two', a: 1 }))
    expect(viewKey('x', { a: 1 })).not.toBe(viewKey('x', { a: 2 }))
    expect(viewKey('x', new Date(0))).toContain('1970-01-01')
  })
})

describe('memoView — admission control', () => {
  it(`never runs more than MAX_INFLIGHT_VIEWS (${MAX_INFLIGHT_VIEWS}) distinct computations at once`, async () => {
    invalidateViews()
    let running = 0
    let peak = 0
    const slow = (n: number) => async () => {
      running += 1
      peak = Math.max(peak, running)
      await sleep(30)
      running -= 1
      return n
    }
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => memoView(`k:adm:${i}`, slow(i), on)))
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    /* A LITERAL, not the constant: the first version compared against MAX_INFLIGHT_VIEWS and
       passed with the bound set to 99 — a test that reads its expectation from the thing it
       tests cannot fail. The constant is pinned separately so a change to it is deliberate. */
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1) // the bound is a ceiling, not a serialiser
    expect(MAX_INFLIGHT_VIEWS).toBe(2)
  })
})

/**
 * THE BUILDER NOBODY WRAPPED YET. A memo that covers eight of nine page builders leaves the
 * ninth as the pile-up — and the first version of this change shipped exactly that: four
 * files gained the import and not the wrapper. No behavioural test can fail for a caller
 * nobody has written, so this is a source grep, in the style of one-route-rule.test.ts.
 */
describe('every page builder delegates to memoView', () => {
  const root = join(import.meta.dirname, '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  const files = ['src/app/view-model.ts', ...readdirSync(join(root, 'src/app/view-model')).map((f) => `src/app/view-model/${f}`)]
  /** Exceptions, each with the reason its file states. */
  const ALLOWED = new Set([
    'buildTodayView', // a cheap projection of the memoised buildCeoView — memoising twice lets two copies disagree
    'buildChannelsView', // same
    'buildLoginQueue', // polled by the Connect flow while a person signs in; moves second to second
  ])

  it('wraps every builder a page.tsx imports', () => {
    /* THE SET IS "WHAT A PAGE CALLS", discovered rather than listed — a hand-maintained list
       is what let four builders ship with the import and no wrapper. Internal helpers a page
       never calls (the per-chart builders inside charts.ts) are covered by their caller. */
    const pages = walk(join(root, 'src/app')).filter((p) => p.endsWith('page.tsx'))
    const called = new Set<string>()
    for (const p of pages) for (const m of readFileSync(p, 'utf8').matchAll(/\bbuild[A-Z]\w+/g)) called.add(m[0])
    expect(called.size).toBeGreaterThan(8)
    const defs = new Map<string, string>()
    for (const f of files) {
      const src = read(f)
      const re = /export async function (build\w+)\s*\(([^)]*)\)[^{]*\{\s*([^\n]*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) defs.set(m[1]!, m[3]!)
    }
    const unwrapped = [...called].filter((name) => !ALLOWED.has(name) && defs.has(name) && !/return memoView\(/.test(defs.get(name)!))
    expect(unwrapped).toEqual([])
  })

  it('actions.ts never calls revalidatePath directly — refreshPath drops the memo with it', () => {
    const src = read('src/app/actions.ts')
    expect(src.match(/revalidatePath\(/g)?.length).toBe(1) // the helper's own body
    expect(src).toMatch(/function refreshPath\(path: string\): void \{\s*invalidateViews\(\)\s*revalidatePath\(path\)/)
    expect(src.match(/refreshPath\(/g)!.length).toBeGreaterThan(40)
  })
})
