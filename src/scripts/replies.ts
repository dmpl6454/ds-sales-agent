import { prisma } from '@/lib/db'
import { checkForReplies, REPLY_CHECK_SLOTS } from '@/outreach/replyCheck'

/**
 *   pnpm ig:replies
 *
 * Runs the same reply check the scheduler runs at ${REPLY_CHECK_SLOTS}, immediately.
 *
 * Identical code path, not a parallel implementation — `checkForReplies` is the one
 * function, and this is a second caller. The alternative is two copies that drift,
 * which is exactly how `sendNow` ended up missing five of the checks `deliverWaiting`
 * enforced, including *they replied*.
 *
 * Opens one real browser window per conversation, so it is not free: the caps inside
 * `checkForReplies` apply here too.
 */
async function main(): Promise<void> {
  console.log(`\n  Checking open conversations for replies…\n`)

  const r = await checkForReplies()

  for (const o of r.outcomes) {
    const mark =
      o.status === 'reply-found' ? '★' : o.status === 'no-reply' ? '·' : o.status === 'unreadable' ? '!' : ' '
    console.log(`  ${mark} ${o.pairKey.padEnd(46)} ${o.status}${o.detail ? ` — ${o.detail}` : ''}`)
  }

  console.log(`\n  checked ${r.checked}, replies found ${r.repliesFound}, unreadable ${r.unreadable}`)

  if (r.deferred > 0) {
    /**
     * Reported, never silent. The sweep's budget is a constant while the number of
     * conversations grows with the fleet, so this number is the honest measure of how much
     * of the sweep the fleet has outgrown.
     *
     * It is deliberately NOT phrased as a problem: since Phase 6 a follow-up reads its own
     * conversation immediately before it goes out, so a deferred sweep no longer means a
     * message can be sent on stale information.
     */
    console.log(
      `  ${r.deferred} more conversation(s) were not reached this run — each is read before anything is sent into it.`,
    )
  }

  if (r.repliesFound > 0) {
    console.log('  Outreach to those channels is now halted until you mark the reply handled.')
  }
  if (r.unreadable > 0) {
    // Never reported as "no reply". An unreadable thread is a failure to evaluate the
    // guard, not evidence that the guard should pass.
    console.log('  Some conversations could not be read — that is NOT the same as "no reply".')
    console.log('  Inspect one by hand with: pnpm ig:thread <sender> <target> --debug')
  }
  if (r.checked === 0) {
    console.log('  Nothing to check: no delivered message is waiting on an unrecorded reply.')
  }
  console.log('')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
