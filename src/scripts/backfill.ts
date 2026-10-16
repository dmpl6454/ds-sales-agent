/**
 *   pnpm ig:backfill --hours N          DRY RUN: read every watched channel back N hours through the
 *                                       official API; say how many posts are not stored. Writes nothing.
 *   pnpm ig:backfill --hours N --run    store them, through an ordinary detection pass that asks the
 *                                       official API only. Refuses while the worker runs on this host,
 *                                       and prints the one line instead — detached, so a dropped
 *                                       console cannot leave the worker stopped:
 *     setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:backfill --hours N --run; pm2 start ds-sales-worker' > /tmp/ig-backfill.log 2>&1 < /dev/null & tail -F /tmp/ig-backfill.log
 *   --channel <handle>                  (repeatable) only these watched channels — how a run the call
 *                                       cap cut short is finished; the report prints the line.
 *
 * N: a whole number of hours, 1..168. Needs META_GRAPH_TOKEN and META_IG_USER_ID in this host's .env.
 * Everything it does is in src/detection/backfill.ts, where it is tested; this file reads the command
 * line, prints, and — only for --run — loads the detection pass. The dry run never loads it (see
 * backfill.ts, "THE DRY RUN WRITES NOTHING — STRUCTURALLY"). docs/DEPLOY.md says when to run it.
 *
 * Exit 0: every channel read (dry run) or backfilled (run) back the full N hours. 1: some were not,
 * named in the output. 2: refused before reading anything (command line, configuration, worker running).
 */
import { prisma } from '@/lib/db'
import { BACKFILL_USAGE, parseBackfillArgs, runBackfill } from '@/detection/backfill'

const args = parseBackfillArgs(process.argv.slice(2))
if (args.kind === 'help') {
  console.log(BACKFILL_USAGE)
  process.exit(0)
}
if (args.kind === 'refused') {
  console.error(args.why)
  process.exit(2)
}

const code = await runBackfill(args.plan, {
  out: (line) => console.log(line),
  runPass: async (hours, channels) => {
    // Loaded here and only here: the dry run must not have the pass's writers in its module graph.
    const { runDetection } = await import('@/detection/pipeline')
    const summary = await runDetection({ officialBackfillHours: hours, ...(channels.length > 0 ? { onlyChannels: channels } : {}) })
    // The pass records its feed answers fire-and-forget; let them land before the process exits.
    const { feedAnswersSettled } = await import('@/detection/feedEvidence')
    await feedAnswersSettled()
    return summary
  },
})
await prisma.$disconnect().catch(() => {})
process.exit(code)
