import type { BrowserContext, Page } from 'patchright'
import { launchProfile, loggedInAs, sessionUserId } from './session'
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
}

const sessions = new Map<string, ConnectSession>()

/** A browser window left open forever is its own hazard. */
const MAX_AGE_MS = 20 * 60_000

export type ConnectState =
  | { state: 'opening' }
  | { state: 'waiting'; message: string }
  | { state: 'connected'; handle: string }
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
    sessions.set(handle, { handle, context, page, startedAt: Date.now() })

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Already logged in from a previous session — nothing for the human to do.
    const already = await loggedInAs(page)
    if (already === handle.toLowerCase()) {
      await finish(handle)
      return { state: 'connected', handle }
    }
    if (already) {
      return { state: 'wrong-account', actual: already, expected: handle }
    }

    log.step('connect window opened', { handle })
    return { state: 'waiting', message: 'Log in in the Chrome window that just opened.' }
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
    const recovered = profileStatus(handle).hasSession
    await cancelConnect(handle)
    return recovered
      ? { state: 'connected', handle }
      : { state: 'closed', message: 'The Chrome window was closed before login finished.' }
  }

  try {
    const who = await loggedInAs(s.page)
    if (who === handle.toLowerCase()) {
      await finish(handle)
      return { state: 'connected', handle }
    }
    if (who) return { state: 'wrong-account', actual: who, expected: handle }

    /**
     * A session cookie with no resolvable username is a THIRD state, and collapsing
     * it into "still waiting" is what made this spin forever once already: the
     * identity lookup was broken, so a fully logged-in account polled indefinitely
     * with the UI cheerfully saying "waiting for you to log in". Whenever the answer
     * is "I cannot tell", say so instead of implying the user has not acted.
     */
    if (await sessionUserId(s.page)) {
      return {
        state: 'waiting',
        message: 'Logged in — confirming which account with Instagram…',
      }
    }
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
