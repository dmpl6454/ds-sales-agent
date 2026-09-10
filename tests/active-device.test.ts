import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { decideDeviceRole } from '@/outreach/activeDevice'

/**
 * THE SENDING MAC (2026-09-10): one Mac does the fleet's work, every other Mac holds. The rule
 * is pure; the tests below pin it in BOTH directions, then pin where it is asked — because a
 * guard is only as good as its callers, and this codebase has shipped a correct guard with a
 * missing caller five times.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('decideDeviceRole', () => {
  it('the selected Mac is active', () => {
    expect(decideDeviceRole({ selected: 'tabish-mac', thisDevice: 'tabish-mac' })).toEqual({
      active: true,
      selected: 'tabish-mac',
      thisDevice: 'tabish-mac',
    })
  })

  it('every other Mac holds, whatever is signed in there', () => {
    const v = decideDeviceRole({ selected: 'tabish-mac', thisDevice: 'DMPLs Mac Studio' })
    expect(v.active).toBe(false)
    if (v.active) throw new Error('unreachable')
    expect(v.reason).toBe('another-mac')
    expect(v.detail).toContain('tabish-mac')
    expect(v.detail).toContain('DMPLs Mac Studio')
  })

  it('no selection means NO Mac sends — never "whichever Mac runs"', () => {
    for (const selected of [null, '', '   ']) {
      const v = decideDeviceRole({ selected, thisDevice: 'tabish-mac' })
      expect(v.active, `selected=${JSON.stringify(selected)}`).toBe(false)
      if (!v.active) expect(v.reason).toBe('none-selected')
    }
  })

  it('names are compared exactly — a near-miss is another Mac', () => {
    expect(decideDeviceRole({ selected: 'tabish-mac', thisDevice: 'Tabish-Mac' }).active).toBe(false)
  })
})

describe('the rule is asked at both ends and by every pass', () => {
  const dispatcher = strip(readFileSync('src/outreach/dispatcher.ts', 'utf8'))
  const agent = strip(readFileSync('src/agent/index.ts', 'utf8'))

  it('withSendLock asks after the SEND_ENABLED floor and before acquiring the lock', () => {
    const at = dispatcher.indexOf('export async function withSendLock')
    const body = dispatcher.slice(at, at + 1600)
    const floor = body.indexOf('env.SEND_ENABLED')
    const role = body.indexOf('thisMacRole()')
    const acquire = body.indexOf('acquireSendLock(')
    expect(floor).toBeGreaterThan(-1)
    expect(role).toBeGreaterThan(floor)
    expect(acquire).toBeGreaterThan(role)
  })

  it('a standby dispatch tick returns before the breaker, the queue count and the lock — and records no dispatchState', () => {
    const at = dispatcher.indexOf('export async function dispatchTick')
    const body = dispatcher.slice(at)
    const role = body.indexOf('thisMacRole()')
    const standbyReturn = body.indexOf("reason: 'not-the-selected-mac'")
    const breaker = body.indexOf('assessFleetBreaker(at)')
    const lock = body.indexOf('withSendLock(`dispatch:')
    expect(role).toBeGreaterThan(-1)
    expect(standbyReturn).toBeGreaterThan(role)
    expect(breaker).toBeGreaterThan(standbyReturn)
    expect(lock).toBeGreaterThan(standbyReturn)
    // Between asking and returning, nothing writes the fleet's "what the last tick did" row.
    expect(body.slice(role, standbyReturn)).not.toContain('recordDispatchState')
  })

  it.each(['tick', 'replyPass', 'brandPass', 'detectionFailoverPass'])('%s asks before doing fleet work', (fn) => {
    const at = agent.indexOf(`async function ${fn}(`)
    expect(at, `${fn} not found`).toBeGreaterThan(-1)
    const body = agent.slice(at, agent.indexOf('\n}\n', at))
    expect(body, `${fn} never asks thisMacRole`).toContain('thisMacRole()')
  })

  it('the reply sweep asks on entry and re-asks before every inbox scan and every thread read', () => {
    const sweep = strip(readFileSync('src/outreach/replyCheck.ts', 'utf8'))
    const asks = sweep.match(/thisMacRole\(\)/g) ?? []
    expect(asks.length, 'entry + inbox loop + thread loop').toBeGreaterThanOrEqual(3)
    const inboxLoop = sweep.indexOf('for (const sender of local)')
    const threadLoop = sweep.indexOf('for (const c of candidates)')
    expect(sweep.indexOf('thisMacRole()', inboxLoop) - inboxLoop).toBeLessThan(200)
    expect(sweep.indexOf('thisMacRole()', threadLoop) - threadLoop).toBeLessThan(250)
  })

  it('the connect relay does NOT ask — a Mac must be signable-in before it can be chosen', () => {
    const connect = strip(readFileSync('src/agent/connectPass.ts', 'utf8'))
    expect(connect).not.toContain('thisMacRole')
  })
})
