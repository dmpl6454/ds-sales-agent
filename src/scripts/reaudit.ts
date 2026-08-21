import { prisma } from '@/lib/db'
import { badgeDoorPass } from '@/detection/badgeDoor'

/**
 * `pnpm ig:reaudit` — drain the badge-door backlog: every handle a paid post asserts
 * whose badge was never actually checked. DRY RUN BY DEFAULT; `--run` enriches and
 * admits. `--limit N` bounds the enrichment spend (default 60).
 *
 * RUN FROM A HOME-IP MACHINE like every other consumer of Instagram endpoints that
 * matter. The scheduled half lives on the device agent's brand timer; this command
 * exists for the measured backlog (192 handles the day it was written) because a
 * 10-per-pass timer takes days to drain what one command clears in twenty minutes.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const run = argv.includes('--run')
  const limitArg = argv.indexOf('--limit')
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) || 60 : 60

  console.log(`\n  Badge-door re-audit ${run ? '(LIVE)' : '(dry run — nothing is written; --run to admit)'}\n`)
  const s = await badgeDoorPass({ maxEnrichments: limit, dryRun: !run })
  console.log(`  candidates (asserted, unminted, badge unknown or true): ${s.candidates}`)
  console.log(`  enriched this run: ${s.enriched} (limit ${limit})${s.haltedEarly ? ' — more remain, run again' : ''}`)
  console.log(`  ${run ? 'admitted' : 'would admit'}: ${s.admitted}`)
  console.log(`  refused (unverified — the bar working): ${s.refusedUnverified}`)
  console.log(`  unreachable (left for a later pass): ${s.unreachable}\n`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
