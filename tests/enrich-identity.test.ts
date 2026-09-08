import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { setIgTransportForTests } from '@/detection/igHttp'

// enrichHandle reads through igGet (node:https, no Sec-Fetch headers); these cases stub
// globalThis.fetch, so the transport is bridged to whatever fetch is stubbed at call time.
setIgTransportForTests(async (url, init) => {
  const r = await (globalThis.fetch as unknown as (u: string, i: { headers: Record<string, string> }) => Promise<Response>)(url, {
    headers: init.headers,
  })
  return { status: r.status, ok: r.ok, text: () => r.text(), json: () => r.json() as Promise<unknown> }
})

import { enrichHandle } from '../src/detection/enrichHandle'

/**
 * THE PAYLOAD MUST DESCRIBE THE ACCOUNT WE ASKED ABOUT.
 *
 * `feed/user/<h>/username/` returns `items[]` (that account's posts) and `user`. The code
 * used to read `items[0].user` FIRST — the owner of the newest post, which on a co-authored
 * post is the COLLABORATOR.
 *
 * The two fixtures below are the REAL responses measured on 2026-08-23:
 *   asked @yamigautam  → items[0].user = @amazonmgmstudiosin "Amazon MGM Studios India" ✓verified
 *   asked @akshaykumar → items[0].user = @jiohotstar          "JioHotstar"              ✓verified
 *
 * `is_verified` came from that object too, so VERIFIED ONLY could be satisfied by someone
 * else's badge. MEASURED consequence: of the 40 newest live prospects, FOUR were not
 * verified at all — @bigfmvibe was stored as "Nasha Boy", is really "BIG Vibe", is
 * unverified, and had been messaged.
 *
 * The negative direction carries the weight here: the test that matters is the one where
 * the collaborator is VERIFIED and the real account is NOT.
 */
describe('enrichHandle only ever reports the account it was asked about', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  const respond = (body: unknown) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch
  }

  it('prefers body.user over the newest post owner (the real @yamigautam payload)', async () => {
    respond({
      items: [{ user: { username: 'amazonmgmstudiosin', full_name: 'Amazon MGM Studios India', is_verified: true, follower_count: 900_000 } }],
      user: { username: 'yamigautam', full_name: 'Yami Gautam Dhar', is_verified: true, follower_count: 1_000 },
    })

    const e = await enrichHandle('yamigautam')
    expect(e.reachable).toBe(true)
    expect(e.fullName).toBe('Yami Gautam Dhar')
    expect(e.followers).toBe(1_000)
  })

  it("NEVER borrows a verified collaborator's badge for an unverified account", async () => {
    // The safety case. Without the identity check this returns isVerified TRUE and the
    // account is admitted by the badge door — which is how @bigfmvibe was messaged.
    respond({
      items: [{ user: { username: 'jiohotstar', full_name: 'JioHotstar', is_verified: true } }],
      user: { username: 'someunverifiedpage', full_name: 'Some Unverified Page', is_verified: false },
    })

    const e = await enrichHandle('someunverifiedpage')
    expect(e.isVerified).toBe(false)
    expect(e.fullName).toBe('Some Unverified Page')
  })

  it('is NOT REACHABLE — never a verdict — when the payload describes somebody else entirely', async () => {
    respond({ items: [{ user: { username: 'jiohotstar', full_name: 'JioHotstar', is_verified: true } }] })

    const e = await enrichHandle('akshaykumar')
    expect(e.reachable).toBe(false)
    expect(e.isVerified).toBeNull()
    expect(e.reason).toContain('jiohotstar')
  })

  it('still accepts the item user when it IS the account asked about', async () => {
    // Most accounts have no collaborator on their newest post, and some payloads carry no
    // top-level `user` at all. Those must keep working, or the fix becomes an outage.
    respond({ items: [{ user: { username: 'vibe', full_name: 'VIBE', is_verified: true } }] })

    const e = await enrichHandle('vibe')
    expect(e.reachable).toBe(true)
    expect(e.fullName).toBe('VIBE')
    expect(e.isVerified).toBe(true)
  })
})
