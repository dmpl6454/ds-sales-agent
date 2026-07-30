import { prisma } from './db'
import { env } from './env'

/**
 * Runtime-editable settings, stored in the Setting table so /settings can change
 * behaviour without a redeploy. Env provides the defaults.
 *
 * Cooldown lives here rather than only in env because it is the knob most likely
 * to be tuned after watching real replies — and tuning it should not require SSH.
 */

export const SETTING_KEYS = {
  defaultCooldownDays: 'defaultCooldownDays',
  maxPerTargetPerDay: 'maxPerTargetPerDay',
  hookMaxAgeHours: 'hookMaxAgeHours',
  autopilotEnabled: 'autopilotEnabled',
} as const

export interface RuntimeSettings {
  defaultCooldownDays: number
  maxPerTargetPerDay: number
  hookMaxAgeHours: number
  /** Global kill switch. A sender also needs its own autoSendEnabled. */
  autopilotEnabled: boolean
}

function defaults(): RuntimeSettings {
  return {
    defaultCooldownDays: env.DEFAULT_COOLDOWN_DAYS,
    maxPerTargetPerDay: env.MAX_PER_TARGET_PER_DAY,
    hookMaxAgeHours: env.HOOK_MAX_AGE_HOURS,
    autopilotEnabled: env.AUTOPILOT_ENABLED,
  }
}

export async function getSettings(): Promise<RuntimeSettings> {
  const rows = await prisma.setting.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const d = defaults()

  const num = (key: string, fallback: number): number => {
    const raw = map.get(key)
    if (raw === undefined) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = map.get(key)
    if (raw === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
  }

  return {
    defaultCooldownDays: num(SETTING_KEYS.defaultCooldownDays, d.defaultCooldownDays),
    maxPerTargetPerDay: num(SETTING_KEYS.maxPerTargetPerDay, d.maxPerTargetPerDay),
    hookMaxAgeHours: num(SETTING_KEYS.hookMaxAgeHours, d.hookMaxAgeHours),
    /**
     * Two different questions, deliberately not conflated:
     *
     *   AUTOPILOT_ENABLED (env)  — MAY this deployment send unattended?  Hard floor.
     *   the DB row               — IS it switched on right now?           Defaults OFF.
     *
     * The fallback here is a literal `false`, not `d.autopilotEnabled`. It used to be
     * the latter, and the consequence was found the moment the toggle appeared on
     * screen: flipping AUTOPILOT_ENABLED=true to *permit* autopilot also silently
     * *armed* it, and the dashboard read "Autopilot is ON" with nobody having
     * chosen that. Granting permission must never be the same act as switching on.
     */
    autopilotEnabled: d.autopilotEnabled && bool(SETTING_KEYS.autopilotEnabled, false),
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}
