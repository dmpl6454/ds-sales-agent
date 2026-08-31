import { istStamp } from './time'

/**
 * Deliberately tiny. The worker's real audit trail is the ScrapeRun and
 * AuditLog tables — stdout is for watching it work, not for forensics.
 *
 * `alarm` is separate from `error` on purpose: it marks the failures that mean
 * "the system is quietly doing nothing", which is the dangerous mode. A broken
 * parser returning zero posts looks exactly like a quiet news day unless we
 * shout about it.
 */

type Fields = Record<string, unknown>

function fmt(level: string, msg: string, fields?: Fields): string {
  const base = `${istStamp()} ${level.padEnd(5)} ${msg}`
  if (!fields || Object.keys(fields).length === 0) return base
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return `${base}  ${kv}`
}

/**
 * A thrown value in words, and NEVER an empty string.
 *
 * ── MEASURED 2026-08-31 ─────────────────────────────────────────────────────
 *
 * The device agent's own log carried **272 lines reading `device tick failed error=`** —
 * an error report naming nothing, which is worse than no line at all because it looks
 * handled. The cause is that `err.message` is legitimately empty on some of what the
 * database driver throws (the informative part sits on `name`, `code` or `cause`), and
 * every one of this codebase's ~50 catch blocks reaches for `.message` alone.
 *
 * So the fallbacks are tried in order and the LAST of them is the constructor name, which
 * always exists. "Something threw and we cannot say what" is itself a fact worth printing;
 * silence is not. Same principle as `framesRead`'s five states and `identify`'s
 * `no-answer` — an absence must be reported as an absence, not rendered as nothing.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    const s = String(err)
    return s.trim().length > 0 ? s : `a non-Error value was thrown (${typeof err})`
  }
  const parts = [
    err.message,
    // Prisma and undici put the useful half here when `message` is blank.
    typeof (err as unknown as { code?: unknown }).code === 'string'
      ? `code ${(err as unknown as { code: string }).code}`
      : '',
    err.cause instanceof Error ? `caused by ${err.cause.name}: ${err.cause.message}` : '',
  ].filter((p) => p.trim().length > 0)
  if (parts.length > 0) return parts.join(' — ')
  return `${err.name || err.constructor.name} was thrown with no message`
}

export const log = {
  info(msg: string, fields?: Fields) {
    console.log(fmt('INFO', msg, fields))
  },
  warn(msg: string, fields?: Fields) {
    console.warn(fmt('WARN', msg, fields))
  },
  error(msg: string, fields?: Fields) {
    console.error(fmt('ERROR', msg, fields))
  },
  /** A failure that would otherwise be invisible. Always investigate. */
  alarm(msg: string, fields?: Fields) {
    console.error(fmt('ALARM', `🚨 ${msg}`, fields))
  },
  step(msg: string, fields?: Fields) {
    console.log(fmt('STEP', `→ ${msg}`, fields))
  },
}
