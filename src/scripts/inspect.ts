import { prisma } from '@/lib/db'
import { readStringArray } from '@/lib/json'

/** Quick DB inspection for debugging detection quality. Read-only. */
async function main() {
  const rows = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN' },
    orderBy: { postedAt: 'desc' },
    include: { target: true },
  })
  for (const r of rows) {
    console.log('─'.repeat(78))
    console.log(`${r.shortcode}  @${r.target.handle}  ${r.postedAt.toISOString().slice(0, 10)}  conf=${r.confidence}`)
    console.log(`  brands : ${readStringArray(r.brands).join(' | ') || '(none)'}`)
    console.log(`  signals: ${readStringArray(r.signals).join(' | ')}`)
    console.log(`  tags   : ${(r.caption.match(/#[\w]+/g) ?? []).join(' ') || '(none)'}`)
    console.log(`  mention: ${(r.caption.match(/@[\w.]+/g) ?? []).join(' ') || '(none)'}`)
  }
  console.log('─'.repeat(78))
  const counts = await prisma.detectedCampaign.groupBy({ by: ['verdict'], _count: { _all: true } })
  for (const c of counts) console.log(`  ${c.verdict.padEnd(14)} ${c._count._all}`)
  await prisma.$disconnect()
}
main()
