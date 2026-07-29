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
