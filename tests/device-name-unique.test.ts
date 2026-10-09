import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ONE NAME, ONE MAC — the C4 finding of the 9 October audit (2026-10-09).
 *
 * The device NAME is the only identity the runtime has: the sending Mac is `activeDevice ===
 * deviceId()`, the send lock compares names, presence is keyed by name, revoke matched names. And
 * nothing checked that two Macs chose different ones — the installer pre-fills ComputerName, so
 * two "Mac Studio"s was the DEFAULT. MEASURED against the real modules before this: both
 * enrolments approved, both Macs active, each took the send lock over the other's live drive.
 *
 * The decision is pure and is driven first; then the real `startEnrolment` / `approveEnrolment` /
 * `pollEnrolment` and the public route, over a real SQLite file and a real authorized_keys file.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-name-unique-'))
const dbPath = join(dir, 'names.db')
const AK_FILE = join(dir, 'authorized_keys')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

// `@/lib/env` parses process.env once, on the first import — so all of this before any import.
process.env.DATABASE_URL = `file:${dbPath}`
process.env.DEVICE_AUTHORIZED_KEYS = AK_FILE
process.env.SEND_ENABLED = 'false'
process.env.DEVICE_DATABASE_URL = 'postgresql://device@127.0.0.1:15432/ds_sales_agent'
process.env.DEVICE_SSH_HOST = '203.0.113.7'

const { prisma } = await import('@/lib/db')
const enrol = await import('@/lib/deviceEnrol')
const {
  decideEnrolName,
  keyFingerprint,
  keyBlob,
  authorizedKeyLine,
  startEnrolment,
  approveEnrolment,
  pollEnrolment,
  listPendingEnrolments,
  NAME_RESERVED_MS,
} = enrol

/** A structurally valid ed25519 public key whose 32 key bytes are all `byte` — distinct per byte. */
function edKey(byte: number): string {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const type = Buffer.from('ssh-ed25519')
  return `ssh-ed25519 ${Buffer.concat([u32(type.length), type, u32(32), Buffer.alloc(32, byte)]).toString('base64')}`
}
const K1 = edKey(1)
const K2 = edKey(2)
const K3 = edKey(3)
const line = (pub: string, name: string) => ({ name, blob: keyBlob(pub), fingerprint: keyFingerprint(pub), restricted: true })
const NOW = Date.parse('2026-10-09T10:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const pendingRow = (pub: string, name: string): import('@/lib/deviceEnrol').Enrolment => ({
  userCode: 'X' + name.length,
  deviceCode: 'd'.repeat(64),
  deviceName: name,
  publicKey: pub,
  createdAt: ago(60_000),
})
const base = { lines: [], pending: [], presence: [], activeDevice: null, now: NOW }

describe('decideEnrolName — the pure rule', () => {
  it('a name a waiting request already carries is taken, and the suggestion is the next free one', () => {
    const d = decideEnrolName({ ...base, requested: 'Mac Studio', publicKey: K2, pending: [pendingRow(K1, 'Mac Studio')] })
    expect(d).toEqual({ kind: 'taken', name: 'Mac Studio', suggestion: 'Mac Studio 2', shared: false })
  })

  it('names compare after cleaning and ignoring case — "mac  studio" is "Mac Studio" to a person', () => {
    const d = decideEnrolName({ ...base, requested: 'mac  studio', publicKey: K2, lines: [line(K1, 'Mac Studio')] })
    expect(d.kind).toBe('taken')
  })

  it('a hand-paired Mac (no ds-device line) keeps its name reserved far longer than one heartbeat', () => {
    // The maintainer's Mac pairs by its own key, so presence is its only claim. A lid closed for
    // three minutes must not free the name; thirty days does.
    for (const age of [3 * 60_000, 3 * 24 * 3_600_000]) {
      const d = decideEnrolName({ ...base, requested: 'tabish-mac', publicKey: K2, presence: [{ device: 'tabish-mac', at: ago(age) }] })
      expect(d.kind, `age=${age}`).toBe('taken')
    }
    const old = decideEnrolName({ ...base, requested: 'tabish-mac', publicKey: K2, presence: [{ device: 'tabish-mac', at: ago(31 * 24 * 3_600_000) }] })
    expect(old.kind).toBe('free')
    expect(NAME_RESERVED_MS).toBe(30 * 24 * 3_600_000)
  })

  it('the selected sending Mac\'s name cannot be inherited by a newcomer', () => {
    const d = decideEnrolName({ ...base, requested: 'DMPLs Mac Studio', publicKey: K2, activeDevice: 'DMPLs Mac Studio' })
    expect(d.kind).toBe('taken')
  })

  it('a Mac is not refused by its OWN heartbeat — the fingerprint says it is us; no fingerprint, it does not', () => {
    const presence = [{ device: 'Studio', at: ago(30_000), keyFingerprint: keyFingerprint(K1) }]
    expect(decideEnrolName({ ...base, requested: 'Studio', publicKey: K1, presence, activeDevice: 'Studio' }).kind).toBe('free')
    const blind = [{ device: 'Studio', at: ago(30_000) }]
    expect(decideEnrolName({ ...base, requested: 'Studio', publicKey: K1, presence: blind, activeDevice: 'Studio' }).kind).toBe('taken')
  })

  it('a key already paired keeps the name it is paired as, whatever it asked for', () => {
    const d = decideEnrolName({ ...base, requested: 'Renamed Office', publicKey: K1, lines: [line(K1, 'Office')] })
    expect(d).toEqual({ kind: 'same-mac', name: 'Office' })
  })

  it('re-pairing does not re-bless an existing duplicate — a shared paired name is refused', () => {
    const lines = [line(K1, 'Mac Studio'), line(K2, 'Mac Studio')]
    const d = decideEnrolName({ ...base, requested: 'Mac Studio', publicKey: K2, lines })
    expect(d.kind).toBe('taken')
    if (d.kind === 'taken') expect(d.shared).toBe(true)
  })

  it('an old agent\'s fingerprint-less entry under our own paired name is not a second Mac', () => {
    const d = decideEnrolName({
      ...base,
      requested: 'Mac Studio',
      publicKey: K1,
      lines: [line(K1, 'Mac Studio')],
      presence: [{ device: 'Mac Studio', at: ago(10_000) }],
    })
    expect(d).toEqual({ kind: 'same-mac', name: 'Mac Studio' })
  })

  it('a presence entry carrying a DIFFERENT key under our paired name IS a second Mac', () => {
    const d = decideEnrolName({
      ...base,
      requested: 'Mac Studio',
      publicKey: K1,
      lines: [line(K1, 'Mac Studio')],
      presence: [{ device: 'Mac Studio', at: ago(10_000), keyFingerprint: keyFingerprint(K3) }],
    })
    expect(d.kind).toBe('taken')
  })

  it('the suggestion skips claimed names and stays inside 40 characters', () => {
    const d = decideEnrolName({ ...base, requested: 'Mac Studio', publicKey: K3, lines: [line(K1, 'Mac Studio'), line(K2, 'Mac Studio 2')] })
    expect(d.kind === 'taken' && d.suggestion).toBe('Mac Studio 3')
    const long = 'L'.repeat(40)
    const d2 = decideEnrolName({ ...base, requested: long, publicKey: K2, lines: [line(K1, long)] })
    expect(d2.kind === 'taken' && d2.suggestion).toBe(`${'L'.repeat(38)} 2`)
  })

  it('an expired, approved or withdrawn request claims nothing', () => {
    const expired = { ...pendingRow(K1, 'Mac Studio'), createdAt: ago(16 * 60_000) }
    const approved = { ...pendingRow(K1, 'Mac Studio'), approvedAt: ago(1000) }
    const withdrawn = { ...pendingRow(K1, 'Mac Studio'), withdrawnAt: ago(1000) }
    for (const p of [expired, approved, withdrawn]) {
      expect(decideEnrolName({ ...base, requested: 'Mac Studio', publicKey: K2, pending: [p] }).kind).toBe('free')
    }
  })
})

// ── the real functions, over a real database and a real authorized_keys file ──────────────

const enrolRows = async () => (await prisma.setting.findMany({ where: { key: { startsWith: 'deviceEnrol:' } } })).map((r) => JSON.parse(r.value) as import('@/lib/deviceEnrol').Enrolment)

beforeEach(async () => {
  await prisma.setting.deleteMany()
  await prisma.auditLog.deleteMany()
  writeFileSync(AK_FILE, '')
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('startEnrolment refuses a second Mac under a name', () => {
  it('two Macs, one name: the second is refused with a suggestion, and only one request waits', async () => {
    const a = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 })
    expect(a.ok).toBe(true)
    const b = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K2 })
    expect(b.ok).toBe(false)
    if (b.ok) throw new Error('unreachable')
    expect(b.code).toBe('name-taken')
    expect(b.suggestion).toBe('Mac Studio 2')
    expect(await enrolRows()).toHaveLength(1)
  })

  it('the same Mac asking twice is accepted, and its newer request supersedes the older', async () => {
    const a = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 })
    const b = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 })
    expect(a.ok && b.ok).toBe(true)
    const rows = await enrolRows()
    expect(rows).toHaveLength(1)
    expect(b.ok && rows[0]!.userCode).toBe(b.ok ? b.enrolment.userCode : '')
  })

  it('supersede spares an approved row a running installer is about to poll', async () => {
    const a = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 })
    if (!a.ok) throw new Error('start refused')
    expect((await approveEnrolment(a.enrolment.userCode, 'op@example.com')).ok).toBe(true)
    // The installer is opened again before the first run's poll lands.
    const again = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 })
    expect(again.ok).toBe(true)
    const polled = await pollEnrolment(a.enrolment.deviceCode)
    expect(polled.status).toBe('approved')
  })

  it('a key already paired keeps its paired name — the poll hands that name back, and no second line is written', async () => {
    writeFileSync(AK_FILE, authorizedKeyLine(K1, 'Office') + '\n')
    const r = await startEnrolment({ deviceName: 'Renamed Office', publicKey: K1 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.enrolment.deviceName).toBe('Office')
    expect(r.enrolment.requestedName).toBe('Renamed Office')
    expect((await approveEnrolment(r.enrolment.userCode, 'op@example.com')).ok).toBe(true)
    const polled = await pollEnrolment(r.enrolment.deviceCode)
    expect(polled.status === 'approved' && polled.deviceName).toBe('Office')
    expect(readFileSync(AK_FILE, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('an EXISTING duplicate is not re-blessed: a key paired under a shared name is refused whatever it asks for', async () => {
    // Two keys paired as "Mac Studio" before this check existed. Re-pairing either must not hand
    // it the shared name again, and a new name cannot fix it from here (the line is never
    // rewritten), so the answer is `name-shared` — which the installer shows rather than re-asking.
    writeFileSync(AK_FILE, [authorizedKeyLine(K1, 'Mac Studio'), authorizedKeyLine(K2, 'Mac Studio'), ''].join('\n'))
    for (const asked of ['Mac Studio', 'Mac Studio 2']) {
      const r = await startEnrolment({ deviceName: asked, publicKey: K2 })
      expect(r.ok, asked).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.code).toBe('name-shared')
      expect(r.reason).toMatch(/already paired as “Mac Studio”, and another Mac/)
    }
    expect(await enrolRows()).toHaveLength(0)
    const { POST } = await import('@/app/api/device/enrol/start/route')
    const res = await POST(new Request('http://x/api/device/enrol/start', { method: 'POST', body: JSON.stringify({ deviceName: 'Mac Studio', publicKey: K1 }) }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('name-shared')
  })

  it('a refused name leaves ONE audit row per fifteen minutes, and the public sentence names no source', async () => {
    writeFileSync(AK_FILE, authorizedKeyLine(K1, 'Mac Studio') + '\n')
    await prisma.setting.create({ data: { key: 'activeDevice', value: 'Mac Studio' } })
    const reasons: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K2 })
      expect(r.ok).toBe(false)
      if (!r.ok) reasons.push(r.reason)
    }
    expect(await prisma.auditLog.count({ where: { action: 'device.enrol.refused-name' } })).toBe(1)
    for (const reason of reasons) {
      expect(reason).toMatch(/another Mac/)
      // Which kind of holder it found — paired, waiting, online, selected — is not said publicly.
      // This was a word list (selected|online|sending|waiting) until the sentence had to name every
      // remedy, one of which is choosing a different Sending Mac; the property is now asserted
      // directly — the sentence is built from the name and suggestion alone, and the remedy block
      // below shows it is the same for all four kinds of holder.
      expect(reason).toBe(enrol.nameTakenReason('Mac Studio', 'Mac Studio 2'))
      expect(reason).not.toMatch(/already paired|is paired/i)
    }
  })

  it('a name that cannot be checked is refused, never assumed free', async () => {
    rmSync(AK_FILE, { force: true })
    mkdirSync(AK_FILE) // reading authorized_keys now throws (EISDIR)
    try {
      const r = await startEnrolment({ deviceName: 'Fresh Mac', publicKey: K3 })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/could not check/)
      expect(await enrolRows()).toHaveLength(0)
    } finally {
      rmSync(AK_FILE, { recursive: true, force: true })
      writeFileSync(AK_FILE, '')
    }
  })
})

/**
 * ── THE REFUSAL'S REMEDY MUST WORK FOR WHATEVER HOLDS THE NAME (2026-10-09) ──
 *
 * The sentence promised "remove it under Senders → Paired Macs, and the name frees up". MEASURED by
 * the review: when the holder is the selected sending Mac, or a Mac known only by its heartbeat (the
 * maintainer's hand-key Mac), there is nothing under Paired Macs to remove and the name stays taken.
 * Each case here holds the name one way, follows the remedy the sentence offers for that way, and
 * the same newcomer must then be accepted. The sentence itself must be the same in every case — it
 * is public, and which kind of holder exists is not something a stranger guessing names may learn.
 */
describe('the taken-name sentence offers a remedy that frees the name, whatever holds it', () => {
  const DAY = 24 * 3_600_000
  const setPresence = (at: string) =>
    prisma.setting.upsert({
      where: { key: 'devicePresence' },
      update: { value: JSON.stringify([{ device: 'Mac Studio', at, handles: [] }]) },
      create: { key: 'devicePresence', value: JSON.stringify([{ device: 'Mac Studio', at, handles: [] }]) },
    })
  const cases: Array<{ holder: string; hold: () => Promise<unknown>; remedy: RegExp; follow: () => Promise<unknown> }> = [
    {
      holder: 'a paired Mac',
      hold: async () => writeFileSync(AK_FILE, authorizedKeyLine(K1, 'Mac Studio') + '\n'),
      remedy: /Paired Macs/,
      follow: () => enrol.revokePairedDevice(keyFingerprint(K1)),
    },
    {
      holder: 'the selected sending Mac',
      hold: () => prisma.setting.create({ data: { key: 'activeDevice', value: 'Mac Studio' } }),
      remedy: /Sending Mac/,
      follow: () => prisma.setting.update({ where: { key: 'activeDevice' }, data: { value: 'Office' } }),
    },
    {
      holder: 'a Mac known only by its heartbeat',
      hold: () => setPresence(new Date(Date.now() - 3_600_000).toISOString()),
      remedy: new RegExp(`${NAME_RESERVED_MS / DAY} days`),
      follow: () => setPresence(new Date(Date.now() - NAME_RESERVED_MS - DAY).toISOString()),
    },
    {
      holder: 'a Mac still asking to be paired',
      hold: () => startEnrolment({ deviceName: 'Mac Studio', publicKey: K1 }),
      remedy: /15 minutes/,
      follow: async () => {
        const [row] = await enrolRows()
        await prisma.setting.update({
          where: { key: `deviceEnrol:${row!.userCode}` },
          data: { value: JSON.stringify({ ...row, createdAt: new Date(Date.now() - 16 * 60_000).toISOString() }) },
        })
      },
    },
  ]

  it('each holder: the sentence names its remedy, and following it frees the name', async () => {
    const reasons: string[] = []
    for (const c of cases) {
      await prisma.setting.deleteMany()
      writeFileSync(AK_FILE, '')
      await c.hold()
      const refused = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K2 })
      expect(refused.ok, c.holder).toBe(false)
      if (refused.ok) throw new Error('unreachable')
      expect(refused.code, c.holder).toBe('name-taken')
      reasons.push(refused.reason)
      expect(refused.reason, c.holder).toMatch(c.remedy)
      await c.follow()
      const accepted = await startEnrolment({ deviceName: 'Mac Studio', publicKey: K2 })
      expect(accepted.ok, `${c.holder}, after its remedy`).toBe(true)
    }
    // One sentence for every holder: which kind exists is not said to the public.
    expect(new Set(reasons).size).toBe(1)
  })
})

describe('approveEnrolment asks again, and withdraws rather than deletes', () => {
  /** Two requests that both passed `start` in the same minute — written directly, as the race leaves them. */
  async function raced() {
    const mk = (code: string, pub: string, dc: string) =>
      prisma.setting.create({
        data: {
          key: `deviceEnrol:${code}`,
          value: JSON.stringify({ userCode: code, deviceCode: dc, deviceName: 'Mac Studio', publicKey: pub, createdAt: new Date().toISOString() }),
        },
      })
    await mk('AAAA1111', K1, 'a'.repeat(64))
    await mk('BBBB2222', K2, 'b'.repeat(64))
  }

  it('the first approval wins; the second is withdrawn, and exactly one line carries the name', async () => {
    await raced()
    expect((await approveEnrolment('AAAA1111', 'op@example.com')).ok).toBe(true)
    const second = await approveEnrolment('BBBB2222', 'op@example.com')
    expect(second.ok).toBe(false)
    const lines = readFileSync(AK_FILE, 'utf8').split('\n').filter((l) => l.endsWith(' ds-device:Mac Studio'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(keyBlob(K1))
    expect((await listPendingEnrolments()).map((p) => p.userCode)).not.toContain('BBBB2222')
  })

  it('the withdrawn Mac\'s next poll says why, once; after that the row is gone', async () => {
    await raced()
    await approveEnrolment('AAAA1111', 'op@example.com')
    await approveEnrolment('BBBB2222', 'op@example.com')
    const first = await pollEnrolment('b'.repeat(64))
    expect(first.status).toBe('unknown')
    expect(first.status === 'unknown' && first.reason).toMatch(/another Mac/)
    const second = await pollEnrolment('b'.repeat(64))
    expect(second).toEqual({ status: 'unknown' })
  })

  it('a withdrawn request cannot be approved afterwards — not even once the name is free again', async () => {
    await raced()
    await approveEnrolment('AAAA1111', 'op@example.com')
    await approveEnrolment('BBBB2222', 'op@example.com')
    expect((await approveEnrolment('BBBB2222', 'op@example.com')).ok).toBe(false)
    // The other Mac is removed, so the name is free — but the installer that asked has been (or is
    // about to be) told its request was withdrawn. Approving it now would hand the secrets to a run
    // that has already given up; it must ask again.
    writeFileSync(AK_FILE, '')
    expect((await approveEnrolment('BBBB2222', 'op@example.com')).ok).toBe(false)
    expect(readFileSync(AK_FILE, 'utf8')).toBe('')
  })
})

describe('the public route answers a taken name with 200 and the sentence first', () => {
  it('200, error first, a status installers can read, no userCode, not cached', async () => {
    const { POST } = await import('@/app/api/device/enrol/start/route')
    const call = (deviceName: string, publicKey: string) =>
      POST(new Request('http://x/api/device/enrol/start', { method: 'POST', body: JSON.stringify({ deviceName, publicKey }) }))
    expect((await call('Mac Studio', K1)).status).toBe(200)
    const res = await call('Mac Studio', K2)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text.startsWith('{"error":')).toBe(true)
    const body = JSON.parse(text)
    expect(body.status).toBe('name-taken')
    expect(body.deviceName).toBe('Mac Studio')
    expect(body.suggestion).toBe('Mac Studio 2')
    expect(body.userCode).toBeUndefined()
  })

  it('malformed input is still a 400', async () => {
    const { POST } = await import('@/app/api/device/enrol/start/route')
    const res = await POST(new Request('http://x/api/device/enrol/start', { method: 'POST', body: JSON.stringify({ deviceName: 'x', publicKey: 'nope' }) }))
    expect(res.status).toBe(400)
  })
})
