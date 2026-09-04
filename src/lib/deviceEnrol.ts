import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'

/**
 * PAIRING A MAC WITHOUT HANDING ANYONE A SECRET (2026-09-03).
 *
 * Until now a new operator was handed three things person to person — the database URL, a
 * shared tunnel key FILE and a login — and typed or dragged them into a Terminal window.
 * Tabish: *"We want a seamless experience just download on their machine and run, no
 * terminal hassle."*
 *
 * So the installer OBTAINS its own credentials, the way `gh auth login` does:
 *
 *   1. the Mac generates its OWN ed25519 keypair (the private key never leaves it) and
 *      POSTs the public key + a device name to `/api/device/enrol/start` (public route —
 *      the Mac has no session yet), receiving a short USER CODE and a long secret DEVICE CODE;
 *   2. it opens the browser at `/devices/enrol?code=<user code>`; the operator — already
 *      signed in to the dashboard they downloaded the image from — sees the Mac's name and
 *      key fingerprint and clicks Approve, which appends the public key to the server's
 *      `authorized_keys` under the SAME forward-only restrictions the shared key carried
 *      (`restrict,port-forwarding,permitopen=…5432,command=/usr/bin/false`: no shell, no
 *      files, one port);
 *   3. the installer, POSTing the device code to `/api/device/enrol/poll` (in the body, never the URL — a
 *      query string is written to access logs), receives the
 *      database URL and the SSH endpoint ONCE, writes its .env and ssh config, and the row
 *      is deleted.
 *
 * WHAT THIS IMPROVES BEYOND CONVENIENCE: every Mac has its own key, so one machine's access
 * can be revoked without touching the others (`revokePairedDevice`) — the shared key made
 * that impossible. And the approval page shows the fingerprint the installer also shows, so
 * an operator approving a Mac they did not just set up has something to compare.
 *
 * BOUNDS, because `start` is public: codes are random (8-char user code, 32-byte device
 * code), enrolments expire in 15 minutes, at most 20 may be pending, an approval needs a
 * signed-in operator, and the key must parse as exactly one ed25519 public key — a newline
 * or a second key in the payload would otherwise become a second `authorized_keys` line.
 *
 * Pure helpers first (tested without a database), then the store, then the file I/O.
 */

export const ENROL_TTL_MS = 15 * 60_000
export const MAX_PENDING_ENROLMENTS = 20
export const KEY_COMMENT_PREFIX = 'ds-device:'
export const KEY_RESTRICTIONS =
  'restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="localhost:5432",command="/usr/bin/false"'
const SETTING_PREFIX = 'deviceEnrol:'

/** A name a person typed, made safe for a .env value, an authorized_keys comment and a screen. */
export function sanitizeDeviceName(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  return cleaned.length > 0 ? cleaned : 'mac'
}

/**
 * Exactly one ed25519 public key, optionally with a comment, and nothing else. The blob of an
 * ed25519 key is always 51 bytes (4+11 type, 4+32 key), so the base64 is checked by DECODING
 * it rather than by length alone. A CR or LF anywhere refuses: `authorized_keys` is
 * line-oriented, and a second line in the payload would be a second authorised key.
 */
export function isEd25519PublicKey(s: string): boolean {
  if (typeof s !== 'string' || /[\r\n]/.test(s)) return false
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]{60,80}={0,2})(?: ([^\s].{0,79}))?$/.exec(s.trim())
  if (!m) return false
  const blob = Buffer.from(m[1]!, 'base64')
  return blob.length === 51 && blob.subarray(4, 15).toString('latin1') === 'ssh-ed25519'
}

/** `SHA256:…` exactly as `ssh-keygen -lf` prints it, so a person can compare the two. */
export function keyFingerprint(publicKey: string): string {
  const b64 = publicKey.trim().split(/\s+/)[1] ?? ''
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/** The one line that gets appended. Restrictions first, then the key, then who it is. */
export function authorizedKeyLine(publicKey: string, deviceName: string): string {
  if (!isEd25519PublicKey(publicKey)) throw new Error('not a single ed25519 public key')
  const [type, b64] = publicKey.trim().split(/\s+/)
  return `${KEY_RESTRICTIONS} ${type} ${b64} ${KEY_COMMENT_PREFIX}${sanitizeDeviceName(deviceName)}`
}

export function enrolmentExpired(createdAt: string | Date, now: number = Date.now()): boolean {
  return now - new Date(createdAt).getTime() > ENROL_TTL_MS
}

/** Unambiguous characters only — this code is read off one screen and compared on another. */
export function newUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

export interface Enrolment {
  userCode: string
  deviceCode: string
  deviceName: string
  publicKey: string
  createdAt: string
  approvedAt?: string
  approvedBy?: string
}

// ── the store: one Setting row per pending pairing ────────────────────────────

async function listEnrolments(): Promise<Enrolment[]> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: SETTING_PREFIX } } })
  const out: Enrolment[] = []
  for (const r of rows) {
    try {
      const e = JSON.parse(r.value) as Enrolment
      if (e && typeof e.userCode === 'string' && typeof e.deviceCode === 'string') out.push(e)
    } catch {
      /* an unparsable row is pruned rather than trusted */
      await prisma.setting.delete({ where: { key: r.key } }).catch(() => undefined)
    }
  }
  return out
}

async function save(e: Enrolment): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_PREFIX + e.userCode },
    create: { key: SETTING_PREFIX + e.userCode, value: JSON.stringify(e) },
    update: { value: JSON.stringify(e) },
  })
}

async function remove(userCode: string): Promise<void> {
  await prisma.setting.delete({ where: { key: SETTING_PREFIX + userCode } }).catch(() => undefined)
}

async function pruneExpired(all: Enrolment[]): Promise<Enrolment[]> {
  const live: Enrolment[] = []
  for (const e of all) {
    if (enrolmentExpired(e.createdAt)) await remove(e.userCode)
    else live.push(e)
  }
  return live
}

export async function startEnrolment(input: {
  deviceName: string
  publicKey: string
}): Promise<{ ok: true; enrolment: Enrolment } | { ok: false; reason: string }> {
  if (!isEd25519PublicKey(input.publicKey)) {
    return { ok: false, reason: 'publicKey must be a single ssh-ed25519 public key' }
  }
  const live = await pruneExpired(await listEnrolments())
  if (live.filter((e) => !e.approvedAt).length >= MAX_PENDING_ENROLMENTS) {
    return { ok: false, reason: 'too many Macs are waiting for approval right now — try again in a few minutes' }
  }
  const enrolment: Enrolment = {
    userCode: newUserCode(),
    deviceCode: randomBytes(32).toString('hex'),
    deviceName: sanitizeDeviceName(input.deviceName),
    publicKey: input.publicKey.trim(),
    createdAt: new Date().toISOString(),
  }
  await save(enrolment)
  /**
   * A MAC ASKING LEAVES A TRACE (2026-09-04). This wrote nothing at all, so when a second
   * operator's install went unapproved there was no way to tell "the installer never phoned
   * home" from "it did, and nobody approved inside fifteen minutes" — two problems with
   * completely different remedies, indistinguishable from the server afterwards. The actor is
   * the DEVICE, because this path is public by necessity: the Mac has no session yet.
   *
   * Never allowed to fail the enrolment: a missing audit row is worth less than a pairing.
   */
  await prisma.auditLog
    .create({
      data: {
        actor: `device:${enrolment.deviceName}`,
        action: 'device.enrol.requested',
        entity: `Device:${enrolment.deviceName}`,
        detail: `waiting for an operator to approve ${keyFingerprint(enrolment.publicKey)} — expires in 15 minutes`,
      },
    })
    .catch(() => undefined)
  return { ok: true, enrolment }
}

/**
 * EVERY MAC CURRENTLY WAITING FOR APPROVAL — the list that did not exist (2026-09-04).
 *
 * ── WHY THIS IS THE LOAD-BEARING HALF OF THE FIX ────────────────────────────
 *
 * A second operator ran the installer and **nothing appeared anywhere.** MEASURED afterwards:
 * 0 pending rows, and 0 `device.paired` audit rows other than the 3 September tests. The
 * installer was fine. The pairing was INVISIBLE.
 *
 * `findByUserCode` was the ONLY reader, and it needs the exact code out of the URL the
 * installer opened. `/senders` → Paired Macs reads `authorized_keys`, so it lists devices that
 * are ALREADY approved and can never show one that is waiting. So the moment that URL was lost
 * — and it was lost for everyone, see the `next` fix in `devices/enrol/page.tsx` — the request
 * existed, expired after fifteen minutes and left no trace on any screen.
 *
 * That is this project's most expensive recurring failure, in the one flow a new operator meets
 * first: *nothing renders an absence*. A pending pairing is now on `/senders` beside the paired
 * ones, so approving it needs no URL, no code and nothing remembered.
 *
 * Expired rows are filtered rather than shown: a person cannot act on one, and the installer's
 * own message already says to run it again.
 */
export async function listPendingEnrolments(): Promise<
  { userCode: string; deviceName: string; fingerprint: string; createdAt: string }[]
> {
  const live = await listEnrolments()
  return live
    .filter((e) => !e.approvedAt && !enrolmentExpired(e.createdAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e) => ({
      userCode: e.userCode,
      deviceName: e.deviceName,
      fingerprint: keyFingerprint(e.publicKey),
      createdAt: e.createdAt,
    }))
}

export async function findByUserCode(userCode: string): Promise<Enrolment | null> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_PREFIX + userCode.trim().toUpperCase() } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as Enrolment
  } catch {
    return null
  }
}

/**
 * The operator's click. Refuses anywhere that is not the hosted server: a laptop running
 * `pnpm local` has no `authorized_keys` to grant and no tunnel URL to hand out, and writing a
 * key into a developer's own ~/.ssh by mistake is the kind of thing that must fail closed.
 */
export async function approveEnrolment(
  userCode: string,
  actorEmail: string,
): Promise<{ ok: true; deviceName: string; fingerprint: string } | { ok: false; reason: string }> {
  if (env.SEND_ENABLED) {
    return { ok: false, reason: 'pairing is approved on the hosted dashboard, not on a sending machine' }
  }
  if (!env.DEVICE_DATABASE_URL) {
    return { ok: false, reason: 'the server has no DEVICE_DATABASE_URL configured — nothing to hand a paired Mac' }
  }
  const e = await findByUserCode(userCode)
  if (!e) return { ok: false, reason: 'no Mac is waiting under that code — it may have expired; run the installer again' }
  if (enrolmentExpired(e.createdAt)) {
    await remove(e.userCode)
    return { ok: false, reason: 'that request expired (15 minutes) — run the installer again and approve promptly' }
  }
  if (!e.approvedAt) {
    appendAuthorizedKey(authorizedKeyLine(e.publicKey, e.deviceName))
    await save({ ...e, approvedAt: new Date().toISOString(), approvedBy: actorEmail })
  }
  return { ok: true, deviceName: e.deviceName, fingerprint: keyFingerprint(e.publicKey) }
}

export type PollResult =
  | { status: 'pending'; deviceName: string }
  | { status: 'approved'; deviceName: string; databaseUrl: string; sshHost: string; sshUser: string }
  | { status: 'expired' }
  | { status: 'unknown' }

/** The installer asks with its secret device code. Secrets are handed out ONCE; the row goes. */
export async function pollEnrolment(deviceCode: string): Promise<PollResult> {
  if (!/^[a-f0-9]{64}$/.test(deviceCode)) return { status: 'unknown' }
  const all = await listEnrolments()
  const e = all.find((x) => x.deviceCode === deviceCode)
  if (!e) return { status: 'unknown' }
  if (enrolmentExpired(e.createdAt)) {
    await remove(e.userCode)
    return { status: 'expired' }
  }
  if (!e.approvedAt) return { status: 'pending', deviceName: e.deviceName }
  await remove(e.userCode)
  return {
    status: 'approved',
    deviceName: e.deviceName,
    databaseUrl: env.DEVICE_DATABASE_URL ?? '',
    sshHost: env.DEVICE_SSH_HOST,
    sshUser: env.DEVICE_SSH_USER,
  }
}

// ── authorized_keys ────────────────────────────────────────────────────────────

function keysPath(): string {
  return env.DEVICE_AUTHORIZED_KEYS
}

export function readAuthorizedKeys(): string[] {
  const p = keysPath()
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n')
}

/** Atomic: write beside, chmod 600, rename. A half-written authorized_keys locks everyone out. */
function writeAuthorizedKeys(lines: string[]): void {
  const p = keysPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(p), `.authorized_keys.${process.pid}.tmp`)
  const body = lines.join('\n').replace(/\n*$/, '\n')
  writeFileSync(tmp, body, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
}

function appendAuthorizedKey(line: string): void {
  const lines = readAuthorizedKeys().filter((l) => l.length > 0)
  const blob = line.split(/\s+/).find((t) => /^AAAA/.test(t))
  if (blob && lines.some((l) => l.includes(blob))) return // the same key twice is one key
  writeAuthorizedKeys([...lines, line])
}

export interface PairedDevice {
  name: string
  fingerprint: string
}

/** The Macs paired through this flow — the lines this module wrote, recognised by their comment. */
export function listPairedDevices(): PairedDevice[] {
  const out: PairedDevice[] = []
  for (const l of readAuthorizedKeys()) {
    const i = l.indexOf(` ${KEY_COMMENT_PREFIX}`)
    if (i < 0) continue
    const name = l.slice(i + 1 + KEY_COMMENT_PREFIX.length).trim()
    const parts = l.split(/\s+/)
    const typeIdx = parts.findIndex((p) => p === 'ssh-ed25519')
    if (typeIdx < 0 || !parts[typeIdx + 1]) continue
    out.push({ name, fingerprint: keyFingerprint(`ssh-ed25519 ${parts[typeIdx + 1]}`) })
  }
  return out
}

/** Removes every key line carrying this device's comment. Returns how many went. */
export function revokePairedDevice(name: string): number {
  const wanted = ` ${KEY_COMMENT_PREFIX}${sanitizeDeviceName(name)}`
  const lines = readAuthorizedKeys()
  const kept = lines.filter((l) => !l.endsWith(wanted))
  const removed = lines.length - kept.length
  if (removed > 0) writeAuthorizedKeys(kept.filter((l) => l.length > 0))
  return removed
}
