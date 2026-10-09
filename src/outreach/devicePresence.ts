/**
 * WHO THIS MAC IS, AND WHICH MACS ARE BEATING — one leaf module, no agent imports.
 *
 * Two facts that used to live in `src/agent/index.ts` and `src/agent/claim.ts`, moved here
 * on 2026-09-10 because the send lock needed them and the dispatcher cannot import the
 * agent: `agent/index.ts` imports the dispatcher, so the reverse edge is a cycle, and it
 * would drag the agent's whole module graph (connect pass, disk care, brand discovery) into
 * every process that merely wants to send — the web tier included.
 *
 * WHY THE DISPATCHER NEEDS THEM. The fleet send lock is a database row shared by every Mac
 * in the fleet, and until this date it identified its holder by PID ALONE. A pid is a fact
 * about one machine: `process.kill(pid, 0)` on Mac A says nothing about a process on Mac B,
 * and read "no such process here" as "the holder crashed" — so the day a second Mac joined,
 * each dispatcher stepped over the other's live lock on every tick (MEASURED: seven takeovers
 * in forty minutes, all naming the other Mac's live agent). The lock row now carries the
 * device, and a foreign holder's liveness is asked of `devicePresence` — the heartbeat every
 * device agent writes every 30 s — rather than of the local OS.
 */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import type { BuildVersionSource } from '@/lib/buildVersion'
import { keyFingerprint } from '@/lib/keyFingerprint'
export { hostId } from '@/lib/hostId'

/**
 * Identifies this machine.
 *
 * Recorded so that "which device is sending this?" is answerable, and so a draft stuck in
 * SENDING names the machine to go and look at. `hostname()` is not unique in principle
 * and is the honest best available — the alternative is a generated id nobody can map
 * back to a physical laptop, which is worse for the operator question this answers. The
 * installer writes `DS_DEVICE_NAME` from the name the operator typed.
 *
 * A BLANK NAME IS NO NAME (2026-10-09). This was `??`, so `DS_DEVICE_NAME=""` — or the
 * all-spaces name an older installer wrote for a ComputerName in a non-Latin script — was the
 * device name `''`, shared by every Mac that hit it, instead of falling back to the hostname.
 * Which Mac is "the sending Mac" is decided by this string, so two Macs agreeing on `''` would
 * both be it.
 */
export function deviceId(): string {
  return process.env.DS_DEVICE_NAME?.trim() || hostname()
}

/**
 * The fingerprint of this Mac's own tunnel key — the key the server authorised when it paired,
 * so the one fact about this Mac the server can check against `authorized_keys`. Carried in
 * presence so a Mac re-pairing under its own name is not refused as "another Mac is online with
 * that name" by its own heartbeat (2026-10-09). Absent on a Mac that tunnels with a hand key.
 */
export function tunnelKeyFingerprint(): string | undefined {
  try {
    const pub = readFileSync(join(homedir(), '.ssh', 'ds_tunnel_key.pub'), 'utf8').trim()
    return pub.startsWith('ssh-ed25519 ') ? keyFingerprint(pub) : undefined
  } catch {
    return undefined
  }
}

export const DEVICE_PRESENCE_KEY = 'devicePresence'

/** How often a device agent writes its presence. `PRESENCE_FRESH_MS` is derived from it. */
export const PRESENCE_INTERVAL_MS = 30_000

/** A device that has not written for four intervals is not here, whatever else it says. */
export const PRESENCE_FRESH_MS = 4 * PRESENCE_INTERVAL_MS

export interface DevicePresence {
  device: string
  at: string
  /** Which accounts this device holds a logged-in Chrome profile for. */
  handles: string[]
  /**
   * The build this agent is running (`buildVersion()`), so /senders can show a Mac that is
   * still on last week's DMG beside the installer's current build (2026-09-08). Optional
   * because rows written before this existed carry none — absence renders as "unknown",
   * never as "current".
   */
  version?: string
  /** 'stamp' = installed from an image (can be updated by re-running it); 'git' = a checkout. */
  versionSource?: BuildVersionSource
  /**
   * WHICH MACHINE wrote the entry (`hostId()`, 2026-10-09), so two Macs that share a name are two
   * entries rather than one entry overwritten every 30 seconds by each in turn. Absent on entries
   * from agents older than the field, and on a Mac whose id could not be read.
   */
  host?: string
  /** This Mac's tunnel-key fingerprint (`tunnelKeyFingerprint()`), for the enrolment name check. */
  keyFingerprint?: string
}

/** Every entry in the row, unfiltered — the enrolment name check reads further back than a heartbeat. */
export async function readPresenceEntries(): Promise<DevicePresence[]> {
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return (parsed as DevicePresence[]).filter((d) => d !== null && typeof d === 'object' && typeof d.device === 'string' && typeof d.at === 'string')
  } catch {
    return []
  }
}

/** Every device that has written its presence within `PRESENCE_FRESH_MS`, newest first. */
export async function readPresence(): Promise<DevicePresence[]> {
  const cutoff = Date.now() - PRESENCE_FRESH_MS
  return (await readPresenceEntries())
    .filter((d) => new Date(d.at).getTime() >= cutoff)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * PURE. The presence row after `me` writes (2026-10-09).
 *
 * Other names are kept exactly as before. Under OUR name this used to drop everything, so two
 * Macs with one name overwrote each other's entry every 30 seconds — their handles flapped and
 * the duplicate was never visible to anything. Now an entry under our name is dropped only when
 * it is OURS (same host), LEGACY (no host — most likely this very Mac before it learned the
 * field), or STALE; a fresh entry from another machine is kept beside ours, so a second Mac
 * running under this name is something every reader can see.
 */
export function mergePresence(all: readonly DevicePresence[], me: DevicePresence, now: number): DevicePresence[] {
  const kept = all.filter((d) => {
    if (d.device !== me.device) return true
    if (d.host === undefined || d.host === me.host) return false
    return now - new Date(d.at).getTime() < PRESENCE_FRESH_MS
  })
  return [...kept, me]
}

/**
 * Is the named Mac still beating? `undefined` — a lock row written by an agent older than
 * the device field — is NOT beating: the caller cannot place it, so it is honoured only
 * until the lock is stale. Absence of a name must never read as "alive".
 *
 * `host`, when the lock row carries one, must match too (2026-10-09): under a shared name THIS
 * Mac beats under the holder's name, so asking by name alone would say a dead twin is beating
 * for as long as we are — the lock it left behind would never be released.
 */
export async function deviceIsBeating(device: string | undefined, host?: string): Promise<boolean> {
  if (device === undefined) return false
  return (await readPresence()).some(
    (d) => d.device === device && (host === undefined || d.host === undefined || d.host === host),
  )
}
