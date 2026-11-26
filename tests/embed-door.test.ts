import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * THE EMBED DOOR: THE SWITCH, THE GATE, THE PROOF AND THE CEILING — 26 Nov 2026.
 *
 * `embedDoor.ts` is what stands between a caller and Instagram's embed pages, and it is the new source of the
 * verified badge. What is pinned here, each in the direction that would hurt:
 *
 *   - with the switch off, or on the server, NOTHING is requested;
 *   - a badge is believed only after the door has read "verified" on an account we hold as verified AND "not
 *     verified" on one we hold as not — so a page that says true about everybody admits nobody, and a page that
 *     says false about everybody refuses nobody for good;
 *   - a refusal closes the door and nothing is asked while it is closed;
 *   - an embed page that answers never reopens the profile door Instagram is still refusing;
 *   - the hourly ceiling holds whoever is asking.
 *
 * The database, the environment and the settings are stand-ins; the gate is the real `anonGate` on a test clock.
 */

const envBox = { SEND_ENABLED: true }
const settingsBox: { value: Record<string, unknown> | Error } = { value: { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 40 } }

vi.mock('@/lib/db', () => ({
  prisma: { setting: { upsert: async () => ({}), findUnique: async () => null, findMany: async () => [] } },
}))
vi.mock('@/lib/env', () => ({ env: envBox }))
vi.mock('@/lib/settings', () => ({
  getSettings: async () => {
    if (settingsBox.value instanceof Error) throw settingsBox.value
    return settingsBox.value
  },
}))

const { readProfileEmbed, readPostEmbed, setEmbedDoorForTests, embedRequestsMade, EMBED_PROOF_MAX_AGE_MS, EMBED_PROOF_RETRY_MS, EMBED_SPACING_MS } =
  await import('@/detection/embedDoor')
const { anonGateCheck, anonGateRecordThrottle, resetAnonGate, setAnonGateClock } = await import('@/detection/anonGate')
type EmbedAnswer = import('@/detection/embedFetch').EmbedAnswer

let clock = 1_800_000_000_000
const asked: string[] = []
const slept: number[] = []
/** What each handle or shortcode's page says. Anything not listed is a 200 with no data for it. */
let world: Record<string, EmbedAnswer | 'verified' | 'unverified' | 'shell'> = {}

const profilePage = (handle: string, verified: boolean): string =>
  `<html><head><title>Instagram</title></head><body><script type="application/json">${JSON.stringify({
    user: { username: handle, full_name: `Name of ${handle}`, is_verified: verified, follower_count: 1234 },
  })}</script></body></html>`
const shell = '<html><head><title>Instagram</title></head><body><div id="app"></div></body></html>'
const page = (body: string): EmbedAnswer => ({ kind: 'page', status: 200, body, contentType: 'text/html', hops: 0, capped: false })

async function fetchStub(url: string): Promise<EmbedAnswer> {
  const profile = /instagram\.com\/([a-z0-9._]+)\/embed\/$/.exec(url)
  const post = /instagram\.com\/p\/([A-Za-z0-9_-]+)\/embed\/captioned\/$/.exec(url)
  const key = profile?.[1] ?? post?.[1] ?? url
  asked.push(key)
  const w = world[key]
  if (w === undefined || w === 'shell') return page(shell)
  if (w === 'verified') return page(profilePage(key, true))
  if (w === 'unverified') return page(profilePage(key, false))
  return w
}

const honestControls = { netflix_in: 'verified', sonytvofficial: 'verified', marketingmentalist: 'unverified', chumbak_official: 'unverified' } as const

function useRealSwitch(): void {
  setEmbedDoorForTests({ fetch: fetchStub, now: () => clock, sleep: async (ms) => void (slept.push(ms), (clock += ms)), userAgent: 'test-agent' })
}

beforeEach(() => {
  clock = 1_800_000_000_000
  asked.length = 0
  slept.length = 0
  world = { ...honestControls }
  envBox.SEND_ENABLED = true
  settingsBox.value = { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 40 }
  resetAnonGate()
  setAnonGateClock(() => clock)
  useRealSwitch()
})

describe('the switch and the machine', () => {
  it('asks nothing while embed reads are switched off', async () => {
    settingsBox.value = { embedReads: false, embedTransport: 'curl', embedMaxPerHour: 40 }
    expect(await readProfileEmbed('somebrand')).toEqual({ kind: 'not-asked', why: 'switched-off' })
    expect(await readPostEmbed('Dcc4pQ8sX0N')).toEqual({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('asks nothing when the setting is absent — an old settings object must not switch it on', async () => {
    settingsBox.value = {}
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('a switch that cannot be read is a switch that is off', async () => {
    settingsBox.value = new Error('database unreachable')
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('never asks from a machine that may not send (the server), whatever the switch says', async () => {
    envBox.SEND_ENABLED = false
    expect(await readProfileEmbed('somebrand')).toEqual({ kind: 'not-asked', why: 'not-a-sending-machine' })
    expect(await readPostEmbed('Dcc4pQ8sX0N', { person: true })).toEqual({ kind: 'not-asked', why: 'not-a-sending-machine' })
    expect(asked).toEqual([])
  })

  it('a person previewing a post may ask with the switch off — and only that', async () => {
    settingsBox.value = { embedReads: false, embedTransport: 'curl', embedMaxPerHour: 40 }
    world['Dcc4pQ8sX0N'] = page('<div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> hi <a href="/brand_one/">@brand_one</a></div>')
    expect(await readPostEmbed('Dcc4pQ8sX0N', { person: true })).toMatchObject({ kind: 'read', mentions: ['brand_one'] })
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked' })
  })
})

describe('the proof, before any badge is believed', () => {
  it('reads a verified control and an unverified control first, then the account asked', async () => {
    world['somebrand'] = 'verified'
    const r = await readProfileEmbed('@SomeBrand')
    expect(r).toMatchObject({ kind: 'read', isVerified: true, fullName: 'Name of somebrand', followers: 1234 })
    expect(asked).toEqual(['netflix_in', 'marketingmentalist', 'somebrand'])
  })

  it('a proof stands for twelve hours and is made again after that', async () => {
    world['a_brand'] = 'unverified'
    await readProfileEmbed('a_brand')
    asked.length = 0
    clock += EMBED_PROOF_MAX_AGE_MS - 60_000
    await readProfileEmbed('a_brand')
    expect(asked).toEqual(['a_brand'])
    asked.length = 0
    clock += 2 * 60_000
    await readProfileEmbed('a_brand')
    expect(asked).toEqual(['netflix_in', 'marketingmentalist', 'a_brand'])
  })

  /** THE DANGEROUS ONE: a page that says "verified" about every account would admit every candidate. */
  it('a door that reads verified for everybody is not believed, and the candidate is never even asked', async () => {
    world = { netflix_in: 'verified', sonytvofficial: 'verified', marketingmentalist: 'verified', chumbak_official: 'verified', unverified_shop: 'verified' }
    const r = await readProfileEmbed('unverified_shop')
    expect(r.kind).toBe('nothing')
    expect(r).not.toMatchObject({ kind: 'read' })
    expect(asked).toEqual(['netflix_in', 'marketingmentalist', 'chumbak_official'])
    expect(asked).not.toContain('unverified_shop')
  })

  /** And its mirror: "not verified" about everybody would write a permanent refusal against every real lead. */
  it('a door that reads not-verified for everybody is not believed either', async () => {
    world = { netflix_in: 'unverified', sonytvofficial: 'unverified', marketingmentalist: 'unverified', chumbak_official: 'unverified', real_brand: 'unverified' }
    const r = await readProfileEmbed('real_brand')
    expect(r.kind).toBe('nothing')
    expect(asked).toEqual(['netflix_in', 'sonytvofficial'])
  })

  it('a door that serves empty shells proves nothing', async () => {
    world = {}
    expect((await readProfileEmbed('real_brand')).kind).toBe('nothing')
    expect(asked).not.toContain('real_brand')
  })

  it('a failed proof is not retried for half an hour, and costs no request meanwhile', async () => {
    world = {}
    await readProfileEmbed('real_brand')
    asked.length = 0
    clock += EMBED_PROOF_RETRY_MS - 60_000
    expect((await readProfileEmbed('real_brand')).kind).toBe('nothing')
    expect(asked).toEqual([])
    clock += 2 * 60_000
    world = { ...honestControls, real_brand: 'verified' }
    expect(await readProfileEmbed('real_brand')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('one stale label does not sink it: the second control of that kind is asked', async () => {
    world = { netflix_in: 'unverified', sonytvofficial: 'verified', marketingmentalist: 'verified', chumbak_official: 'unverified', a_brand: 'verified' }
    expect(await readProfileEmbed('a_brand')).toMatchObject({ kind: 'read', isVerified: true })
    expect(asked).toEqual(['netflix_in', 'sonytvofficial', 'marketingmentalist', 'chumbak_official', 'a_brand'])
  })

  it('a refusal during the proof is a refusal, and closes the door', async () => {
    world['netflix_in'] = { kind: 'login-redirect', status: 302, location: 'https://www.instagram.com/accounts/login/' }
    const r = await readProfileEmbed('a_brand')
    expect(r).toMatchObject({ kind: 'refused', status: 302 })
    expect(anonGateCheck('embed').ok).toBe(false)
    expect(asked).toEqual(['netflix_in'])
  })
})

describe('what is never a verdict', () => {
  beforeEach(async () => {
    world['warmup'] = 'verified'
    await readProfileEmbed('warmup') // the proof is made; the cases below are about one account
    asked.length = 0
  })

  it('a page with no data for the handle is nothing — a missing, gated or shell page look alike', async () => {
    const r = await readProfileEmbed('qqqq_nope_nope_12345')
    expect(r).toMatchObject({ kind: 'nothing', status: null })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a page whose own data says both is nothing', async () => {
    world['mixed'] = page(`<script type="application/json">${JSON.stringify([{ username: 'mixed', is_verified: true }, { username: 'mixed', is_verified: false }])}</script>`)
    expect((await readProfileEmbed('mixed')).kind).toBe('nothing')
  })

  it('an odd status, a timeout and an off-site redirect are nothing, and do not close the door', async () => {
    world['a'] = { kind: 'page', status: 404, body: 'nope', contentType: 'text/html', hops: 0, capped: false }
    world['b'] = { kind: 'no-answer', error: 'timed out after 25000 ms' }
    world['c'] = { kind: 'redirect-refused', status: 302, location: 'https://evil.example/' }
    expect(await readProfileEmbed('a')).toMatchObject({ kind: 'nothing', status: 404 })
    expect(await readProfileEmbed('b')).toMatchObject({ kind: 'nothing', status: null })
    expect(await readProfileEmbed('c')).toMatchObject({ kind: 'nothing' })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('not a handle is nothing, with no request', async () => {
    expect(await readProfileEmbed('not a handle')).toMatchObject({ kind: 'nothing', reason: 'not a handle' })
    expect(asked).toEqual([])
  })
})

describe('a refusal closes the door, and only this door', () => {
  beforeEach(async () => {
    world['warmup'] = 'verified'
    await readProfileEmbed('warmup')
    asked.length = 0
  })

  const refusals: Array<[string, EmbedAnswer]> = [
    ['sent to the login page', { kind: 'login-redirect', status: 302, location: '/accounts/login/?next=x' }],
    ['a 429', { kind: 'page', status: 429, body: '{"message":"Please wait a few minutes"}', contentType: 'application/json', hops: 0, capped: false }],
    ['a 401', { kind: 'page', status: 401, body: '', contentType: null, hops: 0, capped: false }],
    ['a 403 saying require_login', { kind: 'page', status: 403, body: '{"require_login":true}', contentType: 'application/json', hops: 0, capped: false }],
    ['a login page served as a 200', { kind: 'page', status: 200, body: '<html><head><title>Login • Instagram</title></head><body><input type="password"></body></html>', contentType: 'text/html', hops: 0, capped: false }],
  ]
  it.each(refusals)('%s is a refusal, and nothing more is asked until the cooldown ends', async (_name, answer) => {
    world['victim'] = answer
    world['next_one'] = 'verified'
    const r = await readProfileEmbed('victim')
    expect(r.kind).toBe('refused')
    // Reported as a "this host was told to stop" status when no request can be made, so callers halt their pass.
    const again = await readProfileEmbed('next_one')
    expect(again).toMatchObject({ kind: 'refused', status: 429 })
    expect(asked).toEqual(['victim'])
    clock += 16 * 60_000
    expect(await readProfileEmbed('next_one')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('a 403 that does not say require_login is one account’s answer, not a refusal of the host', async () => {
    world['gated'] = { kind: 'page', status: 403, body: 'forbidden', contentType: 'text/html', hops: 0, capped: false }
    expect(await readProfileEmbed('gated')).toMatchObject({ kind: 'nothing', status: 403 })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a refused embed door leaves the feed and profile doors alone', async () => {
    world['victim'] = { kind: 'login-redirect', status: 302, location: '/accounts/login/' }
    await readProfileEmbed('victim')
    expect(anonGateCheck('embed').ok).toBe(false)
    expect(anonGateCheck('feed').ok).toBe(true)
    expect(anonGateCheck('profile').ok).toBe(true)
  })

  /** The direction that matters: the profile endpoint is STILL refusing; a served embed page must not reopen it. */
  it('an embed page that answers never reopens a profile door Instagram is refusing', async () => {
    anonGateRecordThrottle('profile', 401)
    anonGateRecordThrottle('feed', 401)
    world['a_brand'] = 'verified'
    expect(await readProfileEmbed('a_brand')).toMatchObject({ kind: 'read' })
    expect(anonGateCheck('profile').ok).toBe(false)
    expect(anonGateCheck('feed').ok).toBe(false)
  })
})

describe('the hourly ceiling and the spacing', () => {
  it('stops at the ceiling without asking, and says when it lifts', async () => {
    setEmbedDoorForTests({ fetch: fetchStub, now: () => clock, sleep: async (ms) => void (clock += ms), userAgent: 'test-agent', maxPerHour: 5 })
    for (const h of ['a', 'b', 'c']) world[h] = 'verified'
    const first = clock
    expect((await readProfileEmbed('a')).kind).toBe('read') // 2 proof + 1
    expect((await readProfileEmbed('b')).kind).toBe('read') // 4
    expect((await readProfileEmbed('c')).kind).toBe('read') // 5
    const full = await readProfileEmbed('a')
    expect(full).toMatchObject({ kind: 'refused', status: 429 })
    expect(embedRequestsMade()).toBe(5)
    if (full.kind === 'refused') expect(full.until.getTime()).toBeGreaterThanOrEqual(first + 60 * 60_000)
    // Our own ceiling is not Instagram refusing: the gate stays open.
    expect(anonGateCheck('embed').ok).toBe(true)
    clock += 61 * 60_000
    expect((await readProfileEmbed('a')).kind).toBe('read')
  })

  it('reads the ceiling from the setting', async () => {
    settingsBox.value = { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 3 }
    world['a'] = 'verified'
    expect((await readProfileEmbed('a')).kind).toBe('read') // 3 requests
    expect(await readProfileEmbed('a')).toMatchObject({ kind: 'refused' })
    expect(embedRequestsMade()).toBe(3)
  })

  it('never makes two requests closer than the spacing', async () => {
    world['a'] = 'verified'
    await readProfileEmbed('a')
    expect(slept.length).toBe(2)
    for (const ms of slept) expect(ms).toBe(EMBED_SPACING_MS)
  })
})

describe('the post door', () => {
  const caption = '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/publisher_one/">publisher_one</a> Launch with <a href="https://www.instagram.com/brand.one/">@brand.one</a> today</div>'

  it('returns the linked mentions, the owner and the caption text — with no proof needed', async () => {
    world['DcyE65LPYMj'] = page(caption)
    const r = await readPostEmbed('DcyE65LPYMj')
    expect(r).toMatchObject({ kind: 'read', owner: 'publisher_one', mentions: ['brand.one'] })
    if (r.kind === 'read') expect(r.captionText).toContain('Launch with @brand.one today')
    expect(asked).toEqual(['DcyE65LPYMj'])
  })

  it('a page with no caption is nothing; a login page is a refusal that closes the door', async () => {
    world['PNOCAP01'] = page('<div class="Embed">This post is unavailable</div>')
    expect(await readPostEmbed('PNOCAP01')).toMatchObject({ kind: 'nothing' })
    expect(anonGateCheck('embed').ok).toBe(true)
    world['PWALL001'] = page('<html><head><title>Login • Instagram</title></head><body><input type="password"></body></html>')
    expect(await readPostEmbed('PWALL001')).toMatchObject({ kind: 'refused' })
    expect(anonGateCheck('embed').ok).toBe(false)
  })

  it('refuses something that is not a shortcode without asking', async () => {
    expect(await readPostEmbed('../etc')).toMatchObject({ kind: 'nothing', reason: 'not a post shortcode' })
    expect(asked).toEqual([])
  })
})
