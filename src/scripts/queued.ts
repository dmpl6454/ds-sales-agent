import { prisma } from '@/lib/db'
import { readRecord } from '@/lib/json'
import { profileStatus } from '@/outreach/browser/profile'

/**
 * Read-only: every message that is prepared, then why the remaining pairs are not.
 *
 * Previously this printed only the first draft and filed everything else under
 * "why the others were skipped" — including pairs whose status was READY, which
 * read as "skipped: ready". Prepared messages and blocked pairs are now separated,
 * because conflating them hid three sendable drafts behind a misleading heading.
 */
async function main() {
  const attempts = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
    include: { pair: { include: { sender: true, target: true } }, campaign: true, variant: true },
    orderBy: { queuedAt: 'asc' },
  })

  if (attempts.length === 0) {
    console.log('\nnothing prepared\n')
  } else {
    console.log(`\n${attempts.length} message${attempts.length === 1 ? '' : 's'} prepared\n`)
  }

  for (const [i, a] of attempts.entries()) {
    const bespoke = Boolean(
      a.pair.bespokeBody && a.renderedBody.includes(a.pair.bespokeBody.split('\n')[0]!.slice(0, 40)),
    )
    const profile = profileStatus(a.pair.sender.handle)
    console.log('═'.repeat(72))
    console.log(`${i + 1}.  @${a.pair.sender.handle}  →  @${a.pair.target.handle}`)
    console.log('═'.repeat(72))
    console.log(`STATUS  ${a.status}   ${bespoke ? 'BESPOKE (written for this recipient)' : `variant ${a.variant.label}`}   ${a.renderedBody.length} chars   touch ${a.touchNumber}`)
    if (bespoke && a.pair.bespokeNote) console.log(`WHY     ${a.pair.bespokeNote}`)
    console.log(`HOOK    ${a.campaign ? a.campaign.permalink : '(no specific campaign — outreach is never blocked on detection)'}`)
    console.log(
      `SEND    ${profile.initialised ? 'automatic — Chrome profile ready' : `needs a one-time login first:  pnpm ig:login ${a.pair.sender.handle}`}`,
    )
    if (a.error) console.log(`LAST    ${a.error}`)
    console.log('─'.repeat(72))
    console.log(a.renderedBody)
    console.log('─'.repeat(72))
    console.log()
  }

  const run = await prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } })
  if (run) {
    const detail = readRecord(run.detail)
    const outreach = Array.isArray(detail.outreach)
      ? (detail.outreach as { pairKey: string; skipReason?: string; status?: string }[])
      : []
    const blocked = outreach.filter((o) => o.skipReason)
    if (blocked.length > 0) {
      console.log('pairs the safety gate held back on the last run:')
      for (const o of blocked) console.log(`  ${o.pairKey.padEnd(44)} ${o.skipReason}`)
      console.log()
    }
  }
  await prisma.$disconnect()
}
main()
