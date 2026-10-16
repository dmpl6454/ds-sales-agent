import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `pnpm ig:backfill` (src/detection/backfill.ts, 16 Oct 2026) — read a blind stretch back through the
 * official read. What carries the weight, each mutation applied by hand, seen red, and restored:
 *
 *   1. `--hours` IS REQUIRED and is a whole number 1..168, refused with a sentence otherwise.
 *   2. NO CONFIGURATION, NO READ: without META_GRAPH_TOKEN + META_IG_USER_ID it refuses (exit 2) in one
 *      sentence naming both, before any request — dry run and --run alike.
 *   3. THE DRY RUN WRITES NOTHING, against a real database: no DetectedCampaign row, no Setting row (no
 *      feed-answer evidence, no anonymous gate), no anonymous request, and the pass is never called.
 *      MUTATION: removing `record: false` from the dry run's `fetchFeedViaGraph` call fails "reports per
 *      channel … and writes nothing at all" on its own (the evidence row appears), beside the grep. And STRUCTURALLY: backfill.ts imports the pass as a
 *      type only and none of the writers; the command line loads the pass only inside `runPass`.
 *      MUTATION: a value import of `./pipeline` in backfill.ts fails "backfill.ts imports the pass as a
 *      TYPE only"; so does a dry run that forgets `record: false`.
 *   4. `--run` REFUSES BESIDE A LIVE WORKER ON THIS HOST and hands back the exact one-line command; a
 *      stale beat, another machine's beat, a dead pid or no beat at all lets it through. The clock,
 *      the heartbeat, this machine's name and the liveness check are all injected — hermetic.
 *      MUTATION: dropping the `!input.alive(beat.pid)` line fails "a dead pid does not block" (the
 *      `pm2 stop` case: the beat is still fresh); dropping the machine comparison fails "another
 *      machine's heartbeat does not block".
 *   5. NO SILENT CAPS: every channel `--run` did not take back the full N hours is named with why, and
 *      split into what a re-run can finish (with the exact `--channel` line) and what it cannot.
 *   6. (review, 16 Oct 2026) THE LINE IS DETACHED: `setsid sh -c '…stop && run; start'`, so a dropped
 *      console cannot kill the run and leave the worker stopped. A fresh beat naming NO machine refuses
 *      on freshness alone, as `startScheduler` does. `--channel` finishes a capped run.
 *
 * No network: every official request goes through `setIgTransportForTests`; an anonymous one throws.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-backfill-'))
const dbPath = join(dir, 'backfill.db')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "TargetAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "role" TEXT NOT NULL DEFAULT 'PROSPECT',
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
    "isVerified" BOOLEAN,
    "followerCount" INTEGER,
    "campaignTalent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");
  CREATE TABLE "DetectedCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caption" TEXT NOT NULL,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "mediaType" TEXT,
    "brands" TEXT NOT NULL DEFAULT '[]',
    "signals" TEXT NOT NULL DEFAULT '[]',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL,
    "humanLabel" BOOLEAN,
    "labelledBy" TEXT,
    "labelledAt" DATETIME,
    "verdictSource" TEXT NOT NULL DEFAULT 'none',
    "classifierModel" TEXT,
    "classifierReason" TEXT,
    "taggedAccounts" TEXT NOT NULL DEFAULT '[]',
    "rawPayload" TEXT,
    "frameText" TEXT,
    CONSTRAINT "DetectedCampaign_targetId_fkey" FOREIGN KEY ("targetId")
      REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX "DetectedCampaign_shortcode_key" ON "DetectedCampaign"("shortcode");
`)
bootstrap.close()
process.env.DATABASE_URL = `file:${dbPath}`
const savedDevice = process.env.DS_DEVICE_NAME
process.env.DS_DEVICE_NAME = 'linode-detect'

const { prisma } = await import('@/lib/db')
const b = await import('@/detection/backfill')
const { channelSummaryLine, frameShrinkLine, passSummaryLine } = await import('@/detection/detectionReport')
const g = await import('@/detection/graphFeed')
const { resetAnonGate } = await import('@/detection/anonGate')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
const fe = await import('@/detection/feedEvidence')
type DetectionSummary = import('@/detection/pipeline').DetectionSummary
type ChannelOutcome = import('@/detection/pipeline').ChannelOutcome
type SchedulerHeartbeat = import('@/worker/heartbeat').SchedulerHeartbeat

afterAll(async () => {
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

const NOW = Date.parse('2026-10-16T01:30:00Z')
const nowS = Math.floor(NOW / 1000)
const H = 3600
const TOKEN = 'tok_SECRET_backfill_7'
const configure = () => {
  vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
  vi.stubEnv('META_IG_USER_ID', '17841400000000999')
}

type Answer = { status: number; body: string }
type Call = { host: 'anonymous' | 'graph'; handle: string; after: string | null }
let calls: Call[] = []
let graphAnswer: (handle: string, after: string | null) => Answer = () => ({ status: 500, body: '' })
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', '+0000')
/** One Business Discovery page: posts `hoursAgo` before NOW, codes `<prefix><i>`. */
const page = (handle: string, items: Array<[string, number]>, after: string | null): Answer => ({
  status: 200,
  body: JSON.stringify({
    business_discovery: {
      username: handle,
      media: {
        data: items.map(([code, h]) => ({ id: code, caption: 'g', timestamp: iso(nowS - h * H), permalink: `https://www.instagram.com/p/${code}/`, media_type: 'IMAGE' })),
        paging: { cursors: after ? { after } : {} },
      },
    },
  }),
})

const noSleep = vi.fn(async (_ms: number) => {})
const noPass = vi.fn(async (_hours: number): Promise<DetectionSummary> => {
  throw new Error('the pass must not be called here')
})

beforeEach(async () => {
  await fe.feedAnswersSettled()
  calls = []
  noSleep.mockClear()
  noPass.mockClear()
  resetAnonGate()
  g.resetGraphStateForTests()
  g.setGraphClockForTests(() => NOW)
  fe.resetFeedEvidenceForTests()
  await prisma.detectedCampaign.deleteMany()
  await prisma.targetAccount.deleteMany()
  await prisma.setting.deleteMany()
  setIgTransportForTests(async (url) => {
    if (!url.startsWith('https://graph.facebook.com/')) {
      calls.push({ host: 'anonymous', handle: url, after: null })
      throw new Error('an anonymous request was made')
    }
    const u = decodeURIComponent(url)
    const handle = u.match(/business_discovery\.username\(([^)]+)\)/)![1]!
    const after = u.match(/media\.after\(([^)]+)\)/)?.[1] ?? null
    calls.push({ host: 'graph', handle, after })
    const a = graphAnswer(handle, after)
    return { status: a.status, ok: a.status >= 200 && a.status < 300, contentType: 'application/json', text: async () => a.body, json: async () => JSON.parse(a.body) as unknown } satisfies IgResponse
  })
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined)
  vi.stubEnv('META_GRAPH_TOKEN', '')
  vi.stubEnv('META_IG_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setIgTransportForTests()
  g.setGraphClockForTests()
})

// ── 1. The command line ──────────────────────────────────────────────────────────────────────

describe('parseBackfillArgs (PURE)', () => {
  it('--hours is required, and is a whole number of hours from 1 to 168', () => {
    for (const argv of [[], ['--run'], ['--hours'], ['--hours=']]) {
      const r = b.parseBackfillArgs(argv)
      expect(r.kind).toBe('refused')
      expect((r as { why: string }).why).toMatch(/--hours is required: .*1 to 168/)
    }
    for (const bad of ['0', '169', '1.5', 'abc', '48h', ' 48', '-1', '1e2', '048.0']) {
      const r = b.parseBackfillArgs(['--hours', bad])
      expect(r, bad).toMatchObject({ kind: 'refused' })
      expect((r as { why: string }).why).toMatch(/not a whole number of hours from 1 to 168/)
    }
  })
  it('the forms a person types', () => {
    expect(b.parseBackfillArgs(['--hours', '48'])).toEqual({ kind: 'run', plan: { hours: 48, run: false } })
    expect(b.parseBackfillArgs(['--hours=168', '--run'])).toEqual({ kind: 'run', plan: { hours: 168, run: true } })
    expect(b.parseBackfillArgs(['--run', '--hours', '1'])).toEqual({ kind: 'run', plan: { hours: 1, run: true } })
    expect(b.parseBackfillArgs(['--help']).kind).toBe('help')
    expect(b.parseBackfillArgs(['--hours', '2', '--hours', '3'])).toMatchObject({ kind: 'refused', why: expect.stringMatching(/twice/) })
    expect(b.parseBackfillArgs(['--hours', '2', '--force'])).toMatchObject({ kind: 'refused', why: expect.stringMatching(/--force is not an option/) })
  })
  it('--channel is repeatable, takes an @ or none, dedupes, and refuses what is not a stored handle', () => {
    expect(b.parseBackfillArgs(['--hours', '48', '--channel', 'viralbhayani', '--channel', '@voompla', '--channel=voompla'])).toEqual({
      kind: 'run',
      plan: { hours: 48, run: false, channels: ['viralbhayani', 'voompla'] },
    })
    for (const bad of [['--channel'], ['--channel', 'ViralBhayani'], ['--channel', 'a b'], ['--channel=']]) {
      expect(b.parseBackfillArgs(['--hours', '48', ...bad]), bad.join(' ')).toMatchObject({ kind: 'refused', why: expect.stringMatching(/is not an Instagram handle as stored here/) })
    }
  })
  it('the line to run instead is ONE line, and DETACHED — a dropped console cannot strand the worker', () => {
    const line = b.stopRunStartLine(48)
    expect(line).toBe(
      "setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:backfill --hours 48 --run; pm2 start ds-sales-worker' > /tmp/ig-backfill.log 2>&1 < /dev/null & tail -F /tmp/ig-backfill.log",
    )
    expect(line).not.toMatch(/\n/)
    // The start is after `;`, not `&&`: the worker comes back however the run ends.
    expect(line).toMatch(/--run; pm2 start ds-sales-worker'/)
    expect(b.stopRunStartLine(48, ['viralbhayani', 'voompla'])).toContain('pnpm ig:backfill --hours 48 --channel viralbhayani --channel voompla --run;')
  })
})

// ── 2. No configuration ──────────────────────────────────────────────────────────────────────

describe('without the official read configured', () => {
  it.each([false, true])('refuses in one sentence naming both keys, before any request (run: %s)', async (run) => {
    const out: string[] = []
    const code = await b.runBackfill({ hours: 48, run }, { out: (l) => out.push(l), runPass: noPass, sleep: noSleep, readHeartbeat: async () => null })
    expect(code).toBe(2)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/META_GRAPH_TOKEN and META_IG_USER_ID/)
    expect(calls).toEqual([])
    expect(noPass).not.toHaveBeenCalled()
  })
})

// ── 3. The dry run ───────────────────────────────────────────────────────────────────────────

async function seedChannels() {
  for (const [handle, watch] of [['chan_a', true], ['chan_b', true], ['chan_off', false]] as const) {
    await prisma.targetAccount.create({ data: { id: `t_${handle}`, handle, displayName: handle, kind: 'CHANNEL', role: 'WATCH', watchEnabled: watch } })
  }
  // A prospect, not a watched channel: never read either.
  await prisma.targetAccount.create({ data: { id: 't_brand', handle: 'somebrand', displayName: 'Some Brand', kind: 'BRAND', role: 'PROSPECT' } })
  // One of chan_a's in-window posts is already stored.
  await prisma.detectedCampaign.create({
    data: { targetId: 't_chan_a', shortcode: 'DcA1x', permalink: 'https://www.instagram.com/p/DcA1x/', postedAt: new Date(NOW - 1 * H * 1000), caption: 'stored', verdict: 'CAMPAIGN', rawPayload: '{"kept":true}' },
  })
}

describe('the dry run', () => {
  it('reports per channel, in totals, and the one line to store them — and writes nothing at all', async () => {
    configure()
    await seedChannels()
    graphAnswer = (handle, after) => {
      if (handle === 'chan_b') return page(handle, [['DcB1x', 2]], null)
      // chan_a: 1 h (stored), 10 h, then 30 h, 47.9 h, 48.1 h and 60 h — the last two outside a
      // 48-hour window, one of them only just: the floor is pinned to the minute, not the page.
      return after === 'p2'
        ? page(handle, [['DcA3x', 30], ['DcA5x', 47.9], ['DcA6x', 48.1], ['DcA4x', 60]], 'p3')
        : page(handle, [['DcA1x', 1], ['DcA2x', 10]], 'p2')
    }
    const before = await prisma.detectedCampaign.findMany()
    const out: string[] = []
    const code = await b.runBackfill({ hours: 48, run: false }, { out: (l) => out.push(l), runPass: noPass, now: () => NOW, delayMs: 0, sleep: noSleep })

    expect(code).toBe(0)
    expect(out[0]).toContain(`since ${new Date(NOW - 48 * H * 1000).toISOString()}`)
    expect(out).toContain('  @chan_a: 4 in the window, 3 not stored (2 calls)')
    expect(out).toContain('  @chan_b: 1 in the window, 1 not stored (1 call)')
    expect(out).toContain('2 channels, 5 posts in the window, 4 not stored.')
    expect(out.some((l) => /^3 official calls used of this dry run's cap of 200.*pauses it for 30 minutes/.test(l))).toBe(true)
    // What --run costs, in time with the worker stopped: 4 posts × 7 s ≈ 0.5 min, said as at least a minute.
    expect(out.some((l) => /^--run would store and judge about 4 posts: roughly 1 minute at ~7 s a post, with the worker stopped — detection, drafting and the four slots pause/.test(l))).toBe(true)
    expect(out.at(-2)).toBe(b.stopRunStartLine(48))
    expect(out.at(-1)).toMatch(/runs detached — closing this console does not stop it or leave the worker stopped/)
    // Only the watched channels, and chan_a stopped at the first page older than the window.
    expect(calls).toEqual([
      { host: 'graph', handle: 'chan_a', after: null },
      { host: 'graph', handle: 'chan_a', after: 'p2' },
      { host: 'graph', handle: 'chan_b', after: null },
    ])

    // NOTHING WRITTEN: the rows are as they were, and not one Setting row exists — no feed-answer
    // evidence (the fire-and-forget write is awaited first), no anonymous gate state.
    await fe.feedAnswersSettled()
    expect(await prisma.detectedCampaign.findMany()).toEqual(before)
    expect(await prisma.setting.findMany()).toEqual([])
    expect(noPass).not.toHaveBeenCalled()
    expect(out.join('\n')).not.toContain(TOKEN)
  })

  it('a channel it cannot read, and one the bound cuts short, are named — and the exit code says so', async () => {
    configure()
    await seedChannels()
    graphAnswer = (handle, after) => {
      if (handle === 'chan_a') return { status: 400, body: JSON.stringify({ error: { code: 110, error_subcode: 2207013, message: 'Invalid user id' } }) }
      // chan_b never ends inside the window: 25-post pages, an hour apart, forever.
      const n = after === null ? 0 : Number(after.slice(1))
      return page(handle, Array.from({ length: 25 }, (_, i) => [`DcB${n}_${i}x`, (n * 25 + i) / 60] as [string, number]), `c${n + 1}`)
    }
    const out: string[] = []
    const code = await b.runBackfill({ hours: 168, run: false }, { out: (l) => out.push(l), runPass: noPass, now: () => NOW, delayMs: 0, sleep: noSleep })
    expect(code).toBe(1)
    expect(out.find((l) => l.startsWith('  @chan_a:'))).toMatch(/not read — official API: @chan_a is not a Business or Creator account/)
    expect(out.find((l) => l.startsWith('  @chan_b:'))).toMatch(/cut short: it reached the per-channel bound \(600 posts\) before 168 hours back — --run reads the same 600; the counts are a floor/)
    // Neither is a re-run's to finish: a personal account, and a bound a re-run meets again.
    expect(out).toContain('2 channels cannot be read further by re-running — named above: @chan_a, @chan_b.')
    expect(out.some((l) => /not read to the end/.test(l))).toBe(false)
    expect(calls.filter((c) => c.handle === 'chan_b')).toHaveLength(24)
  })

  /**
   * THE DRY RUN'S CALL CAP (review, 16 Oct 2026): a week across many channels can need more than
   * 200 calls. Nine channels that page forever: eight spend 24 each (their bound, 192), the ninth
   * gets the last 8 and is cut short by the CAP, the tenth is not read at all — and the line that
   * reads just those two is printed. MUTATION (applied by hand, saw red, restored): `if (false)` for
   * the `budget.remaining <= 0` guard fails it; so does any other sentence for the call-cap rows.
   */
  it('the call cap: the channel it cuts short and the ones after it are named, with the line that reads just those', async () => {
    configure()
    const handles = Array.from({ length: 10 }, (_, i) => `chan_${String(i).padStart(2, '0')}`)
    for (const h of handles) await prisma.targetAccount.create({ data: { id: `t_${h}`, handle: h, displayName: h, kind: 'CHANNEL', role: 'WATCH' } })
    graphAnswer = (handle, after) => {
      const n = after === null ? 0 : Number(after.slice(1))
      return page(handle, Array.from({ length: 25 }, (_, i) => [`Dc${handle}_${n}_${i}x`, (n * 25 + i) / 60] as [string, number]), `c${n + 1}`)
    }
    const out: string[] = []
    const code = await b.runBackfill({ hours: 168, run: false }, { out: (l) => out.push(l), runPass: noPass, now: () => NOW, delayMs: 0, sleep: noSleep })
    expect(code).toBe(1)
    expect(calls).toHaveLength(200)
    expect(out.find((l) => l.startsWith('  @chan_08:'))).toMatch(/\(8 calls\) — cut short: the dry run's call cap \(200\) ran out before it reached 168 hours back; the counts are a floor/)
    expect(out.find((l) => l.startsWith('  @chan_09:'))).toBe("  @chan_09: not read — the dry run's call cap (200) was spent before it")
    expect(out).toContain(`2 channels were not read to the end — named above. To read just those (a dry run): pnpm ig:backfill --hours 168 --channel chan_08 --channel chan_09`)
    expect(out).toContain('8 channels cannot be read further by re-running — named above: ' + handles.slice(0, 8).map((h) => `@${h}`).join(', ') + '.')
  }, 30_000)

  it('spaces its channels: one sleep between each, of the given gap', async () => {
    configure()
    await seedChannels()
    graphAnswer = (handle) => page(handle, [[`Dc${handle}S1`, 1]], null)
    await b.runBackfill({ hours: 48, run: false }, { out: () => undefined, runPass: noPass, now: () => NOW, delayMs: 7, sleep: noSleep })
    expect(noSleep.mock.calls).toEqual([[7]]) // chan_a, then chan_b: one gap
  })

  it('--channel reads only the named watched channels; a name that is not one is refused before anything is read', async () => {
    configure()
    await seedChannels()
    graphAnswer = (handle) => page(handle, [[`Dc${handle}K1`, 1]], null)
    const out: string[] = []
    expect(await b.runBackfill({ hours: 48, run: false, channels: ['chan_b'] }, { out: (l) => out.push(l), runPass: noPass, now: () => NOW, delayMs: 0, sleep: noSleep })).toBe(0)
    expect(calls.map((c) => c.handle)).toEqual(['chan_b'])
    expect(out[0]).toMatch(/reading @chan_b back 48 hours/)
    expect(out.at(-2)).toBe(b.stopRunStartLine(48, ['chan_b']))

    calls = []
    const refused: string[] = []
    for (const run of [false, true]) {
      refused.length = 0
      const code = await b.runBackfill({ hours: 48, run, channels: ['chan_b', 'chan_off', 'somebrand'] }, { out: (l) => refused.push(l), runPass: noPass, now: () => NOW, readHeartbeat: async () => null })
      expect(code).toBe(2)
      expect(refused).toEqual(['Refusing: @chan_off, @somebrand are not watched channels here (a CHANNEL target with watching on) — check the handle on /targets.'])
    }
    expect(calls).toEqual([])
    expect(noPass).not.toHaveBeenCalled()
  })
})

describe('the dry-run module never loads the pass or a writer (source)', () => {
  const code = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('backfill.ts imports the pass as a TYPE only, and none of the writers', () => {
    const src = code('src/detection/backfill.ts')
    const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2]! }))
    const valueImports = imports.filter((i) => !i.type).map((i) => i.from).sort()
    expect(valueImports).toEqual(['./detectionReport', './graphFeed', './officialReach', '@/lib/db', '@/worker/heartbeat'].sort())
    expect(imports.filter((i) => i.from === './pipeline').every((i) => i.type)).toBe(true)
    expect(src).not.toMatch(/\bimport\(/) // no dynamic import hiding one either
    expect(src).not.toMatch(/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/)
    expect(src).not.toMatch(/setSetting\(|recordFeedAnswer\(|anonGate\w*\(|saveFrame\(|judgeWithFrame\(|classifyCaption\(/)
    // The one official read in the dry run never records.
    expect(src).toMatch(/fetchFeedViaGraph\(t\.handle, \{[\s\S]*?record: false,[\s\S]*?\}\)/)
  })
  it('the modules it does load write nothing on their own (detectionReport.ts and officialReach.ts are type-only or pure)', () => {
    for (const rel of ['src/detection/detectionReport.ts', 'src/detection/officialReach.ts']) {
      const src = code(rel)
      const valueImports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)].filter((m) => !m[1]).map((m) => m[2])
      expect(valueImports, rel).not.toContain('./pipeline')
      expect(valueImports, rel).not.toContain('@/lib/db')
      expect(src, rel).not.toMatch(/prisma\./)
    }
  })
  it('the command line loads the pass only inside runPass', () => {
    const src = code('src/scripts/backfill.ts')
    expect(src).not.toMatch(/^import [\s\S]*?from '@\/detection\/pipeline'/m)
    const runPass = src.slice(src.indexOf('runPass:'))
    expect(runPass).toMatch(/await import\('@\/detection\/pipeline'\)/)
    expect(runPass).toMatch(/runDetection\(\{ officialBackfillHours: hours, \.\.\.\(channels\.length > 0 \? \{ onlyChannels: channels \} : \{\}\) \}\)/)
  })
  it('--run prints ig:detect’s own lines: both use the one formatter', () => {
    expect(code('src/scripts/detect.ts')).toMatch(/channelSummaryLine\(c\)/)
    expect(code('src/scripts/detect.ts')).toMatch(/passSummaryLine\(s\)/)
  })
})

// ── 4. --run beside a worker ─────────────────────────────────────────────────────────────────

describe('--run refuses beside a live worker on this host, and only then', () => {
  const beat = (over: Partial<SchedulerHeartbeat> = {}): SchedulerHeartbeat => ({
    pid: 4242,
    host: 'worker',
    at: new Date(NOW - 30_000).toISOString(),
    machine: 'linode-detect',
    ...over,
  })
  const summary = (channels: ChannelOutcome[] = []): DetectionSummary => ({
    channels,
    postsSeen: 0,
    newPosts: 0,
    detected: 0,
    hadParseFailure: false,
    hadError: false,
    throttledUntil: null,
    channelsUnread: 0,
    pagesFetched: 0,
    brandsResolved: { looked: 0, decided: 0, skippedUnsure: 0, haltedEarly: false, unreached: 0, backingOff: 0, awaitingRetry: 0 },
    servedBy: { anonymous: 0, graph: 0 },
    officialCalls: { used: 0, cap: 200, dropped: 0 },
  })
  const run = async (b0: SchedulerHeartbeat | null | Error, alive: (pid: number) => boolean) => {
    configure()
    const out: string[] = []
    const pass = vi.fn(async (_h: number, _c: readonly string[]) => summary())
    const asked: number[] = []
    const code = await b.runBackfill(
      { hours: 48, run: true },
      {
        out: (l) => out.push(l),
        runPass: pass,
        now: () => NOW,
        machine: () => 'linode-detect',
        readHeartbeat: async () => {
          if (b0 instanceof Error) throw b0
          return b0
        },
        alive: (pid) => {
          asked.push(pid)
          return alive(pid)
        },
      },
    )
    return { code, out, pass, asked }
  }

  it('a fresh beat naming this machine, whose pid is alive → refused, with the exact one-line command', async () => {
    const r = await run(beat(), () => true)
    expect(r.code).toBe(2)
    expect(r.pass).not.toHaveBeenCalled()
    expect(r.out[0]).toMatch(/^The detection worker is running on this host \(pid 4242, last heartbeat 30s ago\)/)
    expect(r.out.at(-2)).toBe(b.stopRunStartLine(48))
    expect(r.out.at(-1)).toMatch(/runs detached/)
    expect(calls).toEqual([])
  })
  it('a fresh beat naming NO machine (an older build) refuses on freshness alone — its pid is not asked about, as startScheduler', async () => {
    for (const alive of [true, false]) {
      const r = await run(beat({ machine: undefined }), () => alive)
      expect(r.code).toBe(2)
      expect(r.asked).toEqual([]) // a pid is a fact about one machine; this one cannot say whose it is
      expect(r.out[0]).toMatch(/names no machine beat 30s ago \(pid 4242\)/)
      expect(r.pass).not.toHaveBeenCalled()
    }
    // …and once that beat is stale it does not block.
    const stale = await run(beat({ machine: undefined, at: new Date(NOW - 3 * 60_000).toISOString() }), () => true)
    expect(stale.pass).toHaveBeenCalledWith(48, [])
  })
  it('the staleness bound is HEARTBEAT_STALE_MS exactly: a beat that old does not block, one a millisecond younger does', async () => {
    const at = (ms: number) => beat({ at: new Date(NOW - ms).toISOString() })
    expect((await run(at(3 * 60_000), () => true)).pass).toHaveBeenCalledWith(48, [])
    expect((await run(at(3 * 60_000 - 1), () => true)).code).toBe(2)
  })
  it('a dead pid does not block — the `pm2 stop` case: the beat is still fresh, the process is gone', async () => {
    const r = await run(beat(), () => false)
    expect(r.code).toBe(0)
    expect(r.pass).toHaveBeenCalledWith(48, [])
  })
  it('a stale beat does not block, and its pid is not even asked about', async () => {
    const r = await run(beat({ at: new Date(NOW - 3 * 60_000 - 1).toISOString() }), () => true)
    expect(r.pass).toHaveBeenCalledWith(48, [])
    expect(r.asked).toEqual([])
  })
  it("another machine's heartbeat does not block (the Mac's, sharing the database)", async () => {
    const r = await run(beat({ machine: 'DMPLs Mac Studio' }), () => true)
    expect(r.pass).toHaveBeenCalledWith(48, [])
    expect(r.asked).toEqual([])
  })
  it('no heartbeat at all does not block', async () => {
    const r = await run(null, () => true)
    expect(r.pass).toHaveBeenCalledWith(48, [])
  })
  it('a heartbeat that cannot be READ refuses — a running worker cannot be ruled out', async () => {
    const r = await run(new Error("Invalid `prisma.setting.findUnique()` invocation:\n\nCan't reach database server at 127.0.0.1:15432"), () => true)
    expect(r.code).toBe(2)
    expect(r.pass).not.toHaveBeenCalled()
    expect(r.out[0]).toMatch(/heartbeat could not be read \(Can't reach database server at 127\.0\.0\.1:15432\)/)
    expect(r.out.at(-2)).toBe(b.stopRunStartLine(48))
  })
  it('pidAliveHere: this process is alive; a pid nobody holds is not; EPERM — another user’s process — is alive', () => {
    expect(b.pidAliveHere(process.pid)).toBe(true)
    expect(b.pidAliveHere(2 ** 22 + 12345)).toBe(false)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    expect(b.pidAliveHere(1)).toBe(true)
  })
})

// ── 5. --run's report ────────────────────────────────────────────────────────────────────────

describe("--run's report names every channel it did not backfill", () => {
  const ch = (handle: string, over: Partial<ChannelOutcome>): ChannelOutcome => ({
    handle,
    fetched: 0,
    alreadyKnown: 0,
    stored: 0,
    campaigns: 0,
    unclassified: 0,
    organic: 0,
    officiallyPaid: 0,
    frameFlagged: 0,
    evidenceRefreshed: 0,
    pagesFetched: 0,
    ...over,
  })
  const since = nowS - 48 * H
  const channels: ChannelOutcome[] = [
    ch('done', { fetched: 40, stored: 12, campaigns: 3, alreadyKnown: 28, pagesFetched: 2, servedBy: 'graph', officialReach: { sinceUnix: since, reached: true } }),
    ch('capped', { fetched: 25, stored: 25, pagesFetched: 1, servedBy: 'graph', officialReach: { sinceUnix: since, reached: false, short: 'call-cap', oldestUnix: nowS - 5 * H } }),
    ch('bounded', { fetched: 600, stored: 300, pagesFetched: 24, servedBy: 'graph', officialReach: { sinceUnix: since, reached: false, short: 'channel-bound', oldestUnix: nowS - 40 * H } }),
    ch('storefail', { fetched: 40, stored: 10, pagesFetched: 2, servedBy: 'graph', officialReach: { sinceUnix: since, reached: true }, error: 'database is locked' }),
    ch('paused', { error: 'the official read is paused on this host (graph-rate-limit) — no request made', officialUnavailable: 'paused', officialPausedBy: 'graph-rate-limit' }),
    ch('tokenpaused', { error: 'the official read is paused on this host (graph-token) — no request made', officialUnavailable: 'paused', officialPausedBy: 'graph-token' }),
    ch('refusedhost', { error: 'the official read is paused on this host (graph-error) — no request made', officialUnavailable: 'paused', officialPausedBy: 'graph-error' }),
    ch('spent', { error: "the official read's call cap (200) was spent before this channel — no request made", officialUnavailable: 'cap-reached' }),
    ch('ratelimited', { skipped: 'official-rate-limited', error: 'official API: rate limited', officialFailure: 'graph-rate-limit' }),
    ch('personal', { error: 'official API: @personal is not a Business or Creator account, or does not exist (Invalid user id)', officialFailure: 'graph-not-professional' }),
    ch('badtoken', { error: 'official API: the read token is invalid or expired', officialFailure: 'graph-token' }),
    ch('anonymous', { fetched: 12, alreadyKnown: 12, pagesFetched: 1, servedBy: 'anonymous' }),
    ch('empty', { pagesFetched: 1, servedBy: 'graph', parseFailure: true, officialReach: { sinceUnix: since, reached: true } }),
  ]
  const s: DetectionSummary = {
    channels,
    postsSeen: 677,
    newPosts: 337,
    detected: 3,
    hadParseFailure: true,
    hadError: true,
    throttledUntil: null,
    channelsUnread: 0,
    pagesFetched: 29,
    brandsResolved: { looked: 0, decided: 0, skippedUnsure: 0, haltedEarly: false, unreached: 0, backingOff: 0, awaitingRetry: 0 },
    servedBy: { anonymous: 1, graph: 5 },
    officialCalls: { used: 200, cap: 200, dropped: 1 },
  }

  it('prints ig:detect’s lines, the calls, and every channel not backfilled with why — split into what a re-run can finish and what it cannot — exit 1', async () => {
    configure()
    const out: string[] = []
    const code = await b.runBackfill(
      { hours: 48, run: true },
      { out: (l) => out.push(l), runPass: async () => s, now: () => NOW, machine: () => 'linode-detect', readHeartbeat: async () => null, alive: () => false },
    )
    expect(code).toBe(1)
    for (const c of channels) expect(out).toContain(channelSummaryLine(c))
    expect(out).toContain(`${passSummaryLine(s)} 200 official calls used of the run's cap of 200.`)
    // The run spent its hour: said, because the pause it may have earned dies with this process.
    expect(out.some((l) => /spent most of an hour's official budget: the worker's next passes may meet a rate limit/.test(l))).toBe(true)
    expect(out).toContain('Backfilled: 1 of 13 channels.')
    const again = out.indexOf('NOT backfilled — a re-run can finish these (it reads only them, and re-reading what is stored writes nothing):')
    const never = out.indexOf('NOT backfilled — re-running will not help these:')
    expect(again).toBeGreaterThan(-1)
    expect(never).toBeGreaterThan(again)
    const section = (from: number, to: number) => out.slice(from + 1, to).filter((l) => l.startsWith('  @')).map((l) => l.slice(3, l.indexOf(':')))
    expect(section(again, never)).toEqual(['capped', 'storefail', 'paused', 'spent', 'ratelimited', 'anonymous', 'empty'])
    expect(section(never, out.length)).toEqual(['bounded', 'tokenpaused', 'refusedhost', 'personal', 'badtoken'])
    expect(out).toContain(b.stopRunStartLine(48, ['capped', 'storefail', 'paused', 'spent', 'ratelimited', 'anonymous', 'empty']))
    const why = (h: string) => out.find((l) => l.startsWith(`  @${h}: `) && !l.includes(' fetched, '))
    expect(why('done')).toBeUndefined()
    expect(why('capped')).toMatch(/the run's call cap \(200\) ran out before it reached 48 hours back/)
    expect(why('bounded')).toMatch(/per-channel bound \(600 posts\) before 48 hours back — a re-run reads the same 600/)
    expect(why('storefail')).toMatch(/it was read, then storing failed part way: database is locked/)
    expect(why('paused')).toMatch(/paused by a rate-limit answer earlier in this run — re-run after an hour/)
    expect(why('tokenpaused')).toMatch(/token is invalid or expired — a person must mint a new one/)
    expect(why('refusedhost')).toMatch(/refused this host .* a person must look/)
    expect(why('spent')).toMatch(/the run's call cap \(200\) was spent before this channel/)
    expect(why('ratelimited')).toMatch(/rate limit .* re-run after an hour/)
    expect(why('personal')).toMatch(/is not a Business or Creator account/)
    expect(why('badtoken')).toMatch(/token is invalid or expired/)
    expect(why('anonymous')).toMatch(/the anonymous feed served it — a backfill reads only through the official API/)
    expect(why('empty')).toMatch(/no posts/)
  })

  it('a pass that had an error is not a clean run, whatever the per-channel lines say', async () => {
    configure()
    const out: string[] = []
    const odd = { ...s, channels: [channels[0]!], hadError: true, hadParseFailure: false, officialCalls: { used: 2, cap: 200, dropped: 0 } }
    const code = await b.runBackfill(
      { hours: 48, run: true },
      { out: (l) => out.push(l), runPass: async () => odd, now: () => NOW, machine: () => 'linode-detect', readHeartbeat: async () => null, alive: () => false },
    )
    expect(code).toBe(1)
  })

  it('every channel backfilled → exit 0, and no NOT-backfilled list', async () => {
    configure()
    const out: string[] = []
    const ok = { ...s, channels: [channels[0]!], hadError: false, hadParseFailure: false, officialCalls: { used: 2, cap: 200, dropped: 0 } }
    const code = await b.runBackfill(
      { hours: 48, run: true },
      { out: (l) => out.push(l), runPass: async () => ok, now: () => NOW, machine: () => 'linode-detect', readHeartbeat: async () => null, alive: () => false },
    )
    expect(code).toBe(0)
    expect(out).toContain('Backfilled: 1 of 1 channel.')
    expect(out.some((l) => /NOT backfilled/.test(l))).toBe(false)
  })

  /**
   * THE RUN SAYS WHAT IT DID WITH THE FRAMES (review, 16 Oct 2026). `frameShrinks` was set on every pass
   * and printed by nothing, so a backfill that left frames unshrunk said so only in a log the person
   * running it does not read. MUTATION (applied once, seen red, restored): deleting `if (frames)
   * out(frames)` in backfill.ts fails this; returning a line for an all-zero summary in
   * detectionReport.ts fails the "nothing to say" half.
   */
  it('prints the pass’s frame shrinks after its summary line — and nothing when there were none', async () => {
    configure()
    const withFrames: DetectionSummary = {
      ...s,
      channels: [channels[0]!],
      hadError: false,
      hadParseFailure: false,
      officialCalls: { used: 2, cap: 200, dropped: 0 },
      frameShrinks: { bound: 65, widened: 25, started: 25, deferred: 0, coolingOff: 0 },
    }
    const out: string[] = []
    await b.runBackfill(
      { hours: 48, run: true },
      { out: (l) => out.push(l), runPass: async () => withFrames, now: () => NOW, machine: () => 'linode-detect', readHeartbeat: async () => null, alive: () => false },
    )
    const line = frameShrinkLine(withFrames)
    expect(line).toBe('A shrink was started for 25 cover frames over the size cap (one that failed is logged as "frame not saved", with why).')
    expect(out.indexOf(line!)).toBe(out.indexOf(`${passSummaryLine(withFrames)} 2 official calls used of the run's cap of 200.`) + 1)

    // Nothing to say: no line, on either command.
    const quiet = { ...withFrames, frameShrinks: { bound: 40, widened: 0, started: 0, deferred: 0, coolingOff: 0 } }
    expect(frameShrinkLine(quiet)).toBeNull()
    expect(frameShrinkLine({ frameShrinks: undefined })).toBeNull()
    const quietOut: string[] = []
    await b.runBackfill(
      { hours: 48, run: true },
      { out: (l) => quietOut.push(l), runPass: async () => quiet, now: () => NOW, machine: () => 'linode-detect', readHeartbeat: async () => null, alive: () => false },
    )
    expect(quietOut.some((l) => /cover frame/.test(l))).toBe(false)

    // Left over: deferred and cooling off are said, with the remedy.
    expect(frameShrinkLine({ frameShrinks: { bound: 40, widened: 0, started: 40, deferred: 3, coolingOff: 2 } })).toMatch(
      /3 more were left unshrunk — this pass's 40 shrinks were spent, on a channel's newest page, which the next pass re-reads and shrinks\. `pnpm ig:frames --capture`.* 2 skipped without a request: their shrink failed/,
    )
    // ig:detect prints it too.
    expect(readFileSync(join(process.cwd(), 'src/scripts/detect.ts'), 'utf8')).toMatch(/^const frames = frameShrinkLine\(s\)$/m)
  })
})
