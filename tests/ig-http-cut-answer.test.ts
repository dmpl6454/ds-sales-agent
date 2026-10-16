/**
 * AN ANSWER WHOSE BODY WAS CUT OFF IS STILL AN ANSWER (16 Oct 2026, review of the official-read
 * retry). Drives the REAL request code (`requestOverHttpForTests` — `node:http` instead of
 * `node:https`, the same function otherwise) against a local server, because the defect lived in
 * how the transport rejected, which no scripted transport can show: a status line followed by a
 * reset socket used to reject exactly like a request nothing answered, so a 429 or a rate-limit
 * 400 whose body was lost was retried as "no answer".
 *
 * MUTATIONS (applied once, seen red, restored): `fail = reject` (no status on the rejection) fails
 * the first and third cases; `cutAnswer` accepting a 2xx fails "a 2xx cut off…".
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { answerStatusOf, cutAnswer, requestOverHttpForTests } from '@/detection/igHttp'

let server: http.Server | null = null
async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/feed`
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
})

/** Send the status line and part of a body, then reset the connection. */
const cutAfter = (status: number) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': '500' })
  res.write('{"error":{"code":4,"mess')
  setTimeout(() => res.socket?.destroy(), 20)
}

describe('igHttp: a rejection after the status arrived carries the status', () => {
  it('a 400 whose body is cut off rejects WITH its status, and cutAnswer turns it back into the answer', async () => {
    const url = await serve(cutAfter(400))
    const err = await requestOverHttpForTests(url, { headers: {}, timeoutMs: 5_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(answerStatusOf(err)).toBe(400)
    const cut = cutAnswer(err, 'aborted')!
    expect(cut).toMatchObject({ status: 400, ok: false, contentType: null })
    expect(await cut.text()).toBe("the answer's body was cut off (aborted)")
    await expect(cut.json()).rejects.toThrow()
  })

  it('a request nothing answered carries no status, and is not an answer', async () => {
    const url = await serve(() => {
      /* never writes a status line */
    })
    const err = await requestOverHttpForTests(url, { headers: {}, timeoutMs: 200 }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('timed out after 200 ms')
    expect(answerStatusOf(err)).toBeNull()
    expect(cutAnswer(err, 'timed out')).toBeNull()
  })

  it('a 2xx cut off mid-body stays a transport failure: nothing usable arrived', async () => {
    const url = await serve(cutAfter(200))
    const err = await requestOverHttpForTests(url, { headers: {}, timeoutMs: 5_000 }).catch((e: unknown) => e)
    expect(answerStatusOf(err)).toBe(200)
    expect(cutAnswer(err, 'aborted')).toBeNull()
  })

  it('a whole answer still resolves as before', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"message":"Please wait a few minutes"}')
    })
    const r = await requestOverHttpForTests(url, { headers: {}, timeoutMs: 5_000 })
    expect(r).toMatchObject({ status: 429, ok: false, contentType: 'application/json' })
    expect(await r.json()).toEqual({ message: 'Please wait a few minutes' })
  })

  it('anything that is not such an error has no status', () => {
    expect(answerStatusOf(new Error('x'))).toBeNull()
    expect(answerStatusOf('x')).toBeNull()
    expect(answerStatusOf(Object.assign(new Error('x'), { answerStatus: '400' }))).toBeNull()
  })
})
