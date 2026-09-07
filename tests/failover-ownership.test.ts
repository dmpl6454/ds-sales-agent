/**
 * Who may write what, when a Mac reads the feeds in the server's place (7 Sept 2026).
 *
 * Two source greps, because both failure modes are a line somebody deletes while "tidying":
 *   1. only a PRIMARY pass may set or clear `detectThrottledUntil` — a failover pass writing
 *      its own cooldown there tells the dashboard the wrong host's story, and a failover pass
 *      clearing it hides a server that is still being refused;
 *   2. the pairing hand-off carries the classifier key and the installer writes it — a Mac
 *      that reads feeds without it stores posts nothing judges, and the agent refuses to run
 *      the failover at all in that state rather than doing half a job.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

describe('the throttle stamp belongs to the primary', () => {
  it('pipeline.ts writes detectThrottledUntil only when role is primary, and the agent passes role: failover', () => {
    const pipeline = read('src', 'detection', 'pipeline.ts')
    const fn = pipeline.slice(pipeline.indexOf('async function recordDetectionOutput('))
    expect(fn).toMatch(/if \(input\.role !== 'primary'\) \{/)
    expect(fn.indexOf("input.role !== 'primary'")).toBeLessThan(fn.indexOf('DETECT_THROTTLED_KEY'))
    const agent = read('src', 'agent', 'index.ts')
    expect(agent).toMatch(/runDetection\(\{ role: 'failover' \}\)/)
  })
})

describe('the classifier key travels with the pairing', () => {
  it('pollEnrolment hands modelKey over and install.sh writes it as DEEPSEEK_API_KEY', () => {
    expect(read('src', 'lib', 'deviceEnrol.ts')).toMatch(/modelKey: process\.env\.DEEPSEEK_API_KEY \|\| null/)
    const installer = read('scripts', 'dmg', 'install.sh')
    expect(installer).toMatch(/j\.modelKey\|\|""/)
    expect(installer).toMatch(/set_env DEEPSEEK_API_KEY/)
    expect(installer).toMatch(/write_env "\$DBURL" "\$NAME" "\$\{MODEL_KEY:-\}"/)
  })
  it('the agent refuses the failover without the key instead of storing unjudged posts', () => {
    const agent = read('src', 'agent', 'index.ts')
    const fn = agent.slice(agent.indexOf('async function detectionFailoverPass('))
    expect(fn.indexOf('DEEPSEEK_API_KEY')).toBeGreaterThan(-1)
    expect(fn.indexOf('DEEPSEEK_API_KEY')).toBeLessThan(fn.indexOf("runDetection({ role: 'failover' })"))
  })
})