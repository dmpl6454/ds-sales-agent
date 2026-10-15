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
    /**
     * Stage 1.4 (audit L6): NOTHING writes it between the function's HEAD and the standby return
     * either. The slice above starts at the role ask, so a DRY_RUN write sitting ABOVE the ask —
     * which is exactly where it lived, and let a DRY_RUN standby overwrite the sending Mac's row
     * every tick — was outside it and the old check stayed green.
     */
    expect(body.slice(0, standbyReturn)).not.toContain('recordDispatchState')
  })

  it('the DRY_RUN hold is written only AFTER the standby return, so only the selected Mac can write it (Stage 1.4)', () => {
    const at = dispatcher.indexOf('export async function dispatchTick')
    const body = dispatcher.slice(at)
    const standbyReturn = body.indexOf("reason: 'not-the-selected-mac'")
    const dryRunBranch = body.indexOf('if (env.DRY_RUN)')
    const dryRunReason = body.indexOf("reason: 'dry-run'")
    expect(standbyReturn).toBeGreaterThan(-1)
    expect(dryRunBranch, 'the DRY_RUN branch must still exist').toBeGreaterThan(-1)
    expect(dryRunBranch, 'DRY_RUN is asked before the role — a DRY_RUN standby writes dispatchState').toBeGreaterThan(standbyReturn)
    expect(dryRunReason).toBeGreaterThan(dryRunBranch)
    // And its write is inside that branch, i.e. after the standby return, not merely near it.
    const write = body.indexOf('recordDispatchState', standbyReturn)
    expect(write).toBeGreaterThan(dryRunBranch)
    expect(write).toBeLessThan(body.indexOf('assessFleetBreaker(at)'))
  })

  it('the SEND_ENABLED courtesy comes first: before the role ask, with no write and no settings read (Stage 1.4)', () => {
    const at = dispatcher.indexOf('export async function dispatchTick')
    const body = dispatcher.slice(at)
    const floor = body.indexOf('if (!env.SEND_ENABLED)')
    const floorReturn = body.indexOf("reason: 'send-disabled'")
    const role = body.indexOf('thisMacRole()')
    expect(floor).toBeGreaterThan(-1)
    expect(floorReturn).toBeGreaterThan(floor)
    expect(role, 'the role is asked before the floor — a host that cannot send pays for a read').toBeGreaterThan(floorReturn)
    expect(body.slice(0, role)).not.toContain('getSettings')
    expect(body.slice(0, role)).not.toContain('recordDispatchState')
    // The HARD floor is unmoved: withSendLock still refuses on it, before the role and the lock.
    const lockFn = dispatcher.indexOf('export async function withSendLock')
    const lockBody = dispatcher.slice(lockFn, lockFn + 1600)
    expect(lockBody.indexOf('env.SEND_ENABLED')).toBeGreaterThan(-1)
    expect(lockBody.indexOf('thisMacRole()')).toBeGreaterThan(lockBody.indexOf('env.SEND_ENABLED'))
  })

  it.each(['tick', 'replyPass', 'brandPass', 'detectionFailoverPass'])('%s asks before doing fleet work', (fn) => {
    const at = agent.indexOf(`async function ${fn}(`)
    expect(at, `${fn} not found`).toBeGreaterThan(-1)
    const body = agent.slice(at, agent.indexOf('\n}\n', at))
    expect(body, `${fn} never asks thisMacRole`).toContain('thisMacRole()')
  })

  /**
   * Re-pointed at `deliverOne.ts` (Stage 1.3): the claim moved out of the loop into the one
   * delivery function both callers use, so this is now true of the Send button's claim too —
   * which used to be made BEFORE the lock and before any of these asks.
   */
  it('the delivery function re-asks immediately before the READY→SENDING claim — a long evaluation is a window', () => {
    const deliver = strip(readFileSync('src/outreach/deliverOne.ts', 'utf8'))
    const head = deliver.indexOf('async function deliverOne(')
    const claim = deliver.indexOf("data: { status: 'SENDING' }", head)
    const ask = deliver.lastIndexOf('thisMacRole()', claim)
    expect(head).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(head)
    expect(ask, 'no thisMacRole() between the function head and the claim').toBeGreaterThan(head)
    // Nothing that drives a browser sits between the ask and the claim.
    expect(deliver.slice(ask, claim)).not.toMatch(/browserSender\.send|probeHandle\(/)
  })

  it('and asks all three — switch, shutdown, sending Mac — BEFORE the thread read, which is itself a drive (Stage 1.3)', () => {
    const deliver = strip(readFileSync('src/outreach/deliverOne.ts', 'utf8'))
    const head = deliver.indexOf('async function deliverOne(')
    const read = deliver.indexOf('await ensureConversationChecked(', head)
    expect(read).toBeGreaterThan(head)
    const before = deliver.slice(head, read)
    expect(before, 'the switch is not re-asked before the read').toMatch(/\(await getSettings\(\)\)\.autopilotEnabled/)
    expect(before, 'shutdown is not asked before the read').toMatch(/browserShutdownRequested\(\)/)
    expect(before, 'the sending Mac is not asked before the read').toMatch(/thisMacRole\(\)/)
    // And the three are asked AGAIN after it — the first ask is additional, never a replacement.
    const after = deliver.slice(read, deliver.indexOf("data: { status: 'SENDING' }", read))
    expect(after).toMatch(/\(await getSettings\(\)\)\.autopilotEnabled/)
    expect(after).toMatch(/browserShutdownRequested\(\)/)
    expect(after).toMatch(/thisMacRole\(\)/)
  })

  it('the reply sweep asks on entry and re-asks before every inbox scan and every thread read', () => {
    const sweep = strip(readFileSync('src/outreach/replyCheck.ts', 'utf8'))
    const asks = sweep.match(/thisMacRole\(\)/g) ?? []
    // The wrapper (`sweepUnderLock`) asks too since Stage 1.2, so a bare count of 3 no longer
    // proves the entry ask exists — deleting it would leave 3 and stay green. Pin it BY POSITION.
    expect(asks.length, 'wrapper + entry + inbox loop + thread loop').toBeGreaterThanOrEqual(4)
    const sweepFn = sweep.indexOf('export async function checkForReplies')
    expect(sweepFn).toBeGreaterThan(-1)
    const entryAsk = sweep.indexOf('thisMacRole()', sweepFn)
    const firstScan = sweep.indexOf('await inboxPhase(', sweepFn)
    expect(entryAsk, 'checkForReplies no longer asks the role on entry').toBeGreaterThan(sweepFn)
    expect(entryAsk, 'the entry ask must come before the first inbox scan can open Chrome').toBeLessThan(firstScan)
    const inboxLoop = sweep.indexOf('for (const sender of local)')
    const threadLoop = sweep.indexOf('for (const c of candidates)')
    expect(sweep.indexOf('thisMacRole()', inboxLoop) - inboxLoop).toBeLessThan(200)
    expect(sweep.indexOf('thisMacRole()', threadLoop) - threadLoop).toBeLessThan(250)
  })

  it('the lock wrapper every sweep goes through asks too — after the floor, before the lock (Stage 1.2)', () => {
    const sweep = strip(readFileSync('src/outreach/replyCheck.ts', 'utf8'))
    const at = sweep.indexOf('export async function sweepUnderLock')
    expect(at).toBeGreaterThan(-1)
    const body = sweep.slice(at, sweep.indexOf('\n}\n', at))
    const floor = body.indexOf('env.SEND_ENABLED')
    const role = body.indexOf('thisMacRole()')
    const lock = body.indexOf('withSendLock(')
    expect(floor).toBeGreaterThan(-1)
    expect(role).toBeGreaterThan(floor)
    expect(lock).toBeGreaterThan(role)
  })

  it('the connect relay does NOT ask — a Mac must be signable-in before it can be chosen', () => {
    const connect = strip(readFileSync('src/agent/connectPass.ts', 'utf8'))
    expect(connect).not.toContain('thisMacRole')
  })
})
