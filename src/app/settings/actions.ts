'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { setSetting, SETTING_KEYS, readNumericSetting, getSettings } from '@/lib/settings'

/**
 * Saving the runtime settings.
 *
 * `requireUser()` is the FIRST statement, before any argument is read. Middleware is a
 * router filter; a server action is a POST endpoint, and these values change who gets
 * messaged and how often.
 */

export interface SaveSettingsInput {
  maxPerTargetPerDay: string
  defaultCooldownDays: string
  hookMaxAgeHours: string
  maxNewBrandTouchesPerDay: string
  personaGateChannels: boolean
}

export async function saveSettings(input: SaveSettingsInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser()

  /**
   * VALIDATED BEFORE IT IS STORED, using the same reader that applies it.
   *
   * The Setting row overriding a range-checked env value used to be checked for nothing,
   * so 1000, -5 and 2.5 were all accepted silently while the validated default quietly
   * stopped applying. Running the value through `readNumericSetting` here means the form
   * refuses what the reader would have ignored — rather than accepting it, storing it,
   * and silently using something else.
   */
  const rejected: string[] = []
  const checkNumber = (key: string, raw: string, opts?: { allowUnlimited?: boolean }): string | null => {
    const sentinel = -999_999
    const parsed = readNumericSetting(key, raw, sentinel, opts)
    if (parsed === sentinel) {
      rejected.push(key)
      return null
    }
    return raw.trim()
  }

  const values: [string, string | null][] = [
    [
      SETTING_KEYS.maxPerTargetPerDay,
      checkNumber(SETTING_KEYS.maxPerTargetPerDay, input.maxPerTargetPerDay, { allowUnlimited: true }),
    ],
    [SETTING_KEYS.defaultCooldownDays, checkNumber(SETTING_KEYS.defaultCooldownDays, input.defaultCooldownDays)],
    [SETTING_KEYS.hookMaxAgeHours, checkNumber(SETTING_KEYS.hookMaxAgeHours, input.hookMaxAgeHours)],
    [
      SETTING_KEYS.maxNewBrandTouchesPerDay,
      checkNumber(SETTING_KEYS.maxNewBrandTouchesPerDay, input.maxNewBrandTouchesPerDay),
    ],
  ]

  if (rejected.length > 0) {
    return {
      ok: false,
      message: `Nothing was saved. These need a whole number of 1 or more${''}: ${rejected.join(', ')}.`,
    }
  }

  const before = await getSettings()

  for (const [key, value] of values) if (value !== null) await setSetting(key, value)
  await setSetting(SETTING_KEYS.personaGateChannels, input.personaGateChannels ? 'true' : 'false')

  /**
   * Audited with the BEFORE and AFTER of anything that loosens a guard.
   *
   * Raising a cap or switching the persona gate off is the sort of change that is
   * obvious on the day and unexplainable a month later. The audit row is the only place
   * that answers "who widened this, and from what".
   */
  const after = await getSettings()
  const changes: string[] = []
  if (before.maxPerTargetPerDay !== after.maxPerTargetPerDay)
    changes.push(`maxPerTargetPerDay ${before.maxPerTargetPerDay} → ${after.maxPerTargetPerDay}`)
  if (before.defaultCooldownDays !== after.defaultCooldownDays)
    changes.push(`cooldownDays ${before.defaultCooldownDays} → ${after.defaultCooldownDays}`)
  if (before.hookMaxAgeHours !== after.hookMaxAgeHours)
    changes.push(`hookMaxAgeHours ${before.hookMaxAgeHours} → ${after.hookMaxAgeHours}`)
  if (before.maxNewBrandTouchesPerDay !== after.maxNewBrandTouchesPerDay)
    changes.push(`newBrandTouches ${before.maxNewBrandTouchesPerDay} → ${after.maxNewBrandTouchesPerDay}`)
  if (before.personaGateChannels !== after.personaGateChannels)
    changes.push(`personaGateChannels ${before.personaGateChannels} → ${after.personaGateChannels}`)

  if (changes.length > 0) {
    await prisma.auditLog.create({
      data: {
        actor: user.email,
        action: 'settings.saved',
        entity: 'Setting',
        detail: changes.join('; '),
      },
    })
  }

  revalidatePath('/settings')
  revalidatePath('/')
  return {
    ok: true,
    message: changes.length === 0 ? 'No changes.' : `Saved. ${changes.join('; ')}.`,
  }
}
