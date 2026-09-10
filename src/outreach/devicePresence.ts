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
import { hostname } from 'node:os'
import { prisma } from '@/lib/db'
import type { BuildVersionSource } from '@/lib/buildVersion'

/**
 * Identifies this machine.
 *
 * Recorded so that "which device is sending this?" is answerable, and so a draft stuck in
 * SENDING names the machine to go and look at. `hostname()` is not unique in principle
 * and is the honest best available — the alternative is a generated id nobody can map
 * back to a physical laptop, which is worse for the operator question this answers. The
 * installer writes `DS_DEVICE_NAME` from the name the operator typed.
 */
export function deviceId(): string {
  return process.env.DS_DEVICE_NAME ?? hostname()
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
}

/** Every device that has written its presence within `PRESENCE_FRESH_MS`, newest first. */
export async function readPresence(): Promise<DevicePresence[]> {
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - PRESENCE_FRESH_MS
    return (parsed as DevicePresence[])
      .filter((d) => new Date(d.at).getTime() >= cutoff)
      .sort((a, b) => b.at.localeCompare(a.at))
  } catch {
    return []
  }
}

/**
 * Is the named Mac still beating? `undefined` — a lock row written by an agent older than
 * the device field — is NOT beating: the caller cannot place it, so it is honoured only
 * until the lock is stale. Absence of a name must never read as "alive".
 */
export async function deviceIsBeating(device: string | undefined): Promise<boolean> {
  if (device === undefined) return false
  return (await readPresence()).some((d) => d.device === device)
}
