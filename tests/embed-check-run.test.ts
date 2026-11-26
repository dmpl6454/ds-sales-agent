import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * `pnpm ig:embed-check` MUST FAIL WHEN THE READER WOULD MISBEHAVE IN PRODUCTION — review, 26 Nov 2026.
 *
 * The check is the one step between "the code has never seen a real embed page" and a build on the Mac, so a check
 * that passes too easily is worse than none. The review found three ways it did: a login page for the account that
 * does not exist counted as "as held" (in production that page closes the door, and most of what discovery asks
 * about does not exist); a post that was asked for and never read was simply left out; and a caption with "@" words
 * no link went to was a pass, though production would never count that read as whole.
 *
 * Run here as a real process against a stand-in Instagram, the way it runs on the Mac.
 */

type Mode = 'honest' | 'missing-is-login' | 'post-unlinked' | 'posts-refused' | 'post-cut'
let mode: Mode = 'honest'
let server: http.Server
let origin = ''

const profile = (handle: string, verified: boolean): string =>
  `<html><head><title>Instagram</title></head><body><script type="application/json">${JSON.stringify({
    user: { username: handle, full_name: `Name ${handle}`, is_verified: verified },
  })}</script></body></html>`
const SHELL = '<html><head><title>Instagram</title></head><body><div id="app"></div></body></html>'
const LOGIN = '<html><head><title>Login • Instagram</title></head><body><input type="password"></body></html>'
const caption = (extra: string, close = true): string =>
  `<html><head><title>Instagram</title></head><body><div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> launch with <a href="/brand_one/">@brand_one</a>${extra}${close ? '</div>' : ''}</body></html>`

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers })
      res.end(body)
    }
    const p = /^\/([a-z0-9._]+)\/embed\/$/.exec(url)
    if (p) {
      const h = p[1] ?? ''
      if (h === 'netflix_in' || h === 'sonytvofficial') return send(200, profile(h, true))
      if (h === 'marketingmentalist' || h === 'chumbak_official') return send(200, profile(h, false))
      return send(200, mode === 'missing-is-login' ? LOGIN : SHELL)
    }
    if (/^\/p\/[A-Za-z0-9_-]+\/embed\/captioned\/$/.test(url)) {
      if (mode === 'posts-refused') return send(302, '', { location: `${origin}/accounts/login/` })
      if (mode === 'post-unlinked') return send(200, caption(' and @farmleyin today'))
      if (mode === 'post-cut') return send(200, caption(' and more', false))
      return send(200, caption(' today'))
    }
    send(404, 'nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function runCheck(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'scripts', 'embed-check.ts'), '--transport', 'node'],
      { env: { ...process.env, DS_EMBED_TEST_ORIGIN: origin }, timeout: 60_000 },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 99) : 0
        resolve({ code, out: String(stdout) })
      },
    )
  })
}

describe('embed-check passes only on what production would also accept', () => {
  it('an honest door: every account as held, both posts read whole — exit 0', async () => {
    mode = 'honest'
    const r = await runCheck()
    expect(r.out).toContain('TEST ORIGIN IN USE')
    expect(r.out).toContain('every account read as we hold it')
    expect(r.out).toContain('every post read, and the two counts agree')
    expect(r.code).toBe(0)
  }, 60_000)

  it('a login page for the account that does not exist is NOT as held', async () => {
    mode = 'missing-is-login'
    const r = await runCheck()
    expect(r.out).toMatch(/qqqq_nope_nope_12345 via node: a login page \(production would close the door[^\n]*<-- NOT as held/)
    expect(r.out).toContain('1 account reading(s) NOT as held')
    expect(r.code).toBe(1)
  }, 60_000)

  it('a caption with an "@" word no link goes to is a post to look at', async () => {
    mode = 'post-unlinked'
    const r = await runCheck()
    expect(r.out).toContain('"@" words no link goes to: @farmleyin')
    expect(r.code).toBe(1)
  }, 60_000)

  it('a caption the page cut off is a post to look at', async () => {
    mode = 'post-cut'
    const r = await runCheck()
    expect(r.out).toContain('the page stopped before the caption ended')
    expect(r.code).toBe(1)
  }, 60_000)

  it('posts asked for and never read are counted, not left out', async () => {
    mode = 'posts-refused'
    const r = await runCheck()
    expect(r.out).toMatch(/p\/DcyE65LPYMj: not asked {2}<-- NOT READ/)
    expect(r.out).toContain('2 post reading(s) to look at')
    expect(r.code).toBe(1)
  }, 60_000)
})
