import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeFeedAnswer, type FeedAnswer, type FeedAnswerRow, type FeedAnswerRecord } from '@/detection/feedEvidence'
import { describeDetectionOutage, describeOfficialRead, lastCheckCause, type OutagePasses } from '@/app/view-model/detection-outage'
import { istTimeKey } from '@/lib/time'

/**
 * WHAT THE PAGE SAYS ABOUT THE OFFICIAL READ FALLBACK (15 Oct 2026). PURE — the rows are built
 * here, so every sentence is a row in a table.
 *
 *   1. the record's three new facts move the way the sentences need: a Graph `ok` starts
 *      `graphSince`, an anonymous `ok` ends it, a token or rate-limit answer ends it, and one
 *      channel's not-a-business answer does NOT (or one personal account on the watch list would
 *      restart the clock every pass). MUTATION (applied by hand, saw red, restored): making
 *      `stopsTheFallback` true for every failure kind fails "…one channel that is not a business
 *      account does not";
 *   2. the ATTENTION sentence while the API serves leads with the ANONYMOUS cause on record and
 *      says "refusing" only for a recorded refusal. MUTATION (applied by hand, saw red, restored):
 *      making `describeOfficialRead` always lead with "Instagram is refusing anonymous reads" fails
 *      "a 400 is not called a refusal";
 *   3. the blind-page sentences when the newest failure is the API's own — the token one in the
 *      exact words the operator was promised, and none of them an anonymous-feed sentence about a
 *      Graph answer;
 *   4. the rung order in view-model.ts: blind first, then the official-read attention line, then
 *      the paired-Mac line (whose sentence would be false while the SERVER reads through the API).
 */

const NOW = Date.parse('2026-10-15T09:00:00Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const answer = (over: Partial<FeedAnswer>): FeedAnswer => ({
  at: minsAgo(10),
  host: 'linode-detect',
  source: 'anonymous-app',
  handle: 'viralbhayani',
  kind: 'throttle',
  status: 401,
  contentType: 'application/json',
  head: '{"message":"Please wait a few minutes before you try again.","require_login":true}',
  items: null,
  ...over,
})
const graphOk = (at: string) => answer({ at, source: 'graph', kind: 'ok', status: 200, head: null, items: 3 })

describe('mergeFeedAnswer — the fallback facts', () => {
  const apply = (...as: FeedAnswer[]) => as.reduce<FeedAnswerRecord | null>((r, a) => mergeFeedAnswer(r, a), null)!

  it('a Graph ok after an anonymous refusal starts graphSince, and later ones keep it', () => {
    const refusal = answer({ at: minsAgo(30) })
    const r = apply(refusal, graphOk(minsAgo(29)), graphOk(minsAgo(14)))
    expect(r.graphSince).toBe(minsAgo(29))
    expect(r.graphOkAt).toBe(minsAgo(14))
    expect(r.lastAnonymousFailure).toEqual(refusal)
    expect(r.lastOkAt).toBe(minsAgo(14)) // a Graph page IS a feed page read
  })

  it('an anonymous ok ends it — the anonymous feed is reading again', () => {
    const r = apply(answer({ at: minsAgo(30) }), graphOk(minsAgo(29)), answer({ at: minsAgo(5), kind: 'ok', status: 200, head: null, items: 12 }))
    expect(r.graphSince).toBeNull()
    expect(r.graphOkAt).toBe(minsAgo(29))
  })

  it('a token or rate-limit answer ends it; one channel that is not a business account does not', () => {
    const base = [answer({ at: minsAgo(30) }), graphOk(minsAgo(29))] as const
    expect(apply(...base, answer({ at: minsAgo(20), source: 'graph', kind: 'graph-token', status: 400 })).graphSince).toBeNull()
    expect(apply(...base, answer({ at: minsAgo(20), source: 'graph', kind: 'graph-rate-limit', status: 400 })).graphSince).toBeNull()
    expect(apply(...base, answer({ at: minsAgo(20), source: 'graph', kind: 'graph-not-professional', status: 400 })).graphSince).toBe(minsAgo(29))
  })

  it('a Graph failure is the newest failure but never the anonymous one', () => {
    const anon = answer({ at: minsAgo(30), kind: 'http-error', status: 400 })
    const gfail = answer({ at: minsAgo(20), source: 'graph', kind: 'graph-error', status: 400 })
    const r = apply(anon, gfail)
    expect(r.lastFailure).toEqual(gfail)
    expect(r.lastAnonymousFailure).toEqual(anon)
  })
})

const passes = (rows: FeedAnswerRow[], over: Partial<OutagePasses> = {}): OutagePasses => ({
  feedOkAt: new Date(NOW - 5 * 60_000),
  throttledUntil: null,
  feedAnswers: rows,
  detectionHost: 'linode-detect',
  ...over,
})
const row = (over: Partial<FeedAnswerRow>): FeedAnswerRow => ({
  host: 'linode-detect',
  last: graphOk(minsAgo(5)),
  lastFailure: answer({ at: minsAgo(40) }),
  lastOkAt: minsAgo(5),
  lastAnonymousFailure: answer({ at: minsAgo(40) }),
  graphSince: minsAgo(40),
  graphOkAt: minsAgo(5),
  ...over,
})
const since = istTimeKey(new Date(NOW - 40 * 60_000))

describe('describeOfficialRead — the attention line while the API serves', () => {
  it('a recorded refusal: the sentence the operator was promised', () => {
    expect(describeOfficialRead(passes([row({})]), NOW)).toBe(
      `Instagram is refusing anonymous reads, so the server is reading channels through the official API (since ${since}); posts read this way carry no tag data.`,
    )
  })

  it('a 400 is not called a refusal', () => {
    const anon = answer({ at: minsAgo(40), kind: 'http-error', status: 400, head: '{"message":"SecFetch Policy violation."}' })
    const s = describeOfficialRead(passes([row({ lastAnonymousFailure: anon, lastFailure: anon })]), NOW)!
    expect(s).not.toMatch(/refusing/)
    expect(s).toBe(
      `Instagram stopped answering the server's anonymous feed reads the way it used to (HTTP 400: "SecFetch Policy violation."), so the server is reading channels through the official API (since ${since}); posts read this way carry no tag data.`,
    )
  })

  it('no anonymous failure on record (a row from before this build): "refusing" only with the recorded cooldown', () => {
    const bare = row({ lastAnonymousFailure: null })
    expect(describeOfficialRead(passes([bare], { throttledUntil: new Date(NOW + 600_000) }), NOW)).toMatch(/^Instagram is refusing anonymous reads, so/)
    expect(describeOfficialRead(passes([bare]), NOW)).toMatch(/^The anonymous feed is not serving channels, so/)
  })

  it('nothing to say when the fallback is not serving, or last served long ago', () => {
    expect(describeOfficialRead(passes([]), NOW)).toBeNull()
    expect(describeOfficialRead(passes([row({ graphSince: null })]), NOW)).toBeNull()
    expect(describeOfficialRead(passes([row({ graphOkAt: minsAgo(91) })]), NOW)).toBeNull()
  })

  it('names a host by its own name when no heartbeat says which is the server', () => {
    expect(describeOfficialRead(passes([row({})], { detectionHost: null }), NOW)).toMatch(/so linode-detect is reading channels/)
  })
})

describe('describeDetectionOutage — when the newest failure is the official API’s own', () => {
  const blind = (failure: FeedAnswer, over: Partial<FeedAnswerRow> = {}) =>
    describeDetectionOutage(
      passes([row({ last: failure, lastFailure: failure, lastOkAt: minsAgo(70), graphSince: null, graphOkAt: minsAgo(70), ...over })], {
        feedOkAt: new Date(NOW - 70 * 60_000),
        throttledUntil: new Date(NOW + 5 * 60_000),
      }),
      NOW,
    )
  const refusal = ' Instagram is refusing anonymous reads from the server (HTTP 401: "Please wait a few minutes before you try again.").'

  it('the token: the exact sentence, and the anonymous cause after it', () => {
    const f = answer({ at: minsAgo(8), source: 'graph', kind: 'graph-token', status: 400, head: '(#190) Error validating access token: Session has expired' })
    expect(blind(f)).toBe(`The official read token is invalid or expired — reading has stopped until it is replaced; no paid posts found for 70 min.${refusal}`)
  })

  it('the rate limit says when it retries', () => {
    const f = answer({ at: minsAgo(8), source: 'graph', kind: 'graph-rate-limit', status: 400, head: '(#4) Application request limit reached', until: new Date(NOW + 22 * 60_000).toISOString() })
    expect(blind(f)).toBe(
      `The official API asked the server to slow down (HTTP 400: "(#4) Application request limit reached") — no paid posts found for 70 min; it retries by itself at ${istTimeKey(new Date(NOW + 22 * 60_000))}.${refusal}`,
    )
  })

  it('not a business account names the channel', () => {
    const f = answer({ at: minsAgo(8), source: 'graph', kind: 'graph-not-professional', status: 400, head: '(#110) Invalid user id', handle: 'someperson' })
    expect(blind(f)).toMatch(/^The official API cannot read @someperson: it is not a Business or Creator account, or no such username exists/)
  })

  it("a refusal whose body was cut off says so, and never quotes our own note as Meta's words (cutOff.ts)", () => {
    const f = answer({ at: minsAgo(8), source: 'graph', kind: 'graph-rate-limit', status: 400, head: "the answer's body was cut off (aborted)", until: new Date(NOW + 22 * 60_000).toISOString() })
    const s = blind(f)
    expect(s).toMatch(/^The official API asked the server to slow down \(HTTP 400; its body was cut off\)/)
    expect(s).not.toMatch(/"the answer's body/)
  })

  it('no Graph failure is ever phrased as the anonymous feed "answering differently"', () => {
    for (const kind of ['graph-error', 'transport', 'shape', 'empty', 'not-json'] as const) {
      const s = blind(answer({ at: minsAgo(8), source: 'graph', kind, status: kind === 'transport' ? null : 400, head: 'x' }))
      expect(s, kind).toMatch(/official API/)
      expect(s, kind).not.toMatch(/^Instagram stopped answering/)
    }
  })

  it('lastCheckCause names the official API for its own failures', () => {
    const run = { startedAt: new Date(NOW - 10 * 60_000), finishedAt: new Date(NOW - 9 * 60_000), postsSeen: 0 }
    const p = (f: FeedAnswer) => passes([row({ last: f, lastFailure: f, lastOkAt: null, graphSince: null })], { feedOkAt: null })
    expect(lastCheckCause(p(answer({ at: minsAgo(9), source: 'graph', kind: 'graph-token', status: 400 })), run)).toBe('the official read token is invalid or expired')
    expect(lastCheckCause(p(answer({ at: minsAgo(9), source: 'graph', kind: 'graph-error', status: 403 })), run)).toBe('the official API answered HTTP 403')
  })
})

describe('the rung order on the landing page', () => {
  it('blind, then the official-read line, then the paired-Mac line', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'app', 'view-model.ts'), 'utf8')
    const ladder = src.slice(src.indexOf('} else if (detectionBlind(passes)) {'))
    const blind = ladder.indexOf('detectionBlind(passes)')
    const official = ladder.indexOf('} else if (officialRead !== null) {')
    const mac = ladder.indexOf('} else if (passes.throttledUntil) {')
    expect(blind).toBe(ladder.indexOf('detectionBlind('))
    expect(official).toBeGreaterThan(blind)
    expect(mac).toBeGreaterThan(official)
  })
})
