import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { currentUser } from '@/lib/session'
import { composeStamp, PULSE_IGNORED_SETTING_KEYS } from './stamp'
import { buildVersion } from '@/lib/buildVersion'

/**
 * GET /api/pulse → `{ stamp, build }` — has anything a dashboard page shows changed, and which build serves it?
 *
 * Polled by `auto-refresh.tsx` instead of blindly re-rendering the page on a timer. The
 * composition and the reasoning — including why five hot `Setting` keys are excluded — live
 * in `./stamp.ts`, which is PURE; this file is the reader only: five aggregate queries, all
 * issued at once, against columns that are indexed where the table is large.
 *
 * ── THE COST, STATED ─────────────────────────────────────────────────────────────────
 *
 * Five queries per poll per open tab, every 30-45 s. Against a page render of 100-160
 * queries plus hydration on one vCPU (MEASURED: `/` 2.1 s warm, 5.3 s cold) this is the
 * cheap question that lets the expensive one be skipped. It is also five queries the
 * `DS_QUERY_COUNT` counter will see if a poll lands inside an `ig:layout` check window — the
 * same flake the old refresh caused with a FULL render, now bounded at five.
 *
 * ── BEHIND THE FRONT DOOR, TWICE ─────────────────────────────────────────────────────
 *
 * `middleware.ts` is deny-by-default and `/api/pulse` is deliberately NOT in `PUBLIC_PATHS`
 * (pinned in `tests/middleware.test.ts`), so an anonymous poll is redirected to the sign-in
 * page before this runs. `currentUser()` is asked here as well — middleware is a router
 * filter and this is an endpoint, the same reasoning that puts `requireUser()` at the top of
 * every server action. A bare 401 rather than a throw: a thrown error is a 500, and the
 * client treats both as "do nothing", but a 500 in the server log for an expired session
 * would send somebody hunting a fault that is not there.
 *
 * `no-store` on the response and `force-dynamic` on the route, because a cached stamp is a
 * change detector that cannot see change.
 */
export const dynamic = 'force-dynamic'

/**
 * Drafts that exist and have not reached a terminal state. NOT `IN_FLIGHT_STATUSES`, which
 * includes SENT/REPLIED — those are already covered by `max(sentAt)`/`max(repliedAt)`, and a
 * count including them would only move when a delivery does. This count is the one thing
 * that moves when a draft changes status WITHOUT a timestamp: READY → SENDING → FAILED.
 */
const PENDING_STATUSES = ['SENDING', 'READY', 'QUEUED'] as const

export async function GET() {
  const user = await currentUser()
  if (!user) return new NextResponse(null, { status: 401, headers: { 'Cache-Control': 'no-store' } })

  const [attempts, inFlight, posts, settings, senders] = await Promise.all([
    prisma.outreachAttempt.aggregate({ _max: { sentAt: true, queuedAt: true, repliedAt: true } }),
    prisma.outreachAttempt.count({ where: { status: { in: [...PENDING_STATUSES] } } }),
    prisma.detectedCampaign.aggregate({ _max: { detectedAt: true }, _count: { _all: true } }),
    prisma.setting.aggregate({
      where: { key: { notIn: [...PULSE_IGNORED_SETTING_KEYS] } },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    prisma.senderAccount.aggregate({ _max: { updatedAt: true } }),
  ])

  const stamp = composeStamp({
    lastSentAt: attempts._max.sentAt,
    lastQueuedAt: attempts._max.queuedAt,
    lastRepliedAt: attempts._max.repliedAt,
    inFlight,
    lastDetectedAt: posts._max.detectedAt,
    postCount: posts._count._all,
    settingsUpdatedAt: settings._max.updatedAt,
    settingCount: settings._count._all,
    senderUpdatedAt: senders._max.updatedAt,
  })

  // `build` lets an open tab notice a deploy and reload itself (build-watch.tsx, 2026-09-10).
  return NextResponse.json({ stamp, build: buildVersion() }, { headers: { 'Cache-Control': 'no-store' } })
}