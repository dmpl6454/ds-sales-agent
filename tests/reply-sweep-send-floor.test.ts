import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * A process that may not send may not sweep. MEASURED 9 Sept 2026: the Mac-hosted scheduler
 * (SEND_ENABLED=false) opened three revenue profiles for its 11:00 reply sweep while the device
 * agent beside it tried to send from one of them — three drives failed. On the server the sweep
 * had only ever been stopped by the ABSENCE of profiles, never by the floor.
 */
describe('the reply sweep honours the send floor', () => {
  it('refuses before touching the database or a browser when SEND_ENABLED is false', async () => {
    process.env.SEND_ENABLED = 'false'
    vi.resetModules()
    const { checkForReplies } = await import('../src/outreach/replyCheck')
    const summary = await checkForReplies()
    expect(summary).toMatchObject({ checked: 0, repliesFound: 0, inboxesScanned: 0 })
  })
  it('the guard is the FIRST thing the sweep does — before the inbox scan can open Chrome', () => {
    const src = readFileSync('src/outreach/replyCheck.ts', 'utf8')
    const fn = src.indexOf('export async function checkForReplies')
    const guard = src.indexOf('if (!env.SEND_ENABLED)', fn)
    const scan = src.indexOf('await inboxPhase(', fn)
    expect(guard).toBeGreaterThan(fn)
    expect(scan).toBeGreaterThan(guard)
  })
})
