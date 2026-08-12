import { prisma } from '@/lib/db'
import { istStamp } from '@/lib/time'

/**
 *   pnpm ig:reply <sender> <target> [--at <ISO timestamp>]
 *   pnpm ig:reply --list
 *
 * Records that a target replied to us, which halts all further outreach to them.
 *
 * WHY THIS EXISTS AS ITS OWN COMMAND
 *
 * `OutreachAttempt.repliedAt` was read in six places — the governor's TARGET_REPLIED
 * stop, the planner, `deliverWaiting`, the dashboard, the audit — and written in
 * none. Nothing in the codebase could set it, so the governor's hardest guard, the
 * one that halts *every* sender to a target the moment a human answers, had never
 * been able to fire once.
 *
 * That is the failure mode this project keeps hitting: the negative direction works
 * perfectly (no reply -> null -> proceed), which is what makes it look wired up. The
 * positive direction was unreachable. A guard nobody can trigger is not a guard.
 *
 * The cost of the gap is specific and bad: someone answers a pitch, and the agent
 * keeps firing cold follow-ups into a live conversation from up to three accounts.
 * That is precisely the "repeated unwanted contact" Meta's policy penalises, aimed
 * at the one person who actually engaged.
 *
 * This is the manual path, deliberately shipped first because it is correct and
 * immediate. Automatic detection reads the thread and is the better answer, but a
 * missing guard should not wait on a browser routine to become fixable.
 *
 * WHY A REPLY IS NOT AN OPT-OUT
 *
 * `optedOut` means "never contact again" and is used for retirement. A reply is the
 * opposite of a rejection — it is the outcome we want. It stops *automated* outreach
 * so a human can take the conversation over. Conflating the two would file every
 * interested prospect under "do not contact".
 */

interface Args {
  sender?: string
  target?: string
  at?: Date
  list: boolean
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  let at: Date | undefined
  let list = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--list') {
      list = true
    } else if (arg === '--at') {
      const raw = argv[++i]
      if (!raw) throw new Error('--at needs an ISO timestamp, e.g. --at 2026-07-31T08:10:00Z')
      const parsed = new Date(raw)
      if (Number.isNaN(parsed.getTime())) throw new Error(`--at is not a valid date: ${raw}`)
      // A reply in the future is a typo, and it would poison the cooldown maths.
      if (parsed.getTime() > Date.now() + 60_000) throw new Error(`--at is in the future: ${raw}`)
      at = parsed
    } else {
      positional.push(arg.replace(/^@/, ''))
    }
  }

  return { sender: positional[0], target: positional[1], at, list }
}

/** Every attempt that could receive a reply, so the operator can see what to name. */
async function list(): Promise<void> {
  const sent = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['SENT', 'REPLIED'] } },
    include: { pair: { include: { sender: true, target: true } } },
    orderBy: { sentAt: 'desc' },
  })

  if (sent.length === 0) {
    console.log('\n  Nothing has been sent yet, so nothing can have been replied to.\n')
    return
  }

  console.log('\n  Delivered messages:\n')
  for (const a of sent) {
    const mark = a.repliedAt ? '✉ REPLIED' : '  awaiting'
    const when = a.repliedAt ? ` (reply recorded ${istStamp(a.repliedAt)})` : ''
    console.log(`  ${mark}  @${a.pair.sender.handle} → @${a.pair.target.handle}${when}`)
  }
  console.log('\n  Record one with:  pnpm ig:reply <sender> <target> [--at <ISO>]\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.list || !args.sender || !args.target) {
    await list()
    if (!args.list) {
      console.log('  Usage: pnpm ig:reply <sender> <target> [--at <ISO timestamp>]\n')
      process.exitCode = 1
    }
    await prisma.$disconnect()
    return
  }

  const pair = await prisma.outreachPair.findFirst({
    where: { sender: { handle: args.sender }, target: { handle: args.target } },
    include: { sender: true, target: true },
  })

  if (!pair) {
    console.log(`\n  No routing pair @${args.sender} → @${args.target}.\n`)
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  // The reply attaches to the message it answers: the most recent delivered attempt
  // for this pair. Attaching it to the pair alone would lose which message earned it.
  const attempt = await prisma.outreachAttempt.findFirst({
    where: { pairId: pair.id, status: { in: ['SENT', 'REPLIED'] } },
    orderBy: { sentAt: 'desc' },
  })

  if (!attempt) {
    console.log(
      `\n  @${args.sender} → @${args.target} has no delivered message, so there is nothing to have replied to.\n`,
    )
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  // Already recorded. Re-running with an explicit --at CORRECTS the timestamp rather
  // than refusing: the common case is recording a reply as "now" because the real
  // time was unknown, then learning it from the thread. Without this the approximate
  // value would be permanent, and an operator with better information could not
  // supply it. Bare re-runs are still a no-op, so this cannot silently drift.
  if (attempt.repliedAt) {
    if (!args.at) {
      console.log(`\n  Already recorded: @${args.target} replied ${istStamp(attempt.repliedAt)}. Nothing to do.`)
      console.log(`  Pass --at <ISO> to correct the timestamp.\n`)
      await prisma.$disconnect()
      return
    }
    if (args.at.getTime() === attempt.repliedAt.getTime()) {
      console.log(`\n  Already recorded with that exact time. Nothing to do.\n`)
      await prisma.$disconnect()
      return
    }
  }

  // A reply cannot predate the message it answers.
  const at = args.at ?? new Date()
  if (attempt.sentAt && at.getTime() < attempt.sentAt.getTime()) {
    console.log(
      `\n  Refusing: the reply time ${istStamp(at)} is before the message was sent ` +
        `(${istStamp(attempt.sentAt)}).\n`,
    )
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction([
    prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { repliedAt: at, status: 'REPLIED' },
    }),
    prisma.auditLog.create({
      data: {
        actor: 'operator',
        action: attempt.repliedAt ? 'reply.correct' : 'reply.record',
        entity: `OutreachAttempt:${attempt.id}`,
        detail:
          `@${pair.target.handle} replied to @${pair.sender.handle} at ${at.toISOString()}` +
          `${attempt.repliedAt ? ` (corrected from ${attempt.repliedAt.toISOString()})` : ''}` +
          `${args.at ? '' : ' (timestamp not supplied — recorded as now)'}`,
      },
    }),
  ])

  // Say what it now blocks, not just that a row changed. The point of recording a
  // reply is the halt, and an operator should see the halt confirmed.
  const otherSenders = await prisma.outreachPair.count({
    where: { targetId: pair.targetId, senderId: { not: pair.senderId }, enabled: true },
  })

  console.log(`\n  Recorded: @${pair.target.handle} replied to @${pair.sender.handle} at ${istStamp(at)}.`)
  console.log(`\n  Outreach to @${pair.target.handle} is now halted for every sender`)
  console.log(`  (this pair${otherSenders > 0 ? ` and ${otherSenders} other enabled pair(s)` : ''}).`)
  console.log(`  The governor will report: target-replied\n`)
  if (!args.at) {
    console.log(`  Timestamp was not supplied, so "now" was recorded. Re-run with`)
    console.log(`  --at <ISO> if you know when the reply actually arrived.\n`)
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err)
  await prisma.$disconnect()
  process.exitCode = 1
})
