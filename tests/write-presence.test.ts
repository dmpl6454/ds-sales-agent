import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `writePresence`, DRIVEN against a real Setting row (2026-10-09, the C4 finding).
 *
 * `mergePresence` is tested pure in device-presence.test.ts; this pins that the heartbeat the
 * agent actually writes goes through it and carries its machine id. MEASURED before: the writer
 * filtered `d.device !== me.device`, so two Macs that shared a name overwrote each other's entry
 * every 30 seconds and the duplicate was invisible to every reader.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-write-presence-'))
const dbPath = join(dir, 'presence.db')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.DS_DEVICE_NAME = 'this-mac'
process.env.DS_HOST_ID = 'host-b'

const { prisma } = await import('@/lib/db')
const { writePresence } = await import('@/agent')

type Entry = { device: string; at: string; host?: string; handles: string[] }
const row = async () => JSON.parse((await prisma.setting.findUnique({ where: { key: 'devicePresence' } }))!.value) as Entry[]
const seed = (entries: Entry[]) => prisma.setting.create({ data: { key: 'devicePresence', value: JSON.stringify(entries) } })

beforeEach(async () => {
  await prisma.setting.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('writePresence keeps a second Mac under our name visible', () => {
  it('a fresh twin on another host survives our heartbeat; a stale twin and our own old entry do not', async () => {
    const now = Date.now()
    await seed([
      { device: 'this-mac', at: new Date(now - 10_000).toISOString(), host: 'host-a', handles: ['x'] }, // fresh twin
      { device: 'this-mac', at: new Date(now - 10 * 60_000).toISOString(), host: 'host-z', handles: [] }, // stale twin
      { device: 'this-mac', at: new Date(now - 30_000).toISOString(), host: 'host-b', handles: [] }, // ours, previous beat
      { device: 'studio', at: new Date(now - 10_000).toISOString(), host: 'host-s', handles: [] }, // another name
    ])
    await writePresence(['bollywoodchronicle'])
    const after = await row()
    expect(after.map((d) => `${d.device}@${d.host}`).sort()).toEqual(['studio@host-s', 'this-mac@host-a', 'this-mac@host-b'])
    const mine = after.find((d) => d.host === 'host-b')!
    expect(mine.handles).toEqual(['bollywoodchronicle'])
  })
})
