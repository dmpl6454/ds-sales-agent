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

  /**
   * Hard lifetime ceiling on messages ever sent. Empty string = no ceiling.
   * Defaults to 1: a fresh deployment can send exactly one message, which must
   * be raised deliberately. The safest default is the one that cannot surprise
   * you.
   */
  MAX_TOTAL_SENDS: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return 1
      if (v.trim().toLowerCase() === 'unlimited') return null
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1
    }),

  DEFAULT_COOLDOWN_DAYS: intish(7, 0, 365),
  /**
   * The one volume rule left (2026-08-18, Tabish): messages one account may deliver to
   * one recipient per IST day. Everything else is unlimited by his instruction.
   * (Replaces MAX_PER_TARGET_PER_DAY, which counted across all senders — the rule is
   * per account→recipient pair now, so the old key is ignored if still present.)
   */
  MAX_PER_PAIR_PER_DAY: intish(5, 1, 10),
  HOOK_MAX_AGE_HOURS: intish(72, 1, 720),

  SEND_JITTER_MIN_SECONDS: intish(45, 0, 3600),
  SEND_JITTER_MAX_SECONDS: intish(180, 0, 3600),
  AUTOPILOT_ENABLED: boolish(false),

  /**
   * The code someone must supply to create an account, once this is reachable from
   * anywhere other than 127.0.0.1.
   *
   * Empty means SIGNUP IS CLOSED — not "no gate". That direction is deliberate and it is
   * the opposite of what a permissive default would do: a server deployed without this
   * set refuses new accounts rather than offering an open door onto a page with a Send
   * button. The same reasoning as `AUTOPILOT_ENABLED` being an environment hard floor —
   * a web page must not be able to widen its own access.
   *
   * Generate with: openssl rand -hex 16
   */
  SIGNUP_INVITE_CODE: z.string().optional().transform((v) => v ?? ''),

  /**
   * MAY THIS DEPLOYMENT DRIVE A BROWSER AND SEND? A hard floor, like AUTOPILOT_ENABLED.
   *
   * `false` on the server, and it is what makes hosting safe at all. The Linode never
   * holds an Instagram session: the Chrome profiles carry device identity written by a
   * hand login from a HOME IP, and copying them to a datacenter is a cookie transplant —
   * `sessionid` is a bearer token with no channel binding, so it works right up until
   * enforcement lands silently. Research confirmed device+network continuity is a
   * pass/fail gate rather than a score.
   *
   * So the server detects, classifies and shows; the user's own machine sends. A
   * misconfigured server therefore prepares messages and delivers nothing, which is the
   * safe failure. Environment only, never settable from the dashboard.
   */
  SEND_ENABLED: boolish(true),

  /**
   * Where the built macOS installer (.dmg) lives, so the hosted dashboard can serve it from
   * a Download button. The Linode is Linux and CANNOT build a .dmg (`hdiutil` is macOS-only),
   * so the image is built on a Mac (`bash scripts/build-dmg.sh`) and the deploy copies it
   * here. Optional: unset (or a missing file) makes the download route say the installer has
   * not been published yet, rather than 500.
   */
  AGENT_DMG_PATH: z.string().optional(),

  /**
   * ── PAIRING A MAC FROM THE DASHBOARD (2026-09-03) ───────────────────────────────
   * A new Mac's installer pairs itself: it POSTs its own public key, the operator approves
   * on /devices/enrol, and the installer is handed the tunnel-side connection string and the
   * SSH endpoint once. These are what it is handed and where the key is written. Hosted
   * server only — approval refuses on a machine with SEND_ENABLED=true.
   */
  DEVICE_DATABASE_URL: z.string().optional(),
  DEVICE_AUTHORIZED_KEYS: z.string().optional().transform((v) => v ?? '/root/.ssh/authorized_keys'),
  /**
   * WHERE A NEWLY PAIRED MAC IS TOLD TO TUNNEL. It used to default to a hardcoded
   * '172.105.53.101' — and on 9 Sept 2026 that address stopped being ours: it is another
   * team's production box, which our processes must never touch again. A default naming the
   * wrong machine is worse than no default, because the pairing SUCCEEDS and the operator's
   * Mac quietly opens a tunnel to a stranger's server. Unset now means the enrol hand-off
   * refuses and says so, which is the same direction as SIGNUP_INVITE_CODE being unset
   * closing signup rather than opening it.
   */
  DEVICE_SSH_HOST: z.string().optional(),
  DEVICE_SSH_USER: z.string().optional().transform((v) => v ?? 'root'),

  OPERATOR_NAME: z.string().optional().transform((v) => v ?? 'operator'),

  /**
   * Which browser `pnpm send` opens, e.g. "Google Chrome" / "Brave Browser" /
   * "Safari". Empty = the macOS default handler for https.
   *
   * This exists because the default is not necessarily the browser you are logged
   * into Instagram in, and the failure mode is confusing: you get a login wall and
   * assume the agent lost your session. It never had one — the agent holds no
   * credentials at all. Name the browser here and the ambiguity goes away.
   */
  SEND_BROWSER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : null))
    .pipe(z.string().regex(/^[A-Za-z0-9 .()-]{1,40}$/, 'SEND_BROWSER must be an app name').nullable()),
})

/**
 * EVERY KEY THIS SCHEMA GOVERNS, so `.env.example` can be checked against it.
 *
 * MEASURED 2026-08-17, cloning the repo the way a second operator will: `.env.example` was
 * missing `SIGNUP_INVITE_CODE`, `SEND_ENABLED` and `MAX_TOTAL_SENDS`. The first of those is
 * a DEAD END rather than an inconvenience — an unset invite code means signup is CLOSED, so
 * a new operator installs the app, starts it, and can never create the account that would
 * let them use it. Nothing says why, because that behaviour is correct on a server.
 *
 * `tests/env-example.test.ts` is total over this list, for the same reason
 * `tests/stopInventory.test.ts` is total over `RESEND_BLOCKS`: the failure mode is a key
 * somebody adds here and forgets to document, and no behavioural test can fail for that.
 */
export const ENV_KEYS = Object.keys(schema.shape).sort()

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
