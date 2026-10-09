import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A SENDING MAC WHOSE LOOP FAILS MUST NOT READ AS HEALTHY (audit H11, 2026-10-09).
 *
 * Presence is written before anything in the device agent's tick can throw, so it proves the
 * process is alive and nothing more. The stamp proves a tick COMPLETED. These pin the rule in
 * both directions — including every case that must NOT alarm, because absence of data
 * hardening into an alarm is the same defect as absence hardening into a verdict — and pin
 * that the agent writes the stamp and the landing page reads it, since no behavioural test
 * can fail for a caller nobody wrote.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-dispatch-health-'))
const dbPath = join(dir, 'health.db')
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

const { prisma } = await import('@/lib/db')
const { assessDispatch, parseDispatchStamp, recordDispatchOk, DISPATCH_OK_KEY, DISPATCH_STALE_MS, DISPATCH_STAMP_EVERY_MS } = await import(
  '@/outreach/dispatchHealth'
)
const { readPassHealth } = await import('@/worker/scheduler')

beforeEach(async () => {
  await prisma.setting.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-09T10:00:00Z')
const stampAt = (msAgo: number, device = 'studio') => ({ device, at: new Date(NOW - msAgo) })

describe('assessDispatch', () => {
  it('alarms when the selected Mac beats and its last completed tick is past the threshold', () => {
    const r = assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(DISPATCH_STALE_MS + 1), now: NOW })
    expect(r.stale).toBe(true)
    expect(r.lastOkAt).toEqual(new Date(NOW - DISPATCH_STALE_MS - 1))
  })

  it('does not alarm on a recent completed tick, or exactly at the threshold', () => {
    expect(assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(30_000), now: NOW }).stale).toBe(false)
    expect(assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(DISPATCH_STALE_MS), now: NOW }).stale).toBe(false)
  })

  it('does not alarm when nothing has been measured, or the stamp names another Mac', () => {
    expect(assessDispatch({ selected: 'studio', selectedBeating: true, stamp: null, now: NOW }).stale).toBe(false)
    // The stamp a previous selection left behind says nothing about the Mac selected now.
    const other = assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(DISPATCH_STALE_MS * 10, 'laptop'), now: NOW })
    expect(other).toEqual({ stale: false, lastOkAt: null })
  })

  it('does not alarm when no Mac is selected or the selected Mac is not beating (other rungs say that)', () => {
    expect(assessDispatch({ selected: null, selectedBeating: false, stamp: stampAt(DISPATCH_STALE_MS * 10), now: NOW }).stale).toBe(false)
    expect(assessDispatch({ selected: 'studio', selectedBeating: false, stamp: stampAt(DISPATCH_STALE_MS * 10), now: NOW }).stale).toBe(false)
  })

  it('ignores a stamp from before the current selection — re-selecting a Mac is not its loop failing', () => {
    const selectedSince = new Date(NOW - 60_000)
    const old = assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(DISPATCH_STALE_MS * 4), selectedSince, now: NOW })
    expect(old).toEqual({ stale: false, lastOkAt: null })
    // Once the newly selected Mac has stamped and then stops, the alarm can fire again.
    const since = new Date(NOW - DISPATCH_STALE_MS * 3)
    expect(assessDispatch({ selected: 'studio', selectedBeating: true, stamp: stampAt(DISPATCH_STALE_MS * 2), selectedSince: since, now: NOW }).stale).toBe(true)
  })

  it('tolerates one slow-but-healthy tick: the threshold is longer than a pre-send read plus a send', () => {
    expect(DISPATCH_STALE_MS).toBeGreaterThan(6 * 60_000 + 2 * 60_000)
  })
})

describe('parseDispatchStamp', () => {
  it('reads the shape the agent writes', () => {
    expect(parseDispatchStamp(JSON.stringify({ device: 'studio', at: '2026-10-09T10:00:00.000Z' }))).toEqual({
      device: 'studio',
      at: new Date('2026-10-09T10:00:00.000Z'),
    })
  })

  it('treats anything unreadable as not measured, never as stale', () => {
    for (const bad of [null, undefined, '', 'not json', '{}', '{"device":1,"at":"x"}', '{"device":"a","at":"not a date"}', '[]']) {
      expect(parseDispatchStamp(bad as string | null | undefined)).toBeNull()
    }
  })
})

describe('the stamp round-trips through the query the landing page already makes', () => {
  it('recordDispatchOk is read back by readPassHealth', async () => {
    await recordDispatchOk('studio')
    const health = await readPassHealth()
    expect(health.dispatchStamp?.device).toBe('studio')
    expect(Date.now() - health.dispatchStamp!.at.getTime()).toBeLessThan(10_000)
  })

  it('writes at most once a minute per Mac — a tick can end every second', async () => {
    const t0 = Date.now() + 10 * 60_000 // clear of the write the test above made
    await recordDispatchOk('studio', t0)
    await recordDispatchOk('studio', t0 + 30_000)
    expect((await readPassHealth()).dispatchStamp?.at.getTime()).toBe(t0)
    await recordDispatchOk('studio', t0 + DISPATCH_STAMP_EVERY_MS)
    expect((await readPassHealth()).dispatchStamp?.at.getTime()).toBe(t0 + DISPATCH_STAMP_EVERY_MS)
  })

  it('carries when the selection was written, from the same query', async () => {
    await prisma.setting.create({ data: { key: 'activeDevice', value: 'studio' } })
    expect((await readPassHealth()).activeDeviceSince).toBeInstanceOf(Date)
  })

  it('no row reads as null', async () => {
    expect((await readPassHealth()).dispatchStamp).toBeNull()
    await prisma.setting.create({ data: { key: DISPATCH_OK_KEY, value: 'garbage' } })
    expect((await readPassHealth()).dispatchStamp).toBeNull()
  })
})

describe('the stamp has a writer and a reader', () => {
  const agent = readFileSync('src/agent/index.ts', 'utf8')
  const tickStart = agent.indexOf('async function tick(')
  const tickBody = agent.slice(tickStart, agent.indexOf('export async function runDeviceAgent', tickStart))

  it('the agent stamps only after the standby return, and after the dispatch tick', () => {
    expect(tickStart).toBeGreaterThan(-1)
    const standby = tickBody.indexOf('if (!role.active)')
    const firstStamp = tickBody.indexOf('recordDispatchOk(')
    expect(standby).toBeGreaterThan(-1)
    expect(firstStamp).toBeGreaterThan(standby)
    const dispatched = tickBody.indexOf("dispatchTick('device')")
    expect(tickBody.indexOf('recordDispatchOk(', dispatched)).toBeGreaterThan(dispatched)
  })

  it('the health ladder alarms on it', () => {
    const vm = readFileSync('src/app/view-model.ts', 'utf8')
    expect(vm).toContain('assessDispatch(')
    expect(vm).toMatch(/else if \(dispatch\.stale\)/)
  })
})
