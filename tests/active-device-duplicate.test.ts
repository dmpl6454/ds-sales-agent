import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A NAME TWO MACS CARRY CANNOT BE CHOSEN AS THE SENDING MAC (2026-10-09, the C4 finding).
 *
 * The sending Mac is whichever Mac's `deviceId()` equals the `activeDevice` Setting, so selecting
 * a name two Macs run under makes BOTH of them the sending Mac. `setActiveDevice` is driven for
 * real here — real queries, a real authorized_keys file — with only the session and the modules
 * that pull a browser into a unit test stubbed, exactly as tests/route-rule.test.ts does it.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-active-dup-'))
const dbPath = join(dir, 'active.db')
const AK_FILE = join(dir, 'authorized_keys')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "AuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "actor" TEXT NOT NULL, "action" TEXT NOT NULL, "entity" TEXT NOT NULL, "detail" TEXT, "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
`)
bootstrap.close()
process.env.DATABASE_URL = `file:${dbPath}`
process.env.DEVICE_AUTHORIZED_KEYS = AK_FILE

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/session', () => ({
  requireOperator: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
  requireUser: async () => ({ email: 'test@dashmani.com', role: 'operator' }),
}))
vi.mock('@/outreach/senders/browser', () => ({ browserSender: {} }))
vi.mock('@/outreach/browser/connect', () => ({
  startConnect: async () => ({ state: 'waiting' }),
  pollConnect: async () => ({ state: 'waiting' }),
  cancelConnect: async () => undefined,
}))
vi.mock('@/outreach/browser/profile', () => ({ profileStatus: async () => ({ hasSession: false }) }))
vi.mock('@/worker/runSlot', () => ({ runSlot: async () => ({}) }))

const { setActiveDevice } = await import('@/app/actions')
const { authorizedKeyLine } = await import('@/lib/deviceEnrol')
const { prisma } = await import('@/lib/db')

function edKey(byte: number): string {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const type = Buffer.from('ssh-ed25519')
  return `ssh-ed25519 ${Buffer.concat([u32(type.length), type, u32(32), Buffer.alloc(32, byte)]).toString('base64')}`
}
const beat = (device: string, host: string) => ({ device, host, at: new Date().toISOString(), handles: [] })
const presence = (entries: object[]) =>
  prisma.setting.upsert({
    where: { key: 'devicePresence' },
    update: { value: JSON.stringify(entries) },
    create: { key: 'devicePresence', value: JSON.stringify(entries) },
  })
const selected = async () => (await prisma.setting.findUnique({ where: { key: 'activeDevice' } }))?.value ?? null

beforeEach(async () => {
  await prisma.setting.deleteMany()
  await prisma.auditLog.deleteMany()
  writeFileSync(AK_FILE, '')
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('setActiveDevice refuses a name two Macs carry', () => {
  it('two Macs beating under one name: refused, nothing written, nothing audited', async () => {
    await presence([beat('Mac Studio', 'host-a'), beat('Mac Studio', 'host-b')])
    const r = await setActiveDevice('Mac Studio')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Two Macs are running as “Mac Studio”/)
    expect(await selected()).toBeNull()
    expect(await prisma.auditLog.count()).toBe(0)
  })

  it('two paired keys under one name: refused', async () => {
    writeFileSync(AK_FILE, [authorizedKeyLine(edKey(1), 'Mac Studio'), authorizedKeyLine(edKey(2), 'Mac Studio'), ''].join('\n'))
    const r = await setActiveDevice('Mac Studio')
    expect(r.ok).toBe(false)
    expect(await selected()).toBeNull()
  })

  it('one Mac under the name is chosen as before', async () => {
    await presence([beat('Mac Studio', 'host-a'), beat('tabish-mac', 'host-t')])
    writeFileSync(AK_FILE, [authorizedKeyLine(edKey(1), 'Mac Studio'), ''].join('\n'))
    const r = await setActiveDevice('Mac Studio')
    expect(r.ok).toBe(true)
    expect(await selected()).toBe('Mac Studio')
  })
})
