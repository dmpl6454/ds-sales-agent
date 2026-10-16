import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * HOW FAR BACK THE OFFICIAL READ REACHES (src/detection/officialReach.ts, 16 Oct 2026).
 *
 * Measured on the box: the first official pass after a day-long blind stretch stored 234 posts and
 * read only 6 hours, because the routine floor is `max(now - 6h, newestStored - 60)` and every later
 * pass stops at the newest stored post. Two answers, official door only, and what pins each:
 *
 *   1. THE GAP RULE. A channel whose newest stored post is older than the pass's floor gets an
 *      official floor of `max(newest - 60, now - 36h)` and a 150-post bound; a channel with a row
 *      inside the lookback, or with no rows, gets exactly today's options; and the ANONYMOUS
 *      options are identical in every case — compared against the same pass with the fallback off.
 *      MUTATIONS (applied by hand, saw red, restored): never passing `reach` to fetchChannelFeed fails
 *      "a gapped channel reaches back"; reading a channel with no rows as a gap (`newest ?? 0`) fails
 *      "a channel with no rows keeps today's read"; `<=` for `<` in the gap test fails the PURE
 *      boundary case; computing the reach with the fallback off fails "the anonymous options are the
 *      same…"; dropping the gap rule's `Math.min(sinceUnix, …)` fails "a longer lookback…"; the
 *      routine floor in place of the gap floor fails "a gapped channel reaches back".
 *   2. `officialBackfillHours`. Every channel's official floor is `now - N h` whatever is stored,
 *      the bound is 600 posts, the pass cap 200 — and the anonymous options are again unchanged.
 *      MUTATIONS (applied by hand, saw red, restored): leaving the budget at GRAPH_MAX_CALLS_PER_PASS
 *      fails "the backfill raises the cap"; `Math.max` for `Math.min` (the newest stored post
 *      honoured) fails "every channel reaches back now - N h"; dropping the `Math.min` with the
 *      routine floor fails "a backfill shorter than the routine read…".
 *   3. A SHORTFALL IS NAMED. A deepened read that does not reach its floor is recorded on the channel
 *      (`officialReach`) and logged with the command that finishes it. MUTATION (applied by hand,
 *      saw red, restored): deleting the `outcome.officialReach =` assignment fails "a cut-short read".
 *
 * `fetchChannelFeed` is replaced by a recorder that hands back canned answers: what is under test is
 * which options the pass computes, not the doors themselves (tests/feed-source.test.ts holds those,
 * and tests/official-read-pipeline.test.ts drives a gap through the real doors).
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-official-reach-'))
const dbPath = join(dir, 'reach.db')
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

type Recorded = { handle: string; opts: Record<string, unknown>; budgetAtCall: { remaining: number; used: number; dropped: number } }
type FeedSource = typeof import('@/detection/feedSource')
type Answer = (handle: string, opts: Parameters<FeedSource['fetchChannelFeed']>[1]) => Awaited<ReturnType<FeedSource['fetchChannelFeed']>>
const rec = vi.hoisted(() => ({ calls: [] as Recorded[], answer: null as null | Answer }))

vi.mock('@/detection/feedSource', async (importOriginal) => {
  const actual = await importOriginal<FeedSource>()
  return {
    ...actual,
    fetchChannelFeed: async (handle: string, opts: Parameters<FeedSource['fetchChannelFeed']>[1]) => {
      const { graphBudget, ...rest } = opts
      rec.calls.push({ handle, opts: rest, budgetAtCall: { ...graphBudget! } })
      if (rec.answer) return rec.answer(handle, opts)
      return { posts: [], pagesFetched: 1, moreAvailable: false, source: 'graph' as const, fallbackReason: 'test', anonymousError: null }
    },
  }
})
vi.mock('@/detection/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/media')>()
  return { ...actual, saveFrame: async () => 'no-url' as const }
})
vi.mock('@/detection/autoResolve', () => ({
  autoResolveBrands: async () => ({ looked: 0, decided: 0, skippedUnsure: 0, haltedEarly: false, unreached: 0, backingOff: 0, awaitingRetry: 0 }),
}))
vi.mock('@/detection/rejudge', () => ({
  rejudgeUnusedEvidence: async () => ({ examined: 0, changed: 0, remaining: 0, skippedNoEvidence: 0, skippedCallFailed: 0, proposals: [] }),
}))
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ tagsAsEvidence: false, publisherAsContext: false }) }))
vi.mock('@/detection/detectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/detectors')>()
  return { ...actual, getDetector: () => actual.passthroughDetector }
})

const { prisma } = await import('@/lib/db')
const { runDetection, GRAPH_MAX_CALLS_PER_PASS } = await import('@/detection/pipeline')
const r = await import('@/detection/officialReach')
const { resetAnonGate, anonGateRecordThrottle } = await import('@/detection/anonGate')
const { setIgTransportForTests } = await import('@/detection/igHttp')
const { FeedFetchError } = await import('@/detection/feed')
const bf = await import('@/detection/backfill')
const g = await import('@/detection/graphFeed')
const fe = await import('@/detection/feedEvidence')
const { log } = await import('@/lib/logger')
type FeedPost = import('@/detection/feed').FeedPost

afterAll(async () => {
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

const NOW = Date.parse('2026-10-16T01:00:00Z')
const nowS = Math.floor(NOW / 1000)
const H = 3600
const floorS = nowS - 6 * H // DETECT_LOOKBACK_HOURS
/** Each channel's newest stored post, in hours before NOW; null = nothing stored. */
const NEWEST: Record<string, number | null> = { chan_gap: 20, chan_old: 50, chan_fresh: 1, chan_empty: null }
const newestS = (h: string) => nowS - NEWEST[h]! * H

const configure = () => {
  vi.stubEnv('META_GRAPH_TOKEN', 'tok_test_only_1')
  vi.stubEnv('META_IG_USER_ID', '17841400000000999')
}
const byHandle = () => Object.fromEntries(rec.calls.map((c) => [c.handle, c]))
const ANON_KEYS = ['maxPosts', 'sinceUnix', 'completeSinceUnix', 'maxPages', 'delayMs', 'allowGraph'] as const
const anonymousSide = (o: Record<string, unknown>) => Object.fromEntries(ANON_KEYS.filter((k) => k in o).map((k) => [k, o[k]]))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await fe.feedAnswersSettled()
  rec.calls = []
  rec.answer = null
  resetAnonGate()
  g.resetGraphStateForTests()
  fe.resetFeedEvidenceForTests()
  await prisma.detectedCampaign.deleteMany()
  await prisma.targetAccount.deleteMany()
  await prisma.setting.deleteMany()
  for (const [handle, hours] of Object.entries(NEWEST)) {
    await prisma.targetAccount.create({ data: { id: `t_${handle}`, handle, displayName: handle, kind: 'CHANNEL', role: 'WATCH', detectorKey: 'passthrough' } })
    if (hours === null) continue
    // The newest row, and an older one behind it — `newestStored` is a max over every row.
    for (const [i, age] of [hours, hours + 5].entries()) {
      await prisma.detectedCampaign.create({
        data: { targetId: `t_${handle}`, shortcode: `Dc${handle}${i}x`, permalink: `https://www.instagram.com/p/Dc${handle}${i}x/`, postedAt: new Date(NOW - age * H * 1000), caption: 'stored', verdict: 'ORGANIC' },
      })
    }
  }
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined)
  vi.stubEnv('META_GRAPH_TOKEN', '')
  vi.stubEnv('META_IG_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
  setIgTransportForTests()
})

describe('the gap rule (routine pass)', () => {
  it('a gapped channel reaches back to max(newest - 60, now - 36h), with the 150-post bound — the others are today', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0 })
    const c = byHandle()
    expect(c.chan_gap!.opts).toEqual({
      maxPosts: 48,
      sinceUnix: floorS,
      officialSinceUnix: newestS('chan_gap') - 60,
      officialMaxPosts: 150,
      officialMaxPages: 6,
      allowGraph: true,
    })
    // A gap older than the 36-hour catch-up stops there.
    expect(c.chan_old!.opts).toMatchObject({ sinceUnix: floorS, officialSinceUnix: nowS - 36 * H, officialMaxPosts: 150, officialMaxPages: 6 })
    // A row inside the lookback: exactly today's read, no official key at all.
    expect(c.chan_fresh!.opts).toEqual({ maxPosts: 48, sinceUnix: newestS('chan_fresh') - 60, allowGraph: true })
    // The recorder spends no calls, so every channel sees the routine pass's whole cap.
    expect(c.chan_fresh!.budgetAtCall.remaining).toBe(GRAPH_MAX_CALLS_PER_PASS)
  })

  it('a channel with no rows keeps today’s read — a new channel is not read 36 hours deep every pass', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0 })
    expect(byHandle().chan_empty!.opts).toEqual({ maxPosts: 48, sinceUnix: floorS, allowGraph: true })
  })

  it('the anonymous options are the same on every channel as with the fallback off — and off, no official key is added', async () => {
    await runDetection({ channelSpacingMs: 0 })
    const off = byHandle()
    for (const c of Object.values(off)) expect(Object.keys(c.opts).some((k) => k.startsWith('official'))).toBe(false)
    rec.calls = []
    configure()
    await runDetection({ channelSpacingMs: 0 })
    const on = byHandle()
    expect(Object.keys(on).sort()).toEqual(Object.keys(NEWEST).sort())
    for (const h of Object.keys(NEWEST)) expect(anonymousSide(on[h]!.opts)).toEqual(anonymousSide(off[h]!.opts))
  })

  it('a longer lookback is never made shallower by the 36-hour reach', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0, lookbackHours: 48 })
    // chan_old (50 h) is a gap even at 48 h; its official floor is the pass's own 48-hour floor, not 36.
    expect(byHandle().chan_old!.opts).toMatchObject({ sinceUnix: nowS - 48 * H, officialSinceUnix: nowS - 48 * H })
    // chan_gap (20 h) is inside a 48-hour lookback: no gap, today's read.
    expect(Object.keys(byHandle().chan_gap!.opts).some((k) => k.startsWith('official'))).toBe(false)
  })
})

describe('officialBackfillHours (pnpm ig:backfill --run)', () => {
  it('every channel reaches back now - N h whatever is stored, with the 600-post bound — the anonymous options unchanged', async () => {
    await runDetection({ channelSpacingMs: 0 })
    const off = byHandle()
    rec.calls = []
    configure()
    await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    const on = byHandle()
    for (const h of Object.keys(NEWEST)) {
      expect(on[h]!.opts).toMatchObject({ officialSinceUnix: nowS - 48 * H, officialMaxPosts: 600, officialMaxPages: 24, officialOnly: true })
      expect(anonymousSide(on[h]!.opts)).toEqual(anonymousSide(off[h]!.opts))
      // A routine pass never asks for an official-only read.
      expect(off[h]!.opts.officialOnly).toBeUndefined()
    }
  })

  it('the dry run counts the floor the run uses — backfillFloorFor is the pass’s own answer, channel by channel', async () => {
    configure()
    for (const hours of [1, 6, 24, 48, 168]) {
      rec.calls = []
      await runDetection({ channelSpacingMs: 0, officialBackfillHours: hours })
      for (const [h, c] of Object.entries(byHandle())) {
        const newest = NEWEST[h] === null ? undefined : newestS(h)
        expect(c.opts.officialSinceUnix, `${h} @ ${hours}h`).toBe(r.backfillFloorFor({ newestStoredUnix: newest, nowUnix: nowS, hours }))
      }
    }
  })

  it('--channel: onlyChannels reads just those watched channels', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48, onlyChannels: ['chan_gap', 'chan_empty'] })
    expect(rec.calls.map((c) => c.handle).sort()).toEqual(['chan_empty', 'chan_gap'])
  })

  it('a backfill without the official read refuses rather than run a routine pass under its name', async () => {
    await expect(runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })).rejects.toThrow(/needs the official read/)
    configure()
    await expect(runDetection({ channelSpacingMs: 0, officialBackfillHours: 48, role: 'failover' })).rejects.toThrow(/needs the official read/)
    expect(rec.calls).toEqual([])
  })

  it('a backfill stores the window it was asked for — the last page’s older posts are not stored; a routine read keeps them', async () => {
    configure()
    const answer: Answer = (handle) =>
      handle === 'chan_empty'
        ? { posts: [graphPost('DcWin1', 1), graphPost('DcWin47', 47), graphPost('DcWin49', 49)], pagesFetched: 1, moreAvailable: false, source: 'graph', fallbackReason: 'test', anonymousError: null }
        : { posts: [], pagesFetched: 1, moreAvailable: false, source: 'graph', fallbackReason: 'test', anonymousError: null }
    rec.answer = answer
    const s = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    const stored = async () => (await prisma.detectedCampaign.findMany({ where: { targetId: 't_chan_empty' }, select: { shortcode: true } })).map((x) => x.shortcode).sort()
    expect(await stored()).toEqual(['DcWin1', 'DcWin47'])
    expect(s.channels.find((c) => c.handle === 'chan_empty')!.stored).toBe(2)
    await prisma.detectedCampaign.deleteMany({ where: { targetId: 't_chan_empty' } })
    rec.answer = answer
    await runDetection({ channelSpacingMs: 0 })
    expect(await stored()).toEqual(['DcWin1', 'DcWin47', 'DcWin49'])
  })

  it('the backfill raises the cap to GRAPH_BACKFILL_CALL_CAP; a routine pass keeps GRAPH_MAX_CALLS_PER_PASS', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0 })
    expect(rec.calls[0]!.budgetAtCall.remaining).toBe(GRAPH_MAX_CALLS_PER_PASS)
    rec.calls = []
    const s = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    expect(r.GRAPH_BACKFILL_CALL_CAP).toBe(200)
    expect(rec.calls[0]!.budgetAtCall.remaining).toBe(r.GRAPH_BACKFILL_CALL_CAP)
    expect(s.officialCalls).toEqual({ used: 0, cap: r.GRAPH_BACKFILL_CALL_CAP, dropped: 0 })
  })

  it('a backfill shorter than the routine read never reads less than it would', async () => {
    configure()
    await runDetection({ channelSpacingMs: 0, officialBackfillHours: 1 })
    const c = byHandle()
    expect(c.chan_empty!.opts).toMatchObject({ officialSinceUnix: floorS }) // the 6-hour floor, not 1 hour
    expect(c.chan_gap!.opts).toMatchObject({ officialSinceUnix: newestS('chan_gap') - 60 }) // the gap rule's floor
  })

  it('refuses a length the command would refuse', async () => {
    for (const bad of [0, 169, 1.5, Number.NaN]) {
      await expect(runDetection({ channelSpacingMs: 0, officialBackfillHours: bad })).rejects.toThrow(/whole number of hours from 1 to 168/)
    }
    expect(rec.calls).toEqual([])
  })
})

const graphPost = (code: string, hoursAgo: number): FeedPost => ({
    shortcode: code,
    permalink: `https://www.instagram.com/p/${code}/`,
    ownerHandle: 'x',
    caption: 'via graph',
    likeCount: null,
    commentCount: null,
    postedAt: new Date(NOW - hoursAgo * H * 1000),
    gridIndex: 0,
    isPaidPartnership: false,
    sponsorHandles: [],
    collabHandles: [],
    taggedAccounts: [],
    mediaType: 'feed',
    thumbnailUrl: null,
    videoUrl: null,
    videoDurationSeconds: null,
    evidenceIncomplete: true,
  })

describe('a deepened official read that does not reach its floor is named', () => {
  const post = graphPost
  const named = (warn: { mock: { calls: unknown[][] } }, handle: string) =>
    warn.mock.calls.find(([msg, f]) => /was not read — the oldest part of that stretch is unread/.test(String(msg)) && (f as { handle?: string })?.handle === handle)?.[1] as
      | { handle: string; remedy: string; because: string; missingSince: string; reachedBackTo: string }
      | undefined
  const asOf = '(as of 2026-10-16T01:00:00.000Z; add the hours since)'

  it('a cut-short read is recorded on the channel and logged with the command that finishes it', async () => {
    configure()
    const warn = vi.spyOn(log, 'warn')
    rec.answer = (handle, opts) => {
      if (handle === 'chan_gap') {
        // The pass's budget ran out after one page, two hours deep, more available.
        opts.graphBudget!.remaining = 0
        return { posts: [post('DcGapA1', 1), post('DcGapA2', 2)], pagesFetched: 1, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
      }
      if (handle === 'chan_old') {
        return { posts: [post('DcOldA1', 3), post('DcOldA2', 40)], pagesFetched: 2, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
      }
      return { posts: [post(`Dc${handle}N`, 0.5)], pagesFetched: 1, moreAvailable: false, source: 'graph', fallbackReason: 'test', anonymousError: null }
    }
    const s = await runDetection({ channelSpacingMs: 0 })
    const out = Object.fromEntries(s.channels.map((c) => [c.handle, c]))
    expect(out.chan_gap!.officialReach).toEqual({ sinceUnix: newestS('chan_gap') - 60, reached: false, short: 'call-cap', oldestUnix: nowS - 2 * H })
    expect(out.chan_gap!.unreadStretch).toEqual({ sinceUnix: newestS('chan_gap') - 60, reachedBackTo: nowS - 2 * H, because: 'call-cap' })
    expect(out.chan_old!.officialReach).toEqual({ sinceUnix: nowS - 36 * H, reached: true })
    expect(out.chan_fresh!.officialReach).toBeUndefined() // no reach asked for: nothing to report
    expect(out.chan_fresh!.unreadStretch).toBeUndefined()
    expect(out.chan_empty!.unreadStretch).toBeUndefined()
    const gap = named(warn, 'chan_gap')
    expect(gap?.remedy).toBe(`pnpm ig:backfill --hours 21 --channel chan_gap ${asOf}`)
    expect(gap?.because).toMatch(/call cap \(60\)/)
  })

  /**
   * THE CLAMP IS NOT SILENT (review, 16 Oct 2026). A gap older than the 36-hour catch-up is read back
   * 36 hours — the read REACHES its floor, so `officialShortfall` says reached — and the hours between
   * that floor and the gap's start are left unread, for good once the newest posts are stored.
   * MUTATION (applied by hand, saw red, restored): computing `wantedUnix` from `reach.officialSinceUnix`
   * alone (no `gapStart`) fails this test.
   */
  it('a gap older than the 36-hour clamp is named even though the read reached its floor', async () => {
    configure()
    const warn = vi.spyOn(log, 'warn')
    rec.answer = (handle) =>
      handle === 'chan_old'
        ? { posts: [post('DcOldB1', 3), post('DcOldB2', 37)], pagesFetched: 2, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
        : { posts: [post(`Dc${handle}M`, 0.5)], pagesFetched: 1, moreAvailable: false, source: 'graph', fallbackReason: 'test', anonymousError: null }
    const s = await runDetection({ channelSpacingMs: 0 })
    const old = s.channels.find((c) => c.handle === 'chan_old')!
    expect(old.officialReach).toEqual({ sinceUnix: nowS - 36 * H, reached: true })
    expect(old.unreadStretch).toEqual({ sinceUnix: newestS('chan_old') - 60, reachedBackTo: nowS - 37 * H, because: 'catch-up-clamp' })
    const w = named(warn, 'chan_old')
    expect(w?.remedy).toBe(`pnpm ig:backfill --hours 51 --channel chan_old ${asOf}`)
    expect(w?.because).toMatch(/older than the 36 hours the automatic rule reads back/)

    // In a backfill the same stretch is the backfill's to name — it read back what it was asked.
    warn.mockClear()
    await prisma.detectedCampaign.deleteMany({ where: { shortcode: { in: ['DcOldB1', 'DcOldB2'] } } })
    const bfS = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 24 })
    // A 24-hour backfill of a 50-hour gap still reads the gap rule's 36 hours (never shallower).
    expect(bfS.channels.find((c) => c.handle === 'chan_old')!.unreadStretch).toEqual({ sinceUnix: newestS('chan_old') - 60, reachedBackTo: nowS - 37 * H, because: 'backfill-hours' })
    expect(named(warn, 'chan_old')?.because).toMatch(/older than the 36 hours this backfill read back/)
    expect(w?.missingSince).toBe(new Date((newestS('chan_old') - 60) * 1000).toISOString())
  })

  it('a read that got past the gap’s start, or read the whole feed, names nothing — a dormant channel is not named every pass', async () => {
    configure()
    const warn = vi.spyOn(log, 'warn')
    rec.answer = (handle) =>
      handle === 'chan_old'
        ? // Dormant-shaped: everything it returns is older than the newest post we hold.
          { posts: [post('DcOldC1', 55), post('DcOldC2', 70)], pagesFetched: 1, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
        : handle === 'chan_gap'
          ? { posts: [post('DcGapC1', 1), post('DcGapC2', 22)], pagesFetched: 1, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
          : { posts: [post(`Dc${handle}C`, 0.5)], pagesFetched: 1, moreAvailable: true, source: 'graph', fallbackReason: 'test', anonymousError: null }
    const s = await runDetection({ channelSpacingMs: 0 })
    for (const c of s.channels) expect(c.unreadStretch, c.handle).toBeUndefined()
    expect(warn.mock.calls.some(([msg]) => /was not read — the oldest part/.test(String(msg)))).toBe(false)
  })

  it('a gapped channel the ANONYMOUS door served is named when its read stopped short of the gap — never deepened, but never silent', async () => {
    configure()
    const warn = vi.spyOn(log, 'warn')
    const anon = (posts: FeedPost[], more: boolean) => ({ posts, pagesFetched: 1, moreAvailable: more, source: 'anonymous' as const, fallbackReason: null, anonymousError: null })
    rec.answer = (handle) => (handle === 'chan_gap' ? anon([post('DcAnonG1', 1), post('DcAnonG2', 8)], true) : anon([post(`Dc${handle}A`, 0.5)], false))
    const s = await runDetection({ channelSpacingMs: 0 })
    expect(s.channels.find((c) => c.handle === 'chan_gap')!.unreadStretch).toEqual({ sinceUnix: newestS('chan_gap') - 60, reachedBackTo: nowS - 8 * H, because: 'anonymous-window' })
    expect(named(warn, 'chan_gap')?.remedy).toBe(`pnpm ig:backfill --hours 21 --channel chan_gap ${asOf}`)
    // …and the anonymous options it was asked with are the routine ones (no official key reaches them).
    expect(anonymousSide(byHandle().chan_gap!.opts)).toEqual({ maxPosts: 48, sinceUnix: floorS, allowGraph: true })

    // With the official read off there is no remedy to name, so nothing is named.
    warn.mockClear()
    vi.stubEnv('META_GRAPH_TOKEN', '')
    rec.answer = (handle) => (handle === 'chan_gap' ? anon([post('DcAnonG3', 1), post('DcAnonG4', 8)], true) : anon([post(`Dc${handle}B`, 0.5)], false))
    const off = await runDetection({ channelSpacingMs: 0 })
    expect(off.channels.find((c) => c.handle === 'chan_gap')!.unreadStretch).toBeUndefined()
  })
})

describe('the rules (PURE)', () => {
  const base = { nowUnix: nowS, floorUnix: floorS }
  it('a gap is strictly older than the floor; at the floor it is not one', () => {
    expect(r.officialReachFor({ ...base, sinceUnix: floorS, newestStoredUnix: floorS - 1 })).not.toBeNull()
    expect(r.officialReachFor({ ...base, sinceUnix: floorS, newestStoredUnix: floorS })).toBeNull()
    expect(r.officialReachFor({ ...base, sinceUnix: floorS, newestStoredUnix: undefined })).toBeNull()
  })
  it('the bounds are what the docblock says', () => {
    expect(r.GRAPH_GAP_MAX_POSTS).toBe(150)
    expect(r.GRAPH_BACKFILL_MAX_POSTS).toBe(600)
    expect(r.BACKFILL_MAX_HOURS).toBe(168)
  })
  it('a shortfall: reached at the floor or at the end of history; otherwise the cap or the bound', () => {
    const reach = { officialSinceUnix: nowS - 10 * H, officialMaxPosts: 150, officialMaxPages: 6 }
    const at = (hours: number[]) => hours.map((h) => ({ postedAt: new Date(NOW - h * H * 1000) }))
    expect(r.officialShortfall({ posts: at([1, 10]), pagesFetched: 1, moreAvailable: true }, reach, 5)).toEqual({ reached: true })
    expect(r.officialShortfall({ posts: at([1, 2]), pagesFetched: 1, moreAvailable: false }, reach, 5)).toEqual({ reached: true })
    expect(r.officialShortfall({ posts: at([1, 2]), pagesFetched: 1, moreAvailable: true }, reach, 0)).toMatchObject({ reached: false, short: 'call-cap' })
    expect(r.officialShortfall({ posts: at([1, 2]), pagesFetched: 6, moreAvailable: true }, reach, 0)).toMatchObject({ reached: false, short: 'channel-bound' })
    expect(r.officialShortfall({ posts: at([1, 2]), pagesFetched: 1, moreAvailable: true }, reach, null)).toMatchObject({ reached: false, short: 'channel-bound' })
    // The POST bound, reached in the same call that emptied the budget, is the bound and not the cap.
    expect(r.officialShortfall({ posts: at(Array.from({ length: 150 }, (_, i) => 1 + i / 100)), pagesFetched: 5, moreAvailable: true }, reach, 0)).toMatchObject({ reached: false, short: 'channel-bound' })
  })
  it('unreadStretch: named only when more exists and the read stopped before the wanted floor', () => {
    const at = (hours: number[]) => hours.map((h) => ({ postedAt: new Date(NOW - h * H * 1000) }))
    const wanted = nowS - 20 * H
    expect(r.unreadStretch({ posts: at([1, 8]), moreAvailable: true }, wanted)).toEqual({ oldestUnix: nowS - 8 * H })
    expect(r.unreadStretch({ posts: at([1, 20]), moreAvailable: true }, wanted)).toBeNull() // at the floor
    expect(r.unreadStretch({ posts: at([1, 8]), moreAvailable: false }, wanted)).toBeNull() // the whole feed
    expect(r.unreadStretch({ posts: [], moreAvailable: true }, wanted)).toEqual({ oldestUnix: null })
    expect(r.gapStartUnix(floorS - 1, floorS)).toBe(floorS - 61)
    expect(r.gapStartUnix(floorS, floorS)).toBeNull()
    expect(r.gapStartUnix(undefined, floorS)).toBeNull()
  })
  it('hoursBackTo rounds up and caps at the material window', () => {
    expect(r.hoursBackTo(nowS - 20 * H - 60, nowS)).toBe(21)
    expect(r.hoursBackTo(nowS - 400 * H, nowS)).toBe(168)
  })
})

/**
 * WHY THE OFFICIAL READ COULD NOT SERVE A CHANNEL IS RECORDED (review, 16 Oct 2026) — `ig:backfill`
 * names every channel it did not finish from these fields, so where they are written is under test,
 * not only the reader. MUTATIONS (applied by hand, saw red, restored): deleting
 * `if (officialOn) officialUnavailable(outcome, official)` in the closed-gate branch fails "a closed
 * gate and the cap spent"; deleting its `graphBudget.dropped += 1` fails the same test's `dropped`;
 * deleting the official-only branch's `officialUnavailable(outcome, official)` fails "a backfill whose
 * cap is spent"; deleting the catch's `officialReadAvailability` block fails "the anonymous refusal
 * rethrown"; not recording `officialPausedBy` fails both pause rows.
 */
describe('why the official read could not serve a channel is recorded', () => {
  /** The first channel asked spends the pass's whole budget; later ones find it spent. */
  const drainFirst = (): Answer => {
    let first = true
    return (handle, opts) => {
      if (first) {
        first = false
        opts.graphBudget!.used += opts.graphBudget!.remaining
        opts.graphBudget!.remaining = 0
      }
      return { posts: [graphPost(`Dc${handle}D`, 0.5)], pagesFetched: 1, moreAvailable: false, source: 'graph', fallbackReason: 'test', anonymousError: null }
    }
  }
  /** Meta's answer, once, through the real reader — so the pause is set exactly as a pass meets it. */
  const pauseWith = async (error: object) => {
    setIgTransportForTests(async () => ({ status: 400, ok: false, contentType: 'application/json', text: async () => JSON.stringify({ error }), json: async () => ({ error }) }))
    await g.fetchFeedViaGraph('someone', { delayMs: 0, record: false }).catch(() => undefined)
    expect(g.graphCooldown().open).toBe(false)
  }

  it('a closed gate and the cap spent → officialUnavailable "cap-reached", skipped "throttled", and every such channel counted', async () => {
    configure()
    anonGateRecordThrottle('feed', 401)
    rec.answer = drainFirst()
    const s = await runDetection({ channelSpacingMs: 0 })
    const graph = s.channels.filter((c) => c.servedBy === 'graph')
    const rest = s.channels.filter((c) => c.servedBy === undefined)
    expect(graph).toHaveLength(1)
    expect(rest).toHaveLength(3)
    for (const c of rest) expect(c, c.handle).toMatchObject({ skipped: 'throttled', officialUnavailable: 'cap-reached' })
    expect(s.officialCalls).toMatchObject({ cap: GRAPH_MAX_CALLS_PER_PASS, dropped: 3 })
  })

  it('a backfill whose cap is spent → officialUnavailable "cap-reached", the official read named in the error, NOT "throttled" — and a re-run can finish it', async () => {
    configure()
    rec.answer = drainFirst()
    const s = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    const rest = s.channels.filter((c) => c.servedBy === undefined)
    expect(rest).toHaveLength(3)
    for (const c of rest) {
      expect(c.officialUnavailable, c.handle).toBe('cap-reached')
      expect(c.skipped, c.handle).toBeUndefined()
      expect(c.error, c.handle).toMatch(/official read's call cap \(200\) was spent before this channel — no request made/)
      expect(bf.notBackfilledReason(c, 48, 200)).toEqual({ why: "the run's call cap (200) was spent before this channel", rerun: true })
    }
    expect(s.officialCalls).toMatchObject({ cap: 200, dropped: 3 })
    expect(s.channelsUnread).toBe(0) // not the anonymous door's story
    expect(rec.calls).toHaveLength(1)
  })

  it('a backfill while the official read is paused by a RATE LIMIT → "paused", by graph-rate-limit, no request, re-run after an hour', async () => {
    configure()
    await pauseWith({ code: 4, message: 'Application request limit reached' })
    const s = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    expect(rec.calls).toEqual([])
    for (const c of s.channels) {
      expect(c, c.handle).toMatchObject({ officialUnavailable: 'paused', officialPausedBy: 'graph-rate-limit' })
      expect(bf.notBackfilledReason(c, 48, 200)).toMatchObject({ rerun: true, why: expect.stringMatching(/rate-limit answer .* re-run after an hour/) })
    }
  })

  it('… by a TOKEN error → "paused", by graph-token, and re-running will not help until a person mints a new one', async () => {
    configure()
    await pauseWith({ code: 190, message: 'Error validating access token: Session has expired' })
    const s = await runDetection({ channelSpacingMs: 0, officialBackfillHours: 48 })
    for (const c of s.channels) {
      expect(c, c.handle).toMatchObject({ officialUnavailable: 'paused', officialPausedBy: 'graph-token' })
      expect(bf.notBackfilledReason(c, 48, 200)).toMatchObject({ rerun: false, why: expect.stringMatching(/token is invalid or expired — a person must mint a new one/) })
    }
  })

  it('the anonymous refusal rethrown because the cap was spent (gate open) → "throttled" AND officialUnavailable "cap-reached"', async () => {
    configure()
    const drain = drainFirst()
    let first = true
    rec.answer = (handle, opts) => {
      if (first) {
        first = false
        return drain(handle, opts)
      }
      // What feedSource.ts rethrows when the anonymous feed refuses and the fallback cannot serve.
      throw new FeedFetchError(handle, 'HTTP 401 require_login', false, true, new Date(NOW + 15 * 60_000))
    }
    const s = await runDetection({ channelSpacingMs: 0 })
    const rest = s.channels.filter((c) => c.servedBy === undefined)
    expect(rest).toHaveLength(3)
    for (const c of rest) expect(c, c.handle).toMatchObject({ skipped: 'throttled', officialUnavailable: 'cap-reached' })
  })
})
