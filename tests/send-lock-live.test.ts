import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `withSendLock` AND THE SENDING-MAC RULE, against a real database (2026-10-09).
 *
 * The 9 October audit found that the lock every browser drive passes through, and the role check
 * inside it, had NO behavioural test: every delivery test mocks `thisMacRole` to "active", and the
 * rest grep for names. So inverting the role's fail-closed catch, widening the disk-care exemption
 * or making the release unconditional all passed the suite. These drive the real functions over a
 * real SQLite file, with the role decided by a real `activeDevice` Setting row, exactly as the
 * agent reads it.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-send-lock-'))
const dbPath = join(dir, 'lock.db')
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
process.env.SEND_ENABLED = 'true'

const { prisma } = await import('@/lib/db')
const { withSendLock, sendLockHeldHere } = await import('@/outreach/dispatcher')
const { thisMacRole } = await import('@/outreach/activeDevice')

const lockRow = () => prisma.setting.findUnique({ where: { key: 'sendLock' } })
const select = (device: string | null) =>
  device === null
    ? prisma.setting.deleteMany({ where: { key: 'activeDevice' } })
    : prisma.setting.upsert({
        where: { key: 'activeDevice' },
        update: { value: device },
        create: { key: 'activeDevice', value: device },
      })

beforeEach(async () => {
  await prisma.setting.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('the sending-Mac rule fails closed', () => {
  it('no Mac selected → not active, and the lock refuses to run anything', async () => {
    await select(null)
    expect((await thisMacRole()).active).toBe(false)
    let ran = false
    expect(await withSendLock('dispatch:device', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
  })

  it('another Mac selected → this Mac drives nothing', async () => {
    await select('the-studio')
    let ran = false
    expect(await withSendLock('reply-sweep', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
  })

  it('this Mac selected → it runs, holding the row for the duration and clearing it after', async () => {
    await select('this-mac')
    const during = await withSendLock('dispatch:device', async () => {
      expect(sendLockHeldHere()).toBe(true)
      return lockRow()
    })
    expect(during?.value).toMatch(/"device":"this-mac"/)
    expect(sendLockHeldHere()).toBe(false)
    expect(await lockRow()).toBeNull()
  })
})

describe('a lock that changed hands is not deleted by its former holder', () => {
  it('leaves the new holder\'s row in place', async () => {
    await select('this-mac')
    await withSendLock('reply-sweep', async () => {
      // Another Mac stepped over this one while it was asleep and now holds the lock.
      await prisma.setting.update({
        where: { key: 'sendLock' },
        data: { value: JSON.stringify({ pid: 1, device: 'the-studio', what: 'dispatch:device', at: new Date().toISOString() }) },
      })
    })
    const row = await lockRow()
    expect(row?.value).toMatch(/"device":"the-studio"/)
  })
})

describe('a standby Mac\'s disk care does not take the fleet lock', () => {
  it('runs without creating the shared row, so the selected Mac is never paused', async () => {
    await select('the-studio')
    const seen = await withSendLock('disk-care', async () => ({ row: await lockRow(), held: sendLockHeldHere() }))
    expect(seen).not.toBeNull()
    expect(seen!.row).toBeNull()
    // The in-process guard is still taken, so nothing in this process overlaps the prune.
    expect(seen!.held).toBe(true)
  })

  it('on the SELECTED Mac disk care still takes the row, so no drive starts under a prune', async () => {
    await select('this-mac')
    const seen = await withSendLock('disk-care', () => lockRow())
    expect(seen?.value).toMatch(/"what":"disk-care"/)
  })

  it('the exemption is exactly disk care — a standby reply sweep is still refused', async () => {
    await select('the-studio')
    expect(await withSendLock('reply-sweep', async () => 'ran')).toBeNull()
  })
})

/**
 * ── THE SLOT LOCK, SAME DATABASE (2026-10-09) ────────────────────────────────
 *
 * On the Linode the slots and the 15-minute planner share ONE process, and the row granted a
 * take-over to any holder with our own pid — so the planner took over a running slot's lock,
 * planned beside it, and its `finally` deleted the row under the slot.
 */
describe('the slot lock is held in-process and released only by its holder', async () => {
  const { withSlotLock, slotLockHeldInThisProcess, touchSlotLock } = await import('@/worker/runSlot')
  const slotRow = () => prisma.setting.findUnique({ where: { key: 'slotRunning' } })

  it('a nested run in the same process is refused, and the outer holder keeps its row', async () => {
    const inner = await withSlotLock('slot-11:00', async () => {
      expect(slotLockHeldInThisProcess()).toBe(true)
      const nested = await withSlotLock('detect-draft', async () => 'planned')
      return { nested, row: await slotRow() }
    })
    expect(inner?.nested).toBeNull()
    expect(inner?.row?.value).toMatch(/"slot":"slot-11:00"/)
    expect(slotLockHeldInThisProcess()).toBe(false)
    expect(await slotRow()).toBeNull()
  })

  it('a lock refreshed mid-run is still released — the refresh rewrites the row the release matches on', async () => {
    await withSlotLock('slot-15:00', async () => {
      const before = (await slotRow())?.value
      await new Promise((r) => setTimeout(r, 5))
      await touchSlotLock('slot-15:00')
      const after = (await slotRow())?.value
      expect(after).toBeDefined()
      expect(after).not.toBe(before)
    })
    expect(await slotRow()).toBeNull()
  })

  it('a refresh never stamps over a row this process no longer holds', async () => {
    await withSlotLock('detect-draft', async () => {
      const foreign = JSON.stringify({ pid: 999999, slot: 'other', at: new Date().toISOString() })
      await prisma.setting.update({ where: { key: 'slotRunning' }, data: { value: foreign } })
      await touchSlotLock('detect-draft')
      expect((await slotRow())?.value).toBe(foreign)
    })
    expect((await slotRow())?.value).toMatch(/"slot":"other"/)
    await prisma.setting.deleteMany({ where: { key: 'slotRunning' } })
  })

  it('a holder whose row changed hands does not delete the new one', async () => {
    await withSlotLock('detect-draft', async () => {
      await prisma.setting.update({
        where: { key: 'slotRunning' },
        data: { value: JSON.stringify({ pid: 999999, slot: 'other', at: new Date().toISOString() }) },
      })
    })
    expect((await slotRow())?.value).toMatch(/"slot":"other"/)
  })
})
