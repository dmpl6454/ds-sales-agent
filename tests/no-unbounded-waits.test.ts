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
      const raw = readFileSync(file, 'utf8')
      // A browser component fetches its own same-origin API; it is not a server waiting on a
      // remote. Identified by its directive, not its directory: actions.ts lives in src/app too.
      if (/^\s*['"]use client['"]/.test(raw)) continue
      const src = code(raw)
      // EVERY call, whatever its shape: find `fetch(` not preceded by an identifier character or
      // a dot (so `prefetch(` and `x.fetch(` are not calls of the global), then read the WHOLE
      // argument list by bracket matching. A call the scan cannot close fails rather than skips.
      for (const m of src.matchAll(/(?<![\w.$])fetch\(/g)) {
        seen++
        let depth = 1
        let i = m.index! + m[0].length
        for (; i < src.length && depth > 0; i++) {
          if (src[i] === '(') depth++
          else if (src[i] === ')') depth--
        }
        const args = src.slice(m.index! + m[0].length, i - 1)
        // Named by the call's own text: line numbers would be those of the comment-stripped source.
        const at = `${file.replace(root, '')}: fetch(${args.replace(/\s+/g, ' ').slice(0, 60)}`
        if (depth !== 0) offenders.push(`${at} (could not read the call)`)
        else if (!/signal:\s*AbortSignal\.timeout\(/.test(args)) offenders.push(at)
      }
    }
    expect(seen, 'no fetch found at all — the scan is broken').toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })

  it('no agent pass is guarded by a bare boolean "running" flag', () => {
    const src = code(readFileSync(join(root, 'src/agent/index.ts'), 'utf8'))
    expect(src).not.toMatch(/let \w*[Rr]unning\s*=\s*(false|true)\b/)
    // The three passes that can hang all go through the timestamp check.
    expect(src.match(/passIsRunning\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
