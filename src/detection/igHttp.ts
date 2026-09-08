/**
 * igHttp.ts — the ONE transport for anonymous Instagram reads. Plain `node:https`, on purpose.
 *
 * MEASURED 8 Sept 2026, both hosts, same minute, same URL, same headers:
 *
 *   Node's global fetch (undici)      → 400 "SecFetch Policy violation."
 *   Python urllib / curl / node:https → 200, 12 items
 *
 * Node's built-in `fetch` implements the WHATWG spec, which adds `Sec-Fetch-Mode`, `Sec-Fetch-Site`
 * and `Sec-Fetch-Dest` to every request — and the spec forbids scripts from setting or removing
 * `Sec-` headers, so no `headers` option can take them off. Those headers say "I am a browser",
 * which contradicts the Instagram-app identity every read now presents (see FEED_HEADERS in
 * feed.ts), and Instagram refuses the contradiction with a 400. The web identity never tripped
 * this because a browser identity plus browser headers is consistent; it is the identity switch
 * that made the transport matter. `node:https` sends exactly the headers it is given.
 *
 * The shape returned mimics the parts of `Response` the callers already use (`status`, `ok`,
 * `text()`, `json()`), so the four call sites changed one word. Redirects are followed a few
 * times because `exists.ts` relied on `redirect: 'follow'`. A timeout throws, exactly as the
 * `AbortSignal.timeout` it replaces did, so every caller's transport-failure branch is unchanged.
 *
 * Tests substitute the transport with `setIgTransportForTests` rather than stubbing the global
 * `fetch`, which this module no longer touches.
 */
import https from 'node:https'

export interface IgResponse {
  status: number
  ok: boolean
  text(): Promise<string>
  json(): Promise<unknown>
}

export type IgTransport = (url: string, init: { headers: Record<string, string>; timeoutMs: number }) => Promise<IgResponse>

const MAX_REDIRECTS = 3

function request(url: string, headers: Record<string, string>, timeoutMs: number, hop = 0): Promise<IgResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location && hop < MAX_REDIRECTS) {
        res.resume()
        resolve(request(new URL(location, url).toString(), headers, timeoutMs, hop + 1))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => body,
          json: async () => JSON.parse(body) as unknown,
        })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

let transport: IgTransport = (url, init) => request(url, init.headers, init.timeoutMs)

/** GET an Instagram endpoint with exactly these headers and nothing else. */
export function igGet(url: string, init: { headers: Record<string, string>; timeoutMs: number }): Promise<IgResponse> {
  return transport(url, init)
}

/** Tests only: replace the transport (pass undefined to restore the real one). */
export function setIgTransportForTests(fn?: IgTransport): void {
  transport = fn ?? ((url, init) => request(url, init.headers, init.timeoutMs))
}
