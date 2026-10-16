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
import http from 'node:http'
import { CUT_OFF_MARKER } from './cutOff'

export interface IgResponse {
  status: number
  ok: boolean
  /**
   * The response's `content-type`, when the transport knows it. Optional so a test transport
   * may leave it out; `feedEvidence.ts` records it beside a failed answer, because "a web page
   * where JSON was expected" is half of what a 200 refusal looks like.
   */
  contentType?: string | null
  text(): Promise<string>
  json(): Promise<unknown>
}

export type IgTransport = (url: string, init: { headers: Record<string, string>; timeoutMs: number }) => Promise<IgResponse>

const MAX_REDIRECTS = 3

/**
 * ── AN ANSWER WHOSE BODY WAS CUT OFF IS STILL AN ANSWER (16 Oct 2026, review) ───────────────
 *
 * A rejection that comes AFTER the status line arrived — the socket reset or timed out mid-body —
 * used to look exactly like a request nothing answered, so a 429 or a rate-limit 400 whose body
 * was lost was retried as "no answer": the anonymous feed up to three more times, the official
 * read once, each into a throttle that had already spoken. The rejection now carries the status
 * (`answerStatus`), and `cutAnswer` turns a non-2xx one back into the answer it was. A 2xx whose
 * body was cut stays a transport failure: nothing usable arrived, and asking again is right.
 */
type CutError = Error & { answerStatus?: number }

/** The status of an answer whose body was cut off (the transport failed after the status arrived), or null. */
export function answerStatusOf(err: unknown): number | null {
  const s = err instanceof Error ? (err as CutError).answerStatus : undefined
  return typeof s === 'number' ? s : null
}

/**
 * A NON-2xx answer whose body was cut off, as the response it was — its status, and a body saying
 * what happened (`why`, already redacted by the caller) — so a caller files it as an ANSWER and
 * never re-asks it as if nothing had come back. Null for anything else.
 */
export function cutAnswer(err: unknown, why: string): IgResponse | null {
  const status = answerStatusOf(err)
  if (status === null || (status >= 200 && status < 300)) return null
  const body = `${CUT_OFF_MARKER} (${why})`
  return {
    status,
    ok: false,
    contentType: null,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

type RequestModule = Pick<typeof https, 'request'>

function request(url: string, headers: Record<string, string>, timeoutMs: number, hop = 0, mod: RequestModule = https): Promise<IgResponse> {
  return new Promise((resolve, reject) => {
    // Set once the status line arrived: a failure after that is a cut-off ANSWER, not "no answer".
    let answered: number | null = null
    const fail = (err: Error): void => reject(answered === null ? err : Object.assign(err, { answerStatus: answered }))
    const req = mod.request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location && hop < MAX_REDIRECTS) {
        res.resume()
        resolve(request(new URL(location, url).toString(), headers, timeoutMs, hop + 1, mod))
        return
      }
      answered = status
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const ct = res.headers['content-type']
        resolve({
          status,
          ok: status >= 200 && status < 300,
          contentType: typeof ct === 'string' ? ct : null,
          text: async () => body,
          json: async () => JSON.parse(body) as unknown,
        })
      })
      res.on('error', fail)
    })
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', fail)
    req.end()
  })
}

let transport: IgTransport = (url, init) => request(url, init.headers, init.timeoutMs)

/** GET an Instagram endpoint with exactly these headers and nothing else. */
export function igGet(url: string, init: { headers: Record<string, string>; timeoutMs: number }): Promise<IgResponse> {
  return transport(url, init)
}

/** Tests only: the REAL request code over plain `node:http`, so a local server can drive it without a certificate. */
export function requestOverHttpForTests(url: string, init: { headers: Record<string, string>; timeoutMs: number }): Promise<IgResponse> {
  return request(url, init.headers, init.timeoutMs, 0, http)
}

/** Tests only: replace the transport (pass undefined to restore the real one). */
export function setIgTransportForTests(fn?: IgTransport): void {
  transport = fn ?? ((url, init) => request(url, init.headers, init.timeoutMs))
}
