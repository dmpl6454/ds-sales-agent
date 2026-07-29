import 'dotenv/config'
import { z } from 'zod'

/**
 * Env is parsed once, loudly, at startup. A misconfigured cooldown or a
 * DRY_RUN that silently defaults to "off" is the kind of mistake that only
 * shows up as messages you did not intend to send — so it fails fast instead.
 */

/** "1" | "true" | "yes" -> true. Anything else (including empty) -> false. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
    })

const intish = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max))

/** "11:00,15:00" -> ["11:00","15:00"], validated as HH:MM. */
const slots = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.split(',').map((s) => s.trim()) : ['11:00', '15:00', '17:00', '20:00']))
  .pipe(z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'slot must be HH:MM')).min(1))

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Safety: defaults to ON. You must explicitly set DRY_RUN=0 to send anything.
  DRY_RUN: boolish(true),
  SLOTS: slots,
  TZ: z.string().optional().transform((v) => v ?? 'Asia/Kolkata'),
  CATCHUP_WINDOW_MINUTES: intish(240, 0, 1440),

  DEFAULT_COOLDOWN_DAYS: intish(7, 0, 365),
  MAX_PER_TARGET_PER_DAY: intish(1, 1, 10),
  HOOK_MAX_AGE_HOURS: intish(72, 1, 720),

  SEND_JITTER_MIN_SECONDS: intish(45, 0, 3600),
  SEND_JITTER_MAX_SECONDS: intish(180, 0, 3600),
  AUTOPILOT_ENABLED: boolish(false),

  OPERATOR_NAME: z.string().optional().transform((v) => v ?? 'operator'),
  HEADLESS: boolish(true),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fix the above.`)
}

export const env = parsed.data

if (env.SEND_JITTER_MIN_SECONDS > env.SEND_JITTER_MAX_SECONDS) {
  throw new Error('SEND_JITTER_MIN_SECONDS must be <= SEND_JITTER_MAX_SECONDS')
}

/** True when we are allowed to actually deliver messages. Checked at every send site. */
export const canSend = !env.DRY_RUN
