/**
 * REMOVE EVERY MESSAGE AIMED AT A PAGE WE ONLY WATCH.
 *
 * ── WHY THIS COMMAND EXISTS, AND WHY IT IS NOT `ig:prune-pairs` ────────────
 *
 * Until 2026-08-17 nothing stopped a message being addressed to a watched publisher.
 * `routes.ts` carried four refusals and none was about what a target IS, so
 * `ensureFleetPairs` enrolled @viralbhayani and @madovermarketing_mom — our two
 * COMPETITORS — as ordinary recipients. MEASURED: 26 attempts and 8 pairs between them,
 * 6 still READY with a live Send button on the dashboard.
 *
 * `pnpm ig:prune-pairs` cannot do this. `mayPrunePair` refuses any pair carrying an attempt
 * of ANY status, and every one of these carries attempts — which is correct for that
 * command, whose job is removing routes that were never used.
 *
 * ── THE RULE THIS COMMAND MUST NOT BREAK ──────────────────────────────────
 *
 * `OutreachAttempt` is the record of what real people were actually sent, and spacing, the
 * unanswered-touch cap and the new-material rule are all derived from it. Deleting one that
 * was DELIVERED would let the system write again to someone it has already written to, and
 * `OutreachAttempt.pairId` is `ON DELETE CASCADE`, so deleting a pair takes its attempts
 * with it silently.
 *
 * So this refuses outright the moment it finds a DELIVERED attempt — it does not skip that
 * pair and carry on, it stops. MEASURED before it was first run: 0 of the 26 had ever been
 * delivered, so the refusing branch could not fire against live data, which is exactly why
 * it is asserted here rather than assumed. A command that erases send history must be
 * unable to do so by construction, not by the data happening to be convenient today.
 *
 * DRY RUN BY DEFAULT, like every other destructive command here. `--run` performs it.
 */
import { prisma } from '../lib/db.js'
import { DELIVERED_STATUSES } from '../lib/constants.js'
import { discardAttempt } from '../outreach/discard.js'

const RUN = process.argv.includes('--run')
const ACTOR = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

async function main() {
  const watched = await prisma.targetAccount.findMany({
    where: { role: 'WATCH' },
    select: { id: true, handle: true, displayName: true },
    orderBy: { handle: 'asc' },
  })

  if (watched.length === 0) {
    console.log('No WATCH targets. Nothing to do.')
    return
  }

  console.log(`Pages we watch and must never message (${watched.length}):`)
  for (const w of watched) console.log(`   @${w.handle}`)

  const ids = watched.map((w) => w.id)

  const attempts = await prisma.outreachAttempt.findMany({
    where: { targetId: { in: ids } },
    select: {
      id: true,
      status: true,
      queuedAt: true,
      sentAt: true,
      sender: { select: { handle: true } },
      target: { select: { handle: true } },
    },
    orderBy: { queuedAt: 'desc' },
  })
  const pairs = await prisma.outreachPair.findMany({
    where: { targetId: { in: ids } },
    select: { id: true, sender: { select: { handle: true } }, target: { select: { handle: true } } },
  })

  console.log(`\nMessages aimed at them: ${attempts.length}`)
  const byStatus = new Map<string, number>()
  for (const a of attempts) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1)
  for (const [s, n] of [...byStatus.entries()].sort()) console.log(`   ${s.padEnd(9)} ${n}`)
  console.log(`Routes to them: ${pairs.length}`)

  /**
   * THE REFUSAL, checked before anything is written. `DELIVERED_STATUSES` rather than a
   * literal `['SENT']`: a message that was answered is `REPLIED`, and counting only SENT is
   * the exact bug this codebase found in `ig:audit` — the best outcome quietly removing a
   * row from the total that protects it.
   */
  const delivered = attempts.filter((a) => (DELIVERED_STATUSES as readonly string[]).includes(a.status))
  if (delivered.length > 0) {
    console.error(`\nREFUSING. ${delivered.length} of these were actually DELIVERED to a real person:`)
    for (const d of delivered) {
      console.error(`   @${d.sender.handle} → @${d.target.handle} at ${d.sentAt?.toISOString() ?? 'unknown'}`)
    }
    console.error(
      '\nDeleting them would erase the record of messages people received, which spacing, the\n' +
        'unanswered-touch cap and the new-material rule are all derived from. Retire the target\n' +
        'instead (that is what `optedOut` is for) and leave the history alone.',
    )
    process.exitCode = 1
    return
  }

  if (!RUN) {
    console.log('\nWould discard these waiting drafts:')
    for (const a of attempts.filter((x) => x.status === 'READY' || x.status === 'QUEUED')) {
      console.log(`   @${a.sender.handle} → @${a.target.handle}  (queued ${a.queuedAt.toISOString()})`)
    }
    console.log(`\nThen delete ${attempts.length} attempt row(s) and ${pairs.length} route(s).`)
    console.log('\nDRY RUN — pass --run to do it.')
    return
  }

  /**
   * Waiting drafts go through `discardAttempt` rather than being deleted outright, because
   * it is the ONE writer that turns a waiting draft into SKIPPED and it leaves an audit row.
   * The rows are removed a moment later anyway; what survives is the audit trail saying a
   * person decided these should not be sent, which is the honest record of what happened.
   */
  let discarded = 0
  for (const a of attempts) {
    if (a.status !== 'READY' && a.status !== 'QUEUED') continue
    const r = await discardAttempt({
      attemptId: a.id,
      actor: ACTOR,
      reason: 'aimed at a page we only watch, never a company we message',
    })
    if (r.ok) discarded += 1
  }

  const removedAttempts = await prisma.outreachAttempt.deleteMany({ where: { targetId: { in: ids } } })
  const removedPairs = await prisma.outreachPair.deleteMany({ where: { targetId: { in: ids } } })

  await prisma.auditLog.create({
    data: {
      actor: ACTOR,
      action: 'watch.messages.purged',
      entity: `TargetAccount:${watched.map((w) => w.handle).join(',')}`,
      detail: `discarded ${discarded} waiting · deleted ${removedAttempts.count} attempts and ${removedPairs.count} routes · 0 had ever been delivered`,
    },
  })

  console.log(`\nDone. Discarded ${discarded} waiting draft(s).`)
  console.log(`Deleted ${removedAttempts.count} attempt row(s) and ${removedPairs.count} route(s).`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
