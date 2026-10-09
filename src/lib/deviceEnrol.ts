import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { keyFingerprint } from '@/lib/keyFingerprint'
import { DEVICE_PRESENCE_KEY, PRESENCE_FRESH_MS, readPresenceEntries, type DevicePresence } from '@/outreach/devicePresence'

export { keyFingerprint }

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
  /**
   * The name the Mac ASKED for, kept only when it differs from `deviceName` — a key already
   * paired under another name keeps that name (`decideEnrolName`), and the approval page says so.
   */
  requestedName?: string
  /**
   * Withdrawn at approval because its name was taken in the meantime (2026-10-09). Kept rather
   * than deleted so the installer's next poll can say WHY — a deleted row reads as "expired or
   * not found", whose remedy (approve faster) is the wrong one. Delivered once, then removed.
   */
  withdrawnAt?: string
  withdrawnReason?: string
}

// ── ONE NAME, ONE MAC (2026-10-09) ─────────────────────────────────────────────
//
// The device NAME is the only identity the runtime has: the sending Mac is `activeDevice ===
// deviceId()`, the send lock and the orphan sweep compare it, presence is keyed by it, the
// connect relay addresses it, and revoke matched it. Nothing checked that two Macs chose
// different ones — and the installer pre-fills ComputerName, so two "Mac Studio"s were the
// default. MEASURED against the real modules: both enrolments approved, both Macs believed they
// were the sending Mac, each took the send lock over the other's live drive, one parked the
// other's in-flight message, and revoking "Mac Studio" removed BOTH keys.
//
// So a name is checked against every place a Mac can already be holding it, before anything is
// written and again at approval. The KEY is the identity: a Mac re-pairing with the key it is
// already paired under is the same Mac, and keeps the name it is paired as.

/** How long a presence entry keeps its name reserved. A Mac with its lid shut for a week is still that Mac. */
export const NAME_RESERVED_MS = 30 * 24 * 60 * 60_000

/** Names compare as the server would store them, ignoring case — "Mac Studio" and "mac  studio" are one name to a person. */
export function nameKey(n: string): string {
  return sanitizeDeviceName(n).toLowerCase()
}

/** The base64 key itself, from a public key or an authorized_keys line (options and comment ignored). */
export function keyBlob(keyOrLine: string): string {
  const parts = keyOrLine.trim().split(/\s+/)
  const i = parts.indexOf('ssh-ed25519')
  return i >= 0 ? (parts[i + 1] ?? '') : ''
}

export interface PairedKeyLine {
  name: string
  blob: string
  fingerprint: string
  /** Written by this flow under KEY_RESTRICTIONS, rather than added to the file by hand. */
  restricted: boolean
}

/** One authorized_keys line, if it is one this flow recognises as a paired Mac (its comment). */
function parsePairedKeyLine(l: string): PairedKeyLine | null {
  const i = l.indexOf(` ${KEY_COMMENT_PREFIX}`)
  if (i < 0) return null
  const name = l.slice(i + 1 + KEY_COMMENT_PREFIX.length).trim()
  const parts = l.split(/\s+/)
  const typeIdx = parts.findIndex((p) => p === 'ssh-ed25519')
  if (typeIdx < 0 || !parts[typeIdx + 1]) return null
  const blob = parts[typeIdx + 1]!
  return { name, blob, fingerprint: keyFingerprint(`ssh-ed25519 ${blob}`), restricted: l.startsWith(KEY_RESTRICTIONS) }
}

/** A presence entry, as far as the name check cares: who, when, which machine, which key. */
export type NameClaim = Pick<DevicePresence, 'device' | 'at' | 'host' | 'keyFingerprint'>

export type EnrolNameDecision =
  | { kind: 'free'; name: string }
  /** This key is already paired; it keeps the name it is paired as, whatever it asked for. */
  | { kind: 'same-mac'; name: string }
  /** `shared`: this key's own paired name is carried by another Mac too — a new name cannot fix that here. */
  | { kind: 'taken'; name: string; suggestion: string | null; shared: boolean }

/**
 * PURE. May a Mac holding `publicKey` be paired as `requested`?
 *
 * A name is CLAIMED by another Mac when, ignoring case, it is carried by: a paired line with a
 * different key; a live, unapproved, non-withdrawn request with a different key; a presence entry
 * from the last `NAME_RESERVED_MS` whose key fingerprint is not this key's (an entry with NO
 * fingerprint counts — absence is not evidence it is us, and the maintainer's Mac pairs by a hand
 * key and is reserved only by its presence); or the selected sending Mac's name, unless a presence
 * entry under it carries this key. Thirty days rather than one heartbeat, because a Mac with its
 * lid closed for three minutes is still the Mac that owns its name.
 *
 * A name is SHARED — a narrower test — only on POSITIVE evidence of a second Mac: another paired
 * line, another live request, or a presence entry carrying a DIFFERENT fingerprint. An old agent's
 * fingerprint-less entry is most likely this very Mac, so it never makes a name shared.
 *
 * The key decides first. Already paired: keep that name (no authorized_keys rewrite), unless that
 * name is shared, which refuses — re-pairing must not re-bless an existing duplicate. Not paired:
 * the requested name, if nothing claims it.
 */
export function decideEnrolName(args: {
  requested: string
  publicKey: string
  lines: readonly PairedKeyLine[]
  pending: readonly Enrolment[]
  presence: readonly NameClaim[]
  activeDevice: string | null
  now: number
}): EnrolNameDecision {
  const requested = sanitizeDeviceName(args.requested)
  const blob = keyBlob(args.publicKey)
  const fp = keyFingerprint(args.publicKey)
  const presence = args.presence.filter((p) => {
    const t = new Date(p.at).getTime()
    return Number.isFinite(t) && args.now - t <= NAME_RESERVED_MS
  })
  const pending = args.pending.filter((e) => !e.approvedAt && !e.withdrawnAt && !enrolmentExpired(e.createdAt, args.now))
  const active = args.activeDevice !== null && args.activeDevice.trim() !== '' ? args.activeDevice : null

  const otherLine = (key: string) => args.lines.some((l) => l.blob !== blob && nameKey(l.name) === key)
  const otherRequest = (key: string) => pending.some((e) => keyBlob(e.publicKey) !== blob && nameKey(e.deviceName) === key)
  const claimed = (name: string): boolean => {
    const key = nameKey(name)
    if (otherLine(key) || otherRequest(key)) return true
    if (presence.some((p) => nameKey(p.device) === key && p.keyFingerprint !== fp)) return true
    if (active !== null && nameKey(active) === key) {
      return !presence.some((p) => nameKey(p.device) === key && p.keyFingerprint === fp)
    }
    return false
  }
  const shared = (name: string): boolean => {
    const key = nameKey(name)
    return (
      otherLine(key) ||
      otherRequest(key) ||
      presence.some((p) => nameKey(p.device) === key && p.keyFingerprint !== undefined && p.keyFingerprint !== fp)
    )
  }
  const suggest = (name: string): string | null => {
    const base = sanitizeDeviceName(name).replace(/ [2-9]$/, '')
    for (let n = 2; n <= 9; n++) {
      const suffix = ` ${n}`
      const candidate = `${base.slice(0, 40 - suffix.length).trim()}${suffix}`
      if (!claimed(candidate)) return candidate
    }
    return null
  }

  const ours = args.lines.filter((l) => l.blob === blob)
  const paired = ours.find((l) => nameKey(l.name) === nameKey(requested)) ?? ours[ours.length - 1]
  if (paired) {
    if (!shared(paired.name)) return { kind: 'same-mac', name: paired.name }
    return { kind: 'taken', name: paired.name, suggestion: suggest(paired.name), shared: true }
  }
  if (!claimed(requested)) return { kind: 'free', name: requested }
  return { kind: 'taken', name: requested, suggestion: suggest(requested), shared: false }
}

/**
 * The sentence a refused Mac shows. PUBLIC — `start` needs no session — so it never says WHICH
 * kind of holder it found (paired, waiting, online, selected to send): that would let anyone
 * guessing names learn which Mac sends.
 *
 * SO IT NAMES EVERY WAY A NAME FREES UP, NOT ONE (2026-10-09). It promised "remove it under
 * Senders → Paired Macs, and the name frees up" — false when the holder is the selected sending
 * Mac (revoking a key does not change the selection) or a Mac known only by its heartbeat, such as
 * one paired by a hand key (nothing of it is listed there). Whoever is told a remedy that does
 * nothing concludes the dashboard is broken. The figures come from the rules that enforce them.
 */
export function nameTakenReason(name: string, suggestion: string | null): string {
  const days = Math.round(NAME_RESERVED_MS / (24 * 60 * 60_000))
  const minutes = Math.round(ENROL_TTL_MS / 60_000)
  return (
    `The name “${name}” is already used by another Mac on this dashboard. Two Macs with one name would ` +
    `both act as that Mac, so this one needs its own — open DS Sales Agent and give it a different name` +
    `${suggestion ? ` (for example “${suggestion}”)` : ''}. If that other Mac is gone for good, whoever ` +
    'runs the dashboard can free the name under Senders: remove it from Paired Macs, and if it was the ' +
    `Sending Mac, choose a different one. A Mac not listed under Paired Macs gives its name up by itself ` +
    `${days} days after it last reported, or within ${minutes} minutes if it was only asking to be paired.`
  )
}

/**
 * The key that asked is already paired, under a name another Mac carries too. A new name cannot
 * fix that from here — the existing line is never rewritten — so the remedy is removing one.
 */
export function nameSharedReason(name: string): string {
  return (
    `This Mac is already paired as “${name}”, and another Mac on this dashboard uses that name too. Two ` +
    'Macs with one name would both act as that Mac, so this one cannot be paired again until one of them ' +
    'is removed — whoever runs the dashboard can remove one under Senders → Paired Macs (each is listed with ' +
    'its key), then open DS Sales Agent again.'
  )
}

const COULD_NOT_CHECK = 'could not check whether that name is free — try again in a minute'

/** Every source a name can be held by, read once. Throws when any read fails — the caller fails closed. */
async function readNameSources(): Promise<{ lines: PairedKeyLine[]; presence: NameClaim[]; activeDevice: string | null }> {
  const [presence, settings] = await Promise.all([readPresenceEntries(), getSettings()])
  return { lines: pairedKeyLines(), presence, activeDevice: settings.activeDevice }
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

export type StartRefusal = {
  ok: false
  reason: string
  /** Set only for a name refusal, which the route answers with 200 so installers in the field show the sentence. */
  code?: 'name-taken' | 'name-shared'
  name?: string
  suggestion?: string | null
}

export async function startEnrolment(input: {
  deviceName: string
  publicKey: string
}): Promise<{ ok: true; enrolment: Enrolment } | StartRefusal> {
  if (!isEd25519PublicKey(input.publicKey)) {
    return { ok: false, reason: 'publicKey must be a single ssh-ed25519 public key' }
  }
  const live = await pruneExpired(await listEnrolments())
  if (live.filter((e) => !e.approvedAt && !e.withdrawnAt).length >= MAX_PENDING_ENROLMENTS) {
    return { ok: false, reason: 'too many Macs are waiting for approval right now — try again in a few minutes' }
  }
  const requested = sanitizeDeviceName(input.deviceName)
  const blob = keyBlob(input.publicKey)

  // ONE NAME, ONE MAC (2026-10-09). Every read is inside the try: a name we could not check is
  // refused, never assumed free — "we could not ask" must not authorise a second Mac under a name.
  let decision: EnrolNameDecision
  try {
    const sources = await readNameSources()
    decision = decideEnrolName({ requested, publicKey: input.publicKey, pending: live, now: Date.now(), ...sources })
  } catch {
    return { ok: false, reason: COULD_NOT_CHECK }
  }
  if (decision.kind === 'taken') {
    const code = decision.shared ? 'name-shared' : 'name-taken'
    await auditNameRefusal(requested, `${keyFingerprint(input.publicKey)} asked for “${requested}” — ${code}`)
    return {
      ok: false,
      code,
      name: decision.name,
      suggestion: decision.suggestion,
      reason: decision.shared ? nameSharedReason(decision.name) : nameTakenReason(decision.name, decision.suggestion),
    }
  }

  // THE SAME MAC ASKING AGAIN SUPERSEDES ITS EARLIER REQUEST, so one Mac is one Approve row. Only
  // UNAPPROVED rows: an approved one may be a moment from being polled by a run still going, and
  // deleting it would turn that run's answer into "not found".
  let superseded = 0
  for (const old of live) {
    if (!old.approvedAt && keyBlob(old.publicKey) === blob) {
      await remove(old.userCode)
      superseded += 1
    }
  }

  const enrolment: Enrolment = {
    userCode: newUserCode(),
    deviceCode: randomBytes(32).toString('hex'),
    deviceName: decision.name,
    publicKey: input.publicKey.trim(),
    createdAt: new Date().toISOString(),
    ...(decision.name !== requested ? { requestedName: requested } : {}),
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
   *
   * Written only for a request that superseded nothing (2026-10-09): `start` is public, and a
   * caller looping on one key would otherwise write a row per call — each call now replaces the
   * last instead of piling up against MAX_PENDING_ENROLMENTS, which is what bounded this before.
   */
  if (superseded === 0) {
    await prisma.auditLog
      .create({
        data: {
          actor: `device:${enrolment.deviceName}`,
          action: 'device.enrol.requested',
          entity: `Device:${enrolment.deviceName}`,
          detail: `waiting for an operator to approve ${keyFingerprint(enrolment.publicKey)} — expires in 15 minutes${
            decision.kind === 'same-mac' ? ` (this key is already paired as “${decision.name}”)` : ''
          }`,
        },
      })
      .catch(() => undefined)
  }
  return { ok: true, enrolment }
}

/**
 * A refused name leaves a trace, BOUNDED: at most one row per name per fifteen minutes. A refusal
 * creates no enrolment row, so nothing else bounds it, and the endpoint is public. Never allowed
 * to change the answer.
 */
async function auditNameRefusal(name: string, detail: string): Promise<void> {
  try {
    const entity = `Device:${name}`
    const recent = await prisma.auditLog.findFirst({
      where: { action: 'device.enrol.refused-name', entity, at: { gte: new Date(Date.now() - ENROL_TTL_MS) } },
      select: { id: true },
    })
    if (recent) return
    await prisma.auditLog.create({ data: { actor: `device:${name}`, action: 'device.enrol.refused-name', entity, detail } })
  } catch {
    /* a missing audit row is worth less than an answer */
  }
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
    .filter((e) => !e.approvedAt && !e.withdrawnAt && !enrolmentExpired(e.createdAt))
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
  if (e.approvedAt) return { ok: true, deviceName: e.deviceName, fingerprint: keyFingerprint(e.publicKey) }
  if (e.withdrawnAt) return { ok: false, reason: e.withdrawnReason ?? 'this request was withdrawn' }

  /**
   * ASKED AGAIN AT THE MOMENT OF GRANTING (2026-10-09). `start` checked the name, but two Macs can
   * start in the same minute, a Mac can come online, and a selection can change in the fifteen
   * minutes a request waits. Waiting requests are deliberately NOT sources here: they are the
   * race, and counting them would withdraw whichever of two the operator approved FIRST — the
   * opposite of their click. The authoritative sources are the keys already granted, presence and
   * the selection, so the first approval wins and the second is withdrawn.
   *
   * Withdrawn, not deleted: the installer's next poll says WHY. And never approved on the strength
   * of the key alone — `start` has no proof the caller holds the private key, and approving
   * releases the database URL and the model key.
   */
  let decision: EnrolNameDecision
  try {
    const sources = await readNameSources()
    decision = decideEnrolName({ requested: e.deviceName, publicKey: e.publicKey, pending: [], now: Date.now(), ...sources })
  } catch {
    return { ok: false, reason: COULD_NOT_CHECK }
  }
  if (decision.kind === 'taken') {
    // A shared paired name is not fixed by a new name (the line is never rewritten): say so.
    const withdrawnReason = decision.shared
      ? `This pairing request was withdrawn. ${nameSharedReason(decision.name)}`
      : `This pairing request was withdrawn: another Mac on this dashboard already uses the name “${decision.name}”. ` +
        'Open DS Sales Agent again and give this Mac a different name.'
    await save({ ...e, withdrawnAt: new Date().toISOString(), withdrawnReason })
    return {
      ok: false,
      reason: `Another Mac on this dashboard now uses the name “${decision.name}”, so this request was withdrawn rather than approved. The Mac that asked is told why the next time it checks.`,
    }
  }
  // The name the key is actually paired under, so the poll hands back what authorized_keys says.
  const deviceName = decision.name
  appendAuthorizedKey(authorizedKeyLine(e.publicKey, deviceName))
  await save({ ...e, deviceName, approvedAt: new Date().toISOString(), approvedBy: actorEmail })
  return { ok: true, deviceName, fingerprint: keyFingerprint(e.publicKey) }
}

export type PollResult =
  | { status: 'pending'; deviceName: string }
  | {
      status: 'approved'
      deviceName: string
      databaseUrl: string
      sshHost: string
      sshUser: string
      /**
       * The classifier key, so a paired Mac can JUDGE the posts it stores when it reads the
       * feeds in the server's place (detection failover, 7 Sept 2026). Without it a failover
       * pass would store rows nothing judges. Null when the server itself has none.
       */
      modelKey: string | null
    }
  | { status: 'expired' }
  /** `reason` only for a request withdrawn at approval — once; the row goes with it. */
  | { status: 'unknown'; reason?: string }
  /**
   * THE SERVER CANNOT FINISH THIS PAIRING (9 Sept 2026). It has no endpoint to hand over —
   * `DEVICE_DATABASE_URL` or `DEVICE_SSH_HOST` is unset. The enrolment row is deliberately
   * KEPT, so fixing the server's .env lets the same waiting Mac complete instead of starting
   * again. Until today `DEVICE_SSH_HOST` fell back to a hardcoded address, and on the day that
   * address became another team's box a pairing would have succeeded and pointed an operator's
   * Mac at a stranger's server.
   */
  | { status: 'misconfigured'; missing: string[] }

/** The installer asks with its secret device code. Secrets are handed out ONCE; the row goes. */
export async function pollEnrolment(deviceCode: string): Promise<PollResult> {
  if (!/^[a-f0-9]{64}$/.test(deviceCode)) return { status: 'unknown' }
  const all = await listEnrolments()
  const e = all.find((x) => x.deviceCode === deviceCode)
  if (!e) return { status: 'unknown' }
  // Before expiry: a request withdrawn in its last minute must still say why.
  if (e.withdrawnAt) {
    await remove(e.userCode)
    return { status: 'unknown', reason: e.withdrawnReason ?? 'this pairing request was withdrawn' }
  }
  if (enrolmentExpired(e.createdAt)) {
    await remove(e.userCode)
    return { status: 'expired' }
  }
  if (!e.approvedAt) return { status: 'pending', deviceName: e.deviceName }
  // Checked BEFORE the row is removed: secrets are handed out once, so a hand-off that cannot
  // be completed must leave the request intact rather than burning it.
  const databaseUrl = env.DEVICE_DATABASE_URL
  const sshHost = env.DEVICE_SSH_HOST
  if (!databaseUrl || !sshHost) {
    return {
      status: 'misconfigured',
      missing: [...(databaseUrl ? [] : ['DEVICE_DATABASE_URL']), ...(sshHost ? [] : ['DEVICE_SSH_HOST'])],
    }
  }
  await remove(e.userCode)
  return {
    status: 'approved',
    deviceName: e.deviceName,
    databaseUrl,
    sshHost,
    sshUser: env.DEVICE_SSH_USER,
    modelKey: process.env.DEEPSEEK_API_KEY || null,
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

/** Every paired-Mac line, with its key — the name check needs the key, not only the name. */
export function pairedKeyLines(): PairedKeyLine[] {
  const out: PairedKeyLine[] = []
  for (const l of readAuthorizedKeys()) {
    const p = parsePairedKeyLine(l)
    if (p) out.push(p)
  }
  return out
}

/** The Macs paired through this flow — the lines this module wrote, recognised by their comment. */
export function listPairedDevices(): PairedDevice[] {
  return pairedKeyLines().map((l) => ({ name: l.name, fingerprint: l.fingerprint }))
}

export const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/

/**
 * Removes ONE Mac's tunnel key, by its fingerprint. Returns how many lines went.
 *
 * ── BY KEY, NEVER BY NAME (2026-10-09) ──────────────────────────────────────
 *
 * This matched the line's `ds-device:<name>` comment, so revoking one of two Macs that shared a
 * name removed BOTH keys — MEASURED: "Mac Studio" revoked, paired went from 2 to 0. A key is the
 * one thing two Macs cannot share. The `ds-device:` filter stays: this is reachable by an
 * operator's POST, and a crafted fingerprint must not be able to remove the management key or a
 * hand-added line.
 *
 * It also releases the NAME: presence now reserves a name for thirty days, so a revoked Mac's
 * old entry would go on claiming it. Only entries that are not FRESH are pruned — revoking does
 * not end an established tunnel (sshd reads authorized_keys at authentication), so a Mac still
 * beating keeps its entry and its name until it actually reconnects and fails.
 */
export async function revokePairedDevice(fingerprint: string): Promise<number> {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return 0
  const lines = readAuthorizedKeys()
  const names: string[] = []
  const kept = lines.filter((l) => {
    const p = parsePairedKeyLine(l)
    if (p === null || p.fingerprint !== fingerprint) return true
    names.push(p.name)
    return false
  })
  if (names.length === 0) return 0
  writeAuthorizedKeys(kept.filter((l) => l.length > 0))
  await pruneStalePresence(fingerprint, names).catch(() => undefined) // the key is gone either way
  return names.length
}

/** Drops the revoked Mac's NON-fresh presence entries, so its name stops being reserved. */
async function pruneStalePresence(fingerprint: string, names: readonly string[]): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })
  if (!row) return
  let all: DevicePresence[]
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return
    all = parsed as DevicePresence[]
  } catch {
    return
  }
  const now = Date.now()
  const wanted = new Set(names.map(nameKey))
  const kept = all.filter((d) => {
    if (now - new Date(d?.at).getTime() < PRESENCE_FRESH_MS) return true
    if (d.keyFingerprint === fingerprint) return false
    // An entry carrying ANOTHER key is another Mac's, whatever its name.
    return !(d.keyFingerprint === undefined && typeof d.device === 'string' && wanted.has(nameKey(d.device)))
  })
  if (kept.length === all.length) return
  // Conditional on the row being what was read: an agent's heartbeat landing in between wins.
  await prisma.setting.updateMany({ where: { key: DEVICE_PRESENCE_KEY, value: row.value }, data: { value: JSON.stringify(kept) } })
}
