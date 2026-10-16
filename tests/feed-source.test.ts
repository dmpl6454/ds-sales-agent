import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * WHICH DOOR A CHANNEL IS READ THROUGH (src/detection/feedSource.ts, 15 Oct 2026).
 *
 * Two claims, each only provable by behaviour:
 *
 *   1. DORMANT MEANS TODAY. With the official read unconfigured — and with it configured but not
 *      this pass's to use (a Mac's failover) — `fetchChannelFeed` makes the SAME requests and
 *      throws the SAME errors as `fetchFeed`, scenario by scenario, compared side by side.
 *      MUTATION (applied by hand, saw red, restored): dropping `!graphConfigured()` from
 *      `officialReadAvailability` fails the six rows where the anonymous feed refuses, fails or
 *      reads nothing (only "a good page" stays green), because the unconfigured selector then
 *      tries the official API and throws its "not configured" error instead.
 *   2. THE ORDER TABLE, row by row — including the one with no second chance: a CLOSED anonymous
 *      gate plus a configured fallback makes ZERO anonymous requests. MUTATION (applied by hand,
 *      saw red, restored): deleting the `!gate.ok && canFallBack(opts)` early branch fails
 *      "closed anonymous gate" (the channel is then not read at all).
 *
 * No network: both endpoints are answered by one recording transport.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-feed-source-'))
const dbPath = join(dir, 'source.db')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()
process.env.DATABASE_URL = `file:${dbPath}`

const { prisma } = await import('@/lib/db')
const { fetchFeed, FeedFetchError } = await import('@/detection/feed')
const { fetchChannelFeed, officialReadAvailability } = await import('@/detection/feedSource')
const g = await import('@/detection/graphFeed')
const { anonGateRecordThrottle, resetAnonGate, setAnonGateClock } = await import('@/detection/anonGate')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
const fe = await import('@/detection/feedEvidence')

afterAll(async () => {
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-15T09:00:00Z')
const WALL = '{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}'
const anonPage = (n: number) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ code: `DcAnon${i}xx`, taken_at: 1_760_500_000 - i, caption: { text: 'hi' } })), more_available: false })
const graphPage = JSON.stringify({
  business_discovery: {
    username: 'viralbhayani',
    media: { data: [{ id: '1', caption: 'via graph', timestamp: '2026-10-15T08:00:00+0000', permalink: 'https://www.instagram.com/p/DcGraph01/', media_type: 'IMAGE', media_url: 'https://cdn.example/a.jpg' }], paging: { cursors: {} } },
  },
})

type Answer = { status: number; body: string; contentType?: string } | Error
type Call = { host: 'anonymous' | 'graph'; url: string; headers: Record<string, string> }
let calls: Call[] = []

/** One transport for both doors, routed by host, answering from a queue per door. */
function route(anon: Answer[], graph: Answer[] = []) {
  const q = { anonymous: [...anon], graph: [...graph] }
  setIgTransportForTests(async (url, init) => {
    const host = url.startsWith('https://graph.facebook.com/') ? 'graph' : 'anonymous'
    calls.push({ host, url, headers: { ...init.headers } })
    const next = q[host].shift()
    if (!next) throw new Error(`the test transport ran out of ${host} answers`)
    if (next instanceof Error) throw next
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      contentType: next.contentType ?? 'application/json',
      text: async () => next.body,
      json: async () => JSON.parse(next.body) as unknown,
    } satisfies IgResponse
  })
}

const configure = () => {
  vi.stubEnv('META_GRAPH_TOKEN', 'tok_test_only_1')
  vi.stubEnv('META_IG_USER_ID', '17841400000000999')
}
const unconfigure = () => {
  vi.stubEnv('META_GRAPH_TOKEN', '')
  vi.stubEnv('META_IG_USER_ID', '')
}

async function reset() {
  await fe.feedAnswersSettled()
  calls = []
  resetAnonGate()
  setAnonGateClock(() => NOW)
  g.resetGraphStateForTests()
  g.setGraphClockForTests(() => NOW)
  fe.resetFeedEvidenceForTests()
  await prisma.setting.deleteMany()
}

/** What a call did, in comparable form: the result, or the error's class and every flag. */
async function outcome(p: Promise<unknown>) {
  try {
    const r = (await p) as { posts: { shortcode: string }[]; pagesFetched: number; moreAvailable: boolean }
    return { ok: true, shortcodes: r.posts.map((x) => x.shortcode), pagesFetched: r.pagesFetched, moreAvailable: r.moreAvailable }
  } catch (err) {
    const e = err as InstanceType<typeof FeedFetchError>
    return { ok: false, name: e.name, message: e.message, isThrottle: e.isThrottle, isParseFailure: e.isParseFailure, isTransport: e.isTransport, until: e.until?.toISOString() ?? null }
  }
}

beforeEach(async () => {
  await reset()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
  setIgTransportForTests()
  setAnonGateClock()
  g.setGraphClockForTests()
})

/** An official-only reach as the pipeline sets it for a gap (officialReach.ts): far back, deep. */
const REACH = { officialSinceUnix: 1_759_000_000, officialMaxPosts: 150, officialMaxPages: 6 } as const

// ── 1. Dormant means today ────────────────────────────────────────────────────────────

const SCENARIOS: Array<[string, Answer[], boolean?]> = [
  ['a good page', [{ status: 200, body: anonPage(3) }]],
  ['a 401 login wall', [{ status: 401, body: WALL }]],
  ['a 200 carrying the login wall', [{ status: 200, body: '{"status":"fail","require_login":true}' }]],
  ['a 400 SecFetch', [{ status: 400, body: '{"message":"SecFetch Policy violation."}' }]],
  ['a 200 web page', [{ status: 200, body: '<!DOCTYPE html><html></html>', contentType: 'text/html' }]],
  ['a 200 with no posts', [{ status: 200, body: anonPage(0) }]],
  ['a closed gate', [], true],
]

describe('dormant: the selector is fetchFeed, request for request and error for error', () => {
  it.each(SCENARIOS)('%s', async (_name, answers, closeGate) => {
    const run = async (call: () => Promise<unknown>, setup: () => void) => {
      await reset()
      setup()
      if (closeGate) anonGateRecordThrottle('feed', 401)
      route(answers)
      const out = await outcome(call())
      return { out, calls: calls.map((c) => ({ url: c.url, headers: c.headers })) }
    }
    const today = await run(() => fetchFeed('viralbhayani', { maxPosts: 48, sinceUnix: 1_760_000_000 }), unconfigure)
    const unconfigured = await run(
      () => fetchChannelFeed('viralbhayani', { maxPosts: 48, sinceUnix: 1_760_000_000, allowGraph: true, graphBudget: { remaining: 60, used: 0, dropped: 0 } }),
      unconfigure,
    )
    const failoverPass = await run(
      () => fetchChannelFeed('viralbhayani', { maxPosts: 48, sinceUnix: 1_760_000_000, allowGraph: false, graphBudget: { remaining: 60, used: 0, dropped: 0 } }),
      configure,
    )
    // The official-only reach (16 Oct 2026) changes nothing where the official read is not in play.
    const unconfiguredWithReach = await run(
      () =>
        fetchChannelFeed('viralbhayani', {
          maxPosts: 48,
          sinceUnix: 1_760_000_000,
          ...REACH,
          allowGraph: true,
          graphBudget: { remaining: 60, used: 0, dropped: 0 },
        }),
      unconfigure,
    )
    expect(unconfigured).toEqual(today)
    expect(failoverPass).toEqual(today)
    expect(unconfiguredWithReach).toEqual(today)
    expect(calls.some((c) => c.host === 'graph')).toBe(false)
  })

  it('a transport failure, too (retries and all)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const fail = () => Array.from({ length: 4 }, () => new Error('getaddrinfo ENOTFOUND i.instagram.com'))
    const run = async (call: () => Promise<unknown>, setup: () => void) => {
      await reset()
      setup()
      route(fail())
      const p = outcome(call())
      await vi.runAllTimersAsync()
      return { out: await p, calls: calls.length }
    }
    const today = await run(() => fetchFeed('viralbhayani'), unconfigure)
    const selector = await run(() => fetchChannelFeed('viralbhayani', { allowGraph: true }), unconfigure)
    expect(selector).toEqual(today)
    expect(today.out).toMatchObject({ ok: false, isTransport: true })
  })
})

// ── 2. The order table, configured ─────────────────────────────────────────────────────

describe('configured: the order', () => {
  beforeEach(() => configure())
  const budget = () => ({ remaining: 60, used: 0, dropped: 0 })

  it('the anonymous feed answers → it serves, and the official API is never asked', async () => {
    route([{ status: 200, body: anonPage(2) }])
    const r = await fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() })
    expect(r.source).toBe('anonymous')
    expect(r.fallbackReason).toBeNull()
    expect(calls.map((c) => c.host)).toEqual(['anonymous'])
  })

  it.each([
    ['a 401 refusal', { status: 401, body: WALL }, true],
    ['a 400', { status: 400, body: '{"message":"SecFetch Policy violation."}' }, false],
    ['a web page', { status: 200, body: '<html></html>', contentType: 'text/html' }, false],
  ] as const)('%s → the official API serves the channel', async (_name, answer, refusal) => {
    route([answer], [{ status: 200, body: graphPage }])
    const b = budget()
    const r = await fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: b, delayMs: 0 })
    expect(r.source).toBe('graph')
    expect(r.evidenceIncomplete).toBe(true)
    expect(r.posts.map((p) => p.shortcode)).toEqual(['DcGraph01'])
    expect(r.anonymousError?.isThrottle).toBe(refusal)
    expect(r.fallbackReason).not.toMatch(/^\[@/)
    expect(calls.map((c) => c.host)).toEqual(['anonymous', 'graph'])
    expect(b).toEqual({ remaining: 59, used: 1, dropped: 0 })
  })

  it('a first page with no posts → the official API too (a watched channel never has none)', async () => {
    route([{ status: 200, body: anonPage(0) }], [{ status: 200, body: graphPage }])
    const r = await fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() })
    expect(r.source).toBe('graph')
    expect(r.fallbackReason).toBe('the anonymous feed answered with no posts')
  })

  it('a transport failure is re-thrown: the same broken network would not reach the official API either', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    route(Array.from({ length: 4 }, () => new Error('ECONNRESET')))
    const p = outcome(fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() }))
    await vi.runAllTimersAsync()
    expect(await p).toMatchObject({ ok: false, isTransport: true, name: 'FeedFetchError' })
    expect(calls.every((c) => c.host === 'anonymous')).toBe(true)
  })

  it('closed anonymous gate → ZERO anonymous requests, straight to the official API', async () => {
    anonGateRecordThrottle('feed', 401)
    route([], [{ status: 200, body: graphPage }])
    const r = await fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() })
    expect(r.source).toBe('graph')
    expect(r.anonymousError).toBeNull()
    expect(r.fallbackReason).toMatch(/no anonymous request made/)
    expect(calls.map((c) => c.host)).toEqual(['graph'])
  })

  it('closed anonymous gate and a PAUSED official API → today exactly: no request at all', async () => {
    anonGateRecordThrottle('feed', 401)
    // Pause the official path with a real rate-limit answer.
    route([], [{ status: 400, body: JSON.stringify({ error: { code: 4, message: 'Application request limit reached' } }) }])
    await g.fetchFeedViaGraph('someone').catch(() => undefined)
    calls = []
    expect(officialReadAvailability({ allowGraph: true })).toBe('paused')
    const out = await outcome(fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() }))
    expect(out).toMatchObject({ ok: false, name: 'FeedFetchError', isThrottle: true })
    expect((out as { message: string }).message).toMatch(/no request made/)
    expect(calls).toEqual([])
  })

  it('the call cap spent → the anonymous error stands, and the channel the cap cost is COUNTED', async () => {
    route([{ status: 401, body: WALL }])
    const b = { remaining: 0, used: 60, dropped: 0 }
    const out = await outcome(fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: b }))
    expect(out).toMatchObject({ ok: false, name: 'FeedFetchError', isThrottle: true })
    expect(b.dropped).toBe(1)
    expect(calls.map((c) => c.host)).toEqual(['anonymous'])
  })

  it('the official API failing too → its error, carrying the anonymous one', async () => {
    route([{ status: 401, body: WALL }], [{ status: 400, body: JSON.stringify({ error: { code: 110, message: 'Invalid user id' } }) }])
    const err = (await fetchChannelFeed('viralbhayani', { allowGraph: true, graphBudget: budget() }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err).toBeInstanceOf(g.GraphFeedError)
    expect(err.graphKind).toBe('graph-not-professional')
    expect(err.anonymousError?.isThrottle).toBe(true)
    expect(err.isThrottle).toBe(false)
  })
})

// ── 3. The official-only reach (16 Oct 2026, officialReach.ts) ─────────────────────────────

/**
 * `officialSinceUnix` / `officialMaxPosts` / `officialMaxPages` are what the pipeline sets for a
 * channel with a real gap and what `ig:backfill` sets for every channel. They must reach the OFFICIAL
 * read and never the anonymous one — the anonymous door's throttle is what volume earned.
 *
 * MUTATIONS (applied by hand, saw red, restored): `viaGraph` passing `o.sinceUnix` / `o.maxPosts` /
 * `o.maxPages` instead of the official-only values fails "the official-only fields reach the official
 * read"; `fetchChannelFeed`'s `feedOpts` taking `opts.officialSinceUnix ?? …` (or the official
 * post/page bound) fails "the anonymous door never sees them".
 */
describe('the official-only reach: the official read only', () => {
  beforeEach(() => configure())
  const budget = () => ({ remaining: 60, used: 0, dropped: 0 })
  const nowS = Math.floor(NOW / 1000)
  const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', '+0000')
  let n = 0
  /** One Business Discovery page: `ages` in minutes, newest first; `after` the next cursor, or none. */
  const graphAt = (ages: number[], after: string | null): Answer => ({
    status: 200,
    body: JSON.stringify({
      business_discovery: {
        username: 'viralbhayani',
        media: {
          data: ages.map((m) => ({ id: String(++n), caption: 'g', timestamp: iso(nowS - m * 60), permalink: `https://www.instagram.com/p/DcReach${n}x/`, media_type: 'IMAGE' })),
          paging: { cursors: after ? { after } : {} },
        },
      },
    }),
  })
  const graphCalls = () => calls.filter((c) => c.host === 'graph')
  const cursorOf = (c: Call) => decodeURIComponent(c.url).match(/media\.after\(([^)]+)\)/)?.[1] ?? null

  it('the official-only fields reach the official read — floor, post bound and page bound', async () => {
    // Page 1 ends 2 h back; page 2 ends 20 h back. The routine floor (1 h) stops after page 1.
    const pages = () => [graphAt([60, 120], 'p2'), graphAt([600, 1200], null)]
    const routine = { maxPosts: 48, sinceUnix: nowS - 3600, allowGraph: true, delayMs: 0 }

    route([{ status: 401, body: WALL }], pages())
    const today = await fetchChannelFeed('viralbhayani', { ...routine, graphBudget: budget() })
    expect(graphCalls()).toHaveLength(1)
    expect(today.posts).toHaveLength(2)

    await reset()
    configure()
    route([{ status: 401, body: WALL }], pages())
    const reached = await fetchChannelFeed('viralbhayani', { ...routine, officialSinceUnix: nowS - 30 * 3600, graphBudget: budget() })
    expect(reached.source).toBe('graph')
    expect(graphCalls().map(cursorOf)).toEqual([null, 'p2'])
    expect(reached.posts).toHaveLength(4)

    // The post bound: 25-post pages, all newer than any floor. `maxPosts: 48` stops at two pages;
    // `officialMaxPosts: 75` reads three; `officialMaxPages: 1` stops at one.
    const full = (k: number) => Array.from({ length: k }, (_, i) => graphAt(Array.from({ length: 25 }, (_, j) => 1 + i * 25 + j), `c${i + 2}`))
    for (const [extra, pagesExpected, postsExpected] of [
      [{}, 2, 48],
      [{ officialMaxPosts: 75 }, 3, 75],
      [{ officialMaxPosts: 150, officialMaxPages: 1 }, 1, 25],
    ] as const) {
      await reset()
      configure()
      route([{ status: 401, body: WALL }], full(6))
      const r = await fetchChannelFeed('viralbhayani', { ...routine, sinceUnix: nowS - 48 * 3600, ...extra, graphBudget: budget() })
      expect(graphCalls()).toHaveLength(pagesExpected)
      expect(r.posts).toHaveLength(postsExpected)
    }
  })

  it('… on every path to the official read: a closed gate, and an empty first page', async () => {
    anonGateRecordThrottle('feed', 401)
    route([], [graphAt([60, 120], 'p2'), graphAt([600], null)])
    await fetchChannelFeed('viralbhayani', { maxPosts: 48, sinceUnix: nowS - 3600, officialSinceUnix: nowS - 30 * 3600, allowGraph: true, delayMs: 0, graphBudget: budget() })
    expect(calls.map((c) => c.host)).toEqual(['graph', 'graph'])

    await reset()
    configure()
    route([{ status: 200, body: anonPage(0) }], [graphAt([60, 120], 'p2'), graphAt([600], null)])
    await fetchChannelFeed('viralbhayani', { maxPosts: 48, sinceUnix: nowS - 3600, officialSinceUnix: nowS - 30 * 3600, allowGraph: true, delayMs: 0, graphBudget: budget() })
    expect(calls.map((c) => c.host)).toEqual(['anonymous', 'graph', 'graph'])
  })

  /**
   * One field per row, so no bound masks another: each row's routine read stops on exactly the
   * bound its leaked official twin would lift, and the transport holds a second page that only a
   * leak would ask for.
   */
  const anonItems = (ages: number[]) => ages.map((h, i) => ({ code: `DcAnonR${h}${i}x`, taken_at: nowS - h * 3600, caption: { text: 'hi' } }))
  const anonAt = (ages: number[], more: boolean): Answer => ({
    status: 200,
    body: JSON.stringify({ items: anonItems(ages), more_available: more, ...(more ? { next_max_id: 'm2' } : {}) }),
  })
  it.each([
    // [what, routine options, the official twin, answers, the routine outcome]
    ['the floor', { maxPosts: 48, sinceUnix: nowS - 3 * 3600 }, { officialSinceUnix: nowS - 100 * 3600 }, [anonAt([2, 4, 6], true), anonAt([8], false)], 1, 3],
    ['the post bound', { maxPosts: 2, sinceUnix: nowS - 100 * 3600 }, { officialMaxPosts: 600 }, [anonAt([2, 4, 6], false)], 1, 2],
    ['the page bound', { maxPosts: 48, maxPages: 1, sinceUnix: nowS - 100 * 3600 }, { officialMaxPages: 24 }, [anonAt([2, 4, 6], true), anonAt([8], false)], 1, 3],
  ] as const)('the anonymous door never sees %s — same requests and answer as without it, and as fetchFeed', async (_what, routine, twin, answers, callsExpected, postsExpected) => {
    const run = async (call: () => Promise<unknown>) => {
      await reset()
      configure()
      route([...answers])
      const out = await outcome(call())
      return { out, calls: calls.map((c) => ({ host: c.host, url: c.url, headers: c.headers })) }
    }
    const today = await run(() => fetchFeed('viralbhayani', { ...routine, delayMs: 0 }))
    const without = await run(() => fetchChannelFeed('viralbhayani', { ...routine, delayMs: 0, allowGraph: true, graphBudget: budget() }))
    const withReach = await run(() => fetchChannelFeed('viralbhayani', { ...routine, ...twin, delayMs: 0, allowGraph: true, graphBudget: budget() }))
    expect(today.calls).toHaveLength(callsExpected)
    expect(today.out).toMatchObject({ ok: true })
    expect((today.out as { shortcodes: string[] }).shortcodes).toHaveLength(postsExpected)
    expect(without).toEqual(today)
    expect(withReach).toEqual(today)
  })
})

// ── 4. The official-only read (`pnpm ig:backfill --run`, review 16 Oct 2026) ───────────────────

/**
 * A backfill that tried the anonymous feed first worked only while that feed was refused: the day it
 * answers again, it would serve every channel its routine 48 posts and nothing would be backfilled —
 * while the dry run, reading Business Discovery directly, predicted otherwise. `officialOnly` asks the
 * official API and NEVER the anonymous feed, gate open or closed, and with the official read unusable
 * makes no request of EITHER door. MUTATIONS (applied by hand, saw red, restored): deleting the
 * `if (opts.officialOnly) …` line fails "gate open, anonymous answering"; returning `viaGraph` in
 * place of the throw fails "unusable, it throws and asks nobody" (a request is made, or the cap reads
 * as an empty answer); not counting `dropped` fails the cap row.
 */
describe('officialOnly: the official API and nothing else', () => {
  const budget = (remaining = 60) => ({ remaining, used: 0, dropped: 0 })
  const base = { maxPosts: 48, sinceUnix: 1_760_000_000, allowGraph: true, delayMs: 0, officialOnly: true } as const

  it('gate open, anonymous answering → only the official API is asked, and it serves', async () => {
    configure()
    route([{ status: 200, body: anonPage(12) }], [{ status: 200, body: graphPage }])
    const r = await fetchChannelFeed('viralbhayani', { ...base, graphBudget: budget() })
    expect(calls.map((c) => c.host)).toEqual(['graph'])
    expect(r.source).toBe('graph')
    expect(r.fallbackReason).toMatch(/official-only read \(pnpm ig:backfill\) — no anonymous request made/)
    expect(r.posts.map((p) => p.shortcode)).toEqual(['DcGraph01'])
  })

  it('gate closed → the official API, no anonymous request', async () => {
    configure()
    anonGateRecordThrottle('feed', 401)
    route([], [{ status: 200, body: graphPage }])
    const r = await fetchChannelFeed('viralbhayani', { ...base, graphBudget: budget() })
    expect(calls.map((c) => c.host)).toEqual(['graph'])
    expect(r.source).toBe('graph')
  })

  it.each([
    ['not this pass’s to use (allowGraph false)', () => configure(), { allowGraph: false }, 'not-configured', 0],
    ['not configured', () => unconfigure(), {}, 'not-configured', 0],
    ['the cap spent', () => configure(), { graphBudget: budget(0) }, 'cap-reached', 1],
  ] as const)('unusable — %s — it throws a GraphFeedError and asks nobody', async (_what, setup, over, kind, dropped) => {
    setup()
    route([{ status: 200, body: anonPage(12) }], [{ status: 200, body: graphPage }])
    const b = budget()
    const opts = { ...base, graphBudget: b, ...over }
    const err = (await fetchChannelFeed('viralbhayani', opts).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err).toBeInstanceOf(g.GraphFeedError)
    expect(err.graphKind).toBe(kind)
    expect(err.message).toMatch(/no request made/)
    expect(calls).toEqual([])
    expect((opts.graphBudget as { dropped: number }).dropped).toBe(dropped)
  })

  it('paused by a rate limit → a throttle-shaped GraphFeedError naming the pause, and no request', async () => {
    configure()
    // One real rate-limit answer sets the pause, exactly as a pass would meet it.
    route([], [{ status: 400, body: JSON.stringify({ error: { code: 4, message: 'Application request limit reached' } }) }])
    await g.fetchFeedViaGraph('voompla', { delayMs: 0, record: false }).catch(() => undefined)
    calls = []
    route([{ status: 200, body: anonPage(12) }], [{ status: 200, body: graphPage }])
    const err = (await fetchChannelFeed('viralbhayani', { ...base, graphBudget: budget() }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err.graphKind).toBe('paused')
    expect(err.isThrottle).toBe(true)
    expect(err.message).toMatch(/paused on this host until .*graph-rate-limit/)
    expect(calls).toEqual([])
  })

  it('absent or false is the order table, unchanged: gate open, anonymous answering → the anonymous feed serves', async () => {
    configure()
    route([{ status: 200, body: anonPage(12) }], [{ status: 200, body: graphPage }])
    const r = await fetchChannelFeed('viralbhayani', { ...base, officialOnly: false, graphBudget: budget() })
    expect(calls.map((c) => c.host)).toEqual(['anonymous'])
    expect(r.source).toBe('anonymous')
  })
})
