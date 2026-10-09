import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE SERVER MUST NOT BE ABLE TO SEND, and this asserts it structurally.
 *
 * Hosting is only safe because the machine on the public internet never holds an
 * Instagram session. The Chrome profiles carry device identity (`mid`, `ig_did`,
 * `ig-u-rur`) written by a hand login from a HOME IP; copying them to a datacenter is a
 * cookie transplant in all but name, and `sessionid` is a bearer token with no channel
 * binding — so a transplant WORKS, right up until enforcement lands silently. Research
 * established device + network continuity as a pass/fail gate, not a score.
 *
 * `SEND_ENABLED=false` is the hard floor that makes that structural rather than a
 * convention. Its FIRST version was checked only inside the device agent, which left the
 * dashboard's Send button, the on-demand dialog, the scheduler's dispatcher and the CLI
 * all still able to drive a browser on the server — the same "one rule, several callers"
 * gap that has bitten this codebase four times. It now lives in `withSendLock`, which
 * CLAUDE.md documents as covering EVERY path that drives a browser to send.
 */

const REPO = process.cwd()
const DISPATCHER = readFileSync(join(REPO, 'src/outreach/dispatcher.ts'), 'utf8')
const ENV = readFileSync(join(REPO, 'src/lib/env.ts'), 'utf8')
const AGENT = readFileSync(join(REPO, 'src/agent/index.ts'), 'utf8')

/** Source with comments removed, so an assertion measures CODE and not prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('SEND_ENABLED is a hard floor on every send path', () => {
  it('is checked inside withSendLock — the one chokepoint', () => {
    const body = code(DISPATCHER)
    const lockAt = body.indexOf('export async function withSendLock')
    expect(lockAt, 'withSendLock not found').toBeGreaterThan(-1)

    const lockBody = body.slice(lockAt, lockAt + 900)
    expect(lockBody, 'withSendLock does not check SEND_ENABLED').toMatch(/env\.SEND_ENABLED/)
  })

  it('checks it BEFORE acquiring the lock or driving anything', () => {
    const body = code(DISPATCHER)
    const lockAt = body.indexOf('export async function withSendLock')
    // The WHOLE function, not a fixed window: a 900-character window is a measurement of how
    // much was written above the acquire, and it broke the day a shutdown check was added.
    const lockBody = body.slice(lockAt, body.indexOf('\nexport ', lockAt + 1))

    const floorAt = lockBody.indexOf('env.SEND_ENABLED')
    const acquireAt = lockBody.indexOf('acquireSendLock')
    expect(acquireAt).toBeGreaterThan(-1)
    // A floor checked after the lock is taken would leave a lock row behind on a machine
    // that was never going to send — visible later as a stuck send nobody can explain.
    expect(floorAt, 'the floor must come before acquireSendLock').toBeLessThan(acquireAt)
  })

  it('returns null rather than throwing, so a blocked send leaves the draft waiting', () => {
    const body = code(DISPATCHER)
    const lockAt = body.indexOf('export async function withSendLock')
    // The WHOLE function, not a fixed window: a 900-character window is a measurement of how
    // much was written above the acquire, and it broke the day a shutdown check was added.
    const lockBody = body.slice(lockAt, body.indexOf('\nexport ', lockAt + 1))
    const floorAt = lockBody.indexOf('env.SEND_ENABLED')
    const after = lockBody.slice(floorAt, floorAt + 260)

    // `null` is the established "held, not sent" signal here. A throw would surface as an
    // error on a dashboard where the correct message is "your device will send this".
    expect(after).toMatch(/return null/)
    expect(after).not.toMatch(/throw /)
  })

  /**
   * An unset variable must mean "this machine may send" for a laptop, and the SERVER gets
   * its `false` explicitly from its own .env. That default is the right way round: a
   * developer running the app locally is the common case and has the profiles; a server is
   * deployed deliberately and is configured deliberately.
   */
  it('defaults to true, and the server sets false explicitly', () => {
    expect(ENV).toMatch(/SEND_ENABLED:\s*boolish\(true\)/)
  })

  it('is an environment variable, never a Setting a web page could flip', () => {
    // The whole point of a hard floor is that the dashboard cannot cross it — the same
    // reasoning AUTOPILOT_ENABLED already carries.
    expect(DISPATCHER).not.toMatch(/settings\.sendEnabled/)
    expect(ENV).toMatch(/SEND_ENABLED/)
  })

  it('is also refused up front by the device agent, with a reason', () => {
    // Belt and braces: the agent refuses to even start, so an operator on the server sees
    // WHY rather than a process that runs and silently never sends.
    expect(code(AGENT)).toMatch(/!env\.SEND_ENABLED/)
    expect(AGENT).toMatch(/not allowed to send/)
  })
})
