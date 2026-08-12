import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { operatorName } from '@/outreach/render'

/**
 * ── OUR OWN BOOKKEEPING MUST NOT REACH THE SCREEN ──────────────────────────
 *
 * `TargetAccount.displayName` and `SenderAccount.displayName` are INTERNAL labels. CLAUDE.md
 * already records one consequence: `{{channel}}` rendered `displayName` and put "Bollywood
 * Chronicle (test target)" into the body of a message. The same strings then leaked onto the
 * dashboard, where on 2026-08-06 the live values were:
 *
 *     "Bollywood Chronicle (test target)"     "Bollywood Society (rehearsal target)"
 *     "Burner (test target)"                  "Tabish (trial)"
 *
 * So the headline read *"Burner (test target) replied. Outreach to them is on hold"* and an
 * account row read "Tabish (trial)". Sixteen separate call sites, all of the form
 * `x.displayName`, and each one individually looks harmless.
 *
 * That is why this is a SOURCE-level assertion rather than a copy review. A per-string test
 * would have to name all sixteen and would pass the seventeenth. `tests/shell.test.ts` uses
 * the same technique for the same reason — a page forgetting `<Nav>` is invisible in every
 * other check because only the ABSENCE of something is wrong.
 *
 * Scoped to the view models on purpose. They are the only place display strings are produced
 * — "the page itself does no querying and no interpretation", per `view-model.ts` — and
 * `actions.ts` legitimately WRITES a `displayName` when a channel is added, which must not be
 * trimmed on the way into the database.
 */

const VIEW_MODELS = (() => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts')) out.push(full)
    }
  }
  walk(join(process.cwd(), 'src', 'app', 'view-model'))
  out.push(join(process.cwd(), 'src', 'app', 'view-model.ts'))
  return out
})()

describe('no view model hands a raw displayName to the screen', () => {
  it('found the view models', () => {
    // Without this the whole file passes by covering nothing if the layout moves.
    expect(VIEW_MODELS.length).toBeGreaterThanOrEqual(4)
  })

  it.each(VIEW_MODELS.map((f) => [f.split('/src/')[1]!, f]))('%s', (_rel, file) => {
    expect(unwrappedReads(readFileSync(file, 'utf8')), 'reads displayName directly').toEqual([])
  })

  /**
   * And the assertion above is not vacuous: it must be able to FAIL.
   *
   * A guard nobody can trigger is this codebase's signature failure, and the first version of
   * `unwrappedReads` was one — it matched `personaBroken[0]!.displayName` as the substring
   * `0]!.displayName`, which no `operatorName(...)` prefix could ever match, so it reported a
   * leak in correctly-wrapped code. A checker that cries wolf gets deleted, which is a worse
   * outcome than not having written it. So both directions are pinned here.
   */
  it('reports a genuine leak', () => {
    expect(unwrappedReads('const name = target.displayName\n')).toEqual(['target.displayName'])
    expect(unwrappedReads('sentence: `Messaged ${a.pair.target.displayName}`')).toEqual([
      'a.pair.target.displayName',
    ])
  })

  it('accepts a wrapped read, including the bracket-and-bang forms that broke the first version', () => {
    expect(unwrappedReads('operatorName(target.displayName)')).toEqual([])
    expect(unwrappedReads('`${operatorName(personaBroken[0]!.displayName)} is incomplete`')).toEqual([])
    expect(unwrappedReads('operatorName(campaign?.target.displayName ?? "")')).toEqual([])
    expect(unwrappedReads('xs.map((s) => operatorName(s.displayName))')).toEqual([])
  })

  it('ignores a Prisma select and a field declaration, which are not reads', () => {
    expect(unwrappedReads('select: { displayName: true }')).toEqual([])
    expect(unwrappedReads('export interface X {\n  displayName: string\n}')).toEqual([])
  })

  /** A wrapped read must not launder an UNWRAPPED one elsewhere in the same file. */
  it('does not let one wrapped call excuse the rest of the file', () => {
    expect(unwrappedReads('operatorName(a.displayName)\nconst b = other.displayName')).toEqual([
      'other.displayName',
    ])
  })
})

/**
 * Reads of `displayName` that are NOT inside an `operatorName(...)` call.
 *
 * Works by DELETING every `operatorName(` … matching `)` region and then looking at what is
 * left, rather than by trying to guess the shape of an expression with a regex. Expressions
 * here contain `[0]`, `!`, `?.` and `??`, and a character class broad enough to cover them
 * happily matches a fragment starting mid-expression — which is exactly how the first version
 * of this checker produced a false positive.
 */
function unwrappedReads(src: string): string[] {
  let out = ''
  let i = 0
  while (i < src.length) {
    const at = src.indexOf('operatorName(', i)
    if (at === -1) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, at)
    // Walk to the paren that closes this call.
    let depth = 0
    let j = at + 'operatorName'.length
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    i = j + 1
  }
  // `something.displayName` — a leading dot is what makes it a READ. `displayName: true` in a
  // Prisma select and `displayName: string` in an interface have none.
  return [...out.matchAll(/[A-Za-z_$][\w$]*(?:[.?!]+[\w$]+|\[\d+\]|!)*\.displayName\b/g)].map((m) => m[0])
}

/**
 * The values themselves, asserted against the function rather than described in prose, so
 * this file records what was actually on screen and what it now reads as.
 */
describe('the live labels, before and after', () => {
  const LIVE: Array<[string, string]> = [
    ['Bollywood Chronicle (test target)', 'Bollywood Chronicle'],
    ['Bollywood Society (rehearsal target)', 'Bollywood Society'],
    ['Burner (test target)', 'Burner'],
    ['Tabish (trial)', 'Tabish'],
    // Untouched: no annotation to strip.
    ['Viral Bhayani', 'Viral Bhayani'],
    ['Royal Canin India', 'Royal Canin India'],
    ['Milano Ice Cream, Bangalore', 'Milano Ice Cream, Bangalore'],
  ]

  it.each(LIVE)('%s -> %s', (raw, clean) => {
    expect(operatorName(raw)).toBe(clean)
  })

  it('the headline that was actually wrong now reads correctly', () => {
    const before = `Burner (test target) replied. Outreach to them is on hold until you have answered.`
    const after = `${operatorName('Burner (test target)')} replied. Outreach to them is on hold until you have answered.`
    expect(after).toBe('Burner replied. Outreach to them is on hold until you have answered.')
    expect(after).not.toBe(before)
  })
})
