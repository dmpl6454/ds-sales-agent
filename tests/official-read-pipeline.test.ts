import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE OFFICIAL READ FALLBACK THROUGH THE REAL PIPELINE, AGAINST A REAL DATABASE (15 Oct 2026).
 *
 * `runDetection` runs for real over a temporary SQLite file; only the network (one recording
 * transport for both doors), the frame download, the brand resolver, the re-judge pass and the
 * Setting reader are faked. What this pins, and the mutation that fails each:
 *
 *   1. a pass the anonymous feed REFUSES, with the fallback configured, still stores posts and
 *      stamps `detectFeedOkAt` — and spends no further anonymous request once the gate closed;
 *   2. unconfigured, the same refusal halts the pass exactly as before (no official call at all);
 *   3. THE EVIDENCE-WIPE GUARD. A Graph-served re-observation reports EMPTY tags because the API
 *      returns none; compared like an anonymous read it would write `[]` over the real ones.
 *      MUTATION (applied by hand, saw red, restored): deleting `if (post.evidenceIncomplete)
 *      return null` from `evidenceRefresh` fails "a Graph-served re-observation leaves stored
 *      tags untouched";
 *   4. the same guard on the OTHER writer — `persist`'s upsert reconciler, reached when a
 *      concurrent pass stored the post first. Since review (15 Oct 2026) an incomplete post updates
 *      the counts and NOTHING else — not the verdict, not the caption, not the frame text, which
 *      were formed from less evidence than the row holds. MUTATION (applied by hand, saw red,
 *      restored): writing the full update for an incomplete post fails "the reconciler keeps the
 *      evidence a concurrent anonymous pass captured";
 *   5. the first anonymous read of a Graph-stored post replaces its incomplete payload even when
 *      it has no tags either. MUTATION (applied by hand, saw red, restored): deleting
 *      `if (previous.incomplete) changed.push('completed')` fails "the first anonymous read…";
 *   6. the official API's rate-limit pause is never written as the ANONYMOUS cooldown.
 *      MUTATION (applied by hand, saw red, restored): deleting the `err instanceof GraphFeedError`
 *      branch in the pipeline's catch fails "a Graph rate limit is not the anonymous cooldown";
 *   7. a Mac's failover pass never asks the official API.
 *   8. (review) when the anonymous feed returns a post the official API stored, the post is JUDGED
 *      AGAIN and written whole — caption with its @mentions, tags, brands, verdict — unless a person
 *      labelled it, in which case only its evidence and caption are completed. MUTATION (applied by
 *      hand, saw red, restored): emptying the `rejudge` set fails "a Graph-stored post is judged again…";
 *   9. (review) a channel holding such posts inside the lookback pages back to the oldest of them.
 *      MUTATION (applied by hand, saw red, restored): never setting `completeSinceUnix` fails "the
 *      feed reaches back…";
 *  10. (review) a pass whose every page was EMPTY does not stamp `detectFeedOkAt`. MUTATION (applied
 *      by hand, saw red, restored): reverting either the first-page stamp's `posts.length > 0` or
 *      `recordDetectionOutput`'s `pagesWithPosts` fails "an all-empty pass is not a read".
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-official-read-'))
const dbPath = join(dir, 'pipeline.db')
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

/** Runs inside the detector, i.e. after the pipeline computed its known set and before `persist`. */
const onClassify = vi.hoisted(() => ({ hook: null as null | ((shortcode: string) => Promise<void>) }))

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
  const wrapped = {
    ...actual.passthroughDetector,
    async classify(post: Parameters<typeof actual.passthroughDetector.classify>[0]) {
      if (onClassify.hook) await onClassify.hook(post.shortcode)
      return actual.passthroughDetector.classify(post)
    },
  }
  return { ...actual, getDetector: () => wrapped }
})

const { prisma } = await import('@/lib/db')
const { runDetection } = await import('@/detection/pipeline')
const { buildRawPayload, evidenceRefresh, EVIDENCE_INCOMPLETE_MARKER } = await import('@/detection/evidence')
const { resetAnonGate, setAnonGateClock, DETECT_FEED_OK_KEY, DETECT_THROTTLED_KEY } = await import('@/detection/anonGate')
const g = await import('@/detection/graphFeed')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
type FeedPost = import('@/detection/feed').FeedPost
const fe = await import('@/detection/feedEvidence')

afterAll(async () => {
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

const NOW = Date.parse('2026-10-15T09:00:00Z')
const WALL = '{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}'
const SHORTCODE: Record<string, string> = { chan_a: 'DcGraphA1', chan_b: 'DcGraphB1' }
const TAGGED = '["royalcanin.india"]'
const PAYLOAD = JSON.stringify({ isPaidPartnership: true, sponsorHandles: [], collabHandles: ['brandco'], thumbnailUrl: null, videoUrl: null, videoDurationSeconds: null, capturedAt: '2026-10-15T08:00:00.000Z' })

type Answer = { status: number; body: string; contentType?: string }
type Call = { host: 'anonymous' | 'graph'; handle: string }
let calls: Call[] = []
let anonQueue: Answer[] = []
/** When set, the anonymous feed answers per handle — the pass rotates its channel order. */
let anonByHandle: Record<string, Answer> | null = null
/** When set, the anonymous feed answers per handle AND url — for pagination. */
let anonFn: null | ((handle: string, url: string) => Answer) = null
let graphAnswer: (handle: string) => Answer = () => ({ status: 500, body: '' })

function graphPage(handle: string): Answer {
  return {
    status: 200,
    body: JSON.stringify({
      business_discovery: {
        username: handle,
        media: {
          data: [{ id: '1', caption: `via graph for ${handle}`, timestamp: '2026-10-15T08:00:00+0000', permalink: `https://www.instagram.com/p/${SHORTCODE[handle]}/`, media_type: 'IMAGE', media_url: 'https://cdn.example/a.jpg' }],
          paging: { cursors: {} },
        },
      },
    }),
  }
}
const anonPage = (code: string, extra: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: JSON.stringify({ items: [{ code, taken_at: 1_760_515_200, caption: { text: 'via the feed' }, ...extra }], more_available: false }),
})

beforeEach(async () => {
  await fe.feedAnswersSettled()
  calls = []
  anonQueue = []
  anonByHandle = null
  anonFn = null
  graphAnswer = graphPage
  onClassify.hook = null
  resetAnonGate()
  setAnonGateClock(() => NOW)
  g.resetGraphStateForTests()
  g.setGraphClockForTests(() => NOW)
  fe.resetFeedEvidenceForTests()
  await prisma.detectedCampaign.deleteMany()
  await prisma.targetAccount.deleteMany()
  await prisma.setting.deleteMany()
  for (const handle of ['chan_a', 'chan_b']) {
    await prisma.targetAccount.create({ data: { id: `t_${handle}`, handle, displayName: handle, kind: 'CHANNEL', role: 'WATCH', detectorKey: 'passthrough' } })
  }
  setIgTransportForTests(async (url) => {
    if (url.startsWith('https://graph.facebook.com/')) {
      const handle = decodeURIComponent(url).match(/business_discovery\.username\(([^)]+)\)/)![1]!
      calls.push({ host: 'graph', handle })
      const a = graphAnswer(handle)
      return { status: a.status, ok: a.status >= 200 && a.status < 300, contentType: 'application/json', text: async () => a.body, json: async () => JSON.parse(a.body) as unknown } satisfies IgResponse
    }
    const handle = url.match(/feed\/user\/([^/]+)\//)![1]!
    calls.push({ host: 'anonymous', handle })
    const a = anonFn ? anonFn(handle, url) : anonByHandle ? anonByHandle[handle] : anonQueue.shift()
    if (!a) throw new Error('the test transport ran out of anonymous answers')
    return { status: a.status, ok: a.status >= 200 && a.status < 300, contentType: a.contentType ?? 'application/json', text: async () => a.body, json: async () => JSON.parse(a.body) as unknown } satisfies IgResponse
  })
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined)
  // Unconfigured by default, whatever a developer's .env holds (env.ts loads it with dotenv):
  // "unconfigured" rows must not depend on the absence of a line in somebody's file.
  vi.stubEnv('META_GRAPH_TOKEN', '')
  vi.stubEnv('META_IG_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setIgTransportForTests()
  setAnonGateClock()
  g.setGraphClockForTests()
})

const configure = () => {
  vi.stubEnv('META_GRAPH_TOKEN', 'tok_test_only_1')
  vi.stubEnv('META_IG_USER_ID', '17841400000000999')
}
const setting = async (key: string) => (await prisma.setting.findUnique({ where: { key } }))?.value ?? null
const row = (shortcode: string) => prisma.detectedCampaign.findUnique({ where: { shortcode } })

describe('a pass the anonymous feed refuses', () => {
  it('with the fallback configured: stores the posts, stamps detectFeedOkAt, and spends no anonymous request after the gate closed', async () => {
    configure()
    anonQueue = [{ status: 401, body: WALL }]
    const s = await runDetection({ channelSpacingMs: 0 })

    expect(calls.map((c) => c.host)).toEqual(['anonymous', 'graph', 'graph'])
    expect(s.servedBy).toEqual({ anonymous: 0, graph: 2 })
    expect(s.channelsUnread).toBe(0)
    expect(s.newPosts).toBe(2)
    expect(s.channels.every((c) => c.servedBy === 'graph')).toBe(true)
    expect(await setting(DETECT_FEED_OK_KEY)).not.toBeNull()
    // The ANONYMOUS cooldown is still recorded: the banner says both things.
    expect(await setting(DETECT_THROTTLED_KEY)).toBe(new Date(NOW + 15 * 60_000).toISOString())

    const stored = (await row('DcGraphA1'))!
    expect(stored.taggedAccounts).toBe('[]')
    expect(JSON.parse(stored.rawPayload!)).toMatchObject({ evidenceIncomplete: true, isPaidPartnership: null })
  })

  it('unconfigured: the pass halts on the refusal exactly as it always has — no official call at all', async () => {
    anonQueue = [{ status: 401, body: WALL }]
    const s = await runDetection({ channelSpacingMs: 0 })
    expect(calls).toEqual([expect.objectContaining({ host: 'anonymous' })])
    expect(s.servedBy).toEqual({ anonymous: 0, graph: 0 })
    expect(s.channelsUnread).toBe(2)
    expect(s.channels.map((c) => c.skipped)).toEqual(['throttled', 'throttled'])
    expect(s.newPosts).toBe(0)
    expect(await setting(DETECT_FEED_OK_KEY)).toBeNull()
    expect(await setting(DETECT_THROTTLED_KEY)).toBe(new Date(NOW + 15 * 60_000).toISOString())
  })

  it("a Mac's failover pass never asks the official API, even where it is configured", async () => {
    configure()
    anonQueue = [{ status: 401, body: WALL }]
    const s = await runDetection({ channelSpacingMs: 0, role: 'failover' })
    expect(calls.map((c) => c.host)).toEqual(['anonymous'])
    expect(s.servedBy.graph).toBe(0)
  })

  it('a Graph rate limit is not the anonymous cooldown — detectThrottledUntil stays the anonymous gate’s', async () => {
    configure()
    const secfetch = { status: 400, body: '{"message":"SecFetch Policy violation."}' }
    anonQueue = [secfetch, secfetch]
    graphAnswer = () => ({ status: 400, body: JSON.stringify({ error: { code: 4, message: 'Application request limit reached' } }) })
    const s = await runDetection({ channelSpacingMs: 0 })
    // First channel: anonymous 400 → official API → rate limited. Second: anonymous 400 → official paused → the 400 stands.
    expect(calls.map((c) => c.host)).toEqual(['anonymous', 'graph', 'anonymous'])
    expect(s.channels.map((c) => c.skipped ?? null)).toEqual(['official-rate-limited', null])
    expect(s.channelsUnread).toBe(0)
    expect(s.throttledUntil).toBeNull()
    expect(await setting(DETECT_THROTTLED_KEY)).toBeNull()
    expect(s.channels[0]!.error).toMatch(/SecFetch[\s\S]*then[\s\S]*official API: rate limited/)
  })
})

describe('evidence the official API does not report is never erased', () => {
  const incompletePost = (over: Partial<FeedPost> = {}): FeedPost => ({
    shortcode: 'DcGraphA1',
    permalink: 'https://www.instagram.com/p/DcGraphA1/',
    ownerHandle: 'chan_a',
    caption: 'x',
    likeCount: null,
    commentCount: null,
    postedAt: new Date(NOW),
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
    ...over,
  })

  it('evidenceRefresh says nothing about a Graph-served post (PURE)', () => {
    expect(evidenceRefresh({ taggedAccounts: TAGGED, rawPayload: PAYLOAD }, incompletePost(), new Date(NOW))).toBeNull()
  })

  it('a Graph-served re-observation leaves stored tags untouched', async () => {
    configure()
    await prisma.detectedCampaign.create({
      data: { targetId: 't_chan_a', shortcode: 'DcGraphA1', permalink: 'https://www.instagram.com/p/DcGraphA1/', postedAt: new Date(NOW - 3_600_000), caption: 'x', verdict: 'ORGANIC', taggedAccounts: TAGGED, rawPayload: PAYLOAD },
    })
    anonQueue = [{ status: 401, body: WALL }]
    const s = await runDetection({ channelSpacingMs: 0 })
    expect(s.servedBy.graph).toBe(2)
    const after = (await row('DcGraphA1'))!
    expect(after.taggedAccounts).toBe(TAGGED)
    expect(after.rawPayload).toBe(PAYLOAD)
    expect(s.channels.reduce((n, c) => n + c.evidenceRefreshed, 0)).toBe(0)
  })

  it('the reconciler keeps the evidence a concurrent anonymous pass captured', async () => {
    configure()
    // The other pass stores the post between this pass's known-set query and its persist —
    // the slot/cron collision the upsert's update branch exists for.
    onClassify.hook = async (shortcode) => {
      if (shortcode !== 'DcGraphA1') return
      await prisma.detectedCampaign.create({
        data: { targetId: 't_chan_a', shortcode, permalink: `https://www.instagram.com/p/${shortcode}/`, postedAt: new Date(NOW), caption: 'x', verdict: 'ORGANIC', brands: '["@brandco"]', taggedAccounts: TAGGED, rawPayload: PAYLOAD },
      })
    }
    anonQueue = [{ status: 401, body: WALL }]
    await runDetection({ channelSpacingMs: 0 })
    const after = (await row('DcGraphA1'))!
    expect(after.taggedAccounts).toBe(TAGGED)
    expect(after.rawPayload).toBe(PAYLOAD)
    expect(after.brands).toBe('["@brandco"]')
    // Nothing judged from less evidence overwrites what the complete read stored — not the verdict,
    // not the caption (the API's has no @mentions), not the frame text.
    expect(after.verdict).toBe('ORGANIC')
    expect(after.caption).toBe('x')
  })

  it('the first anonymous read of a Graph-stored post replaces its incomplete payload, even with no tags either', async () => {
    configure()
    anonQueue = [{ status: 401, body: WALL }]
    await runDetection({ channelSpacingMs: 0 })
    expect(JSON.parse((await row('DcGraphA1'))!.rawPayload!)).toMatchObject({ evidenceIncomplete: true })

    // The anonymous feed is back; the post has no tags on Instagram either. (The cooldown is
    // forgotten in memory AND on disk, or the pass would rehydrate it.)
    vi.unstubAllEnvs()
    resetAnonGate()
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'anonThrottle:' } } })
    anonByHandle = { chan_a: anonPage('DcGraphA1'), chan_b: anonPage('DcGraphB1') }
    const s = await runDetection({ channelSpacingMs: 0 })
    expect(s.servedBy).toEqual({ anonymous: 2, graph: 0 })
    const payload = JSON.parse((await row('DcGraphA1'))!.rawPayload!) as Record<string, unknown>
    expect(payload.evidenceIncomplete).toBeUndefined()
    expect(payload.isPaidPartnership).toBe(false)
    expect(s.channels.reduce((n, c) => n + c.evidenceRefreshed, 0)).toBe(2)

    // And it then compares like any other row: a third read changes nothing.
    const third = await runDetection({ channelSpacingMs: 0 })
    expect(third.channels.reduce((n, c) => n + c.evidenceRefreshed, 0)).toBe(0)
  })

  it('the marker the pipeline queries for is byte-identical to what buildRawPayload writes', () => {
    expect(buildRawPayload(incompletePost(), new Date(NOW))).toContain(EVIDENCE_INCOMPLETE_MARKER)
    expect(buildRawPayload(incompletePost({ evidenceIncomplete: undefined }), new Date(NOW))).not.toContain(EVIDENCE_INCOMPLETE_MARKER)
  })

  it('a Graph-stored post is judged again from the complete read — and a labelled one keeps its answer', async () => {
    const seed = (shortcode: string, over: Record<string, unknown>) =>
      prisma.detectedCampaign.create({
        data: {
          targetId: shortcode === 'DcGraphA1' ? 't_chan_a' : 't_chan_b',
          shortcode,
          permalink: `https://www.instagram.com/p/${shortcode}/`,
          postedAt: new Date(NOW - 3_600_000),
          caption: 'Thanks royalcanin.india', // the API's caption: no @
          verdict: 'ORGANIC',
          verdictSource: 'semantic',
          taggedAccounts: '[]',
          brands: '[]',
          rawPayload: buildRawPayload(incompletePost({ shortcode }), new Date(NOW - 3_600_000)),
          ...over,
        },
      })
    await seed('DcGraphA1', {})
    await seed('DcGraphB1', { verdict: 'CAMPAIGN', verdictSource: 'human', humanLabel: true })
    const judged: string[] = []
    onClassify.hook = async (shortcode) => {
      judged.push(shortcode)
    }
    const whole = { caption: { text: 'Thanks @royalcanin.india' }, coauthor_producers: [{ username: 'brandco' }], usertags: { in: [{ user: { username: 'royalcanin.india' } }] } }
    anonByHandle = { chan_a: anonPage('DcGraphA1', whole), chan_b: anonPage('DcGraphB1', whole) }
    const s = await runDetection({ channelSpacingMs: 0 })

    expect(judged).toEqual(['DcGraphA1']) // the labelled post is never re-judged
    const a = (await row('DcGraphA1'))!
    expect(a.caption).toBe('Thanks @royalcanin.india')
    expect(a.taggedAccounts).toBe('["royalcanin.india"]')
    expect(JSON.parse(a.brands) as string[]).toContain('@brandco')
    expect(a.verdict).toBe('UNCLASSIFIED') // the passthrough detector's own answer, freshly reached
    expect(a.verdictSource).toBe('none')
    expect(JSON.parse(a.rawPayload!)).not.toHaveProperty('evidenceIncomplete')

    const b = (await row('DcGraphB1'))!
    expect(b.caption).toBe('Thanks @royalcanin.india') // the caption is evidence, completed
    expect(b.taggedAccounts).toBe('["royalcanin.india"]')
    expect(b.verdict).toBe('CAMPAIGN') // the person's answer stands
    expect(b.verdictSource).toBe('human')
    expect(JSON.parse(b.rawPayload!)).not.toHaveProperty('evidenceIncomplete')

    // Neither is a NEW post — both were counted when they were stored.
    expect(s.newPosts).toBe(0)
    expect(s.channels.reduce((n, c) => n + c.evidenceRefreshed, 0)).toBe(2)
  })

  it('the feed reaches back to the oldest Graph-stored post inside the lookback, and stops once it is complete', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const item = (code: string, ageMin: number) => ({ code, taken_at: nowS - ageMin * 60, caption: { text: 'feed' } })
    for (const [code, ageMin] of [['DcIncX1', 40], ['DcIncX2', 180]] as const) {
      await prisma.detectedCampaign.create({
        data: {
          targetId: 't_chan_a',
          shortcode: code,
          permalink: `https://www.instagram.com/p/${code}/`,
          postedAt: new Date((nowS - ageMin * 60) * 1000),
          caption: 'via graph',
          verdict: 'ORGANIC',
          rawPayload: buildRawPayload(incompletePost({ shortcode: code }), new Date()),
        },
      })
    }
    anonFn = (handle, url) => {
      if (handle === 'chan_b') return anonPage('DcOtherB1')
      return url.includes('max_id=p2')
        ? { status: 200, body: JSON.stringify({ items: [item('DcIncX2', 180)], more_available: false }) }
        : { status: 200, body: JSON.stringify({ items: [item('DcNewY', 10), item('DcIncX1', 40), item('DcNewZ', 60)], more_available: true, next_max_id: 'p2' }) }
    }
    await runDetection({ channelSpacingMs: 0 })
    // Page 1's oldest post is past the newest stored row, so without the reach-back it stops there.
    expect(calls.filter((c) => c.handle === 'chan_a')).toHaveLength(2)
    expect(JSON.parse((await row('DcIncX2'))!.rawPayload!)).not.toHaveProperty('evidenceIncomplete')

    // Complete now: the next pass reads one page, as any channel does.
    calls = []
    await runDetection({ channelSpacingMs: 0 })
    expect(calls.filter((c) => c.handle === 'chan_a')).toHaveLength(1)
  }, 20_000)

  it('an all-empty pass is not a read — detectFeedOkAt is not stamped, and one page with posts is', async () => {
    anonByHandle = { chan_a: { status: 200, body: '{"items":[]}' }, chan_b: { status: 200, body: '{"items":[]}' } }
    await runDetection({ channelSpacingMs: 0 })
    expect(await setting(DETECT_FEED_OK_KEY)).toBeNull()

    anonByHandle = { chan_a: { status: 200, body: '{"items":[]}' }, chan_b: anonPage('DcOtherB1') }
    await runDetection({ channelSpacingMs: 0 })
    expect(await setting(DETECT_FEED_OK_KEY)).not.toBeNull()
  })

  it('and a complete payload is byte-for-byte what it always was', () => {
    const complete = incompletePost({ evidenceIncomplete: undefined, isPaidPartnership: true })
    expect(Object.keys(JSON.parse(buildRawPayload(complete, new Date(NOW))) as object)).toEqual([
      'isPaidPartnership',
      'sponsorHandles',
      'collabHandles',
      'thumbnailUrl',
      'videoUrl',
      'videoDurationSeconds',
      'capturedAt',
    ])
  })
})
