import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { profileDir, profileStatus } from './profile'

/**
 * Reclaiming disk from a Chrome profile WITHOUT touching the device identity.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * MEASURED 2026-08-05 on the live profiles: the account that has done every send is
 * **685 MB**, of which `Cache` + `Code Cache` + `GPUCache` are **601 MB — 88%**. The part
 * that cannot be rebuilt is **27 KB**: `Default/Cookies` (20 KB — `mid`, `datr`, `ig_did`,
 * `sessionid`) and `Local State` (7 KB).
 *
 * At 65 profiles the projection is ~44 GB against **27 GB free**, so the disk fills before
 * onboarding finishes. Pruning takes 65 profiles to ~5.5 GB.
 *
 * And it is not a one-off: that profile grew 604 MB -> 685 MB in a day containing ZERO
 * sends. The growth was reply-check browser sessions, and Phase 6 made those run before
 * every follow-up — so cache growth is now proportional to messages sent, which is exactly
 * what scales with the fleet.
 *
 * ── WHY THE DELETABLE SET IS AN ALLOWLIST ─────────────────────────────────
 *
 * `~/.ds-sales-agent` is as sensitive as a password file, and destroying a profile's device
 * identity is unrecoverable — the next login looks like new hardware to Instagram, which is
 * the precise state the whole send design exists to avoid. So this names what may be
 * deleted and touches nothing else.
 *
 * A list of PROTECTED paths would fail in the dangerous direction: the day Chrome invents a
 * new directory, a denylist deletes it. `src/middleware.ts` reasons identically about public
 * versus private routes, and for the same reason. The cost of an allowlist is that a new
 * cache directory goes unreclaimed — we free less disk than we could, which is the correct
 * kind of wrong.
 *
 * Deliberately NOT included, though they are 79 MB more per profile: `component_crx_cache`,
 * `WasmTtsEngine`, `OnDeviceHeadSuggestModel`, `GraphiteDawnCache`. The three below are the
 * ones actually measured, and they already deliver the documented 685 MB -> 84 MB. The
 * remainder would buy ~5 GB across the fleet for extra risk against directories nobody has
 * examined. Headroom, not a target.
 */

/** The ONLY paths this module may ever delete, relative to the profile directory. */
export const DISPOSABLE_SUBPATHS = [
  join('Default', 'Cache'),
  join('Default', 'Code Cache'),
  join('Default', 'GPUCache'),
] as const

/**
 * The irreplaceable 27 KB. Backed up before anything is deleted and verified
 * byte-identical afterwards.
 *
 * `Default/Cookies` holds the durable device identifiers a hand login wrote. `Local State`
 * holds profile-level state Chrome cannot reconstruct. Verifying rather than trusting is
 * the point: "the prune did not touch them" is a claim, and a hash is evidence.
 */
export const PROTECTED_SUBPATHS = [join('Default', 'Cookies'), 'Local State'] as const

export interface PruneCandidate {
  subpath: string
  exists: boolean
  bytes: number
}

export interface PruneReport {
  handle: string
  dir: string
  /** No profile directory at all — nothing to do, and NOT an error. */
  missing: boolean
  candidates: PruneCandidate[]
  bytesReclaimable: number
  bytesBefore: number
  bytesAfter: number | null
  /** Set when the prune was refused. The prune is never partial: it happens or it does not. */
  refused: string | null
  deleted: boolean
  /** Every protected file verified byte-identical after the delete. */
  identityIntact: boolean | null
  /** Protected files that VANISHED — a destroyed profile, not a detail. */
  identityMissing: string[]
  /** Protected files whose bytes CHANGED — something wrote while we worked. */
  identityChanged: string[]
  /** `hasSession` before and after. A change here is an alarm, not a detail. */
  sessionBefore: boolean
  sessionAfter: boolean | null
  backupDir: string | null
}

/** Recursive byte size of a path, 0 when absent. Symlinks are never followed. */
export function dirBytes(path: string): number {
  let stat
  try {
    stat = statSync(path, { throwIfNoEntry: false })
  } catch {
    return 0
  }
  if (!stat) return 0
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size

  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    total += dirBytes(join(path, entry.name))
  }
  return total
}

/**
 * Which pid, if any, has this profile open as its Chrome user-data directory?
 *
 * PURE, and separated from the `ps` call for the reason `classifyProfile` and
 * `interpretLookupFailure` were: the logic lived inside a syscall and therefore had no tests
 * at all, which is how two wrong verdicts shipped. Here it is worse than an untested
 * verdict — a false negative deletes 481 MB out from under a live browser and can corrupt
 * the cookie database, and a false positive refuses to prune forever.
 *
 * ── WHY THE MATCH IS `--user-data-dir=`, NOT A SUBSTRING ───────────────────
 *
 * The first version asked whether the command line contained the directory path AND the word
 * "chrome" anywhere. FOUND BY RUNNING THE TESTS, not by reading: the mutation-testing shell
 * command matched itself. Its argv contained the repo path and the phrase "Chrome is running
 * on this profile" — from the source string being edited — so an ordinary `zsh` was reported
 * as a browser holding the profile.
 *
 * That is a false positive, which refuses and is therefore the safe direction; but it means
 * any unrelated process mentioning both can block pruning indefinitely, and it says the
 * matcher was never testing the right thing. `--user-data-dir=<dir>` is HOW Chrome is told
 * which profile to use — it is the fact, not a correlate of it. `profile.ts` documents that
 * exact flag as the only safe way to open one of these by hand.
 */
export function findProfileHolder(psOutput: string, dir: string, ownPid: number): number | null {
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const space = trimmed.indexOf(' ')
    if (space === -1) continue
    const pid = Number(trimmed.slice(0, space))
    if (!Number.isInteger(pid) || pid === ownPid) continue
    const command = trimmed.slice(space + 1)

    /**
     * Chrome writes the flag as `--user-data-dir=/path`, and a path containing spaces (ours
     * does not, but a handle-derived path is not the only caller) may be quoted. Renderer
     * and GPU helper processes inherit the same flag, which is what we want: ANY live
     * process holding this directory is a reason to refuse.
     */
    for (const m of command.matchAll(/--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
      const value = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\/+$/, '')
      if (value === dir.replace(/\/+$/, '')) return pid
    }
  }
  return null
}

/**
 * Is a Chrome process currently using this profile? ASK THE OS, do not infer.
 *
 * Chrome leaves a `SingletonLock` behind when it crashes, so a file's presence answers "did
 * Chrome ever run" rather than "is Chrome running" — the same mistake as reading a
 * heartbeat's age and calling it liveness, which already left this project with autopilot on
 * and nothing scheduled.
 *
 * Returns a pid, or null for "no process", or THROWS for "cannot tell". The caller refuses
 * on a pid and on a throw alike: absence of an answer must never become a negative verdict.
 */
export function chromeHoldingProfile(dir: string): number | null {
  // `ps -Ao pid=,command=` — full argv, every user's processes. A throw here means we do not
  // know, and the caller must treat not knowing as "occupied".
  const out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return findProfileHolder(out, dir, process.pid)
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * Did every protected file survive byte-identical? PURE, and separated for one reason: as an
 * inline loop it could not be driven to FAIL.
 *
 * FOUND BY MUTATION TESTING. Replacing the comparison with a constant `true` broke no test,
 * because every case asserted `identityIntact` on a happy path where it was true regardless.
 * That is this codebase's signature failure exactly — a check nobody can trigger, reading as
 * healthy because the common path is the one that works — and it had reappeared inside the
 * verification written to prevent it.
 *
 * `missing` and `changed` are reported separately because they mean different things to a
 * person: a cookie database that VANISHED is a destroyed profile, one whose bytes CHANGED is
 * a browser that wrote to it while we worked.
 */
export function verifyUnchanged(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string | null>,
): { intact: boolean; missing: string[]; changed: string[] } {
  const missing: string[] = []
  const changed: string[] = []
  for (const [subpath, hash] of before) {
    const now = after.get(subpath) ?? null
    if (now === null) missing.push(subpath)
    else if (now !== hash) changed.push(subpath)
  }
  return { intact: missing.length === 0 && changed.length === 0, missing, changed }
}

/** Where the 27 KB is copied before anything is deleted. Outside the profile, deliberately. */
export function backupRoot(): string {
  return join(homedir(), '.ds-sales-agent', 'identity-backups')
}

/**
 * Prune one profile.
 *
 * DRY RUN BY DEFAULT, like every other command here that cannot be undone.
 *
 * The order is load-bearing: measure, refuse-or-proceed, BACK UP, delete, verify. Backing up
 * after the delete would be worthless, and verifying is what turns "this does not touch the
 * cookies" from an assertion into a measurement.
 */
export function pruneProfile(args: {
  handle: string
  dryRun?: boolean
  /** Injected in tests so the OS check itself can be driven both ways. */
  chromeCheck?: (dir: string) => number | null
  now?: Date
}): PruneReport {
  const { handle, dryRun = true, chromeCheck = chromeHoldingProfile, now = new Date() } = args
  const dir = profileDir(handle)

  const base: PruneReport = {
    handle,
    dir,
    missing: !existsSync(dir),
    candidates: [],
    bytesReclaimable: 0,
    bytesBefore: 0,
    bytesAfter: null,
    refused: null,
    deleted: false,
    identityIntact: null,
    identityMissing: [],
    identityChanged: [],
    sessionBefore: false,
    sessionAfter: null,
    backupDir: null,
  }
  if (base.missing) return base

  base.bytesBefore = dirBytes(dir)
  base.sessionBefore = profileStatus(handle).hasSession
  base.candidates = DISPOSABLE_SUBPATHS.map((subpath) => {
    const full = join(dir, subpath)
    return { subpath, exists: existsSync(full), bytes: dirBytes(full) }
  })
  base.bytesReclaimable = base.candidates.reduce((n, c) => n + c.bytes, 0)

  if (dryRun) return base

  /**
   * Refuse unless the profile is provably unoccupied. Both "a browser has it" and "we could
   * not find out" refuse — absence of an answer must never be read as a negative verdict,
   * which is a mistake this codebase has made in four places and documents by name.
   */
  let holder: number | null
  try {
    holder = chromeCheck(dir)
  } catch (e) {
    base.refused = `cannot determine whether Chrome is using this profile (${e instanceof Error ? e.message : String(e)}) — refusing`
    return base
  }
  if (holder !== null) {
    base.refused = `Chrome is running on this profile (pid ${holder}) — close it first`
    return base
  }

  // Back up the irreplaceable part BEFORE touching anything, and remember its hashes.
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const backupDir = join(backupRoot(), `${handle}-${stamp}`)
  const hashesBefore = new Map<string, string>()
  mkdirSync(backupDir, { recursive: true })
  for (const subpath of PROTECTED_SUBPATHS) {
    const full = join(dir, subpath)
    if (!existsSync(full)) continue
    hashesBefore.set(subpath, sha256(full))
    // Flattened name: "Default/Cookies" cannot be a path component.
    copyFileSync(full, join(backupDir, subpath.replace(/[\\/]/g, '_')))
  }
  base.backupDir = backupDir

  for (const candidate of base.candidates) {
    if (!candidate.exists) continue
    /**
     * `join(dir, subpath)` where `subpath` comes from the frozen allowlist above and `dir`
     * from `profileDir`, which runs `assertSafeHandle`. Neither side is caller-supplied
     * text, so no traversal is reachable — worth stating, because this is an `rm -rf` on a
     * directory holding live credentials.
     */
    rmSync(join(dir, candidate.subpath), { recursive: true, force: true })
  }
  base.deleted = true

  // VERIFY. The claim is "device identity untouched"; this is the evidence.
  const hashesAfter = new Map<string, string | null>()
  for (const subpath of hashesBefore.keys()) {
    const full = join(dir, subpath)
    hashesAfter.set(subpath, existsSync(full) ? sha256(full) : null)
  }
  const verdict = verifyUnchanged(hashesBefore, hashesAfter)
  base.identityIntact = verdict.intact
  base.identityMissing = verdict.missing
  base.identityChanged = verdict.changed
  base.bytesAfter = dirBytes(dir)
  base.sessionAfter = profileStatus(handle).hasSession

  return base
}
