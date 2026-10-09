import { NextResponse } from 'next/server'
import { startEnrolment } from '@/lib/deviceEnrol'

export const dynamic = 'force-dynamic'

/**
 * PUBLIC — the Mac calling this has no session yet; that is the point of pairing. It carries
 * nothing sensitive in and hands nothing sensitive out: a public key comes in, two codes go
 * back, and the secrets are released only by `poll` AFTER a signed-in operator approves.
 * See `src/lib/deviceEnrol.ts` for the bounds that make a public start safe.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
  }
  const { deviceName, publicKey } = (body ?? {}) as { deviceName?: unknown; publicKey?: unknown }
  if (typeof deviceName !== 'string' || typeof publicKey !== 'string') {
    return NextResponse.json({ error: 'deviceName and publicKey are required strings' }, { status: 400 })
  }
  const r = await startEnrolment({ deviceName, publicKey })
  if (!r.ok && (r.code === 'name-taken' || r.code === 'name-shared')) {
    /**
     * A TAKEN NAME IS ANSWERED WITH 200 (2026-10-09), on purpose. Installers already handed out
     * call this with `curl -f`, which discards the body of any 4xx and says "check the internet
     * connection" — the wrong remedy, about a sentence the person needed to read. A 200 with no
     * userCode reaches their "The dashboard refused the pairing request: <body>" branch instead,
     * and `error` comes FIRST so the sentence is the first thing in that dialog. New installers
     * read `status` and ask for another name. Malformed input and a full queue stay 400.
     */
    return NextResponse.json(
      { error: r.reason, status: r.code, deviceName: r.name, suggestion: r.suggestion ?? null },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 })
  return NextResponse.json(
    {
      userCode: r.enrolment.userCode,
      deviceCode: r.enrolment.deviceCode,
      deviceName: r.enrolment.deviceName,
      approvePath: `/devices/enrol?code=${r.enrolment.userCode}`,
      expiresInSeconds: 15 * 60,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
