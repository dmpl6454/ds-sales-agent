import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { buildGreeting } from '@/outreach/render'
import { classifyOpener, type OpenerShape } from '@/outreach/staleTemplate'
import { discardAttempt } from '@/outreach/discard'

/**
 * `pnpm ig:discard-stale-drafts` — retire waiting drafts written against an older
 * message template, so the planner rewrites them with the current one. DRY RUN BY DEFAULT.
 *
 * ── WHY A DRAFT GOES STALE AT ALL ─────────────────────────────────────────
 *
 * A body is rendered ONCE and frozen, deliberately: the composer read-back compares against
 * exactly those bytes and an operator may have edited them. The cost is that changing
 * `renderMessage` leaves the whole queue carrying the previous copy with nothing on any
 * screen saying so. MEASURED the day the merged opener shipped: 46 of 46 waiting drafts,
 * the oldest six days old, every one of them still opening with a lone greeting — the exact
 * shape that made Instagram's inbox preview read "Hi Crocs India team," and nothing else.
 *
 * ── ORDERING, WHICH IS THE SAME TRAP AS `ig:dedupe-drafts` ────────────────
 *
 * RUN THIS ONLY AFTER THE NEW TEMPLATE IS DEPLOYED TO THE MACHINE THAT DRAFTS. The planner
 * runs on the Linode; until its copy of `render.ts` has the change, the next slot rewrites
 * every draft this removes IN THE OLD SHAPE, and all the run achieves is churn plus an audit
 * row apiece. The command cannot verify another host's bytes, so it prints the warning and
 * `--run` stays yours to type.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
 *
 * It discards through `discardAttempt`, the ONE writer, whose status guard lives INSIDE the
 * update — so a SENT, SENDING or REPLIED row cannot be touched however this is invoked, and
 * every removal leaves an audit row. `SKIPPED` is not an `IN_FLIGHT_STATUS`, so a discarded
 * draft does not burn the campaign or variant pool.
 *
 * And it never discards on `unknown`. `classifyOpener` answers `stale` / `current` /
 * `unknown`, and the third is what a HAND-EDITED body looks like — indistinguishable from a
 * rendering this does not recognise. Those are listed and left alone, because the
 * destructive direction here is `stale` and a queue is not garbage merely because a probe
 * could not read it.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const actor = `cli:${env.OPERATOR_NAME}`

const REASON = 'discarded as stale: written against the pre-2026-08-17 message template'

async function main(): Promise<void> {
  const waiting = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] } },
    select: {
      id: true,
      renderedBody: true,
      queuedAt: true,
      sender: { select: { handle: true } },
      target: { select: { handle: true, displayName: true, contactFirstName: true, kind: true } },
    },
    orderBy: { queuedAt: 'asc' },
  })

  if (waiting.length === 0) {
    console.log('No drafts are waiting. Nothing to do.')
    return
  }

  const buckets: Record<OpenerShape, { line: string; id: string }[]> = { stale: [], current: [], unknown: [] }

  for (const d of waiting) {
    /**
     * The greeting comes from `buildGreeting` itself rather than being reconstructed here.
     * A probe that builds its own copy of what the writer emits is how `readThread.ts` drifted
     * from its own docblock for weeks; sharing the function is what makes the comparison mean
     * anything.
     */
    const greetingNow = buildGreeting({
      handle: d.target.handle,
      displayName: d.target.displayName,
      contactFirstName: d.target.contactFirstName,
      kind: d.target.kind,
    })

    const verdict = classifyOpener({ renderedBody: d.renderedBody, greetingNow })
    const age = d.queuedAt ? `${Math.floor((Date.now() - d.queuedAt.getTime()) / 86_400_000)}d old` : 'undated'
    buckets[verdict.shape].push({
      id: d.id,
      line: `  ${d.sender.handle} → @${d.target.handle}  (${age})  ${verdict.detail}`,
    })
  }

  console.log(`${waiting.length} draft(s) waiting.\n`)

  if (buckets.current.length > 0) {
    console.log(`CURRENT TEMPLATE — left alone (${buckets.current.length}):`)
    for (const r of buckets.current) console.log(r.line)
    console.log()
  }

  /**
   * Printed even when empty. "We could not read N of these" is exactly the number that
   * disappears when a report only lists what it acted on, and it is the number that says a
   * probe has stopped working.
   */
  console.log(`COULD NOT TELL — left alone, never discarded (${buckets.unknown.length}):`)
  for (const r of buckets.unknown) console.log(r.line)
  if (buckets.unknown.length === 0) console.log('  (none)')
  console.log()

  console.log(`STALE TEMPLATE (${buckets.stale.length}):`)
  for (const r of buckets.stale) console.log(r.line)
  if (buckets.stale.length === 0) console.log('  (none)')
  console.log()

  if (buckets.stale.length === 0) {
    console.log('Nothing to discard.')
    return
  }

  if (!run) {
    console.log(`DRY RUN. ${buckets.stale.length} draft(s) would be discarded. Re-run with --run.`)
    console.log()
    console.log('BEFORE YOU DO: the current template must already be deployed to the machine that')
    console.log('drafts, or the next slot rewrites every one of these in the old shape and the only')
    console.log('lasting effect is the audit trail.')
    return
  }

  let done = 0
  for (const r of buckets.stale) {
    const result = await discardAttempt({ attemptId: r.id, reason: REASON, actor })
    if (result.ok) done++
    else console.log(`  refused: ${result.message}`)
  }
  console.log(`Discarded ${done} stale draft(s). The planner rewrites them at the next slot, with the current template.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
