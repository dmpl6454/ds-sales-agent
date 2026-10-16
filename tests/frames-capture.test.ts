import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `pnpm ig:frames --capture` REFUSES BESIDE A WORKER RUNNING ON THIS HOST (review, 16 Oct 2026).
 *
 * WHY: every over-size frame it fetches is a Python + OpenCV shrink child, it has no per-run bound, and
 * beside the worker on the 961 MB box that is a second such child next to the worker's own OCR and shrink
 * children (CLAUDE.md rule 16). `ig:rejudge` and `ig:backfill --run` already refused; this did not.
 *
 * Driven three ways: the pure decision (`framesCaptureRefusal`, media.ts); the printed line held
 * byte-identical to docs/DEPLOY.md's frames line; and src/scripts/frames.ts ITSELF, imported with its
 * database, heartbeat and frame saver mocked — it runs its query at import time, so the script is
 * evaluated once per case — asserting by what was CALLED: beside a worker `saveFrameReport` never is, and
 * the dry run never even reads the heartbeat.
 *
 * MUTATION (applied once, seen red, restored from a scratch copy): deleting the refusal block in
 * src/scripts/frames.ts fails "--capture beside a worker running on this host…" and "an unreadable
 * heartbeat refuses too".
 */

const ROOT = resolve(__dirname, '..')
const NOW = Date.now()
const HERE = 'linode-detect'

const state = vi.hoisted(() => ({
  beat: null as null | { pid: number; host: string; at: string; machine?: string },
  beatError: null as null | Error,
  beatReads: 0,
  saves: [] as string[],
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: {
      findMany: async () => [
        { shortcode: 'DcWithUrl01', rawPayload: JSON.stringify({ thumbnailUrl: 'https://cdn.example/a.jpg' }), target: { handle: 'viralbhayani' } },
        { shortcode: 'DcWithUrl02', rawPayload: JSON.stringify({ thumbnailUrl: 'https://cdn.example/b.jpg', evidenceIncomplete: true }), target: { handle: 'viralbhayani' } },
        { shortcode: 'DcNoUrl0001', rawPayload: null, target: { handle: 'viralbhayani' } },
      ],
    },
  },
}))
vi.mock('@/worker/heartbeat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/worker/heartbeat')>()
  return {
    ...actual,
    machineId: () => HERE,
    pidAliveHere: () => true,
    readSchedulerHeartbeat: async () => {
      state.beatReads++
      if (state.beatError) throw state.beatError
      return state.beat
    },
  }
})
vi.mock('@/detection/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/media')>()
  return {
    ...actual,
    hasFrame: async () => false,
    saveFrameReport: async (shortcode: string) => {
      state.saves.push(shortcode)
      return { outcome: 'saved' as const, shrunk: null, failure: null, why: null }
    },
  }
})

const media = await import('@/detection/media')

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}
const savedArgv = process.argv
const log = vi.spyOn(console, 'log').mockImplementation(() => {})
const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Exited(code ?? 0)
}) as never)

afterAll(() => {
  process.argv = savedArgv
  log.mockRestore()
  exit.mockRestore()
})

beforeEach(() => {
  state.beat = null
  state.beatError = null
  state.beatReads = 0
  state.saves = []
  log.mockClear()
})

/** Evaluate src/scripts/frames.ts once with these arguments; its exit code and what it printed. */
async function runFrames(args: string[]): Promise<{ code: number; text: string }> {
  process.argv = [savedArgv[0]!, 'src/scripts/frames.ts', ...args]
  vi.resetModules()
  let code = -1
  try {
    await import('@/scripts/frames')
  } catch (err) {
    if (!(err instanceof Exited)) throw err
    code = err.code
  } finally {
    process.argv = savedArgv
  }
  return { code, text: log.mock.calls.map((c) => c.join(' ')).join('\n') }
}

const running = () => ({ pid: 4242, host: 'worker', at: new Date(NOW - 30_000).toISOString(), machine: HERE })

describe('framesCaptureRefusal — the decision and its words (PURE)', () => {
  it('no worker on this host: null, so --capture runs', () => {
    expect(media.framesCaptureRefusal({ worker: null })).toBeNull()
  })

  it('a worker running here: names its pid, says nothing was done, and hands back the detached line', () => {
    const lines = media.framesCaptureRefusal({ worker: { kind: 'running', pid: 4242, ago: '30s ago' } })!
    expect(lines[0]).toMatch(/The detection worker is running on this host \(pid 4242, last heartbeat 30s ago\)\..*Python \+ OpenCV shrink child.*Refusing\./)
    expect(lines).toContain('Nothing was downloaded and nothing was written. Run this instead, as one line:')
    expect(lines).toContain(media.framesCaptureStopRunStartLine())
    expect(lines.at(-1)).toBe(media.FRAMES_CAPTURE_DETACHED_NOTE)
  })

  it('a worker that names no machine, and an unreadable heartbeat, refuse too — the conservative direction', () => {
    expect(media.framesCaptureRefusal({ worker: { kind: 'unnamed', pid: 7, ago: '5s ago' } })![0]).toMatch(/names no machine beat 5s ago \(pid 7\)/)
    expect(media.framesCaptureRefusal({ heartbeatError: 'connection refused' })![0]).toBe(
      'Refusing: the scheduler heartbeat could not be read (connection refused), so a worker running on this host cannot be ruled out.',
    )
  })

  it('the line is docs/DEPLOY.md\'s frames line exactly, less its `cd`', () => {
    expect(media.framesCaptureStopRunStartLine()).toBe(
      "setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:frames --capture; pm2 start ds-sales-worker' > /tmp/ig-frames.log 2>&1 < /dev/null & tail -F /tmp/ig-frames.log",
    )
    const deploy = readFileSync(join(ROOT, 'docs', 'DEPLOY.md'), 'utf8').split('\n')
    expect(deploy).toContain(`cd /opt/ds-sales-agent && ${media.framesCaptureStopRunStartLine()}`)
  })
})

describe('src/scripts/frames.ts, evaluated for real with its database and heartbeat mocked', () => {
  it('--capture beside a worker running on this host prints the counts, refuses, and saves nothing', async () => {
    state.beat = running()
    const r = await runFrames(['--capture'])
    expect(r.code).toBe(2)
    expect(state.beatReads).toBe(1)
    expect(state.saves).toEqual([])
    expect(r.text).toMatch(/3 posts since the detection cutoff/) // the counts come first
    expect(r.text).toMatch(/The detection worker is running on this host \(pid 4242/)
    expect(r.text).toContain(media.framesCaptureStopRunStartLine())
  })

  it('an unreadable heartbeat refuses too', async () => {
    state.beatError = new Error('Can\'t reach database server')
    const r = await runFrames(['--capture'])
    expect(r.code).toBe(2)
    expect(state.saves).toEqual([])
    expect(r.text).toMatch(/the scheduler heartbeat could not be read \(Can't reach database server\)/)
  })

  it('--capture with no worker here (another machine\'s beat) captures every frame that has a URL', async () => {
    state.beat = { ...running(), machine: 'tabish-mac' }
    const r = await runFrames(['--capture'])
    expect(r.code).toBe(0)
    expect(state.saves).toEqual(['DcWithUrl01', 'DcWithUrl02'])
    expect(r.text).toMatch(/Saved 2 frames/)
  })

  it('the dry run still runs beside the worker — it only counts, never reads the heartbeat, saves nothing', async () => {
    state.beat = running()
    const r = await runFrames([])
    expect(r.code).toBe(0)
    expect(state.beatReads).toBe(0)
    expect(state.saves).toEqual([])
    expect(r.text).toMatch(/--capture downloads the 2 recoverable frames/)
  })
})
