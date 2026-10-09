import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `getSettings` SPLITS THE SWITCH IN TWO, AND THE SPLIT IS LOAD-BEARING — audit H8.
 *
 *   autopilotEnabled    = env.AUTOPILOT_ENABLED && row   — ENFORCEMENT. A floored host never sends.
 *   autopilotFleetWide  = row                            — DISPLAY. The fleet's switch, on every host.
 *
 * Both fall back to OFF with no row, so granting the floor never arms the switch. Driven with the
 * real `getSettings` and a mocked env, because env.ts loads dotenv and a developer `.env` carrying
 * AUTOPILOT_ENABLED=true would make both values equal and every assertion below vacuous.
 */

const rows = vi.hoisted(() => ({ value: [] as { key: string; value: string }[] }))
vi.mock('@/lib/db', () => ({ prisma: { setting: { findMany: async () => rows.value } } }))

async function settingsWithFloor(floor: boolean) {
  vi.resetModules()
  vi.doMock('@/lib/env', async (orig) => {
    const m = (await orig()) as { env: Record<string, unknown> }
    return { ...m, env: { ...m.env, AUTOPILOT_ENABLED: floor } }
  })
  const { getSettings } = await import('@/lib/settings')
  return getSettings()
}

beforeEach(() => {
  rows.value = []
})

describe('on a FLOORED host (the hosted Linode)', () => {
  it('(a) row ON: enforcement OFF, display ON', async () => {
    rows.value = [{ key: 'autopilotEnabled', value: 'true' }]
    const s = await settingsWithFloor(false)
    expect(s.autopilotEnabled).toBe(false)
    expect(s.autopilotFleetWide).toBe(true)
  })

  it('(b) row OFF: both OFF', async () => {
    rows.value = [{ key: 'autopilotEnabled', value: 'false' }]
    const s = await settingsWithFloor(false)
    expect(s.autopilotEnabled).toBe(false)
    expect(s.autopilotFleetWide).toBe(false)
  })

  it('(c) no row: both OFF — absence never reads as ON', async () => {
    const s = await settingsWithFloor(false)
    expect(s.autopilotEnabled).toBe(false)
    expect(s.autopilotFleetWide).toBe(false)
  })
})

describe('on a sending Mac (floor granted)', () => {
  it('(d) row ON: both ON', async () => {
    rows.value = [{ key: 'autopilotEnabled', value: 'true' }]
    const s = await settingsWithFloor(true)
    expect(s.autopilotEnabled).toBe(true)
    expect(s.autopilotFleetWide).toBe(true)
  })

  it('(e) no row: both OFF — granting permission is never the same act as switching on', async () => {
    const s = await settingsWithFloor(true)
    expect(s.autopilotEnabled).toBe(false)
    expect(s.autopilotFleetWide).toBe(false)
  })
})
