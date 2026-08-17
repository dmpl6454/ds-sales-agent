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

const i = process.argv.indexOf('--lookback')
const lookbackHours = i >= 0 ? Number(process.argv[i + 1]) : undefined

const s = await runDetection(lookbackHours ? { lookbackHours } : {})
for (const c of s.channels) {
  console.log(
    `  @${c.handle}: ${c.fetched} fetched, ${c.stored} new (${c.campaigns} campaigns), ${c.alreadyKnown} known` +
      /*
       * Only when it happened. A post editing its own tags after publication is rare and
       * worth a word; a "0 refreshed" on every channel every pass is furniture, and this
       * dashboard has a rule about numbers that appear whether or not they mean anything.
       */
      (c.evidenceRefreshed > 0 ? `, ${c.evidenceRefreshed} changed their tags since we stored them` : '') +
      (c.error ? ` — ERROR: ${c.error}` : ''),
  )
}
console.log(`\n${s.postsSeen} posts seen, ${s.newPosts} new, ${s.detected} campaigns.`)
process.exit(s.hadParseFailure || s.hadError ? 1 : 0)
