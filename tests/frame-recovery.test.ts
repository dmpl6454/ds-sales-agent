import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A POST JUDGED WITH NO FRAME IS RE-JUDGED ONCE ITS FRAME ARRIVES — and only then (16 Oct 2026).
 *
 * MEASURED IN PRODUCTION: the official read's full-size frames were refused by `saveFrame`, so post
 * after post was stored `frame:not-saved` — judged on its caption alone. `saveFrame` now shrinks
 * them; the frame then reaches disk on a later pass (the pipeline's known-post loop re-banks it) or
 * through `pnpm ig:frames --capture`. `rejudgeUnusedEvidence` is what reads it afterwards.
 *
 * Driven for real over a temporary SQLite file and a real frame directory (HOME is redirected, so
 * `hasFrame` checks real files); only the judge is faked, and it fakes the frame half of
 * `judgeWithFrame` faithfully: no file on disk → `frame:not-saved`, a person's label → refused.
 *
 * What this pins, and the mutation that fails each (applied by hand once, seen red, restored from a
 * scratch copy):
 *   - THE DISK CONDITION. A `frame:not-saved` post with NO frame here is never offered to the judge
 *     and nothing about it is written, and it cannot take a slot of the bound from one that has a
 *     frame. MUTATION: dropping the `hasFrame` filter in rejudge.ts fails "a post with no frame here
 *     is skipped…" and "the bound…";
 *   - THE HUMAN-LABEL EXCLUSION. A labelled post is never offered, even with its frame on disk.
 *     MUTATION: dropping `humanLabel: null` from `recoveryWhere` fails "a human-labelled post…";
 *   - THE DRY RUN WRITES NOTHING — the CLI's default mode, and the person's step after a deploy. The
 *     rows it proposes are compared whole before and after. MUTATION: deleting the `continue` in the
 *     dryRun branch (so a dry run falls through to `prisma.detectedCampaign.update`) fails "one bound
 *     over both populations…" (review, 16 Oct 2026 — before this the case checked only what the
 *     dry run RETURNED, and the mutation left every test green);
 *   - what the bound left behind is COUNTED (`recoverableNotReached`, `recoveryScanComplete`), and
 *     `rejudgeBacklog` counts the same rows without asking the judge at all;
 *   - the shared bound, newest first, over both populations;
 *   - the rewrite parses the signals array rather than substituting into the string;
 *   - A PERSON WHO ANSWERS WHILE THE POST IS BEING JUDGED KEEPS THEIR ANSWER (review, 16 Oct 2026). The
 *     fake judge labels the row as a side effect, exactly as /paid-posts would mid-judgement. MUTATION:
 *     the write back to `update({ where: { id: p.id } … })` (unconditional) fails "a person who labels
 *     the post while it is being judged keeps their answer";
 *   - `count: 0` IS NOT ALWAYS A PERSON: a post DELETED mid-judgement is `skippedRowRemoved` (log field
 *     `postRemovedMeanwhile`), never "a person answered". MUTATION: counting every `count: 0` as
 *     `skippedHumanAnswered` again fails "a post deleted while it is being judged…";
 *   - A RECOVERED ROW THAT READS NOTHING is counted as `skippedFrameHereNoVerdict` — never
 *     `skippedNoEvidence` ("not on this machine") — and is offered again next pass; the pass's log
 *     fields name it `frameHereNoVerdict`. MUTATION: dropping the `recoverableIds.has(p.id)` branch of
 *     the skip counters in rejudge.ts fails "a recovered row that reads nothing is counted as
 *     frame-here-no-verdict…".
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-frame-recovery-'))
const savedHome = process.env.HOME
process.env.HOME = dir
const dbPath = join(dir, 'recovery.db')
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

/**
 * The fake judge's behaviour, and every shortcode it was asked about. `during` runs inside the judge
 * call — a person acting on the dashboard while the post is being judged; `readsNothing` are
 * shortcodes whose frame is on disk but whose reading fails (`frame:ocr-failed`).
 */
const judge = vi.hoisted(() => ({
  asked: [] as string[],
  during: null as null | ((shortcode: string) => Promise<void>),
  readsNothing: new Set<string>(),
}))

vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ tagsAsEvidence: false, publisherAsContext: false }) }))
vi.mock('@/detection/judge', async () => {
  const { hasFrame } = await import('@/detection/media')
  return {
    async judgeWithFrame(input: { shortcode: string }, captionOnly: string, opts: { humanLabelled?: boolean } = {}) {
      judge.asked.push(input.shortcode)
      if (judge.during) await judge.during(input.shortcode)
      const base = { frameText: null, frameSummary: null, engine: null, changedByFrame: false, secondLook: null, frameCallMade: false }
      // The two refusals of the real judge this test is about, in its order: a person first.
      if (opts.humanLabelled) return { ...base, verdict: captionOnly, signals: [], reason: 'human-labelled' }
      if (!(await hasFrame(input.shortcode))) return { ...base, verdict: captionOnly, signals: ['frame:not-saved'], reason: 'judged' }
      if (judge.readsNothing.has(input.shortcode)) return { ...base, verdict: captionOnly, signals: ['frame:ocr-failed'], reason: 'judged' }
      return {
        ...base,
        verdict: 'CAMPAIGN',
        signals: ['frame:escalated-to-campaign', 'frame:says-campaign', 'frame:engine-rapidocr'],
        frameText: 'on screen: THANE’s First Double Decker Bus — in shot: SWITCH',
        changedByFrame: true,
        frameCallMade: true,
        reason: 'judged',
      }
    },
  }
})

const { prisma } = await import('@/lib/db')
const { rejudgeUnusedEvidence, rejudgeBacklog, rewriteFrameSignals, rejudgeLogFields, emptyRejudgeSummary } = await import('@/detection/rejudge')
const { FRAMES_DIR } = await import('@/lib/paths')

afterAll(async () => {
  await prisma.$disconnect()
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
})

const NOT_SAVED = '["detector:semantic","frame:not-saved"]'

async function post(shortcode: string, hoursAgo: number, extra: Record<string, unknown> = {}) {
  return prisma.detectedCampaign.create({
    data: {
      targetId: 'tgt-live',
      shortcode,
      permalink: `https://www.instagram.com/p/${shortcode}/`,
      postedAt: new Date(Date.now() - hoursAgo * 3600_000),
      caption: 'Thane just got its first double decker bus',
      verdict: 'ORGANIC',
      verdictSource: 'semantic',
      signals: NOT_SAVED,
      ...extra,
    },
  })
}
const putFrame = (shortcode: string) => {
  mkdirSync(FRAMES_DIR, { recursive: true })
  writeFileSync(join(FRAMES_DIR, `${shortcode}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
}
const row = (shortcode: string) => prisma.detectedCampaign.findUniqueOrThrow({ where: { shortcode } })

beforeEach(async () => {
  judge.asked = []
  judge.during = null
  judge.readsNothing = new Set()
  rmSync(FRAMES_DIR, { recursive: true, force: true })
  await prisma.detectedCampaign.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.targetAccount.createMany({
    data: [
      { id: 'tgt-live', handle: 'viralbhayani', displayName: 'Viral Bhayani', detectorKey: 'semantic' },
      { id: 'tgt-retired', handle: 'bollywoodsocietyy', displayName: 'Bollywood Society', detectorKey: 'semantic', optedOut: true },
    ],
  })
})

describe('the recovery: a frame:not-saved post whose frame is on this host now', () => {
  it('is re-judged through judgeWithFrame, and the not-saved mark is superseded by what was read', async () => {
    await post('DcThaneBus', 3)
    putFrame('DcThaneBus')
    const summary = await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual(['DcThaneBus'])
    expect(summary).toMatchObject({ examined: 1, changed: 1, recoveredFrames: 1 })
    const after = await row('DcThaneBus')
    expect(after.verdict).toBe('CAMPAIGN')
    expect(JSON.parse(after.signals)).toEqual(['detector:semantic', 'frame:escalated-to-campaign', 'frame:says-campaign', 'frame:engine-rapidocr'])
    expect(after.frameText).toMatch(/SWITCH/)
    // Re-run: the mark is gone, so it is never offered again.
    judge.asked = []
    await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual([])
  })

  it('a post with no frame here is skipped and nothing is written — it is not even offered to the judge', async () => {
    const before = await post('DcNoFrame1', 1)
    const summary = await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual([])
    expect(summary.examined).toBe(0)
    expect(await row('DcNoFrame1')).toEqual(before)
  })

  it('the bound: a newer frameless post cannot take the only slot from an older one whose frame arrived', async () => {
    await post('DcNoFrame2', 1)
    await post('DcHasFrame', 5)
    putFrame('DcHasFrame')
    await rejudgeUnusedEvidence({ limit: 1 })
    expect(judge.asked).toEqual(['DcHasFrame'])
    expect((await row('DcHasFrame')).verdict).toBe('CAMPAIGN')
    expect((await row('DcNoFrame2')).signals).toBe(NOT_SAVED)
  })

  it('a human-labelled post is never touched, even with its frame on disk', async () => {
    const before = await post('DcLabelled', 2, { humanLabel: false, verdictSource: 'human', labelledBy: 'tabish@dashmani.com' })
    putFrame('DcLabelled')
    await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual([])
    expect(await row('DcLabelled')).toEqual(before)
  })

  it('a retired channel is not offered — its judge call would be refused every pass forever', async () => {
    await post('DcRetired1', 2, { targetId: 'tgt-retired' })
    putFrame('DcRetired1')
    await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual([])
  })

  it('one bound over both populations, newest first; the dry run writes nothing; the default bound holds', async () => {
    const callFailBefore = await post('DcCallFail', 1, { signals: '["detector:semantic","frame:call-failed","frame:engine-rapidocr"]' })
    putFrame('DcCallFail')
    const recoverBefore: Awaited<ReturnType<typeof post>>[] = []
    for (let i = 0; i < 12; i++) {
      recoverBefore.push(await post(`DcRecover${String(i).padStart(2, '0')}`, 2 + i))
      putFrame(`DcRecover${String(i).padStart(2, '0')}`)
    }
    const two = await rejudgeUnusedEvidence({ limit: 2, dryRun: true })
    expect(judge.asked).toEqual(['DcCallFail', 'DcRecover00'])
    expect(two.recoveredFrames).toBe(1)
    // The dry run DECIDED both — and wrote neither. Both rows are compared whole.
    expect(two.proposals.map((p) => p.shortcode)).toEqual(['DcCallFail', 'DcRecover00'])
    expect(two.proposals.every((p) => p.from === 'ORGANIC' && p.to === 'CAMPAIGN')).toBe(true)
    expect(await row('DcCallFail')).toEqual(callFailBefore)
    expect(await row('DcRecover00')).toEqual(recoverBefore[0])
    // What the bound left: 11 more posts whose frame is here, and the scan saw every row.
    expect(two).toMatchObject({ recoverableNotReached: 11, recoveryScanComplete: true })

    judge.asked = []
    const pass = await rejudgeUnusedEvidence()
    expect(pass.examined).toBe(10)
    expect(judge.asked).toHaveLength(10)
    expect(pass.recoverableNotReached).toBe(3) // 12 recoverable, 9 of the 10 slots went to them
  })

  it('a scan window smaller than the population says so, and its count is only a floor', async () => {
    for (let i = 0; i < 4; i++) {
      await post(`DcWindow0${i}`, 1 + i)
      if (i === 3) putFrame(`DcWindow0${i}`) // the only frame here is on the OLDEST row
    }
    const s = await rejudgeUnusedEvidence({ recoveryScan: 3 })
    expect(judge.asked).toEqual([]) // the oldest row is beyond the 3-row window: not reached
    expect(s).toMatchObject({ examined: 0, recoverableNotReached: 0, recoveryScanComplete: false })
    const all = await rejudgeUnusedEvidence({ recoveryScan: 100_000, dryRun: true })
    expect(judge.asked).toEqual(['DcWindow03'])
    expect(all.recoveryScanComplete).toBe(true)
  })

  it('a person who labels the post while it is being judged keeps their answer', async () => {
    await post('DcRaceLbl1', 2)
    putFrame('DcRaceLbl1')
    let labelled: Awaited<ReturnType<typeof row>> | null = null
    // Between the selection (which saw humanLabel null) and the write: a person answers on /paid-posts.
    judge.during = async (shortcode) => {
      await prisma.detectedCampaign.update({
        where: { shortcode },
        data: { humanLabel: false, verdictSource: 'human', labelledBy: 'tabish@dashmani.com', labelledAt: new Date() },
      })
      labelled = await row(shortcode)
    }
    const summary = await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual(['DcRaceLbl1'])
    // The judge said CAMPAIGN; the person said ordinary. The person's answer stands, untouched.
    expect(summary).toMatchObject({ examined: 1, changed: 0, skippedHumanAnswered: 1, skippedRowRemoved: 0, skippedWriteUnmatched: 0 })
    expect(await row('DcRaceLbl1')).toEqual(labelled)
    expect(labelled!.verdict).toBe('ORGANIC')
    expect(labelled!.signals).toBe(NOT_SAVED)
    expect(rejudgeLogFields(summary).personAnsweredMeanwhile).toBe(1)
  })

  /**
   * The conditional write also matches nothing when the ROW is gone — a channel removed, its campaigns
   * cascading, while the post was being judged — and that is not a person's answer (review, 16 Oct 2026).
   * MUTATION (applied once, seen red, restored): counting every `count: 0` as `skippedHumanAnswered`
   * again in rejudge.ts fails this.
   */
  it('a post deleted while it is being judged is counted as removed, never as "a person answered"', async () => {
    await post('DcGoneMid1', 2)
    putFrame('DcGoneMid1')
    judge.during = async (shortcode) => {
      await prisma.detectedCampaign.delete({ where: { shortcode } })
    }
    const summary = await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual(['DcGoneMid1'])
    expect(summary).toMatchObject({ examined: 1, changed: 0, skippedRowRemoved: 1, skippedHumanAnswered: 0, skippedWriteUnmatched: 0 })
    expect(await prisma.detectedCampaign.findUnique({ where: { shortcode: 'DcGoneMid1' } })).toBeNull() // nothing recreated
    expect(rejudgeLogFields(summary)).toMatchObject({ postRemovedMeanwhile: 1, personAnsweredMeanwhile: 0, writeMatchedNothing: 0 })
  })

  it('a recovered row that reads nothing is counted as frame-here-no-verdict, never as no-frame-here, and is offered again', async () => {
    const before = await post('DcOcrDied1', 2)
    putFrame('DcOcrDied1')
    judge.readsNothing.add('DcOcrDied1')
    const summary = await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual(['DcOcrDied1'])
    expect(summary).toMatchObject({ examined: 1, recoveredFrames: 1, skippedFrameHereNoVerdict: 1, skippedNoEvidence: 0, skippedCallFailed: 0 })
    expect(await row('DcOcrDied1')).toEqual(before) // nothing written
    const fields = rejudgeLogFields(summary)
    expect(fields).toMatchObject({ frameHereNoVerdict: 1, noFrameHere: 0, callDidNotAnswer: 0 })
    // Retried next pass: the row still carries the mark and the frame is still here.
    judge.asked = []
    await rejudgeUnusedEvidence()
    expect(judge.asked).toEqual(['DcOcrDied1'])
  })

  it('a failed call (not a recovered row) still counts as callDidNotAnswer — the old split is intact', async () => {
    await post('DcCallAgain', 1, { signals: '["detector:semantic","frame:call-failed"]' })
    putFrame('DcCallAgain')
    judge.readsNothing.add('DcCallAgain')
    const summary = await rejudgeUnusedEvidence()
    expect(summary).toMatchObject({ examined: 1, recoveredFrames: 0, skippedCallFailed: 1, skippedFrameHereNoVerdict: 0 })
  })

  it('rejudgeBacklog counts both populations without asking the judge', async () => {
    await post('DcCallFail', 1, { signals: '["detector:semantic","frame:call-failed"]' })
    await post('DcHereNow1', 2)
    putFrame('DcHereNow1')
    await post('DcNotHere1', 3)
    const backlog = await rejudgeBacklog()
    expect(backlog).toEqual({ failedCalls: 1, recoverableHere: 1, scanComplete: true })
    expect(judge.asked).toEqual([])
  })
})

describe('rewriteFrameSignals', () => {
  it('replaces every retryable frame mark in the ARRAY, keeping the rest and de-duplicating', () => {
    expect(JSON.parse(rewriteFrameSignals('["a","frame:not-saved","second-look:judged"]', ['second-look:judged', 'frame:read-agreed']))).toEqual([
      'a',
      'second-look:judged',
      'frame:read-agreed',
    ])
    expect(JSON.parse(rewriteFrameSignals('["frame:call-failed","frame:ocr-failed"]', ['frame:no-text']))).toEqual(['frame:no-text'])
  })

  it('a cell that is not a JSON array keeps the old string substitution rather than being emptied', () => {
    expect(rewriteFrameSignals('detector:semantic frame:not-saved', ['frame:read-agreed'])).toBe('detector:semantic frame:read-agreed')
  })
})

describe('rejudgeLogFields — the names on the pass\'s log line', () => {
  it('names every skip reason by what it is, and the empty summary reports zero of each', () => {
    const fields = rejudgeLogFields({
      ...emptyRejudgeSummary(),
      examined: 9,
      skippedNoEvidence: 1,
      skippedCallFailed: 2,
      skippedFrameHereNoVerdict: 3,
      skippedHumanAnswered: 4,
      skippedRowRemoved: 8,
      skippedWriteUnmatched: 10,
      recoveredFrames: 5,
      recoverableNotReached: 6,
      remaining: 7,
    })
    expect(fields).toEqual({
      examined: 9,
      changed: 0,
      noFrameHere: 1,
      callDidNotAnswer: 2,
      frameHereNoVerdict: 3,
      personAnsweredMeanwhile: 4,
      postRemovedMeanwhile: 8,
      writeMatchedNothing: 10,
      frameArrivedLater: 5,
      framesWaiting: 6,
      remaining: 7,
    })
    expect(Object.values(rejudgeLogFields(emptyRejudgeSummary())).every((n) => n === 0)).toBe(true)
  })
})
