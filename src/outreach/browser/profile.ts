import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertSafeHandle } from '@/lib/urls'

/**
 * One real Chrome profile directory per sending account.
 *
 * This is the single most important file in the send path, so the reasoning is
 * written out rather than assumed.
 *
 * The thing that gets Instagram accounts banned is NOT automation as such — it is
 * a session appearing on a device that has never seen it before. Verified
 * 2026-07-30: a login by hand writes durable device identifiers (`mid`, `ig_did`,
 * `ig-u-rur`) into the browser profile and records a login event binding that
 * browser to the account. `sessionid` is a bearer token with NO channel binding, so
 * copying it into a fresh automation profile still *works* — right up until
 * enforcement lands, silently, because every device signal is new.
 *
 * So the design is: you log in ONCE, BY HAND, into the directory below
 * (`pnpm login <handle>`). Automation then reuses that same directory forever.
 * Same profile, same device identifiers, same residential IP, same login event.
 * From Instagram's side nothing changed — because nothing did.
 *
 * Consequences that are load-bearing, do not "optimise" them away:
 *
 *   - NEVER import a cookie or storageState into one of these. If a profile is not
 *     logged in, the fix is `pnpm login <handle>`, never a transplant.
 *   - One directory per account, never shared. Two accounts in one profile means
 *     switching, which is a different (noisier) pattern than a dedicated browser.
 *   - Lives outside the repo, under the user's home. It contains a live session;
 *     it must never be committed, synced, or copied to another machine — a profile
 *     that appears on new hardware is exactly the signal we are avoiding.
 *   - `channel: 'chrome'` uses the installed Google Chrome, not bundled Chromium.
 *     Chromium has a distinguishable build; Chrome is what a person uses.
 */

const ROOT = join(homedir(), '.ds-sales-agent', 'chrome-profiles')

export interface ProfileStatus {
  handle: string
  dir: string
  /** The directory exists and has Chrome's own files in it — i.e. it has been used. */
  initialised: boolean
}

/** Absolute path to a sender's dedicated Chrome profile directory. */
export function profileDir(handle: string): string {
  assertSafeHandle(handle)
  return join(ROOT, handle)
}

/**
 * Creates the directory if absent. Chrome populates it on first launch; we only
 * guarantee the parent exists so `launchPersistentContext` does not fail.
 */
export function ensureProfileDir(handle: string): string {
  const dir = profileDir(handle)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Whether Chrome has ever run in this profile. A profile that exists but is empty
 * has never been logged into, which is a different message to the operator than
 * "no profile at all".
 *
 * Note this reports *initialised*, not *logged in*. Whether the session is still
 * valid can only be answered by loading Instagram, which is the send path's job —
 * a cheap filesystem check must not be allowed to imply more than it knows.
 */
export function profileStatus(handle: string): ProfileStatus {
  const dir = profileDir(handle)
  let initialised = false
  if (existsSync(dir)) {
    // Chrome writes "Default/" and "Local State" on its first run.
    const entries = readdirSync(dir)
    initialised = entries.includes('Default') || entries.includes('Local State')
  }
  return { handle, dir, initialised }
}
