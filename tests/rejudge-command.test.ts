import { describe, expect, it } from 'vitest'
import { runRejudge, rejudgeStopRunStartLine, parseRejudgeArgs, REJUDGE_FULL_SCAN } from '@/detection/rejudgeCommand'
import type { RejudgeOptions, RejudgeSummary } from '@/detection/rejudge'
import { workerRunningHere, type SchedulerHeartbeat } from '@/worker/heartbeat'

/**
 * `pnpm ig:rejudge` refuses to judge beside a worker running on this host (review, 16 Oct 2026).
 *
 * WHY: every post a re-judge looks at is an OCR read plus one or two classifier calls, the worker's
 * own pass does the same work on the same newest posts, and the box has 961 MB (CLAUDE.md rule 16:
 * one OCR child at a time). The first version of docs/DEPLOY.md told a person to run it with the
 * worker up, and nothing stopped them.
 *
 * Driven through `runRejudge` with the heartbeat, the clock, the pid check and the re-judge itself
 * injected — so the refusal is asserted by what was CALLED (the judge never is), not by a source grep.
 *
 * MUTATION (applied once, seen red, restored from a scratch copy): deleting the `if (worker) return
 * refuse(…)` branch in src/detection/rejudgeCommand.ts fails "refuses beside a worker running on this
 * host…" (both modes) and "a worker that names no machine…".
 */

const NOW = Date.parse('2026-10-16T08:00:00Z')
const HERE = 'linode-detect'
const beat = (over: Partial<SchedulerHeartbeat> = {}): SchedulerHeartbeat => ({
  pid: 4242,
  host: 'worker',
  at: new Date(NOW - 30_000).toISOString(),
  machine: HERE,
  ...over,
})

const summary = (over: Partial<RejudgeSummary> = {}): RejudgeSummary => ({
  examined: 0,
  changed: 0,
  remaining: 0,
  skippedNoEvidence: 0,
  skippedCallFailed: 0,
  skippedFrameHereNoVerdict: 0,
  skippedHumanAnswered: 0,
  skippedRowRemoved: 0,
  skippedWriteUnmatched: 0,
  recoveredFrames: 0,
  recoverableNotReached: 0,
  recoveryScanComplete: true,
  proposals: [],
  ...over,
})

async function drive(argv: string[], hb: SchedulerHeartbeat | null | Error, alive = true, result = summary()) {
  const out: string[] = []
  const asked: RejudgeOptions[] = []
  let counted = 0
  const code = await runRejudge(argv, {
    out: (l) => out.push(l),
    now: () => NOW,
    machine: () => HERE,
    alive: () => alive,
    readHeartbeat: async () => {
      if (hb instanceof Error) throw hb
      return hb
    },
    rejudge: async (opts) => {
      asked.push(opts)
      return result
    },
    backlog: async () => {
      counted++
      return { failedCalls: 3, recoverableHere: 41, scanComplete: true }
    },
  })
  return { code, out, asked, counted, text: out.join('\n') }
}

describe('ig:rejudge refuses to judge beside a worker running on this host', () => {
  it('refuses beside a worker running on this host — --run AND the dry run, which costs the same', async () => {
    for (const argv of [['--run'], []]) {
      const r = await drive(argv, beat())
      expect(r.code).toBe(2)
      expect(r.asked).toEqual([]) // the judge was never asked
      expect(r.text).toMatch(/The detection worker is running on this host \(pid 4242, last heartbeat 30s ago\)/)
      expect(r.text).toMatch(/Nothing was judged and nothing was written/)
      // What is waiting is still said — counted without judging.
      expect(r.counted).toBe(1)
      expect(r.text).toMatch(/Waiting: 3 post\(s\) carrying frame:call-failed or frame:ocr-failed; 41 judged with no frame/)
      // And the detached line for exactly what was asked.
      expect(r.out).toContain(rejudgeStopRunStartLine({ run: argv.includes('--run'), limit: 200 }))
    }
  })

  it('a worker that names no machine is refused on freshness alone', async () => {
    const r = await drive(['--run'], beat({ machine: undefined }), false)
    expect(r.code).toBe(2)
    expect(r.asked).toEqual([])
    expect(r.text).toMatch(/names no machine beat 30s ago \(pid 4242\)/)
  })

  it('a heartbeat that cannot be read is a refusal, never a permission', async () => {
    const r = await drive(['--run'], new Error('connect ECONNREFUSED 127.0.0.1:5432'))
    expect(r.code).toBe(2)
    expect(r.asked).toEqual([])
    expect(r.text).toMatch(/heartbeat could not be read \(connect ECONNREFUSED/)
  })

  it('runs when the beat is another machine’s, stale, absent, or its pid is dead — scanning the whole population', async () => {
    const cases: [SchedulerHeartbeat | null, boolean][] = [
      [beat({ machine: 'tabish-mac' }), true],
      [beat({ at: new Date(NOW - 4 * 60_000).toISOString() }), true],
      [null, true],
      [beat(), false], // `pm2 stop` leaves a fresh beat behind; the dead pid is what says so
    ]
    for (const [hb, alive] of cases) {
      const r = await drive(['--run', '--limit', '50'], hb, alive)
      expect(r.code).toBe(0)
      expect(r.asked).toEqual([{ limit: 50, dryRun: false, recoveryScan: REJUDGE_FULL_SCAN }])
    }
    const dry = await drive([], null)
    expect(dry.asked).toEqual([{ limit: 200, dryRun: true, recoveryScan: REJUDGE_FULL_SCAN }])
    expect(dry.text).toMatch(/DRY RUN\. Nothing was written/)
  })

  it('says how many recoverable posts it did not reach, and that the pass will not reach older ones', async () => {
    const r = await drive(['--run'], null, true, summary({ examined: 200, recoveredFrames: 200, recoverableNotReached: 730 }))
    expect(r.text).toMatch(/730 more post\(s\) judged with no frame have their frame on this machine and were not reached/)
    expect(r.text).toMatch(/repeat this run until this line is gone/)
    const floor = await drive([], null, true, summary({ recoverableNotReached: 5, recoveryScanComplete: false }))
    expect(floor.text).toMatch(/At least 5 more/)
    const none = await drive(['--run'], null, true, summary())
    expect(none.text).not.toMatch(/not reached/)
  })

  /**
   * A RECOVERED row is selected because its frame IS on this machine (rejudge.ts `hasFrame`), so when
   * its reading or its classifier call produces no verdict it must not be told the frame is elsewhere
   * (review, 16 Oct 2026). MUTATION (applied once, seen red, restored): folding
   * `skippedFrameHereNoVerdict` into the "not on THIS machine" line in rejudgeCommand.ts fails this.
   */
  it('a recovered row that produced no verdict is never told its frame is elsewhere; a person’s answer is reported as standing', async () => {
    const r = await drive(['--run'], null, true, summary({ examined: 3, recoveredFrames: 2, skippedFrameHereNoVerdict: 2, skippedHumanAnswered: 1 }))
    expect(r.text).toMatch(/2 left alone — frame on disk here, but the reading or the classifier produced no verdict — retried next pass\./)
    expect(r.text).toMatch(/1 not written — a person answered the post on the dashboard while it was being judged; their answer stands\./)
    expect(r.text).not.toMatch(/not on THIS machine/)
    // The old sentence is still there for the rows it is true of.
    const elsewhere = await drive(['--run'], null, true, summary({ examined: 4, skippedNoEvidence: 4 }))
    expect(elsewhere.text).toMatch(/4 left alone — the frame is not on THIS machine/)
    expect(elsewhere.text).not.toMatch(/frame on disk here/)
  })

  /** `count: 0` is not always a person (rejudge.ts `skippedRowRemoved`): each cause gets its own sentence. */
  it('a post removed mid-judgement, and a write that matched nothing, are never reported as a person’s answer', async () => {
    const r = await drive(['--run'], null, true, summary({ examined: 3, skippedRowRemoved: 2, skippedWriteUnmatched: 1 }))
    expect(r.text).toMatch(/2 not written — the post was removed while it was being judged\./)
    expect(r.text).toMatch(/1 not written — the write matched no row, and the post now reads unlabelled; it is offered again next pass\./)
    expect(r.text).not.toMatch(/a person answered/)
  })

  it('a --limit that is not a positive whole number is refused before anything is read', async () => {
    for (const bad of ['0', '-3', '1.5', 'many']) expect(parseRejudgeArgs(['--limit', bad])).toHaveProperty('refused')
    const r = await drive(['--limit', 'x'], beat())
    expect(r.code).toBe(1)
    expect(r.asked).toEqual([])
  })

  it('the detached line stops the worker by name, and starts it again however the run ends', () => {
    expect(rejudgeStopRunStartLine({ run: true, limit: 500 })).toBe(
      "setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:rejudge --run --limit 500; pm2 start ds-sales-worker' > /tmp/ig-rejudge.log 2>&1 < /dev/null & tail -F /tmp/ig-rejudge.log",
    )
  })
})

describe('workerRunningHere — the one check ig:backfill and ig:rejudge share', () => {
  const ask = (hb: SchedulerHeartbeat | null, alive = true) => workerRunningHere({ beat: hb, nowMs: NOW, machine: HERE, alive: () => alive })
  it('yes for a fresh beat naming this machine with a live pid; unnamed for a fresh beat naming none', () => {
    expect(ask(beat())).toEqual({ kind: 'running', pid: 4242, ago: '30s ago' })
    expect(ask(beat({ machine: undefined }), false)).toEqual({ kind: 'unnamed', pid: 4242, ago: '30s ago' })
  })
  it('no for another machine, a stale beat, no beat, or a dead pid', () => {
    expect(ask(beat({ machine: 'tabish-mac' }))).toBeNull()
    expect(ask(beat({ at: new Date(NOW - 3 * 60_000).toISOString() }))).toBeNull()
    expect(ask(null)).toBeNull()
    expect(ask(beat(), false)).toBeNull()
  })
})
