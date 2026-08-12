/**
 *   pnpm ig:frames            how many cover frames are on disk, and what is missing
 *   pnpm ig:frames --capture  download every frame whose URL is still alive. FREE.
 *
 * The cover frame is the only record of what a post SHOWED, and a paid placement can live
 * entirely in the footage (CLAUDE.md, "THE CAPTION IS NOT THE POST"). Frames are saved
 * automatically at detection time; this covers the corpus that predates that, and any save
 * that failed.
 *
 * **Run `--capture` generously and often.** It costs nothing but bandwidth (~35 KB a
 * frame), and the thumbnail is a CDN URL with a lifetime: once it expires, the frame for
 * that post is gone for good and no later decision can re-examine it. Judging the frames
 * can wait; capturing them cannot.
 *
 * MEASURED on the live database, and it is why this command exists: 48 of 1,709 rows hold
 * a thumbnail URL at all. The pipeline's docblock claimed those URLs were "refreshed on
 * every re-observation" and they never were — `persist` runs only for posts that are NEW,
 * and 39 re-observed pre-capture rows gained no URL across ~9 later passes. So the URL
 * record is sparse by construction, and the frames on disk are already the better corpus:
 * 206 frames against 48 URLs.
 */
import { prisma } from '@/lib/db'
import { readRecord } from '@/lib/json'
import { saveFrame, hasFrame, MEAN_FRAME_BYTES } from '@/detection/media'
import { detectionCutoff } from '@/lib/cutoff'

const capture = process.argv.includes('--capture')

const rows = await prisma.detectedCampaign.findMany({
  where: { postedAt: { gte: detectionCutoff() } },
  orderBy: { postedAt: 'desc' },
  select: { shortcode: true, rawPayload: true, target: { select: { handle: true } } },
})

let onDisk = 0
let haveUrl = 0
const missing: { shortcode: string; url: string | null }[] = []

for (const r of rows) {
  const already = await hasFrame(r.shortcode)
  if (already) {
    onDisk += 1
    continue
  }
  const url = readRecord(r.rawPayload).thumbnailUrl
  const asUrl = typeof url === 'string' ? url : null
  if (asUrl) haveUrl += 1
  missing.push({ shortcode: r.shortcode, url: asUrl })
}

console.log(`\n${rows.length} posts since the detection cutoff`)
console.log(`  ${onDisk} have a cover frame saved`)
console.log(`  ${missing.length} do not — of those, ${haveUrl} still have a URL worth trying`)
console.log(`  ${missing.length - haveUrl} have no URL and can never be recovered`)

if (!capture) {
  console.log(
    `\n--capture downloads the ${haveUrl} recoverable frames. Costs nothing but bandwidth ` +
      `(~${((haveUrl * MEAN_FRAME_BYTES) / 1024 / 1024).toFixed(1)} MB at the measured mean of ` +
      `${Math.round(MEAN_FRAME_BYTES / 1024)} KB a frame).`,
  )
  process.exit(0)
}

let saved = 0
let expired = 0
for (const m of missing) {
  if (!m.url) continue
  const outcome = await saveFrame(m.shortcode, m.url)
  if (outcome === 'saved') saved += 1
  else if (outcome === 'failed') expired += 1
}

console.log(`\nSaved ${saved} frames. ${expired} URLs had already expired and are gone for good.`)
process.exit(0)
