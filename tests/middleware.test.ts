import { describe, expect, it } from 'vitest'
import { decideRoute, isPublic, PUBLIC_PATHS } from '@/middleware'
import { safeNext } from '@/lib/safe-next'

/**
 * The front door, tested in BOTH directions.
 *
 * An auth check is the worst place in the codebase to verify only one side: "refuses
 * everyone" and "refuses nobody" both pass a test that only asserts refusal. Every
 * block below therefore pairs a refusal with the permission it must not swallow.
 *
 * Verified against the running server too (307 for anonymous, 200 with a real session,
 * 307 for an expired one and for a forged token). These tests are what keep it true.
 */

const anon = { method: 'GET', hasCookie: false, search: '' }
const authed = { method: 'GET', hasCookie: true, search: '' }

describe('decideRoute — protected pages', () => {
  it('sends an anonymous visitor to sign-in', () => {
    expect(decideRoute({ ...anon, pathname: '/' })).toEqual({ kind: 'redirect-signin', next: null })
  })

  it('LETS A SIGNED-IN VISITOR THROUGH — the direction a one-sided test would miss', () => {
    expect(decideRoute({ ...authed, pathname: '/' })).toEqual({ kind: 'allow' })
  })

  it('protects a route nobody has thought of yet (deny by default)', () => {
    // The whole point of listing PUBLIC paths rather than protected ones: a route added
    // later is covered without anyone remembering to cover it.
    for (const path of ['/settings', '/api/send', '/admin', '/brands', '/some/deep/route']) {
      expect(decideRoute({ ...anon, pathname: path }).kind).toBe('redirect-signin')
      expect(decideRoute({ ...authed, pathname: path }).kind).toBe('allow')
    }
  })

  it('carries the intended destination, including its query string', () => {
    expect(decideRoute({ ...anon, pathname: '/brands', search: '?sort=oldest' })).toEqual({
      kind: 'redirect-signin',
      next: '/brands?sort=oldest',
    })
  })

  it('does not carry a `next` of "/" — signing in already lands there', () => {
    expect(decideRoute({ ...anon, pathname: '/' })).toEqual({ kind: 'redirect-signin', next: null })
  })
})

describe('decideRoute — server actions and other writes', () => {
  it('returns 401 rather than redirecting an unauthenticated POST', () => {
    // A redirect would give the client a 200 for the login page, which reads as success.
    // A refused mutation must never look like a completed one.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(decideRoute({ pathname: '/', search: '', method, hasCookie: false })).toEqual({
        kind: 'unauthorized',
      })
    }
  })

  it('ALLOWS the same POST once signed in', () => {
    expect(decideRoute({ pathname: '/', search: '', method: 'POST', hasCookie: true })).toEqual({
      kind: 'allow',
    })
  })

  it('treats HEAD like GET, so a link check gets a redirect rather than a 401', () => {
    expect(decideRoute({ pathname: '/', search: '', method: 'HEAD', hasCookie: false }).kind).toBe(
      'redirect-signin',
    )
  })
})

describe('decideRoute — public pages', () => {
  it('lets an anonymous visitor reach sign-in and sign-up', () => {
    // If this ever fails, nobody can sign in — including whoever must fix it.
    for (const path of PUBLIC_PATHS) {
      expect(decideRoute({ ...anon, pathname: path })).toEqual({ kind: 'allow' })
    }
  })

  /**
   * ── THE REDIRECT LOOP REGRESSION (2026-09-01) ─────────────────────────────
   *
   * This used to assert `redirect-home` — a bounce on cookie PRESENCE, because the
   * middleware may not touch the database. Composed with the dashboard's VALIDATED
   * redirect the other way, a DEAD cookie ping-ponged /sign-in → / → /sign-in forever:
   * Safari, holding an expired session, hit "Too many redirects" and could never reach
   * the login form that would have replaced the cookie. The auth pages ALLOW every
   * cookie state now; the signed-in bounce lives in the pages themselves, where
   * `currentUser()` validates. Reintroducing the presence bounce here fails this case.
   */
  it('lets a cookie-carrying visitor reach the auth pages — a dead cookie must be able to reach the form', () => {
    for (const path of PUBLIC_PATHS) {
      expect(decideRoute({ ...authed, pathname: path })).toEqual({ kind: 'allow' })
    }
  })

  it('never redirects static assets, even when signed in', () => {
    // Redirecting these would render the dashboard unstyled, which reads as "broken app"
    // rather than "auth working".
    for (const path of ['/_next/static/css/app.css', '/_next/static/chunks/main.js', '/favicon.ico']) {
      expect(decideRoute({ ...authed, pathname: path })).toEqual({ kind: 'allow' })
      expect(decideRoute({ ...anon, pathname: path })).toEqual({ kind: 'allow' })
    }
  })
})

describe('isPublic', () => {
  it('is true for the auth pages and asset prefixes', () => {
    expect(isPublic('/sign-in')).toBe(true)
    expect(isPublic('/sign-up')).toBe(true)
    expect(isPublic('/_next/static/chunks/x.js')).toBe(true)
    expect(isPublic('/favicon.ico')).toBe(true)
    // The Mac that pairs itself has no session yet — exactly these two, and nothing beside them.
    expect(isPublic('/api/device/enrol/start')).toBe(true)
    expect(isPublic('/api/device/enrol/poll')).toBe(true)
    expect(isPublic('/api/device/enrol/approve')).toBe(false)
    expect(isPublic('/api/device/enrol')).toBe(false)
    expect(isPublic('/devices/enrol')).toBe(false)
  })

  it('is false for everything else, including near-misses', () => {
    expect(isPublic('/')).toBe(false)
    expect(isPublic('/sign-in-not-really')).toBe(false)
    expect(isPublic('/x/_next/static/y.js')).toBe(false)
    // A path that merely CONTAINS a public path must not be public — otherwise
    // `/admin?next=/sign-in` or `/evil/sign-in` would walk straight through.
    expect(isPublic('/evil/sign-in')).toBe(false)
  })
})

describe('safeNext — the open-redirect guard', () => {
  it('keeps a legitimate same-origin path', () => {
    expect(safeNext('/brands')).toBe('/brands')
    expect(safeNext('/brands?sort=oldest')).toBe('/brands?sort=oldest')
    expect(safeNext('/')).toBe('/')
  })

  it('falls back to / when there is nothing to honour', () => {
    expect(safeNext(undefined)).toBe('/')
    expect(safeNext(null)).toBe('/')
    expect(safeNext('')).toBe('/')
  })

  it('REFUSES an absolute URL to another origin', () => {
    expect(safeNext('https://evil.com')).toBe('/')
    expect(safeNext('http://evil.com/steal')).toBe('/')
    expect(safeNext('javascript:alert(1)')).toBe('/')
  })

  it('REFUSES a protocol-relative URL — the case that gets missed', () => {
    // A browser reads `//evil.com` as `https://evil.com`. It starts with `/`, so a
    // guard that only checked the first character would wave it straight through, and
    // the phishing value is that the login behind it is genuine.
    expect(safeNext('//evil.com')).toBe('/')
    expect(safeNext('//evil.com/path')).toBe('/')
  })

  it('REFUSES backslashes, which some browsers normalise to a separator', () => {
    expect(safeNext('/\\evil.com')).toBe('/')
    expect(safeNext('\\\\evil.com')).toBe('/')
  })
})
