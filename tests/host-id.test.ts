import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostId, hostIdFrom } from '@/lib/hostId'

/**
 * WHICH PHYSICAL MACHINE THIS IS (2026-10-09, the C4 finding). Two Macs under one NAME read each
 * other's send-lock row as their own; the lock now also compares a machine id. The id must be
 * stable per MACHINE — one Mac with two ids would read its own dashboard's lock row as foreign and
 * see its previous process as a second Mac — so a transient hardware-read failure must reuse the
 * cache, never mint a new id. Driven against real files in a temporary DATA_ROOT, with the
 * hardware reader injected.
 */

const roots: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'ds-hostid-'))
  roots.push(d)
  return d
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

const savedHost = process.env.DS_HOST_ID
const withoutEnvId = <T>(fn: () => T): T => {
  delete process.env.DS_HOST_ID
  try {
    return fn()
  } finally {
    if (savedHost !== undefined) process.env.DS_HOST_ID = savedHost
  }
}
const uuid = (u: string | undefined) => () => u
const failing = () => {
  throw new Error('ioreg timed out')
}

describe('hostIdFrom — one machine, one id', () => {
  it('the same hardware gives the same id, and the cache records it as hardware', () =>
    withoutEnvId(() => {
      const root = fresh()
      const a = hostIdFrom(root, uuid('AAAA-1111'), false)
      const b = hostIdFrom(root, uuid('AAAA-1111'), false)
      expect(a).toMatch(/^[0-9a-f]{16}$/)
      expect(b).toBe(a)
      expect(JSON.parse(readFileSync(join(root, 'host-id'), 'utf8'))).toEqual({ id: a, source: 'hardware' })
    }))

  it('a hardware read that FAILS reuses the cached id — never a new random one', () =>
    withoutEnvId(() => {
      const root = fresh()
      const a = hostIdFrom(root, uuid('AAAA-1111'), false)
      expect(hostIdFrom(root, failing, false)).toBe(a)
      expect(hostIdFrom(root, uuid(undefined), false)).toBe(a)
    }))

  it('different hardware than a hardware-sourced cache is a clone or a new board: the hardware wins', () =>
    withoutEnvId(() => {
      const root = fresh()
      const a = hostIdFrom(root, uuid('AAAA-1111'), false)
      const b = hostIdFrom(root, uuid('BBBB-2222'), false)
      expect(b).not.toBe(a)
      expect(JSON.parse(readFileSync(join(root, 'host-id'), 'utf8')).id).toBe(b)
    }))

  it('no hardware and no cache mints ONE random id, and keeps it — even once the hardware answers', () =>
    withoutEnvId(() => {
      const root = fresh()
      const r = hostIdFrom(root, failing, false)
      expect(r).toMatch(/^[0-9a-f]{16}$/)
      expect(hostIdFrom(root, failing, false)).toBe(r)
      expect(hostIdFrom(root, uuid('AAAA-1111'), false)).toBe(r)
    }))

  it('an unreadable cache with no hardware is undefined — today\'s semantics, never a guess', () =>
    withoutEnvId(() => {
      const root = fresh()
      writeFileSync(join(root, 'host-id'), 'not json')
      expect(hostIdFrom(root, failing, false)).toBeUndefined()
    }))

  it('under the test runner, with no DS_HOST_ID, nothing is returned and no file is written', () =>
    withoutEnvId(() => {
      const root = fresh()
      expect(hostIdFrom(root, uuid('AAAA-1111'))).toBeUndefined()
      expect(existsSync(join(root, 'host-id'))).toBe(false)
      expect(hostId()).toBeUndefined()
    }))

  it('DS_HOST_ID wins, and is read on every call', () => {
    process.env.DS_HOST_ID = 'host-a'
    expect(hostId()).toBe('host-a')
    process.env.DS_HOST_ID = 'host-b'
    expect(hostId()).toBe('host-b')
    if (savedHost === undefined) delete process.env.DS_HOST_ID
    else process.env.DS_HOST_ID = savedHost
  })
})
