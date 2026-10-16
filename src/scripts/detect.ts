/**
 *   pnpm ig:detect                 one detection pass now, routine 6-hour lookback
 *   pnpm ig:detect --lookback 26   reach further back, which BANKS COVER FRAMES for
 *                                  re-observed posts (their stored URL is not refreshed —
 *                                  see the note in pipeline.ts; the bytes are the record)
 *
 * The same function the 15-minute clock fires (src/detection/cadence.ts), on demand.
 * Anonymous reads only — decision 4 holds, nothing here can spam anyone — plus caption
 * classification for NEW posts (fractions of a cent) and the frame check where a key is
 * configured. Idempotent on shortcode, so overlapping with the scheduler is safe.
 */
import { runDetection } from '@/detection/pipeline'
// The line format lives in detectionReport.ts, shared with `pnpm ig:backfill --run`.
import { channelSummaryLine, frameShrinkLine, passSummaryLine } from '@/detection/detectionReport'

const i = process.argv.indexOf('--lookback')
const lookbackHours = i >= 0 ? Number(process.argv[i + 1]) : undefined

const s = await runDetection(lookbackHours ? { lookbackHours } : {})
for (const c of s.channels) console.log(channelSummaryLine(c))
console.log(`\n${passSummaryLine(s)}`)
const frames = frameShrinkLine(s)
if (frames) console.log(frames)
process.exit(s.hadParseFailure || s.hadError ? 1 : 0)
