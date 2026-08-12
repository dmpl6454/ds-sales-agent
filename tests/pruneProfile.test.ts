import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

/**
 * Pruning a Chrome profile deletes from a directory that holds the ONE thing in this repo
 * that cannot be rebuilt: the device identity a hand login wrote. Destroying it makes the
 * next login look like new hardware to Instagram, which is the state the whole send design
 * exists to avoid.
 *
 * So the tests here are not about disk arithmetic. They are about the two directions of
 * every refusal, and about the protected files surviving BYTE-IDENTICAL — asserted by hash,
 * because "it does not touch the cookies" is a claim and a hash is evidence.
 *
 * `profileDir` is redirected at a temp directory. Driving the real one would mean an
 * `rm -rf` against live credentials from a test run, which is not a thing to be one typo
 * away from.
 */

const SANDBOX = join(tmpdir(), `ds-prune-test-${process.pid}`)
let currentHandle = 'testaccount'

vi.mock('@/outreach/browser/profile', () => ({
  profileDir: (handle: string) => join(SANDBOX, handle),
  profileStatus: (handle: string) => {
    const dir = join(SANDBOX, handle)
    return {
      handle,
      dir,
      initialised: existsSync(dir),
      // Stand in for the real cookie-database read: the fixture writes a Cookies file, so
      // its presence is the session. The point under test is that pruning does not remove it.
      hasSession: existsSync(join(dir, 'Default', 'Cookies')),
    }
  },
}))

const {
  pruneProfile,
  DISPOSABLE_SUBPATHS,
  PROTECTED_SUBPATHS,
  dirBytes,
  chromeHoldingProfile,
  findProfileHolder,
  verifyUnchanged,
  backupRoot,
} = await import('@/outreach/browser/pruneProfile')

/** A profile that looks like a real one: big caches, tiny irreplaceable files. */
function makeProfile(handle: string, opts: { withSession?: boolean } = {}) {
  const dir = join(SANDBOX, handle)
  for (const sub of DISPOSABLE_SUBPATHS) {
    mkdirSync(join(dir, sub), { recursive: true })
    writeFileSync(join(dir, sub, 'data_0'), 'x'.repeat(4096))
    writeFileSync(join(dir, sub, 'index'), 'y'.repeat(2048))
  }
  mkdirSync(join(dir, 'Default'), { recursive: true })
  if (opts.withSession !== false) writeFileSync(join(dir, 'Default', 'Cookies'), 'THE-DEVICE-IDENTITY-mid-datr-ig_did')
  writeFileSync(join(dir, 'Local State'), 'THE-LOCAL-STATE')
  // Things that must survive because they are NOT on the allowlist.
  mkdirSync(join(dir, 'Default', 'Local Storage'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Local Storage', 'leveldb.log'), 'instagram localstorage')
  writeFileSync(join(dir, 'Default', 'Cookies-journal'), 'journal')
  writeFileSync(join(dir, 'Default', 'History'), 'history')
  mkdirSync(join(dir, 'component_crx_cache'), { recursive: true })
  writeFileSync(join(dir, 'component_crx_cache', 'blob'), 'z'.repeat(1024))
  return dir
}

const noChrome = () => null

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  currentHandle = 'testaccount'
})

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('the deletable set is a frozen allowlist', () => {
  it('names exactly the three measured cache directories', () => {
    expect([...DISPOSABLE_SUBPATHS]).toEqual([
      join('Default', 'Cache'),
      join('Default', 'Code Cache'),
      join('Default', 'GPUCache'),
    ])
  })

  /**
   * The whole safety argument. Not "Cookies is protected" — that is a denylist claim — but
   * "nothing outside the allowlist is reachable at all".
   */
  it('lists no path that could hold device identity', () => {
    for (const sub of DISPOSABLE_SUBPATHS) {
      expect(sub.toLowerCase()).not.toContain('cookie')
      expect(sub.toLowerCase()).not.toContain('local state')
      expect(sub.toLowerCase()).not.toContain('local storage')
      expect(sub.toLowerCase()).not.toContain('network')
    }
  })

  it('protects the two files that cannot be rebuilt', () => {
    expect([...PROTECTED_SUBPATHS]).toEqual([join('Default', 'Cookies'), 'Local State'])
  })
})

describe('dry run is the default', () => {
  it('reports what it would free and deletes nothing', () => {
    const dir = makeProfile(currentHandle)
    const before = dirBytes(dir)
    const r = pruneProfile({ handle: currentHandle, chromeCheck: noChrome })

    expect(r.deleted).toBe(false)
    expect(r.bytesReclaimable).toBeGreaterThan(0)
    expect(dirBytes(dir)).toBe(before)
    for (const sub of DISPOSABLE_SUBPATHS) expect(existsSync(join(dir, sub))).toBe(true)
  })

  it('needs no argument to be a dry run', () => {
    makeProfile(currentHandle)
    expect(pruneProfile({ handle: currentHandle, chromeCheck: noChrome }).deleted).toBe(false)
  })
})

describe('pruning for real', () => {
  it('deletes every disposable directory and nothing else', () => {
    const dir = makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })

    expect(r.deleted).toBe(true)
    for (const sub of DISPOSABLE_SUBPATHS) expect(existsSync(join(dir, sub)), sub).toBe(false)

    // Everything off the allowlist survives, including caches we deliberately do not claim.
    expect(existsSync(join(dir, 'Default', 'Cookies'))).toBe(true)
    expect(existsSync(join(dir, 'Local State'))).toBe(true)
    expect(existsSync(join(dir, 'Default', 'Cookies-journal'))).toBe(true)
    expect(existsSync(join(dir, 'Default', 'Local Storage', 'leveldb.log'))).toBe(true)
    expect(existsSync(join(dir, 'Default', 'History'))).toBe(true)
    expect(existsSync(join(dir, 'component_crx_cache', 'blob'))).toBe(true)
  })

  /** The claim is "device identity untouched". This is the evidence, not the assertion. */
  it('leaves the protected files byte-identical', () => {
    const dir = makeProfile(currentHandle)
    const cookiesBefore = readFileSync(join(dir, 'Default', 'Cookies'))
    const stateBefore = readFileSync(join(dir, 'Local State'))

    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })

    expect(r.identityIntact).toBe(true)
    expect(readFileSync(join(dir, 'Default', 'Cookies')).equals(cookiesBefore)).toBe(true)
    expect(readFileSync(join(dir, 'Local State')).equals(stateBefore)).toBe(true)
  })

  it('reports the session as still present afterwards', () => {
    makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })
    expect(r.sessionBefore).toBe(true)
    expect(r.sessionAfter).toBe(true)
  })

  it('frees the bytes it said it would', () => {
    makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })
    expect(r.bytesBefore - r.bytesAfter!).toBe(r.bytesReclaimable)
  })

  it('backs the protected files up BEFORE deleting, outside the profile', () => {
    makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })

    expect(r.backupDir).toBeTruthy()
    expect(r.backupDir!.startsWith(backupRoot())).toBe(true)
    expect(r.backupDir!.startsWith(join(SANDBOX, currentHandle))).toBe(false)
    expect(readFileSync(join(r.backupDir!, 'Default_Cookies'), 'utf8')).toContain('THE-DEVICE-IDENTITY')
    expect(readFileSync(join(r.backupDir!, 'Local State'), 'utf8')).toBe('THE-LOCAL-STATE')
    rmSync(r.backupDir!, { recursive: true, force: true })
  })

  /** A profile that was never logged into still prunes; it simply has no session either way. */
  it('prunes a profile with no session without claiming one appeared', () => {
    makeProfile(currentHandle, { withSession: false })
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })
    expect(r.deleted).toBe(true)
    expect(r.sessionBefore).toBe(false)
    expect(r.sessionAfter).toBe(false)
    // Nothing to verify means nothing was broken, not that verification was skipped.
    expect(r.identityIntact).toBe(true)
  })
})

describe('it refuses rather than risking a live profile', () => {
  /** A browser has the directory: deleting 481 MB underneath it can corrupt the cookie DB. */
  it('refuses when Chrome is running on the profile', () => {
    const dir = makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: () => 4242 })

    expect(r.deleted).toBe(false)
    expect(r.refused).toContain('4242')
    for (const sub of DISPOSABLE_SUBPATHS) expect(existsSync(join(dir, sub))).toBe(true)
    expect(r.backupDir).toBeNull()
  })

  /**
   * "Could not determine X" must never become "X is false" — the failure this codebase
   * documents by name and has made in four places. Not knowing whether Chrome is running
   * refuses exactly as a running Chrome does.
   */
  it('refuses when it CANNOT TELL whether Chrome is running', () => {
    const dir = makeProfile(currentHandle)
    const r = pruneProfile({
      handle: currentHandle,
      dryRun: false,
      chromeCheck: () => {
        throw new Error('ps unavailable')
      },
    })

    expect(r.deleted).toBe(false)
    expect(r.refused).toContain('cannot determine')
    for (const sub of DISPOSABLE_SUBPATHS) expect(existsSync(join(dir, sub))).toBe(true)
  })

  /** And the permitting direction, so the refusals above are not vacuous. */
  it('proceeds when the profile is provably unoccupied', () => {
    makeProfile(currentHandle)
    const r = pruneProfile({ handle: currentHandle, dryRun: false, chromeCheck: noChrome })
    expect(r.refused).toBeNull()
    expect(r.deleted).toBe(true)
  })

  it('treats a missing profile as nothing to do, not as an error', () => {
    const r = pruneProfile({ handle: 'neverloggedin', dryRun: false, chromeCheck: noChrome })
    expect(r.missing).toBe(true)
    expect(r.deleted).toBe(false)
    expect(r.refused).toBeNull()
  })
})

describe('dirBytes', () => {
  it('sums a tree', () => {
    const dir = join(SANDBOX, 'sizes')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'f1'), 'x'.repeat(100))
    writeFileSync(join(dir, 'a', 'b', 'f2'), 'x'.repeat(50))
    expect(dirBytes(dir)).toBe(150)
  })

  it('returns 0 for an absent path rather than throwing', () => {
    expect(dirBytes(join(SANDBOX, 'nope'))).toBe(0)
  })

  /**
   * Symlinks are never followed. A symlink inside a cache directory pointing at the profile
   * root would otherwise make `dirBytes` recurse into the live profile — and, far worse,
   * `rmSync(recursive)` follows nothing but the reasoning has to be stated once.
   */
  it('does not follow symlinks', () => {
    const dir = join(SANDBOX, 'links')
    mkdirSync(join(dir, 'real'), { recursive: true })
    writeFileSync(join(dir, 'real', 'f'), 'x'.repeat(10))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect(dirBytes(dir)).toBe(10)
  })
})

/**
 * ── the matcher, driven from a fixed `ps` transcript ──────────────────────
 *
 * These are the lines that decide whether a destructive delete goes ahead, so they are
 * asserted against literal text rather than against the machine's live process list. The
 * previous version of this suite called the real function on `process.cwd()` and asserted
 * null — which passed until my own mutation-testing shell command matched it, because that
 * command's argv contained both the repo path and the phrase "Chrome is running on this
 * profile" out of the source being edited.
 *
 * Two lessons in one: a test whose subject is the ambient machine is not a test, and the
 * POSITIVE direction had no coverage whatsoever — every refusal above injects a fake
 * `chromeCheck`, so the real matching had never once been shown to fire.
 */
describe('findProfileHolder', () => {
  const DIR = '/Users/t/.ds-sales-agent/chrome-profiles/bollywoodsocietyy'
  const OTHER = '/Users/t/.ds-sales-agent/chrome-profiles/madaboutmarketingg'
  const OURS = 4242

  const line = (pid: number, cmd: string) => ` ${pid} ${cmd}`

  it('finds a browser launched on this profile', () => {
    const ps = [
      line(1, '/sbin/launchd'),
      line(
        900,
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --password-store=basic --use-mock-keychain`,
      ),
    ].join('\n')
    expect(findProfileHolder(ps, DIR, OURS)).toBe(900)
  })

  /** Renderer and GPU helpers inherit the flag. Any live process holding it must refuse. */
  it('finds a helper process holding the same profile', () => {
    const ps = line(
      901,
      `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${DIR}`,
    )
    expect(findProfileHolder(ps, DIR, OURS)).toBe(901)
  })

  it('handles a quoted path', () => {
    const ps = line(902, `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="${DIR}"`)
    expect(findProfileHolder(ps, DIR, OURS)).toBe(902)
  })

  it('ignores a trailing slash difference', () => {
    expect(findProfileHolder(line(903, `chrome --user-data-dir=${DIR}/`), DIR, OURS)).toBe(903)
  })

  /** A browser on a DIFFERENT account's profile must not block this one. */
  it('does not match a browser on another profile', () => {
    expect(findProfileHolder(line(904, `chrome --user-data-dir=${OTHER}`), DIR, OURS)).toBeNull()
  })

  /** Nor a profile whose path merely starts with ours. */
  it('does not match a sibling whose path is a prefix', () => {
    expect(findProfileHolder(line(905, `chrome --user-data-dir=${DIR}-old`), DIR, OURS)).toBeNull()
  })

  it('never reports our own pid', () => {
    expect(findProfileHolder(line(OURS, `chrome --user-data-dir=${DIR}`), DIR, OURS)).toBeNull()
  })

  /**
   * THE EXACT FALSE POSITIVE THAT WAS THERE. A shell whose command line contains both the
   * profile path and the word "Chrome" is not a browser.
   */
  it('does not match a shell that merely mentions the path and the word Chrome', () => {
    const ps = line(
      906,
      `/bin/zsh -c cd ${DIR} && perl -pi -e 's/Chrome is running on this profile/x/' pruneProfile.ts`,
    )
    expect(findProfileHolder(ps, DIR, OURS)).toBeNull()
  })

  it('does not match a plain grep for the path', () => {
    expect(findProfileHolder(line(907, `grep -r ${DIR} .`), DIR, OURS)).toBeNull()
  })

  it('survives a malformed line rather than throwing', () => {
    const ps = ['', '   ', 'nopid-here', line(908, `chrome --user-data-dir=${DIR}`)].join('\n')
    expect(findProfileHolder(ps, DIR, OURS)).toBe(908)
  })
})

describe('chromeHoldingProfile asks the OS', () => {
  /**
   * The real function against the real process list. Proves it RUNS on this platform rather
   * than throwing — a throw would make every prune refuse and look like a safety feature.
   * The directory does not exist, so no browser can hold it.
   */
  it('returns null for a directory no browser could be using', () => {
    expect(chromeHoldingProfile(join(SANDBOX, 'definitely-not-a-chrome-profile'))).toBeNull()
  })
})

/**
 * ── the verification itself, driven to FAIL ────────────────────────────────
 *
 * FOUND BY MUTATION TESTING: replacing the hash comparison with a constant `true` broke no
 * test, because every case asserted `identityIntact` where it was true anyway. A check nobody
 * can trigger, reading as healthy because the common path works — inside the verification
 * written to prevent that exact thing.
 *
 * The prune cannot produce the failing state (the allowlist makes it unreachable, which is
 * the point), so the decision is a pure function and is asserted directly.
 */
describe('verifyUnchanged', () => {
  const COOKIES = join('Default', 'Cookies')

  it('confirms when every hash matches', () => {
    const before = new Map([[COOKIES, 'aaa'], ['Local State', 'bbb']])
    const after = new Map<string, string | null>([[COOKIES, 'aaa'], ['Local State', 'bbb']])
    expect(verifyUnchanged(before, after)).toEqual({ intact: true, missing: [], changed: [] })
  })

  it('reports a CHANGED file, separately from a missing one', () => {
    const before = new Map([[COOKIES, 'aaa']])
    const after = new Map<string, string | null>([[COOKIES, 'zzz']])
    const v = verifyUnchanged(before, after)
    expect(v.intact).toBe(false)
    expect(v.changed).toEqual([COOKIES])
    expect(v.missing).toEqual([])
  })

  /** A vanished cookie database is a destroyed profile; it must not read as "changed". */
  it('reports a MISSING file, separately from a changed one', () => {
    const before = new Map([[COOKIES, 'aaa']])
    const after = new Map<string, string | null>([[COOKIES, null]])
    const v = verifyUnchanged(before, after)
    expect(v.intact).toBe(false)
    expect(v.missing).toEqual([COOKIES])
    expect(v.changed).toEqual([])
  })

  /** An absent key is as bad as an explicit null — never silently "fine". */
  it('treats an absent entry as missing, not as unchanged', () => {
    const v = verifyUnchanged(new Map([[COOKIES, 'aaa']]), new Map())
    expect(v.intact).toBe(false)
    expect(v.missing).toEqual([COOKIES])
  })

  it('finds every problem, not just the first', () => {
    const before = new Map([[COOKIES, 'aaa'], ['Local State', 'bbb']])
    const after = new Map<string, string | null>([[COOKIES, null], ['Local State', 'zzz']])
    const v = verifyUnchanged(before, after)
    expect(v.missing).toEqual([COOKIES])
    expect(v.changed).toEqual(['Local State'])
  })

  /** Nothing to verify is intact, and that is correct: a profile never logged into. */
  it('is intact when there was nothing protected to begin with', () => {
    expect(verifyUnchanged(new Map(), new Map()).intact).toBe(true)
  })
})
