import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * OVER-SIZE COVER FRAMES ARE SHRUNK, NOT THROWN AWAY (16 Oct 2026).
 *
 * MEASURED IN PRODUCTION: with the anonymous feed walled, every post arrives through the official
 * Graph API, whose frame is a FULL-SIZE file, and `saveFrame` refused anything over 512 KB — the
 * box's backfill log read `frame size out of bounds — not saved bytes=1052612 / 748357 / 591056 /
 * 870691 / 571895`. Every official-read post was judged on its caption alone.
 *
 * What this pins, and the mutation that fails each (applied by hand once, seen red, restored from a
 * scratch copy — never `git checkout`):
 *
 *   1. the platform decision, every branch, pure (`frameShrinkTool`);
 *   2. THE MAGIC-BYTE GUARD — an over-size MP4 (`ftyp` at offset 4) is refused WITHOUT the shrink
 *      being invoked. MUTATION: deleting the `if (!kind) return refuse('not-an-image' …)` branch in
 *      `saveFrameReport` fails "an over-size MP4 is refused without invoking the shrink";
 *   3. THE POST-SHRINK SIZE CHECK — output still over the cap writes nothing. MUTATION: deleting the
 *      `result.bytes.length > MAX_FRAME_BYTES` refusal fails "a shrink whose output is still over the
 *      cap writes nothing";
 *   4. the input bound, the failure paths, the no-engine reason, and that a normal 47 KB frame never
 *      starts a child;
 *   5. a REAL run of scripts/frame-shrink.py under this machine's python3 — skipped when no python3
 *      with Pillow is present. In the container this was written in, python3 had PIL and NOT cv2, so
 *      the OpenCV branch (the server's) was not exercised here; `sips` (macOS) never was. It pins the
 *      EXACT output size and the JPEG QUALITY, not upper bounds (review, 16 Oct 2026): a 9:16 input
 *      alone cannot catch a stretch, because 9:16 IS the box's shape, so a 4:5 and a landscape input
 *      sit beside it; and the quality is read back from the output's quantisation tables, which
 *      libjpeg scales from the quality setting — OpenCV and Pillow both write those standard tables,
 *      so the check does not depend on which engine ran. MUTATIONS (each applied once, seen red,
 *      restored from a scratch copy), all in scripts/frame-shrink.py unless named:
 *        - `fit` returning `(max_w, max_h)` (a stretch to the box)  → "1080x1350 … 720x900" goes red;
 *        - `fit` halving both sides                                 → "… exactly 720x1280" goes red;
 *        - Pillow's save at `quality=30`                            → the quality assertions go red;
 *        - media.ts passing `SHRUNK_FRAME_MAX_WIDTH / 4` and `SHRUNK_FRAME_MAX_HEIGHT / 4` to the
 *          script                                                   → the end-to-end case goes red.
 *      Those last arguments are the point of the end-to-end case: a frame quietly shrunk to 180x320
 *      would sit below the ~480 px that RapidOCR's recall was MEASURED on, and nothing else would say.
 *
 * Added by the second review (16 Oct 2026), each mutation applied once, seen red, restored:
 *   6. THE QUALITY STEP-DOWN. The noise frame below is 565,435 bytes at 85 after the resize
 *      (measured here, Pillow 12.3.0), over the cap; the script now re-encodes at 75, then 65, and refuses below.
 *      MUTATION: `qualities()` in scripts/frame-shrink.py returning `[requested]` only fails "a noise
 *      frame over the cap at 85 steps down…" and the end-to-end noise case. And the sips path's loop:
 *      replacing it with one run at 85 fails "sips: steps the quality down…" (a FAKE sips here — the
 *      real one was never run where this was written);
 *   7. THE 12 MP PIXEL CAP, refused from a header alone (a 4000x4000 1-bit PNG — no decode). MUTATION:
 *      `MAX_PIXELS = 25_000_000` again fails "a 16-megapixel image is refused from its header…";
 *   8. THE SCRIPT MUST EXIST. MUTATION: dropping the `hasScript` check in `frameShrinkTool` fails "a
 *      missing scripts/frame-shrink.py is a reason naming the file…";
 *   9. THE NEGATIVE CACHE. MUTATION: deleting `shrinkFailures.note(shortcode)` in media.ts's `refuse`
 *      fails "a shortcode whose shrink failed is skipped without a request…";
 *  10. THE PER-PASS BOUND, in "the bound: …". MUTATIONS, each red at the assertion named: `boundSpent`
 *      always false — the 41st's body is read (`bodyPulls`; the second guard before the shrink still
 *      defers it, so no child starts); reading to `MAX_SHRINK_INPUT_BYTES` whatever the bound — the
 *      same; deferring every frame after its read once the bound is spent — "a frame under the cap is
 *      saved…"; deferring every frame BEFORE its request once spent — the one-request assertion.
 *  11. THE NEGATIVE CACHE IS BOUNDED (review, 16 Oct 2026) — it never evicted, so it held one entry per
 *      failing shortcode for the worker's life. MUTATIONS: deleting the eviction loop in lookupCooldown.ts
 *      fails "createFailureMemory: a cap…" and "the shrink negative cache is bounded…"; media.ts creating
 *      the memory without its `maxEntries` fails the second alone.
 */

const home = mkdtempSync(join(tmpdir(), 'ds-frame-shrink-'))
const savedHome = process.env.HOME
// paths.ts reads homedir() at import time, so the frame store lands in this temp directory.
process.env.HOME = home

const media = await import('@/detection/media')
const { createFailureMemory } = await import('@/detection/lookupCooldown')
const platform = await import('@/lib/platform')
const { FRAMES_DIR } = await import('@/lib/paths')

afterAll(() => {
  media.setFrameShrinkerForTests(null)
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const ROOT = resolve(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'frame-shrink.py')

/** A buffer of `size` bytes that starts with `head`. */
const withHead = (head: number[], size: number) => {
  const b = Buffer.alloc(size, 0x41)
  Buffer.from(head).copy(b)
  return b
}
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d] // ....ftypisom

let served: { body: Buffer; headers?: Record<string, string>; status?: number; lazy?: boolean } = { body: Buffer.alloc(0) }
let shrinkCalls: Buffer[] = []
/** Requests made, and how many times a lazily served body was actually pulled. */
let fetchCalls = 0
let bodyPulls = 0
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
const info = vi.spyOn(console, 'log').mockImplementation(() => {})

beforeEach(() => {
  rmSync(FRAMES_DIR, { recursive: true, force: true })
  shrinkCalls = []
  fetchCalls = 0
  bodyPulls = 0
  warn.mockClear()
  info.mockClear()
  media.resetFrameMemoriesForTests()
  vi.stubGlobal('fetch', async () => {
    fetchCalls++
    const status = served.status ?? 200
    if (!served.lazy) return new Response(new Uint8Array(served.body), { status, headers: served.headers })
    // A body that is only produced when someone reads it — so a test can see it was never read.
    const bytes = new Uint8Array(served.body)
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          bodyPulls++
          c.enqueue(bytes)
          c.close()
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, { status, headers: served.headers })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  media.setFrameShrinkerForTests(null)
})

const frameOnDisk = (shortcode: string) => {
  const p = join(FRAMES_DIR, `${shortcode}.jpg`)
  return existsSync(p) ? readFileSync(p) : null
}
const shrinkTo = (out: Buffer) =>
  media.setFrameShrinkerForTests(async (input) => {
    shrinkCalls.push(input)
    return { ok: true, bytes: out, engine: 'python' }
  })

describe('which tool shrinks a frame on this host — the one platform branch', () => {
  it('macOS uses sips, and prefers it to a Python that happens to exist', () => {
    expect(platform.frameShrinkTool('darwin', true, false)).toEqual({ engine: 'sips', command: 'sips' })
    expect(platform.frameShrinkTool('darwin', true, true).engine).toBe('sips')
  })

  it('anything with the RapidOCR interpreter uses scripts/frame-shrink.py under it', () => {
    const t = platform.frameShrinkTool('linux', false, true, '/x/scripts/frame-shrink.py', true)
    expect(t).toEqual({ engine: 'python', command: platform.RAPIDOCR_PYTHON, script: '/x/scripts/frame-shrink.py' })
    // The default script path is this checkout's, which exists.
    expect(platform.frameShrinkTool('darwin', false, true).engine).toBe('python')
  })

  it('a missing scripts/frame-shrink.py is a reason naming the file, never a python run that fails on every frame', () => {
    const t = platform.frameShrinkTool('linux', false, true, '/opt/ds-sales-agent/scripts/frame-shrink.py', false)
    expect(t.engine).toBe('none')
    if (t.engine === 'none') expect(t.reason).toMatch(/\/opt\/ds-sales-agent\/scripts\/frame-shrink\.py is missing/)
    // The real existence check, through the default: a path that is not there.
    expect(platform.frameShrinkTool('linux', false, true, '/nonexistent/frame-shrink.py').engine).toBe('none')
    // sips on a Mac needs no script.
    expect(platform.frameShrinkTool('darwin', true, true, '/nonexistent/frame-shrink.py', false).engine).toBe('sips')
  })

  it('sips is never chosen off macOS', () => {
    expect(platform.frameShrinkTool('linux', true, false).engine).toBe('none')
  })

  it('no tool is a REASON naming what to install, never a silent skip', () => {
    const linux = platform.frameShrinkTool('linux', false, false)
    expect(linux.engine).toBe('none')
    if (linux.engine === 'none') expect(linux.reason).toMatch(/RAPIDOCR_PYTHON/)
    const mac = platform.frameShrinkTool('darwin', false, false)
    if (mac.engine === 'none') expect(mac.reason).toMatch(/sips/)
    expect(platform.frameShrinkTool('win32', false, false).engine).toBe('none')
  })

  it('sips arguments: probe, then -Z only when shrinking, always JPEG at the quality given', () => {
    expect(platform.sipsProbeArgs('/t/a.jpg')).toEqual(['-g', 'pixelWidth', '-g', 'pixelHeight', '/t/a.jpg'])
    expect(platform.sipsShrinkArgs('/t/a.jpg', '/t/o.jpg', 1280, 85)).toEqual([
      '-Z', '1280', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '/t/a.jpg', '--out', '/t/o.jpg',
    ])
    expect(platform.sipsShrinkArgs('/t/a.png', '/t/o.jpg', null, 85)).not.toContain('-Z')
  })

  it("parses sips's size report, and refuses anything that is not one", () => {
    expect(platform.parseSipsDimensions('/tmp/x.jpg\n  pixelWidth: 1080\n  pixelHeight: 1920\n')).toEqual({ width: 1080, height: 1920 })
    expect(platform.parseSipsDimensions('Error: unable to open')).toBeNull()
    expect(platform.parseSipsDimensions('  pixelWidth: 0\n  pixelHeight: 10')).toBeNull()
  })
})

describe('the box a frame is fitted into, and what counts as an image', () => {
  it('fits 720 x 1280 keeping aspect, and never upscales', () => {
    expect(media.fitWithin(1080, 1920)).toMatchObject({ width: 720, height: 1280, scaled: true })
    expect(media.fitWithin(1080, 1350)).toMatchObject({ width: 720, height: 900, scaled: true })
    expect(media.fitWithin(1440, 1800)).toMatchObject({ width: 720, height: 900, scaled: true })
    expect(media.fitWithin(1080, 1080)).toMatchObject({ width: 720, height: 720, scaled: true })
    expect(media.fitWithin(500, 3000)).toMatchObject({ width: 213, height: 1280, scaled: true })
    expect(media.fitWithin(400, 300)).toEqual({ width: 400, height: 300, scale: 1, scaled: false })
  })

  it('reads the magic bytes: JPEG, PNG and WebP are images, an MP4 is not', () => {
    expect(media.imageKind(withHead(JPEG, 16))).toBe('jpeg')
    expect(media.imageKind(withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16))).toBe('png')
    expect(media.imageKind(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('webp')
    expect(media.imageKind(withHead(MP4, 16))).toBeNull()
    expect(media.imageKind(Buffer.alloc(0))).toBeNull()
  })
})

describe('saveFrame: an over-size frame is shrunk, and every refusal writes nothing', () => {
  it('a normal 47 KB frame never starts a shrink, and is saved byte for byte', async () => {
    served = { body: withHead(JPEG, 47_400) }
    shrinkTo(withHead(JPEG, 10))
    expect(await media.saveFrame('DcNormal01', 'https://cdn.example/a.jpg')).toBe('saved')
    expect(shrinkCalls).toHaveLength(0)
    expect(frameOnDisk('DcNormal01')?.equals(served.body)).toBe(true)
  })

  it('an over-size JPEG is shrunk, and the SAVED bytes are the shrunk ones, within the cap', async () => {
    served = { body: withHead(JPEG, 1_052_612) }
    const out = withHead(JPEG, 180_000)
    shrinkTo(out)
    const report = await media.saveFrameReport('DcBigJpeg1', 'https://cdn.example/b.jpg')
    expect(report.outcome).toBe('saved')
    expect(report.shrunk).toEqual({ fromBytes: 1_052_612, toBytes: 180_000, engine: 'python', quality: null })
    expect(shrinkCalls).toHaveLength(1)
    expect(shrinkCalls[0]!.length).toBe(1_052_612)
    const saved = frameOnDisk('DcBigJpeg1')!
    expect(saved.equals(out)).toBe(true)
    expect(saved.length).toBeLessThanOrEqual(media.MAX_FRAME_BYTES)
    // One line per shrink with both sizes — what production greps to measure it.
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('frame shrunk to fit the cap and saved'))
    expect(line).toMatch(/bytesBefore=1052612 bytesAfter=180000/)
  })

  it('an over-size MP4 is refused without invoking the shrink', async () => {
    served = { body: withHead(MP4, 900_000) }
    shrinkTo(withHead(JPEG, 10))
    const report = await media.saveFrameReport('DcVideo001', 'https://cdn.example/v.mp4')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'not-an-image' })
    expect(report.why).toMatch(/ftyp/)
    expect(shrinkCalls).toHaveLength(0)
    expect(frameOnDisk('DcVideo001')).toBeNull()
  })

  it('a file above the shrink input bound is refused without invoking the shrink — read or declared', async () => {
    served = { body: withHead(JPEG, media.MAX_SHRINK_INPUT_BYTES + 1) }
    shrinkTo(withHead(JPEG, 10))
    expect((await media.saveFrameReport('DcHuge0001', 'https://cdn.example/h.jpg')).failure).toBe('too-large-to-shrink')

    // A declared Content-Length over the bound is refused before the body is read at all.
    served = { body: withHead(JPEG, 1000), headers: { 'content-length': String(media.MAX_SHRINK_INPUT_BYTES + 5) } }
    expect((await media.saveFrameReport('DcHuge0002', 'https://cdn.example/h2.jpg')).failure).toBe('too-large-to-shrink')
    expect(shrinkCalls).toHaveLength(0)
    expect(frameOnDisk('DcHuge0001')).toBeNull()
    expect(frameOnDisk('DcHuge0002')).toBeNull()
  })

  it('a shrink that fails writes nothing, and says why', async () => {
    served = { body: withHead(JPEG, 700_000) }
    media.setFrameShrinkerForTests(async () => ({ ok: false, kind: 'failed', reason: 'python exited 4: cannot decode' }))
    const report = await media.saveFrameReport('DcShrFail1', 'https://cdn.example/c.jpg')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'shrink-failed' })
    expect(report.why).toMatch(/shrink failed: python exited 4/)
    expect(frameOnDisk('DcShrFail1')).toBeNull()
  })

  it('a shrink whose output is still over the cap writes nothing', async () => {
    served = { body: withHead(JPEG, 2_000_000) }
    shrinkTo(withHead(JPEG, media.MAX_FRAME_BYTES + 1))
    const report = await media.saveFrameReport('DcStillBig', 'https://cdn.example/d.jpg')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'still-too-large' })
    expect(frameOnDisk('DcStillBig')).toBeNull()
  })

  it('a shrink whose output is not a JPEG writes nothing', async () => {
    served = { body: withHead(JPEG, 700_000) }
    shrinkTo(withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 1000))
    expect((await media.saveFrameReport('DcNotJpeg1', 'https://cdn.example/e.jpg')).failure).toBe('shrink-failed')
    expect(frameOnDisk('DcNotJpeg1')).toBeNull()
  })

  it('no shrink engine on this host: failed, nothing written, and the reason is in the log', async () => {
    served = { body: withHead(JPEG, 600_000) }
    // The REAL runner, handed the `none` decision — the branch a host without a tool takes.
    media.setFrameShrinkerForTests((input) => media.shrinkFrameBytes(input, { engine: 'none', reason: 'install the RapidOCR venv' }))
    const report = await media.saveFrameReport('DcNoEngine', 'https://cdn.example/f.jpg')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'no-shrink-engine' })
    expect(frameOnDisk('DcNoEngine')).toBeNull()
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toMatch(/frame not saved .*no shrink engine here: install the RapidOCR venv/)
  })

  it('never throws upward — a fetch that throws is a failed frame, not a failed pass', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up')
    })
    expect(await media.saveFrame('DcThrows01', 'https://cdn.example/g.jpg')).toBe('failed')
  })
})

describe('a failed shrink is not retried every pass; a pass starts at most SHRINKS_PER_PASS shrinks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a shortcode whose shrink failed is skipped without a request for SHRINK_RETRY_AFTER_MS, then retried', async () => {
    served = { body: withHead(JPEG, 700_000) }
    media.setFrameShrinkerForTests(async (input) => {
      shrinkCalls.push(input)
      return { ok: false, kind: 'failed', reason: 'python exited 4: cannot decode' }
    })
    expect((await media.saveFrameReport('DcCoolOff1', 'https://cdn.example/c1.jpg')).failure).toBe('shrink-failed')
    expect(fetchCalls).toBe(1)

    const budget = media.createFrameShrinkBudget()
    const again = await media.saveFrameReport('DcCoolOff1', 'https://cdn.example/c1.jpg', { budget })
    expect(again.outcome).toBe('cooling-off')
    expect(fetchCalls).toBe(1) // no request at all
    expect(shrinkCalls).toHaveLength(1)
    expect(budget).toMatchObject({ coolingOff: 1, started: 0, deferred: 0 }) // counted, not silent
    expect(frameOnDisk('DcCoolOff1')).toBeNull()

    // It expires: after the cooldown the frame is fetched and the shrink tried again.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + media.SHRINK_RETRY_AFTER_MS + 1_000)
    expect((await media.saveFrameReport('DcCoolOff1', 'https://cdn.example/c1.jpg')).failure).toBe('shrink-failed')
    expect(fetchCalls).toBe(2)
    expect(shrinkCalls).toHaveLength(2)
  })

  it('a still-too-large result and a missing engine are remembered too; a refused DOWNLOAD is not', async () => {
    served = { body: withHead(JPEG, 2_000_000) }
    shrinkTo(withHead(JPEG, media.MAX_FRAME_BYTES + 1))
    expect((await media.saveFrameReport('DcStillBg2', 'https://cdn.example/s2.jpg')).failure).toBe('still-too-large')
    expect((await media.saveFrameReport('DcStillBg2', 'https://cdn.example/s2.jpg')).outcome).toBe('cooling-off')
    expect(fetchCalls).toBe(1)

    served = { body: withHead(JPEG, 600_000) }
    media.setFrameShrinkerForTests((input) => media.shrinkFrameBytes(input, { engine: 'none', reason: 'install the RapidOCR venv' }))
    expect((await media.saveFrameReport('DcNoEngin2', 'https://cdn.example/ne.jpg')).failure).toBe('no-shrink-engine')
    expect((await media.saveFrameReport('DcNoEngin2', 'https://cdn.example/ne.jpg')).outcome).toBe('cooling-off')
    expect(fetchCalls).toBe(2)

    // The small-frame path's failures are never cached: an expired URL is asked again next time.
    served = { body: Buffer.alloc(0), status: 403 }
    expect((await media.saveFrameReport('DcExpired1', 'https://cdn.example/e1.jpg')).failure).toBe('fetch-refused')
    expect((await media.saveFrameReport('DcExpired1', 'https://cdn.example/e1.jpg')).failure).toBe('fetch-refused')
    expect(fetchCalls).toBe(4)
  })

  /**
   * The memory every caller shares (lookupCooldown.ts), with a cap. No cap — what every caller but
   * media.ts passes — is unbounded, exactly as before (review, 16 Oct 2026). MUTATION (applied once, seen
   * red, restored): deleting the eviction loop in `createFailureMemory`'s `note` fails this and the next.
   */
  it('createFailureMemory: a cap keeps the newest failures and forgets the oldest; no cap (every other caller) is unbounded', () => {
    const capped = createFailureMemory(60_000, { maxEntries: 3 })
    for (const k of ['k0', 'k1', 'k2', 'k3', 'k4']) capped.note(k)
    expect(capped.size()).toBe(3)
    expect(['k0', 'k1', 'k2', 'k3', 'k4'].map((k) => capped.isCoolingOff(k))).toEqual([false, false, true, true, true])
    // A re-noted key moves to the newest end, so the next eviction takes the oldest FAILURE.
    capped.note('k2')
    capped.note('k5')
    expect(capped.size()).toBe(3)
    expect(['k2', 'k3', 'k4', 'k5'].map((k) => capped.isCoolingOff(k))).toEqual([true, false, true, true])

    const open = createFailureMemory(60_000)
    for (let i = 0; i < 50; i++) open.note(`o${i}`)
    expect(open.size()).toBe(50)
    // A cap that is not a positive whole number is no cap — never one that empties the memory.
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const m = createFailureMemory(60_000, { maxEntries: bad })
      for (let i = 0; i < 10; i++) m.note(`b${i}`)
      expect(m.size()).toBe(10)
    }
  })

  /**
   * media.ts's own memory, through `saveFrameReport`: each refusal here is `too-large-to-shrink` from a
   * declared Content-Length (no body read, no child), the cheapest way to note one. MUTATION (applied once,
   * seen red, restored): media.ts creating the memory without `{ maxEntries: SHRINK_FAILURE_MEMORY_MAX }`
   * fails this.
   */
  it(`the shrink negative cache is bounded at ${media.SHRINK_FAILURE_MEMORY_MAX}: the newest failures stay remembered, the oldest are asked again`, async () => {
    expect(media.SHRINK_FAILURE_MEMORY_MAX).toBe(5_000) // the over-size memory's cap, beside it
    served = { body: withHead(JPEG, 1000), headers: { 'content-length': String(media.MAX_SHRINK_INPUT_BYTES + 5) }, lazy: true }
    const n = media.SHRINK_FAILURE_MEMORY_MAX + 2
    const code = (i: number) => `DcCap${String(i).padStart(5, '0')}`
    for (let i = 0; i < n; i++) {
      expect((await media.saveFrameReport(code(i), 'https://cdn.example/cap.jpg')).failure).toBe('too-large-to-shrink')
    }
    expect(fetchCalls).toBe(n)
    expect(bodyPulls).toBe(0)
    expect(media.shrinkFailureMemorySizeForTests()).toBe(media.SHRINK_FAILURE_MEMORY_MAX)
    // The newest is still cooling off — no request.
    expect((await media.saveFrameReport(code(n - 1), 'https://cdn.example/cap.jpg')).outcome).toBe('cooling-off')
    expect((await media.saveFrameReport(code(2), 'https://cdn.example/cap.jpg')).outcome).toBe('cooling-off')
    expect(fetchCalls).toBe(n)
    // The two oldest were forgotten: asked again (and remembered again, which keeps the size at the cap).
    expect((await media.saveFrameReport(code(0), 'https://cdn.example/cap.jpg')).failure).toBe('too-large-to-shrink')
    expect(fetchCalls).toBe(n + 1)
    expect(media.shrinkFailureMemorySizeForTests()).toBe(media.SHRINK_FAILURE_MEMORY_MAX)
  }, 30_000) // ~2.5 s measured here for 5,002 refusals; the default 5 s is too close on a slower machine

  it(`the bound: ${media.SHRINKS_PER_PASS} shrinks start, the next over-size frame is deferred with its body unread, and once known it is deferred with no request`, async () => {
    expect(media.SHRINKS_PER_PASS).toBe(40) // the number the docblock justifies
    const budget = media.createFrameShrinkBudget()
    shrinkTo(withHead(JPEG, 90_000))
    served = { body: withHead(JPEG, 600_000) }
    for (let i = 0; i < media.SHRINKS_PER_PASS; i++) {
      expect(await media.saveFrame(`DcBound${String(i).padStart(3, '0')}`, `https://cdn.example/b${i}.jpg`, { budget })).toBe('saved')
    }
    expect(shrinkCalls).toHaveLength(media.SHRINKS_PER_PASS)
    expect(budget).toMatchObject({ remaining: 0, started: media.SHRINKS_PER_PASS, deferred: 0 })

    // The 41st: one request, headers only — the declared length is over the cap, so the body is never read.
    served = { body: withHead(JPEG, 600_000), headers: { 'content-length': '600000' }, lazy: true }
    const fetchesBefore = fetchCalls
    expect(await media.saveFrame('DcBound041', 'https://cdn.example/b41.jpg', { budget })).toBe('deferred')
    expect(fetchCalls).toBe(fetchesBefore + 1)
    expect(bodyPulls).toBe(0)
    expect(shrinkCalls).toHaveLength(media.SHRINKS_PER_PASS)
    expect(frameOnDisk('DcBound041')).toBeNull()
    expect(budget.deferred).toBe(1)

    // No Content-Length: read only up to the cap, then deferred — still no shrink.
    served = { body: withHead(JPEG, 600_000) }
    expect(await media.saveFrame('DcBound042', 'https://cdn.example/b42.jpg', { budget })).toBe('deferred')
    expect(shrinkCalls).toHaveLength(media.SHRINKS_PER_PASS)

    // A frame under the cap is saved as ever with the bound spent — never counted, never deferred.
    served = { body: withHead(JPEG, 47_400) }
    expect(await media.saveFrame('DcSmallAft', 'https://cdn.example/sm.jpg', { budget })).toBe('saved')
    expect(budget).toMatchObject({ started: media.SHRINKS_PER_PASS, deferred: 2 })

    // The NEXT pass: once its bound is spent, the frame already known over-size is deferred with NO request.
    const next = media.createFrameShrinkBudget(1)
    served = { body: withHead(JPEG, 600_000) }
    expect(await media.saveFrame('DcOther001', 'https://cdn.example/o1.jpg', { budget: next })).toBe('saved')
    const before = fetchCalls
    expect(await media.saveFrame('DcBound041', 'https://cdn.example/b41.jpg', { budget: next })).toBe('deferred')
    expect(fetchCalls).toBe(before)
    // And a pass with room shrinks it.
    expect(await media.saveFrame('DcBound041', 'https://cdn.example/b41.jpg', { budget: media.createFrameShrinkBudget() })).toBe('saved')
  })

  /**
   * The pass's half, by source — the pipeline's other dependencies make a behavioural pass test here
   * heavy, and the failure mode is a `saveFrame` call written without the budget. MUTATION (applied
   * once, seen red, restored): dropping `{ budget: frameBudget }` from the known-post loop's call in
   * pipeline.ts fails this.
   */
  it('the detection pass makes ONE budget and hands it to every saveFrame call, and logs the deferrals once', () => {
    const src = readFileSync(join(ROOT, 'src', 'detection', 'pipeline.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const calls = [...src.matchAll(/(?<![\w.])saveFrame\(([^)]*)\)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const args of calls) expect(args).toMatch(/\{ budget: frameBudget \}/)
    expect(src.match(/createFrameShrinkBudget\(/g)).toHaveLength(1)
    expect(src).toMatch(/log\.info\('frames left for a later pass to shrink'/)
  })

  /**
   * The room a backfill's read, or a read past its first page, adds for its own frames (pipeline.ts;
   * behaviour in tests/official-reach.test.ts). A bad count must add nothing: `remaining += NaN` would
   * make `remaining <= 0` false forever and silently unbound the pass. MUTATION (applied once, seen red,
   * restored): deleting `widenFrameShrinkBudget`'s whole-number guard fails this.
   */
  it('widening adds exactly the posts given, to bound and remaining — and a bad count adds nothing', async () => {
    const budget = media.createFrameShrinkBudget()
    media.widenFrameShrinkBudget(budget, 60)
    expect(budget).toMatchObject({ bound: media.SHRINKS_PER_PASS + 60, widened: 60, remaining: media.SHRINKS_PER_PASS + 60 })
    for (const bad of [Number.NaN, -5, 0, 2.5, Number.POSITIVE_INFINITY]) media.widenFrameShrinkBudget(budget, bad)
    expect(budget).toMatchObject({ bound: media.SHRINKS_PER_PASS + 60, widened: 60, remaining: media.SHRINKS_PER_PASS + 60 })
    // Spent like any room: the 101st over-size frame is deferred.
    shrinkTo(withHead(JPEG, 90_000))
    served = { body: withHead(JPEG, 600_000) }
    for (let i = 0; i < media.SHRINKS_PER_PASS + 60; i++) {
      expect(await media.saveFrame(`DcWide${String(i).padStart(3, '0')}`, `https://cdn.example/w${i}.jpg`, { budget })).toBe('saved')
    }
    expect(await media.saveFrame('DcWideLast', 'https://cdn.example/wl.jpg', { budget })).toBe('deferred')
    expect(budget).toMatchObject({ started: media.SHRINKS_PER_PASS + 60, deferred: 1, remaining: 0 })
  })

  it('no budget (pnpm ig:frames --capture) is unbounded', async () => {
    shrinkTo(withHead(JPEG, 90_000))
    served = { body: withHead(JPEG, 600_000) }
    for (let i = 0; i < media.SHRINKS_PER_PASS + 2; i++) {
      expect(await media.saveFrame(`DcNoBdg${String(i).padStart(3, '0')}`, `https://cdn.example/n${i}.jpg`)).toBe('saved')
    }
    expect(shrinkCalls).toHaveLength(media.SHRINKS_PER_PASS + 2)
  })
})

describe('the shrink runners: exit codes, the reported quality, and the sips step-down (a FAKE sips)', () => {
  const work = mkdtempSync(join(tmpdir(), 'ds-fake-shrink-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  it('qualityReported reads the script\'s one success line, and nothing else', () => {
    expect(media.qualityReported('{"ok": true, "quality": 75, "bytes": 480096}\n')).toBe(75)
    expect(media.qualityReported('[ WARN:0] noise\n{"ok": true, "quality": 65, "bytes": 1}')).toBe(65)
    expect(media.qualityReported('{"error": "x"}')).toBeNull()
    expect(media.qualityReported('')).toBeNull()
  })

  it('the script exiting 6 (still too large at 65) is a still-too-large refusal, remembered, nothing written', async () => {
    const script = join(work, 'exit6.py')
    writeFileSync(script, 'import sys, json\nsys.stdin.buffer.read()\nprint(json.dumps({"error": "still-too-large"}), file=sys.stderr)\nsys.exit(6)\n')
    served = { body: withHead(JPEG, 700_000) }
    media.setFrameShrinkerForTests((input) => media.shrinkFrameBytes(input, { engine: 'python', command: 'python3', script }))
    const report = await media.saveFrameReport('DcExit6001', 'https://cdn.example/x6.jpg')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'still-too-large' })
    expect(frameOnDisk('DcExit6001')).toBeNull()
    expect((await media.saveFrameReport('DcExit6001', 'https://cdn.example/x6.jpg')).outcome).toBe('cooling-off')
  })

  /** A stand-in for macOS's sips: reports 1080x1920, and writes a JPEG-headed file whose size depends on the quality asked. */
  const fakeSips = join(work, 'fake-sips')
  writeFileSync(
    fakeSips,
    [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'a = sys.argv[1:]',
      "if '-g' in a:",
      "    print(a[-1]); print('  pixelWidth: 1080'); print('  pixelHeight: 1920'); sys.exit(0)",
      "q = a[a.index('formatOptions') + 1]",
      "out = a[a.index('--out') + 1]",
      "n = json.loads(os.environ['FAKE_SIPS_SIZES'])[q]",
      "open(out, 'wb').write(b'\\xff\\xd8\\xff\\xe0' + b'A' * (n - 4))",
      "open(os.environ['FAKE_SIPS_LOG'], 'a').write(' '.join(a) + '\\n')",
    ].join('\n'),
  )
  chmodSync(fakeSips, 0o755)
  const sipsRun = async (sizes: Record<string, number>) => {
    const logPath = join(work, `sips-${Math.random().toString(36).slice(2)}.log`)
    process.env.FAKE_SIPS_SIZES = JSON.stringify(sizes)
    process.env.FAKE_SIPS_LOG = logPath
    const result = await media.shrinkFrameBytes(withHead(JPEG, 900_000), { engine: 'sips', command: fakeSips })
    const runs = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : []
    return { result, runs }
  }

  it('sips: steps the quality down 85 → 75 → 65 while the output is over the cap, and stops at the first that fits', async () => {
    const { result, runs } = await sipsRun({ '85': 600_000, '75': 560_000, '65': 400_000 })
    expect(result).toMatchObject({ ok: true, engine: 'sips', quality: 65 })
    if (result.ok) expect(result.bytes.length).toBe(400_000)
    expect(runs.map((r) => r.match(/formatOptions (\d+)/)?.[1])).toEqual(['85', '75', '65'])
    expect(runs[0]).toMatch(/^-Z 1280 /) // fitted inside 720x1280, never upscaled

    const first = await sipsRun({ '85': 300_000, '75': 1, '65': 1 })
    expect(first.result).toMatchObject({ ok: true, quality: 85 })
    expect(first.runs).toHaveLength(1)
  })

  it('sips: still over the cap at 65 is still-too-large, never a lower quality', async () => {
    const { result, runs } = await sipsRun({ '85': 900_000, '75': 800_000, '65': 700_000 })
    expect(result).toMatchObject({ ok: false, kind: 'still-too-large' })
    expect(runs).toHaveLength(3)
  })
})

/** A python3 that can decode an image at all — Pillow or OpenCV. */
const py = spawnSync('python3', ['-c', 'import importlib.util,sys; sys.exit(0 if (importlib.util.find_spec("PIL") or importlib.util.find_spec("cv2")) else 1)'])
const havePython = py.status === 0

/** A 1080x1920 JPEG over 512 KB, made with Pillow (gradient, some noise, a white card). */
function generateFrame(width: number, height: number, quality: number): Buffer {
  const code = [
    'import io, sys',
    'from PIL import Image, ImageDraw',
    `w, h = ${width}, ${height}`,
    "base = Image.linear_gradient('L').resize((w, h)).convert('RGB')",
    "noise = Image.effect_noise((w, h), 40).convert('RGB')",
    'im = Image.blend(base, noise, 0.5)',
    'ImageDraw.Draw(im).rectangle((w // 10, h // 2 - 100, w - w // 10, h // 2 + 100), fill=(255, 255, 255))',
    `b = io.BytesIO(); im.save(b, 'JPEG', quality=${quality}); sys.stdout.buffer.write(b.getvalue())`,
  ].join('\n')
  const r = spawnSync('python3', ['-c', code], { maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`could not generate a test frame: ${r.stderr}`)
  return r.stdout
}
/** Width, height and quantisation tables of a JPEG, as Pillow reads them back. */
function jpegFacts(jpeg: Buffer): { width: number; height: number; quant: number[][] } {
  const code =
    'import io, sys, json\n' +
    'from PIL import Image\n' +
    'im = Image.open(io.BytesIO(sys.stdin.buffer.read()))\n' +
    'q = im.quantization\n' +
    'print(json.dumps({"width": im.size[0], "height": im.size[1], "quant": [list(q[k]) for k in sorted(q)]}))'
  const r = spawnSync('python3', ['-c', code], { input: jpeg })
  if (r.status !== 0) throw new Error(`could not read the JPEG back: ${r.stderr}`)
  return JSON.parse(String(r.stdout)) as { width: number; height: number; quant: number[][] }
}
function dimensions(jpeg: Buffer): { width: number; height: number } {
  const { width, height } = jpegFacts(jpeg)
  return { width, height }
}
/**
 * The quantisation tables libjpeg's quality scaling produces at `quality` — read off a tiny reference
 * image Pillow encodes here. They depend on the quality setting alone, not on the picture.
 */
function referenceQuant(quality: number): number[][] {
  const r = spawnSync('python3', ['-c', `import io,sys; from PIL import Image; b=io.BytesIO(); Image.new('RGB',(16,16),(120,60,30)).save(b,'JPEG',quality=${quality}); sys.stdout.buffer.write(b.getvalue())`])
  if (r.status !== 0) throw new Error(`could not encode a reference JPEG: ${r.stderr}`)
  return jpegFacts(r.stdout).quant
}
// Pillow specifically: the generator and the read-back use it, whichever engine the script picks.
const havePil = havePython && spawnSync('python3', ['-c', 'import PIL']).status === 0

/**
 * A 1080x1920 frame of uniform random noise (seeded, so every run is the same picture), encoded at
 * quality 95 — the hardest input a JPEG encoder meets. MEASURED here, through scripts/frame-shrink.py
 * under Pillow 12.3.0 (`--max-bytes 1` prints every quality it tried): fitted to 720x1280 it is 565,435
 * bytes at 85, 431,505 at 75, 363,082 at 65 — 41 KB over the cap at 85 and 93 KB under it at 75 (one
 * seed, one Pillow version; another libjpeg build can move these).
 */
function noiseFrame(): Buffer {
  const code = [
    'import io, sys, random',
    'from PIL import Image',
    'w, h = 1080, 1920',
    "im = Image.frombytes('RGB', (w, h), random.Random(7).randbytes(w * h * 3))",
    "b = io.BytesIO(); im.save(b, 'JPEG', quality=95); sys.stdout.buffer.write(b.getvalue())",
  ].join('\n')
  const r = spawnSync('python3', ['-c', code], { maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`could not generate a noise frame: ${r.stderr}`)
  return r.stdout
}
/** The script's last STDERR line, parsed. */
const lastJson = (stderr: Buffer) => JSON.parse(String(stderr).trim().split('\n').pop() ?? '{}') as Record<string, unknown>

describe.skipIf(!havePil)('scripts/frame-shrink.py, run for real under python3 (Pillow path here)', () => {
  const shrink = (input: Buffer) => {
    const r = spawnSync('python3', [SCRIPT], { input, maxBuffer: 8 * 1024 * 1024 })
    expect(r.status, String(r.stderr)).toBe(0)
    expect(media.imageKind(r.stdout)).toBe('jpeg')
    return r.stdout
  }

  it('shrinks an over-size 1080x1920 JPEG to exactly 720x1280, at JPEG quality 85', () => {
    const input = generateFrame(1080, 1920, 95)
    expect(input.length).toBeGreaterThan(media.MAX_FRAME_BYTES)
    const out = jpegFacts(shrink(input))
    expect({ width: out.width, height: out.height }).toEqual({ width: 720, height: 1280 })
    expect(out.quant).toEqual(referenceQuant(85))
    expect(out.quant).not.toEqual(referenceQuant(95)) // the tables tell qualities apart at all
  })

  it('keeps a 4:5 frame 4:5 (1080x1350 → 720x900) — a stretch to the box would not', () => {
    expect(dimensions(shrink(generateFrame(1080, 1350, 95)))).toEqual({ width: 720, height: 900 })
  })

  it('keeps a landscape frame landscape (1440x1080 → 720x540)', () => {
    expect(dimensions(shrink(generateFrame(1440, 1080, 95)))).toEqual({ width: 720, height: 540 })
  })

  it('never upscales a frame already inside the box', () => {
    expect(dimensions(shrink(generateFrame(400, 300, 90)))).toEqual({ width: 400, height: 300 })
  })

  it('an undecodable input exits non-zero with NOTHING on stdout and a JSON error on stderr', () => {
    const r = spawnSync('python3', [SCRIPT], { input: withHead(MP4, 4096) })
    expect(r.status).not.toBe(0)
    expect(r.stdout.length).toBe(0)
    expect(JSON.parse(String(r.stderr)).error).toMatch(/cannot decode/)
  })

  it('a noise frame over the cap at 85 steps down and comes out under 512 KB at a quality below 85', () => {
    const input = noiseFrame()
    // The control: with no size target the script writes quality 85, and that is over the cap.
    const plain = spawnSync('python3', [SCRIPT], { input, maxBuffer: 8 * 1024 * 1024 })
    expect(plain.status).toBe(0)
    expect(plain.stdout.length).toBeGreaterThan(media.MAX_FRAME_BYTES)

    const r = spawnSync('python3', [SCRIPT, '--max-bytes', String(media.MAX_FRAME_BYTES)], { input, maxBuffer: 8 * 1024 * 1024 })
    expect(r.status, String(r.stderr)).toBe(0)
    expect(r.stdout.length).toBeLessThanOrEqual(media.MAX_FRAME_BYTES)
    const facts = jpegFacts(r.stdout)
    expect({ width: facts.width, height: facts.height }).toEqual({ width: 720, height: 1280 })
    expect(facts.quant).toEqual(referenceQuant(75))
    expect(facts.quant).not.toEqual(referenceQuant(85))
    expect(lastJson(r.stderr)).toMatchObject({ ok: true, quality: 75, bytes: r.stdout.length })
  })

  it('still over --max-bytes at 65: exit 6, NOTHING on stdout, a still-too-large JSON error — never a lower quality', () => {
    // No real frame stays over 512 KB at 65 after the resize (the noise frame is 363,082 bytes), so the
    // cap is lowered to make this input incompressible relative to it.
    const r = spawnSync('python3', [SCRIPT, '--max-bytes', '200000'], { input: noiseFrame(), maxBuffer: 8 * 1024 * 1024 })
    expect(r.status).toBe(6)
    expect(r.stdout.length).toBe(0)
    const err = lastJson(r.stderr)
    expect(err.error).toBe('still-too-large')
    expect((err.tried as number[][]).map((t) => t[0])).toEqual([85, 75, 65])
  })

  it('a 16-megapixel image is refused from its header — over the 12 MP cap, nothing decoded, nothing on stdout', () => {
    const png = spawnSync('python3', ['-c', "import io,sys; from PIL import Image; b=io.BytesIO(); Image.new('1',(4000,4000)).save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())"], {
      maxBuffer: 8 * 1024 * 1024,
    })
    expect(png.status).toBe(0)
    const r = spawnSync('python3', [SCRIPT], { input: png.stdout })
    expect(r.status).not.toBe(0)
    expect(r.stdout.length).toBe(0)
    expect(String(lastJson(r.stderr).error)).toMatch(/4000x4000, over the 12000000-pixel cap/)
  })

  it('end to end through saveFrame: a noise frame is saved under the cap at the stepped-down quality, and the log line says which', async () => {
    served = { body: noiseFrame() }
    media.setFrameShrinkerForTests((input) => media.shrinkFrameBytes(input, { engine: 'python', command: 'python3', script: SCRIPT }))
    const report = await media.saveFrameReport('DcNoiseRun', 'https://cdn.example/nz.jpg')
    expect(report.outcome).toBe('saved')
    expect(report.shrunk?.quality).toBe(75)
    const saved = frameOnDisk('DcNoiseRun')!
    expect(saved.length).toBeLessThanOrEqual(media.MAX_FRAME_BYTES)
    expect(jpegFacts(saved).quant).toEqual(referenceQuant(75))
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('frame shrunk to fit the cap and saved'))
    expect(line).toMatch(/quality=75/)
  })

  it('end to end through saveFrame: the real runner, with the arguments media.ts passes, saves a 720x1280 quality-85 JPEG under the cap', async () => {
    served = { body: generateFrame(1080, 1920, 95) }
    media.setFrameShrinkerForTests((input) => media.shrinkFrameBytes(input, { engine: 'python', command: 'python3', script: SCRIPT }))
    const report = await media.saveFrameReport('DcRealRun1', 'https://cdn.example/r.jpg')
    expect(report.outcome).toBe('saved')
    expect(report.shrunk?.fromBytes).toBe(served.body.length)
    const saved = frameOnDisk('DcRealRun1')!
    expect(saved.length).toBeLessThanOrEqual(media.MAX_FRAME_BYTES)
    expect(media.imageKind(saved)).toBe('jpeg')
    const facts = jpegFacts(saved)
    expect({ width: facts.width, height: facts.height }).toEqual({ width: 720, height: 1280 })
    expect(facts.quant).toEqual(referenceQuant(85))
    expect(report.shrunk?.quality).toBe(85)
  })
})
