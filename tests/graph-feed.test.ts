import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE OFFICIAL READ PATH (src/detection/graphFeed.ts, 15 Oct 2026) — every shape here is FROM
 * META'S DOCUMENTATION. No call to graph.facebook.com has ever been made from this repo (no
 * token, and this container cannot resolve the host), so these pin what the code does with the
 * documented answers, not that the answers are what the documentation says. The first real
 * answer is `ig:probe --graph` on the box.
 *
 * What carries the weight, each driven both ways:
 *
 *   1. the URL — the field expression, the cursor, and that the builder never sees the token;
 *   2. the mapping — a shortcode from all three permalink forms (it is the row's identity, so a
 *      post read here and there lands on ONE row), and every post flagged evidence-incomplete;
 *   3. the error table — the subcode-33 "does not exist" is OUR account id, not theirs;
 *   4. THE TOKEN NEVER LEAVES — not in a thrown message, not in a log line, not in the evidence
 *      row, even when a transport error or Meta's own message carries it. MUTATION (applied by
 *      hand, saw red, restored): deleting the literal-token replacement in `scrub` fails
 *      "a token echoed by the transport or by Meta never leaves this file" — the test token is
 *      deliberately one feedEvidence's generic shapes do NOT catch;
 *   5. the 30-minute pause after a rate limit, with an injected clock, and that a paused path
 *      makes ZERO requests. MUTATION (applied by hand, saw red, restored): deleting the
 *      `paused = …` line in the rate-limit branch fails "a rate limit pauses the path".
 *   6. ONE token alarm per process. MUTATION (applied by hand, saw red, restored): deleting the
 *      `if (!tokenAlarmed)` guard fails "the token alarm is raised once per process".
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-graph-feed-'))
const dbPath = join(dir, 'graph.db')
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
const savedDevice = process.env.DS_DEVICE_NAME
process.env.DS_DEVICE_NAME = 'linode-detect'

const { prisma } = await import('@/lib/db')
const g = await import('@/detection/graphFeed')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
const fe = await import('@/detection/feedEvidence')
const { REQUEST_TIMEOUT_MS } = await import('@/detection/feed')

afterAll(async () => {
  // Evidence writes are fire-and-forget; let the last ones land before the file goes.
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

/** Short, not EAA-shaped, under 32 characters — so ONLY the literal-token scrub can catch it. */
const TOKEN = 'tok_SECRET_value_9'
const IG_USER_ID = '17841400000000999'

/** A Business Discovery answer in the documented shape. */
function docAnswer(over: { username?: string; data?: unknown[]; after?: string | null } = {}) {
  return {
    business_discovery: {
      username: over.username ?? 'viralbhayani',
      media: {
        data: over.data ?? [
          {
            id: '17900000000000001',
            caption: 'Out now on Prime Video #TheTraitors',
            timestamp: '2026-10-15T08:01:02+0000',
            permalink: 'https://www.instagram.com/reel/DcAAAAAAAA1/',
            media_type: 'VIDEO',
            media_product_type: 'REELS',
            media_url: 'https://scontent.example/v1.mp4',
            thumbnail_url: 'https://scontent.example/t1.jpg',
            like_count: 120,
            comments_count: 4,
          },
          {
            id: '17900000000000002',
            caption: 'Spotted at the airport',
            timestamp: '2026-10-15T07:30:00+0000',
            permalink: 'https://www.instagram.com/p/DcBBBBBBBB2/',
            media_type: 'IMAGE',
            media_product_type: 'FEED',
            media_url: 'https://scontent.example/i2.jpg',
            comments_count: 0,
            // like_count absent: the owner hid likes
          },
          {
            id: '17900000000000003',
            timestamp: '2026-10-15T07:00:00+0000',
            permalink: 'https://www.instagram.com/tv/DcCCCCCCCC3/',
            media_type: 'CAROUSEL_ALBUM',
            media_product_type: 'FEED',
            media_url: 'https://scontent.example/c3.mp4',
          },
          // No permalink: no shortcode, so no row identity — dropped and counted.
          { id: '17900000000000004', timestamp: '2026-10-15T06:00:00+0000', media_type: 'IMAGE' },
        ],
        paging: over.after === null ? { cursors: { before: 'QVFIUmJlZm9yZQ' } } : { cursors: { before: 'QVFIUmJlZm9yZQ', after: over.after ?? 'QVFIUmFmdGVy' } },
      },
      id: '17841400000000001',
    },
    id: IG_USER_ID,
  }
}

describe('buildBusinessDiscoveryUrl — PURE, and it never sees the token', () => {
  const o = { igUserId: IG_USER_ID, version: 'v25.0', limit: 25 }
  const fieldsOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get('fields') ?? '')

  it('asks for the username beside the media, on our own account id', () => {
    const url = g.buildBusinessDiscoveryUrl('viralbhayani', o)
    expect(url.startsWith(`https://graph.facebook.com/v25.0/${IG_USER_ID}?fields=`)).toBe(true)
    expect(fieldsOf(url)).toBe(
      'business_discovery.username(viralbhayani){username,media.limit(25){id,caption,timestamp,permalink,media_type,media_product_type,media_url,thumbnail_url,like_count,comments_count}}',
    )
    expect(url).not.toMatch(/access_token/)
  })

  it('puts the cursor on the media edge for the next page', () => {
    expect(fieldsOf(g.buildBusinessDiscoveryUrl('viralbhayani', { ...o, after: 'QVFIUmFmdGVy' }))).toContain('media.after(QVFIUmFmdGVy).limit(25){')
  })

  it('clamps the page size', () => {
    expect(fieldsOf(g.buildBusinessDiscoveryUrl('a.b_c', { ...o, limit: 1000 }))).toContain('media.limit(100)')
    expect(fieldsOf(g.buildBusinessDiscoveryUrl('a.b_c', { ...o, limit: 0 }))).toContain('media.limit(1)')
  })

  it('refuses anything that could rewrite the field expression', () => {
    expect(() => g.buildBusinessDiscoveryUrl('x){media', o)).toThrow(/not an Instagram username/)
    expect(() => g.buildBusinessDiscoveryUrl('x y', o)).toThrow(/not an Instagram username/)
    expect(() => g.buildBusinessDiscoveryUrl('ok', { ...o, after: 'abc){id' })).toThrow(/cursor/)
    expect(() => g.buildBusinessDiscoveryUrl('ok', { ...o, igUserId: '12ab' })).toThrow(/numeric/)
    expect(() => g.buildBusinessDiscoveryUrl('ok', { ...o, version: '25' })).toThrow(/version/)
  })
})

describe('shortcodeFromPermalink — the row identity both sources share', () => {
  it.each([
    ['https://www.instagram.com/p/DcBBBBBBBB2/', 'DcBBBBBBBB2'],
    ['https://www.instagram.com/reel/DcAAAAAAAA1/', 'DcAAAAAAAA1'],
    ['https://www.instagram.com/reels/DcAAAAAAAA1/', 'DcAAAAAAAA1'],
    ['https://www.instagram.com/tv/DcCCCCCCCC3/', 'DcCCCCCCCC3'],
    ['https://instagram.com/p/Dc_-abc123?igsh=x', 'Dc_-abc123'],
    ['https://www.instagram.com/viralbhayani/p/DcBBBBBBBB2/', 'DcBBBBBBBB2'],
  ])('%s', (permalink, code) => {
    expect(g.shortcodeFromPermalink(permalink)).toBe(code)
  })
  it.each([[null], [''], ['https://www.instagram.com/viralbhayani/'], ['https://evil.example/p/DcBBBBBBBB2/'], ['https://www.instagram.com/p/abc/']])(
    'no shortcode in %s',
    (permalink) => {
      expect(g.shortcodeFromPermalink(permalink)).toBeNull()
    },
  )
})

describe('parseBusinessDiscovery — the documented answer, mapped onto FeedPost', () => {
  it('maps every field the way feed.ts does, and flags the evidence INCOMPLETE', () => {
    const r = g.parseBusinessDiscovery(docAnswer(), 'viralbhayani')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.evidenceIncomplete).toBe(true)
    expect(r.after).toBe('QVFIUmFmdGVy')
    expect(r.dropped).toBe(1)
    expect(r.posts.map((p) => p.shortcode)).toEqual(['DcAAAAAAAA1', 'DcBBBBBBBB2', 'DcCCCCCCCC3'])
    expect(r.posts[0]).toEqual({
      shortcode: 'DcAAAAAAAA1',
      permalink: 'https://www.instagram.com/p/DcAAAAAAAA1/', // feed.ts's own form, so both write one row
      ownerHandle: 'viralbhayani',
      caption: 'Out now on Prime Video #TheTraitors',
      likeCount: 120,
      commentCount: 4,
      postedAt: new Date('2026-10-15T08:01:02Z'),
      gridIndex: 0,
      isPaidPartnership: false,
      sponsorHandles: [],
      collabHandles: [],
      taggedAccounts: [],
      mediaType: 'clips',
      thumbnailUrl: 'https://scontent.example/t1.jpg',
      videoUrl: 'https://scontent.example/v1.mp4',
      videoDurationSeconds: null,
      evidenceIncomplete: true,
    })
    // An image is its own cover; hidden likes are unknown, not zero.
    expect(r.posts[1]).toMatchObject({ mediaType: 'feed', likeCount: null, commentCount: 0, thumbnailUrl: 'https://scontent.example/i2.jpg', videoUrl: null })
    // A carousel's media_url may be its first child's VIDEO: never taken as a frame.
    expect(r.posts[2]).toMatchObject({ mediaType: 'carousel_container', caption: '', thumbnailUrl: null, videoUrl: null })
    expect(r.posts.every((p) => p.evidenceIncomplete === true)).toBe(true)
  })

  it('continues grid indices from the offset it is given', () => {
    const r = g.parseBusinessDiscovery(docAnswer(), 'viralbhayani', 25)
    expect(r.ok && r.posts.map((p) => p.gridIndex)).toEqual([25, 26, 27])
  })

  it('an empty page has no next page, whatever cursor rode along', () => {
    const r = g.parseBusinessDiscovery(docAnswer({ data: [] }), 'viralbhayani')
    expect(r).toEqual({ ok: true, posts: [], after: null, dropped: 0, evidenceIncomplete: true })
  })

  it('no media edge reads as an empty page, not a changed shape', () => {
    expect(g.parseBusinessDiscovery({ business_discovery: { username: 'x', id: '1' } }, 'x')).toMatchObject({ ok: true, posts: [] })
  })

  it('an answer about a different account is refused — existence is not identity', () => {
    expect(g.parseBusinessDiscovery(docAnswer({ username: 'viralbhayani2' }), 'viralbhayani')).toEqual({
      ok: false,
      why: 'the answer describes @viralbhayani2, not @viralbhayani',
    })
    // Case is not identity.
    expect(g.parseBusinessDiscovery(docAnswer({ username: 'ViralBhayani' }), 'viralbhayani').ok).toBe(true)
  })

  it.each([[null], ['nope'], [[]], [{}], [{ business_discovery: { media: { data: 'x' } } }], [{ business_discovery: { media: [] } }]])(
    'refuses a shape it does not know: %j',
    (json) => {
      expect(g.parseBusinessDiscovery(json, 'x').ok).toBe(false)
    },
  )
})

describe('classifyGraphError — the documented codes, and the order that matters', () => {
  const err = (e: Record<string, unknown>) => ({ error: { type: 'OAuthException', fbtrace_id: 'A1', ...e } })
  const rows: Array<[string, number, unknown, string, 'all' | 'channel']> = [
    ['190 invalid token', 400, err({ code: 190, message: 'Invalid OAuth access token - Cannot parse access token' }), 'graph-token', 'all'],
    ['190/463 expired', 400, err({ code: 190, error_subcode: 463, message: 'Error validating access token: Session has expired' }), 'graph-token', 'all'],
    ['4 app limit', 400, err({ code: 4, message: 'Application request limit reached' }), 'graph-rate-limit', 'all'],
    ['17 user limit', 400, err({ code: 17, message: 'User request limit reached' }), 'graph-rate-limit', 'all'],
    ['32 page limit', 400, err({ code: 32, message: 'Page request limit reached' }), 'graph-rate-limit', 'all'],
    ['613 custom', 400, err({ code: 613, message: 'Calls to this api have exceeded the rate limit.' }), 'graph-rate-limit', 'all'],
    ['80002 Instagram BUC', 400, err({ code: 80002, message: 'There have been too many calls to this Instagram account.' }), 'graph-rate-limit', 'all'],
    ['a bare 429', 429, undefined, 'graph-rate-limit', 'all'],
    ['10 permission', 403, err({ code: 10, message: 'Application does not have permission for this action' }), 'graph-error', 'all'],
    ['200 permission', 403, err({ code: 200, message: 'Permissions error' }), 'graph-error', 'all'],
    ['100/33 OUR id is wrong', 400, err({ code: 100, error_subcode: 33, message: "Unsupported get request. Object with ID '1784' does not exist, cannot be loaded due to missing permissions" }), 'graph-error', 'all'],
    ['110 invalid user id', 400, err({ code: 110, message: 'Invalid user id' }), 'graph-not-professional', 'channel'],
    ['100/2207013 cannot find user', 400, err({ code: 100, error_subcode: 2207013, message: 'Invalid parameter' }), 'graph-not-professional', 'channel'],
    ['100 "Cannot find User"', 400, err({ code: 100, message: 'Cannot find User with username x' }), 'graph-not-professional', 'channel'],
    // MEASURED on the box, 15 Oct 2026 (curl, verbatim bodies, fbtrace ids dropped):
    ['measured: 110/2207013 personal account', 400, { error: { message: 'Invalid user id', type: 'OAuthException', code: 110, error_subcode: 2207013, is_transient: false } }, 'graph-not-professional', 'channel'],
    ['measured: 100/33 empty account id', 400, { error: { message: 'Unsupported get request. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api', type: 'GraphMethodException', code: 100, error_subcode: 33 } }, 'graph-error', 'all'],
    ['measured: 2500 empty token', 400, { error: { message: 'An active access token must be used to query information about the current user.', type: 'OAuthException', code: 2500 } }, 'graph-token', 'all'],
    ['2500 unknown path components', 400, err({ code: 2500, message: 'Unknown path components: /business_discovery' }), 'graph-error', 'all'],
    ['1 unknown', 500, err({ code: 1, message: 'An unknown error occurred' }), 'graph-error', 'channel'],
    ['a proxy 502 page', 502, undefined, 'graph-error', 'channel'],
  ]
  it.each(rows)('%s', (_name, status, json, kind, scope) => {
    const v = g.classifyGraphError(status, json)
    expect(v.kind).toBe(kind)
    expect(v.scope).toBe(scope)
  })

  it("keeps Meta's words with the code, redacted, and nothing else", () => {
    const v = g.classifyGraphError(400, err({ code: 190, message: 'Bad token EAAGm0PX4ZCpsBAxyz9 given' }))
    expect(v.message).toBe('(#190) Bad token [redacted] given')
    expect(g.classifyGraphError(502, undefined).message).toBe('HTTP 502')
  })
})

// ── Through the transport and the real Setting table ──────────────────────────────────

type Call = { url: string; headers: Record<string, string>; timeoutMs: number }
const calls: Call[] = []
const json = (status: number, body: unknown): IgResponse => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, ok: status >= 200 && status < 300, contentType: 'application/json', text: async () => text, json: async () => JSON.parse(text) as unknown }
}
function script(...answers: Array<IgResponse | Error>) {
  const queue = [...answers]
  setIgTransportForTests(async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, timeoutMs: init.timeoutMs })
    const next = queue.shift()
    if (!next) throw new Error('the test transport ran out of answers')
    if (next instanceof Error) throw next
    return next
  })
}

async function evidenceRow(): Promise<string> {
  await fe.feedAnswersSettled()
  const row = await prisma.setting.findUnique({ where: { key: fe.feedAnswerKey() } })
  return row?.value ?? ''
}

describe('fetchFeedViaGraph', () => {
  let now = Date.parse('2026-10-15T09:00:00Z')
  const out: string[] = []
  beforeEach(async () => {
    // A write the previous test fired and did not wait for must land BEFORE this test's wipe.
    await fe.feedAnswersSettled()
    calls.length = 0
    out.length = 0
    now = Date.parse('2026-10-15T09:00:00Z')
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', IG_USER_ID)
    vi.stubEnv('META_GRAPH_VERSION', 'v25.0')
    g.resetGraphStateForTests()
    g.setGraphClockForTests(() => now)
    fe.resetFeedEvidenceForTests()
    await prisma.setting.deleteMany()
    for (const m of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        out.push(args.map(String).join(' '))
      })
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    g.setGraphClockForTests()
    setIgTransportForTests()
  })

  it('is dormant until both keys are set', async () => {
    vi.stubEnv('META_GRAPH_TOKEN', '')
    expect(g.graphConfigured()).toBe(false)
    const err = await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(g.GraphFeedError)
    expect((err as InstanceType<typeof g.GraphFeedError>).graphKind).toBe('not-configured')
    expect(calls).toHaveLength(0)
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', 'not-digits')
    expect(g.graphConfigured()).toBe(false)
  })

  it('sends only Accept, a bounded timeout, and the token in the query — never the anonymous identity', async () => {
    script(json(200, docAnswer({ after: null })))
    const r = await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers).toEqual({ Accept: 'application/json' })
    // Its own bound, longer than the anonymous feed's: a page of 25 media nodes is a heavier request.
    expect(calls[0]!.timeoutMs).toBe(g.GRAPH_REQUEST_TIMEOUT_MS)
    expect(g.GRAPH_REQUEST_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
    expect(new URL(calls[0]!.url).searchParams.get('access_token')).toBe(TOKEN)
    expect(r).toMatchObject({ pagesFetched: 1, moreAvailable: false, evidenceIncomplete: true })
    expect(r.posts).toHaveLength(3)
    // Recorded as the official source, first page only.
    const rec = fe.parseFeedAnswerRecord(await evidenceRow())!
    expect(rec.last).toMatchObject({ source: 'graph', kind: 'ok', items: 3, status: 200, handle: 'viralbhayani' })
    expect(rec.graphSince).toBe(rec.last.at)
  })

  it('pages with the cursor until there is none, and spends the budget one call at a time', async () => {
    const second = docAnswer({ after: null, data: [{ id: '9', caption: 'older', timestamp: '2026-10-14T08:00:00+0000', permalink: 'https://www.instagram.com/p/DcDDDDDDDD4/', media_type: 'IMAGE', media_url: 'https://scontent.example/i4.jpg' }] })
    script(json(200, docAnswer()), json(200, second))
    const budget = { remaining: 60, used: 0, dropped: 0 }
    const r = await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget })
    expect(calls).toHaveLength(2)
    expect(decodeURIComponent(calls[1]!.url)).toContain('media.after(QVFIUmFmdGVy).limit(25)')
    expect(r.posts.map((p) => p.gridIndex)).toEqual([0, 1, 2, 3])
    expect(budget).toEqual({ remaining: 58, used: 2, dropped: 0 })
  })

  it('stops paging once a page reaches past `sinceUnix`, cursor or not', async () => {
    script(json(200, docAnswer()))
    await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, sinceUnix: Date.parse('2026-10-15T07:45:00Z') / 1000 })
    expect(calls).toHaveLength(1)
  })

  it('stops at the budget mid-channel and keeps what it read', async () => {
    script(json(200, docAnswer()))
    const budget = { remaining: 1, used: 0, dropped: 0 }
    const r = await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget })
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({ pagesFetched: 1, moreAvailable: true })
    expect(budget.remaining).toBe(0)
  })

  /**
   * ONE SLOW PAGE NO LONGER COSTS A CHANNEL (16 Oct 2026, GRAPH_REQUEST_TIMEOUT_MS). The box's first
   * backfill lost @rvcjinsta and @instantbollywood whole, each to one `timed out after 12000 ms`.
   * MUTATIONS (applied once, seen red, restored): `GRAPH_TRANSPORT_RETRIES = 0` fails the first case;
   * dropping the budget condition fails "the retry is never made past the budget"; retrying a non-ok
   * answer (`if (!res.ok && attempt < retries) continue`) fails "an ANSWER is never re-asked" and the
   * three refusal cases below it. From the review the same day: recording a transport failure on every
   * attempt fails the first case's evidence assertions; `remaining <= 1` fails "…when one call is
   * left"; dropping the pause fails "waits the page spacing"; dropping the second pause check fails
   * "a rate limit set meanwhile".
   */
  it('a page that times out is tried once more, charged to the budget, and the channel is kept', async () => {
    const second = docAnswer({ after: null, data: [{ id: '9', caption: 'older', timestamp: '2026-10-14T08:00:00+0000', permalink: 'https://www.instagram.com/p/DcDDDDDDDD4/', media_type: 'IMAGE', media_url: 'https://scontent.example/i4.jpg' }] })
    script(json(200, docAnswer()), new Error('timed out after 30000 ms'), json(200, second))
    const budget = { remaining: 60, used: 0, dropped: 0 }
    const r = await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget })
    expect(calls).toHaveLength(3)
    // The retry asked for the SAME page: the second page's cursor, twice.
    expect(calls[2]!.url).toBe(calls[1]!.url)
    expect(r.posts.map((p) => p.gridIndex)).toEqual([0, 1, 2, 3])
    expect(r.pagesFetched).toBe(2)
    expect(budget).toEqual({ remaining: 57, used: 3, dropped: 0 })
    expect(out.join('\n')).toMatch(/trying the same page once more/)
    expect(out.join('\n')).not.toContain(TOKEN)
    // A read that recovered is not on record as a failure: the banner must not say "could not be reached".
    const rec = fe.parseFeedAnswerRecord(await evidenceRow())!
    expect(rec.last).toMatchObject({ source: 'graph', kind: 'ok' })
    expect(rec.lastFailure).toBeNull()
  })

  it('the retry is made when exactly one call is left, and spends it', async () => {
    script(new Error('timed out after 30000 ms'), json(200, docAnswer({ after: null })))
    const budget = { remaining: 2, used: 0, dropped: 0 }
    const r = await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget })
    expect(calls).toHaveLength(2)
    expect(r.posts).toHaveLength(3)
    expect(budget).toEqual({ remaining: 0, used: 2, dropped: 0 })
  })

  it("waits the read's page spacing between the two tries", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      script(new Error('timed out after 30000 ms'), json(200, docAnswer({ after: null })))
      const read = g.fetchFeedViaGraph('viralbhayani', { delayMs: 1000 })
      await vi.advanceTimersByTimeAsync(999)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await read
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rate limit set meanwhile by another read is not spent into — the retry is not made', async () => {
    // While this page's first try fails, another read in the same process is rate-limited.
    setIgTransportForTests(async (url, init) => {
      calls.push({ url, headers: { ...init.headers }, timeoutMs: init.timeoutMs })
      if (decodeURIComponent(url).includes('business_discovery.username(otherpage)')) {
        return json(400, { error: { code: 4, message: 'Application request limit reached', type: 'OAuthException' } })
      }
      await g.fetchFeedViaGraph('otherpage', { delayMs: 0 }).catch(() => undefined)
      throw new Error('timed out after 30000 ms')
    })
    const budget = { remaining: 60, used: 0, dropped: 0 }
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls.filter((c) => decodeURIComponent(c.url).includes('business_discovery.username(viralbhayani)'))).toHaveLength(1)
    expect(err.graphKind).toBe('paused')
    expect(err.isThrottle).toBe(true)
    expect(err.message).toMatch(/the retry of this page was not made/)
    // Not charged: no second request was made.
    expect(budget).toEqual({ remaining: 59, used: 1, dropped: 0 })
  })

  it('a pause set DURING the wait before the retry is not spent into, and the log says the retry was not made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      setIgTransportForTests(async (url, init) => {
        calls.push({ url, headers: { ...init.headers }, timeoutMs: init.timeoutMs })
        if (decodeURIComponent(url).includes('business_discovery.username(otherpage)')) {
          return json(400, { error: { code: 4, message: 'Application request limit reached', type: 'OAuthException' } })
        }
        throw new Error('timed out after 30000 ms')
      })
      const budget = { remaining: 60, used: 0, dropped: 0 }
      const read = g.fetchFeedViaGraph('viralbhayani', { delayMs: 1000, budget }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(500)
      // Halfway through the wait, another read in this process is rate-limited.
      await g.fetchFeedViaGraph('otherpage', { delayMs: 0 }).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(500)
      const err = (await read) as InstanceType<typeof g.GraphFeedError>
      expect(calls.filter((c) => decodeURIComponent(c.url).includes('business_discovery.username(viralbhayani)'))).toHaveLength(1)
      expect(err.graphKind).toBe('paused')
      expect(budget).toEqual({ remaining: 59, used: 1, dropped: 0 })
      const said = out.join('\n')
      expect(said).toMatch(/the retry of this page was not made — the official read was paused meanwhile/)
      expect(said).not.toMatch(/trying the same page once more/)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A STATUS THAT ARRIVED IS AN ANSWER EVEN WHEN ITS BODY DID NOT (igHttp.ts `cutAnswer`). MUTATION
   * (applied once, seen red, restored): deleting the `cutAnswer` branch fails both cases — the 400 is
   * retried as a transport failure, and the cut 429 neither pauses the path nor stops the retry.
   */
  it('a refusal whose body was cut off is filed as the answer it was, never retried', async () => {
    script(Object.assign(new Error('aborted'), { answerStatus: 400 }), json(200, docAnswer({ after: null })))
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls).toHaveLength(1)
    expect(err.isTransport).toBe(false)
    expect(err.graphKind).toBe('graph-error')
    const rec = fe.parseFeedAnswerRecord(await evidenceRow())!
    expect(rec.last).toMatchObject({ source: 'graph', kind: 'graph-error', status: 400 })
    expect(rec.last.head).toMatch(/the answer's body was cut off \(aborted\)/)
  })

  it('a cut-off 429 pauses the path like any rate limit — it is not spent into again', async () => {
    script(Object.assign(new Error('socket hang up'), { answerStatus: 429 }), json(200, docAnswer({ after: null })))
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls).toHaveLength(1)
    expect(err.graphKind).toBe('graph-rate-limit')
    expect(g.graphCooldown()).toMatchObject({ open: false, kind: 'graph-rate-limit' })
  })

  it('a page that times out twice fails the channel as a transport failure, recorded', async () => {
    script(new Error('timed out after 30000 ms'), new Error('socket hang up'))
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls).toHaveLength(1 + g.GRAPH_TRANSPORT_RETRIES)
    expect(err).toBeInstanceOf(g.GraphFeedError)
    expect(err.graphKind).toBe('transport')
    expect(err.isTransport).toBe(true)
    expect(err.message).toMatch(/could not be reached after 2 tries: socket hang up/)
    expect(fe.parseFeedAnswerRecord(await evidenceRow())!.last).toMatchObject({ source: 'graph', kind: 'transport', status: null })
    // A transport failure is not Meta refusing: the path stays open.
    expect(g.graphCooldown()).toEqual({ open: true })
  })

  it('the retry is never made past the budget', async () => {
    script(new Error('timed out after 30000 ms'), json(200, docAnswer({ after: null })))
    const budget = { remaining: 1, used: 0, dropped: 0 }
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0, budget }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls).toHaveLength(1)
    expect(err.graphKind).toBe('transport')
    expect(err.message).toMatch(/could not be reached: timed out/)
    expect(budget).toEqual({ remaining: 0, used: 1, dropped: 0 })
  })

  it('an ANSWER is never re-asked — a 5xx or an error envelope is Meta speaking', async () => {
    script(json(502, '<html>Bad Gateway</html>'), json(200, docAnswer({ after: null })))
    const err = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 }).catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(calls).toHaveLength(1)
    expect(err.isTransport).toBe(false)
  })

  it('a rate limit pauses the path for 30 minutes — and a paused path makes no request', async () => {
    script(json(400, { error: { code: 4, message: 'Application request limit reached', type: 'OAuthException' } }))
    const err = (await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err).toBeInstanceOf(g.GraphFeedError)
    expect(err.graphKind).toBe('graph-rate-limit')
    expect(err.isThrottle).toBe(true)
    expect(err.until?.getTime()).toBe(now + g.GRAPH_RATE_LIMIT_COOLDOWN_MS)
    expect(g.graphCooldown()).toEqual({ open: false, until: new Date(now + 30 * 60_000), kind: 'graph-rate-limit' })

    now += 29 * 60_000
    const paused = (await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(paused.graphKind).toBe('paused')
    expect(paused.isThrottle).toBe(true)
    expect(calls).toHaveLength(1) // no second request

    now += 60_000
    expect(g.graphCooldown()).toEqual({ open: true })
    script(json(200, docAnswer({ after: null })))
    await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 })
    expect(calls).toHaveLength(2)
    const rec = fe.parseFeedAnswerRecord(await evidenceRow())!
    expect(rec.lastFailure).toMatchObject({ source: 'graph', kind: 'graph-rate-limit' })
  })

  it('the token alarm is raised once per process, and a token error is not a throttle', async () => {
    const dead = () => json(400, { error: { code: 190, error_subcode: 463, message: 'Error validating access token: Session has expired', type: 'OAuthException' } })
    script(dead())
    const first = (await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(first.graphKind).toBe('graph-token')
    expect(first.isThrottle).toBe(false)
    expect(first.message).toMatch(/the read token is invalid or expired/)
    // The pause saves the ~19 calls a pass would spend learning the same thing; it re-asks hourly.
    expect(g.graphCooldown()).toMatchObject({ open: false, kind: 'graph-token' })
    now += g.GRAPH_STOPPED_RETRY_MS
    script(dead())
    await g.fetchFeedViaGraph('viralbhayani').catch(() => undefined)
    expect(calls).toHaveLength(2)
    expect(out.filter((l) => l.includes('the official read token is invalid or expired — a person must mint a new one'))).toHaveLength(1)
  })

  it('an account that is not professional fails that channel only — the path stays open', async () => {
    script(json(400, { error: { code: 110, message: 'Invalid user id', type: 'OAuthException' } }))
    const err = (await g.fetchFeedViaGraph('someperson').catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err.graphKind).toBe('graph-not-professional')
    expect(err.isThrottle).toBe(false)
    expect(err.message).toMatch(/@someperson is not a Business or Creator account/)
    expect(g.graphCooldown()).toEqual({ open: true })
  })

  it('a changed shape is a parse failure, recorded', async () => {
    script(json(200, { data: [] }))
    const err = (await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)) as InstanceType<typeof g.GraphFeedError>
    expect(err.isParseFailure).toBe(true)
    expect(fe.parseFeedAnswerRecord(await evidenceRow())!.last).toMatchObject({ source: 'graph', kind: 'shape' })
  })

  it('a token echoed by the transport or by Meta never leaves this file', async () => {
    // 1. A transport error carrying the full URL and the bare token.
    setIgTransportForTests(async (url) => {
      calls.push({ url, headers: {}, timeoutMs: 0 })
      throw new Error(`connect ECONNREFUSED while fetching ${url} (token ${TOKEN})`)
    })
    const e1 = (await g.fetchFeedViaGraph('viralbhayani', { delayMs: 0 }).catch((e: unknown) => e)) as Error
    // 2. Meta's own message quoting it back.
    script(json(400, { error: { code: 1, message: `Unexpected token ${TOKEN} in request`, type: 'OAuthException' } }))
    const e2 = (await g.fetchFeedViaGraph('viralbhayani').catch((e: unknown) => e)) as Error
    for (const m of [e1.message, e2.message, String(e1.stack), String(e2.stack)]) {
      expect(m).not.toContain(TOKEN)
      expect(m).not.toContain(encodeURIComponent(TOKEN))
    }
    expect(e1.message).toMatch(/could not be reached/)
    const stored = await evidenceRow()
    expect(stored).not.toBe('')
    expect(stored).not.toContain(TOKEN)
    expect(out.join('\n')).not.toContain(TOKEN)
  })

  it('probeOfficialRead says what it read in a sentence, never the URL', async () => {
    script(json(200, docAnswer({ after: null })))
    const p = await g.probeOfficialRead('viralbhayani')
    expect(p.ok).toBe(true)
    expect(p.sentence).toBe('The official API read 3 post(s) from @viralbhayani; the newest is from 2026-10-15T08:01:02.000Z. They carry no tag data.')
    vi.stubEnv('META_GRAPH_TOKEN', '')
    expect((await g.probeOfficialRead('viralbhayani')).sentence).toMatch(/not configured on this host/)
  })
})
