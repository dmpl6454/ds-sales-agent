/**
 * embedFetch.ts — fetch ONE Instagram embed page the way `scripts/embed-badge-probe.sh` did on 26 Nov 2026.
 *
 * Node built-ins only and no project import, for the same reason as `embedParse.ts`: the Mac check
 * (`scripts/embed-check-on-mac.sh`) fetches this file on its own and runs it from an installed tree.
 *
 * ── WHAT IS SENT, AND WHY IT IS NOT `igGet` ──────────────────────────────────────────────────────
 *
 * `igHttp.ts` presents the Instagram APP's identity to the app's API and must never carry a browser header. An
 * embed page is the opposite request: a web page loaded in another site's iframe, by a desktop Chrome. So this is
 * a second, separate identity for a second, separate kind of URL — only `/<handle>/embed/` and
 * `/p/<shortcode>/embed/captioned/` — and the two are never mixed: nothing here can reach the API, and `igGet`
 * never asks for these pages.
 *
 *   NO LOGIN, NO COOKIE. Nothing here sends one, and a cookie a page tries to set is never read, kept or sent
 *   (decision 4: an anonymous read must stay anonymous; a session here would turn an address-level risk into an
 *   account-level one).
 *
 * Two transports, because only one of them has been MEASURED: the probe was `curl`, and curl was answered. Node's
 * own TLS and HTTP/1.1 are a different client on the wire, and whether Instagram answers it the same is unknown
 * until `pnpm ig:embed-check` says so on the Mac. `node` sends exactly the headers below over `node:https`;
 * `curl` runs the system curl with the probe's own arguments.
 *
 * ── THE STOP RULES, THE PROBE'S ──────────────────────────────────────────────────────────────────
 *
 * A redirect is followed at most three times, only over https to instagram.com, and NEVER to a login page: being
 * sent to one is the door refusing, and it is reported as that. Nothing is retried here. What a caller does with a
 * refusal (close the door for a while) lives with the caller.
 */
import https from 'node:https'
import http from 'node:http'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'

export const EMBED_IG_ORIGIN = 'https://www.instagram.com'
/** The probe's cap. A profile embed measured ~1 MB; anything past this is cut and reported as cut. */
export const EMBED_MAX_BYTES = 3 * 1024 * 1024
export const EMBED_TIMEOUT_MS = 25_000
const CONNECT_TIMEOUT_S = 10
export const EMBED_MAX_HOPS = 3
/** The Chrome major the probe falls back to when it cannot read the one installed. */
export const EMBED_DEFAULT_CHROME_MAJOR = 145

export type EmbedPlatform = 'mac' | 'windows' | 'linux'
export type EmbedTransportName = 'node' | 'curl'

export function embedUserAgent(platform: EmbedPlatform, chromeMajor: number = EMBED_DEFAULT_CHROME_MAJOR): string {
  const major = Number.isInteger(chromeMajor) && chromeMajor >= 100 && chromeMajor <= 999 ? chromeMajor : EMBED_DEFAULT_CHROME_MAJOR
  const os = platform === 'mac' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'windows' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/**
 * The headers a browser sends for an iframe load, in the order the probe sent them. NOT a `Cookie`, ever.
 * (`Sec-Fetch-*` can be set here because this is not `fetch()` — see igHttp.ts for why that matters.)
 */
export function embedHeaders(userAgent: string): Array<[string, string]> {
  return [
    ['User-Agent', userAgent],
    ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['Accept-Encoding', 'gzip, deflate'],
    ['Upgrade-Insecure-Requests', '1'],
    ['Sec-Fetch-Dest', 'iframe'],
    ['Sec-Fetch-Mode', 'navigate'],
    ['Sec-Fetch-Site', 'cross-site'],
  ]
}

const HANDLE = /^[a-z0-9._]{1,30}$/
const SHORTCODE = /^[A-Za-z0-9_-]{5,40}$/

/** Null when `handle` is not shaped like one — a URL is never built from text that is not a handle. */
export function profileEmbedUrl(handle: string, origin: string = EMBED_IG_ORIGIN): string | null {
  const h = handle.trim().replace(/^@/, '').toLowerCase()
  return HANDLE.test(h) ? `${origin}/${h}/embed/` : null
}

export function postEmbedUrl(shortcode: string, origin: string = EMBED_IG_ORIGIN): string | null {
  return SHORTCODE.test(shortcode) ? `${origin}/p/${shortcode}/embed/captioned/` : null
}

/** PURE. Is this redirect target a login page? The probe's rule. */
export function isLoginUrl(location: string): boolean {
  const u = location.toLowerCase()
  let path = u
  if (/^https?:\/\//.test(u)) {
    const rest = u.replace(/^https?:\/\//, '')
    path = rest.includes('/') ? rest.slice(rest.indexOf('/')) : '/'
  } else if (u.startsWith('//')) {
    const rest = u.slice(2)
    path = rest.includes('/') ? rest.slice(rest.indexOf('/')) : '/'
  }
  return (
    path.includes('/accounts/login') ||
    path === '/login' ||
    path.startsWith('/login/') ||
    path.startsWith('/login?') ||
    path.startsWith('/login#')
  )
}

/** PURE. The next URL a redirect may be followed to, or null: https, instagram.com (or the test origin), readable. */
export function resolveEmbedRedirect(base: string, location: string, testOrigin?: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (location === '' || /[^!-~]/.test(location)) return null
  let next: URL
  try {
    next = new URL(location, base)
  } catch {
    return null
  }
  if (testOrigin !== undefined) return next.origin === new URL(testOrigin).origin ? next.toString() : null
  if (next.protocol !== 'https:') return null
  const host = next.hostname.toLowerCase()
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null
  return next.toString()
}

/** One request, no redirect followed. */
interface Hop {
  status: number
  location: string | null
  contentType: string | null
  body: string
  /** True when the body was longer than the cap and was cut there. */
  capped: boolean
}

export type EmbedAnswer =
  /** A final answer with a body, whatever its status. 200 is the only one a parser should be shown. */
  | { kind: 'page'; status: number; body: string; contentType: string | null; hops: number; capped: boolean }
  /** Sent to a login page: the door is refusing this client from this address. */
  | { kind: 'login-redirect'; status: number; location: string }
  /** A redirect this does not follow: off-site, unreadable, or more than three in a row. */
  | { kind: 'redirect-refused'; status: number; location: string }
  /** Nothing came back: a timeout, a reset, no network, curl missing. */
  | { kind: 'no-answer'; error: string }

export interface EmbedFetchOptions {
  userAgent: string
  transport: EmbedTransportName
  timeoutMs?: number
  /** Tests only: a plain-http origin on this machine that stands in for Instagram. */
  testOrigin?: string
  /** The curl to run for the `curl` transport. `/usr/bin/curl` on a Mac. */
  curlPath?: string
}

function nodeHop(url: string, headers: Array<[string, string]>, timeoutMs: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https
    const flat: Record<string, string> = {}
    for (const [k, v] of headers) flat[k] = v
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    const req = mod.request(url, { method: 'GET', headers: flat, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0
      const loc = res.headers.location
      const ct = res.headers['content-type']
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
      const stream = enc.includes('gzip') ? res.pipe(zlib.createGunzip()) : enc.includes('deflate') ? res.pipe(zlib.createInflate()) : res
      const chunks: Buffer[] = []
      let size = 0
      let capped = false
      const finish = (): void =>
        done(() =>
          resolve({
            status,
            location: typeof loc === 'string' ? loc : null,
            contentType: typeof ct === 'string' ? ct : null,
            body: Buffer.concat(chunks).toString('utf8'),
            capped,
          }),
        )
      stream.on('data', (c: Buffer) => {
        if (capped) return
        if (size + c.length > EMBED_MAX_BYTES) {
          chunks.push(c.subarray(0, EMBED_MAX_BYTES - size))
          size = EMBED_MAX_BYTES
          capped = true
          req.destroy()
          finish()
          return
        }
        chunks.push(c)
        size += c.length
      })
      stream.on('end', finish)
      stream.on('error', (e: Error) => done(() => reject(e)))
      res.on('error', (e: Error) => done(() => reject(e)))
    })
    // `timeout` above is an IDLE timeout; this is the bound on the whole request, as curl's --max-time was.
    const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', (e: Error) => done(() => reject(e)))
    req.end()
  })
}

/** PURE. curl's `-D -` output (one header block, then the body) as a hop. Null when it is not that. */
export function parseCurlOutput(input: Buffer): Hop | null {
  let out = input
  // Through a proxy curl prints the tunnel's own "200 Connection established" block first: that is not the answer.
  for (let guard = 0; guard < 3; guard++) {
    const firstLine = out.subarray(0, Math.min(out.length, 120)).toString('latin1').split(/\r?\n/)[0] ?? ''
    if (!/^HTTP\/[0-9.]+ +200 +connection established/i.test(firstLine)) break
    const end = out.indexOf('\r\n\r\n')
    if (end < 0) break
    out = out.subarray(end + 4)
  }
  let split = out.indexOf('\r\n\r\n')
  let gap = 4
  if (split < 0) {
    split = out.indexOf('\n\n')
    gap = 2
  }
  if (split < 0) return null
  const head = out.subarray(0, split).toString('latin1')
  const lines = head.split(/\r?\n/)
  const m = /^HTTP\/[0-9.]+ +([0-9]{3})/.exec(lines[0] ?? '')
  if (!m) return null
  let location: string | null = null
  let contentType: string | null = null
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (name === 'location') location = value
    else if (name === 'content-type') contentType = value
    // A Set-Cookie line is never read: its value goes nowhere.
  }
  let body = out.subarray(split + gap)
  let capped = false
  if (body.length > EMBED_MAX_BYTES) {
    body = body.subarray(0, EMBED_MAX_BYTES)
    capped = true
  }
  return { status: Number(m[1]), location, contentType, body: body.toString('utf8'), capped }
}

function curlHop(url: string, headers: Array<[string, string]>, timeoutMs: number, curlPath: string): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const ua = headers.find(([k]) => k === 'User-Agent')?.[1] ?? ''
    const args = [
      '-q', '-sS', '--proto', '=http,https',
      '--connect-timeout', String(CONNECT_TIMEOUT_S),
      '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))),
      '--compressed', '-D', '-', '-o', '-', '-A', ua,
    ]
    for (const [k, v] of headers) {
      if (k === 'User-Agent') continue
      args.push('-H', `${k}: ${v}`)
    }
    args.push('--', url)
    // No shell: the URL and every header are separate arguments. No -L (redirects are ours to judge), no cookie jar.
    execFile(curlPath, args, { encoding: 'buffer', maxBuffer: EMBED_MAX_BYTES + 256 * 1024, timeout: timeoutMs + 5_000 }, (err, stdout) => {
      const hop = stdout && stdout.length > 0 ? parseCurlOutput(stdout as Buffer) : null
      if (hop) {
        resolve(hop)
        return
      }
      reject(err ?? new Error('curl returned nothing readable'))
    })
  })
}

/** Fetch one embed page. Never throws: nothing coming back is `no-answer`. */
export async function fetchEmbed(startUrl: string, opts: EmbedFetchOptions): Promise<EmbedAnswer> {
  const timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS
  const headers = embedHeaders(opts.userAgent)
  let url = startUrl
  // The first URL obeys the same host rule a redirect does: this can only ever ask Instagram (or the test stand-in).
  if (resolveEmbedRedirect(url, url, opts.testOrigin) === null) return { kind: 'no-answer', error: 'not an Instagram URL' }
  for (let hops = 0; ; hops++) {
    let hop: Hop
    try {
      hop = opts.transport === 'curl' ? await curlHop(url, headers, timeoutMs, opts.curlPath ?? 'curl') : await nodeHop(url, headers, timeoutMs)
    } catch (err) {
      return { kind: 'no-answer', error: err instanceof Error ? err.message || err.name : String(err) }
    }
    const redirect = hop.status === 301 || hop.status === 302 || hop.status === 303 || hop.status === 307 || hop.status === 308
    if (!redirect || hop.location === null || hop.location === '') {
      return { kind: 'page', status: hop.status, body: hop.body, contentType: hop.contentType, hops, capped: hop.capped }
    }
    if (isLoginUrl(hop.location)) return { kind: 'login-redirect', status: hop.status, location: hop.location }
    const next = resolveEmbedRedirect(url, hop.location, opts.testOrigin)
    if (next === null || hops >= EMBED_MAX_HOPS) return { kind: 'redirect-refused', status: hop.status, location: hop.location }
    url = next
  }
}

/**
 * The major version of the Chrome installed on this Mac, as the probe read it, or the default. Asked once.
 * (`defaults` exists only on macOS; anywhere else this is the default straight away.)
 */
let chromeMajorOnce: Promise<number> | null = null
export function installedChromeMajor(platform: EmbedPlatform): Promise<number> {
  if (platform !== 'mac') return Promise.resolve(EMBED_DEFAULT_CHROME_MAJOR)
  chromeMajorOnce ??= new Promise<number>((resolve) => {
    execFile('defaults', ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'], { timeout: 5_000 }, (err, stdout) => {
      const major = Number(String(stdout ?? '').trim().split('.')[0])
      resolve(!err && Number.isInteger(major) && major >= 100 && major <= 999 ? major : EMBED_DEFAULT_CHROME_MAJOR)
    })
  })
  return chromeMajorOnce
}
