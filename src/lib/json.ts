/**
 * SQLite has no array type, so list columns (brands, signals, run detail) are
 * stored as JSON strings. These helpers are the only place that knows that —
 * callers work with real arrays and objects.
 *
 * Reads are deliberately forgiving: a corrupt or hand-edited cell yields an
 * empty list rather than crashing a scrape run. Detection data is disposable;
 * the run finishing is not.
 */

export function readStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

export function writeStringArray(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)])
}

export function readRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function writeRecord(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}
