import { NextResponse, type NextRequest } from 'next/server'
/**
 * From `session-cookie`, NOT `session` — middleware runs in the Edge runtime and
 * `lib/session.ts` imports `node:crypto`, which does not exist there. That import
 * compiled and typechecked cleanly and then threw on every single request, so the entire
 * dashboard 500'd including the sign-in page. Keep this import Node-free.
 */
import { SESSION_COOKIE } from '@/lib/session-cookie'

/**
 * The front door. Default-DENY.
 *
 * WHAT THIS CLOSES
 *
 * There was no middleware at all, and `src/app/actions.ts` exports 18 server actions —
 * `sendNow`, `setAutopilot`, `connectAccount`, `removeSender`, `removeTarget`. A server
 * action is reachable by anything that can reach the page, so every one of those was
 * callable by any client that could open the port, with no password. Measured before
 * this existed: a `curl` to the LAN IP returned 200 with `Send from @<revenue account>`
 * in the HTML.
 *
 * WHY THE MATRIX IS DENY-BY-DEFAULT
 *
 * The list below is of PUBLIC paths, and everything absent from it is protected. The
 * opposite shape — a list of protected paths — fails in the dangerous direction: a new
 * route, or a route someone renames, is exposed until a human remembers to add it. That
 * is precisely how 18 actions came to be exported with nothing in front of them. Here a
 * forgotten route is merely unreachable, which is visible in a second.
 *
 * WHAT THIS IS *NOT*
 *
 * Not a permission model. Open signup is deliberate (Tabish, 2026-08-03, after the
 * exposure was stated twice), and every signed-in user can send from every connected
 * account — `sendNow` checks the safety gate, not who is asking. So this answers "is
 * anyone signed in", never "may THIS person do THIS". Before the dashboard is reachable
 * beyond 127.0.0.1 that distinction needs a role column. See the spec.
 *
 * AND NOT A SUBSTITUTE FOR CHECKING IN THE ACTION
 *
 * Middleware is a router-level filter; a server action is a POST endpoint. Defence in
 * depth means each mutating action ALSO calls `requireUser()`. If a future Next release,
 * a config change, or a matcher edit lets one request past this file, the action must
 * still refuse. One layer that cannot fail is not a thing that exists.
 */

/**
 * Paths reachable with no session.
 *
 * Deliberately tiny, and each entry is here for a stated reason:
 * /sign-in, /sign-up   the only way to GET a session. Locking these would lock out
 *                        everyone, permanently, including whoever must fix it.
 *   /_next, /favicon.ico static assets. The login page cannot render without its CSS,
 *                        and a login page that renders unstyled looks broken enough
 *                        that people assume the app is down.
 */
export const PUBLIC_PATHS = ['/sign-in', '/sign-up'] as const
const PUBLIC_PREFIXES = ['/_next/', '/favicon.ico'] as const

export function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname as (typeof PUBLIC_PATHS)[number])) return true
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
}

/**
 * What should happen to a request, as a value.
 *
 * Split out from `middleware()` and kept PURE — no NextRequest, no NextResponse, no
 * cookies — for the same reason `governor.ts` and `gate.ts` are pure: it is the only way
 * to test every branch in BOTH directions. A gate verified only where it refuses is the
 * documented recurring failure in this codebase, and an auth check is the worst possible
 * place to repeat it: "blocks everyone" and "blocks nobody" both pass a one-sided test.
 */
export type RouteDecision =
  | { kind: 'allow' }
  | { kind: 'redirect-signin'; next: string | null }
  | { kind: 'unauthorized' }

export function decideRoute(input: {
  pathname: string
  search: string
  method: string
  hasCookie: boolean
}): RouteDecision {
  const { pathname, search, method, hasCookie } = input

  if (isPublic(pathname)) {
    /**
     * ── NO already-signed-in BOUNCE HERE ANY MORE (2026-09-01) ──────────────
     *
     * This file used to send `hasCookie && /sign-in` home — presence, because this file
     * may not touch the database. Composed with the DOWNSTREAM validated redirect the
     * other way, that was an infinite loop for anyone holding a DEAD cookie:
     *
     *     /         currentUser() fails    → 307 /sign-in     (validated, correct)
     *     /sign-in  cookie merely PRESENT  → 307 /            (presence, this file)
     *
     * Safari held an expired session and could never reach the one page that would have
     * replaced it — "Too many redirects", locked out of the login form itself. The
     * signed-in convenience bounce lives in the sign-in/sign-up PAGES now, where
     * `currentUser()` can actually validate. Presence is not a session; this file's own
     * docblock says a forged cookie buys "a redirect, not an action", and two such
     * redirects composed into a lockout.
     */
    return { kind: 'allow' }
  }

  if (hasCookie) return { kind: 'allow' }

  /**
   * A server action is a POST to the page's own URL. Redirecting it would turn a refused
   * mutation into a 200 for the login page, which the client reads as success — a control
   * reporting something it did not do. So an unauthenticated write gets a bare 401.
   */
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'unauthorized' }

  const target = `${pathname}${search}`
  return { kind: 'redirect-signin', next: target === '/' ? null : target }
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl

  /**
   * Presence of the cookie only — this file does not touch the database.
   *
   * Middleware runs on every request, and `prisma` here would mean a query per asset.
   * More importantly the session is VALIDATED (hash looked up, expiry enforced in the
   * query) by `currentUser()` in the page or action that actually does something. So a
   * forged or expired cookie gets past this file and is then refused with nothing done —
   * it buys an attacker a redirect, not an action.
   *
   * This is the one place where being a cheap check is correct rather than sloppy, and
   * it is only correct BECAUSE the real check exists downstream. If `requireUser()` is
   * ever removed from the actions, this comment becomes a lie and the system becomes
   * open.
   */
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value)

  const decision = decideRoute({ pathname, search, method: request.method, hasCookie })

  switch (decision.kind) {
    case 'allow':
      return NextResponse.next()

    case 'unauthorized':
      return new NextResponse(null, { status: 401 }) as unknown as NextResponse

    case 'redirect-signin': {
      /**
       * Carry the original destination so signing in lands where the person was going.
       * `decision.next` is already only a path and query — never an absolute URL, which
       * would make this an open redirect that could bounce someone to another origin
       * with a genuine login behind it.
       */
      const url = new URL('/sign-in', request.url)
      if (decision.next) url.searchParams.set('next', decision.next)
      return NextResponse.redirect(url)
    }
  }
}

/**
 * Everything except Next's internals and static files.
 *
 * The negative lookahead is the matcher equivalent of the deny-by-default rule above:
 * it names what to SKIP, so a new route is covered automatically. `api` is deliberately
 * absent from the skip list — there are no public API routes, and an unprotected one
 * added later must not be exempt by default.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
