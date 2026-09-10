import { closeSync, openSync, readdirSync, readSync, statSync, statfsSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '@/lib/logger'
import { DATA_ROOT, LOGS_DIR, PROFILES_DIR } from '@/lib/paths'
import { pruneProfile, type PruneReport } from '@/outreach/browser/pruneProfile'
import { withSendLock } from '@/outreach/dispatcher'

/**
 * DISK CARE — the device agent keeps its own machine from filling up, with nobody running
 * a command.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * This Mac has hit LITERALLY ZERO bytes free twice (2026-08-19, mid-session — every tool
 * including `df` failed), and `pnpm ig:prune` existed both times. The fix was always one
 * command away and the disk still filled, which is this repo's most-repeated lesson:
 * *a feature that works only when someone runs a command is not running* (166 cover frames,
 * brand discovery, the reply sweep — all the same shape). Measured 2026-09-02 when this was
 * built: 5.0 GB of Chrome profile cache (7 profiles, 88% disposable) and a 236 MB watch.log
 * with no rotation, against single-digit GB free.
 *
 * Two jobs, deliberately independent:
 *
 *   1. LOG ROTATION, every pass regardless of free space. launchd appends to the same
 *      files forever; a log is not a ledger, so the tail is kept and the rest dropped.
 *   2. PROFILE CACHE PRUNE, only when free space is BELOW the floor. It reuses
 *      `pruneProfile` — the allowlist, the is-Chrome-open refusal, the backup and the
 *      hash verification all apply unchanged. This module adds a CALLER, never a second
 *      implementation (the gate.ts/readThread.ts drift, avoided by construction).
 *
 * ── WHY THE PRUNE RUNS UNDER THE SEND LOCK ──────────────────────────────────
 *
 * Deleting cache out from under a live browser can corrupt the cookie database, and the
 * cookie database IS the credential. Every browser drive on this machine happens inside
 * `withSendLock`, so holding it guarantees no drive starts mid-prune. `pruneProfile`'s own
 * per-profile OS check is kept as the second layer — the same both-ends discipline as every
 * load-bearing rule here. A busy lock skips the pass; the next one is hours away and the
 * disk does not fill in hours.
 *
 * ── FAILURE POSTURE ─────────────────────────────────────────────────────────
 *
 * Never allowed to take the agent down: disk care is housekeeping, and housekeeping
 * failing must not stop messages that are already written from going out (the brandPass
 * rule, verbatim). Identity damage after a prune — a protected file missing or changed —
 * is ALARMED, because that is a destroyed or contended profile, not a detail.
 */

/** How often disk care runs. Cache regrows with sends, not with wall-clock, so hours. */
export const DISK_CARE_INTERVAL_MS = 6 * 60 * 60_000

/**
 * ── THE PRUNE POLLS FOR THE LOCK, BOUNDED (2026-09-10) ─────────────────────────────
 *
 * Disk care used to ask for the fleet send lock ONCE and skip the pass if it was busy. That
 * was the reply sweep's defect of 9 Sept in a third costume: with another Mac's dispatcher
 * holding the lock for most of every minute, one try loses almost every time, and "the prune
 * waits for the next pass" was logged four times on 10 Sept while this Mac sat at 4.3 GiB free
 * with 4.4 GiB of prunable profile cache — on a disk that has hit literally zero twice.
 *
 * So it polls, like the sweep: one `create` on the lock row per try, nothing held while it
 * waits. Every second rather than every five, because the holder that starved it re-takes the
 * lock milliseconds after releasing it and a five-second poll lands inside its next hold
 * (the sweep lost a three-minute wait to exactly that the same afternoon). Still bounded, so
 * a pass never turns into a wedge; a busy lock after the budget is reported, not retried.
 */
export const DISK_CARE_LOCK_WAIT_MS = 3 * 60_000
export const DISK_CARE_LOCK_POLL_MS = 1_000

/**
 * The free-space floor that triggers a prune, in bytes (10 GiB).
 *
 * Chosen from the measured failure, not taste: the machine died at 0 twice, cache regrows
 * ~80 MB per profile per active day, and a full prune reclaims ~4-5 GB — so a 10 GiB floor
 * gives weeks of headroom between passes while never pruning a machine that has plenty.
 */
export const MIN_FREE_BYTES = 10 * 1024 ** 3

/** A live log over this size is rotated (25 MB — watch.log was 236 MB when this shipped). */
export const LOG_ROTATE_AT_BYTES = 25 * 1024 ** 2

/** How much recent history survives a rotation, copied into `<name>.1`. */
export const LOG_KEEP_TAIL_BYTES = 2 * 1024 ** 2

/**
 * A profile whose reclaimable cache is under this is left alone. A prune writes a backup
 * directory and walks the whole profile twice; doing that to reclaim 3 MB is churn.
 */
export const PRUNE_WORTH_BYTES = 64 * 1024 ** 2

/** Free bytes on the volume holding `path` — what an unprivileged writer can actually use. */
export function freeBytesAt(path: string): number {
  const s = statfsSync(path)
  return Number(s.bavail) * Number(s.bsize)
}

export interface RotatedLog {
  file: string
  bytesBefore: number
  error: string | null
}

/**
 * Rotate every `*.log` in `dir` that has outgrown `maxBytes`: the last `keepBytes` are
 * copied to `<name>.1` (overwritten each time, so history is bounded at one tail), then the
 * live file is truncated to zero.
 *
 * The live file is truncated IN PLACE rather than renamed, because launchd holds it open —
 * a rename would leave launchd appending to a detached inode and the visible file empty
 * forever. launchd opens StandardOutPath in append mode, so writes after a truncate land at
 * the new end; if a future macOS opened it plain, writes at the old offset make a sparse
 * file, which APFS stores compactly — wrong-looking `ls` size, disk still reclaimed.
 *
 * Lines written between the tail read and the truncate are lost. Acceptable by design:
 * this is a log, not a ledger — everything load-bearing is in the database.
 */
export function rotateLogs(args?: { dir?: string; maxBytes?: number; keepBytes?: number }): RotatedLog[] {
  const { dir = LOGS_DIR, maxBytes = LOG_ROTATE_AT_BYTES, keepBytes = LOG_KEEP_TAIL_BYTES } = args ?? {}
  const rotated: RotatedLog[] = []

  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.log'))
  } catch {
    return rotated // no logs directory on this machine — nothing to do, not an error
  }

  for (const name of names) {
    const full = join(dir, name)
    try {
      const size = statSync(full).size
      if (size <= maxBytes) continue

      const tailLength = Math.min(keepBytes, size)
      const buffer = Buffer.alloc(tailLength)
      const fd = openSync(full, 'r')
      try {
        readSync(fd, buffer, 0, tailLength, size - tailLength)
      } finally {
        closeSync(fd)
      }
      // `.1` — not `.log` — so a rotated tail can never itself be selected for rotation.
      writeFileSync(`${full}.1`, buffer)
      truncateSync(full, 0)
      rotated.push({ file: name, bytesBefore: size, error: null })
    } catch (err) {
      rotated.push({ file: name, bytesBefore: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return rotated
}

/** Which profiles exist on this machine's disk. Empty when the directory is absent. */
function profilesOnDisk(): string[] {
  try {
    return readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface DiskCareReport {
  rotated: RotatedLog[]
  freeBytesBefore: number
  freeBytesAfter: number
  /** True when free space was above the floor, so no prune was attempted. */
  aboveFloor: boolean
  /** True when a send held the lock for the whole wait budget and the prune stepped aside. */
  lockBusy: boolean
  /** How long the pass polled for the lock — before it got it, or before it gave up. */
  lockWaitedMs: number
  pruned: PruneReport[]
  skippedSmall: number
  /** Handles whose prune left a protected file missing or changed — an alarm, never a detail. */
  identityDamage: string[]
}

/** Injection seams for tests. Production callers pass nothing. */
export interface DiskCareDeps {
  minFreeBytes?: number
  freeBytes?: () => number
  rotate?: () => RotatedLog[]
  listProfiles?: () => string[]
  prune?: (args: { handle: string; dryRun: boolean }) => PruneReport
  lock?: <T>(what: string, fn: () => Promise<T>) => Promise<T | null>
  /** The wait budget and poll cadence for a busy lock — injectable so the test needs no clock. */
  lockWaitMs?: number
  lockPollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * One disk-care pass: rotate oversized logs, and when free space is below the floor,
 * prune every profile worth pruning under the send lock. Never throws.
 */
export async function diskCarePass(deps?: DiskCareDeps): Promise<DiskCareReport> {
  const {
    minFreeBytes = MIN_FREE_BYTES,
    freeBytes = () => freeBytesAt(DATA_ROOT),
    rotate = rotateLogs,
    listProfiles = profilesOnDisk,
    prune = pruneProfile,
    lock = withSendLock,
    lockWaitMs = DISK_CARE_LOCK_WAIT_MS,
    lockPollMs = DISK_CARE_LOCK_POLL_MS,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = deps ?? {}

  const report: DiskCareReport = {
    rotated: [],
    freeBytesBefore: 0,
    freeBytesAfter: 0,
    aboveFloor: false,
    lockBusy: false,
    lockWaitedMs: 0,
    pruned: [],
    skippedSmall: 0,
    identityDamage: [],
  }

  try {
    report.rotated = rotate()

    report.freeBytesBefore = freeBytes()
    report.freeBytesAfter = report.freeBytesBefore
    if (report.freeBytesBefore >= minFreeBytes) {
      report.aboveFloor = true
      return report
    }

    const pruneAll = async () => {
      const done: PruneReport[] = []
      for (const handle of listProfiles()) {
        // Measure first (dry run is the default and costs no writes); only a profile with
        // real cache to give back pays for a backup directory and a second walk.
        const dry = prune({ handle, dryRun: true })
        if (dry.missing || dry.bytesReclaimable < PRUNE_WORTH_BYTES) {
          report.skippedSmall += 1
          continue
        }
        done.push(prune({ handle, dryRun: false }))
      }
      return done
    }

    // Poll for the lock, bounded — see DISK_CARE_LOCK_WAIT_MS. Each try is one `create` on
    // the lock row and holds nothing while it waits; the callback runs only once it is held.
    const started = now()
    let outcome = await lock('disk-care', pruneAll)
    while (outcome === null && now() - started < lockWaitMs) {
      await sleep(lockPollMs)
      outcome = await lock('disk-care', pruneAll)
    }
    report.lockWaitedMs = now() - started

    if (outcome === null) {
      report.lockBusy = true
      return report
    }
    report.pruned = outcome
    report.identityDamage = outcome
      .filter((p) => p.deleted && (p.identityIntact === false || (p.sessionBefore && p.sessionAfter === false)))
      .map((p) => p.handle)
    report.freeBytesAfter = freeBytes()
    return report
  } catch (err) {
    // Housekeeping must never take the sender down.
    log.error('disk care pass failed', { error: err instanceof Error ? err.message : String(err) })
    return report
  }
}

const gb = (n: number): string => (n / 1024 ** 3).toFixed(1)

/** The pass plus its log lines — what the agent's timer actually calls. */
export async function diskCareTick(): Promise<void> {
  const report = await diskCarePass()

  for (const r of report.rotated) {
    if (r.error) log.warn('log rotation failed for one file', { file: r.file, error: r.error })
    else log.info('rotated an oversized log', { file: r.file, wasMb: Math.round(r.bytesBefore / 1024 ** 2) })
  }

  if (report.aboveFloor) {
    log.step('disk care: free space is fine', { freeGb: gb(report.freeBytesBefore) })
    return
  }
  if (report.lockBusy) {
    log.step('disk care: a send held the lock for the whole wait — the prune waits for the next pass', {
      waitedSeconds: Math.round(report.lockWaitedMs / 1000),
    })
    return
  }

  const freed = report.pruned.reduce((n, p) => n + (p.bytesBefore - (p.bytesAfter ?? p.bytesBefore)), 0)
  log.info('disk care pruned profile caches', {
    freeGbBefore: gb(report.freeBytesBefore),
    freeGbAfter: gb(report.freeBytesAfter),
    freedMb: Math.round(freed / 1024 ** 2),
    pruned: report.pruned.filter((p) => p.deleted).length,
    refused: report.pruned.filter((p) => p.refused !== null).map((p) => `${p.handle}: ${p.refused}`),
    skippedSmall: report.skippedSmall,
  })

  if (report.identityDamage.length > 0) {
    // A protected file missing or changed after a prune is a destroyed or contended
    // profile. The backup taken before the delete is the recovery path.
    log.alarm('disk care: a profile identity file changed during pruning — check the backup', {
      handles: report.identityDamage.join(', '),
    })
  }
}