import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE CONNECT RELAY — signing a sender in from the HOSTED website.
 *
 * The website cannot open a browser (the Linode has no profiles and must never), so it
 * writes a request into the shared database and the operator's own device agent opens the
 * Chrome window there. What is tested here is the DB state machine that carries a connect
 * across that gap, and the properties that keep it safe:
 *
 *   - a request is addressed to a DEVICE, and only that device's active list returns it, so
 *     a second operator's Mac cannot claim a sign-in meant for the first;
 *   - only ACTIVE statuses are handed to a device — a settled one is never re-driven;
 *   - the status → ConnectState mapping is total, so the UI needs no new state machine;
 *   - a completed sign-in writes the session the same way a local login does, and clears a
 *     dead-session mark ONLY on proof (verified), never on a cookie alone.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-connect-relay-'))
const dbPath = join(dir, 'relay.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "personaName" TEXT NOT NULL DEFAULT '',
    "personaRole" TEXT NOT NULL DEFAULT '',
    "personaBrand" TEXT NOT NULL DEFAULT '',
    "personaPhone" TEXT NOT NULL DEFAULT '',
    "personaEmail" TEXT NOT NULL DEFAULT '',
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fleetMember" BOOLEAN NOT NULL DEFAULT true,
    "dailyCap" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "challengedAt" DATETIME,
    "cohort" INTEGER NOT NULL DEFAULT 1,
    "sessionPath" TEXT,
    "sessionSavedAt" DATETIME,
    "sessionInvalidAt" DATETIME,
    "sessionInvalidReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");
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

process.env.DATABASE_URL = `file:${dbPath}`

const relay = await import('@/outreach/connectRelay')
const { prisma } = await import('@/lib/db')

beforeEach(async () => {
  await prisma.setting.deleteMany({})
  await prisma.senderAccount.deleteMany({})
})

describe('requestToConnectState (pure mapping)', () => {
  const base = { handle: 'brand', device: 'mac-a', requestedBy: 'x@y.com', createdAt: 'a', updatedAt: 'a' }

  it('maps every status onto a ConnectState', () => {
    expect(relay.requestToConnectState(null, 'brand').state).toBe('closed')
    expect(relay.requestToConnectState({ ...base, status: 'requested', message: 'm' }, 'brand').state).toBe('waiting')
    expect(relay.requestToConnectState({ ...base, status: 'opening', message: 'm' }, 'brand').state).toBe('waiting')
    expect(relay.requestToConnectState({ ...base, status: 'waiting', message: 'm' }, 'brand').state).toBe('waiting')
    expect(relay.requestToConnectState({ ...base, status: 'error', message: 'm' }, 'brand').state).toBe('error')
    expect(relay.requestToConnectState({ ...base, status: 'cancelled', message: 'm' }, 'brand').state).toBe('closed')
  })

  it('carries verified and the wrong-account handle through', () => {
    const c = relay.requestToConnectState({ ...base, status: 'connected', message: 'm', verified: true }, 'brand')
    expect(c).toEqual({ state: 'connected', handle: 'brand', verified: true })
    const w = relay.requestToConnectState({ ...base, status: 'wrong-account', message: 'm', actual: 'someoneelse' }, 'brand')
    expect(w).toEqual({ state: 'wrong-account', actual: 'someoneelse', expected: 'brand' })
  })
})

describe('the request queue', () => {
  it('enqueues a request that only its target device can claim', async () => {
    await relay.enqueueConnectRequest({ handle: 'brand', device: 'mac-a', requestedBy: 'op@x.com' })

    const forA = await relay.activeRequestsForDevice('mac-a')
    const forB = await relay.activeRequestsForDevice('mac-b')
    expect(forA.map((r) => r.handle)).toEqual(['brand'])
    // The load-bearing safety property: a second operator's Mac never sees it.
    expect(forB).toEqual([])
    expect(forA[0]?.status).toBe('requested')
  })

  it('a settled request is not handed to the device again', async () => {
    await relay.enqueueConnectRequest({ handle: 'brand', device: 'mac-a', requestedBy: 'op@x.com' })
    await relay.updateConnectRequest('brand', { status: 'connected', verified: true, message: 'done' })

    expect(await relay.activeRequestsForDevice('mac-a')).toEqual([])
    // …but the UI can still read the terminal state.
    const read = await relay.readConnectRequest('brand')
    expect(read?.status).toBe('connected')
    expect(read?.verified).toBe(true)
  })

  it('a second ask overwrites the first — never two windows for one handle', async () => {
    await relay.enqueueConnectRequest({ handle: 'brand', device: 'mac-a', requestedBy: 'op@x.com' })
    await relay.updateConnectRequest('brand', { status: 'waiting', message: 'signing in' })
    await relay.enqueueConnectRequest({ handle: 'brand', device: 'mac-b', requestedBy: 'op2@x.com' })

    const read = await relay.readConnectRequest('brand')
    expect(read?.device).toBe('mac-b')
    expect(read?.status).toBe('requested') // reset to the fresh ask, not left mid-flight
    expect(await relay.activeRequestsForDevice('mac-a')).toEqual([])
  })

  it('updateConnectRequest never invents a row for a request that does not exist', async () => {
    await relay.updateConnectRequest('ghost', { status: 'connected', message: 'x' })
    expect(await relay.readConnectRequest('ghost')).toBeNull()
  })

  it('deleteConnectRequest removes it (an operator cancel)', async () => {
    await relay.enqueueConnectRequest({ handle: 'brand', device: 'mac-a', requestedBy: 'op@x.com' })
    await relay.deleteConnectRequest('brand')
    expect(await relay.readConnectRequest('brand')).toBeNull()
  })

  it('sweeps a request past its TTL in any status, and keeps a fresh one', async () => {
    const old = new Date(Date.now() - relay.CONNECT_REQUEST_TTL_MS - 60_000)
    await relay.enqueueConnectRequest({ handle: 'stale', device: 'mac-a', requestedBy: 'op@x.com', now: old })
    await relay.enqueueConnectRequest({ handle: 'fresh', device: 'mac-a', requestedBy: 'op@x.com' })

    const removed = await relay.sweepStaleRequests()
    expect(removed).toBe(1)
    expect(await relay.readConnectRequest('stale')).toBeNull()
    expect(await relay.readConnectRequest('fresh')).not.toBeNull()
  })
})

describe('persistSenderSession — the DB half of recording a login', () => {
  beforeEach(async () => {
    await prisma.senderAccount.create({
      data: {
        id: 's1',
        handle: 'brand',
        displayName: 'Brand',
        personaName: '',
        personaRole: '',
        personaBrand: '',
        personaPhone: '',
        personaEmail: '',
        sessionInvalidAt: new Date('2026-01-01'),
      },
    })
  })

  it('records the session path and CLEARS a dead-session mark on proof (verified)', async () => {
    await relay.persistSenderSession('brand', true)
    const s = await prisma.senderAccount.findUnique({ where: { handle: 'brand' } })
    expect(s?.sessionPath).not.toBeNull()
    expect(s?.sessionInvalidAt).toBeNull()
  })

  it('records the session path but LEAVES the dead-session mark when unverified (a cookie is not proof)', async () => {
    await relay.persistSenderSession('brand', false)
    const s = await prisma.senderAccount.findUnique({ where: { handle: 'brand' } })
    expect(s?.sessionPath).not.toBeNull()
    // The mark exists precisely to overrule a cookie on disk — an unverified connect must not clear it.
    expect(s?.sessionInvalidAt).not.toBeNull()
  })
})
