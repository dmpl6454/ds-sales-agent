import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '@/lib/logger'
import { FRAMES_DIR } from '@/lib/paths'

/**
 * The durable cover-frame store: ~/.ds-sales-agent-DATA/frames/<shortcode>.jpg
 *
 * NOTE THE DIRECTORY. These moved OUT of `~/.ds-sales-agent` on 2026-08-08, and the
 * distinction is a security boundary rather than tidiness: that directory holds Chrome
 * profiles which decrypt offline to Instagram session cookies, so it is treated as a
 * password file. Frames are public CDN images and the exact thing a future contact-sheet
 * UI, support bundle or rsync wants to touch casually — none of which is safe while they
 * share a parent with the profiles. See src/lib/paths.ts.
 *
 * WHY BYTES AND NOT URLS. `rawPayload` records the thumbnail URL, and that URL is a CDN
 * link with a lifetime. The docs used to say the pipeline "refreshes it on every
 * re-observation" — IT DOES NOT, and never did. `persist()` runs only inside
 * `for (const post of fresh)`, and `fresh` excludes every shortcode already stored, so a
 * re-observed post is never re-persisted. MEASURED on the live database: 48 of 1,709 rows
 * carry a thumbnail URL, all of them created after capture shipped, and 39 pre-capture
 * rows that were re-observed across ~9 later passes gained none.
 *
 * That is the whole argument for storing bytes. A URL is a promise that something else
 * will still be there later; the file is the evidence. The Thane bus (`DbtNU9UzWYU`)
 * proved the cost — the paid placement was IN the frame, the caption said nothing, and by
 * the time anyone looked, looking depended on a URL nobody had kept alive.
 *
 * COST, MEASURED rather than estimated (206 real frames, 10,005,588 bytes):
 * mean 47.4 KB a frame — NOT the ~35 KB first written here — and 203 posts a day across
 * the watched channels, so ~9.6 MB/day and ~3.5 GB/year. The earlier figure understated it
 * threefold. Against ~26 GB free that is still not the disk problem browser cache is
 * (627 MB in ONE profile; see ig:prune), but it is the fastest-growing directory here and
 * it belongs in that command's report.
 *
 * EVERY function here refuses to throw upward. A frame failing to save must never fail
 * a detection pass: the caption verdict does not depend on it, and detection finishing
 * matters more than any single piece of evidence.
 */

const FRAMES_ROOT = FRAMES_DIR

/**
 * Instagram media CDN needs no headers at all — it is a public CDN URL — but a size cap
 * is load-bearing: this writes to disk on every new post, forever, and a shape change
 * upstream (a video URL landing in the thumbnail field) must cost one skipped frame, not
 * an unbounded file.
 */
const MAX_FRAME_BYTES = 512 * 1024

/**
 * The measured mean, exported so no caller has to guess and no projection is invented.
 * 206 frames, 10,005,588 bytes, 2026-08-07.
 */
export const MEAN_FRAME_BYTES = 47_400
const FETCH_TIMEOUT_MS = 15_000

/**
 * PURE: where a shortcode's frame lives. Shortcodes are Instagram's own URL-safe tokens,
 * but this is a filename built from remote data, so anything outside the known alphabet
 * is refused rather than repaired — the same rule as "never guess a handle".
 */
export function framePathFor(shortcode: string): string | null {
  if (!/^[A-Za-z0-9_-]{5,32}$/.test(shortcode)) return null
  return join(FRAMES_ROOT, `${shortcode}.jpg`)
}

export async function hasFrame(shortcode: string): Promise<boolean> {
  const path = framePathFor(shortcode)
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function loadFrame(shortcode: string): Promise<Buffer | null> {
  const path = framePathFor(shortcode)
  if (!path) return null
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

export type SaveFrameOutcome = 'saved' | 'already-saved' | 'no-url' | 'bad-shortcode' | 'failed'

/**
 * Download a post's cover frame once. Idempotent: an existing file is never re-fetched
 * (the frame of a published post does not change; the URL under it merely rotates).
 */
export async function saveFrame(shortcode: string, thumbnailUrl: string | null): Promise<SaveFrameOutcome> {
  const path = framePathFor(shortcode)
  if (!path) return 'bad-shortcode'
  if (!thumbnailUrl) return 'no-url'
  if (await hasFrame(shortcode)) return 'already-saved'

  try {
    const res = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      log.warn('frame fetch refused', { shortcode, status: res.status })
      return 'failed'
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
      log.warn('frame size out of bounds — not saved', { shortcode, bytes: bytes.length })
      return 'failed'
    }
    await mkdir(FRAMES_ROOT, { recursive: true })
    await writeFile(path, bytes)
    return 'saved'
  } catch (err) {
    log.warn('frame fetch failed', { shortcode, error: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
}
