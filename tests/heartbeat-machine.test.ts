import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A PID ONLY MEANS SOMETHING ON THE MACHINE THAT OWNS IT.
 *
 * The scheduler refuses to start when another one is already beating, and it decides
 * "already beating" by asking the operating system: `process.kill(pid, 0)` throws only if
 * no such process exists. That was correct — and its own comment said so — while the
 * database was a SQLite file and every scheduler lived on one laptop.
 *
 * Sharing a Postgres between the server and a laptop breaks the premise. Asking THIS
 * kernel about the Linode's pid returns "no such process", the laptop reads that as "it
 * died without clearing its heartbeat", and the guard against two schedulers starts the
 * second one itself. Two schedulers means every slot fires twice, and while detection is
 * idempotent on shortcode, "mostly deduplicated" is not a property to rely on when the
 * failure is a duplicate DM to a real prospect.
 *
 * This is asserted structurally because the alternative is standing up two hosts to
 * reproduce it — and the failure only appears AFTER the Postgres migration, which is
 * exactly the kind of latent bug that ships.
 */

const SCHEDULER = readFileSync(join(process.cwd(), 'src/worker/scheduler.ts'), 'utf8')

describe('heartbeat liveness across machines', () => {
  it('records which machine wrote the beat', () => {
    expect(SCHEDULER).toMatch(/machine\??:\s*string/)
    // Written on every beat, not just read — a field nothing populates is worse than none.
    expect(SCHEDULER).toMatch(/machine:\s*machineId\(\)/)
  })

  it('only asks the local kernel about a pid from THIS machine', () => {
    /**
     * `process.kill` must be reachable only behind a same-machine check. If it is called
     * unconditionally, a remote host's beat is judged by a local pid lookup — the bug.
     */
    expect(SCHEDULER).toMatch(/sameMachine/)

    /**
     * Comments are stripped first. The first draft of this test used a bare `indexOf` and
     * matched the phrase `process.kill(pid, 0)` inside a DOCBLOCK — so it was asserting
     * the order of the prose, not of the code, and reported a failure that was not real.
     * A test that measures the wrong artefact is worse than none: it fails on correct code
     * and, loosened, passes on incorrect code.
     */
    const code = SCHEDULER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const killAt = code.indexOf('process.kill(')
    const guardAt = code.indexOf('if (!sameMachine)')
    expect(killAt, 'process.kill should still be used for the local case').toBeGreaterThan(-1)
    expect(guardAt, 'no same-machine guard before process.kill').toBeGreaterThan(-1)
    expect(guardAt, 'the same-machine guard must come BEFORE process.kill').toBeLessThan(killAt)
  })

  /**
   * The conservative direction, stated: a beat from another machine is judged on
   * FRESHNESS. That may refuse to start for up to the staleness window after a genuine
   * remote crash — and that is the trade we want. Refusing too long is visible on the
   * dashboard's watch alarm; running two schedulers is not visible at all.
   */
  it('treats a fresh beat from another machine as alive', () => {
    const guardBlock = SCHEDULER.slice(
      SCHEDULER.indexOf('if (!sameMachine)'),
      SCHEDULER.indexOf('if (!sameMachine)') + 320,
    )
    expect(guardBlock).toMatch(/return existing\.fresh/)
  })

  it('keeps a beat written before the field existed readable', () => {
    // `machine` is optional. An old row must not crash the reader — and an absent machine
    // must read as "not this one", which refuses rather than assuming the other is dead.
    expect(SCHEDULER).toMatch(/machine\?:/)
    expect(SCHEDULER).toMatch(/existing\.beat\.machine \?\? null/)
  })
})
