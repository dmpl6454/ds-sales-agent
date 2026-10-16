/**
 *   pnpm ig:frames            how many cover frames are on disk, and what is missing
 *   pnpm ig:frames --capture  download every frame whose URL is still alive. FREE.
 *
 * The cover frame is the only record of what a post SHOWED, and a paid placement can live
 * entirely in the footage (CLAUDE.md, "THE CAPTION IS NOT THE POST"). Frames are saved
 * automatically at detection time; this covers the corpus that predates that, and any save
 * that failed.
 *
 * **Run `--capture` generously and often.** It costs nothing but bandwidth (a measured mean of
 * 47.4 KB a frame on the anonymous path; a full-size official-read file is ~0.5-1 MB before it is
 * shrunk), and the thumbnail is a CDN URL with a lifetime: once it expires, THIS command can no longer
 * fetch it. Not always gone for good (review, 16 Oct 2026): the official API pages a channel's whole
 * history, so `pnpm ig:backfill --hours N --run` re-reads the posts of the last N hours (at most 168)
 * with FRESH URLs, and the pipeline's known-post loop saves their frames — every post but a carousel,
 * which the official read gives no frame at all. Judging the frames can wait; capturing them cannot.
 *
 * And judging a captured frame is only PARTLY automatic. The detection pass's re-judge picks up a post
 * stored `frame:not-saved` whose frame is now on disk — but only among the newest 1,000 such posts
 * (rejudge.ts, `RECOVERY_SCAN_PER_PASS`), and the cutoff is a fixed date, so an older post this command
 * banks may never be reached by a pass. `pnpm ig:rejudge --run` reaches it, and says how many it left.
 *
 * ── OFFICIAL-READ FRAMES ARE SHRUNK, AND A FAILURE SAYS WHICH KIND (16 Oct 2026) ──
 *
 * The Graph API's frame is full-size, and `saveFrame` used to refuse everything over 512 KB, so the
 * box's backfill banked almost none of them. It now shrinks an over-size image and saves that
 * (`saveFrameReport` in media.ts). This report says how many were shrunk, and counts each kind of
 * failure separately: "expired" was the only word it had, and it was wrong for every frame the cap
 * refused.
 *
 * NO PER-RUN BOUND, deliberately (review, 16 Oct 2026). The detection pass starts at most
 * `SHRINKS_PER_PASS` (40) shrinks on its routine one-page reads and defers the rest to the next pass,
 * which re-reads those posts — a backfill's reads, and any read past its first page, get room for every
 * frame they return — and it remembers a frame whose shrink failed for 6 h (media.ts). This command passes no budget: it is a person's deliberate act, run with the worker
 * stopped (docs/DEPLOY.md), one shrink at a time, and a bound would only make them run it again.
 *
 * AND `--capture` REFUSES BESIDE A WORKER RUNNING ON THIS HOST (review, 16 Oct 2026), the way `ig:rejudge`
 * and `ig:backfill --run` do: each shrink is a Python + OpenCV child, like an OCR read, next to the
 * worker's own on 961 MB. It prints the counts, then the detached stop-capture-start line
 * (`framesCaptureRefusal` in media.ts — docs/DEPLOY.md's frames line). The dry run still runs beside the
 * worker: it only counts and spends nothing. Its memories start empty — it is a separate process — so a frame the worker is
 * cooling off is retried here, which is the point of running it.
 *
 * THE DRY RUN'S ESTIMATE IS SPLIT BY SOURCE (review, 16 Oct 2026). The 47.4 KB mean is the ANONYMOUS
 * path's thumbnail; an official-read row (its stored payload marks `evidenceIncomplete`) downloads a
 * full-size file before it is shrunk — the box log's refused ones were 571,895-1,052,612 bytes, a
 * RANGE of five, not a measured mean — so most of today's missing set is priced as a range.
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
import {
  saveFrameReport,
  hasFrame,
  framesCaptureRefusal,
  MEAN_FRAME_BYTES,
  MAX_SHRINK_INPUT_BYTES,
  type FrameFailure,
  type FramesCaptureWorkerCheck,
} from '@/detection/media'
import { machineId, pidAliveHere, readSchedulerHeartbeat, workerRunningHere } from '@/worker/heartbeat'
import { EVIDENCE_INCOMPLETE_MARKER } from '@/detection/evidence'
import { detectionCutoff } from '@/lib/cutoff'

/**
 * The full-size frames the box's backfill log refused (16 Oct 2026): `bytes=1052612 / 748357 / 591056 /
 * 870691 / 571895`. Five values — a range for an estimate, not a mean.
 */
const OFFICIAL_FRAME_BYTES_SEEN = { min: 571_895, max: 1_052_612 }
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

const capture = process.argv.includes('--capture')

const rows = await prisma.detectedCampaign.findMany({
  where: { postedAt: { gte: detectionCutoff() } },
  orderBy: { postedAt: 'desc' },
  select: { shortcode: true, rawPayload: true, target: { select: { handle: true } } },
})

let onDisk = 0
let haveUrl = 0
let haveUrlOfficial = 0
const missing: { shortcode: string; url: string | null }[] = []

for (const r of rows) {
  const already = await hasFrame(r.shortcode)
  if (already) {
    onDisk += 1
    continue
  }
  const url = readRecord(r.rawPayload).thumbnailUrl
  const asUrl = typeof url === 'string' ? url : null
  if (asUrl) {
    haveUrl += 1
    // The same marker the pipeline reads to tell an official-read row (evidence.ts).
    if ((r.rawPayload ?? '').includes(EVIDENCE_INCOMPLETE_MARKER)) haveUrlOfficial += 1
  }
  missing.push({ shortcode: r.shortcode, url: asUrl })
}

console.log(`\n${rows.length} posts since the detection cutoff`)
console.log(`  ${onDisk} have a cover frame saved`)
console.log(`  ${missing.length} do not — of those, ${haveUrl} still have a URL worth trying`)
console.log(`  ${missing.length - haveUrl} have no URL and can never be recovered`)

if (!capture) {
  const anonymous = haveUrl - haveUrlOfficial
  console.log(
    `\n--capture downloads the ${haveUrl} recoverable frames. Costs nothing but bandwidth: ` +
      `~${mb(anonymous * MEAN_FRAME_BYTES)} MB for ${anonymous} from the anonymous feed (the measured mean of ` +
      `${Math.round(MEAN_FRAME_BYTES / 1024)} KB a frame), and ${mb(haveUrlOfficial * OFFICIAL_FRAME_BYTES_SEEN.min)}-` +
      `${mb(haveUrlOfficial * OFFICIAL_FRAME_BYTES_SEEN.max)} MB for ${haveUrlOfficial} from the official read, whose ` +
      `full-size files are downloaded before they are shrunk (the box log's refused frames ranged ` +
      `${OFFICIAL_FRAME_BYTES_SEEN.min.toLocaleString('en')}-${OFFICIAL_FRAME_BYTES_SEEN.max.toLocaleString('en')} bytes; no mean is measured). ` +
      `Each over-size one is also a shrink — one Python child at a time, time on the box not measured.`,
  )
  process.exit(0)
}

/**
 * `--capture` refuses while the detection worker runs on THIS host (review, 16 Oct 2026): every
 * over-size frame is a Python + OpenCV shrink child, beside the worker's own on a 961 MB box. The counts
 * above are printed first, and the dry run never gets here. The decision and its words are media.ts's
 * `framesCaptureRefusal`, tested there. MUTATION (applied once, seen red, restored): deleting this block
 * fails tests/frames-capture.test.ts "--capture beside a worker running on this host…".
 */
let check: FramesCaptureWorkerCheck
try {
  check = {
    worker: workerRunningHere({ beat: await readSchedulerHeartbeat(), nowMs: Date.now(), machine: machineId(), alive: pidAliveHere }),
  }
} catch (err) {
  check = { heartbeatError: err instanceof Error ? (err.message.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? err.name) : String(err) }
}
const refusal = framesCaptureRefusal(check)
if (refusal) {
  console.log('')
  for (const line of refusal) console.log(line)
  process.exit(2)
}

let saved = 0
let shrunk = 0
const failures = new Map<FrameFailure, number>()
for (const m of missing) {
  if (!m.url) continue
  const report = await saveFrameReport(m.shortcode, m.url)
  if (report.outcome === 'saved') {
    saved += 1
    if (report.shrunk) shrunk += 1
  } else if (report.outcome === 'failed' && report.failure) {
    failures.set(report.failure, (failures.get(report.failure) ?? 0) + 1)
  }
}

/** Each kind of failure in words, because they have different remedies. */
const FAILURE_WORDS: Record<FrameFailure, string> = {
  'fetch-refused':
    'the CDN refused the stored URL (usually expired). Not gone for good where the official read is configured: ' +
    '`pnpm ig:backfill --hours N --run` (detached, the worker stopped — docs/DEPLOY.md) re-reads the last N hours (at most 168) ' +
    'through the official API and saves their frames from fresh URLs, a carousel excepted; it costs official calls (~200 an hour for the account)',
  'fetch-error': 'the download failed (network; worth trying again)',
  empty: 'the CDN returned an empty file',
  'not-an-image': 'over the size cap and not an image (e.g. a video in the thumbnail field)',
  'too-large-to-shrink': `over ${MAX_SHRINK_INPUT_BYTES / 1024 / 1024} MB — not an image we would shrink`,
  'no-shrink-engine': 'over the size cap and nothing on this host can shrink it (see the log line)',
  'shrink-failed': 'over the size cap and the shrink failed (see the log line)',
  'still-too-large': 'still over the size cap after shrinking, at every JPEG quality down to 65',
  'write-failed': 'could not be written to disk',
}

console.log(`\nSaved ${saved} frames${shrunk > 0 ? ` (${shrunk} of them shrunk from a full-size file to fit the cap)` : ''}.`)
for (const [kind, n] of failures) console.log(`  ${n} not saved: ${FAILURE_WORDS[kind]}`)
if (saved > 0) {
  // Only what rejudge.ts selects: judged ordinary, stored `frame:not-saved`, channel not retired.
  console.log(
    `Posts among them judged ordinary on their caption alone (stored frame:not-saved) are re-judged with their footage ` +
      `by the detection pass on this host — 10 a pass, newest first, and ONLY among the newest 1,000 such posts. ` +
      `For older ones run \`pnpm ig:rejudge --run\` (it refuses beside the worker and prints the detached line to use), ` +
      `and repeat it until it reports none left.`,
  )
}
process.exit(0)
