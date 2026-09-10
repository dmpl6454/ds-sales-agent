import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { LOCK_BUSY_RETRY_MS, LEGACY_LOCK_RETRY_MS } from '@/outreach/dispatcher'

/**
 * TWO MACS, ONE LOCK — the two facts that stopped the fleet starving on 2026-09-10, as
 * source assertions, because both are plumbing a behavioural test cannot reach without a
 * second machine: a tick that finds the lock busy asks again in seconds rather than a whole
 * poll period (two equal periods phase-lock), and a draft this Mac holds no profile for is
 * held BEFORE the gate spends queries under the fleet lock.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('a busy fleet lock is polled, not waited out', () => {
  it('the busy verdict carries a retry hint of a few seconds', () => {
    const src = strip(readFileSync('src/outreach/dispatcher.ts', 'utf8'))
    expect(src).toMatch(/holder\.device === undefined \? LEGACY_LOCK_RETRY_MS : LOCK_BUSY_RETRY_MS/)
    expect(src).toMatch(/lockBusy: true, retryInMs, at/)
    expect(LOCK_BUSY_RETRY_MS).toBeGreaterThanOrEqual(2_000)
    expect(LOCK_BUSY_RETRY_MS).toBeLessThanOrEqual(10_000)
    // An agent older than the device field releases the lock for milliseconds at a time.
    expect(LEGACY_LOCK_RETRY_MS).toBeLessThan(LOCK_BUSY_RETRY_MS)
    expect(LEGACY_LOCK_RETRY_MS).toBeGreaterThanOrEqual(500)
  })
})

describe('a draft with no profile on this Mac never reaches the gate', () => {
  it('the disk check precedes recheckBeforeSend inside the delivery loop', () => {
    const src = strip(readFileSync('src/outreach/deliver.ts', 'utf8'))
    const loop = src.indexOf('for (const attempt of waiting)')
    const disk = src.indexOf('profileStatus(sender.handle).hasSession', loop)
    const gate = src.indexOf('recheckBeforeSend(attempt, { unattended: true })', loop)
    expect(loop).toBeGreaterThan(-1)
    expect(disk).toBeGreaterThan(loop)
    expect(gate).toBeGreaterThan(disk)
  })
})
