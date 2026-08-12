import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * WHERE THINGS LIVE ON DISK — and, more importantly, WHICH DIRECTORY IS A CREDENTIAL.
 *
 * ── THE SPLIT, AND WHY IT IS A SECURITY BOUNDARY ────────────────────────────
 *
 * `~/.ds-sales-agent` holds Chrome profiles, and those decrypt OFFLINE. Patchright
 * hardcodes `--use-mock-keychain --password-store=basic`, so Chrome's cookie-encryption
 * key is a public constant rather than a macOS Keychain entry bound to this machine.
 * Anyone with a copy of that directory reads the Instagram session cookies — which is why
 * CLAUDE.md calls it "as sensitive as a password file" and why backups, cloud-synced
 * folders and screen shares all count as exposure.
 *
 * That rule is only followable if the directory contains NOTHING ELSE. Two things had
 * accumulated inside it that are not secret at all:
 *
 *   - `frames/`  — cover images fetched from a PUBLIC Instagram CDN. 314 files, 15 MB.
 *   - `bin/`     — a Swift OCR helper this repo compiles itself.
 *
 * Neither is a credential, and both are things a future feature wants to touch casually:
 * a contact-sheet UI serving frames, a support bundle, an rsync to a server. Every one of
 * those is safe for frames and catastrophic for profiles, and while they share a parent
 * the difference depends on whoever writes that feature remembering it. This is the same
 * reasoning as `middleware.ts` listing PUBLIC routes rather than private ones, and the
 * pruner deleting from an ALLOWLIST: make the dangerous set small, explicit, and
 * impossible to widen by accident.
 *
 * So: `~/.ds-sales-agent` is credentials ONLY. `~/.ds-sales-agent-data` is everything
 * else — disposable, copyable, serveable, and containing nothing that identifies a
 * device or authenticates a session.
 *
 * A sibling directory rather than a subdirectory on purpose. Nesting the data inside the
 * credential root would mean "copy ~/.ds-sales-agent-data" still walks into the profiles
 * the day someone reorganises, and the whole point is that the two are separable by a
 * glob, a backup rule, or a `scp` that nobody thought hard about.
 */

/** Credentials. Chrome profiles and their device identity. NEVER copy, sync or serve. */
export const CREDENTIAL_ROOT = join(homedir(), '.ds-sales-agent')

/** Everything that is not a credential. Safe to back up, serve, or delete and refetch. */
export const DATA_ROOT = join(homedir(), '.ds-sales-agent-data')

/** Chrome profiles — one per sending account. The device identity lives here. */
export const PROFILES_DIR = join(CREDENTIAL_ROOT, 'chrome-profiles')

/** Copies of the 27 KB of irreplaceable per-profile identity, taken before pruning. */
export const IDENTITY_BACKUPS_DIR = join(CREDENTIAL_ROOT, 'identity-backups')

/** Post cover frames, `<shortcode>.jpg`. Public CDN images; nothing sensitive. */
export const FRAMES_DIR = join(DATA_ROOT, 'frames')

/** Helper binaries this repo compiles (the Swift OCR reader). Rebuildable from source. */
export const BIN_DIR = join(DATA_ROOT, 'bin')

/** Where a long-running watch writes its output. */
export const LOGS_DIR = join(DATA_ROOT, 'logs')
