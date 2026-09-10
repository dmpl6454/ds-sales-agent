import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskCarePass, rotateLogs, type DiskCareDeps } from '../src/agent/diskCare'
import type { PruneReport } from '../src/outreach/browser/pruneProfile'

/**
 * Disk care: the agent keeps its own machine from filling up with nobody running a command.
 *
 * The load-bearing directions, each driven to FAIL if its guard is deleted:
 *   - a machine ABOVE the floor is never pruned (deleting the floor check fails that case);
 *   - a machine BELOW the floor is pruned, through the injected pruner, dry-measured first;
 *   - a busy send lock means NO prune this pass (the lock is what keeps a delete from
 *     racing a live browser drive);
 *   - a throwing pruner never takes the pass down (housekeeping must not stop the sender);
 *   - identity damage after a prune is REPORTED, not swallowed;
 *   - rotation truncates only oversized logs and keeps the tail.
 */

function fakePrune(overrides?: Partial<PruneReport>): (args: { handle: string; dryRun: boolean }) => PruneReport {
  return ({ handle, dryRun }) => ({
    handle,
    dir: `/fake/${handle}`,
    missing: false,
    candidates: [],
    bytesReclaimable: 500 * 1024 ** 2,
    bytesBefore: 700 * 1024 ** 2,
    bytesAfter: dryRun ? null : 200 * 1024 ** 2,
    refused: null,
    deleted: !dryRun,
    identityIntact: dryRun ? null : true,
    identityMissing: [],
    identityChanged: [],
    sessionBefore: true,
    sessionAfter: dryRun ? null : true,
    backupDir: dryRun ? null : '/fake/backup',
    ...overrides,
  })
}

/** A lock that simply runs the function — the "nobody else is sending" case. */
const openLock: DiskCareDeps['lock'] = (_what, fn) => fn()

describe('rotateLogs', () => {
  it('truncates an oversized log, keeps the tail in .1, and leaves small logs alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disk-care-'))
    const big = join(dir, 'watch.log')
    const small = join(dir, 'tunnel.log')
    const notALog = join(dir, 'watch.log.1')
    writeFileSync(big, 'x'.repeat(9_000) + 'THE-TAIL-END')
    writeFileSync(small, 'short')
    writeFileSync(notALog, 'previous tail')

    const rotated = rotateLogs({ dir, maxBytes: 1_000, keepBytes: 100 })

    expect(rotated.map((r) => r.file)).toEqual(['watch.log'])
    expect(rotated[0]?.error).toBeNull()
    expect(statSync(big).size).toBe(0)
    const tail = readFileSync(`${big}.1`, 'utf8')
    expect(tail.endsWith('THE-TAIL-END')).toBe(true)
    expect(tail.length).toBe(100)
    // The small log and the rotated tail itself are untouched.
    expect(readFileSync(small, 'utf8')).toBe('short')
  })

  it('returns nothing for a directory that does not exist — absent logs are not an error', () => {
    expect(rotateLogs({ dir: join(tmpdir(), 'no-such-dir-disk-care') })).toEqual([])
  })
})

describe('diskCarePass', () => {
  it('does NOT prune when free space is above the floor', async () => {
    const calls: string[] = []
    const report = await diskCarePass({
      minFreeBytes: 10,
      freeBytes: () => 50,
      rotate: () => [],
      listProfiles: () => ['a'],
      prune: (args) => {
        calls.push(`${args.handle}:${args.dryRun}`)
        return fakePrune()(args)
      },
      lock: openLock,
    })
    expect(report.aboveFloor).toBe(true)
    expect(calls).toEqual([])
  })

  it('prunes every worthwhile profile when below the floor — dry-measured first, then for real', async () => {
    const calls: string[] = []
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['a', 'b'],
      prune: (args) => {
        calls.push(`${args.handle}:${args.dryRun ? 'dry' : 'REAL'}`)
        return fakePrune()(args)
      },
      lock: openLock,
    })
    expect(report.aboveFloor).toBe(false)
    expect(calls).toEqual(['a:dry', 'a:REAL', 'b:dry', 'b:REAL'])
    expect(report.pruned).toHaveLength(2)
    expect(report.identityDamage).toEqual([])
  })

  it('skips a profile whose reclaimable cache is too small to be worth a backup', async () => {
    const calls: string[] = []
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['tiny'],
      prune: (args) => {
        calls.push(`${args.handle}:${args.dryRun ? 'dry' : 'REAL'}`)
        return fakePrune({ bytesReclaimable: 1024 })(args)
      },
      lock: openLock,
    })
    expect(calls).toEqual(['tiny:dry'])
    expect(report.skippedSmall).toBe(1)
    expect(report.pruned).toEqual([])
  })

  /**
   * ── THE LOCK IS POLLED, BOUNDED (2026-09-10) ──────────────────────────────────────
   *
   * One try per pass lost almost every time once another Mac's dispatcher held the lock for
   * most of every minute — the reply sweep's 9 Sept defect, one lock user along — and this
   * Mac sat at 4.3 GiB free with 4.4 GiB of prunable cache while "the prune waits for the next
   * pass" was logged four times in an afternoon. The clock and the sleep are injected so the
   * wait is asserted in milliseconds of fake time, not endured in real ones.
   */
  it('polls for a busy lock and prunes the moment it is free', async () => {
    let clock = 0
    let tries = 0
    const calls: string[] = []
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['a'],
      prune: (args) => {
        calls.push(`${args.handle}:${args.dryRun ? 'dry' : 'REAL'}`)
        return fakePrune()(args)
      },
      // Busy on the first three tries, free on the fourth.
      lock: async (_what, fn) => (++tries < 4 ? null : fn()),
      lockWaitMs: 60_000,
      lockPollMs: 1_000,
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
    })
    expect(tries).toBe(4)
    expect(report.lockBusy).toBe(false)
    expect(report.lockWaitedMs).toBe(3_000)
    expect(calls).toEqual(['a:dry', 'a:REAL'])
  })

  it('steps aside once the wait budget is spent — bounded, never a wedge, and no prune races a live drive', async () => {
    let clock = 0
    let tries = 0
    const calls: string[] = []
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['a'],
      prune: (args) => {
        calls.push(args.handle)
        return fakePrune()(args)
      },
      lock: async () => {
        tries += 1
        return null
      },
      lockWaitMs: 5_000,
      lockPollMs: 1_000,
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
    })
    expect(report.lockBusy).toBe(true)
    expect(calls).toEqual([])
    // One immediate try, then one per poll inside the budget — and not one more after it.
    expect(tries).toBe(6)
    expect(report.lockWaitedMs).toBe(5_000)
  })

  it('reports identity damage instead of swallowing it', async () => {
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['hurt'],
      prune: (args) => fakePrune(args.dryRun ? {} : { identityIntact: false, identityMissing: ['Default/Cookies'] })(args),
      lock: openLock,
    })
    expect(report.identityDamage).toEqual(['hurt'])
  })

  it('a throwing pruner never takes the pass down — housekeeping must not stop the sender', async () => {
    const report = await diskCarePass({
      minFreeBytes: 100,
      freeBytes: () => 10,
      rotate: () => [],
      listProfiles: () => ['boom'],
      prune: () => {
        throw new Error('disk exploded')
      },
      lock: openLock,
    })
    // The pass resolves with what it had; it does not reject.
    expect(report.pruned).toEqual([])
  })
})