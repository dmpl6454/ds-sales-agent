import { prisma } from '@/lib/db'
import { getDetector } from '@/detection/detectors'
import { writeStringArray, readStringArray } from '@/lib/json'
import { EnrichedPostSchema } from '@/detection/types'
import { log } from '@/lib/logger'

/**
 * Re-run the detectors over captions already stored, without re-fetching anything.
 *
 * Every improvement to a detector needs this: the captions are the expensive
 * part to collect and they never change, while the classification logic will keep
 * evolving. Non-destructive — it only rewrites verdict, confidence, signals and
 * brands, and deliberately preserves any human REVIEW-queue label.
 *
 *   pnpm reclassify           # report what would change
 *   pnpm reclassify --apply   # write the changes
 */
async function main() {
  const apply = process.argv.includes('--apply')

  const campaigns = await prisma.detectedCampaign.findMany({
    include: { target: true },
    orderBy: { postedAt: 'desc' },
  })

  if (campaigns.length === 0) {
    log.warn('nothing stored yet — run `pnpm run:slot` first')
    await prisma.$disconnect()
    return
  }

  let changed = 0
  for (const row of campaigns) {
    const detector = getDetector(row.target.detectorKey)

    const post = EnrichedPostSchema.parse({
      shortcode: row.shortcode,
      permalink: row.permalink,
      ownerHandle: row.target.handle,
      caption: row.caption,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      postedAt: row.postedAt,
      gridIndex: 0,
    })

    const next = await detector.classify(post)
    const prevBrands = readStringArray(row.brands)
    const brandsDiffer = JSON.stringify(prevBrands) !== JSON.stringify(next.brands)
    const verdictDiffers = row.verdict !== next.verdict

    if (!brandsDiffer && !verdictDiffers) continue
    changed += 1

    console.log('─'.repeat(78))
    console.log(`${row.shortcode}  @${row.target.handle}`)
    if (verdictDiffers) console.log(`  verdict: ${row.verdict}  ->  ${next.verdict}`)
    if (brandsDiffer) {
      console.log(`  brands : ${prevBrands.join(' | ') || '(none)'}`)
      console.log(`        ->  ${next.brands.join(' | ') || '(none)'}`)
    }

    if (apply) {
      await prisma.detectedCampaign.update({
        where: { id: row.id },
        data: {
          verdict: next.verdict,
          confidence: next.confidence,
          signals: writeStringArray(next.signals),
          brands: writeStringArray(next.brands),
        },
      })
    }
  }

  console.log('─'.repeat(78))
  console.log(`  ${campaigns.length} stored · ${changed} would change`)
  if (!apply && changed > 0) console.log('  re-run with --apply to write them\n')
  else if (apply) console.log('  applied\n')

  await prisma.$disconnect()
}

main().catch(async (err) => {
  log.error('reclassify failed', { error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
