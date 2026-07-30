import { prisma } from '@/lib/db'
import { readRecord } from '@/lib/json'

/** Read-only: show what is prepared and why the other pairs were skipped. */
async function main() {
  const a = await prisma.outreachAttempt.findFirst({
    where: { status: { in: ['READY', 'QUEUED'] } },
    include: { pair: { include: { sender: true, target: true } }, campaign: true, variant: true },
    orderBy: { queuedAt: 'asc' },
  })

  if (a) {
    console.log(`FROM   @${a.pair.sender.handle}`)
    console.log(`TO     @${a.pair.target.handle}`)
    const bespoke = Boolean(a.pair.bespokeBody && a.renderedBody.includes(a.pair.bespokeBody.split('\n')[0]!.slice(0, 40)))
    console.log(`STATUS ${a.status}   ${bespoke ? 'BESPOKE (written for this recipient)' : `variant ${a.variant.label}`}   ${a.renderedBody.length} chars`)
    if (bespoke && a.pair.bespokeNote) console.log(`WHY    ${a.pair.bespokeNote}`)
    console.log(`HOOK   ${a.campaign ? a.campaign.permalink : '(none)'}`)
    console.log('─'.repeat(72))
    console.log(a.renderedBody)
    console.log('─'.repeat(72))
  } else {
    console.log('nothing prepared')
  }

  const run = await prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } })
  if (run) {
    const detail = readRecord(run.detail)
    const outreach = Array.isArray(detail.outreach) ? (detail.outreach as { pairKey: string; skipReason?: string; status?: string }[]) : []
    console.log('\nwhy the others were skipped:')
    for (const o of outreach) console.log(`  ${o.pairKey.padEnd(44)} ${o.skipReason ?? o.status ?? '?'}`)
  }
  await prisma.$disconnect()
}
main()
