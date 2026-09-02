'use server'

import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { createSession, destroySession, pruneExpiredSessions } from '@/lib/session'
import { emailProblem, hashPassword, normaliseEmail, passwordProblem, verifyPassword } from '@/lib/password'
import { safeNext } from '@/lib/safe-next'
import { inviteCodeAccepted, type Role } from '@/lib/roles'
import { env } from '@/lib/env'

/**
 * Sign up, sign in, sign out.
 *
 * Kept OUT of `actions.ts` on purpose. Every action in that file is a mutation that
 * requires a session; these three are the only ones that must work WITHOUT one, and
 * `middleware.ts` treats their pages as the sole public paths. Mixing them in one file
 * would make "which of these needs auth?" a per-function question, and that is the
 * question the 18 exported actions got wrong.
 *
 * SIGNUP IS NO LONGER OPEN — changed 2026-08-08, when this stopped being a page bound to
 * 127.0.0.1 and became a product on a public URL.
 *
 * The old note here read: *"OPEN SIGNUP is deliberate — Tabish, 2026-08-03, after the
 * exposure was stated twice. A new account can immediately send DMs from every connected
 * Instagram account… What limits that today is the 127.0.0.1 bind, nothing here."* That
 * was a defensible trade while the bind WAS the access control. The moment the bind goes,
 * the same sentence describes a vulnerability rather than a decision, and CLAUDE.md
 * already named the fix: *"Before this is reachable from anywhere else, add roles — view
 * on signup, send on approval."*
 *
 * Two gates now, and they are independent on purpose:
 *   1. an invite code from the environment, to create an account at all;
 *   2. a `role`, which decides whether that account may change anything.
 *
 * Passing (1) grants a VIEWER. Someone who guesses or is handed the code still cannot
 * send from a revenue account. See src/lib/roles.ts.
 */

export interface AuthResult {
  ok: boolean
  message: string
}

/**
 * `redirect()` with a runtime-computed path.
 *
 * `typedRoutes: true` in next.config.ts makes `redirect()` accept only statically known
 * routes, which is a genuine compile-time check worth keeping — it is what would catch
 * a typo'd literal elsewhere. It cannot type a value derived from a query parameter, so
 * the cast is confined to this one helper, immediately after `safeNext` has established
 * the value is a same-origin path. Casting at each call site instead would spread the
 * assertion across three places and make it easy to skip the sanitiser at one of them.
 */
function redirectToPath(path: string): never {
  redirect(path as Parameters<typeof redirect>[0])
}

/**
 * A real scrypt hash of a random value, so verifying against it costs what a real
 * verification costs. Generated once at module load; its plaintext is unknowable, so it
 * cannot accidentally become a valid password.
 *
 * Format matches `hashPassword` exactly — a malformed string would be rejected by
 * `verifyPassword` early and reintroduce the timing difference this exists to remove.
 */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'ZmFrZS1oYXNoLXdob3NlLXBsYWludGV4dC1pcy11bmtub3du'

export async function signUp(
  email: string,
  password: string,
  next?: string,
  inviteCode?: string,
): Promise<AuthResult> {
  /**
   * THE INVITE GATE, CHECKED FIRST — before the email is looked up, before a password is
   * hashed, before anything is written.
   *
   * Registration was OPEN by Tabish's explicit choice on 2026-08-03, and that was a
   * reasonable trade while the dashboard was bound to 127.0.0.1: the bind was the access
   * control. On 2026-08-08 it moves to a public URL, and CLAUDE.md's own sentence becomes
   * the vulnerability rather than a note — *anyone who registers can DM from
   * `@madaboutmarketingg`, `@bollywoodsocietyy` and `@bollywoodchronicle`*.
   *
   * An unset code refuses everything. "No secret configured" must never mean "no gate".
   */
  if (!inviteCodeAccepted(inviteCode, env.SIGNUP_INVITE_CODE)) {
    return {
      ok: false,
      message: env.SIGNUP_INVITE_CODE
        ? 'That invite code is not right. Ask whoever runs this dashboard for one.'
        : 'New accounts are closed on this deployment.',
    }
  }

  const emailIssue = emailProblem(email)
  if (emailIssue) return { ok: false, message: emailIssue }

  const passwordIssue = passwordProblem(password)
  if (passwordIssue) return { ok: false, message: passwordIssue }

  const normalised = normaliseEmail(email)

  const existing = await prisma.user.findUnique({ where: { email: normalised }, select: { id: true } })
  if (existing) {
    /**
     * Says plainly that the address is taken.
     *
     * Enumeration is a real consideration and it is the wrong trade HERE: registration
     * is open, so anyone can discover the same fact by trying to register, and a vague
     * "something went wrong" would leave a legitimate operator unable to tell a taken
     * address from a broken form. Sign-IN below is where the generic message matters.
     */
    return { ok: false, message: 'An account with that email already exists. Sign in instead.' }
  }

  /**
   * EVERY ACCOUNT IS AN OPERATOR — Tabish, 2026-09-02, verbatim: "All users must be at same
   * high level access (chuck operator, viewer, everyone has utmost access)."
   *
   * This replaces "first account bootstraps operator, everyone after is a viewer". The
   * trade is stated once and recorded as his: whoever holds the invite code gets the
   * autopilot switch, retirement, templates and role controls the moment they register.
   * The invite code (`SIGNUP_INVITE_CODE`, unset = signup CLOSED) is now the entire gate,
   * so treat it as a credential. The role column and `requireOperator` stay — reversing
   * this is one line here plus demotions in the Team panel.
   */
  const role: Role = 'operator'

  const user = await prisma.user.create({
    data: { email: normalised, passwordHash: await hashPassword(password), role },
    select: { id: true, email: true, role: true },
  })

  await prisma.auditLog.create({
    data: {
      actor: user.email,
      action: 'auth.signup',
      entity: `User:${user.email}`,
      detail: 'created as an operator — all users share full access (Tabish, 2026-09-02)',
    },
  })

  await createSession(user.id)
  redirectToPath(safeNext(next))
}

export async function signIn(email: string, password: string, next?: string): Promise<AuthResult> {
  const normalised = normaliseEmail(email)
  const user = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true, email: true, passwordHash: true },
  })

  /**
   * One message for "no such account" and for "wrong password", and the work is done in
   * both cases.
   *
   * Returning early on an unknown email would answer "does this address have an
   * account?" by TIMING — no scrypt call is ~100ms faster, which is trivially
   * measurable. So a missing user is verified against a dummy hash to spend the same
   * time. This is the mirror of the sign-up decision above: there, enumeration is
   * unavoidable and clarity wins; here it is avoidable and costs nothing.
   */
  const hash = user?.passwordHash ?? DUMMY_HASH
  const valid = await verifyPassword(password, hash)

  if (!user || !valid) {
    return { ok: false, message: 'Wrong email or password.' }
  }

  await pruneExpiredSessions()
  await createSession(user.id)

  await prisma.auditLog.create({
    data: { actor: user.email, action: 'auth.signin', entity: `User:${user.email}`, detail: null },
  })

  redirectToPath(safeNext(next))
}

export async function signOut(): Promise<void> {
  await destroySession()
  redirect('/sign-in')
}
