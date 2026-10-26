/**
 * DISCARD WAITING DRAFTS AIMED AT A RETIRED RECIPIENT — by hand.
 *
 * Retiring a target (`optedOut`) stops it being SENT to — the gate refuses it — and since 26 Oct
 * 2026 the planner's per-pass sweep and every retirement path also discard the drafts already
 * written for it (src/outreach/retiredRecipientDrafts.ts). This command is that same function
 * behind a dry run, for a person who wants to see the list or clear it without waiting a pass.
 *
 * MEASURED 2026-08-23, straight after the identity repair retired 29 unverified accounts:
 * **4 of the 9 held drafts were "this recipient is retired"** — and this command was written
 * then. Nothing ran it, so on 19–22 Oct the Mac was still re-asking the gate about such drafts
 * ~7,000 times a day. Its own query had also drifted from the gate's (it read the denormalised
 * `attempt.target` where the gate reads `pair.target`, and discarded without `onlyWaiting`); it
 * now has no query of its own beyond the preview, which uses the gate's field.
 *
 * DRY RUN BY DEFAULT.
 */
import { prisma } from '@/lib/db'
import { discardWaitingDraftsToRetiredRecipients } from '@/outreach/retiredRecipientDrafts'

async function main() {
  const run = process.argv.includes('--run')
  const actor = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

  /* The preview asks the gate's question — `pair.target.optedOut` — exactly as the sweep does. */
  const dead = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] }, pair: { target: { optedOut: true } } },
    select: { pair: { select: { sender: { select: { handle: true } }, target: { select: { handle: true } } } } },
    orderBy: { queuedAt: 'asc' },
  })

  if (dead.length === 0) {
    console.log('No waiting drafts are aimed at a retired recipient.')
    return
  }

  console.log(`${dead.length} waiting draft(s) aimed at a retired recipient${run ? '' : '  (DRY RUN)'}\n`)
  for (const a of dead) console.log(`  @${a.pair.sender.handle} → @${a.pair.target.handle}`)
  if (!run) {
    console.log('\nDRY RUN — re-run with --run. History is never touched. The planner also does this every pass.')
    return
  }
  const r = await discardWaitingDraftsToRetiredRecipients({ actor })
  console.log(`\ndiscarded=${r.discarded}`)
}

main().finally(() => prisma.$disconnect())
