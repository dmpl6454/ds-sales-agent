import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * WHEN THE FEED REFUSES, `enrichHandle` ASKS THE EMBED PAGE — AND ONLY THEN — 26 Nov 2026.
 *
 * Every badge in this system is read through `enrichHandle` (ten callers), so this is the one place the embed
 * reader had to be wired in. Three things must hold, and each has cost this codebase before:
 *
 *   1. WITH THE EMBED DOOR NOT ASKING (the switch off, or the server), the result is what it was before this
 *      existed — the same reason text, the same status. A fallback that changed the refusal's shape would change
 *      which passes halt.
 *   2. ONLY A REFUSAL BY THE FEED TRIGGERS IT. A dead handle (404), an answer about somebody else and a timeout
 *      are the feed's own answers; asking the embed page for those would spend the home address on every dead
 *      handle in a queue.
 *   3. WHEN BOTH DOORS REFUSE it still looks like "this host was told to stop" (a 429), or the badge door and
 *      official-page discovery stop halting and bench an innocent candidate for a day instead.
 *
 * The embed door itself is a stand-in here; `tests/embed-door.test.ts` owns it.
 */

vi.mock('@/lib/db', () => ({
  prisma: { setting: { upsert: async () => ({}), findUnique: async () => null, findMany: async () => [] } },
}))

type Outcome = import('@/detection/embedDoor').EmbedProfileOutcome
const embedMock = vi.fn<(h: string) => Promise<Outcome>>()
vi.mock('@/detection/embedDoor', () => ({ readProfileEmbed: (h: string) => embedMock(h) }))

const { enrichHandle } = await import('@/detection/enrichHandle')
const { setIgTransportForTests } = await import('@/detection/igHttp')
const { resetAnonGate, anonGateCheck, anonGateRecordThrottle, setAnonGateClock } = await import('@/detection/anonGate')

let feedCalls = 0
function feedAnswers(status: number, body: unknown): void {
  setIgTransportForTests(async () => {
    feedCalls++
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) as unknown }
  })
}
const WALL = { message: 'Please wait a few minutes before you try again.', require_login: true }
const NOT_ASKED: Outcome = { kind: 'not-asked', why: 'switched-off' }

beforeEach(() => {
  feedCalls = 0
  embedMock.mockReset()
  embedMock.mockResolvedValue(NOT_ASKED)
  resetAnonGate()
  setAnonGateClock()
})

describe('with the embed door not asking, nothing about enrichHandle has changed', () => {
  it('a feed refusal is reported exactly as before', async () => {
    feedAnswers(401, WALL)
    const e = await enrichHandle('somebrand')
    expect(e).toEqual({
      handle: 'somebrand', reachable: false, accountType: null, isVerified: null, followers: null, fullName: null,
      reason: 'HTTP 401', status: 401, source: null,
    })
  })

  it('a closed feed gate is reported exactly as before, with no feed request', async () => {
    anonGateRecordThrottle('profile', 401)
    feedAnswers(200, {})
    const e = await enrichHandle('somebrand')
    expect(e.reachable).toBe(false)
    expect(e.status).toBe(429)
    expect(e.reason).toMatch(/^HTTP 429 \(anonymous reads throttled until /)
    expect(feedCalls).toBe(0)
  })

  it('the server path: "not a sending machine" is not-asked too', async () => {
    embedMock.mockResolvedValue({ kind: 'not-asked', why: 'not-a-sending-machine' })
    feedAnswers(429, 'slow down')
    expect(await enrichHandle('somebrand')).toMatchObject({ reachable: false, reason: 'HTTP 429', status: 429, source: null })
  })
})

describe('only a refusal by the feed sends the question to the embed page', () => {
  it('a dead handle (404) is the feed’s answer: the embed page is not asked', async () => {
    feedAnswers(404, 'not found')
    const e = await enrichHandle('deadhandle')
    expect(e).toMatchObject({ reachable: false, status: 404, reason: 'HTTP 404' })
    expect(embedMock).not.toHaveBeenCalled()
  })

  it('a feed that answers is believed, and marked as the feed', async () => {
    feedAnswers(200, { user: { username: 'somebrand', full_name: 'Some Brand', is_verified: true, follower_count: 10 } })
    const e = await enrichHandle('somebrand')
    expect(e).toMatchObject({ reachable: true, isVerified: true, source: 'feed', fullName: 'Some Brand' })
    expect(embedMock).not.toHaveBeenCalled()
  })

  it('an answer about somebody else, an empty answer and a timeout do not ask the embed page', async () => {
    feedAnswers(200, { user: { username: 'another', is_verified: true } })
    expect((await enrichHandle('somebrand')).reachable).toBe(false)
    feedAnswers(200, {})
    expect((await enrichHandle('somebrand')).reachable).toBe(false)
    setIgTransportForTests(async () => {
      throw new Error('timed out after 12000 ms')
    })
    expect((await enrichHandle('somebrand')).reachable).toBe(false)
    expect(embedMock).not.toHaveBeenCalled()
  })

  it('a 403 that is not the login wall is one account’s answer', async () => {
    feedAnswers(403, 'forbidden')
    await enrichHandle('gated')
    expect(embedMock).not.toHaveBeenCalled()
  })
})

describe('with the embed door asking', () => {
  it('a feed refusal is answered from the embed page, and says so', async () => {
    feedAnswers(401, WALL)
    embedMock.mockResolvedValue({ kind: 'read', isVerified: true, fullName: 'Netflix India', followers: 6734504, basis: 'both' })
    const e = await enrichHandle('@Netflix_IN')
    expect(embedMock).toHaveBeenCalledWith('netflix_in')
    expect(e).toEqual({
      handle: 'netflix_in', reachable: true, accountType: null, isVerified: true, followers: 6734504, fullName: 'Netflix India',
      reason: null, status: null, source: 'embed',
    })
  })

  it('a measured "not verified" comes through as false, not as unknown', async () => {
    feedAnswers(401, WALL)
    embedMock.mockResolvedValue({ kind: 'read', isVerified: false, fullName: null, followers: null, basis: 'exact' })
    expect(await enrichHandle('smallshop')).toMatchObject({ reachable: true, isVerified: false, source: 'embed' })
  })

  it('a closed feed gate asks the embed page without spending a feed request', async () => {
    anonGateRecordThrottle('profile', 401)
    feedAnswers(200, {})
    embedMock.mockResolvedValue({ kind: 'read', isVerified: true, fullName: 'A Brand', followers: 5, basis: 'both' })
    expect(await enrichHandle('a_brand')).toMatchObject({ reachable: true, isVerified: true, source: 'embed' })
    expect(feedCalls).toBe(0)
    // and the embed answer did not reopen the door the feed is still refusing
    expect(anonGateCheck('profile').ok).toBe(false)
  })

  it('BOTH doors refusing still looks like "this host was told to stop"', async () => {
    feedAnswers(401, WALL)
    embedMock.mockResolvedValue({ kind: 'refused', reason: 'sent to the login page', until: new Date('2026-11-26T10:00:00Z'), status: 302 })
    const e = await enrichHandle('somebrand')
    expect(e.reachable).toBe(false)
    expect(e.isVerified).toBeNull()
    // what badgeDoor.ts keys on, and what officialDiscovery.ts and three CLIs key on
    expect(e.status).toBe(429)
    expect(e.reason).toMatch(/\b429\b/)
  })

  it('an embed page that says nothing about the account is unreachable with no verdict and no halt', async () => {
    feedAnswers(401, WALL)
    embedMock.mockResolvedValue({ kind: 'nothing', reason: 'the embed page has no profile data for this handle (x)', status: null })
    const e = await enrichHandle('guessedhandle')
    expect(e).toMatchObject({ reachable: false, isVerified: null, status: null, source: null })
    expect(e.reason).toMatch(/^embed page: /)
    // must NOT read as a throttle, or every guessed handle would halt official-page discovery
    expect(e.reason).not.toMatch(/\b(429|401)\b/)
  })

  it('never reports "reachable" with an unknown badge', async () => {
    feedAnswers(401, WALL)
    for (const o of [
      { kind: 'nothing', reason: 'the embed page does not say (both)', status: null },
      { kind: 'nothing', reason: 'HTTP 404', status: 404 },
      { kind: 'refused', reason: 'HTTP 429', until: new Date(), status: 429 },
    ] as Outcome[]) {
      embedMock.mockResolvedValue(o)
      const e = await enrichHandle('somebrand')
      expect(e.reachable && e.isVerified === null).toBe(false)
    }
  })
})
