import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A COVER FRAME IS WRITTEN TO A TEMP NAME AND RENAMED — so a half-written one never exists under the
 * real name (review, 16 Oct 2026).
 *
 * WHY: `saveFrame` wrote straight to `<shortcode>.jpg`, and `hasFrame` asks only whether that file
 * EXISTS. A full disk or a crash mid-write left a truncated `.jpg` that counted as saved for good — never
 * re-fetched — and that the recovery pass (rejudge.ts) offered to an OCR read every pass. Now the bytes go
 * to `<shortcode>.jpg.tmp-<pid>-<random>` in the same directory, are renamed only once whole, and any
 * failure unlinks the temp.
 *
 * `node:fs/promises` is wrapped so a write can fail HALF-WAY, the way a full disk does: the first half of
 * the bytes really reaches the file, then the call throws ENOSPC. Everything else is the real filesystem,
 * in a temporary HOME.
 *
 * MUTATION (applied once, seen red, restored from a scratch copy): writing straight to `path` again in
 * media.ts (`await writeFile(path, bytes)` in place of the temp-and-rename) fails "a write that fails
 * half-way leaves neither the frame nor a temp" (a truncated `.jpg` is left behind), "a rename that fails
 * leaves neither…" (there is no rename to fail, so the `.jpg` is written) and "a success leaves exactly
 * the .jpg…" (no temp name is ever written).
 */

const fsCtl = vi.hoisted(() => ({ failWrite: false, failRename: false, writes: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const inFrameStore = (p: unknown) => String(p).includes('.ds-sales-agent-data')
  const wrapped = {
    ...actual,
    async writeFile(path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], ...rest: unknown[]) {
      if (inFrameStore(path)) fsCtl.writes.push(String(path))
      if (fsCtl.failWrite && inFrameStore(path)) {
        const bytes = Buffer.from(data as Uint8Array)
        await actual.writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)))
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, data, ...rest)
    },
    async rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
      if (fsCtl.failRename && inFrameStore(to)) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
      return actual.rename(from, to)
    },
  }
  return { ...wrapped, default: wrapped }
})

const home = mkdtempSync(join(tmpdir(), 'ds-frame-atomic-'))
const savedHome = process.env.HOME
process.env.HOME = home // paths.ts reads homedir() at import time

const media = await import('@/detection/media')
const { FRAMES_DIR } = await import('@/lib/paths')

const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const frame = (size: number) => {
  const b = Buffer.alloc(size, 0x41)
  Buffer.from(JPEG).copy(b)
  return b
}
const listing = () => (existsSync(FRAMES_DIR) ? readdirSync(FRAMES_DIR).sort() : [])

vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'log').mockImplementation(() => {})

let served = frame(47_400)
beforeEach(() => {
  rmSync(FRAMES_DIR, { recursive: true, force: true })
  fsCtl.failWrite = false
  fsCtl.failRename = false
  fsCtl.writes = []
  served = frame(47_400)
  media.resetFrameMemoriesForTests()
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(served), { status: 200 }))
})
afterAll(() => {
  vi.unstubAllGlobals()
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('a frame is written whole or not at all', () => {
  it('a success leaves exactly the .jpg, written by way of a temp name in the same directory', async () => {
    expect(await media.saveFrame('DcAtomic01', 'https://cdn.example/a.jpg')).toBe('saved')
    expect(listing()).toEqual(['DcAtomic01.jpg'])
    expect(readFileSync(join(FRAMES_DIR, 'DcAtomic01.jpg')).equals(served)).toBe(true)
    expect(fsCtl.writes).toHaveLength(1)
    expect(fsCtl.writes[0]).toMatch(/DcAtomic01\.jpg\.tmp-\d+-[0-9a-f]+$/)
    expect(dirname(fsCtl.writes[0]!)).toBe(FRAMES_DIR)
  })

  it('a write that fails half-way leaves neither the frame nor a temp — and the next pass fetches it again', async () => {
    fsCtl.failWrite = true
    const report = await media.saveFrameReport('DcAtomic02', 'https://cdn.example/b.jpg')
    expect(report).toMatchObject({ outcome: 'failed', failure: 'write-failed' })
    expect(report.why).toMatch(/ENOSPC/)
    expect(listing()).toEqual([])
    expect(await media.hasFrame('DcAtomic02')).toBe(false)
    // Not a frame "saved forever": the disk recovers, the next attempt writes it whole.
    fsCtl.failWrite = false
    expect(await media.saveFrame('DcAtomic02', 'https://cdn.example/b.jpg')).toBe('saved')
    expect(listing()).toEqual(['DcAtomic02.jpg'])
  })

  it('a rename that fails leaves neither the frame nor a temp', async () => {
    fsCtl.failRename = true
    expect((await media.saveFrameReport('DcAtomic03', 'https://cdn.example/c.jpg')).failure).toBe('write-failed')
    expect(listing()).toEqual([])
  })

  it('a stray temp — a process killed between the write and the rename — is invisible to every reader', async () => {
    mkdirSync(FRAMES_DIR, { recursive: true })
    const stray = media.frameTempPathFor(media.framePathFor('DcStray001')!, 999, 'abc123')
    writeFileSync(stray, frame(1000).subarray(0, 300))
    expect(await media.hasFrame('DcStray001')).toBe(false)
    expect(await media.loadFrame('DcStray001')).toBeNull()
    // So the frame is fetched and saved as if the stray were not there. The stray itself is left —
    // nothing sweeps it (stated in media.ts, `FRAME_TEMP_MARK`).
    expect(await media.saveFrame('DcStray001', 'https://cdn.example/s.jpg')).toBe('saved')
    expect(listing()).toEqual(['DcStray001.jpg', 'DcStray001.jpg.tmp-999-abc123'])
  })

  it('frameTempPathFor: the same directory, the mark, never the frame name itself', () => {
    const path = media.framePathFor('DcNamed001')!
    const temp = media.frameTempPathFor(path)
    expect(dirname(temp)).toBe(dirname(path))
    expect(temp.startsWith(`${path}${media.FRAME_TEMP_MARK}`)).toBe(true)
    expect(temp).not.toBe(path)
    expect(media.frameTempPathFor(path)).not.toBe(temp) // random per call: two writers never share one
  })
})
