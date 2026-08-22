import { prisma } from '@/lib/db'
import { campaignsNamingHandleRows } from '@/outreach/materialAllowance'
import { env } from '@/lib/env'
import { describeCap, getSettings } from '@/lib/settings'
import { hoursAgo } from '@/lib/time'
import { renderMessage, validatePersona } from '@/outreach/render'

/**
 * Print the exact message each routing pair would send right now, using the
 * current live hook and the next variant in rotation.
 *
 * This is the audit surface for the DRY_RUN week: read what would actually go
 * out, to whom, from whom, before anything is enabled.
 *
 *   pnpm preview           # one pair per line-block
 *   pnpm preview --all     # every variant for every pair
 */
async function main() {
  const showAll = process.argv.includes('--all')
  const settings = await getSettings()

  const pairs = await prisma.outreachPair.findMany({
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })

  console.log(`\n  DRY_RUN=${env.DRY_RUN ? '1 (nothing sends)' : '0 (LIVE)'}   max/pair/day=${describeCap(settings.maxPerPairPerDay)}\n`)

  for (const pair of pairs) {
    /* Campaigns NAMING this recipient, through the shared linkage — `targetId` here is
       the posting channel and was null for every prospect (2026-08-22). */
    const naming = await campaignsNamingHandleRows(prisma, pair.target, hoursAgo(settings.hookMaxAgeHours))
    const freshest = naming.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())[0]
    const hook = freshest ? await prisma.detectedCampaign.findUnique({ where: { id: freshest.id } }) : null

    const variants = await prisma.messageVariant.findMany({
      where: { senderId: pair.senderId, enabled: true },
      orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { timesUsed: 'asc' }],
      take: showAll ? undefined : 1,
    })

    const problems = validatePersona(pair.sender)

    console.log('═'.repeat(78))
    console.log(`  FROM  @${pair.sender.handle}   (${pair.sender.displayName})`)
    console.log(`  TO    @${pair.target.handle}   (${pair.target.displayName})`)
    console.log(`  HOOK  ${hook ? `${hook.shortcode} — ${hook.permalink}` : '(no campaign in window)'}`)
    if (problems.length > 0) {
      console.log(`  ⚠ BLOCKED: ${problems.join('; ')}`)
    }
    console.log('═'.repeat(78))

    for (const v of variants) {
      const { body } = renderMessage({
        persona: pair.sender,
        target: pair.target,
        variantBody: v.body,
        hook,
      })
      console.log(`\n  ── variant: ${v.label} (${body.length} chars) ──\n`)
      console.log(
        body
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      )
      console.log()
    }
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
