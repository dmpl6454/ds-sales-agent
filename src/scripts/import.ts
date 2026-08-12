import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { importProspects, IMPORT_ROW_LIMIT } from '@/outreach/importProspects'

/**
 *   pnpm ig:import <file.csv>          preview only, writes nothing
 *   pnpm ig:import <file.csv> --run    create them
 *
 * The same function the dashboard's import form calls — one implementation, two callers,
 * for the reason `pnpm ig:replies` exists alongside the scheduled reply check: a command
 * that reimplements the behaviour can only tell you about itself.
 *
 * DRY RUN BY DEFAULT, like `ig:classify` and `ig:brands`. This is a bulk write against a
 * list somebody pasted, and the wrong file must cost nothing. The preview is the real
 * answer — it checks every handle against Instagram — so `--run` after a clean preview
 * holds no surprises.
 */

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const run = args.includes('--run')

async function main(): Promise<void> {
  if (!file) {
    console.error('\n  Usage: pnpm ig:import <file.csv> [--run]\n')
    process.exitCode = 1
    return
  }

  const text = readFileSync(file, 'utf8')
  const outcome = await importProspects(text, {
    dryRun: !run,
    actor: `cli:${env.OPERATOR_NAME}`,
    note: `imported from ${file}`,
  })

  console.log(`\n  ${run ? 'Importing' : 'Previewing'} ${file}\n`)
  if (outcome.parsed.usedHeader) console.log('  (first row read as a header)\n')

  for (const r of outcome.rows) {
    const mark =
      r.status === 'created' ? '+' : r.status === 'already-known' ? '=' : r.status === 'unconfirmed' ? '?' : '✗'
    console.log(`  ${mark} @${r.handle.padEnd(34)} ${r.status}${r.detail ? ` — ${r.detail}` : ''}`)
  }

  if (outcome.parsed.rejected.length > 0) {
    console.log('\n  Rows that could not be read (left out, never repaired):')
    for (const r of outcome.parsed.rejected) console.log(`    line ${r.line}: ${r.reason}`)
  }
  if (outcome.parsed.duplicates.length > 0) {
    console.log(`\n  Listed more than once, kept once: ${outcome.parsed.duplicates.join(', ')}`)
  }
  if (outcome.parsed.overLimit > 0) {
    // Never a silent truncation: a capped import reporting success is how someone believes
    // eighty were added when fifty were.
    console.log(
      `\n  ${outcome.parsed.overLimit} row(s) beyond the ${IMPORT_ROW_LIMIT}-row limit were NOT read. Split the file.`,
    )
  }

  const willAdd = outcome.rows.filter((r) => r.status === 'created' || r.status === 'unconfirmed').length
  if (!run) {
    console.log(`\n  Nothing was written. ${willAdd} would be added. Add --run to create them.\n`)
    return
  }

  console.log(`\n  ${outcome.created} created. Every route is DISABLED and none are watched.`)
  if (outcome.categories.length > 0) console.log(`  Rotation groups touched: ${outcome.categories.join(', ')}`)
  console.log('  Nothing will be messaged until a route is switched on.\n')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
