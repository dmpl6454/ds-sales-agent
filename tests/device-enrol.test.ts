import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
// Revoking also releases the revoked Mac's NAME from presence (2026-10-09), so the file-I/O tests
// get a real Setting table too — never the suite's default database.
const DB_FILE = join(AK_DIR, 'enrol.db')
const boot = new Database(DB_FILE)
boot.exec(`CREATE TABLE "Setting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
boot.close()
process.env.DATABASE_URL = `file:${DB_FILE}`

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

/** A second, distinct, structurally valid ed25519 key — two Macs need two keys. */
function otherKey(byte: number): string {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const type = Buffer.from('ssh-ed25519')
  return `ssh-ed25519 ${Buffer.concat([u32(type.length), type, u32(32), Buffer.alloc(32, byte)]).toString('base64')}`
}

/**
 * REWRITTEN 2026-10-09, deliberately. This test used to write ONE key under two names and revoke
 * by name — the exact shape of the C4 finding: revoke matched the `ds-device:<name>` comment, so
 * revoking one of two Macs that SHARED a name removed both (MEASURED: paired 2 → 0). Revoking is
 * by key fingerprint now, so two Macs need two keys, and the name is no longer an argument at all.
 */
describe('listPairedDevices / revokePairedDevice — against a real authorized_keys file', () => {
  it('lists only the lines this flow wrote, and revoking by key removes exactly that Mac — even beside a namesake', async () => {
    const file = AK_FILE
    const { listPairedDevices, revokePairedDevice, authorizedKeyLine, keyFingerprint } = await import('@/lib/deviceEnrol')
    const K2 = otherKey(2)
    writeFileSync(
      file,
      [
        'ssh-ed25519 ' + B64 + ' tabish@dashmani.com', // a human's key — not ours to list or touch
        authorizedKeyLine(PUB, 'Mac Studio'),
        authorizedKeyLine(K2, 'Mac Studio'),
        '',
      ].join('\n'),
    )
    expect(listPairedDevices().map((d) => d.name)).toEqual(['Mac Studio', 'Mac Studio'])
    expect(listPairedDevices()[0]!.fingerprint).toBe(FPR)
    expect(await revokePairedDevice(FPR)).toBe(1)
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('tabish@dashmani.com') // untouched — the same key, but not a ds-device line
    expect(after).toContain(K2.split(' ')[1]!) // the namesake survives
    expect(listPairedDevices().map((d) => d.fingerprint)).toEqual([keyFingerprint(K2)])
    // A NAME is not a fingerprint and revokes nothing; neither does anything malformed.
    expect(await revokePairedDevice('Mac Studio')).toBe(0)
    expect(await revokePairedDevice('SHA256:bogus')).toBe(0)
    expect(listPairedDevices()).toHaveLength(1)
  })

  it('never removes a hand-added line, even when its key matches', async () => {
    const { revokePairedDevice } = await import('@/lib/deviceEnrol')
    writeFileSync(AK_FILE, ['ssh-ed25519 ' + B64 + ' tabish@dashmani.com', ''].join('\n'))
    expect(await revokePairedDevice(FPR)).toBe(0)
    expect(readFileSync(AK_FILE, 'utf8')).toContain('tabish@dashmani.com')
  })

  it('releases the revoked Mac\'s name from presence — its STALE entries only, never a fresh one or another key\'s', async () => {
    const { revokePairedDevice, authorizedKeyLine, keyFingerprint } = await import('@/lib/deviceEnrol')
    const { prisma } = await import('@/lib/db')
    const K2 = otherKey(2)
    writeFileSync(AK_FILE, [authorizedKeyLine(PUB, 'Mac Studio'), ''].join('\n'))
    const now = Date.now()
    const entries = [
      { device: 'Mac Studio', at: new Date(now - 3 * 3_600_000).toISOString(), handles: [], host: 'h-old' }, // stale, no key: released
      { device: 'Mac Studio', at: new Date(now - 3 * 3_600_000).toISOString(), handles: [], host: 'h-k2', keyFingerprint: keyFingerprint(K2) }, // another Mac's key: kept
      { device: 'Mac Studio', at: new Date(now - 10_000).toISOString(), handles: [], host: 'h-live' }, // fresh: kept until it reconnects
      { device: 'Elsewhere', at: new Date(now - 3 * 3_600_000).toISOString(), handles: [] }, // another name: kept
    ]
    await prisma.setting.upsert({
      where: { key: 'devicePresence' },
      update: { value: JSON.stringify(entries) },
      create: { key: 'devicePresence', value: JSON.stringify(entries) },
    })
    expect(await revokePairedDevice(FPR)).toBe(1)
    const left = JSON.parse((await prisma.setting.findUnique({ where: { key: 'devicePresence' } }))!.value) as { host?: string; device: string }[]
    expect(left.map((d) => d.host ?? d.device).sort()).toEqual(['Elsewhere', 'h-k2', 'h-live'])
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

  it('opens the hosted dashboard unless OUR app is the thing on :3100', () => {
    /*
     * A PORT PROBE PROVES A LISTENER, NOT THE RIGHT APP. The launcher opened localhost:3100
     * whenever anything answered there — and port 3100 is not exotic: this project moved off
     * 3000 precisely because another app on this machine had taken it. On a Mac with something
     * else listening, the icon opened a stranger's app and the person reported they "could not
     * sign in on the dashboard". Same lesson as the tunnel's `nc -z` check, which passed while
     * every real query died.
     */
    const l = readFileSync(join(repo, 'scripts/dmg/launcher.sh'), 'utf8')
    expect(l).toMatch(/<title>Instagram Outreach<\/title>/)
    expect(l, 'a bare port probe opens whatever is listening').not.toMatch(/if nc -z 127\.0\.0\.1 3100/)
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

/**
 * ── REVOKE IS BY KEY, END TO END (2026-10-09) ────────────────────────────────
 * The library half is driven above; this pins the two ends a person touches, because a form that
 * still posted the NAME would send `revokePairedDevice` a string that revokes nothing — a button
 * that silently does nothing, the failure this repo keeps finding.
 */
describe('the revoke button sends the key, and the action passes it on', () => {
  const repo = join(__dirname, '..')
  it('the form posts the fingerprint, and revokeDevice hands that — not the name — to revokePairedDevice', () => {
    const page = readFileSync(join(repo, 'src/app/senders/page.tsx'), 'utf8')
    expect(page).toMatch(/name="fingerprint" value=\{d\.fingerprint\}/)
    const actions = readFileSync(join(repo, 'src/app/actions.ts'), 'utf8')
    const fn = actions.slice(actions.indexOf('export async function revokeDevice'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/const fingerprint = String\(formData\.get\('fingerprint'\)/)
    expect(body).toMatch(/revokePairedDevice\(fingerprint\)/)
    expect(body).not.toMatch(/revokePairedDevice\(name\)/)
  })
})

/**
 * ── THE INSTALLER ASKS FOR ANOTHER NAME, AND CANNOT STRAND A MAC (2026-10-09) ──
 *
 * Comments are stripped before the order checks so a sentence ABOUT a line cannot satisfy them.
 */
describe('install.sh — one name per Mac', () => {
  const repo = join(__dirname, '..')
  const raw = readFileSync(join(repo, 'scripts/dmg/install.sh'), 'utf8')
  const sh = raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

  it('parses (bash -n)', async () => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('bash', ['-n', join(repo, 'scripts/dmg/install.sh')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })

  it('stamps .version only after the pairing and the tunnel, just before the agent restarts', () => {
    /* Stamped right after the unpack, an update that failed later left a matching version, and the
       launcher (sentinel + equal versions) never re-ran the installer: a Mac with a dead tunnel. */
    const stamp = sh.indexOf('cp "$RES/VERSION" "$DEST/.version"')
    expect(stamp).toBeGreaterThan(-1)
    expect(sh.indexOf('cp "$RES/VERSION"')).toBe(sh.lastIndexOf('cp "$RES/VERSION"'))
    expect(stamp).toBeGreaterThan(sh.lastIndexOf('pair_this_mac\n'))
    expect(stamp).toBeGreaterThan(sh.indexOf('tunnel is up'))
    expect(stamp).toBeLessThan(sh.indexOf('bash scripts/install-watch.sh install'))
  })

  it('offers the kept name only from a .env this installer finished, and never the placeholder', () => {
    const fn = sh.slice(sh.indexOf('pair_this_mac() {'))
    const guard = fn.indexOf('grep -qF "$ENV_DONE_MARK" "$DEST/.env"')
    const read = fn.indexOf('s/^DS_DEVICE_NAME=//p')
    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    expect(fn).toMatch(/\[ "\$DEFAULT_NAME" = "my-mac" \]/)
    expect(sh.indexOf('ENV_DONE_MARK="written by the DS Sales Agent installer"')).toBeLessThan(sh.indexOf('pair_this_mac() {'))
  })

  it('asks the dashboard without curl -f, re-asks for a name on "taken", and writes the server\'s name', () => {
    const fn = sh.slice(sh.indexOf('pair_this_mac() {'), sh.indexOf('\n}\n', sh.indexOf('pair_this_mac() {')))
    const start = fn.slice(fn.indexOf('/api/device/enrol/start') - 200, fn.indexOf('/api/device/enrol/start'))
    expect(start).toMatch(/curl -sS -X POST/)
    expect(start).not.toMatch(/curl -fsS/)
    expect(fn).toMatch(/taken\)[\s\S]*if ! NAME=\$\(ask /)
    expect(fn).toMatch(/\[ "\$TRIES" -lt 5 \]/)
    // The server's deviceName is cleaned and becomes NAME before write_env writes it.
    const adopt = fn.indexOf(`NAME="$(printf '%s' "$SERVER_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"`)
    expect(adopt).toBeGreaterThan(-1)
    expect(adopt).toBeLessThan(fn.indexOf('write_env "$DBURL" "$NAME"'))
    // A withdrawn request's reason is shown instead of "approve faster".
    expect(fn).toMatch(/\[ -n "\$REASON" \] && fail "\$REASON"/)
  })

  it('the response parser reads every answer the dashboard can give — run, not read', async () => {
    const { spawnSync } = await import('node:child_process')
    const m = /^START_PARSER='([^']*)'$/m.exec(raw)
    expect(m, 'START_PARSER must be one single-quoted line').not.toBeNull()
    const run = (body: string) => spawnSync('node', ['-e', m![1]!], { input: body, encoding: 'utf8' }).stdout.split('\n')
    expect(
      run(
        JSON.stringify({ userCode: 'ABCD2345', deviceCode: 'f'.repeat(64), deviceName: 'Mac Studio', approvePath: '/devices/enrol?code=ABCD2345' }),
      ).slice(0, 5),
    ).toEqual(['ok', 'ABCD2345', 'f'.repeat(64), '/devices/enrol?code=ABCD2345', 'Mac Studio'])
    expect(
      run(JSON.stringify({ error: 'The name “Mac Studio” is…', status: 'name-taken', deviceName: 'Mac Studio', suggestion: 'Mac Studio 2' })).slice(0, 3),
    ).toEqual(['taken', 'Mac Studio', 'Mac Studio 2'])
    // A shared paired name is not fixed by another name here: shown as the dashboard said it.
    expect(
      run(JSON.stringify({ error: 'This Mac is already paired as…', status: 'name-shared', deviceName: 'X', suggestion: null })).slice(0, 2),
    ).toEqual(['refused', 'This Mac is already paired as…'])
    expect(run(JSON.stringify({ error: 'too many Macs are waiting\nfor approval' })).slice(0, 2)).toEqual([
      'refused',
      'too many Macs are waiting for approval',
    ])
    expect(run('<html>502 Bad Gateway</html>')[0]).toBe('unreachable')
  })
})

/**
 * ── pair_this_mac, DRIVEN (2026-10-09) ───────────────────────────────────────
 *
 * The greps above pin shapes; this RUNS the installer's own pairing function, cut out of
 * install.sh byte for byte, in a fake HOME with the dashboard, Apple's dialogs and ssh-keygen
 * stubbed. A refused name must be asked for again, the dashboard's name must be the one written,
 * and every refusal must end the run with the dashboard's sentence — CLAUDE.md rule 37: a gate is
 * code, prove it refuses.
 */
describe('install.sh pair_this_mac against a stubbed dashboard', () => {
  const repo = join(__dirname, '..')
  const raw = readFileSync(join(repo, 'scripts/dmg/install.sh'), 'utf8')
  const helpers = raw.slice(raw.indexOf('esc() {'), raw.indexOf('bold "== DS Sales Agent setup =="'))
  const from = raw.indexOf('ENV_DONE_MARK="written by the DS Sales Agent installer"')
  const pairAt = raw.indexOf('pair_this_mac() {')
  const to = raw.indexOf('\n}\n', raw.indexOf('write_ssh_config "$SSH_HOST" "$SSH_USER"', pairAt)) + 3
  const block = raw.slice(from, to)
  const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFFan6luIIBgxby/pMXoNfmUzRGhZGXchva+YyWWm7Hm'

  const stubs = `
curl() {
  local url="\${@: -1}"
  case "$url" in
    */enrol/start)
      cat >> "$H/bodies"; echo >> "$H/bodies"
      echo "$*" >> "$H/curl-args"
      local n; n=$(cat "$H/n"); echo $((n+1)) > "$H/n"
      sed -n "$((n+1))p" "$H/start-responses" ;;
    */enrol/poll) cat "$H/poll-response" ;;
  esac
}
ssh-keygen() {
  if [ "$1" = "-lf" ]; then echo "256 SHA256:stubfingerprint ds-device (ED25519)"; return 0; fi
  local f=""; while [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done
  printf 'PRIVATE' > "$f"; printf '%s ds-device:x\\n' "${PUBKEY}" > "$f.pub"
}
open() { :; }
osascript() { :; }
scutil() { echo "Mac Studio"; }
sleep() { :; }
`

  function drive(opts: { start: object[]; poll?: object; keptEnv?: string; answers?: string[] }) {
    const home = mkdtempSync(join(tmpdir(), 'ds-pair-'))
    const H = join(home, 'harness')
    const dest = join(home, 'ds-sales-agent')
    mkdirSync(H, { recursive: true })
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, '.env.example'), 'DATABASE_URL=""\n')
    if (opts.keptEnv !== undefined) writeFileSync(join(dest, '.env'), opts.keptEnv)
    writeFileSync(join(H, 'n'), '0')
    writeFileSync(join(H, 'start-responses'), opts.start.map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(
      join(H, 'poll-response'),
      JSON.stringify(opts.poll ?? { status: 'approved', databaseUrl: 'postgresql://d@127.0.0.1:15432/db', sshHost: '203.0.113.7', sshUser: 'root', modelKey: '' }),
    )
    const script = [
      'set -euo pipefail',
      `export HOME=${JSON.stringify(home)} H=${JSON.stringify(H)} PUBKEY=${JSON.stringify(PUBKEY)}`,
      'RES="$HOME/res"; DEST="$HOME/ds-sales-agent"; DASHBOARD_URL="https://dash.example"',
      'LOG="$HOME/install.log"; KEY="$HOME/.ssh/ds_tunnel_key"; MODE=tty; MANUAL=0',
      helpers,
      stubs,
      block,
      'pair_this_mac',
      'echo "== DONE"',
    ].join('\n')
    const r = spawnSync('bash', ['-c', script], { input: (opts.answers ?? []).join('\n') + '\n', encoding: 'utf8' })
    const read = (p: string) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return ''
      }
    }
    const out = {
      status: r.status,
      stdout: r.stdout,
      env: read(join(dest, '.env')),
      bodies: read(join(H, 'bodies')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { deviceName: string }),
      curlArgs: read(join(H, 'curl-args')),
    }
    rmSync(home, { recursive: true, force: true })
    return out
  }
  const ok = (deviceName: string) => ({ userCode: 'ABCD2345', deviceCode: 'f'.repeat(64), approvePath: '/devices/enrol?code=ABCD2345', deviceName })
  const taken = (deviceName: string, suggestion: string) => ({ error: `The name “${deviceName}” is already used…`, status: 'name-taken', deviceName, suggestion })

  it('a taken name is asked for again with the suggestion, and the dashboard\'s name is what lands in .env', () => {
    const r = drive({ start: [taken('Mac Studio', 'Mac Studio 2'), ok('Mac Studio 2')], answers: ['', ''] })
    expect(r.status, r.stdout).toBe(0)
    expect(r.bodies.map((b) => b.deviceName)).toEqual(['Mac Studio', 'Mac Studio 2'])
    expect(r.env).toMatch(/^DS_DEVICE_NAME="Mac Studio 2"$/m)
    expect(r.curlArgs).not.toMatch(/(^| )-fsS( |$)/m)
    expect(r.stdout).toMatch(/Name: {2}Mac Studio 2/)
  })

  it('a key already paired keeps the paired name, whatever was typed', () => {
    const r = drive({ start: [ok('Office')], answers: ['Renamed Office'] })
    expect(r.status, r.stdout).toBe(0)
    expect(r.bodies[0]!.deviceName).toBe('Renamed Office')
    expect(r.env).toMatch(/^DS_DEVICE_NAME="Office"$/m)
  })

  it('offers the kept name from a finished .env — and never the example placeholder', () => {
    const kept = drive({ start: [ok('Kept Mac')], answers: [''], keptEnv: '# ── written by the DS Sales Agent installer ──\nDS_DEVICE_NAME="Kept Mac"\n' })
    expect(kept.bodies[0]!.deviceName).toBe('Kept Mac')
    const placeholder = drive({ start: [ok('Mac Studio')], answers: [''], keptEnv: '# ── written by the DS Sales Agent installer ──\nDS_DEVICE_NAME="my-mac"\n' })
    expect(placeholder.bodies[0]!.deviceName).toBe('Mac Studio')
    const unfinished = drive({ start: [ok('Mac Studio')], answers: [''], keptEnv: 'DS_DEVICE_NAME="Half Done"\n' })
    expect(unfinished.bodies[0]!.deviceName).toBe('Mac Studio')
  })

  it('five refusals end the run, writing nothing', () => {
    const t = taken('Mac Studio', 'Mac Studio 2')
    const r = drive({ start: [t, t, t, t, t, t], answers: ['', '', '', '', '', ''] })
    expect(r.status).not.toBe(0)
    expect(r.bodies).toHaveLength(5)
    expect(r.stdout).toMatch(/Could not find a free name/)
    expect(r.env).toBe('')
  })

  it('any other refusal shows the dashboard\'s own sentence, not "check the internet connection"', () => {
    const r = drive({ start: [{ error: 'too many Macs are waiting for approval right now — try again in a few minutes' }], answers: [''] })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/refused the pairing request: too many Macs are waiting/)
    expect(r.stdout).not.toMatch(/check the internet connection/)
  })

  it('a request withdrawn at approval says why, instead of "approve within 15 minutes"', () => {
    const r = drive({ start: [ok('Mac Studio')], answers: [''], poll: { status: 'unknown', reason: 'This pairing request was withdrawn: another Mac on this dashboard already uses the name “Mac Studio”.' } })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/withdrawn: another Mac/)
    expect(r.stdout).not.toMatch(/approve within 15 minutes/)
    expect(r.env).toBe('')
  })
})
