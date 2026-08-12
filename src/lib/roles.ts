/**
 * WHO MAY DO WHAT — the check that did not exist while the dashboard was a local page.
 *
 * ── WHY THIS ARRIVED WITH HOSTING, AND NOT BEFORE ───────────────────────────
 *
 * Auth shipped 2026-08-03 and answered "is this a signed-in person?". It never answered
 * "is this person allowed to send?", because registration is OPEN by Tabish's explicit
 * choice and `sendNow` checks the safety gate rather than who is asking. CLAUDE.md states
 * the consequence plainly: *anyone who registers can DM from `@madaboutmarketingg`,
 * `@bollywoodsocietyy` and `@bollywoodchronicle`*, and what limited that was the
 * `127.0.0.1` bind and nothing else.
 *
 * On 2026-08-08 the bind stops being the limit — the dashboard moves to a public URL as a
 * product other people sign up for. `User` was deliberately shaped to take this column
 * "without a painful migration", and this is that moment.
 *
 * ── TWO ROLES, AND THE DEFAULT IS THE SAFE ONE ──────────────────────────────
 *
 * `viewer`   — read every page. Cannot send, arm, connect, remove or retire.
 * `operator` — everything, subject to every existing safety gate. Roles are ADDITIONAL
 *              to the gate, never a replacement: an operator still cannot cross a
 *              non-overridable stop, and `OVERRIDABLE_BLOCKS` is unchanged.
 *
 * A new account is a `viewer`. That is the direction that fails safe: an account arriving
 * with no explicit grant must not reach a revenue account's Send button. Promotion is a
 * deliberate act, recorded in the audit log.
 *
 * ── AN UNKNOWN ROLE IS NOT AN OPERATOR ──────────────────────────────────────
 *
 * `role` is a String because SQLite has no enums, so the database can hold anything —
 * a typo in a manual UPDATE, a value from a future version, an empty string after a bad
 * migration. Every one of those reads as "not an operator" here. This codebase's
 * signature failure is absence of data hardening into a permissive claim (a dead endpoint
 * read as "logged out", a broken handle read as a run-wide throttle, an unreadable thread
 * read as "no reply"); the same shape with a PERMISSION attached would be worse.
 */

export type Role = 'viewer' | 'operator'

export const ROLES: readonly Role[] = ['viewer', 'operator'] as const

/** The role a brand-new account gets. Read-only, deliberately. */
export const DEFAULT_ROLE: Role = 'viewer'

/**
 * PURE. Anything that is not exactly a known role is treated as the least privileged one.
 * Never throws: a login must not fail because a column holds an unexpected string, but it
 * must also not silently grant more than it should.
 */
export function parseRole(raw: string | null | undefined): Role {
  return raw === 'operator' ? 'operator' : 'viewer'
}

/**
 * May this role take an action that changes something outside the dashboard — sending a
 * DM, arming an account, connecting a browser profile, retiring a channel?
 *
 * Deliberately coarse. A finer permission model is a real design with real questions
 * (may a viewer edit a draft? may they discard one?) and inventing it now would ship
 * guesses. One line separates "can look" from "can act", and it is the line that matters
 * while the risk is that a stranger sends from a revenue account.
 */
export function canAct(role: Role): boolean {
  return role === 'operator'
}

/** What a refused action says. Names the fix, because a refusal that cannot be resolved is a wall. */
export const NOT_AN_OPERATOR =
  'Your account can view this dashboard but not change anything. ' +
  'An operator has to approve you before you can send, connect an account, or arm autopilot.'

/**
 * Is the invite code supplied at signup the right one?
 *
 * ── WHY A SHARED SECRET RATHER THAN AN INVITE TABLE ─────────────────────────
 *
 * Per-address invite rows are better and are not what this needs yet. The property that
 * matters on day one is that the signup form is not a self-service door onto a page with
 * a Send button — and a single env-held code closes that with no schema, no expiry logic
 * and no email delivery. `SIGNUP_INVITE_CODE` lives in the environment exactly like
 * `AUTOPILOT_ENABLED`, and for the same reason: a web page must not be able to widen its
 * own access.
 *
 * NOT constant-time, and that is a considered choice rather than an oversight. This is a
 * shared enrolment token, not a password: it gates account CREATION (which lands a
 * viewer who can do nothing), it is not per-user, and it protects nothing on its own —
 * the role check does that. Adding a timing-safe compare here would imply a guarantee the
 * rest of the design does not make.
 *
 * A MISSING code refuses everything. An unset secret must never mean "no gate", which is
 * the fail-open direction and precisely the mistake `sessionUsable` and `identify()` were
 * both rewritten to avoid.
 */
export function inviteCodeAccepted(supplied: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || expected.trim() === '') return false
  if (!supplied) return false
  return supplied.trim() === expected.trim()
}
