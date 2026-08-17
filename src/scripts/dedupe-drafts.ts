import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { whoseTurn, fleetRingFor, ringFor, categoriesForTarget } from '@/outreach/categories'
import { chooseDraftToKeep, type DraftRef } from '@/outreach/duplicateDrafts'
import { discardAttempt } from '@/outreach/discard'
import { readSenderAvailability } from '@/outreach/availability'

/**
 * `pnpm ig:dedupe-drafts` — one waiting draft per recipient. DRY RUN BY DEFAULT.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS A ONE-OFF WORTH KEEPING ────────────────
 *
 * `whoseTurn` returned null for every recipient there had ever been, so every sender
 * drafted to every recipient. The rotation fix stops new duplicates; it cannot touch the
 * ones already queued, and those are the live exposure: MEASURED 2026-08-13, 7 recipients
 * holding a draft from all three fleet accounts and 1 holding two, bodies near-identical
 * and carrying the same phone number and email. With `MAX_PER_TARGET_PER_DAY = 2`, two of
 * three reach one inbox on one day the moment Autopilot goes on.
 *
 * It is kept rather than run and deleted because the same state is reachable again: a
 * recipient put in a group whose ring later changes, or a draft written by the on-demand
 * dialog beside one the planner wrote.
 *
 * ── ORDERING THAT MATTERS ─────────────────────────────────────────────────
 *
 * RUN THIS ONLY AFTER THE ROTATION FIX IS DEPLOYED TO WHATEVER MACHINE DRAFTS. The planner
 * runs on the Linode; until its copy of `plan.ts` has the fix, the next slot recreates
 * every duplicate this removes, and all the run achieves is churn plus an audit row per
 * deleted draft. The command refuses to guess about that — it prints the warning and the
 * next slot time, and `--run` is still yours to type.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
 *
 * It never touches a SENT, SENDING or REPLIED row: `discardAttempt` is the one writer and
 * its status guard is inside the update. It never discards the LAST draft to a recipient —
 * `chooseDraftToKeep` always names a keeper, including when no account can send today,
 * because a queue is not garbage merely because nothing can go out right now.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const actor = `cli:${env.OPERATOR_NAME}`

async function main(): Promise<void> {
  /**
   * THE SAME availability the planner uses — one reader, three callers. Machine-independent
   * for the same reason: this may be typed on a laptop while the planner runs on a host with
   * no Chrome profiles at all, and a filesystem check would pick a different keeper depending
   * on which machine ran the cleanup.
   */
  const unavailable = await readSenderAvailability()

  const waiting = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] } },
    select: {
      id: true,
      queuedAt: true,
      senderId: true,
      sender: { select: { handle: true } },
      pair: { select: { targetId: true, target: { select: { handle: true } } } },
    },
    orderBy: { queuedAt: 'asc' },
  })

  const byTarget = new Map<string, { handle: string; drafts: DraftRef[] }>()
  for (const a of waiting) {
    const entry = byTarget.get(a.pair.targetId) ?? { handle: a.pair.target.handle, drafts: [] }
    entry.drafts.push({
      attemptId: a.id,
      senderId: a.senderId,
      handle: a.sender.handle,
      queuedAt: a.queuedAt,
    })
    byTarget.set(a.pair.targetId, entry)
  }

  console.log(`${waiting.length} waiting draft(s) across ${byTarget.size} recipient(s).\n`)

  let surplus = 0
  let discarded = 0
  let failed = 0

  for (const [targetId, { handle, drafts }] of byTarget) {
    if (drafts.length < 2) continue

    const groups = await categoriesForTarget(targetId)
    const ring = groups.length > 0 ? await ringFor(groups[0]!.id) : await fleetRingFor(targetId)
    const turn = await whoseTurn({ targetId, unavailable, fleet: ring })
    const decision = chooseDraftToKeep({
      drafts,
      ring,
      lastSenderId: turn.lastSenderId,
      unavailable,
    })
    if (decision === null || decision.discard.length === 0) continue

    surplus += decision.discard.length
    console.log(`@${handle} — ${drafts.length} drafts`)
    console.log(`  keep     @${decision.keep.handle}  (${decision.why})`)
    for (const d of decision.discard) {
      const reason = `duplicate draft to @${handle}; ${decision.why}`
      if (!run) {
        console.log(`  discard  @${d.handle}  [dry run]`)
        continue
      }
      const result = await discardAttempt({ attemptId: d.attemptId, reason, actor })
      if (result.ok) discarded++
      else failed++
      console.log(`  discard  @${d.handle}  ${result.ok ? 'done' : `REFUSED — ${result.message}`}`)
    }
    console.log()
  }

  if (surplus === 0) {
    console.log('Nothing to do — every recipient holds at most one waiting draft.')
    return
  }

  if (!run) {
    console.log(`DRY RUN. ${surplus} surplus draft(s) would be discarded. Re-run with --run.`)
    console.log(
      '\nBEFORE YOU DO: the rotation fix must already be deployed to the machine that drafts,\n' +
        'or the next slot recreates every one of these and the only lasting effect is the audit trail.',
    )
    return
  }

  console.log(`Discarded ${discarded} surplus draft(s).${failed > 0 ? ` ${failed} refused.` : ''}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
