import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { getSettings } from '@/lib/settings'
import { replyHaltFloor } from '@/outreach/replyHalt'
// Never a raw `displayName` — see the note on the import in `view-model.ts`.
import { operatorName } from '@/outreach/render'
/**
 * SERVER ONLY, and this file must stay server-only for it.
 *
 * `profileStatus` reads the credential directory and `prisma` opens the database, so a
 * `'use client'` module importing anything from here would pull `better-sqlite3` into the
 * browser bundle and return HTTP 500 on EVERY route — with `pnpm typecheck` passing
 * throughout. That has happened here once already (`waiting.tsx` → `remedy.ts` → `gate.ts`).
 * `prospects/list.tsx` imports `ProspectRow` with `import type`, which is erased at compile
 * time and carries no runtime edge; keep it that way.
 */
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'

/**
 * The `/prospects` page: everyone we might write to, and what is actually switched on.
 *
 * ── WHY THIS IS NOT THE CHANNELS CARD GROWN LARGER ────────────────────────
 *
 * The existing channels view renders a chip per sender×target route. At four senders and
 * five channels that is twenty chips and it reads well. At 65 senders and 60 targets it is
 * **3,900**, which is not a display problem to solve with scrolling — it is the wrong
 * control. Nobody decides 3,900 routes one at a time.
 *
 * ── AND THEN THE ROUTES STOPPED BEING A DECISION AT ALL (one switch, 2026-08-08) ──
 *
 * The per-route toggle is gone, so this page no longer reports "2 of 8 routes on" either.
 * That count was the honest answer while a route was switchable; once every allowed route
 * exists by rule (`routeAllowed`, `ensureFleetPairs`) it measures nothing an operator can
 * act on, and a number nobody can change is furniture.
 *
 * What replaced it answers the same question — *will anything happen here?* — from ABILITY
 * rather than from configuration: how many fleet accounts can actually send (`sendersAble`),
 * and whether this recipient is retired. Both are facts; neither is a switch.
 */

export interface ProspectRow {
  handle: string
  displayName: string
  kind: string
  /** Are their posts read four times a day? Separate from whether they may be messaged. */
  watchEnabled: boolean
  /** The rotation group whose senders take turns writing to them. */
  category: string | null
  /*
   * `totalPairs` went with the chips. It existed only as the denominator of "2 of 8 routes on",
   * and once nothing can change the numerator the pair count is not a fact about this prospect
   * that anyone acts on — it is the size of a table. Left out rather than left unrendered: a
   * field nobody reads is what a later change wires a new rule to.
   */
  /**
   * `optedOut`: retired, never to be contacted again.
   *
   * ONE field for this, named for what a reader sees. It used to be exposed as BOTH `optedOut`
   * and (via a chip) "retired", and two names for one fact is how a screen comes to state it
   * twice — the duplication the redesign removed. It is the one promise this UI makes that has
   * to survive every other feature, and the governor checks it independently of pairs.
   */
  retired: boolean
  /** Messages actually delivered to them, ever. Counted the way the enforcer counts. */
  delivered: number
  /** Set once anyone answers. Halts every sender to them until a person takes over. */
  replied: boolean
  importNote: string | null
}

export interface ProspectsPageView {
  prospects: ProspectRow[]
  categories: { name: string; senders: number; targets: number }[]
  /**
   * How many fleet accounts can ACTUALLY send right now — ACTIVE, and holding a session
   * nothing has proved dead.
   *
   * One number for the page, not one per prospect: since routes stopped being switchable
   * (one switch, 2026-08-08) the answer is identical for every recipient, and computing it
   * per row would be 60 filesystem reads saying the same thing. It is the honest answer to
   * "will anything happen here" that the old chip wall buried — and it is ABILITY, so it
   * reads zero when the fleet is signed out even while Autopilot is on.
   */
  sendersAble: number
  /** Feeds being read every slot, and what that costs in requests. */
  watched: number
  /**
   * Requests per slot that watching currently implies.
   *
   * On screen because the cost of watching is invisible otherwise, and it is the reason
   * `watchEnabled` exists: four pages per target per slot turns 16 requests into ~240 once
   * a prospect list lands, against an anonymous endpoint whose only risk is rate limiting.
   */
  requestsPerSlot: number
}

/** Pages the detection pipeline reads per channel per slot. Mirrors `MAX_PAGES` there. */
const PAGES_PER_CHANNEL = 4

export async function buildProspectsPage(): Promise<ProspectsPageView> {
  // The "they replied" chip means "halted NOW", so it needs the halt's own window.
  const settings = await getSettings()
  const [targets, categoryRows, fleetSenders] = await Promise.all([
    prisma.targetAccount.findMany({
      orderBy: [{ kind: 'asc' }, { handle: 'asc' }],
      include: {
        // The joined `pairs` (one row per sender, with its display name) went with the chips —
        // one switch, 2026-08-08. Nothing renders a sender name per prospect any more, and at
        // 65×60 that include was the page's largest query for a figure nobody could act on.
        _count: { select: { attempts: true } },
        categories: { include: { category: { select: { name: true } } } },
      },
    }),
    prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { senders: true, targets: true } } },
    }),
    /**
     * `fleetMember: true` is load-bearing, exactly as it is in `plan.ts` and `routes.ts`.
     * The burner (@tabishmukaddam1) is not in the rotation, so counting it would overstate
     * what will happen to a real prospect — and overstating that is the direction this
     * codebase must not fail in.
     */
    prisma.senderAccount.findMany({
      where: { fleetMember: true, status: 'ACTIVE' },
      select: { handle: true, sessionInvalidAt: true },
    }),
  ])

  /**
   * Composed exactly the way `plan.ts` composes it: a cookie on disk AND nothing has since
   * proved it dead. `hasSession` alone reported @tabishmukaddam1 as connected while every
   * real send failed with a login form — freshness is not liveness.
   */
  const sendersAble = fleetSenders.filter((s) =>
    sessionUsable({ hasSessionOnDisk: profileStatus(s.handle).hasSession, sessionInvalidAt: s.sessionInvalidAt }),
  ).length

  /**
   * Delivered counts and reply state in ONE query rather than per row.
   *
   * At 60 prospects the per-row version is 120 extra queries every render. The planner's
   * per-pair loop is already the measured bottleneck at fleet size (~27,300 queries a
   * slot); a page that repeats the mistake would be the same bug in a place nobody
   * profiles.
   */
  const [deliveredRows, repliedRows] = await Promise.all([
    prisma.outreachAttempt.groupBy({
      by: ['targetId'],
      where: { status: { in: [...DELIVERED_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.outreachAttempt.findMany({
      // ACTIVE halts only — the chip says messaging is stopped, so it must use the same
      // one-day window the gate does (Tabish, 2026-08-07; see outreach/replyHalt.ts).
      where: { repliedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
      select: { targetId: true },
      distinct: ['targetId'],
    }),
  ])
  const deliveredBy = new Map(deliveredRows.map((r) => [r.targetId, r._count._all]))
  const repliedSet = new Set(repliedRows.map((r) => r.targetId))

  const prospects: ProspectRow[] = targets.map((t) => ({
    handle: t.handle,
    displayName: operatorName(t.displayName),
    kind: t.kind,
    watchEnabled: t.watchEnabled,
    category: t.categories.find((c) => c.enabled)?.category.name ?? null,
    retired: t.optedOut,
    delivered: deliveredBy.get(t.id) ?? 0,
    replied: repliedSet.has(t.id),
    importNote: t.importNote,
  }))

  const watched = prospects.filter((p) => p.watchEnabled && p.kind === 'CHANNEL' && !p.retired).length

  return {
    prospects,
    categories: categoryRows.map((c) => ({
      name: c.name,
      senders: c._count.senders,
      targets: c._count.targets,
    })),
    sendersAble,
    watched,
    requestsPerSlot: watched * PAGES_PER_CHANNEL,
  }
}
