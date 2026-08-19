import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
const start = new Date()
async function main() {
  console.log('watching from', start.toISOString())
  const seen = new Set<string>()
  for (let i = 0; i < 240; i++) {
    const fresh = await prisma.outreachAttempt.findMany({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: start } },
      select: { id: true, sentAt: true, sentBy: true, target: { select: { handle: true } } },
      orderBy: { sentAt: 'asc' },
    })
    for (const f of fresh) { if (!seen.has(f.id)) { seen.add(f.id); console.log(`SENT ${f.sentAt?.toISOString().slice(11,19)}Z ${f.sentBy} -> @${f.target.handle}`) } }
    if (seen.size >= 3) { console.log('THREE SENDS DONE'); return }
    await new Promise(r => setTimeout(r, 15_000))
  }
  console.log(`timeout: only ${seen.size} sent in the watch window`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
