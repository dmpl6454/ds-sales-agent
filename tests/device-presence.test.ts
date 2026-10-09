import { describe, it, expect, afterEach } from 'vitest'
import { hostname } from 'node:os'
import { deviceId, mergePresence, PRESENCE_FRESH_MS, type DevicePresence } from '@/outreach/devicePresence'

/**
 * WHO THIS MAC IS, AND WHO ELSE IS RUNNING UNDER ITS NAME (2026-10-09, the C4 finding).
 *
 * `deviceId()` is the only identity the sending-Mac rule, the lock and presence have, so a blank
 * name must not become a name every Mac shares — and a second Mac under our name must stay
 * VISIBLE in presence rather than being overwritten by each of us in turn every 30 seconds.
 */

const saved = process.env.DS_DEVICE_NAME
afterEach(() => {
  if (saved === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = saved
})

describe('deviceId — a blank name is no name', () => {
  it('falls back to the hostname for an empty or all-spaces name, and trims a padded one', () => {
    process.env.DS_DEVICE_NAME = ''
    expect(deviceId()).toBe(hostname())
    process.env.DS_DEVICE_NAME = '   '
    expect(deviceId()).toBe(hostname())
    process.env.DS_DEVICE_NAME = ' Office Mac '
    expect(deviceId()).toBe('Office Mac')
    delete process.env.DS_DEVICE_NAME
    expect(deviceId()).toBe(hostname())
  })
})

describe('every reader of DS_DEVICE_NAME treats a blank as no name', () => {
  it('the anonymous-read gate names the host the same way deviceId() does', async () => {
    const { anonGateHost } = await import('@/detection/anonGate')
    process.env.DS_DEVICE_NAME = '  '
    expect(anonGateHost()).toBe(hostname())
    process.env.DS_DEVICE_NAME = ' Office Mac '
    expect(anonGateHost()).toBe('Office Mac')
  })

  /**
   * A SOURCE GREP, because the failure is a reader somebody writes later: `DS_DEVICE_NAME ??`
   * makes `''` a name every Mac that hits it shares. It must find the readers it checks — a grep
   * that matches nothing passes — so it also asserts the three it knows about are there.
   */
  it('no file reads it with `??`, and the known readers all use the trimmed form', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (f === 'generated') continue
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    const readers = files.filter((f) => /process\.env\.DS_DEVICE_NAME/.test(readFileSync(f, 'utf8')))
    expect(readers.map((f) => f.slice(f.indexOf('src/'))).sort()).toEqual([
      'src/detection/anonGate.ts',
      'src/outreach/devicePresence.ts',
      'src/worker/scheduler.ts',
    ])
    for (const f of readers) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/process\.env\.DS_DEVICE_NAME\s*\?\?/)
      expect(src, f).toMatch(/process\.env\.DS_DEVICE_NAME\?\.trim\(\) \|\|/)
    }
  })
})

describe('mergePresence — a second Mac under our name is kept, not overwritten', () => {
  const NOW = Date.parse('2026-10-09T10:00:00Z')
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const entry = (device: string, msAgo: number, host?: string): DevicePresence => ({ device, at: at(msAgo), handles: [], ...(host ? { host } : {}) })
  const me = { ...entry('this-mac', 0, 'host-b'), handles: ['bollywoodchronicle'] }

  it('keeps a FRESH entry from another host under our name beside ours', () => {
    const next = mergePresence([entry('this-mac', 10_000, 'host-a')], me, NOW)
    expect(next.map((d) => d.host)).toEqual(['host-a', 'host-b'])
  })

  it('drops our own previous entry, a legacy (hostless) one and a stale twin — so the row does not grow', () => {
    const next = mergePresence(
      [entry('this-mac', 30_000, 'host-b'), entry('this-mac', 30_000), entry('this-mac', PRESENCE_FRESH_MS + 1, 'host-z')],
      me,
      NOW,
    )
    expect(next).toEqual([me])
  })

  it('leaves every other name exactly as it was, fresh or not', () => {
    const others = [entry('studio', 10_000, 'host-s'), entry('old-mac', 40 * 24 * 3_600_000)]
    expect(mergePresence(others, me, NOW)).toEqual([...others, me])
  })
})
