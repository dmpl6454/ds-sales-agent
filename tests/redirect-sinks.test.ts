import { describe, it, expect } from 'vitest'
import { readSource, stripComments, callsOf, topLevelArgs } from './fixtures/sourceScan'

/**
 * EVERY REDIRECT AFTER A SIGN-IN GOES THROUGH `safeNext` (2026-10-09).
 *
 * `safe-next.ts` is only a guard where it is CALLED. The two sinks that redirect to an
 * attacker-influenced value are `signUp` and `signIn` in `auth-actions.ts`, and both run after
 * `createSession` — the moment a genuine login is complete, which is exactly what makes an open
 * redirect there worth phishing for. A third `redirect(next)` added later would not touch
 * `safe-next.ts` at all, and no behavioural test of `safeNext` can fail for a call that skips it.
 *
 * So this asserts the SHAPE of every redirect in the file: a string literal, or the one call
 * inside `redirectToPath`, and every `redirectToPath` call wraps `safeNext(`. Narrower than
 * that (counting only `redirectToPath(` calls) would let `redirect(next as never)` through.
 */
const src = stripComments(readSource('src/app/auth-actions.ts'))

describe('auth-actions.ts redirects only to a sanitised or literal destination', () => {
  it('every redirect( is a string literal or the single call inside redirectToPath', () => {
    const helper = src.slice(src.indexOf('function redirectToPath('))
    const helperBody = helper.slice(0, helper.indexOf('\n}') + 2)
    const calls = callsOf(src, 'redirect')
    expect(calls.length, 'no redirect( found — the grep is broken').toBeGreaterThan(1)
    let inHelper = 0
    for (const args of calls) {
      const first = topLevelArgs(args)[0] ?? ''
      if (/^(['"`])[^'"`$]*\1$/.test(first)) continue
      expect(helperBody, `a redirect with a computed destination outside redirectToPath: redirect(${args})`).toContain(`redirect(${args})`)
      inHelper++
    }
    expect(inHelper).toBe(1)
  })

  it('every redirectToPath( call passes safeNext(…), and there are exactly two', () => {
    const calls = callsOf(src, 'redirectToPath')
    expect(calls).toHaveLength(2)
    for (const args of calls) expect(args, `redirectToPath(${args})`).toMatch(/^safeNext\(/)
  })
})
