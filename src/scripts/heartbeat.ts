import { prisma } from '@/lib/db'
import { readHeartbeat } from '@/worker/scheduler'
import { assessWatch, watchHealthSentence } from '@/detection/watchHealth'

/**
 *   pnpm worker:heartbeat
 *
 * Is the watch actually running, and if not, what has it cost?
 *
 * Separate from `pnpm agent status` (which answers "what is blocking each ACCOUNT") on
 * purpose: this answers the prior question, and 2026-08-08 is the reason it deserves its
 * own command. Nothing had run for 20 hours, ~108 posts were missed with 9 paid among
 * them, and every screen and script that could have said so was answering a different
 * question. `launchctl list` reports a plist is REGISTERED, which is not the same claim
 * as a process beating — freshness is not liveness, one level up.
 *
 * It prints the same sentence the dashboard renders, from the same pure function, so the
 * terminal and the page can never disagree about how bad it is.
 */
async function main(): Promise<void> {
  const hb = await readHeartbeat()
  const health = assessWatch({
    lastBeatAt: hb ? new Date(hb.beat.at) : null,
    fresh: hb?.fresh ?? false,
    now: new Date(),
  })

  if (!hb) {
    console.log('never written — no watch has ever run')
  } else {
    const ageMin = Math.round((Date.now() - new Date(hb.beat.at).getTime()) / 60_000)
    const state = hb.fresh ? 'fresh' : 'STALE'
    console.log(`${state} — ${ageMin} min old (pid ${hb.beat.pid}, ${hb.beat.host})`)
  }

  const sentence = watchHealthSentence(health)
  if (sentence) {
    console.log()
    console.log(sentence)
  }

  await prisma.$disconnect()
  /**
   * A non-zero exit when posts are being lost, so this composes with anything that
   * checks status — a monitor that treats every outcome as success is not a monitor.
   * `at-risk` still exits 0: it is recoverable, and a check that cries wolf on a
   * survivable state is how alarms stop being read.
   */
  process.exit(health.severity === 'losing-posts' ? 1 : 0)
}

main().catch((err) => {
  console.error('could not read the heartbeat:', err instanceof Error ? err.message : String(err))
  process.exit(2)
})
