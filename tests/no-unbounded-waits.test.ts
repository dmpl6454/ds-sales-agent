import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * NOTHING THE AGENT OR THE WORKER WAITS ON MAY WAIT FOREVER (2026-10-09).
 *
 * Two shapes have each stopped real work in this codebase and were found again in the 9 October
 * audit:
 *
 *  - an outbound `fetch` with no timeout — Node's fetch has none, so a remote that accepts the
 *    connection and stalls holds the caller for as long as undici's own ~5-minute limits, under a
 *    `noOverlap` cron that skips every pass in the meantime (the classifier call had none);
 *  - a pass guarded by a BOOLEAN "running" flag — a pass frozen by sleep or a hung await leaves a
 *    `true` nothing clears, and every later pass returns silently (rule 27; the detection failover
 *    still had one).
 *
 * Source checks, because the failure mode is a call site or a pass nobody has written yet.
 * Comments are stripped first: prose about a fetch is not a fetch.
 */

const root = join(import.meta.dirname, '..')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? (n === 'generated' ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : []
  })

describe('no unbounded waits', () => {
  it('every server-side fetch( carries a timeout signal', () => {
    const offenders: string[] = []
    let seen = 0
    for (const file of walk(join(root, 'src'))) {
      // Browser components fetch their own same-origin API; they are not a server waiting on a remote.
      if (file.includes(`${join('src', 'app')}`) && !file.includes(join('src', 'app', 'api'))) continue
      const src = code(readFileSync(file, 'utf8'))
      for (const m of src.matchAll(/await fetch\(([\s\S]{0,900}?)\)\s*\n/g)) {
        seen++
        if (!/signal:\s*AbortSignal\.timeout\(/.test(m[1]!)) offenders.push(file.replace(root, ''))
      }
    }
    expect(seen, 'no fetch found at all — the scan is broken').toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it('no agent pass is guarded by a bare boolean "running" flag', () => {
    const src = code(readFileSync(join(root, 'src/agent/index.ts'), 'utf8'))
    expect(src).not.toMatch(/let \w*[Rr]unning\s*=\s*(false|true)\b/)
    // The three passes that can hang all go through the timestamp check.
    expect(src.match(/passIsRunning\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
