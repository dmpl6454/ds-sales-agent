import { NextResponse } from 'next/server'
import { pollEnrolment } from '@/lib/deviceEnrol'

export const dynamic = 'force-dynamic'

/**
 * PUBLIC, and the only thing that authenticates the caller is the 32-byte device code it was
 * handed at `start`. The secrets travel exactly once: the first `approved` answer deletes the
 * row, so a code observed later returns `unknown`.
 *
 * THE CODE TRAVELS IN THE BODY, NEVER THE URL. It is the bearer secret that releases the
 * database connection string, and a query string is written to nginx's and Cloudflare's access
 * logs — a place a secret must not sit even for its 15-minute life. POST JSON `{ deviceCode }`
 * or `Authorization: Bearer <deviceCode>`; there is deliberately no GET handler, so a caller
 * that puts the code in a query string gets 405 rather than a quiet success.
 */
export async function POST(req: Request): Promise<Response> {
  let code = ''
  const auth = req.headers.get('authorization') ?? ''
  if (/^Bearer\s+/i.test(auth)) code = auth.replace(/^Bearer\s+/i, '').trim()
  if (!code) {
    try {
      const body = (await req.json()) as { deviceCode?: unknown }
      if (typeof body?.deviceCode === 'string') code = body.deviceCode.trim()
    } catch {
      /* no body — falls through to `unknown` below */
    }
  }
  const r = await pollEnrolment(code)
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}
