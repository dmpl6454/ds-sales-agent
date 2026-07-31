import { prisma } from '@/lib/db'
import { profileStatus } from '@/outreach/browser/profile'

/**
 *   pnpm burner on      only the burner can be messaged
 *   pnpm burner off     back to the real targets
 *   pnpm burner status  which pairs are live right now
 *
 * Rehearsal mode. `on` disables every routing pair except those aimed at the burner,
 * so while you are testing the send path there is no code path that reaches a real
 * prospect — not an unlikely one, none.
 *
 * This exists because "be careful during the test" is not a control. A misclick on
 * the dashboard, a stray `pnpm run:slot`, or the worker firing on schedule would all
 * happily deliver a real pitch mid-rehearsal. Disabling the pairs removes the
 * possibility instead of relying on nobody making a mistake.
 *
 * Prepared drafts for real targets are discarded on `on` for the same reason: a
 * READY attempt has a Send button next to it. They cost seconds to regenerate
 * (`pnpm run:slot`) and are never lost — a fresh draft is written from scratch each
 * time, and discarding one does not consume its campaign as "already referenced".
 */

const BURNER = 'priyanshu123321123'

/**
 * Targets that are safe to message during a rehearsal: the burner, plus any target
 * that is also one of our own sending accounts.
 *
 * The second case is the point — messaging one account you own from another is the
 * closest possible rehearsal of the real thing, with a recipient who cannot be
 * annoyed and cannot report you. Treating those as "real prospects" and disabling
 * them would rule out the best test available.
 */
async function safeTargetIds(): Promise<Set<string>> {
  const senders = new Set((await prisma.senderAccount.findMany({ select: { handle: true } })).map((s) => s.handle))
  const targets = await prisma.targetAccount.findMany({ select: { id: true, handle: true } })
  return new Set(targets.filter((t) => t.handle === BURNER || senders.has(t.handle)).map((t) => t.id))
}

async function main() {
  const cmd = (process.argv[2] ?? 'status').toLowerCase()

  const burner = await prisma.targetAccount.findUnique({ where: { handle: BURNER } })
  if (!burner) {
    console.log(`\n  No burner target seeded (@${BURNER}). Run: pnpm db:seed\n`)
    await prisma.$disconnect()
    return
  }

  if (cmd === 'on' || cmd === 'off') {
    const burnerOnly = cmd === 'on'

    const safe = await safeTargetIds()
    const realPairs = await prisma.outreachPair.updateMany({
      where: { targetId: { notIn: [...safe] } },
      data: { enabled: !burnerOnly },
    })

    let discarded = 0
    if (burnerOnly) {
      const res = await prisma.outreachAttempt.updateMany({
        where: {
          status: { in: ['READY', 'QUEUED'] },
          pair: { targetId: { notIn: [...safe] } },
        },
        data: { status: 'SKIPPED', error: 'discarded for burner rehearsal' },
      })
      discarded = res.count
    }

    await prisma.auditLog.create({
      data: {
        actor: 'operator',
        action: burnerOnly ? 'burner.on' : 'burner.off',
        entity: 'OutreachPair',
        detail: `${realPairs.count} real pairs ${burnerOnly ? 'disabled' : 'enabled'}, ${discarded} drafts discarded`,
      },
    })

    console.log(
      burnerOnly
        ? `\n  REHEARSAL MODE ON\n\n  ${realPairs.count} real routing pairs disabled. ${discarded} prepared draft${discarded === 1 ? '' : 's'} discarded.\n  The only accounts that can now be messaged are ones we own.\n\n  Next:  pnpm run:slot   then send it from the dashboard\n  After: pnpm burner off\n`
        : `\n  REHEARSAL MODE OFF\n\n  ${realPairs.count} real routing pairs re-enabled.\n  Run \`pnpm run:slot\` to prepare real messages again.\n`,
    )
  }

  const pairs = await prisma.outreachPair.findMany({
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })
  const safeIds = await safeTargetIds()
  const anyRealEnabled = pairs.some((p) => p.enabled && !safeIds.has(p.targetId))

  console.log(`  ${anyRealEnabled ? 'LIVE — real prospects are reachable' : 'REHEARSAL — only accounts we own are reachable'}\n`)
  for (const p of pairs) {
    const isSafe = safeIds.has(p.targetId)
    const profile = profileStatus(p.sender.handle)
    console.log(
      `  ${p.enabled ? '●' : '○'} @${p.sender.handle.padEnd(20)} → @${p.target.handle.padEnd(22)}` +
        `${p.enabled ? '' : ' (disabled)'}${isSafe ? '  [safe test target]' : ''}` +
        `${p.enabled && !profile.hasSession ? `  needs: pnpm ig:login ${p.sender.handle}` : ''}`,
    )
  }
  console.log()
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
