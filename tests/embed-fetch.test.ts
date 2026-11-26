import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import {
  fetchEmbed,
  embedHeaders,
  embedUserAgent,
  isLoginUrl,
  resolveEmbedRedirect,
  profileEmbedUrl,
  postEmbedUrl,
  parseCurlOutput,
  EMBED_MAX_BYTES,
  type EmbedTransportName,
} from '@/detection/embedFetch'

/**
 * THE EMBED FETCH KEEPS THE PROBE'S STOP RULES, AND NEVER CARRIES A COOKIE — 26 Nov 2026.
 *
 * A pretend Instagram on this machine, driven through BOTH clients (`node:https`'s code over plain http, and the
 * system curl), because only curl was measured against the real thing and the two must behave alike here. What is
 * pinned: a login redirect is a refusal and is never followed; a redirect leaves the site never; a cookie a page
 * sets is never sent back; the cap and the timeout hold.
 */

interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
}
const seen: Seen[] = []
let server: http.Server
let origin = ''

const PAGE = '<html><head><title>Instagram</title></head><body><script type="application/json">{"user":{"username":"netflix_in","is_verified":true}}</script></body></html>'

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    const url = req.url ?? ''
    if (url.startsWith('/ok/')) {
      const gz = zlib.gzipSync(Buffer.from(PAGE))
      res.writeHead(200, { 'content-type': 'text/html; charset="utf-8"', 'content-encoding': 'gzip', 'set-cookie': 'csrftoken=SECRETVALUE; Path=/' })
      res.end(gz)
    } else if (url.startsWith('/plain/')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    } else if (url.startsWith('/tologin/')) {
      res.writeHead(302, { location: `${origin}/accounts/login/?next=%2Fnetflix_in%2Fembed%2F`, 'set-cookie': 'mid=SECRETVALUE; Path=/' })
      res.end()
    } else if (url.startsWith('/tologin2/')) {
      res.writeHead(302, { location: '/login/?next=x' })
      res.end()
    } else if (url.startsWith('/offsite/')) {
      res.writeHead(302, { location: 'https://evil.example/netflix_in/embed/' })
      res.end()
    } else if (url.startsWith('/hop1/')) {
      res.writeHead(302, { location: '/ok/after-hop/', 'set-cookie': 'ig_did=SECRETVALUE; Path=/' })
      res.end()
    } else if (url.startsWith('/loop/')) {
      res.writeHead(302, { location: '/loop/again/' })
      res.end()
    } else if (url.startsWith('/throttle/')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"message":"Please wait a few minutes before you try again.","require_login":true}')
    } else if (url.startsWith('/big/')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(Buffer.alloc(EMBED_MAX_BYTES + 50_000, 0x61))
    } else if (url.startsWith('/slow/')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE)
      }, 3_000)
    } else {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body>not here</body></html>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

let hasCurl = true
try {
  execFileSync('curl', ['--version'], { stdio: 'ignore' })
} catch {
  hasCurl = false
}
const transports: EmbedTransportName[] = hasCurl ? ['node', 'curl'] : ['node']
const UA = embedUserAgent('mac', 145)
const ask = (path: string, transport: EmbedTransportName, timeoutMs = 10_000) =>
  fetchEmbed(`${origin}${path}`, { userAgent: UA, transport, testOrigin: origin, timeoutMs })

describe.each(transports)('fetchEmbed through %s', (transport) => {
  it('returns a page, un-gzipped, and sends the browser’s iframe headers and no cookie', async () => {
    seen.length = 0
    const a = await ask('/ok/netflix_in/embed/', transport)
    expect(a.kind).toBe('page')
    if (a.kind !== 'page') return
    expect(a.status).toBe(200)
    expect(a.body).toBe(PAGE)
    expect(a.hops).toBe(0)
    const h = seen[0]?.headers ?? {}
    expect(h['user-agent']).toBe(UA)
    expect(h['sec-fetch-dest']).toBe('iframe')
    expect(h['sec-fetch-mode']).toBe('navigate')
    expect(h['sec-fetch-site']).toBe('cross-site')
    expect(h['accept-language']).toBe('en-US,en;q=0.9')
    expect(h['upgrade-insecure-requests']).toBe('1')
    expect(h['cookie']).toBeUndefined()
    expect(h['x-ig-app-id']).toBeUndefined()
  })

  it('being sent to a login page is a refusal, and the login page is never asked for', async () => {
    seen.length = 0
    const a = await ask('/tologin/netflix_in/embed/', transport)
    expect(a.kind).toBe('login-redirect')
    expect(seen).toHaveLength(1)
    seen.length = 0
    expect((await ask('/tologin2/x/', transport)).kind).toBe('login-redirect')
    expect(seen).toHaveLength(1)
  })

  it('never follows a redirect off the site', async () => {
    seen.length = 0
    const a = await ask('/offsite/netflix_in/embed/', transport)
    expect(a.kind).toBe('redirect-refused')
    expect(seen).toHaveLength(1)
  })

  it('follows a redirect inside the site, and does not send back the cookie the first answer set', async () => {
    seen.length = 0
    const a = await ask('/hop1/netflix_in/embed/', transport)
    expect(a.kind).toBe('page')
    if (a.kind === 'page') expect(a.hops).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.headers['cookie']).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('SECRETVALUE')
  })

  it('gives up after three redirects in a row', async () => {
    seen.length = 0
    const a = await ask('/loop/start/', transport)
    expect(a.kind).toBe('redirect-refused')
    expect(seen).toHaveLength(4)
  })

  it('a 429 comes back as a page with its status, for the caller to treat as a refusal', async () => {
    const a = await ask('/throttle/netflix_in/embed/', transport)
    expect(a).toMatchObject({ kind: 'page', status: 429 })
  })

  it('cuts a body at the cap and says so', async () => {
    const a = await ask('/big/x/', transport)
    expect(a.kind).toBe('page')
    if (a.kind !== 'page') return
    expect(a.capped).toBe(true)
    expect(Buffer.byteLength(a.body)).toBe(EMBED_MAX_BYTES)
  })

  it('a page that does not come in time is no-answer, never a verdict', async () => {
    const a = await ask('/slow/x/', transport, 1_000)
    expect(a.kind).toBe('no-answer')
  })

  it('nothing listening is no-answer', async () => {
    const a = await fetchEmbed('http://127.0.0.1:9/ok/x/', { userAgent: UA, transport, testOrigin: 'http://127.0.0.1:9', timeoutMs: 3_000 })
    expect(a.kind).toBe('no-answer')
  })
})

describe('the rules, without a network', () => {
  it('only ever asks Instagram', async () => {
    for (const transport of ['node', 'curl'] as const) {
      expect(await fetchEmbed('https://evil.example/netflix_in/embed/', { userAgent: UA, transport })).toMatchObject({ kind: 'no-answer', error: 'not an Instagram URL' })
      expect(await fetchEmbed('http://www.instagram.com/netflix_in/embed/', { userAgent: UA, transport })).toMatchObject({ kind: 'no-answer' })
      expect(await fetchEmbed('https://instagram.com.evil.example/x/embed/', { userAgent: UA, transport })).toMatchObject({ kind: 'no-answer' })
    }
  })

  it('isLoginUrl — the probe’s rule', () => {
    expect(isLoginUrl('https://www.instagram.com/accounts/login/?next=%2Fnetflix_in%2Fembed%2F')).toBe(true)
    expect(isLoginUrl('/accounts/login/')).toBe(true)
    expect(isLoginUrl('https://www.threads.com/login/?next=x')).toBe(true)
    expect(isLoginUrl('/login')).toBe(true)
    expect(isLoginUrl('/login?next=x')).toBe(true)
    expect(isLoginUrl('//www.instagram.com/accounts/login')).toBe(true)
    expect(isLoginUrl('https://www.instagram.com/netflix_in/embed/')).toBe(false)
    expect(isLoginUrl('https://www.instagram.com/loginpage_brand/embed/')).toBe(false)
    expect(isLoginUrl('https://www.instagram.com/')).toBe(false)
  })

  it('resolveEmbedRedirect — https, instagram.com, readable, or nothing', () => {
    const base = 'https://www.instagram.com/netflix_in/embed/'
    expect(resolveEmbedRedirect(base, '/netflix_in/embed/?x=1')).toBe('https://www.instagram.com/netflix_in/embed/?x=1')
    expect(resolveEmbedRedirect(base, 'https://instagram.com/a/embed/')).toBe('https://instagram.com/a/embed/')
    expect(resolveEmbedRedirect(base, 'http://www.instagram.com/a/embed/')).toBeNull()
    expect(resolveEmbedRedirect(base, 'https://evil.example/a')).toBeNull()
    expect(resolveEmbedRedirect(base, 'https://www.instagram.com.evil.example/a')).toBeNull()
    expect(resolveEmbedRedirect(base, 'https://www.threads.com/@a')).toBeNull()
    expect(resolveEmbedRedirect(base, '/a b')).toBeNull()
    expect(resolveEmbedRedirect(base, '')).toBeNull()
  })

  it('a URL is never built from text that is not a handle or a shortcode', () => {
    expect(profileEmbedUrl('@Netflix_IN')).toBe('https://www.instagram.com/netflix_in/embed/')
    expect(profileEmbedUrl('a/../b')).toBeNull()
    expect(profileEmbedUrl('accounts/login')).toBeNull()
    expect(profileEmbedUrl('')).toBeNull()
    expect(postEmbedUrl('Dcc4pQ8sX0N')).toBe('https://www.instagram.com/p/Dcc4pQ8sX0N/embed/captioned/')
    expect(postEmbedUrl('../x')).toBeNull()
    expect(postEmbedUrl('abc')).toBeNull()
  })

  it('the headers never include a cookie, a session or the app identity', () => {
    const names = embedHeaders(UA).map(([k]) => k.toLowerCase())
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('x-ig-app-id')
    expect(names).not.toContain('authorization')
    expect(names).toContain('sec-fetch-dest')
  })

  it('embedUserAgent falls back to the default Chrome when handed nonsense', () => {
    expect(embedUserAgent('mac', 147)).toContain('Chrome/147.0.0.0')
    expect(embedUserAgent('mac', 7)).toContain('Chrome/145.0.0.0')
    expect(embedUserAgent('linux')).toContain('X11; Linux x86_64')
  })

  it('parseCurlOutput reads one header block and the body, and skips a proxy’s tunnel block', () => {
    const plain = Buffer.from('HTTP/2 302 \r\nlocation: /accounts/login/\r\nset-cookie: a=b\r\ncontent-type: text/html\r\n\r\nbody here')
    expect(parseCurlOutput(plain)).toMatchObject({ status: 302, location: '/accounts/login/', contentType: 'text/html', body: 'body here' })
    const proxied = Buffer.from('HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>x</html>')
    expect(parseCurlOutput(proxied)).toMatchObject({ status: 200, body: '<html>x</html>' })
    expect(parseCurlOutput(Buffer.from('garbage'))).toBeNull()
  })
})
