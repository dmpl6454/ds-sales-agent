/**
 * The only place Instagram URLs are constructed.
 *
 * This module exists because the dashboard and `pnpm send` had drifted apart: the
 * CLI opened the recipient's profile, the dashboard button used `ig.me/m/<handle>`.
 * Verified 2026-07-30 with a desktop User-Agent:
 *
 *   https://ig.me/m/madovermarketing_mom        → HTTP 400, no redirect
 *   https://www.instagram.com/madovermarketing_mom/ → HTTP 200
 *
 * `ig.me` is Meta's mobile-app deep-link domain. On desktop web it is simply dead,
 * so the dashboard's "Open Instagram" button could not work. One definition here,
 * imported by both, is what stops that recurring.
 *
 * Opening the PROFILE rather than deep-linking a thread is also the deliberate
 * choice recorded in CLAUDE.md decision 1: profile → Message → type is the
 * navigation path a person actually takes, and it is the path these accounts have
 * always taken.
 */

/** Instagram handles are [A-Za-z0-9._], 1-30 chars. */
const HANDLE = /^[A-Za-z0-9._]{1,30}$/

/**
 * Defence in depth. Handles come from our own database, but a string about to be
 * handed to the OS (`open <url>`) or interpolated into an href should never be
 * unvalidated.
 */
export function assertSafeHandle(handle: string): void {
  if (!HANDLE.test(handle)) {
    throw new Error(`refusing to build a URL for a malformed handle: ${JSON.stringify(handle)}`)
  }
}

/** The recipient's profile — where a send starts. */
export function profileUrl(handle: string): string {
  assertSafeHandle(handle)
  return `https://www.instagram.com/${handle}/`
}

/**
 * The DM inbox. Used for replies: it is where you can actually read what they
 * wrote. We have no thread id, and deep-linking a thread is ruled out anyway.
 */
export function dmInboxUrl(): string {
  return 'https://www.instagram.com/direct/inbox/'
}
