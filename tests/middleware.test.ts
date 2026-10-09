import { describe, expect, it } from 'vitest'
import { parse as parseQuery } from 'node:querystring'
import { NextURL } from 'next/dist/server/web/next-url'
import { decideRoute, isPublic, PUBLIC_PATHS } from '@/middleware'
import { safeNext } from '@/lib/safe-next'
import { newUserCode } from '@/lib/deviceEnrol'

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

  /**
   * ── /api/pulse IS PROTECTED, AND THAT IS THE DEFAULT WORKING (2026-09-04) ─────────
   *
   * `auto-refresh.tsx` polls this route every 30-45 s from every open tab to decide whether
   * a page needs re-rendering. It reads five aggregates over the outreach, detection and
   * settings tables — nothing a stranger may see, and nothing a stranger should be able to
   * make the server compute on a loop. It is deliberately NOT in `PUBLIC_PATHS`; an
   * anonymous poll gets the sign-in redirect, which the client treats as "do nothing". If
   * this ever fails, somebody added it to the public list to make an expired-session tab
   * quieter, and that is the wrong fix.
   */
  it('protects /api/pulse — the change-detection poll is behind the front door', () => {
    expect(isPublic('/api/pulse')).toBe(false)
    expect((PUBLIC_PATHS as readonly string[]).includes('/api/pulse')).toBe(false)
    expect(decideRoute({ ...anon, pathname: '/api/pulse' })).toEqual({ kind: 'redirect-signin', next: '/api/pulse' })
    expect(decideRoute({ ...authed, pathname: '/api/pulse' })).toEqual({ kind: 'allow' })
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

/**
 * ── THE GUARD MODELLED THE STRING, AND THE BROWSER NAVIGATES THE PARSE (2026-10-09) ──
 *
 * Every case below is a value that passed the old four checks and sent a person somewhere
 * other than where the check thought. Each premise is PINNED in the test itself — the parser
 * really does turn the input into the off-site URL — so a test here cannot pass because the
 * attack stopped being an attack.
 */
const DASH = 'https://dash.example/sign-in'

/** What `?next=<raw>` decodes to, the way the sign-in page receives it. */
const decoded = (raw: string) => new URLSearchParams(`next=${raw}`).get('next')!

/**
 * Where Next's CLIENT actually sends the browser for a server-action redirect to `v`:
 * the server sets `x-action-redirect: <v>;push`, the client takes everything before the FIRST
 * `;`, strips one trailing slash from the path part, and resolves it against the page.
 */
function navigatedTo(v: string): URL {
  let loc = `${v};push`.split(';')[0]!
  const cut = loc.search(/[?#]/)
  const path = cut === -1 ? loc : loc.slice(0, cut)
  const rest = cut === -1 ? '' : loc.slice(cut)
  loc = (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path) + rest
  if (loc === '') loc = '/'
  return new URL(loc, DASH)
}

describe('safeNext — the parser may change nothing', () => {
  /** TAB is the live vector: Node accepts it in a header value, and the parser deletes it. */
  it('refuses TAB, LF and CR, which the parser deletes to make //evil.com', () => {
    expect(new URL('/\t/evil.com', DASH).origin).toBe('https://evil.com') // the premise
    for (const raw of ['/%09/evil.com', '/%0A/evil.com', '/%0D/evil.com', '/%09%2Fevil.com']) {
      expect(safeNext(decoded(raw)), raw).toBe('/')
    }
  })

  it('refuses dot segments, which collapse to a protocol-relative path', () => {
    expect(new URL('/.//evil.com', 'https://dash.example').pathname).toBe('//evil.com') // the premise
    for (const v of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/%2e%2e//evil.com', '/a/./b', '/%2E%2E/targets']) {
      expect(safeNext(v), v).toBe('/')
    }
  })

  /**
   * ── THE `;` BYPASS ───────────────────────────────────────────────────────
   * Resolved whole, these land on `/` — the `..` pops the junk segment — so an origin check
   * and a resolved-pathname check both pass them. The client splits on the first `;` and goes
   * to `/.//evil.com`. Only the `;` rule and the round trip stop it.
   */
  it('refuses a ";" — the client navigates to the part before it', () => {
    expect(new URL('/.//evil.com;/../..', 'https://dash.example').pathname).toBe('/') // whole: harmless
    expect(new URL('/.//evil.com;/../..'.split(';')[0]!, DASH).pathname).toBe('//evil.com') // the client's view
    expect(safeNext('/.//evil.com;/../..')).toBe('/')
    expect(safeNext('/a/..//evil.com;/../x')).toBe('/')
    // A ';' makes the validated string and the navigated string differ even when both are
    // harmless, which is reason enough on its own.
    expect(safeNext('/targets;x')).toBe('/')
  })

  /** Only the round trip refuses these; the character whitelist passes every one. */
  it('refuses anything the parser would re-encode, and keeps legitimate encoding byte-identical', () => {
    expect(safeNext("/paid-posts?q='x'")).toBe('/')
    expect(safeNext('/a?')).toBe('/')
    expect(safeNext('/a#')).toBe('/')
    const encoded = '/x%2Fy?q=%2e%2e&q=a%3Bb#frag'
    expect(safeNext(encoded)).toBe(encoded)
  })

  /**
   * Raw space, DEL, a C0 control and non-ASCII all resolve SAME-origin, so only the whitelist
   * refuses them — and `\x01` would otherwise reach `res.setHeader`, which throws after the
   * session has been created.
   */
  it('refuses raw controls, space and non-ASCII', () => {
    for (const v of ['/\x01x', '/\x7f', '/paid posts', '/ x', '/\u3000/evil.com']) {
      expect(safeNext(v), JSON.stringify(v)).toBe('/')
    }
  })

  it('never throws on a non-string — ?next=a&next=b arrives as an ARRAY', () => {
    expect(safeNext(['/a', '/b'] as unknown as string)).toBe('/')
    expect(safeNext(42 as unknown as string)).toBe('/')
    expect(safeNext({} as unknown as string)).toBe('/')
  })

  /**
   * THE SWEEP MODELS THE SINK, NOT THE VALIDATED STRING. An earlier version of this sweep
   * asserted on `new URL(safeNext(x))` — the string the server checked — and passed against
   * the `;` bypass, because the transformation that leaks happens AFTER the check. So every
   * UTF-16 code unit is pushed through eight shapes and then through `navigatedTo`, which does
   * what Next's client does, and the URL the browser would load is what is asserted.
   */
  it('no code unit, in any shape, sends the browser off this origin or to a // path', () => {
    const shapes = (c: string) => [
      `/${c}/evil.com`,
      `/${c}${c}evil.com`,
      `/.${c}/evil.com`,
      `/${c}\\evil.com`,
      `/.//evil.com;${c}/../..`,
      `/.${c}/evil.com;/..`,
      `/a/..//evil.com;${c}`,
      `/%2e//evil.com;/${c}..`,
    ]
    const leaks: string[] = []
    for (let code = 0; code <= 0xffff; code++) {
      const c = String.fromCharCode(code)
      for (const x of shapes(c)) {
        const u = navigatedTo(safeNext(x))
        if (u.origin !== 'https://dash.example' || (u.pathname + u.search).startsWith('//')) {
          leaks.push(JSON.stringify(x))
        }
      }
    }
    expect(leaks.slice(0, 10)).toEqual([])
  })
})

/**
 * ── EVERY `next` THE APP GENERATES SURVIVES, BYTE-IDENTICAL ─────────────────────────────
 *
 * The rule refuses whatever the parser would change, so it must be checked against what the
 * app actually emits — derived through the REAL parsing the middleware sees (`NextURL`), the
 * real `decideRoute`, the real `searchParams.set`, and BOTH decoders a page might use. Writing
 * these values by hand would skip exactly the normalisation (raw Devanagari, quotes, spaces)
 * that decides whether a legitimate destination survives.
 */
describe('safeNext — keeps every destination the app generates', () => {
  const raws = [
    '/targets?channel=viralbhayani&page=2',
    '/paid-posts?q=arshad+warsi',
    '/paid-posts?q=arshad%20warsi&channel=x',
    '/paid-posts?q=हि',
    "/paid-posts?q='quoted'",
    '/paid-posts?q=a b',
    '/analytics?range=7d&from=bollywoodchronicle&to=sony&sent=3',
    '/senders?paired=DMPLs%20Mac%20Studio',
    '/devices/enrol?code=ABCD2345',
    '/api/pulse',
    '/targets/',
    '/a?',
  ]

  it.each(raws)('%s', (raw) => {
    const nextUrl = new NextURL(`http://127.0.0.1:3100${raw}`)
    const d = decideRoute({ pathname: nextUrl.pathname, search: nextUrl.search, method: 'GET', hasCookie: false })
    expect(d.kind).toBe('redirect-signin')
    if (d.kind !== 'redirect-signin' || !d.next) throw new Error('no next to carry')
    const signIn = new URL('/sign-in', 'http://127.0.0.1:3100')
    signIn.searchParams.set('next', d.next)
    const viaSearchParams = new URL(signIn.href).searchParams.get('next')!
    const viaQuerystring = parseQuery(signIn.search.slice(1)).next as string
    expect(viaQuerystring).toBe(viaSearchParams)
    expect(safeNext(viaSearchParams)).toBe(viaSearchParams)
  })

  /** The enrol page builds its own `next`, and the start route hands out `approvePath`. */
  it('keeps the enrol destination for real pairing codes', () => {
    for (let i = 0; i < 200; i++) {
      const code = newUserCode()
      const href = `/sign-in?next=${encodeURIComponent(`/devices/enrol?code=${code}`)}`
      const received = new URL(href, 'http://127.0.0.1:3100').searchParams.get('next')!
      expect(safeNext(received)).toBe(`/devices/enrol?code=${code}`)
      const approvePath = `/devices/enrol?code=${code}`
      expect(safeNext(approvePath)).toBe(approvePath)
    }
  })
})
