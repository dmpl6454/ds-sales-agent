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
 */
const TWO_FACTOR_PATHS = ['/two_factor', '/accounts/login/two_factor']

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

/** Pure, so every verdict is testable without a browser. */
export function classifyUrl(url: string): UrlVerdict {
  for (const p of CHECKPOINT_PATHS) if (url.includes(p)) return 'checkpoint'
  for (const p of TWO_FACTOR_PATHS) if (url.includes(p)) return 'needs-2fa'
  for (const p of LOGIN_PATHS) if (url.includes(p)) return 'needs-login'
  return 'ok'
}

/**
 * Enforcement that renders in the page rather than changing the URL.
 *
 * `assertNoCheckpoint` only ever looked at `page.url()`. But Instagram's most common
 * response to DM activity — "Action Blocked", "We restrict certain activity" — is a
 * MODAL on the current URL, as is a suspension notice on a profile page. None of those
 * change the path, so none were detected: the send carried on, failed some later check,
 * and was recorded as an ordinary retryable failure. The account stayed ACTIVE and
 * eligible for the next slot, which is retrying into a block — the one thing the
 * checkpoint rule exists to prevent.
 *
 * Phrases are matched loosely on normalised text, and kept narrow and specific on
 * purpose: a false positive halts a healthy revenue account, so this must never match
 * ordinary conversation. Everything here is enforcement language, not chat.
 */
const ENFORCEMENT_PHRASES = [
  'action blocked',
  'we restrict certain activity',
  'temporarily blocked',
  'your account has been disabled',
  'try again later',
  'please wait a few minutes before you try again',
  'message could not be sent',
] as const

export function looksLikeEnforcement(pageText: string): boolean {
  const t = pageText.replace(/\s+/g, ' ').trim().toLowerCase()
  if (t.length === 0) return false
  return ENFORCEMENT_PHRASES.some((p) => t.includes(p))
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
  const text = (await page.locator('body').textContent().catch(() => '')) ?? ''
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

export async function loggedInAs(page: Page): Promise<string | null> {
  try {
    /**
     * Two steps, because there is no single endpoint that answers "who am I" on
     * instagram.com web.
     *
     * The obvious-looking `/api/v1/accounts/current_user/` DOES NOT WORK, and it
     * fails in the worst possible way. Measured 2026-07-31 against a genuinely
     * logged-in profile: it returns **HTTP 200 with `text/html`** — the SPA shell,
     * because it is a mobile-API path that www does not serve. So every check
     * against it returned null, for logged-in and logged-out sessions alike.
     *
     * That was not a cosmetic bug. `assertLoggedInAs` runs before every send, so
     * a fully connected account would have been reported "not logged in" and no
     * message could ever have been delivered. The dashboard's Connect button
     * polling forever is the same fault, just the visible end of it.
     *
     * What does work, verified on the same profile: `ds_user_id` from the session
     * cookie, resolved through `/api/v1/users/{id}/info/`, which returns
     * `application/json` with `user.username`. The cookie establishes that a
     * session exists at all; the lookup establishes whose it is. Both matter —
     * sending from the wrong account is its own failure.
     */
    const userId = await sessionUserId(page)
    if (!userId) return null

    const res = await page.request.get(`https://www.instagram.com/api/v1/users/${userId}/info/`, {
      headers: { 'x-ig-app-id': '936619743392459' },
    })

    // Content type, not just status: logged out, Instagram serves the login page
    // with HTTP 200 and HTML rather than a 4xx.
    const contentType = res.headers()['content-type'] ?? ''
    if (!res.ok() || !contentType.includes('json')) return null

    const body = (await res.json()) as { user?: { username?: string } }
    return body.user?.username?.toLowerCase() ?? null
  } catch {
    return null
  }
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
  const actual = await loggedInAs(page)
  if (actual === null) throw new NotLoggedInError(expected)
  if (actual !== expected.toLowerCase()) throw new WrongAccountError(expected, actual)
}
