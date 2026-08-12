import type { BrowserContext, Page } from 'patchright'
import { launchProfile, identify } from './session'
import { profileStatus } from './profile'
import { log } from '@/lib/logger'

/**
 * Connecting an account from the dashboard instead of a terminal.
 *
 * `pnpm ig:login` blocks on a readline prompt — fine for a developer, useless for a
 * web page. The same flow is split into three steps the browser can drive:
 *
 *   start  → open the account's Chrome profile at instagram.com, leave it open
 *   poll   → "are you logged in yet?", asked every few seconds by the page
 *   finish → on success, close the context (which flushes cookies to disk) and record
 *
 * Everything that made the terminal version safe is unchanged. The human still types
 * the password into Chrome's own form; nothing here reads, stores or transmits it.
 * The only difference is who asks "done yet?" — a prompt, or a poll.
 *
 * The open context lives in a module-level Map because it must outlive the request
 * that created it. That is safe here because this runs as a single local Node
 * process (`next start`, one worker, one machine). It would NOT survive a
 * multi-process deployment, and it does not survive a dev-server hot reload — in
 * both cases the poll reports "no connection in progress" and the user starts again,
 * which is the correct failure rather than a silent one.
 */

interface ConnectSession {
  handle: string
  context: BrowserContext
  page: Page
  startedAt: number
  /** Consecutive polls where a session existed and nothing would say whose. */
  unresolved: number
}

const sessions = new Map<string, ConnectSession>()

/** A browser window left open forever is its own hazard. */
const MAX_AGE_MS = 20 * 60_000

/**
 * How many "I cannot tell whose session this is" polls before saying so out loud.
 *
 * At 2.5s per poll this is about 25 seconds. It exists because the alternative was
 * measured on 2026-08-06: the identity endpoint had died, `identify` reported logged-out
 * for a visibly signed-in account, and Connect sat on "Waiting for you to log in…" until
 * the 20-minute sweep closed the window — a control that could not succeed, telling the
 * operator the fault was theirs. A check that cannot pass must SAY it cannot pass, and
 * the useful information is which lookup failed and how.
 */
const MAX_UNRESOLVED_POLLS = 10

export type ConnectState =
  | { state: 'opening' }
  | { state: 'waiting'; message: string }
  /**
   * `verified` distinguishes PROOF from a cookie. True only when `loggedInAs` resolved
   * the session against Instagram and it matched the expected handle — the strength of
   * claim that may clear a `sessionInvalidAt` mark. The page-closed fallback reports
   * `connected` from a cookie on disk with no identity check, and that path once
   * silently cleared a CHALLENGED halt; it must not clear a dead-session mark either.
   */
  | { state: 'connected'; handle: string; verified: boolean }
  | { state: 'wrong-account'; actual: string; expected: string }
  | { state: 'closed'; message: string }
  | { state: 'error'; message: string }

/**
 * Opens the account's own Chrome profile at instagram.com and returns immediately.
 * The window stays open for the human to log in.
 */
export async function startConnect(handle: string): Promise<ConnectState> {
  await cancelConnect(handle) // never two windows on one profile — Chrome locks it

  try {
    const context = await launchProfile(handle)
    const page = context.pages()[0] ?? (await context.newPage())
    sessions.set(handle, { handle, context, page, startedAt: Date.now(), unresolved: 0 })

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const who = await identify(page)
    // Already logged in from a previous session — nothing for the human to do.
    if (who.kind === 'logged-in') {
      if (who.username === handle.toLowerCase()) {
        await finish(handle)
        return { state: 'connected', handle, verified: true }
      }
      return { state: 'wrong-account', actual: who.username, expected: handle }
    }

    log.step('connect window opened', { handle })
    /**
     * `unknown` must not be dressed as "log in" — it is the state where a session exists
     * and Instagram would not say whose, and telling the operator to log in implies the
     * fault is theirs. The window stays open and the poll keeps trying, bounded by
     * MAX_UNRESOLVED_POLLS, because the answer may simply be a moment late.
     */
    return who.kind === 'unknown'
      ? { state: 'waiting', message: 'Chrome is open. This account looks signed in — confirming with Instagram…' }
      : { state: 'waiting', message: 'Log in in the Chrome window that just opened.' }
  } catch (err) {
    await cancelConnect(handle)
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** Asked every few seconds by the dashboard while the window is open. */
export async function pollConnect(handle: string): Promise<ConnectState> {
  const s = sessions.get(handle)
  if (!s) {
    /**
     * No window open. A session cookie on disk means a previous login succeeded, but it
     * does NOT say which account — so this cannot report a verified connection. It used
     * to, and combined with `hasSession` matching `ds_user_id` as well as `sessionid`
     * that let a stale cookie read as "connected", skipping the wrong-account guard and
     * (via checkConnect) silently clearing a CHALLENGED halt. Report it as unverified.
     */
    return profileStatus(handle).hasSession
      ? { state: 'closed', message: 'A session is already stored for this account. Press Connect to re-verify it.' }
      : { state: 'closed', message: 'No connection in progress. Press Connect to start.' }
  }

  if (Date.now() - s.startedAt > MAX_AGE_MS) {
    await cancelConnect(handle)
    return { state: 'closed', message: 'Timed out after 20 minutes and closed the window. Press Connect to retry.' }
  }

  // The human closing the Chrome window is a legitimate cancel, not an error.
  if (s.page.isClosed()) {
    // A cookie on disk, no identity check — connected but NOT verified.
    const recovered = profileStatus(handle).hasSession
    await cancelConnect(handle)
    return recovered
      ? { state: 'connected', handle, verified: false }
      : { state: 'closed', message: 'The Chrome window was closed before login finished.' }
  }

  try {
    const who = await identify(s.page)
    if (who.kind === 'logged-in') {
      if (who.username === handle.toLowerCase()) {
        await finish(handle)
        return { state: 'connected', handle, verified: true }
      }
      return { state: 'wrong-account', actual: who.username, expected: handle }
    }

    /**
     * A session cookie with no resolvable username is a THIRD state, and collapsing
     * it into "still waiting" is what made this spin forever once already: the
     * identity lookup was broken, so a fully logged-in account polled indefinitely
     * with the UI cheerfully saying "waiting for you to log in". Whenever the answer
     * is "I cannot tell", say so instead of implying the user has not acted.
     *
     * It then happened AGAIN on 2026-08-06 for a different reason — the endpoint went
     * from broken to dead — which is why saying it is no longer enough. After
     * MAX_UNRESOLVED_POLLS the poll stops being hopeful and reports what actually failed,
     * because an operator cannot act on "confirming…" repeated for twenty minutes.
     *
     * The window is deliberately LEFT OPEN: the human may be part-way through a 2FA code,
     * and closing it would throw away a login in progress. The sweeper still collects it.
     */
    if (who.kind === 'unknown') {
      s.unresolved += 1
      if (s.unresolved >= MAX_UNRESOLVED_POLLS) {
        return {
          state: 'error',
          message:
            `This profile is signed in, but Instagram would not confirm which account — so nothing ` +
            `will send from it until that is fixed. The Chrome window is still open, and this is a ` +
            `fault here rather than anything you did. Lookups tried: ${who.detail}`,
        }
      }
      return { state: 'waiting', message: 'Signed in — confirming which account with Instagram…' }
    }

    s.unresolved = 0
    return { state: 'waiting', message: 'Waiting for you to log in…' }
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Closes the context. This is not just tidiness — closing is what flushes cookies
 * and device identifiers to disk, so a session that is never closed is a session
 * that may not survive.
 */
async function finish(handle: string): Promise<void> {
  const s = sessions.get(handle)
  sessions.delete(handle)
  if (!s) return
  try {
    await s.context.close()
  } catch {
    /* already gone */
  }
  log.info('account connected', { handle })
}

export async function cancelConnect(handle: string): Promise<void> {
  await finish(handle)
}

/** True while a Chrome window is open for this handle. */
export function isConnecting(handle: string): boolean {
  return sessions.has(handle)
}

/**
 * Close abandoned Connect windows.
 *
 * `MAX_AGE_MS` was only enforced when `pollConnect` was called, so closing the dashboard
 * tab with a window open left Chrome running indefinitely, holding the lock on that
 * account's profile directory. Every later send for it then failed to launch until
 * somebody noticed. A timeout that only fires while someone is watching is not a timeout.
 */
const SWEEP_INTERVAL_MS = 60_000

const sweeper = setInterval(() => {
  void (async () => {
    for (const [handle, s] of [...sessions]) {
      if (Date.now() - s.startedAt > MAX_AGE_MS) {
        log.warn('closing an abandoned connect window', {
          handle,
          ageMinutes: Math.round((Date.now() - s.startedAt) / 60_000),
        })
        await cancelConnect(handle)
      }
    }
  })()
}, SWEEP_INTERVAL_MS)
sweeper.unref?.()
