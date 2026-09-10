/**
 * ── THE SENDING MAC — one Mac does the fleet's work; every other Mac holds (2026-09-10) ──
 *
 * Tabish: *"select in the senders page which mac would be responsible for everything and at a
 * switch of a button the other mac starts doing all the tasks … any other paired future mac
 * won't send or do anything regardless of signed in senders unless they are selected."*
 *
 * The day a second Mac joined the fleet, "each Mac sends for the profiles on its disk" turned
 * out to mean two Macs holding one profile both sending from it, two dispatchers contending
 * for one lock, and nothing on any screen saying which Mac was in charge. This is the rule
 * that replaces disk-ownership as the arbiter: the `activeDevice` Setting names ONE Mac, and
 * that Mac alone dispatches, sweeps replies, looks up brands and reads feeds in failover.
 * Every other Mac keeps beating (so it can be chosen), records its sessions, services the
 * sign-in windows addressed to it (so it can be PREPARED before it is chosen), cares for its
 * own disk — and drives no browser and spends no lookup.
 *
 * FAIL CLOSED. No Mac selected means no Mac sends, and the landing page says so in a
 * sentence; the alternative — "unset means everybody" — is exactly the state this rule exists
 * to end, arriving by default on every fresh deployment. Enforced at BOTH ends like every
 * load-bearing rule here: `withSendLock` (every browser drive passes through it, whoever
 * called) and the top of each agent pass (so a standby Mac does not even evaluate the queue
 * under the fleet lock).
 *
 * `decideDeviceRole` is PURE; `thisMacRole` reads the Setting fresh on every call — the agent
 * asks it per tick, exactly as it asks the autopilot switch — and an UNREADABLE setting is a
 * refusal, never permission ("we could not ask" must never authorise driving a browser).
 */
import { getSettings } from '@/lib/settings'
import { deviceId } from './devicePresence'

export type DeviceRole =
  | { active: true; selected: string; thisDevice: string }
  | {
      active: false
      selected: string | null
      thisDevice: string
      reason: 'none-selected' | 'another-mac' | 'unreadable'
      detail: string
    }

export function decideDeviceRole(args: { selected: string | null; thisDevice: string }): DeviceRole {
  const { selected, thisDevice } = args
  if (selected === null || selected.trim() === '') {
    return {
      active: false,
      selected: null,
      thisDevice,
      reason: 'none-selected',
      detail: 'no Mac is selected to send — choose one on Senders → Sending Mac; nothing sends anywhere until then',
    }
  }
  if (selected === thisDevice) return { active: true, selected, thisDevice }
  return {
    active: false,
    selected,
    thisDevice,
    reason: 'another-mac',
    detail: `${selected} is the selected sending Mac — this Mac (${thisDevice}) holds everything, whatever is signed in here`,
  }
}

export async function thisMacRole(): Promise<DeviceRole> {
  const thisDevice = deviceId()
  try {
    const settings = await getSettings()
    return decideDeviceRole({ selected: settings.activeDevice, thisDevice })
  } catch (err) {
    return {
      active: false,
      selected: null,
      thisDevice,
      reason: 'unreadable',
      detail: `could not read which Mac is selected to send (${err instanceof Error ? err.message : String(err)}) — holding`,
    }
  }
}
