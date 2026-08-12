import Database from 'better-sqlite3'
import { Client } from 'pg'

/**
 *   pnpm ig:copy-to-postgres            (dry run — counts and checks, writes NOTHING)
 *   pnpm ig:copy-to-postgres --run      (copies)
 *
 * Move every row from the SQLite file to Postgres, once.
 *
 * ── WHY A SCRIPT AND NOT A MIGRATION TOOL ───────────────────────────────────
 *
 * 1,851 posts, 46 attempts and 2,060 model calls is small. A general-purpose tool would
 * bring type inference, batching heuristics and a lot of behaviour nobody here has read,
 * to move an amount of data that fits in memory twice over. The risk in this operation is
 * not throughput; it is silently dropping or mangling rows, and a script whose every step
 * is visible is easier to be sure about than a tool whose defaults are not.
 *
 * ── THE ORDER IS FOREIGN KEYS, NOT PREFERENCE ───────────────────────────────
 *
 * Postgres enforces referential integrity that SQLite was not enforcing here, so parents
 * must land before children or the insert fails. That is a FEATURE of this migration: a
 * row that fails to insert because its parent is missing is an orphan the old database was
 * quietly holding, and it should surface loudly rather than travel.
 *
 * ── EVERY VALUE IS CONVERTED EXPLICITLY ─────────────────────────────────────
 *
 * SQLite has no real BOOLEAN (0/1 integers) and no real DATETIME (ISO strings). Postgres
 * has both, and `pg` will not coerce an integer into a boolean or a string into a
 * timestamp. So the column types are read from the DESTINATION's own catalogue and each
 * value converted to match — rather than guessing from the value's JavaScript type, which
 * would make `0` in an integer column indistinguishable from `false` in a boolean one.
 *
 * ── IT VERIFIES, AND THE VERIFICATION IS NOT A COUNT ────────────────────────
 *
 * Counting rows on both sides proves only that the same NUMBER arrived. This also
 * re-reads a sample of real rows and compares field by field, because "1851 = 1851" is
 * exactly the kind of check that passes while a column has been dropped, truncated or
 * type-mangled — the same shape as the frame migration whose SHA-256 was perfect while
 * the file's mode bit was wrong.
 */

const SQLITE_PATH = process.env.SQLITE_PATH ?? './prisma/dev.db'

/**
 * Parents first. Verified against the schema's relations rather than assumed:
 * SenderAccount and TargetAccount are roots; OutreachPair depends on both; OutreachAttempt
 * depends on the pair, the variant and (optionally) a campaign.
 */
const TABLE_ORDER = [
  'Setting',
  'User',
  'Session',
  'SenderAccount',
  'TargetAccount',
  'Category',
  'CategorySender',
  'CategoryTarget',
  'MessageVariant',
  'DetectedCampaign',
  'OutreachPair',
  'OutreachAttempt',
  'ModelCall',
  'ScrapeRun',
  'AuditLog',
  'BrandLookup',
  'KnownPaidPost',
  'DailyReservation',
  'RuleFeedback',
] as const

interface ColumnType {
  name: string
  /** Postgres's own type name, from the destination catalogue. Never inferred. */
  dataType: string
}

async function destinationColumns(pg: Client, table: string): Promise<ColumnType[]> {
  const r = await pg.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )
  return r.rows.map((row) => ({ name: row.column_name as string, dataType: row.data_type as string }))
}

/**
 * One SQLite value, converted for one Postgres column.
 *
 * Driven by the DESTINATION type, deliberately. Inferring from the value would read `0` in
 * an INTEGER column and `0` meaning false in a BOOLEAN column as the same thing — and
 * `enabled = 0` silently becoming `true` is the kind of error that only shows up when a
 * disabled pair sends a message.
 */
function convert(value: unknown, column: ColumnType): unknown {
  if (value === null || value === undefined) return null

  if (column.dataType === 'boolean') {
    // SQLite stores these as 0/1 integers.
    return value === 1 || value === '1' || value === true
  }

  if (column.dataType.startsWith('timestamp')) {
    /**
     * ── NEVER HAND A `Date` TO A NAIVE TIMESTAMP COLUMN ───────────────────────
     *
     * This returned `new Date(value)` and it was WRONG, in a way that survived the
     * migration's own verification and took a negative number on a dashboard to find.
     *
     * These columns are `timestamp WITHOUT time zone`. Given a JS `Date`, the `pg` driver
     * serialises it using the CLIENT's LOCAL timezone — so a copy run from a machine at
     * UTC+05:30 stored every value 5½ hours ahead. MEASURED: SQLite held
     * `2026-08-07T05:30:45.145+00:00`, Postgres stored `2026-08-07 11:00:45.145`.
     *
     * WHY IT HID. The driver applies the SAME offset on the way back out, so a JS-to-JS
     * comparison from the copying machine round-trips perfectly and reports no difference
     * — the first corrective dry run said "6291 compared, 0 differ" against values that
     * were all shifted. Only `::text`, or a reader in a different timezone, shows it. And
     * a different timezone is exactly what the SERVER is: it runs at UTC and read every
     * copied row 5½ hours late.
     *
     * The fix is to send a STRING already in UTC wall-clock form and let Postgres store it
     * verbatim. A string has no timezone for a driver to apply, so no machine's locale can
     * change what lands in the column.
     */
    const d =
      typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null
    if (!d || Number.isNaN(d.getTime())) {
      if (typeof value === 'string' || typeof value === 'number') {
        throw new Error(`unparseable timestamp: ${JSON.stringify(value)}`)
      }
      return value
    }
    return d.toISOString().replace('T', ' ').replace('Z', '')
  }

  return value
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--run')
  const url = process.env.TARGET_DATABASE_URL
  if (!url) {
    console.error('set TARGET_DATABASE_URL to the Postgres connection string')
    process.exit(1)
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true })
  const pg = new Client({ connectionString: url })
  await pg.connect()

  console.log(apply ? 'COPYING SQLite -> Postgres' : 'DRY RUN — reading and checking, writing nothing')
  console.log(`  from: ${SQLITE_PATH}`)
  console.log(`  to:   ${url.replace(/:[^:@]+@/, ':***@')}`)
  console.log()

  const summary: Array<{ table: string; source: number; copied: number }> = []

  for (const table of TABLE_ORDER) {
    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
    const columns = await destinationColumns(pg, table)

    if (columns.length === 0) {
      console.log(`  ${table.padEnd(20)} SKIPPED — no such table in Postgres`)
      continue
    }

    /**
     * Only columns that exist on BOTH sides travel. A column present in SQLite and absent
     * in Postgres would throw; one present in Postgres and absent here takes its DEFAULT,
     * which is exactly right for a column added by a later migration.
     *
     * The names are REPORTED when they differ, never silently dropped — a quiet column
     * mismatch is how a migration "succeeds" and loses a field.
     */
    const sourceColumns = rows.length > 0 ? Object.keys(rows[0]!) : []
    const shared = columns.filter((c) => sourceColumns.includes(c.name))
    const onlyInSqlite = sourceColumns.filter((n) => !columns.some((c) => c.name === n))
    const onlyInPg = columns.filter((c) => !sourceColumns.includes(c.name)).map((c) => c.name)

    if (onlyInSqlite.length > 0) console.log(`  ${table}: columns NOT copied (absent in Postgres): ${onlyInSqlite.join(', ')}`)
    if (onlyInPg.length > 0 && rows.length > 0) console.log(`  ${table}: columns taking their default: ${onlyInPg.join(', ')}`)

    if (!apply || rows.length === 0) {
      console.log(`  ${table.padEnd(20)} ${String(rows.length).padStart(5)} rows${apply ? ' (nothing to copy)' : ''}`)
      summary.push({ table, source: rows.length, copied: 0 })
      continue
    }

    const names = shared.map((c) => `"${c.name}"`).join(', ')
    const placeholders = shared.map((_, i) => `$${i + 1}`).join(', ')
    const insert = `INSERT INTO "${table}" (${names}) VALUES (${placeholders})`

    let copied = 0
    /**
     * ONE TRANSACTION PER TABLE. A table that fails halfway must leave nothing behind, or
     * a re-run hits primary-key collisions and the operator cannot tell what landed.
     */
    await pg.query('BEGIN')
    try {
      for (const row of rows) {
        const values = shared.map((c) => convert(row[c.name], c))
        await pg.query(insert, values)
        copied += 1
      }
      await pg.query('COMMIT')
    } catch (err) {
      await pg.query('ROLLBACK')
      console.error(`\n  ${table}: FAILED after ${copied} rows — rolled back this table.`)
      console.error(`  ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    console.log(`  ${table.padEnd(20)} ${String(copied).padStart(5)} rows copied`)
    summary.push({ table, source: rows.length, copied })
  }

  console.log()

  // ── VERIFY, and not by counting alone ─────────────────────────────────────
  if (apply) {
    console.log('verifying:')
    let bad = 0
    for (const { table, source } of summary) {
      const r = await pg.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)
      const there = r.rows[0].n as number
      const ok = there === source
      if (!ok) bad += 1
      console.log(`  ${ok ? 'ok  ' : 'BAD '} ${table.padEnd(20)} sqlite=${source} postgres=${there}`)
    }

    /**
     * A count proves the same NUMBER arrived. It cannot see a column that was dropped,
     * truncated or type-mangled — the exact failure the frame migration produced, where
     * SHA-256 was perfect and the file's mode bit was wrong. So read real rows back.
     */
    const probe = sqlite.prepare(`SELECT * FROM "DetectedCampaign" ORDER BY id LIMIT 3`).all() as Record<string, unknown>[]
    for (const row of probe) {
      const r = await pg.query(`SELECT * FROM "DetectedCampaign" WHERE id = $1`, [row.id])
      if (r.rowCount !== 1) {
        console.log(`  BAD  DetectedCampaign ${row.id} did not come back`)
        bad += 1
        continue
      }
      const got = r.rows[0] as Record<string, unknown>
      for (const key of ['shortcode', 'caption', 'verdict', 'frameText'] as const) {
        const a = row[key] ?? null
        const b = got[key] ?? null
        if (String(a) !== String(b)) {
          console.log(`  BAD  DetectedCampaign ${row.id}.${key}: sqlite=${JSON.stringify(a)?.slice(0, 60)} postgres=${JSON.stringify(b)?.slice(0, 60)}`)
          bad += 1
        }
      }

      /**
       * TIMESTAMPS ARE COMPARED AS STORED BYTES (`::text`), NOT AS `Date` OBJECTS.
       *
       * The first version of this check compared them as instants through the driver and
       * PASSED on values that were every one 5½ hours wrong — because the driver applies
       * the client's local timezone on write AND on read, so the round trip agrees with
       * itself on the copying machine while every other machine sees something else.
       *
       * A check that reads a value back the same way it wrote it is not verifying storage;
       * it is verifying its own symmetry. `::text` is the only view with nobody's timezone
       * in it.
       */
      const ts = await pg.query(
        `SELECT "detectedAt"::text AS d, "postedAt"::text AS p FROM "DetectedCampaign" WHERE id = $1`,
        [row.id],
      )
      for (const [key, col] of [['detectedAt', 'd'], ['postedAt', 'p']] as const) {
        const want = row[key] === null || row[key] === undefined ? null : new Date(String(row[key])).getTime()
        const raw = ts.rows[0][col] as string | null
        const have = raw ? new Date(`${raw.replace(' ', 'T')}Z`).getTime() : null
        if (want !== have) {
          console.log(
            `  BAD  DetectedCampaign ${row.id}.${key}: sqlite=${String(row[key])} stored=${raw} ` +
              `(a timezone offset, almost certainly — see the convert() docblock)`,
          )
          bad += 1
        }
      }
    }
    console.log(`  field-level check on 3 real posts, timestamps compared as STORED: ${bad === 0 ? 'identical' : `${bad} PROBLEM(S)`}`)

    console.log()
    console.log(bad === 0 ? 'Every table matches, and sampled rows are identical field by field.' : 'MISMATCHES ABOVE — do not switch over.')
    if (bad > 0) process.exit(1)
  } else {
    const total = summary.reduce((n, s) => n + s.source, 0)
    console.log(`${total} rows would be copied. Re-run with --run.`)
  }

  await pg.end()
  sqlite.close()
}

main().catch((err) => {
  console.error('copy failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
