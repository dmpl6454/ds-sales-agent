import { prisma } from '@/lib/db'
import { istDayStart, daysAgo } from '@/lib/time'
import { readRecord } from '@/lib/json'

/** Cross-check every number the dashboard shows against the database. */
async function main() {
  const weekStart = daysAgo(7)
  const targets = await prisma.targetAccount.findMany({ orderBy: { handle: 'asc' } })

  console.log('\n═══ HEADER (last run) ═══')
  const run = await prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } })
  if (run) {
    console.log(`  postsSeen=${run.postsSeen}  newPosts=${run.newPosts}  detected=${run.detected}  queued=${run.queued}`)
    const d = readRecord(run.detail)
    for (const c of (d.channels ?? []) as any[]) {
      console.log(`    @${c.handle}: fetched=${c.fetched} alreadyKnown=${c.alreadyKnown} stored=${c.stored} campaigns=${c.campaigns}`)
    }
  }

  console.log('\n═══ METRICS (last 7 days) ═══')
  console.log(`  paid campaigns spotted : ${await prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } } })}`)
  console.log(`  messages sent          : ${await prisma.outreachAttempt.count({ where: { status: 'SENT', sentAt: { gte: weekStart } } })}`)
  console.log(`  replies                : ${await prisma.outreachAttempt.count({ where: { repliedAt: { gte: weekStart } } })}`)

  console.log('\n═══ PER CHANNEL ═══')
  for (const t of targets) {
    const all = await prisma.detectedCampaign.count({ where: { targetId: t.id } })
    const week = await prisma.detectedCampaign.count({ where: { targetId: t.id, verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } } })
    const byVerdict = await prisma.detectedCampaign.groupBy({ by: ['verdict'], where: { targetId: t.id }, _count: { _all: true } })
    console.log(`  @${t.handle}`)
    console.log(`    posts stored (all time) : ${all}`)
    console.log(`    CAMPAIGN this week      : ${week}`)
    console.log(`    by verdict              : ${byVerdict.map(v => `${v.verdict}=${v._count._all}`).join(' ')}`)
  }

  console.log('\n═══ ATTEMPTS ═══')
  const byStatus = await prisma.outreachAttempt.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`  ${byStatus.map(s => `${s.status}=${s._count._all}`).join('  ') || '(none)'}`)

  console.log('\n═══ ALL-TIME totals ═══')
  console.log(`  total posts stored: ${await prisma.detectedCampaign.count()}`)
  console.log(`  total CAMPAIGN    : ${await prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN' } })}`)
  await prisma.$disconnect()
}
main()
