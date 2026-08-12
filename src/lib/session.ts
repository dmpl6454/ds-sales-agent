import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { prisma } from './db'
import { SESSION_COOKIE } from './session-cookie'
import { canAct, parseRole, NOT_AN_OPERATOR, type Role } from './roles'

/**
 * Dashboard sessions.
 *
 * A session token is a bearer credential: whoever holds it is signed in. That is the
 * same property that makes Instagram's `sessionid` dangerous to transplant, and the
 * reason this project refuses cookie imports. Our own tokens get the same respect:
 *
 *  - 32 random bytes from the OS CSPRNG. Not a cuid, not a timestamp, not a JWT with a
 *    guessable secret.
 *  - Stored as a SHA-256 HASH. A database read — a backup, `pnpm db:studio`, a screen
 *    share — must not hand over live sessions for every signed-in operator.
 *  - httpOnly, sameSite=lax, path=/. `secure` follows the deployment: see COOKIE_SECURE.
 *
 * SHA-256 rather than scrypt for the token, and that difference is deliberate: a
 * password is low-entropy and needs a slow KDF to survive an offline guessing attack,
 * whereas a 256-bit random token cannot be guessed at all, so a fast hash is
 * sufficient and is checked on every single request.
 */

/**
 * Re-exported for convenience so callers that already import this module do not need a
 * second import. The name is DEFINED in `session-cookie.ts` because `src/middleware.ts`
 * needs it in the Edge runtime, where this file's `node:crypto` import cannot load.
 */
export { SESSION_COOKIE }

/** 30 days. Long enough not to nag an operator; short enough that a stale copy dies. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * `secure` cookies are only sent over HTTPS. The dashboard runs on plain HTTP at
 * http://127.0.0.1:3000, so forcing it in development would silently discard the
 * cookie and make sign-in appear to succeed and then not — the exact
 * "looks-like-it-worked" failure this codebase keeps hitting.
 *
 * When this is put behind HTTPS (a Cloudflare Tunnel, or the deferred Linode host),
 * set COOKIE_SECURE=1.
 */
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true'

export interface SessionUser {
  id: string
  email: string
  /**
   * Parsed through `parseRole`, so an unrecognised value in the column reads as `viewer`
   * rather than propagating a raw string that some later `=== 'operator'` might not
   * match. The permissive direction is the one this codebase keeps getting wrong.
   */
  role: Role
}

/** SHA-256, hex. The stored form of a token. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Mints a session, stores its hash, and sets the cookie.
 *
 * Returns nothing useful on purpose — the raw token exists only in the cookie and is
 * never logged, returned, or persisted. Anything that wants to know who is signed in
 * asks `currentUser()`.
 */
export async function createSession(userId: string): Promise<void> {
  const raw = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await prisma.session.create({
    data: { tokenHash: hashToken(raw), userId, expiresAt },
  })

  const jar = await cookies()
  jar.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  })
}

/**
 * The signed-in user, or null.
 *
 * Expiry is enforced in the QUERY (`expiresAt: { gt: now }`), not by reading the row
 * and comparing afterwards. An expired session must be unusable even if a later branch
 * forgets to check — and a cookie's own `expires` is a client-side hint the client
 * controls, so it can never be the enforcement point.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (!raw) return null

  const session = await prisma.session.findFirst({
    where: { tokenHash: hashToken(raw), expiresAt: { gt: new Date() } },
    select: { user: { select: { id: true, email: true, role: true } } },
  })

  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email, role: parseRole(session.user.role) }
}

/**
 * The identity to record in `sentBy` and `AuditLog.actor`.
 *
 * Falls back to `env.OPERATOR_NAME`'s old role only for callers with no session — the
 * CLI scripts and the worker, which genuinely have no user. A server action must never
 * reach the fallback: `middleware.ts` refuses unauthenticated requests, and each action
 * re-checks. Returning "operator" for a signed-in request would quietly erase the audit
 * trail the whole change exists to create.
 */
export async function actorName(): Promise<string> {
  const user = await currentUser()
  return user?.email ?? 'operator'
}

/**
 * The signed-in user, or a thrown error.
 *
 * Every mutating server action calls this FIRST, before reading arguments or touching
 * the database. `middleware.ts` already refuses unauthenticated requests, so this is
 * the second layer — and it is not redundant: middleware is a router-level filter and a
 * server action is a POST endpoint. A matcher edit, a config change, or a future Next
 * release that lets one request through must still find the action closed.
 *
 * Throws rather than returning null so a caller cannot accidentally continue on a
 * falsy value. There is no "unauthenticated but proceed anyway" path.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser()
  if (!user) throw new Error('Not signed in.')
  return user
}

/**
 * `requireUser`, and then: may this person CHANGE anything?
 *
 * Every action that sends a DM, arms an account, connects a browser profile, retires a
 * channel or clears a halt calls this instead of `requireUser`. The two are deliberately
 * separate functions rather than a boolean argument — a parameter defaulting to
 * "no role check" is one forgotten argument away from an unprotected mutation, and this
 * codebase already shipped eighteen server actions with nothing in front of them.
 *
 * Throws rather than returning a result, for the same reason `requireUser` does: a caller
 * that ignores a returned `false` still performs the mutation, whereas a throw cannot be
 * ignored by accident. Several actions mutate and then audit, so a check deferred into
 * `audit()` would let the write land and fail afterwards.
 */
export async function requireOperator(): Promise<SessionUser> {
  const user = await requireUser()
  if (!canAct(user.role)) throw new Error(NOT_AN_OPERATOR)
  return user
}

/**
 * Signs out: deletes the session row AND clears the cookie.
 *
 * Both halves matter. Clearing only the cookie leaves a valid row that any copy of the
 * token still opens; deleting only the row leaves a cookie that fails every request
 * with no way for the user to tell why.
 */
export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value

  if (raw) {
    // deleteMany, not delete: a token that is already gone is a successful sign-out,
    // not a 500. Signing out twice must not error.
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(raw) } })
  }
  jar.delete(SESSION_COOKIE)
}

/**
 * Drops expired rows. Called opportunistically on sign-in, not on a schedule.
 *
 * Purely hygiene: `currentUser` already refuses an expired session in its query, so a
 * row left here is inert rather than dangerous.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } })
  return count
}

/**
 * Constant-time string compare for equal-length secrets. Exported for tests and for
 * any future token comparison that does not go through the database.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
