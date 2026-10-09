import { chromium, type BrowserContext, type Page } from 'patchright'
import { ensureProfileDir } from './profile'
import { log } from '@/lib/logger'

/**
 * Launching the account's own Chrome profile.
 *
 * Patchright rather than stock Playwright, because stock Playwright is detectable
 * in ways that have nothing to do with behaviour: `navigator.webdriver` is true in
 * every configuration including CDP-attach, and `Runtime.enable` is emitted
 * per-frame on every navigation. Patchright patches both. Verified 2026-07-30 —
 * and note what was *refuted* in the same pass, so nobody spends time on it again:
 * TLS/JA3/JA4 fingerprinting (Playwright-driven Chrome produces a JA4 identical to
 * Chrome stable), `X-IG-WWW-Claim` "session warmth", and anti-detect browsers.
 *
 * Launch options are deliberately minimal. Patchright's own guidance is that the
 * common "stealth" flags make things worse, because a real Chrome does not run with
 * them:
 *
 *   - no `--disable-blink-features=AutomationControlled` (Patchright handles it;
 *     passing it is itself a signal)
 *   - no custom user agent — the profile's real Chrome UA is correct by definition
 *   - `viewport: null` so the window keeps its real dimensions
 *   - `headless: false`, always. A headless Chrome differs in measurable ways, and
 *     watching the send happen is worth more than the terminal being tidy.
 */

/** Instagram surfaces enforcement at these paths. Seeing one means STOP, never retry. */
const CHECKPOINT_PATHS = ['/challenge', '/accounts/suspended', '/accounts/disabled']

/**
 * A 2FA prompt. ROUTINE, and its own state.
 *
 * This used to sit in CHECKPOINT_PATHS, and `assertNoCheckpoint` runs five times inside
 * a single send — so if Instagram asked for a code at any point, the account was marked
 * CHALLENGED, every pair using it halted, and by design nothing retried. But 2FA is the
 * recommended configuration for these accounts, and a re-prompt means an existing
 * session is being re-verified, not that Instagram has taken action.
 *
 * It is the same conflation already fixed for `/accounts/login` immediately below, and
 * that comment's reasoning applies verbatim: an operator who sees CHALLENGED for routine
 * events learns to dismiss it, and then dismisses the one that matters.
 *
 * Not simply merged into LOGIN_PATHS because the remedy differs — a login form means
 * re-authenticate, a 2FA prompt means enter a code for a session that already exists.
 * Checked BEFORE the login paths, because IG's 2FA URL sits under `/accounts/login/`.
 *
 * `/two_step_verification` was MEASURED, not guessed: on 2026-08-17 a real hand login
 * was prompted at `/accounts/login/two_step_verification?encrypted_context=…` — a URL
 * that matches neither of the paths this list shipped with, while `/accounts/login` IS
 * a substring of it. So the login branch won, and a routine code prompt read as a DEAD
 * SESSION: NotLoggedInError → `sessionInvalid: true` → the gate's no-session stop, with
 * the screen telling the operator to re-login an account that was signed in the whole
 * time. That is the §3.5 false-evidence cascade, reachable from a URL nobody had seen
 * until Instagram served it. The paths here are substrings, so this one entry covers
 * both the bare and the /accounts/login/-prefixed form.
 */
const TWO_FACTOR_PATHS = ['/two_factor', '/accounts/login/two_factor', '/two_step_verification']

/**
 * A login form is NOT a checkpoint, and conflating the two was a real bug.
 *
 * `/accounts/login` was in the list above. But an expired session is the ordinary,
 * expected end of a session's life — it is going to happen to all three accounts
 * eventually — whereas a checkpoint means Instagram has taken action against the
 * account. Treating the first as the second marked accounts CHALLENGED on a routine
 * expiry, which is worse than merely inaccurate: an operator who sees CHALLENGED
 * three times for something that just needed a fresh login learns to dismiss it, and
 * then dismisses the one that matters.
 *
 * Expiry → `NotLoggedInError` → "run pnpm ig:login again", account stays ACTIVE.
 * Checkpoint → `CheckpointError` → halt the account, human must look at it.
 */
const LOGIN_PATHS = ['/accounts/login', '/accounts/signup']

export class CheckpointError extends Error {
  constructor(
    readonly url: string,
    readonly kind: string,
  ) {
    super(`Instagram checkpoint (${kind}) at ${url} — stopped, not retried`)
    this.name = 'CheckpointError'
  }
}

export class NotLoggedInError extends Error {
  constructor(readonly handle: string) {
    super(`Chrome profile for @${handle} is not logged in. Run: pnpm ig:login ${handle}`)
    this.name = 'NotLoggedInError'
  }
}

/**
 * Instagram wants a 2FA code. NOT enforcement — the account is fine, a human just has
 * to enter a code. Kept distinct from NotLoggedInError because the remedy differs: a
 * login form means re-authenticate, this means re-verify a session that already exists.
 */
export class TwoFactorRequiredError extends Error {
  constructor(readonly handle: string) {
    super(
      `@${handle} needs a 2FA code — press Connect and enter it. The account is NOT flagged ` +
        `and nothing was retried.`,
    )
    this.name = 'TwoFactorRequiredError'
  }
}

/**
 * A session cookie exists but the identity lookup could not be made — a network blip, a
 * timeout, Instagram returning something unparseable.
 *
 * Distinct from NotLoggedInError because `loggedInAs` used to swallow every error into
 * `null`, which `assertLoggedInAs` turned into "not logged in, run pnpm ig:login". That
 * told the operator to re-login on a transient failure, and re-logging-in is the action
 * that carries real risk in this design. "I could not ask" is a third answer.
 */
export class IdentityCheckFailedError extends Error {
  constructor(
    readonly handle: string,
    /** Named `detail` rather than `cause`, which collides with Error.cause. */
    readonly detail: string,
  ) {
    super(
      `could not confirm which account @${handle} is logged in as (${detail}) — not sending, ` +
        `and NOT a reason to log in again`,
    )
    this.name = 'IdentityCheckFailedError'
  }
}

export class WrongAccountError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`profile is logged in as @${actual}, expected @${expected} — refusing to send`)
    this.name = 'WrongAccountError'
  }
}

/**
 * Opens the account's own profile directory. The caller MUST close it.
 *
 * `channel: 'chrome'` uses the installed Google Chrome. Bundled Chromium has a
 * distinguishable build and a different UA; Chrome is what a person actually runs.
 */
export async function launchProfile(handle: string): Promise<BrowserContext> {
  const dir = ensureProfileDir(handle)
  log.step('opening Chrome profile', { handle, dir })
  return chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    // Only flags a real person's Chrome would also have. Nothing "stealthy".
    args: ['--no-first-run', '--no-default-browser-check'],
  })
}

export type UrlVerdict = 'ok' | 'checkpoint' | 'needs-login' | 'needs-2fa'

/**
 * Does `pattern` (e.g. `/accounts/login`) occur in this URL's PATH as whole segments?
 *
 * ── WHOLE SEGMENTS, NOT A SUBSTRING (2026-10-09) ────────────────────────────
 *
 * These lists were tested with `url.includes(p)`, and a profile URL is
 * `instagram.com/<handle>/`. Handles are `[A-Za-z0-9._]`, so `/challenge` was a substring of
 * `/challengemtv/` and `/two_factor` of `/two_factor_fan/`: the profile loading was read as a
 * CHECKPOINT, the account was marked CHALLENGED, the fleet breaker halted every account for a
 * day, and the draft stayed READY to trip it again the moment a person cleared it — all on
 * the strength of a recipient's name. Matching whole segments anywhere in the path keeps the
 * real cases (`/challenge/`, `/accounts/login/two_step_verification`) and cannot match a
 * handle that merely begins with the word.
 *
 * A URL that will not parse falls back to the old substring test — the cautious direction,
 * because a checkpoint missed is retried into, and a checkpoint invented only pauses.
 */
function pathHas(url: string, pattern: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return url.includes(pattern)
  }
  const segs = path.split('/').filter(Boolean)
  const want = pattern.split('/').filter(Boolean)
  for (let i = 0; i + want.length <= segs.length; i++) {
    if (want.every((w, k) => segs[i + k] === w)) return true
  }
  return false
}

/** Pure, so every verdict is testable without a browser. */
export function classifyUrl(url: string): UrlVerdict {
  for (const p of CHECKPOINT_PATHS) if (pathHas(url, p)) return 'checkpoint'
  for (const p of TWO_FACTOR_PATHS) if (pathHas(url, p)) return 'needs-2fa'
  for (const p of LOGIN_PATHS) if (pathHas(url, p)) return 'needs-login'
  return 'ok'
}

/**
 * Enforcement that renders in the page rather than changing the URL.
 *
 * `assertNoCheckpoint` only ever looked at `page.url()`. But Instagram's most common
 * response to DM activity — "Action Blocked", "We restrict certain activity" — is a
 * MODAL on the current URL. That does not change the path, so it was not detected: the
 * send carried on, failed some later check, and was recorded as an ordinary retryable
 * failure with the account left ACTIVE and eligible next slot. That is retrying into a
 * block.
 *
 * WHERE THIS IS MATCHED, AND WHY IT IS NO LONGER THE WHOLE PAGE.
 *
 * It was `page.locator('body').textContent()`, and this check runs on the DM page —
 * so the text being searched INCLUDES THE CONVERSATION. A prospect replying "haha
 * action blocked" would have marked a revenue account CHALLENGED and halted every pair
 * using it. Enforcement is something Instagram renders in its own chrome, so it is read
 * from Instagram's own chrome: dialogs, alerts and status regions. Other people's words
 * are not evidence about our account.
 *
 * The full-page case is not lost: a suspension or a disabled account lands on
 * `/accounts/suspended` or `/accounts/disabled`, both already in CHECKPOINT_PATHS above,
 * and the URL check runs first. So URL covers the page-level notice and this covers the
 * modal, which is a clean split rather than a narrowing.
 *
 * NOT VERIFIED against a real enforcement modal — producing one means getting an account
 * restricted. The role selectors are the ones Meta's design system uses for modals, and
 * the list is deliberately generous (four roles, not one) for that reason.
 */
const ENFORCEMENT_PHRASES = [
  'action blocked',
  'we restrict certain activity',
  'temporarily blocked',
  'your account has been disabled',
  'please wait a few minutes before you try again',
  'message could not be sent',
] as const

/**
 * REMOVED 2026-08-04: `'try again later'`.
 *
 * It is ordinary Instagram copy — "Something went wrong. Try again later." — matched
 * against the whole page twice per send. A false positive here marks a revenue account
 * CHALLENGED and halts every pair using it, and the comment beside CHECKPOINT_PATHS
 * already warns where that leads: an operator who sees CHALLENGED for routine events
 * learns to dismiss it, and then dismisses the one that matters.
 *
 * Kept as a named constant rather than deleted so nobody re-adds it as an obvious
 * omission. The specific rate-limit sentence above ("please wait a few minutes before
 * you try again") covers the case this was reaching for, without the generic half.
 */
export const DELIBERATELY_NOT_AN_ENFORCEMENT_PHRASE = 'try again later'

/** Where Instagram renders its own notices. Never the whole page — see above. */
const ENFORCEMENT_CONTAINERS = ['[role="dialog"]', '[role="alertdialog"]', '[role="alert"]', '[role="status"]']

export function looksLikeEnforcement(pageText: string): boolean {
  const t = pageText.replace(/\s+/g, ' ').trim().toLowerCase()
  if (t.length === 0) return false
  return ENFORCEMENT_PHRASES.some((p) => t.includes(p))
}

/**
 * The text of Instagram's own dialogs and alerts, concatenated. Empty when there are
 * none, which is the ordinary case.
 */
export async function enforcementSurfaceText(page: Page): Promise<string> {
  const parts: string[] = []
  for (const selector of ENFORCEMENT_CONTAINERS) {
    const loc = page.locator(selector)
    const count = await loc.count().catch(() => 0)
    // Bounded: a page with hundreds of matching nodes is a DOM change, not a dialog,
    // and reading all of them would reintroduce whole-page matching by the back door.
    for (let i = 0; i < Math.min(count, 6); i++) {
      parts.push((await loc.nth(i).textContent().catch(() => '')) ?? '')
    }
  }
  return parts.join(' \n ')
}

/**
 * Throws if the current URL is an enforcement surface (CheckpointError — halt the
 * account), a 2FA prompt (TwoFactorRequiredError — a human enters a code and the
 * account stays ACTIVE), or a login form (NotLoggedInError — just log in again).
 *
 * `handle` is only needed for the message; it is optional so existing mid-send call
 * sites can stay terse where the account is obvious from context.
 */
export function assertNoCheckpoint(page: Page, handle?: string): void {
  const url = page.url()
  switch (classifyUrl(url)) {
    case 'checkpoint': {
      const kind = CHECKPOINT_PATHS.find((p) => url.includes(p))!.replace(/^\//, '')
      throw new CheckpointError(url, kind)
    }
    case 'needs-2fa':
      throw new TwoFactorRequiredError(handle ?? 'this account')
    case 'needs-login':
      throw new NotLoggedInError(handle ?? 'this account')
    case 'ok':
      return
  }
}

/**
 * The URL check PLUS the in-page check. Use this wherever a page has just been navigated
 * or acted upon; `assertNoCheckpoint` alone answers only half the question.
 *
 * Async because it has to read the page, which is why the cheap URL-only variant still
 * exists for the navigation steps that run before any action.
 */
export async function assertNoEnforcement(page: Page, handle?: string): Promise<void> {
  assertNoCheckpoint(page, handle)
  const text = await enforcementSurfaceText(page)
  if (looksLikeEnforcement(text)) {
    throw new CheckpointError(page.url(), 'in-page enforcement notice')
  }
}

/**
 * Which account this profile is actually logged in as, or null if logged out.
 *
 * Uses the same first-party endpoint instagram.com's own web app calls, issued
 * through the page's request context so it carries exactly the cookies and headers
 * the app would send. This does NOT contradict decision 4 ("detection never uses a
 * login") — that rule keeps *campaign detection* anonymous so a feed parser can
 * never escalate an IP risk into an account risk. This is the send path, which is
 * authenticated by definition, and its job here is the opposite of risky: making
 * sure we do not send from the wrong account.
 */
export async function sessionUserId(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies('https://www.instagram.com')
  const raw = cookies.find((c) => c.name === 'ds_user_id')?.value
  // Numeric-only: this value is interpolated into a URL below.
  return raw && /^\d{1,25}$/.test(raw) ? raw : null
}

export type IdentityResult =
  | { kind: 'logged-in'; username: string }
  | { kind: 'logged-out' }
  | { kind: 'unknown'; detail: string }

/** The web app's own app id. Used by every first-party call below. */
const IG_APP_ID = '936619743392459'

/**
 * What ONE identity response established. `no-answer` is the whole point of this type.
 *
 * ── THE BUG THIS SHAPE EXISTS TO REMOVE (2026-08-06) ──────────────────────────
 *
 * This function used to be four lines inside `identify`:
 *
 *     if (!res.ok() || !contentType.includes('json')) return { kind: 'logged-out' }
 *
 * MEASURED against the live @tabishmukaddam1 profile, signed in, page title
 * "(1) Instagram" — an unread-DM badge only a logged-in session renders:
 *
 *     GET www.instagram.com/api/v1/users/2871102548/info/
 *       → HTTP 200, text/html, 627,698 bytes   (the SPA shell)
 *
 * So the endpoint died, and a dead endpoint was read as a POSITIVE CLAIM ABOUT THE
 * ACCOUNT. That claim then travelled the whole system: Connect polled forever, every
 * send threw `NotLoggedInError`, and §3.5 wrote `sessionInvalidAt` — recording a LIVE
 * session as dead, which halts the account through the gate's `no-session` stop and
 * tells the operator to perform the riskiest act in this design (a re-login) on
 * evidence nobody gathered.
 *
 * It is the third appearance of this shape here: `/accounts/current_user/` returning
 * the SPA shell, `resolveBrand` reading one broken handle as a run-wide throttle, and
 * now this. **"I could not ask" must never harden into "the answer is no."**
 *
 * Pure, and separated from the request for the reason `classifyProfile` was: the logic
 * lived inside an `await fetch()` and therefore had no test in either direction.
 */
export type IdentityReading =
  | { kind: 'logged-in'; username: string }
  | { kind: 'logged-out' }
  | { kind: 'no-answer'; detail: string }

/** Instagram's own words for "this request is not authenticated". */
const LOGGED_OUT_MESSAGES = ['login_required', 'not_authenticated']

export function readIdentityResponse(status: number, contentType: string, body: string): IdentityReading {
  const parsed: unknown = contentType.includes('json')
    ? (() => {
        try {
          return JSON.parse(body)
        } catch {
          return undefined
        }
      })()
    : undefined

  const obj = (parsed ?? {}) as {
    message?: unknown
    status?: unknown
    user?: { username?: unknown }
    form_data?: { username?: unknown }
  }

  /**
   * The ONLY positive logged-out answers a response can give: Instagram refusing the
   * request as unauthenticated. A 401/403 is a statement about the session. HTML is not —
   * that is the whole lesson above.
   */
  if (status === 401 || status === 403) return { kind: 'logged-out' }
  const message = typeof obj.message === 'string' ? obj.message.toLowerCase() : ''
  if (LOGGED_OUT_MESSAGES.some((m) => message.includes(m))) return { kind: 'logged-out' }

  /**
   * A username. Two shapes because two endpoints serve it, and `form_data` also carries
   * this account's own email and phone — deliberately ignored, we asked one question.
   */
  const raw = obj.user?.username ?? obj.form_data?.username
  if (typeof raw === 'string' && raw.length > 0) return { kind: 'logged-in', username: raw.toLowerCase() }

  /**
   * Everything else is an unanswered question, including `status: 'fail'` with HTTP 200 —
   * measured on i.instagram.com, which returned
   * `{"message":"…something went wrong…","status_code":"200","status":"fail"}`. JSON, an OK
   * status, and no answer in it. A content-type check alone waves that straight through.
   */
  return {
    kind: 'no-answer',
    detail: `HTTP ${status} ${contentType || 'no content-type'} (${body.length}b)`,
  }
}

/**
 * Positive evidence of being logged out, taken from the PAGE rather than an endpoint.
 *
 * Needed because a revoked session keeps its `sessionid` on disk, so "a session cookie
 * exists but nothing answered" is genuinely ambiguous between a dead SESSION and a dead
 * ENDPOINT. §3.5 has to keep catching the first without inventing the second, so the
 * tie-break is an observation of what Instagram is rendering.
 *
 * MEASURED 2026-08-06 at https://www.instagram.com/ on both profiles:
 *   signed in  → 0 password inputs, title "(1) Instagram"
 *   logged out → 1 password input,  title "Instagram"
 *
 * And the near miss worth recording, because it was the obvious guess: on Instagram's
 * current DOM `input[name="password"]` and `form#loginForm` are **0 in both states**. A
 * check built on either would never fire, and would have looked perfectly reasonable.
 *
 * A count rather than a Page, so both directions are testable without a browser.
 */
export function looksLoggedOut(passwordFieldCount: number): boolean {
  return passwordFieldCount > 0
}

/**
 * Where "who am I" is asked, in order, and why there is more than one.
 *
 * There is no documented endpoint for this on instagram.com web, both of these are
 * first-party calls the app itself makes, and one has already died under us. A single
 * source of truth for identity is a single point of failure for every send.
 *
 * `web_form_data` is FIRST because it is the one measured working today (2026-08-06,
 * 200 `application/json`, `form_data.username`, with and without an `x-csrftoken`
 * header). `users/<id>/info/` is kept behind it rather than deleted: it worked on
 * 2026-07-31, it may come back, and a second opinion costs a request only on the path
 * where the first already failed.
 */
const IDENTITY_ENDPOINTS: Array<{ name: string; url: (userId: string) => string }> = [
  { name: 'accounts/edit/web_form_data', url: () => 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/' },
  { name: 'users/<id>/info', url: (id) => `https://www.instagram.com/api/v1/users/${id}/info/` },
]

/**
 * Who is this profile logged in as — with "I could not tell" as a distinct answer.
 *
 * The three verdicts are load-bearing and each needs its own evidence:
 *   `logged-in`   a first-party endpoint named the account
 *   `logged-out`  no session cookie at all, Instagram refused the request as
 *                 unauthenticated, or the page is rendering a login form
 *   `unknown`     a session exists and nothing would answer. NEVER a verdict about
 *                 the account — see `readIdentityResponse` for what that cost.
 */
export async function identify(page: Page): Promise<IdentityResult> {
  const userId = await sessionUserId(page)
  // Positive evidence: there is no session here to be signed in with.
  if (!userId) return { kind: 'logged-out' }

  const unanswered: string[] = []
  for (const endpoint of IDENTITY_ENDPOINTS) {
    try {
      const res = await page.request.get(endpoint.url(userId), { headers: { 'x-ig-app-id': IG_APP_ID } })
      const reading = readIdentityResponse(res.status(), res.headers()['content-type'] ?? '', await res.text())
      if (reading.kind === 'logged-in') return reading
      if (reading.kind === 'logged-out') return { kind: 'logged-out' }
      unanswered.push(`${endpoint.name} → ${reading.detail}`)
    } catch (err) {
      unanswered.push(`${endpoint.name} → threw ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Nothing answered. Ask the page, which can still supply positive logged-out evidence —
   * and if it cannot, say so rather than choosing a verdict.
   */
  const passwordFields = await page
    .locator('input[type="password"]')
    .count()
    .catch(() => 0)
  if (looksLoggedOut(passwordFields)) return { kind: 'logged-out' }

  return { kind: 'unknown', detail: unanswered.join('; ') }
}

/**
 * Backwards-compatible wrapper: `null` means "not confirmed as anyone". `connect.ts`
 * uses this, where the three-way distinction is not needed — an unknown there just keeps
 * the poll waiting, which is correct.
 */
export async function loggedInAs(page: Page): Promise<string | null> {
  const r = await identify(page)
  return r.kind === 'logged-in' ? r.username : null
}

/**
 * Confirms the profile is logged in as exactly the expected account.
 *
 * Both failure modes are hard stops rather than warnings. Sending from the wrong
 * account would put an unrelated business page into a conversation it has no
 * context for, and sending from a logged-out profile cannot work at all — but would
 * happily type a pitch into a login form if nothing checked.
 */
export async function assertLoggedInAs(page: Page, expected: string): Promise<void> {
  const r = await identify(page)
  // Three outcomes, three errors. Collapsing "could not ask" into "not logged in" sent
  // the operator to re-login for a network blip.
  if (r.kind === 'unknown') throw new IdentityCheckFailedError(expected, r.detail)
  if (r.kind === 'logged-out') throw new NotLoggedInError(expected)
  if (r.username !== expected.toLowerCase()) throw new WrongAccountError(expected, r.username)
}
