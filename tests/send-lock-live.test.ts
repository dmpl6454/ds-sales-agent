import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
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

  it('two runs started in the same tick: exactly one holds the lock (the flag is taken before the first await)', async () => {
    const ran: string[] = []
    const [a, b] = await Promise.all([
      withSlotLock('slot-17:00', async () => {
        ran.push('slot')
        await new Promise((r) => setTimeout(r, 20))
        return 'slot'
      }),
      withSlotLock('detect-draft', async () => {
        ran.push('plan')
        return 'plan'
      }),
    ])
    expect(ran).toEqual(['slot'])
    expect(a).toBe('slot')
    expect(b).toBeNull()
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

/**
 * ── TWO MACS UNDER ONE NAME — THE LOCK TELLS THEM APART BY MACHINE (2026-10-09, C4) ──
 *
 * MEASURED against the real modules before this: Mac A held `{pid, device: 'Mac Studio'}`, Mac B
 * (also 'Mac Studio') read it as its own, asked its own OS about A's pid, and took the lock over
 * A's live drive. The row carries `host` now; DS_HOST_ID stands in for the hardware id here.
 */
describe('a name shared by two Macs does not let one step over the other', () => {
  const savedHost = process.env.DS_HOST_ID
  afterEach(() => {
    if (savedHost === undefined) delete process.env.DS_HOST_ID
    else process.env.DS_HOST_ID = savedHost
  })
  const row = (fields: Record<string, unknown>) => JSON.stringify({ what: 'dispatch:device', ...fields })

  it('a live row from ANOTHER machine under our own name is honoured, and left exactly as it was', async () => {
    process.env.DS_HOST_ID = 'host-b'
    await select('this-mac')
    const foreign = row({ pid: 999_999, device: 'this-mac', host: 'host-a', at: new Date(Date.now() - 20_000).toISOString() })
    await prisma.setting.create({ data: { key: 'sendLock', value: foreign } })
    let ran = false
    expect(await withSendLock('dispatch:device', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
    expect((await lockRow())?.value).toBe(foreign)
  })

  it('a stale row from a twin that stopped beating is released, though WE beat under that name', async () => {
    process.env.DS_HOST_ID = 'host-b'
    await select('this-mac')
    const stale = row({ pid: 999_999, device: 'this-mac', host: 'host-a', at: new Date(Date.now() - 7 * 60_000).toISOString() })
    await prisma.setting.create({ data: { key: 'sendLock', value: stale } })
    // Our own heartbeat under the shared name, fresh. Asked by name alone, the dead twin "beats".
    await prisma.setting.create({
      data: { key: 'devicePresence', value: JSON.stringify([{ device: 'this-mac', host: 'host-b', at: new Date().toISOString(), handles: [] }]) },
    })
    expect(await withSendLock('dispatch:device', async () => 'ran')).toBe('ran')
  })

  it('a row with no host — our predecessor before the field — is recovered as a local crash, as before', async () => {
    process.env.DS_HOST_ID = 'host-b'
    await select('this-mac')
    await prisma.setting.create({ data: { key: 'sendLock', value: row({ pid: 999_999, device: 'this-mac', at: new Date().toISOString() }) } })
    expect(await withSendLock('dispatch:device', async () => 'ran')).toBe('ran')
  })

  it('the row this Mac writes names its machine', async () => {
    process.env.DS_HOST_ID = 'host-b'
    await select('this-mac')
    const during = await withSendLock('dispatch:device', () => lockRow())
    expect(during?.value).toMatch(/"host":"host-b"/)
  })
})

/**
 * ── A ROW WRITTEN BEFORE THIS MAC STARTED CANNOT BELONG TO A LIVE PROCESS (2026-10-09) ──
 *
 * C4 made EPERM read as "alive" (another user's process on this Mac), and the local branch never
 * steps over a live holder. A row left by an agent killed by a power cut survives the reboot; after
 * boot its pid can belong to a root daemon, `kill(pid, 0)` answers EPERM, and every lock user was
 * refused for that daemon's lifetime with nothing able to delete the row. `os.uptime` and
 * `process.kill` stand in for the reboot and the daemon here.
 */
describe('a local row from before this Mac booted does not wedge the fleet', () => {
  const DAEMON_PID = 424_242
  const realKill = process.kill.bind(process)
  const HOUR = 3_600_000
  let restore: Array<{ mockRestore(): void }> = []
  beforeEach(() => {
    restore = [
      // Booted one hour ago.
      vi.spyOn(os, 'uptime').mockReturnValue(3600),
      // The pid now belongs to a process of another user: `kill(pid, 0)` answers EPERM.
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === DAEMON_PID) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
        return realKill(pid, signal)
      }) as typeof process.kill),
    ]
  })
  afterEach(() => {
    for (const r of restore) r.mockRestore()
  })
  const local = (atMsAgo: number) =>
    JSON.stringify({ pid: DAEMON_PID, device: 'this-mac', what: 'dispatch:device', at: new Date(Date.now() - atMsAgo).toISOString() })

  it('a row written before boot is taken over, though its pid answers EPERM', async () => {
    await select('this-mac')
    await prisma.setting.create({ data: { key: 'sendLock', value: local(3 * HOUR) } })
    expect(await withSendLock('dispatch:device', async () => 'ran')).toBe('ran')
    expect(await lockRow()).toBeNull()
  })

  it('a row written after boot whose pid answers EPERM is still honoured — another user on this Mac', async () => {
    await select('this-mac')
    const live = local(20_000)
    await prisma.setting.create({ data: { key: 'sendLock', value: live } })
    let ran = false
    expect(await withSendLock('dispatch:device', async () => (ran = true))).toBeNull()
    expect(ran).toBe(false)
    expect((await lockRow())?.value).toBe(live)
  })
})

/**
 * LAST IN THIS FILE ON PURPOSE: a requested shutdown cannot be withdrawn, so every test after it
 * would run against a stopping agent. Once stopping, nothing new may take the send lock — the
 * shutdown drain would otherwise wait on it and then kill it at the deadline (review, 2026-10-09).
 */
describe('a stopping agent starts no new browser work', () => {
  it('withSendLock refuses new holders after a shutdown is requested', async () => {
    const { requestBrowserShutdown } = await import('@/outreach/shutdown')
    await select('this-mac')
    expect(await withSendLock('dispatch:device', async () => 'drove')).toBe('drove')
    requestBrowserShutdown()
    let ran = false
    const r = await withSendLock('dispatch:device', async () => {
      ran = true
      return 'drove'
    })
    expect(r).toBeNull()
    expect(ran).toBe(false)
    expect(await lockRow()).toBeNull()
  })
})
