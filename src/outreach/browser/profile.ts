import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
 * (`pnpm ig:login <handle>`). Automation then reuses that same directory forever.
 * Same profile, same device identifiers, same residential IP, same login event.
 * From Instagram's side nothing changed — because nothing did.
 *
 * Consequences that are load-bearing, do not "optimise" them away:
 *
 *   - NEVER import a cookie or storageState into one of these. If a profile is not
 *     logged in, the fix is `pnpm ig:login <handle>`, never a transplant.
 *   - One directory per account, never shared. Two accounts in one profile means
 *     switching, which is a different (noisier) pattern than a dedicated browser.
 *   - Lives outside the repo, under the user's home. It contains a live session;
 *     it must never be committed, synced, or copied to another machine — a profile
 *     that appears on new hardware is exactly the signal we are avoiding.
 *   - `channel: 'chrome'` uses the installed Google Chrome, not bundled Chromium.
 *     Chromium has a distinguishable build; Chrome is what a person uses.
 *
 * TWO CONSEQUENCES OF `--use-mock-keychain`, verified 2026-07-30 on the live process:
 *
 * Patchright (like Playwright) hardcodes `--use-mock-keychain --password-store=basic`
 * into its launch switches. `launchProfile` cannot opt out without `ignoreDefaultArgs`.
 * Both flags were confirmed present on the real Chrome this project launched. That
 * means Chrome's cookie encryption key is a PUBLIC CONSTANT rather than an entry in
 * the macOS Keychain, and two things follow:
 *
 *   1. NEVER OPEN ONE OF THESE PROFILES WITH NORMAL CHROME. Plain Chrome derives its
 *      key from the Keychain, cannot decrypt these cookies, and DELETES the rows it
 *      cannot read. That destroys not only the session but `mid`, `datr` and `ig_did`
 *      — the durable device identity this entire design exists to preserve. The next
 *      login would then look like a brand-new device to Instagram, which is the exact
 *      state we are avoiding. Measured on throwaway profiles: row present → row gone,
 *      and going back to Patchright does not recover it.
 *
 *      This matters because opening the profile by hand is the natural reflex when
 *      something looks wrong. It must not be the reflex. Use `pnpm ig:login <handle>`.
 *      If a manual launch is genuinely unavoidable, it MUST carry the same flags:
 *        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *          --user-data-dir=<profile> --password-store=basic --use-mock-keychain
 *
 *   2. TREAT THESE DIRECTORIES AS CREDENTIAL FILES. Because the key is a constant and
 *      not machine-bound, anyone who obtains a copy of the directory can decrypt the
 *      session cookies offline — no Keychain, no password. Backups, cloud-synced
 *      folders and screen-shared terminals all count. This is not a reason to avoid
 *      the design; it is a reason to know that `~/.ds-sales-agent` is as sensitive as
 *      a password file.
 */

const ROOT = join(homedir(), '.ds-sales-agent', 'chrome-profiles')

export interface ProfileStatus {
  handle: string
  dir: string
  /**
   * Chrome has run in this directory at least once. Says NOTHING about being logged
   * in — merely launching the browser creates `Default/`. Do not gate sending on it.
   */
  initialised: boolean
  /**
   * An Instagram session cookie is present on disk. This is the real gate.
   *
   * Read from Chrome's own cookie database by NAME only. Cookie *values* are
   * encrypted; names are not, so presence can be established without decrypting
   * anything and without launching a browser.
   *
   * Still not proof the session works — Instagram can revoke server-side while the
   * cookie sits happily on disk. That question is only answerable by asking
   * Instagram, which `assertLoggedInAs` does on every send. This check exists to
   * stop the far more embarrassing failure: reporting an account "ready" and arming
   * it for unattended sending when it has never been logged into at all.
   */
  hasSession: boolean
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
  return { handle, dir, initialised, hasSession: hasSessionCookie(dir) }
}

/** Cookies Instagram sets only for a logged-in session. */
const SESSION_COOKIES = ['sessionid', 'ds_user_id']

/**
 * Does this profile's cookie jar contain an Instagram session cookie?
 *
 * The database is copied before reading because Chrome holds a write lock on it
 * whenever a browser is open on the profile — and a `pnpm ig:login` window parked at
 * its prompt is exactly when this gets asked. Read-only-open would intermittently
 * throw; a copy always works. Values are never touched, only the `name` column.
 *
 * Failure returns false. This gate must fail CLOSED: "I cannot tell" and "not logged
 * in" both have to mean "do not arm this for unattended sending".
 */
function hasSessionCookie(profileDir: string): boolean {
  const db = join(profileDir, 'Default', 'Cookies')
  if (!existsSync(db)) return false

  const copy = join(tmpdir(), `ds-cookiecheck-${process.pid}-${Date.now()}.db`)
  try {
    copyFileSync(db, copy)
    // Required lazily: this module is imported by the dashboard's server components,
    // and better-sqlite3 is a native module that should not load unless needed.
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const conn = new Database(copy, { readonly: true, fileMustExist: true })
    try {
      const row = conn
        .prepare(
          `select count(*) as n from cookies
            where host_key like '%instagram.com' and name in (${SESSION_COOKIES.map(() => '?').join(',')})`,
        )
        .get(...SESSION_COOKIES) as { n: number } | undefined
      return (row?.n ?? 0) > 0
    } finally {
      conn.close()
    }
  } catch {
    return false
  } finally {
    try {
      rmSync(copy, { force: true })
    } catch {
      /* best effort */
    }
  }
}
