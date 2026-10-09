import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_ROOT } from './paths'

/**
 * ── WHICH PHYSICAL MACHINE THIS IS — not which NAME it goes by (2026-10-09) ──────────────
 *
 * `deviceId()` is a NAME: `DS_DEVICE_NAME`, typed by a person or pre-filled from the Mac's
 * ComputerName. Nothing made two Macs choose different names, and two "Mac Studio"s each read
 * the other's send-lock row as their OWN — so each asked its own OS about the other's pid, was
 * told "no such process", and took the lock over a live drive; its orphan sweep then parked the
 * other Mac's in-flight message (MEASURED against the real modules: the C4 audit finding). A
 * name cannot separate them. A machine identity can.
 *
 * WHAT IT MUST BE: stable per MACHINE, not per process. A per-process random id would make a
 * crashed predecessor on the same Mac read as foreign, and a foreign holder is honoured until
 * its Mac stops beating — which, under the same name, it never does. That is a permanent lock
 * deadlock after any crash mid-drive.
 *
 * WHERE IT COMES FROM, in order:
 *   1. `DS_HOST_ID` — tests, and a deliberate override;
 *   2. under vitest, NOTHING — a test reaching the lock must not write into the real home;
 *   3. on macOS, a hash of the hardware's IOPlatformUUID (it also separates a Migration
 *      Assistant clone, which copies every file — the cache below included);
 *   4. the cache in DATA_ROOT/host-id, or a random id minted ONCE into it.
 *
 * THE CACHE NEVER FLIPS ON A TRANSIENT FAILURE. If `ioreg` times out the cached id is used, never
 * a freshly minted one: one Mac with two ids across two processes would read its own dashboard's
 * lock row as foreign, and would see its previous process's presence entry as a second Mac. A
 * hardware answer that DIFFERS from a hardware-sourced cache is a clone or a logic-board swap, so
 * the hardware wins and the cache is rewritten. A `random` cache is never replaced.
 *
 * UNDEFINED IS A REAL ANSWER and means "today's semantics": every caller compares host only when
 * both sides have one, so an unreadable host never makes this Mac read itself as foreign.
 */

export interface HostIdCache {
  id: string
  source: 'hardware' | 'random'
}

/** PURE apart from the injected reads and writes — the order of sources, and the never-flip rule. */
export function resolveHostId(args: {
  envId: string | undefined
  underTest: boolean
  /** The machine's hardware UUID, or undefined when it could not be read. */
  readHardware: () => string | undefined
  /** `null` = no cache file; `'unreadable'` = a file that exists and cannot be used. */
  readCache: () => HostIdCache | null | 'unreadable'
  /** Overwrite the cache. Best effort: a hardware-derived id is stable without it. */
  writeCache: (c: HostIdCache) => void
  /** Create the cache only if absent, and return what the file holds afterwards (a racing process may have won). */
  createCache: (c: HostIdCache) => HostIdCache | null
  newRandomId: () => string
}): string | undefined {
  const envId = args.envId?.trim()
  if (envId) return envId
  if (args.underTest) return undefined

  let hardware: string | undefined
  try {
    hardware = args.readHardware()
  } catch {
    hardware = undefined
  }
  const hwId = hardware ? createHash('sha256').update(hardware).digest('hex').slice(0, 16) : undefined

  let cache: HostIdCache | null | 'unreadable'
  try {
    cache = args.readCache()
  } catch {
    cache = 'unreadable'
  }

  if (hwId) {
    if (cache !== null && cache !== 'unreadable' && cache.source === 'random') return cache.id
    if (cache === null || cache === 'unreadable' || cache.id !== hwId) {
      try {
        args.writeCache({ id: hwId, source: 'hardware' })
      } catch {
        /* the id is derived from the hardware, so it is the same next time without the file */
      }
    }
    return hwId
  }

  // The hardware did not answer. A cached id — of either source — is the only id this machine
  // may use: minting a different one here is the flip described above.
  if (cache === 'unreadable') return undefined
  if (cache !== null) return cache.id
  try {
    return args.createCache({ id: args.newRandomId(), source: 'random' })?.id
  } catch {
    return undefined
  }
}

function readIoPlatformUuid(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  // cwd '/' because a launchd job whose cwd is a Desktop repo is refused `getcwd` by TCC.
  const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    cwd: '/',
    timeout: 5000,
    encoding: 'utf8',
  })
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1]
}

function parseCache(raw: string): HostIdCache | 'unreadable' {
  try {
    const c = JSON.parse(raw) as HostIdCache
    if (c && typeof c.id === 'string' && c.id.length > 0 && (c.source === 'hardware' || c.source === 'random')) return c
  } catch {
    /* falls through */
  }
  return 'unreadable'
}

/** The real reads and writes, against `<dataRoot>/host-id`. Exported so a test can aim it at a temp dir. */
export function hostIdFrom(
  dataRoot: string,
  readHardware: () => string | undefined = readIoPlatformUuid,
  underTest: boolean = process.env.VITEST !== undefined,
): string | undefined {
  const file = join(dataRoot, 'host-id')
  return resolveHostId({
    envId: process.env.DS_HOST_ID,
    underTest,
    readHardware,
    readCache: () => {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'unreadable'
      }
      return parseCache(raw)
    },
    writeCache: (c) => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(c))
    },
    createCache: (c) => {
      mkdirSync(dirname(file), { recursive: true })
      try {
        writeFileSync(file, JSON.stringify(c), { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      }
      const back = parseCache(readFileSync(file, 'utf8'))
      return back === 'unreadable' ? null : back
    },
    newRandomId: () => randomBytes(8).toString('hex'),
  })
}

let memo: { value: string | undefined } | null = null

/**
 * This machine's id, memoised per process — except an explicit `DS_HOST_ID`, which is read every
 * time so a test can vary it. The memo is what keeps `ioreg` to one spawn per process.
 */
export function hostId(): string | undefined {
  const envId = process.env.DS_HOST_ID?.trim()
  if (envId) return envId
  if (process.env.VITEST !== undefined) return undefined
  if (memo === null) memo = { value: hostIdFrom(DATA_ROOT) }
  return memo.value
}
