/**
 * DISCARD WAITING DRAFTS AIMED AT A RETIRED RECIPIENT.
 *
 * Retiring a target (`optedOut`) stops it being SENT to — the gate refuses it — but it does
 * not remove drafts already written for it. Those sit in the queue permanently held, and the
 * dispatcher re-evaluates them on every 30-second tick forever.
 *
 * MEASURED 2026-08-23, straight after the identity repair retired 29 unverified accounts:
 * **4 of the 9 held drafts were "this recipient is retired"** — nearly half the queue's
 * holds were dead weight, on a fleet whose whole complaint was that it was not sending.
 *
 * Goes through `discardAttempt`, the ONE writer that turns a waiting draft into SKIPPED, so
 * each removal is audited and its status guard lives inside the update — a SENT or SENDING
 * row can never be touched by this.
 *
 * DRY RUN BY DEFAULT.
 */
import { prisma } from '@/lib/db'
import { discardAttempt } from '@/outreach/discard'

async function main() {
  const run = process.argv.includes('--run')
  const actor = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

  const dead = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] }, target: { optedOut: true } },
    select: { id: true, sender: { select: { handle: true } }, target: { select: { handle: true } } },
  })

  if (dead.length === 0) {
    console.log('No waiting drafts are aimed at a retired recipient.')
    return
  }

  console.log(`${dead.length} waiting draft(s) aimed at a retired recipient${run ? '' : '  (DRY RUN)'}\n`)
  let discarded = 0
  for (const a of dead) {
    console.log(`  @${a.sender.handle} → @${a.target.handle}`)
    if (!run) continue
    const r = await discardAttempt({
      attemptId: a.id,
      reason: 'recipient retired — this draft could never be sent',
      actor,
    })
    if (r.ok) discarded++
  }

  console.log(run ? `\ndiscarded=${discarded}` : '\nDRY RUN — re-run with --run. History is never touched.')
}

main().finally(() => prisma.$disconnect())
