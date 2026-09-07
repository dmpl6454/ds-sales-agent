import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * PAIRING A MAC — the pure half, driven without a database or a server.
 *
 * The key below is a REAL ed25519 public key generated with ssh-keygen for this file, and the
 * fingerprint beside it is what `ssh-keygen -lf` printed for it — so the fingerprint test
 * compares our arithmetic against OpenSSH's, not against itself.
 */
/**
 * `@/lib/env` parses process.env ONCE, on the first import anywhere in this file — so the
 * authorized_keys path used by the file-I/O tests must be set before any dynamic import runs,
 * not inside the test that needs it (which is how the first version read the default
 * /root/.ssh path and saw nothing).
 */
const AK_DIR = mkdtempSync(join(tmpdir(), 'ds-ak-'))
const AK_FILE = join(AK_DIR, 'authorized_keys')
process.env.DEVICE_AUTHORIZED_KEYS = AK_FILE

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFFan6luIIBgxby/pMXoNfmUzRGhZGXchva+YyWWm7Hm ds-device:Test Mac'
const FPR = 'SHA256:VUocyrgOPTZLA9sZLGgk8PO0P+0TjLxFbnLFOJIeB14'
const B64 = PUB.split(' ')[1]!

describe('isEd25519PublicKey — exactly one key, and nothing that could become a second line', () => {
  it('accepts a real key with and without its comment', async () => {
    const { isEd25519PublicKey } = await import('@/lib/deviceEnrol')
    expect(isEd25519PublicKey(PUB)).toBe(true)
    expect(isEd25519PublicKey(`ssh-ed25519 ${B64}`)).toBe(true)
    expect(isEd25519PublicKey(`  ssh-ed25519 ${B64}  `)).toBe(true)
  })

  it('refuses anything else — RSA, garbage, two keys, a newline smuggled in', async () => {
    const { isEd25519PublicKey } = await import('@/lib/deviceEnrol')
    expect(isEd25519PublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC' + 'A'.repeat(300) + ' x')).toBe(false)
    expect(isEd25519PublicKey('ssh-ed25519 ' + 'A'.repeat(68))).toBe(false) // right length, wrong bytes
    expect(isEd25519PublicKey(`${PUB}\nssh-ed25519 ${B64} second`)).toBe(false)
    expect(isEd25519PublicKey(`ssh-ed25519 ${B64} comment\r`)).toBe(false)
    expect(isEd25519PublicKey('')).toBe(false)
    expect(isEd25519PublicKey('hello')).toBe(false)
  })
})

describe('authorizedKeyLine — the restrictions are the safety, and they come first', () => {
  it('writes the forward-only prefix, the key, and the device comment', async () => {
    const { authorizedKeyLine, KEY_RESTRICTIONS } = await import('@/lib/deviceEnrol')
    const line = authorizedKeyLine(PUB, 'Tabish MacBook')
    expect(line.startsWith(KEY_RESTRICTIONS + ' ssh-ed25519 ' + B64)).toBe(true)
    expect(line.endsWith(' ds-device:Tabish MacBook')).toBe(true)
    expect(line.includes('\n')).toBe(false)
    // The exact restrictions the shared key has carried since 1 Sept — no shell, no files, one port.
    expect(KEY_RESTRICTIONS).toBe(
      'restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="localhost:5432",command="/usr/bin/false"',
    )
  })

  it('drops the key\'s own comment so a device cannot smuggle options or a second name', async () => {
    const { authorizedKeyLine } = await import('@/lib/deviceEnrol')
    const line = authorizedKeyLine(`ssh-ed25519 ${B64} evil,no-restrict`, 'x')
    expect(line).not.toContain('evil')
    expect(line.split(' ').length).toBe(4) // restrictions · type · blob · comment
  })

  it('refuses to build a line from anything but a single ed25519 key', async () => {
    const { authorizedKeyLine } = await import('@/lib/deviceEnrol')
    expect(() => authorizedKeyLine('ssh-rsa AAAA', 'x')).toThrow()
  })
})

describe('keyFingerprint — agrees with ssh-keygen -lf', () => {
  it('matches OpenSSH byte for byte', async () => {
    const { keyFingerprint } = await import('@/lib/deviceEnrol')
    expect(keyFingerprint(PUB)).toBe(FPR)
  })
})

describe('sanitizeDeviceName', () => {
  it('keeps letters, digits, space, dot, dash, underscore; caps the length; never empty', async () => {
    const { sanitizeDeviceName } = await import('@/lib/deviceEnrol')
    expect(sanitizeDeviceName("Tabish's MacBook Air")).toBe('Tabishs MacBook Air')
    expect(sanitizeDeviceName('  a   b  ')).toBe('a b')
    expect(sanitizeDeviceName('x'.repeat(100)).length).toBe(40)
    expect(sanitizeDeviceName('\n\r\t')).toBe('mac')
    expect(sanitizeDeviceName('naïve café')).toBe('naive cafe')
  })
})

describe('enrolmentExpired — 15 minutes from the request', () => {
  it('is live inside the window and expired just past it', async () => {
    const { enrolmentExpired, ENROL_TTL_MS } = await import('@/lib/deviceEnrol')
    const t0 = Date.parse('2026-09-03T10:00:00Z')
    expect(enrolmentExpired(new Date(t0), t0 + ENROL_TTL_MS - 1)).toBe(false)
    expect(enrolmentExpired(new Date(t0), t0 + ENROL_TTL_MS + 1)).toBe(true)
  })
})

describe('newUserCode — read off one screen, typed on none', () => {
  it('is 8 characters from the unambiguous alphabet', async () => {
    const { newUserCode } = await import('@/lib/deviceEnrol')
    for (let i = 0; i < 50; i++) expect(newUserCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  })
})

describe('listPairedDevices / revokePairedDevice — against a real authorized_keys file', () => {
  it('lists only the lines this flow wrote, and revoking removes exactly that Mac', async () => {
    const file = AK_FILE
    const { listPairedDevices, revokePairedDevice, authorizedKeyLine } = await import('@/lib/deviceEnrol')
    writeFileSync(
      file,
      [
        'ssh-ed25519 ' + B64 + ' tabish@dashmani.com', // a human's key — not ours to list or touch
        authorizedKeyLine(PUB, 'Office Mac'),
        authorizedKeyLine(PUB, 'Home Mac'),
        '',
      ].join('\n'),
    )
    expect(listPairedDevices().map((d) => d.name)).toEqual(['Office Mac', 'Home Mac'])
    expect(listPairedDevices()[0]!.fingerprint).toBe(FPR)
    expect(revokePairedDevice('Office Mac')).toBe(1)
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('tabish@dashmani.com') // untouched
    expect(after).toContain('ds-device:Home Mac')
    expect(after).not.toContain('ds-device:Office Mac')
    expect(revokePairedDevice('Nobody')).toBe(0)
  })
})

/**
 * ── A WAITING MAC MUST BE VISIBLE WITHOUT A URL (2026-09-04) ──────────────────
 *
 * A second operator ran the installer and NOTHING appeared anywhere. MEASURED afterwards: 0
 * paired devices and 0 pending rows — the request had expired unseen. `findByUserCode` was the
 * ONLY reader and it needs the exact code out of the URL the installer opened, while
 * `listPairedDevices` reads `authorized_keys` and can only ever show devices already approved.
 * Between them a pairing that was waiting appeared on no screen at all.
 */
describe('the approve link survives signing in, and a waiting Mac is listed', () => {
  const repo = join(__dirname, '..')

  it('carries the code through the sign-in redirect', () => {
    /* A bare redirect('/sign-in') dropped it, and that is the COMMON path: the installer opens
       this URL in the operator's browser and a NEW operator is by definition not signed in. */
    const page = readFileSync(join(repo, 'src/app/devices/enrol/page.tsx'), 'utf8')
    expect(page).toMatch(/next=\$\{encodeURIComponent\(`\/devices\/enrol\?code=\$\{code\}`\)\}/)
    expect(page, 'a bare redirect drops the code').not.toMatch(/if \(!user\) redirect\('\/sign-in'\)/)
  })

  it('reads the code BEFORE deciding to redirect, or there is nothing to carry', () => {
    const page = readFileSync(join(repo, 'src/app/devices/enrol/page.tsx'), 'utf8')
    expect(page.indexOf('const code =')).toBeLessThan(page.indexOf('const user = await currentUser()'))
  })

  it('lists pending pairings on /senders, not only approved ones', () => {
    /* The load-bearing half: approving must need no URL and no remembered code. */
    const senders = readFileSync(join(repo, 'src/app/senders/page.tsx'), 'utf8')
    expect(senders).toMatch(/listPendingEnrolments/)
    expect(senders).toMatch(/Macs waiting to be approved/)
    expect(senders).toMatch(/action=\{approveDevice\}/)
  })

  it('records that a Mac asked, so an unapproved install is distinguishable from one that never phoned home', () => {
    const lib = readFileSync(join(repo, 'src/lib/deviceEnrol.ts'), 'utf8')
    const fn = lib.slice(lib.indexOf('export async function startEnrolment'))
    expect(fn).toMatch(/device\.enrol\.requested/)
  })
})

/**
 * ── THE .APP MUST NOT BECOME A BROWSER SHORTCUT AFTER A FAILED INSTALL (2026-09-07) ──
 *
 * `launcher.sh` asked whether `~/ds-sales-agent` EXISTS, and `install.sh` creates that
 * directory at step 2 — before the runtime, the tunnel, the pairing and the agent. So any
 * failure after the unpack left the directory behind and every later double-click opened a web
 * page instead of resuming. Handing the person a newer DMG changed nothing, because the check
 * is about their disk rather than about the image.
 *
 * MEASURED after a second operator installed twice: exactly ONE enrolment request had ever
 * reached the server (our own probe), and no dashboard session since 1 September.
 *
 * Same correction as the aborted first run of 1 September, one layer up: a completion
 * SENTINEL, never file existence.
 */
describe('the app relaunches the installer when setup never finished', () => {
  const repo = join(__dirname, '..')
  const launcher = readFileSync(join(repo, 'scripts/dmg/launcher.sh'), 'utf8')
  const installer = readFileSync(join(repo, 'scripts/dmg/install.sh'), 'utf8')

  it('decides on the completion sentinel, not on the code directory', () => {
    expect(launcher).toMatch(/setup-complete/)
    expect(
      launcher,
      'a bare directory check turns a half-finished install into a permanent shortcut',
    ).not.toMatch(/if \[ -d "\$HOME\/ds-sales-agent" \] \|\| \[ -d "\$HOME\/Desktop/)
  })

  it('writes that sentinel LAST, after everything that can fail', () => {
    /* Written at step 2 it would mean "setup started", which is the bug being fixed. */
    expect(installer).toMatch(/setup-complete/)
    expect(installer.indexOf('setup-complete')).toBeGreaterThan(installer.indexOf('tar -xzf'))
    expect(installer.indexOf('setup-complete')).toBeGreaterThan(installer.indexOf('install-tunnel.sh install'))
  })

  it('still treats a maintainer’s dev checkout as a shortcut, never installing over it', () => {
    expect(launcher).toMatch(/Desktop\/AI Sales Agent/)
  })

  it('does not require the person at the keyboard to hold a dashboard login', () => {
    /* The waiting Mac is listed on /senders, so anyone already signed in can approve it. A new
       operator has no account, and demanding one is what stopped the pairing dead. */
    expect(installer).toMatch(/Macs waiting to be approved/)
    expect(installer, 'sign-in must not be stated as the only way').not.toMatch(/Sign in if asked, check that it shows/)
  })
})
