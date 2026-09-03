import { NextResponse } from 'next/server'
import { pollEnrolment } from '@/lib/deviceEnrol'

export const dynamic = 'force-dynamic'

/**
 * PUBLIC, and the only thing that authenticates the caller is the 32-byte device code it was
 * handed at `start`. The secrets travel exactly once: the first `approved` answer deletes the
 * row, so a code observed later returns `unknown`.
 */
export async function GET(req: Request): Promise<Response> {
  const code = new URL(req.url).searchParams.get('device') ?? ''
  const r = await pollEnrolment(code)
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}
