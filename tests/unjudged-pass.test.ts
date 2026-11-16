import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSource, stripComments } from './fixtures/sourceScan'

/**
 * POSTS A CLASSIFIER OUTAGE LEFT UNJUDGED ARE JUDGED ON THE DETECTION CLOCK (16 Nov 2026).
 *
 * MEASURED: DeepSeek answered `HTTP 402` (out of credit) on 8-10 and 13-16 Nov, and ~3,000 posts were
 * stored `UNCLASSIFIED` / `verdictSource: 'none'` — correctly — and then never asked again, because
 * the only thing that selected them was `pnpm ig:classify --run`. unjudged.ts judges them on the clock.
 *
 * Driven over a temporary SQLite file. The detector's caption call and `judgeWithFrame` are faked
 * (no network); everything this file is about — which rows are selected, in what order, how many,
 * when the pass stops, and that the write is conditional — runs for real.
 *
 * Mutations applied by hand once, each seen red, then restored:
 *   - dropping `humanLabel: null` from the conditional write fails "a label written without
 *     re-stamping the source…" (a real label also stamps `verdictSource: 'human'`, which the second
 *     condition catches on its own — so that case alone could not tell the first was gone);
 *   - dropping `verdictSource: 'none'` from it fails "a post the pipeline judged meanwhile…";
 *   - deleting the `break` after a call that did not answer fails "stops at the first post…";
 *   - dropping `target: { detectorKey }` from `unjudgedWhere` fails "a passthrough channel…".
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-unjudged-'))
const dbPath = join(dir, 'unjudged.db')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
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

/** The fake classifier: who it was asked about, whether it answers, and what it says. */
const fake = vi.hoisted(() => ({
  asked: [] as string[],
  ready: true,
  /** Shortcodes the classifier does not answer for. */
  noAnswer: new Set<string>(),
  /** Shortcodes the caption call calls paid. */
  paid: new Set<string>(),
  /** Shortcodes whose FOOTAGE raises an ordinary caption to paid. */
  footagePaid: new Set<string>(),
  /** Runs inside the caption call — a person acting on /paid-posts meanwhile. */
  during: null as null | ((shortcode: string) => Promise<void>),
}))

vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ tagsAsEvidence: false, publisherAsContext: false }) }))
vi.mock('@/detection/detectors/semantic', () => ({
  setChannelVocabulary: () => {},
  semanticDetector: {
    key: 'semantic',
    describe: 'fake',
    readiness: () => (fake.ready ? { ready: true } : { ready: false, reason: 'no key' }),
    async classify(post: { shortcode: string }) {
      fake.asked.push(post.shortcode)
      if (fake.during) await fake.during(post.shortcode)
      if (fake.noAnswer.has(post.shortcode)) {
        return { verdict: 'UNCLASSIFIED', confidence: 0, signals: ['detector:semantic', 'classifier:no-verdict'], brands: [], verdictSource: 'none' }
      }
      const isPaid = fake.paid.has(post.shortcode)
      return {
        verdict: isPaid ? 'CAMPAIGN' : 'ORGANIC',
        confidence: 92,
        signals: ['detector:semantic', 'model:deepseek-v4-flash'],
        brands: isPaid ? ['Nykaa'] : [],
        verdictSource: 'semantic',
        classifierModel: 'deepseek-v4-flash',
        classifierReason: isPaid ? 'a launch with a booking link' : 'paparazzi spotting',
      }
    },
  },
}))
vi.mock('@/detection/judge', () => ({
  async judgeWithFrame(input: { shortcode: string }, captionOnly: string) {
    const base = { frameText: null, frameSummary: null, engine: null, changedByFrame: false, secondLook: null, frameCallMade: false }
    if (captionOnly === 'ORGANIC' && fake.footagePaid.has(input.shortcode)) {
      return { ...base, verdict: 'CAMPAIGN', signals: ['frame:escalated-to-campaign'], frameText: 'on screen: SWITCH', changedByFrame: true, reason: 'judged' }
    }
    return { ...base, verdict: captionOnly, signals: ['frame:no-text'], reason: 'judged' }
  },
}))

const { prisma } = await import('@/lib/db')
const { judgeUnjudgedPosts, UNJUDGED_PASS_SIGNAL, unjudgedLogFields } = await import('@/detection/unjudged')

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

async function post(shortcode: string, hoursAgo: number, extra: Record<string, unknown> = {}) {
  return prisma.detectedCampaign.create({
    data: {
      targetId: 'tgt-viral',
      shortcode,
      permalink: `https://www.instagram.com/p/${shortcode}/`,
      postedAt: new Date(Date.now() - hoursAgo * 3600_000),
      caption: 'Kiara Advani at the launch of the new Nykaa store, book your slot now',
      verdict: 'UNCLASSIFIED',
      verdictSource: 'none',
      signals: '["detector:semantic","classifier:no-verdict"]',
      ...extra,
    },
  })
}
const row = (shortcode: string) => prisma.detectedCampaign.findUniqueOrThrow({ where: { shortcode } })

beforeEach(async () => {
  fake.asked = []
  fake.ready = true
  fake.noAnswer = new Set()
  fake.paid = new Set()
  fake.footagePaid = new Set()
  fake.during = null
  await prisma.detectedCampaign.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.targetAccount.createMany({
    data: [
      { id: 'tgt-viral', handle: 'viralbhayani', displayName: 'Viral Bhayani', detectorKey: 'semantic', role: 'WATCH' },
      { id: 'tgt-pass', handle: 'priyanshu123321123', displayName: 'Rehearsal', detectorKey: 'passthrough' },
    ],
  })
})

describe('judging what an outage left unjudged', () => {
  it('judges the newest first, within the bound, and says how many are left', async () => {
    await post('DcOldest01', 30)
    await post('DcMiddle01', 20)
    await post('DcNewest01', 10)
    fake.paid.add('DcNewest01')
    const s = await judgeUnjudgedPosts({ limit: 2 })
    expect(fake.asked).toEqual(['DcNewest01', 'DcMiddle01'])
    expect(s).toMatchObject({ examined: 2, judged: 2, campaigns: 1, stoppedBecause: null, remaining: 1 })
    const newest = await row('DcNewest01')
    expect(newest.verdict).toBe('CAMPAIGN')
    expect(newest.verdictSource).toBe('semantic')
    expect(newest.confidence).toBe(92)
    expect(newest.classifierReason).toBe('a launch with a booking link')
    expect(JSON.parse(newest.signals)).toEqual(['detector:semantic', 'model:deepseek-v4-flash', 'frame:no-text', UNJUDGED_PASS_SIGNAL])
    expect((await row('DcOldest01')).verdictSource).toBe('none')
    // The next pass picks up what this one left.
    fake.asked = []
    const again = await judgeUnjudgedPosts({ limit: 2 })
    expect(fake.asked).toEqual(['DcOldest01'])
    expect(again.remaining).toBe(0)
  })

  it('the footage still speaks: an ordinary caption the frame raises is stored paid, with what the frame read', async () => {
    await post('DcThaneBus', 5)
    fake.footagePaid.add('DcThaneBus')
    const s = await judgeUnjudgedPosts()
    expect(s.campaigns).toBe(1)
    const r = await row('DcThaneBus')
    expect(r.verdict).toBe('CAMPAIGN')
    expect(r.frameText).toBe('on screen: SWITCH')
  })

  it('merges the brands the row already holds with the ones the caption call named', async () => {
    await post('DcBrands01', 5, { brands: '["@sponsoredco"]' })
    fake.paid.add('DcBrands01')
    await judgeUnjudgedPosts()
    expect(JSON.parse((await row('DcBrands01')).brands)).toEqual(['@sponsoredco', 'Nykaa'])
  })

  it("Instagram's own paid flag in the stored payload makes it paid, recorded as a rule, as the pipeline does", async () => {
    await post('DcOfficial1', 5, { rawPayload: JSON.stringify({ isPaidPartnership: true, sponsorHandles: [], collabHandles: [] }) })
    await judgeUnjudgedPosts()
    const r = await row('DcOfficial1')
    expect(r.verdict).toBe('CAMPAIGN')
    expect(r.verdictSource).toBe('rules')
    expect(r.confidence).toBe(100)
    expect(JSON.parse(r.signals)).toContain('official:is_paid_partnership')
  })

  it('stops at the first post the classifier does not answer, and writes nothing about it', async () => {
    await post('DcFailsNow1', 5)
    await post('DcWouldWork', 6)
    fake.noAnswer.add('DcFailsNow1')
    const before = await row('DcFailsNow1')
    const s = await judgeUnjudgedPosts()
    expect(fake.asked).toEqual(['DcFailsNow1'])
    expect(s).toMatchObject({ examined: 1, judged: 0, stoppedBecause: 'classifier-did-not-answer', remaining: 2 })
    expect(await row('DcFailsNow1')).toEqual(before)
    // The outage ends: the next pass judges both.
    fake.noAnswer.clear()
    fake.asked = []
    const after = await judgeUnjudgedPosts()
    expect(fake.asked).toEqual(['DcFailsNow1', 'DcWouldWork'])
    expect(after.remaining).toBe(0)
  })

  it('asks nothing at all when this host has no classifier key, and still counts the backlog', async () => {
    await post('DcNoKey0001', 5)
    fake.ready = false
    const s = await judgeUnjudgedPosts()
    expect(fake.asked).toEqual([])
    expect(s).toMatchObject({ examined: 0, stoppedBecause: 'classifier-not-configured', remaining: 1 })
  })

  it('a passthrough channel is unjudged by design and is never selected', async () => {
    await post('DcPassThru1', 5, { targetId: 'tgt-pass' })
    const s = await judgeUnjudgedPosts()
    expect(fake.asked).toEqual([])
    expect(s.remaining).toBe(0)
    expect((await row('DcPassThru1')).verdictSource).toBe('none')
  })

  it('never selects a post a person answered, or one from before the detection cutoff', async () => {
    await post('DcLabelled1', 5, { humanLabel: true, labelledBy: 'tabish' })
    await post('DcHistory01', 0, { postedAt: new Date('2026-07-20T10:00:00Z') })
    const s = await judgeUnjudgedPosts()
    expect(fake.asked).toEqual([])
    expect(s.remaining).toBe(0)
  })

  it('never touches a post something already judged', async () => {
    await post('DcJudged001', 5, { verdict: 'ORGANIC', verdictSource: 'semantic', signals: '["detector:semantic"]' })
    await judgeUnjudgedPosts()
    expect(fake.asked).toEqual([])
  })

  it('a person who answers while it is being judged keeps their answer', async () => {
    await post('DcRaceLabel', 5)
    fake.paid.add('DcRaceLabel')
    fake.during = async (sc) => {
      await prisma.detectedCampaign.update({ where: { shortcode: sc }, data: { humanLabel: false, verdict: 'ORGANIC', verdictSource: 'human', labelledBy: 'tabish' } })
    }
    const s = await judgeUnjudgedPosts()
    expect(s).toMatchObject({ examined: 1, judged: 0, skippedChangedMeanwhile: 1 })
    const r = await row('DcRaceLabel')
    expect(r.humanLabel).toBe(false)
    expect(r.verdict).toBe('ORGANIC')
    expect(r.verdictSource).toBe('human')
  })

  it('a label written without re-stamping the source (a bulk script, say) still stands', async () => {
    await post('DcBulkLabel', 5)
    fake.paid.add('DcBulkLabel')
    fake.during = async (sc) => {
      await prisma.detectedCampaign.update({ where: { shortcode: sc }, data: { humanLabel: false, labelledBy: 'cli:bulk' } })
    }
    const s = await judgeUnjudgedPosts()
    expect(s.skippedChangedMeanwhile).toBe(1)
    const r = await row('DcBulkLabel')
    expect(r.humanLabel).toBe(false)
    expect(r.verdict).toBe('UNCLASSIFIED')
  })

  it('a post the pipeline judged meanwhile is not overwritten', async () => {
    await post('DcRacePipe1', 5)
    fake.paid.add('DcRacePipe1')
    fake.during = async (sc) => {
      await prisma.detectedCampaign.update({ where: { shortcode: sc }, data: { verdict: 'ORGANIC', verdictSource: 'semantic', classifierReason: 'from the pipeline' } })
    }
    const s = await judgeUnjudgedPosts()
    expect(s.skippedChangedMeanwhile).toBe(1)
    expect((await row('DcRacePipe1')).classifierReason).toBe('from the pipeline')
  })

  it('names each number in its log line', async () => {
    await post('DcLogLine01', 5)
    const fields = unjudgedLogFields(await judgeUnjudgedPosts())
    expect(fields).toEqual({ examined: 1, judged: 1, paid: 0, changedMeanwhile: 0, stopped: 'no', remaining: 0 })
  })
})

describe('the pipeline runs it — on the server, never on a Mac reading in its place', () => {
  const code = stripComments(readSource('src/detection/pipeline.ts'))
  it('is called with its own catch, after the failover early return', () => {
    const failover = code.indexOf("if (role === 'failover')")
    const call = code.indexOf('judgeUnjudgedPosts()')
    expect(failover).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(failover)
    expect(code.slice(call, call + 60)).toMatch(/^judgeUnjudgedPosts\(\)\s*\.catch\(/)
  })
})
