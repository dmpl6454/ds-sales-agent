import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, access, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '@/lib/logger'
import { FRAMES_DIR } from '@/lib/paths'
import { frameShrinkTool, parseSipsDimensions, sipsProbeArgs, sipsShrinkArgs, type FrameShrinkTool } from '@/lib/platform'
import { createFailureMemory } from './lookupCooldown'
import type { WorkerOnThisHost } from '@/worker/heartbeat'

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
 *
 * The cap is on what is WRITTEN. Since 16 Oct 2026 an over-size IMAGE is shrunk to fit and the
 * shrunk copy saved (see `saveFrameReport`); the cap itself did not move.
 */
export const MAX_FRAME_BYTES = 512 * 1024

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

/**
 * ── A FRAME IS WRITTEN TO A TEMP NAME AND RENAMED, SO A HALF-WRITTEN ONE NEVER EXISTS (review, 16 Oct 2026)
 *
 * `writeFile` straight to `<shortcode>.jpg` was not atomic: a full disk or a crash mid-write leaves a
 * truncated `.jpg`, and `hasFrame` asks only whether the file EXISTS — so the truncated frame counted
 * as saved for good, was never re-fetched, and the recovery pass (rejudge.ts) offered it every pass to
 * an OCR read that could not decode it. Now the bytes go to `<shortcode>.jpg.tmp-<pid>-<random>` in
 * the SAME directory (a rename across filesystems is not atomic) and are renamed onto the real name
 * only once fully written; any failure unlinks the temp.
 *
 * Every reader finds a frame through `framePathFor`, which names `<shortcode>.jpg` exactly, so a temp
 * name is invisible to `hasFrame`, `loadFrame`, OCR (ocr.ts) and `pnpm ig:frames` by construction —
 * none of them lists the directory. (`pnpm ig:migrate-data` does list one, but it is the LEGACY
 * frames directory inside the credential root, which nothing writes to any more; `ig:prune` and disk
 * care never look in the frames directory.) What is NOT handled: a process killed between the write
 * and the rename (SIGKILL — pm2's escalation) leaves one temp file behind, at most `MAX_FRAME_BYTES`,
 * invisible to every reader and swept by nothing. Its frequency is unmeasured; `ls ~/.ds-sales-agent-data/frames | grep -c tmp-` counts them.
 */
export const FRAME_TEMP_MARK = '.tmp-'

/** PURE: the temp name a frame is staged under before the rename. Same directory, never `<shortcode>.jpg`. */
export function frameTempPathFor(path: string, pid: number = process.pid, random: string = randomBytes(6).toString('hex')): string {
  return `${path}${FRAME_TEMP_MARK}${pid}-${random}`
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

/**
 * `deferred` — over the cap, and this pass's shrink bound is spent (`FrameShrinkBudget`); left for the
 * post's next re-observation — only ever on a routine one-page read, which the next pass re-reads. `cooling-off` — this shortcode's over-size path failed within
 * `SHRINK_RETRY_AFTER_MS`; skipped WITHOUT a request. Neither is a failure: nothing was learned about
 * the post, and both are counted by the pass (never silent).
 */
export type SaveFrameOutcome = 'saved' | 'already-saved' | 'no-url' | 'bad-shortcode' | 'failed' | 'deferred' | 'cooling-off'

/**
 * WHY a frame was not saved, as a kind — so `pnpm ig:frames --capture` can count each separately
 * rather than calling every failure "expired". They have different remedies: a refused fetch is
 * usually an expired CDN URL (gone for THAT url; a backfill re-read through the official API brings a
 * fresh one), no shrink engine is a host to fix, a still-too-large frame is a cap to revisit with a
 * measurement.
 */
export type FrameFailure =
  | 'fetch-refused'
  | 'fetch-error'
  | 'empty'
  | 'not-an-image'
  | 'too-large-to-shrink'
  | 'no-shrink-engine'
  | 'shrink-failed'
  | 'still-too-large'
  | 'write-failed'

export interface SaveFrameReport {
  /** `saved` means a usable frame is on disk now, whether or not it had to be shrunk first. */
  outcome: SaveFrameOutcome
  /**
   * Set when the fetched file was over the cap and a shrunk copy was saved instead. `quality` is the
   * JPEG quality that fitted (85, or a step down — see `SHRUNK_FRAME_QUALITY_STEPS`); null when the
   * engine did not say.
   */
  shrunk: { fromBytes: number; toBytes: number; engine: FrameShrinkTool['engine']; quality: number | null } | null
  /** Set when `outcome` is `failed`. */
  failure: FrameFailure | null
  /** The sentence the log carried, for a person reading a report. */
  why: string | null
}

/**
 * ── OVER THE CAP: SHRINK IT, DO NOT THROW IT AWAY (16 Oct 2026) ─────────────────────────────
 *
 * MEASURED IN PRODUCTION. With the anonymous feed walled, every post arrives through the official
 * Graph API (`graphFeed.ts`), whose cover frame is `thumbnail_url` (a video) or the image's own
 * `media_url` — FULL-SIZE files, where the anonymous path picks a ~480 px thumbnail. The box's
 * backfill log refused most of them: `frame size out of bounds — not saved bytes=1052612 / 748357 /
 * 591056 / 870691 / 571895`. Each such post was judged on its caption alone, and its footage text —
 * the Thane-bus class, `SWITCH` on a bumper — was never read.
 *
 * So a file over `MAX_FRAME_BYTES` is shrunk to fit 720 x 1280 at JPEG 85 — stepping down to 75, then
 * 65, if that is still over the cap (`SHRUNK_FRAME_QUALITY_STEPS`) — by `scripts/frame-shrink.py` on the
 * server or `sips` on a Mac (`frameShrinkTool` in lib/platform.ts is the one branch), and THAT is
 * saved. The 512 KB cap on what is WRITTEN is unchanged; what changed is that an over-size image is
 * no longer the end of its evidence. A detection pass starts at most `SHRINKS_PER_PASS` shrinks plus room
 * for every frame of a backfill's read or a read past its first page, and a shortcode whose shrink
 * failed is not retried for `SHRINK_RETRY_AFTER_MS` (all below).
 *
 * Three guards in front of the shrink, each so that a shape change upstream costs one skipped frame
 * and never an unbounded child process:
 *   1. the download itself stops at `MAX_SHRINK_INPUT_BYTES` — a video file in the thumbnail field
 *      is never buffered whole on a 961 MB box;
 *   2. the bytes must BE an image by their magic bytes (JPEG, PNG, WebP) — an MP4 (`ftyp` at offset
 *      4) is refused without starting anything;
 *   3. the shrink is time- and output-bounded, and its output must itself be a JPEG within the cap,
 *      or nothing is written.
 */
/**
 * WHY 8 MB. The largest full-size frame measured on the box was 1,052,612 bytes, and Instagram
 * serves images at most ~1440 px wide; 8 MB is ~8x the largest seen and covers a full-size PNG,
 * while a video file — tens of MB — stops at the bound. Above it the frame is skipped, logged, and
 * nothing is spawned.
 */
export const MAX_SHRINK_INPUT_BYTES = 8 * 1024 * 1024

/**
 * A shrink is one decode and one resize of a file of about a megabyte — expected well under a
 * second, but NOT MEASURED on the 961 MB box, where Python plus OpenCV must also start, and where
 * RapidOCR was measured at 0.61 frames/s under load. Thirty seconds bounds a stuck child without
 * cutting off a slow but healthy one; on expiry the child is SIGKILLed and the frame is skipped.
 */
const SHRINK_TIMEOUT_MS = 30_000

/** The box the shrink fits a frame into, and its JPEG quality. See scripts/frame-shrink.py. */
export const SHRUNK_FRAME_MAX_WIDTH = 720
export const SHRUNK_FRAME_MAX_HEIGHT = 1280
export const SHRUNK_FRAME_JPEG_QUALITY = 85

/**
 * THE QUALITY STEPS, WHEN 85 IS STILL OVER THE CAP (review, 16 Oct 2026). Tried in order, and never
 * below the last. MEASURED here (Pillow 12.3.0, through scripts/frame-shrink.py) on the test's noise
 * frame — 1080x1920 seeded uniform random noise saved at JPEG 95, then fitted to 720x1280 — it is
 * 565,435 bytes at 85 — refused before this — 431,505 at 75 and 363,082 at 65. 65 is a floor CHOSEN for OCR legibility,
 * not measured: how far quality can fall before RapidOCR stops reading small text has not been
 * measured. scripts/frame-shrink.py carries the same steps (`STEP_DOWN_QUALITIES`); the sips path
 * uses this list.
 */
export const SHRUNK_FRAME_QUALITY_STEPS = [SHRUNK_FRAME_JPEG_QUALITY, 75, 65] as const

/** scripts/frame-shrink.py's exit code for "still over --max-bytes at the floor quality". */
const FRAME_SHRINK_EXIT_STILL_TOO_LARGE = 6

/**
 * PURE: what kind of image these bytes are by their own first bytes, or null. A Content-Type header
 * is the remote's claim; the magic bytes are the file.
 */
export function imageKind(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png'
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

/**
 * PURE: the size a frame becomes inside the box, keeping its aspect ratio. Never larger than the
 * input — `scaled: false` means it already fits and is only re-encoded. Mirrors `fit` in
 * scripts/frame-shrink.py; the sips path uses this one.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth = SHRUNK_FRAME_MAX_WIDTH,
  maxHeight = SHRUNK_FRAME_MAX_HEIGHT,
): { width: number; height: number; scale: number; scaled: boolean } {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)
  if (scale >= 1) return { width, height, scale: 1, scaled: false }
  return {
    width: Math.min(maxWidth, Math.max(1, Math.round(width * scale))),
    height: Math.min(maxHeight, Math.max(1, Math.round(height * scale))),
    scale,
    scaled: true,
  }
}

export type ShrinkResult =
  | { ok: true; bytes: Buffer; engine: FrameShrinkTool['engine']; quality?: number | null }
  | { ok: false; kind: 'no-engine' | 'failed' | 'still-too-large'; reason: string }

export type FrameShrinker = (input: Buffer) => Promise<ShrinkResult>

/** One bounded child: stdin in, stdout (as bytes) out. Never throws. */
function runBounded(
  command: string,
  args: string[],
  input: Buffer | null,
): Promise<{ ok: true; stdout: Buffer; stderr: string } | { ok: false; reason: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        command,
        args,
        {
          encoding: 'buffer',
          timeout: SHRINK_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          // Room for "still too large" to be measured and reported; anything beyond is a runaway.
          maxBuffer: 4 * MAX_FRAME_BYTES,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr ?? '').toString('utf8') })
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          const detail = Buffer.from(stderr ?? '').toString('utf8').trim().slice(0, 200)
          const reason =
            e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? `${command} wrote more than ${4 * MAX_FRAME_BYTES} bytes`
              : e.killed || e.signal === 'SIGKILL'
                ? `${command} timed out after ${SHRINK_TIMEOUT_MS}ms`
                : e.code === 'ENOENT'
                  ? `${command} could not start (not found)`
                  : `${command} exited ${String(e.code ?? e.signal ?? 'with an error')}${detail ? `: ${detail}` : ''}`
          resolve({ ok: false, reason, exitCode: typeof e.code === 'number' ? e.code : null })
        },
      )
      // The child may exit before reading all of stdin (a refusal); that EPIPE is not our error.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input ?? undefined)
    } catch (err) {
      resolve({ ok: false, reason: `${command} could not start: ${err instanceof Error ? err.message : String(err)}`, exitCode: null })
    }
  })
}

/**
 * The host's shrink, through the tool `frameShrinkTool` chose. Never throws. `tool` is injectable
 * so a test drives each branch — including `none` — with the real code around it.
 */
export async function shrinkFrameBytes(input: Buffer, tool: FrameShrinkTool = frameShrinkTool()): Promise<ShrinkResult> {
  if (tool.engine === 'none') return { ok: false, kind: 'no-engine', reason: tool.reason }

  if (tool.engine === 'python') {
    const res = await runBounded(
      tool.command,
      [
        tool.script,
        '--max-width', String(SHRUNK_FRAME_MAX_WIDTH),
        '--max-height', String(SHRUNK_FRAME_MAX_HEIGHT),
        '--quality', String(SHRUNK_FRAME_JPEG_QUALITY),
        // The script steps the quality down (75, then 65) until the frame fits, and refuses below 65.
        '--max-bytes', String(MAX_FRAME_BYTES),
      ],
      input,
    )
    if (!res.ok) {
      return res.exitCode === FRAME_SHRINK_EXIT_STILL_TOO_LARGE
        ? { ok: false, kind: 'still-too-large', reason: res.reason }
        : { ok: false, kind: 'failed', reason: res.reason }
    }
    return { ok: true, bytes: res.stdout, engine: 'python', quality: qualityReported(res.stderr) }
  }

  /**
   * sips reads and writes FILES, so the bytes are staged in the OS temp directory under a random
   * name and both files are removed whatever happens. The size is asked first so `-Z` is passed
   * only when the frame is larger than the box. The same quality steps as the script: 85, and while
   * the result is over the cap, 75 then 65 — one bounded sips run each (`formatOptions` is the
   * quality), never below 65. NOT EXERCISED in the container this was written in (no sips); the
   * arguments are pure and tested, the loop is not run.
   */
  const stem = join(tmpdir(), `ds-frame-shrink-${process.pid}-${randomBytes(6).toString('hex')}`)
  const inPath = `${stem}.${imageKind(input) ?? 'img'}`
  const outPath = `${stem}.out.jpg`
  try {
    await writeFile(inPath, input)
    const probe = await runBounded(tool.command, sipsProbeArgs(inPath), null)
    if (!probe.ok) return { ok: false, kind: 'failed', reason: probe.reason }
    const dims = parseSipsDimensions(probe.stdout.toString('utf8'))
    if (!dims) return { ok: false, kind: 'failed', reason: 'sips did not report the image size' }
    const fit = fitWithin(dims.width, dims.height)
    // FLOOR the long side, so sips's own rounding of the short side can never land one pixel over.
    const longSide = fit.scaled ? Math.max(1, Math.floor(Math.max(dims.width, dims.height) * fit.scale)) : null
    let last = 0
    for (const quality of SHRUNK_FRAME_QUALITY_STEPS) {
      const shrunk = await runBounded(tool.command, sipsShrinkArgs(inPath, outPath, longSide, quality), null)
      if (!shrunk.ok) return { ok: false, kind: 'failed', reason: shrunk.reason }
      const bytes = await readFile(outPath)
      if (bytes.length <= MAX_FRAME_BYTES) return { ok: true, bytes, engine: 'sips', quality }
      last = bytes.length
    }
    return {
      ok: false,
      kind: 'still-too-large',
      reason: `sips output was ${last} bytes at quality ${SHRUNK_FRAME_QUALITY_STEPS[SHRUNK_FRAME_QUALITY_STEPS.length - 1]}, over the ${MAX_FRAME_BYTES}-byte cap`,
    }
  } catch (err) {
    return { ok: false, kind: 'failed', reason: `sips staging failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await rm(inPath, { force: true }).catch(() => {})
    await rm(outPath, { force: true }).catch(() => {})
  }
}

/**
 * PURE: the quality scripts/frame-shrink.py says it wrote, from the one JSON line it prints on STDERR
 * after a success (`{"ok": true, "quality": 75, "bytes": …}`), or null. STDOUT is the JPEG and nothing
 * else, so the report goes to STDERR; anything unparsable there is ignored — this is a measurement for
 * the log line, never a guard.
 */
export function qualityReported(stderr: string): number | null {
  for (const line of stderr.split('\n').reverse()) {
    try {
      const v = JSON.parse(line) as { ok?: unknown; quality?: unknown }
      if (v && v.ok === true && typeof v.quality === 'number' && Number.isInteger(v.quality)) return v.quality
    } catch {
      // not the report line
    }
  }
  return null
}

/**
 * ── A FAILED SHRINK IS NOT RETRIED EVERY PASS (review, 16 Oct 2026) ──────────────────────────
 *
 * The official read re-observes a post on every pass while it sits on the first page (25 posts a
 * channel, `GRAPH_PAGE_LIMIT`), and the known-post loop calls `saveFrame` for each frameless one — so a
 * frame whose shrink failed, or came out still too large, was re-downloaded (0.5-1 MB: the box log's
 * refused frames were 571,895-1,052,612 bytes) and re-shrunk (a Python + OpenCV start) on every pass,
 * four an hour, for as long as it was re-observed. And with a per-pass shrink bound (below), a
 * population of such failures would take the whole bound every pass and starve the frames that would
 * have shrunk — the livelock lookupCooldown.ts records three times over.
 *
 * So after a failure on the OVER-SIZE path — not an image, over the input bound, no engine, the shrink
 * failed, still too large — that shortcode is skipped WITHOUT a request for `SHRINK_RETRY_AFTER_MS`.
 * The memory is lookupCooldown.ts's: in-process and time-based. Nothing is persisted, because a
 * failure must never become a verdict; a restart forgets it, which costs one retry — the safe
 * direction. It never touches the normal small-frame path: a shortcode enters it only by failing
 * after its file proved over the cap, and a refused or failed DOWNLOAD (an expired URL, a network
 * blip) is not remembered at all.
 *
 * WHY 6 HOURS. It is the routine detection lookback (`DETECT_LOOKBACK_HOURS`, cadence.ts), the span
 * the official read keeps re-observing a recent post for, so a frame that keeps failing costs one
 * download and one child per such span instead of ~24. A TRANSIENT failure (a child killed under
 * memory pressure, the 30 s timeout) is retried after 6 h if the post is still re-observed, and
 * otherwise by `pnpm ig:frames --capture`, a separate process whose memory starts empty. Also stated:
 * a shrink engine installed while the worker runs is used for these shortcodes only after 6 h or a
 * restart; and an anonymous-feed re-observation of a cooling post (its small thumbnail) is skipped
 * too for the rest of the 6 h. Skips are counted per pass (`FrameShrinkBudget.coolingOff`).
 */
export const SHRINK_RETRY_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * ── AND THE MEMORY IS BOUNDED (review, 16 Oct 2026) ──────────────────────────────────────────
 *
 * It is keyed by SHORTCODE, and nothing evicted an entry — an expired one included — so it held one
 * entry per distinct failing post for the worker's whole life. Capped like the over-size memory below,
 * at the same 5,000, the oldest failure forgotten first (lookupCooldown.ts `maxEntries`). Forgetting one
 * costs what a restart costs: one more download and one more shrink child, inside the pass's bound.
 * MUTATION (applied once, seen red, restored): creating the memory without `maxEntries` fails
 * tests/frame-shrink.test.ts "the shrink negative cache is bounded…".
 */
export const SHRINK_FAILURE_MEMORY_MAX = 5_000

const shrinkFailures = createFailureMemory(SHRINK_RETRY_AFTER_MS, { maxEntries: SHRINK_FAILURE_MEMORY_MAX })

/** The over-size path's failures — the only ones remembered. */
const OVER_SIZE_PATH_FAILURES: ReadonlySet<FrameFailure> = new Set<FrameFailure>([
  'not-an-image',
  'too-large-to-shrink',
  'no-shrink-engine',
  'shrink-failed',
  'still-too-large',
])

/**
 * ── AND A PASS STARTS AT MOST `SHRINKS_PER_PASS` SHRINKS (review, 16 Oct 2026) ───────────────
 *
 * The first pass after this deploys meets every recent frameless official-read post at once — ~425
 * on the box (the review's count; 19 channels x a 25-post page is ~475 re-observed a pass) — and would
 * shrink them all, one child after another, INSIDE the detection pass: at an unmeasured ~1-2 s a
 * shrink plus a 0.5-1 MB download each, a pass of many minutes on the 15-minute clock, and ~400 MB
 * through a 961 MB box's network in one burst.
 *
 * WHY 40. At the same unmeasured 1-2 s it is ~1 minute of shrinking and ~20-40 MB of downloads a pass;
 * the steady state — a few new posts per channel per pass — is well under it, so it binds only on a
 * backlog; and 40 a pass drains ~425 in ~11 passes, under three hours, while the posts are still on
 * the first page being re-observed. The bound counts shrinks STARTED (child processes), not frames
 * saved — a pass whose shrinks all fail spends exactly as much as one whose shrinks all succeed. A
 * frame under the cap is never counted and never deferred.
 *
 * WHAT A DEFERRAL COSTS, precisely. Once the bound is spent, an over-size frame is still REQUESTED once
 * to learn that it is over-size — its body is not read when the response declares a Content-Length
 * over the cap, and is cut at the cap when it does not (whether the Graph CDN sends Content-Length is
 * not measured) — and is then remembered, in-process, as over-size: on later passes, while the bound is
 * spent, it is deferred with NO request at all. A deferred post stays frameless; a ROUTINE read re-reads
 * each channel's newest posts, so the next pass with room shrinks it. The pass logs `frames left for a
 * later pass to shrink` once. NOT GUARANTEED, stated: a post near the bottom of the newest page can
 * fall off it before a pass has room (a busy channel), and an anonymous one-page read re-reads only 12
 * posts — such a post is recovered by `ig:backfill --run`, which is never deferred (below).
 *
 * ── AND A DEEPER READ ADDS ROOM FOR EVERY FRAME IT RETURNED (review, 16 Oct 2026) ──────────────
 *
 * That "re-reads" holds only for a channel's newest page. A read past its first page — the gap rule's
 * catch-up (up to `GRAPH_GAP_MAX_POSTS` a channel), `pnpm ig:backfill --run` (up to 600 a channel and its
 * call cap), or a routine read that needed a second page — returns posts no routine pass reads again: a
 * frame deferred there was never shrunk, and for a post already stored its fresh URL is not even kept
 * (evidence.ts refreshes nothing from the official read), so `ig:frames --capture` would fetch the old,
 * expired one. With one 40-shrink budget a 48-hour backfill would shrink 40 frames and judge the rest on
 * their captions alone (by the code, review 16 Oct 2026 — never run on the box) — the exact failure this
 * file's shrink exists to end.
 *
 * So the pipeline calls `widenFrameShrinkBudget` with the number of posts such a read returned — and for
 * every read of a backfill, a person's run made to store posts with their evidence — BEFORE it saves any
 * of them: that read is never deferred, because its own frames have room. Still bounded, by the read
 * itself (48, 150 or 600 posts a channel, and the pass's call cap: 60, or the backfill's 200, pages of
 * 25), so a pass starts at most 40 plus the posts its deeper reads returned. What that costs is what such
 * a pass always cost before the anonymous wall: a frame per post, read and judged
 * (`BACKFILL_SECONDS_PER_POST`, ~7 s a post MEASURED 8 Sept with frames; the shrink's own time on the
 * box is not measured). Leftover room — posts whose frames were small or already saved — is spent by
 * later channels' backlog in the same pass, which only drains it sooner.
 *
 * `pnpm ig:frames --capture` passes no budget: it is a person's deliberate act, run with the worker
 * stopped (docs/DEPLOY.md), one shrink at a time, and a bound there would only make them re-run it.
 */
export const SHRINKS_PER_PASS = 40

export interface FrameShrinkBudget {
  /** The bound: `SHRINKS_PER_PASS`, plus whatever deeper reads added (`widened`). */
  bound: number
  /** Room added for deeper reads this pass (`widenFrameShrinkBudget`) — part of `bound`. */
  widened: number
  /** Shrinks this pass may still START. */
  remaining: number
  /** Shrinks started (child processes), successful or not. */
  started: number
  /** Over-size frames left for a later pass because the bound was spent. */
  deferred: number
  /** Over-size frames skipped without a request because their shrink failed within `SHRINK_RETRY_AFTER_MS`. */
  coolingOff: number
}

/** One per detection pass; `saveFrameReport` spends it. */
export function createFrameShrinkBudget(bound: number = SHRINKS_PER_PASS): FrameShrinkBudget {
  return { bound, widened: 0, remaining: bound, started: 0, deferred: 0, coolingOff: 0 }
}

/**
 * Room for `posts` more shrinks — called by the pipeline for a backfill's read or a read past its first
 * page, with the number of posts it returned, before any of their frames is saved (see "A DEEPER READ
 * ADDS ROOM" above). Whole,
 * non-negative counts only: anything else adds nothing, so a bad number can never unbound a pass.
 */
export function widenFrameShrinkBudget(budget: FrameShrinkBudget, posts: number): void {
  if (!Number.isInteger(posts) || posts <= 0) return
  budget.bound += posts
  budget.widened += posts
  budget.remaining += posts
}

/**
 * Shortcodes whose file proved over the cap, so a spent bound can defer them with no request. Bounded
 * (insertion order, the oldest forgotten first): forgetting one costs a single request on a later pass.
 */
const OVER_SIZE_MEMORY_MAX = 5_000
const overSizeSeen = new Set<string>()
function rememberOverSize(shortcode: string): void {
  overSizeSeen.delete(shortcode)
  overSizeSeen.add(shortcode)
  if (overSizeSeen.size > OVER_SIZE_MEMORY_MAX) {
    const oldest = overSizeSeen.values().next().value
    if (oldest !== undefined) overSizeSeen.delete(oldest)
  }
}

/** Tests only: both in-process memories, which would otherwise leak between cases in one process. */
export function resetFrameMemoriesForTests(): void {
  shrinkFailures.reset()
  overSizeSeen.clear()
}

/** Tests only: how many shortcodes the shrink negative cache holds now. */
export function shrinkFailureMemorySizeForTests(): number {
  return shrinkFailures.size()
}

let shrinker: FrameShrinker = (input) => shrinkFrameBytes(input)

/** Tests only: replace the shrink; `null` restores the host's own. */
export function setFrameShrinkerForTests(fn: FrameShrinker | null): void {
  shrinker = fn ?? ((input) => shrinkFrameBytes(input))
}

/**
 * Read a response body, stopping once it passes `limit` bytes — so an unexpected video in the
 * thumbnail field costs `limit` bytes of memory and one skipped frame, never the whole file.
 */
async function readBounded(res: Response, limit: number): Promise<{ bytes: Buffer; over: boolean; seen: number }> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    return { bytes: Buffer.alloc(0), over: true, seen: declared }
  }
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer())
    return { bytes: all, over: all.length > limit, seen: all.length }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > limit) {
      await reader.cancel().catch(() => {})
      return { bytes: Buffer.alloc(0), over: true, seen }
    }
    chunks.push(value)
  }
  return { bytes: Buffer.concat(chunks), over: false, seen }
}

/**
 * Download a post's cover frame once. Idempotent: an existing file is never re-fetched
 * (the frame of a published post does not change; the URL under it merely rotates).
 *
 * Never throws: a frame that fails to save costs one piece of evidence, never a detection pass.
 */
export async function saveFrame(
  shortcode: string,
  thumbnailUrl: string | null,
  opts: { budget?: FrameShrinkBudget } = {},
): Promise<SaveFrameOutcome> {
  return (await saveFrameReport(shortcode, thumbnailUrl, opts)).outcome
}

/**
 * `saveFrame`, with what happened on the way — for `pnpm ig:frames --capture`'s report. `budget` is the
 * detection pass's shrink bound (`createFrameShrinkBudget`); absent, shrinks are unbounded.
 */
export async function saveFrameReport(
  shortcode: string,
  thumbnailUrl: string | null,
  opts: { budget?: FrameShrinkBudget } = {},
): Promise<SaveFrameReport> {
  const budget = opts.budget
  const done = (outcome: SaveFrameOutcome, why: string | null = null): SaveFrameReport => ({ outcome, shrunk: null, failure: null, why })
  const refuse = (failure: FrameFailure, why: string, fields: Record<string, unknown> = {}): SaveFrameReport => {
    log.warn('frame not saved', { shortcode, why, ...fields })
    // MUTATION (applied once, seen red, restored): deleting this `note` fails
    // tests/frame-shrink.test.ts "a shortcode whose shrink failed is skipped without a request…".
    if (OVER_SIZE_PATH_FAILURES.has(failure)) shrinkFailures.note(shortcode)
    return { outcome: 'failed', shrunk: null, failure, why }
  }
  const defer = (): SaveFrameReport => {
    if (budget) budget.deferred += 1
    return done('deferred', `over the size cap, and this pass's ${budget?.bound ?? 0} shrinks are spent — left for a later pass that re-reads the post`)
  }

  const path = framePathFor(shortcode)
  if (!path) return done('bad-shortcode')
  if (!thumbnailUrl) return done('no-url')
  if (await hasFrame(shortcode)) return done('already-saved')

  // A shortcode whose over-size path failed recently: no request at all (see SHRINK_RETRY_AFTER_MS).
  if (shrinkFailures.isCoolingOff(shortcode)) {
    if (budget) budget.coolingOff += 1
    return done('cooling-off', `its shrink failed within the last ${SHRINK_RETRY_AFTER_MS / 3_600_000} h — not retried yet`)
  }
  // The bound is spent and this file is already known to be over the cap: defer with no request.
  const boundSpent = budget !== undefined && budget.remaining <= 0
  if (boundSpent && overSizeSeen.has(shortcode)) return defer()

  // Which step a throw came from, so a full disk is never reported as a failed download.
  let phase: 'fetch' | 'write' = 'fetch'
  try {
    const res = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return refuse('fetch-refused', `the CDN refused the frame (HTTP ${res.status}) — usually an expired URL`, { status: res.status })
    }
    /**
     * With the bound spent, read no further than the cap: a frame under it is saved as ever (never
     * deferred), and one over it is deferred without downloading the rest — or any of it, when its
     * Content-Length says so (`readBounded`). MUTATION (applied once, seen red, restored): reading to
     * `MAX_SHRINK_INPUT_BYTES` here regardless fails tests/frame-shrink.test.ts "the bound: …".
     */
    const body = await readBounded(res, boundSpent ? MAX_FRAME_BYTES : MAX_SHRINK_INPUT_BYTES)
    if (body.over) {
      if (boundSpent) {
        rememberOverSize(shortcode)
        return defer()
      }
      return refuse('too-large-to-shrink', `the file is over ${MAX_SHRINK_INPUT_BYTES} bytes — not an image we would shrink`, { bytes: body.seen })
    }
    let bytes = body.bytes
    if (bytes.length === 0) return refuse('empty', 'the CDN returned an empty file')

    let shrunk: SaveFrameReport['shrunk'] = null
    if (bytes.length > MAX_FRAME_BYTES) {
      rememberOverSize(shortcode)
      // An MP4's `ftyp` box must never reach a child. MUTATION (applied once, seen red, restored):
      // deleting this branch fails tests/frame-shrink.test.ts "an over-size MP4 is refused…".
      const kind = imageKind(bytes)
      if (!kind) {
        const head = bytes.subarray(4, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '?')
        return refuse('not-an-image', `over the size cap and not an image by its magic bytes (bytes 4-8 read "${head}")`, { bytes: bytes.length })
      }
      // The bound counts shrinks STARTED. With the bound spent the read above already stopped at the
      // cap and deferred; this is the second guard, so no change to the read can start a child past it.
      if (budget) {
        if (budget.remaining <= 0) return defer()
        budget.remaining -= 1
        budget.started += 1
      }
      const result = await shrinker(bytes)
      if (!result.ok) {
        return result.kind === 'no-engine'
          ? refuse('no-shrink-engine', `over the size cap and no shrink engine here: ${result.reason}`, { bytes: bytes.length })
          : result.kind === 'still-too-large'
            ? refuse('still-too-large', `still too large after shrinking, at every quality down to ${SHRUNK_FRAME_QUALITY_STEPS[SHRUNK_FRAME_QUALITY_STEPS.length - 1]}: ${result.reason}`, { bytes: bytes.length })
            : refuse('shrink-failed', `over the size cap and the shrink failed: ${result.reason}`, { bytes: bytes.length })
      }
      // The output is checked as strictly as a download: a JPEG, non-empty, within the cap.
      if (imageKind(result.bytes) !== 'jpeg' || result.bytes.length === 0) {
        return refuse('shrink-failed', 'over the size cap and the shrink did not produce a JPEG', { bytes: bytes.length, out: result.bytes.length })
      }
      // MUTATION (applied once, seen red, restored): deleting this refusal fails
      // tests/frame-shrink.test.ts "a shrink whose output is still over the cap writes nothing".
      if (result.bytes.length > MAX_FRAME_BYTES) {
        return refuse('still-too-large', `still too large after shrinking (${result.bytes.length} bytes, cap ${MAX_FRAME_BYTES})`, {
          bytes: bytes.length,
          out: result.bytes.length,
        })
      }
      shrunk = { fromBytes: bytes.length, toBytes: result.bytes.length, engine: result.engine, quality: result.quality ?? null }
      bytes = result.bytes
    }

    phase = 'write'
    await mkdir(FRAMES_ROOT, { recursive: true })
    // Atomic: the temp name, then the rename — see `FRAME_TEMP_MARK`. MUTATION (applied once, seen
    // red, restored): writing straight to `path` again fails tests/frame-atomic-write.test.ts.
    const temp = frameTempPathFor(path)
    try {
      await writeFile(temp, bytes)
      await rename(temp, path)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      throw err
    }
    shrinkFailures.clear(shortcode)
    overSizeSeen.delete(shortcode)
    if (shrunk) {
      // ONE LINE PER SHRINK, with both sizes and the quality that fitted: this is how production
      // measures what a shrunk frame comes to and how often the step-down fires (docs/DEPLOY.md greps
      // for it). Nothing about those numbers is measured yet.
      log.info('frame shrunk to fit the cap and saved', {
        shortcode,
        engine: shrunk.engine,
        bytesBefore: shrunk.fromBytes,
        bytesAfter: shrunk.toBytes,
        quality: shrunk.quality ?? 'unreported',
      })
    }
    return { outcome: 'saved', shrunk, failure: null, why: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return phase === 'write'
      ? refuse('write-failed', `the frame could not be written to disk: ${message}`)
      : refuse('fetch-error', `the frame fetch failed: ${message}`)
  }
}

/**
 * ── `pnpm ig:frames --capture` REFUSES BESIDE A WORKER RUNNING ON THIS HOST (review, 16 Oct 2026) ──
 *
 * Every over-size frame it fetches is a shrink — a Python + OpenCV child (scripts/frame-shrink.py), the
 * same weight as an OCR read — and it has no per-run bound. Beside the worker on the 961 MB box that is a
 * second such child next to the worker's own OCR and shrink children (CLAUDE.md rule 16: one OCR child at
 * a time), so it refuses, the way `ig:rejudge` and `ig:backfill --run` do, and prints the detached line
 * that stops the worker, captures, and starts it again (`setsid`, so a closing console cannot strand the
 * worker stopped). "Running on this host" is `workerRunningHere` (worker/heartbeat.ts), asked by the
 * script; this is only the decision and its words, here because src/scripts/frames.ts runs its query at
 * import time and cannot be driven. The DRY RUN (no `--capture`) never asks: it only counts and prices,
 * spending nothing.
 *
 * The line is docs/DEPLOY.md's frames line exactly, less its `cd /opt/ds-sales-agent && ` (a person
 * reading this refusal is already there) — tests/frames-capture.test.ts holds the two together.
 */
export const FRAMES_CAPTURE_LOG = '/tmp/ig-frames.log'

export function framesCaptureStopRunStartLine(): string {
  return (
    `setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:frames --capture; pm2 start ds-sales-worker' ` +
    `> ${FRAMES_CAPTURE_LOG} 2>&1 < /dev/null & tail -F ${FRAMES_CAPTURE_LOG}`
  )
}

/** What the person is told beside that line, every time it is printed. */
export const FRAMES_CAPTURE_DETACHED_NOTE =
  'It runs detached — closing this console does not stop it or leave the worker stopped; Ctrl-C stops only the tail. ' +
  'While it runs the worker is stopped: no detection, no drafting, no slots. Then check the worker came back: pm2 describe ds-sales-worker'

/** What the script learned about a worker on this host: `workerRunningHere`'s answer, or why it could not ask. */
export type FramesCaptureWorkerCheck = { worker: WorkerOnThisHost | null } | { heartbeatError: string }

/**
 * PURE. The lines `--capture` prints INSTEAD of capturing, or null when it may capture. An unreadable
 * heartbeat refuses too: a worker on this host cannot be ruled out, and the conservative direction costs
 * a person one line (the same reasoning as `ig:rejudge`).
 */
export function framesCaptureRefusal(check: FramesCaptureWorkerCheck): string[] | null {
  let why: string
  if ('heartbeatError' in check) {
    why = `Refusing: the scheduler heartbeat could not be read (${check.heartbeatError}), so a worker running on this host cannot be ruled out.`
  } else if (!check.worker) {
    return null
  } else if (check.worker.kind === 'unnamed') {
    why =
      `A detection worker that names no machine beat ${check.worker.ago} (pid ${check.worker.pid}) — it may be on this host, and its pid ` +
      'cannot be checked from here. Refusing; the beat goes stale three minutes after it stops.'
  } else {
    why =
      `The detection worker is running on this host (pid ${check.worker.pid}, last heartbeat ${check.worker.ago}). Every over-size frame ` +
      '--capture fetches is a Python + OpenCV shrink child, and beside the worker that is a second such child next to its own OCR and ' +
      'shrink children on a 961 MB box. Refusing.'
  }
  return [why, 'Nothing was downloaded and nothing was written. Run this instead, as one line:', framesCaptureStopRunStartLine(), FRAMES_CAPTURE_DETACHED_NOTE]
}
