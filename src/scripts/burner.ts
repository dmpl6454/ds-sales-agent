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

    const realPairs = await prisma.outreachPair.updateMany({
      where: { targetId: { not: burner.id } },
      data: { enabled: !burnerOnly },
    })
    await prisma.outreachPair.updateMany({
      where: { targetId: burner.id },
      data: { enabled: true },
    })

    let discarded = 0
    if (burnerOnly) {
      const res = await prisma.outreachAttempt.updateMany({
        where: {
          status: { in: ['READY', 'QUEUED'] },
          pair: { targetId: { not: burner.id } },
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
        ? `\n  REHEARSAL MODE ON\n\n  ${realPairs.count} real routing pairs disabled. ${discarded} prepared draft${discarded === 1 ? '' : 's'} discarded.\n  The only account that can now be messaged is @${BURNER}.\n\n  Next:  pnpm run:slot   then send it from the dashboard\n  After: pnpm burner off\n`
        : `\n  REHEARSAL MODE OFF\n\n  ${realPairs.count} real routing pairs re-enabled.\n  Run \`pnpm run:slot\` to prepare real messages again.\n`,
    )
  }

  const pairs = await prisma.outreachPair.findMany({
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })
  const anyRealEnabled = pairs.some((p) => p.enabled && p.target.handle !== BURNER)

  console.log(`  ${anyRealEnabled ? 'LIVE — real prospects are reachable' : `REHEARSAL — only @${BURNER} is reachable`}\n`)
  for (const p of pairs) {
    const isBurner = p.target.handle === BURNER
    const profile = profileStatus(p.sender.handle)
    console.log(
      `  ${p.enabled ? '●' : '○'} @${p.sender.handle.padEnd(20)} → @${p.target.handle.padEnd(22)}` +
        `${p.enabled ? '' : ' (disabled)'}${isBurner ? '  [burner]' : ''}` +
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
