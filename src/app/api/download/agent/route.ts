import { NextResponse } from 'next/server'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireUser } from '@/lib/session'
import { env } from '@/lib/env'
import { DATA_ROOT } from '@/lib/paths'

export const dynamic = 'force-dynamic'

/**
 * DOWNLOAD THE macOS INSTALLER (the DMG) FROM THE HOSTED DASHBOARD.
 *
 * GET /api/download/agent
 *
 * The sending half of this system can only run on a real Mac — a hand-logged-in Chrome
 * profile from a home IP is the whole safety design, and no website can install it (browser
 * sandboxing, and the server must never hold a session). So onboarding a new operator's Mac
 * needs a downloadable installer, and this serves it.
 *
 * WHY A FILE ON DISK RATHER THAN BUILT ON DEMAND: the Linode is Linux and cannot build a
 * .dmg. The image is built on a Mac (`bash scripts/build-dmg.sh`) and the deploy copies it to
 * `AGENT_DMG_PATH` (default `<data>/DS-Sales-Agent.dmg`). Updating the code therefore updates
 * the served installer the next time it is rebuilt and deployed — the honest mechanism, since
 * the artifact is macOS-only.
 *
 * The DMG carries ZERO credentials (verified at build time); the DATABASE_URL, the tunnel key
 * and the login are still handed over person to person. So gating at `requireUser` — any
 * signed-in person, viewer or operator — is correct: the download alone grants nothing.
 */
export async function GET(): Promise<Response> {
  await requireUser()

  const path = env.AGENT_DMG_PATH ?? join(DATA_ROOT, 'DS-Sales-Agent.dmg')
  if (!existsSync(path)) {
    return NextResponse.json(
      {
        error:
          'The installer has not been published to this server yet. Build it on a Mac ' +
          '(bash scripts/build-dmg.sh) and deploy so it is copied here.',
      },
      { status: 404 },
    )
  }

  const size = statSync(path).size
  const bytes = readFileSync(path)
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-apple-diskimage',
      'Content-Length': String(size),
      'Content-Disposition': 'attachment; filename="DS-Sales-Agent.dmg"',
      // The installer changes with each deploy; never let a proxy pin an old one.
      'Cache-Control': 'no-store',
    },
  })
}
