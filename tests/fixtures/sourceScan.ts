import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Helpers for the SOURCE-SHAPE tests — the ones whose failure mode is a call site nobody has
 * written yet, which no behavioural test can catch.
 *
 * They DISCOVER files rather than listing them. A hard-coded caller list is exactly how a
 * second frame path lived beside `judge.ts` for two months: `tests/one-judging-path.test.ts`
 * named three callers, the detector and the accuracy harness were not among them, and the
 * test stayed green while both ran their own copy.
 */

export const ROOT = join(import.meta.dirname, '..', '..')

/** Every .ts/.tsx file under `dir` (relative to the repo root), skipping generated code. */
export function walkSources(dir: string): string[] {
  const out: string[] = []
  const visit = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      if (statSync(p).isDirectory()) {
        if (name === 'generated' || name === 'node_modules') continue
        visit(p)
      } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(relative(ROOT, p))
      }
    }
  }
  visit(join(ROOT, dir))
  return out.sort()
}

export function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * The source with comments removed and strings KEPT.
 *
 * A character scanner rather than the one-line regex other tests use, because these files
 * talk about the very calls being grepped for — judge.ts's docblocks quote
 * `applyFrameSignal(captionOnly, …)` — and a regex strip mis-reads `'src/**\/*.ts'` or
 * `'https://…'` inside a string as a comment. Strings, template literals and regex literals
 * are copied through untouched; only `//` and `/* *\/` comments become a space.
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  let prev = '' // last significant (non-space) character emitted, to tell a regex from a division
  const regexCanFollow = '(,=:[!&|?{};+-*%<>~^'
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
      prev = c
      continue
    }
    if (c === '/' && (prev === '' || regexCanFollow.includes(prev) || /\b(return|typeof|case|in|of)\s*$/.test(out.slice(-12)))) {
      let j = i + 1
      let inClass = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) break
        j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
      prev = '/'
      continue
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

/**
 * Every INVOCATION of `name(` in already-comment-stripped code, as its raw argument text.
 *
 * Paren-matching, not a regex: a regex requiring a newline before the close once found ZERO
 * calls in a one-line call site and passed vacuously. Declarations are skipped (`function
 * name(`, `async name(`), and so is a longer identifier that merely ends in `name`. Pass a
 * leading dot (`.classify`) for a method call; a method DEFINITION has no dot before it.
 */
export function callsOf(code: string, name: string): string[] {
  const out: string[] = []
  const needle = `${name}(`
  let from = 0
  for (;;) {
    const start = code.indexOf(needle, from)
    if (start === -1) return out
    from = start + needle.length
    const before = code[start - 1] ?? ''
    // `.classify(` is a method call; `xclassify(` is a different identifier.
    if (!name.startsWith('.') && /[\w$]/.test(before)) continue
    if (/\b(function|async)\s+$/.test(code.slice(Math.max(0, start - 30), start))) continue
    let depth = 0
    let i = start + needle.length - 1
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(code.slice(start + needle.length, i))
  }
}

/** Arguments at the TOP level of a call — commas inside nested calls or objects do not count. */
export function topLevelArgs(args: string): string[] {
  if (args.trim() === '') return []
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of args) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}
