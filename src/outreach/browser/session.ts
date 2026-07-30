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
const CHECKPOINT_PATHS = [
  '/challenge',
  '/accounts/suspended',
  '/accounts/disabled',
  '/accounts/login', // session expired — a login form where a profile was expected
  '/two_factor',
]

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

/** Throws CheckpointError if the current URL is an enforcement or login surface. */
export function assertNoCheckpoint(page: Page): void {
  const url = page.url()
  for (const p of CHECKPOINT_PATHS) {
    if (url.includes(p)) throw new CheckpointError(url, p.replace(/^\//, ''))
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
export async function loggedInAs(page: Page): Promise<string | null> {
  try {
    const res = await page.request.get('https://www.instagram.com/api/v1/accounts/current_user/', {
      headers: { 'x-ig-app-id': '936619743392459' },
    })
    if (!res.ok()) return null
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
