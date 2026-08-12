import Database from 'better-sqlite3'
import { Client } from 'pg'

/**
 *   pnpm ig:fix-timestamps          (dry run — counts and shows, changes NOTHING)
 *   pnpm ig:fix-timestamps --run    (corrects)
 *
 * Undo a timezone offset the SQLite -> Postgres copy introduced.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * Every timestamp column in this schema is `timestamp WITHOUT time zone`, because SQLite
 * had no timezone-aware type and the generated Postgres schema mirrors it exactly (which
 * was deliberate — changing column semantics during a host migration means a failure
 * could be either change).
 *
 * `copy-to-postgres.ts` converted each ISO string to a JS `Date`, correctly. The `pg`
 * driver then wrote that Date into a naive column using the CLIENT's LOCAL TIME. The copy
 * ran on a machine at UTC+05:30, so every copied row landed **5 hours 30 minutes in the
 * future**. MEASURED: SQLite held `2026-08-08T06:45:18.917+00:00`, Postgres holds
 * `2026-08-08 12:15:18.917` — same milliseconds, shifted by exactly the machine's offset.
 *
 * ── WHY THE MIGRATION'S OWN VERIFICATION MISSED IT ──────────────────────────
 *
 * It compared timestamps as INSTANTS between the two databases and they matched — because
 * both sides were read through the same driver, which applied the same offset on the way
 * back out. The check proved the transfer was faithful. It could not see that the value
 * being faithfully transferred was already wrong on arrival.
 *
 * Verifying a TRANSFER and verifying the DATA are different questions, and this is the
 * cost of answering only the first. What actually caught it was a dashboard printing
 * "newest seen -171 min ago" — a negative age, which is impossible, so it could not be
 * mistaken for a plausible number.
 *
 * ── WHY THIS MATTERS BEYOND A WRONG LABEL ───────────────────────────────────
 *
 * `detectionCutoff()` refuses to classify posts before 1 August, `HOOK_MAX_AGE_HOURS`
 * retires a hook line after 72 hours, and the reply halt releases after `replyResumeHours`.
 * All three compare against these columns. A row stamped in the future is younger than it
 * is, so a stale hook reads as fresh and a halt expires late.
 *
 * ── WHAT IT TOUCHES, AND WHAT IT MUST NOT ───────────────────────────────────
 *
 * ONLY rows the copy wrote. The server writes correct timestamps — it runs at UTC — so
 * rows from its own detection passes are already right, and shifting them would introduce
 * the very bug this removes. How those two are told apart is the next docblock, and it
 * took two wrong answers to get there.
 */


/**
 * ── HOW A COPIED ROW IS TOLD APART FROM A CORRECT ONE ───────────────────────
 *
 * Two wrong answers came first, and both are worth recording because each looked right.
 *
 * **A time boundary** — "everything before the copy finished" — matched all 1,881 posts,
 * including the ~30 the server had since written CORRECTLY. Shifting those back 5½ hours
 * would have introduced the exact bug being removed, in rows that were fine. The two
 * populations occupy the same range; no cutoff separates them.
 *
 * **`> now()`** — "a copied row is in the future" — was true of 126 rows and false of the
 * rest, because a row shifted +5:30 stops being future-dated as soon as 5½ hours of real
 * time pass. It would have fixed today's rows and left yesterday's silently wrong, which
 * is worse than not running at all: a partial correction makes the remaining error look
 * like real data.
 *
 * **What actually identifies a copied row is the SQLite file**, which is still on disk,
 * was never wrong, and holds the id of every row the copy produced. So the fix is driven
 * from the source: for each row, take the true instant from SQLite and write it to
 * Postgres. Rows the server created are not in that file and are therefore untouched by
 * construction rather than by a predicate that has to be argued about.
 */

/** Every timestamp column, with the table it lives on. Read from the catalogue, not typed by hand. */
async function timestampColumns(pg: Client): Promise<Array<{ table: string; column: string }>> {
  const r = await pg.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
     ORDER BY table_name, column_name`,
  )
  return r.rows.map((row) => ({ table: row.table_name as string, column: row.column_name as string }))
}

/** Postgres wants `YYYY-MM-DD HH:MM:SS.mmm` for a naive column; the source holds ISO-8601. */
function toNaiveUtc(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().replace('T', ' ').slice(0, 23)
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--run')
  const url = process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url || !url.startsWith('postgres')) {
    console.error('set TARGET_DATABASE_URL to the Postgres connection string')
    process.exit(1)
  }

  const sqlite = new Database(process.env.SQLITE_PATH ?? './prisma/dev.db', { readonly: true })
  const pg = new Client({ connectionString: url })
  await pg.connect()

  console.log(apply ? 'CORRECTING timestamps FROM THE SQLITE SOURCE' : 'DRY RUN — nothing will be changed')
  console.log('  every value is re-read from the file the copy came from, which was never wrong')
  console.log('  rows the SERVER created are not in that file and are untouched by construction')
  console.log()

  const columns = await timestampColumns(pg)
  const byTable = new Map<string, string[]>()
  for (const { table, column } of columns) {
    byTable.set(table, [...(byTable.get(table) ?? []), column])
  }

  let checked = 0
  let wrong = 0
  let fixed = 0

  for (const [table, cols] of byTable) {
    // Only tables the copy actually populated. A table absent from SQLite cannot hold a
    // row the copy produced.
    let rows: Record<string, unknown>[]
    try {
      rows = sqlite.prepare(`SELECT id, ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all() as Record<string, unknown>[]
    } catch {
      continue
    }
    if (rows.length === 0) continue

    let tableWrong = 0
    for (const row of rows) {
      const id = row.id as string
      const sets: string[] = []
      const values: unknown[] = []

      for (const col of cols) {
        const raw = row[col]
        if (raw === null || raw === undefined) continue
        const want = toNaiveUtc(String(raw))
        if (!want) continue

        checked += 1
        /**
         * `::text` — THE ONLY HONEST VIEW, and reading it any other way is how this bug
         * hid twice.
         *
         * The `pg` driver applies the client's LOCAL timezone when it writes a naive
         * column AND when it reads one back, so a JS-to-JS comparison on the machine that
         * did the copy always agrees with itself. The first dry run reported "6291
         * compared, 0 differ" against values that were provably shifted.
         *
         * MEASURED on one row, the same row, read two ways:
         *   from this Mac (UTC+5:30)  -> 2026-08-07T05:30:45.145Z   correct
         *   from the SERVER (UTC)     -> 2026-08-07T11:00:45.145Z   5.5 hours wrong
         *
         * The server is the machine that runs detection and serves the dashboard, so the
         * wrong reading is the one that matters. `::text` returns the stored bytes with no
         * timezone applied by anybody, which is the only way to compare what is actually
         * in the column against what the source meant.
         */
        const cur = await pg.query(`SELECT "${col}"::text AS t FROM "${table}" WHERE id = $1`, [id])
        if (cur.rowCount !== 1) continue
        const haveText = cur.rows[0].t as string | null
        if (!haveText) continue

        // Postgres prints trailing zeros away ("...145" vs "...14500"); compare on the
        // instant both strings denote rather than on their spelling.
        if (new Date(`${haveText.replace(' ', 'T')}Z`).getTime() === new Date(`${want.replace(' ', 'T')}Z`).getTime()) continue

        wrong += 1
        tableWrong += 1
        sets.push(`"${col}" = $${sets.length + 2}::timestamp`)
        values.push(want)
      }

      if (sets.length > 0 && apply) {
        /**
         * The values are bound as TEXT and cast in SQL (`$n::timestamp`), never as JS
         * `Date` objects — a Date would be re-serialised by the driver using this
         * machine's local timezone and reintroduce the exact offset being removed. The
         * string already IS the UTC wall-clock we want stored.
         */
        await pg.query(`UPDATE "${table}" SET ${sets.join(', ')} WHERE id = $1`, [id, ...values])
        fixed += sets.length
      }
    }

    if (tableWrong > 0) {
      console.log(`  ${table.padEnd(22)} ${String(tableWrong).padStart(6)} values${apply ? ' corrected' : ' differ from the source'}`)
    }
  }

  console.log()
  console.log(`  ${checked} values compared against the source, ${wrong} differ.`)

  if (apply) {
    // VERIFY, independently of the loop above: is anything still ahead of the clock?
    const future = await pg.query(
      `SELECT COUNT(*)::int AS n FROM "DetectedCampaign" WHERE "detectedAt" > now()`,
    )
    const probe = await pg.query(
      `SELECT "detectedAt" AS v FROM "DetectedCampaign" WHERE shortcode = 'DbtNU9UzWYU'`,
    )
    console.log(`  ${fixed} corrected.`)
    console.log(`  posts still dated in the future: ${future.rows[0].n}`)
    if (probe.rowCount === 1) {
      console.log(`  founding case now reads: ${(probe.rows[0].v as Date).toISOString()}`)
    }
  } else {
    console.log(`\nRe-run with --run to correct them.`)
  }

  await pg.end()
  sqlite.close()
}

main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
