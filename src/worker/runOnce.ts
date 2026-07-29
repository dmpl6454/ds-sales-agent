import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { runSlot } from './runSlot'

/**
 * Run one slot immediately and exit. Used by the dashboard's "Sync now" button,
 * by cron-free manual testing, and by the first-week DRY_RUN audit.
 *
 *   pnpm run:slot            # labelled "manual"
 *   pnpm run:slot 11:00      # labelled as that slot
 */
async function main() {
  const slot = process.argv[2] ?? 'manual'

  if (env.DRY_RUN) {
    log.warn('DRY_RUN is ON — full pipeline will run, nothing will be sent.')
  }

  const result = await runSlot(slot)

  console.log('\n─────────────────────────────────────────')
  console.log(`  status      ${result.status}`)
  console.log(`  posts seen  ${result.postsSeen}`)
  console.log(`  new posts   ${result.newPosts}`)
  console.log(`  campaigns   ${result.detected}`)
  console.log(`  queued      ${result.queued}`)
  console.log(`  sent        ${result.sent}`)
  console.log('─────────────────────────────────────────\n')

  await prisma.$disconnect()
  process.exit(result.status === 'FAILED' ? 1 : 0)
}

main().catch(async (err) => {
  log.alarm('run failed', { error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
