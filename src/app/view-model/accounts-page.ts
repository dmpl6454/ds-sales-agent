import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { daysAgo, istDateKey, relativeLabel } from '@/lib/time'
import { operatorName } from '@/outreach/render'
import { cohortSoakDays, mayArmCohort, readCohortStates } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'
import { getSettings } from '@/lib/settings'

/**
 * The `/accounts` page, and only that page.
 *
 * ── WHY THIS IS A SEPARATE BUILDER ────────────────────────────────────────
 *
 * `view-model.ts` is one 815-line `buildCeoView()` behind a single shared `Promise.all`,
 * written when there was one page. At 65 accounts a single page cannot carry accounts,
 * channels, brands, replies, the message tray AND the metrics, so each page now has a
 * builder that queries exactly what it renders. The overview keeps `buildCeoView`; this
 * is the first of the per-page builders and the pattern the others follow.
 *
 * ── 65 ACCOUNTS CANNOT BE A FLAT LIST ─────────────────────────────────────
 *
 * Sixty-five rows of near-identical text is not information. Accounts are GROUPED BY
 * WHAT THEY NEED, with a count per group before any detail, because the only questions
 * anyone actually asks are "how many are ready" and "what is the next thing I have to
 * do". A flat list answers neither without reading all of it.
 */

export type AccountState = 'ready' | 'setup' | 'broken'

export interface AccountRow {
  id: string
  handle: string
  name: string
  status: string
  state: AccountState
  /** A hand login has happened, so this account CAN send unattended. */
  connected: boolean
  connecting: boolean
  /**
   * Is this account in the ROTATION? `fleetMember: false` means it is excluded from
   * `ensureFleetPairs` and `runOutreach` entirely — it is an account we own that writes to
   * nobody, which is what keeps the rehearsal burner out of real outreach.
   *
   * Read by this page since 2026-08-17, because until then it was not: @tabishmukaddam1 has
   * 0 routes and cannot be elected by rotation, and the page filed it under **"Sending on
   * their own"**. A group title stating a capability its members do not have is the same
   * defect as a heading counting rows the claim is false of.
   */
  fleetMember: boolean
  sentThisWeek: number
  sentToday: number
  dailyCap: number
  /**
   * Which fleet this page sends for. Populated since the rotation-groups feature and
   * RENDERED for the first time on 2026-08-25 — the data was here the whole time and no
   * screen drew it, which is this codebase's most repeated shape. EMPTY means the DEFAULT
   * category (see `senderCategories.ts`), not "sends to anyone".
   */
  categories: string[]
  /** One sentence naming the single next thing a person must do, or null. */
  todo: string | null
}

export interface AccountGroup {
  /** `needs-persona` went with the persona gate (2026-08-18) — nothing persona-shaped renders. */
  key: 'broken' | 'needs-login' | 'ready' | 'out-of-fleet'
  title: string
  rows: AccountRow[]
}

export interface AccountsPageView {
  total: number
  groups: AccountGroup[]
  /** Headline counts, so the shape of the fleet is legible before any row is read. */
  summary: { ready: number; needsLogin: number; broken: number; outOfFleet: number }
}

export async function buildAccountsPage(connectingHandles: readonly string[] = []): Promise<AccountsPageView> {
  const weekStart = daysAgo(7)
  const today = istDateKey()
  const settings = await getSettings()

  const [senders, weekCounts, todayCounts] = await Promise.all([
    prisma.senderAccount.findMany({
      orderBy: { handle: 'asc' },
      include: { categories: { include: { category: { select: { name: true } } } } },
    }),
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: weekStart } },
      _count: { _all: true },
    }),
    prisma.dailyReservation.groupBy({
      by: ['subjectId'],
      where: { day: today, scope: 'sender' },
      _count: { _all: true },
    }),
  ])

  const week = new Map(weekCounts.map((c) => [c.senderId, c._count._all]))
  const todayUsed = new Map(todayCounts.map((c) => [c.subjectId, c._count._all]))
  const connecting = new Set(connectingHandles)

  const rows: AccountRow[] = senders.map((s) => {
    const profile = profileStatus(s.handle)
    /**
     * §3.5: "connected" means a cookie on disk AND nothing has since proved it dead. The
     * cookie file survives an Instagram-side revocation, so `profile.hasSession` alone
     * rendered @tabishmukaddam1 as "connected" while every real send failed with "not
     * logged in" — both true at once, and the dashboard was the half that lied.
     */
    const usable = sessionUsable({ hasSessionOnDisk: profile.hasSession, sessionInvalidAt: s.sessionInvalidAt })

    /**
     * ONE SWITCH, 2026-08-08. This used to require `s.autoSendEnabled` as well.
     *
     * `ready` now means "this account CAN send" — an ability, derived from evidence — rather
     * than "somebody has flipped its bit". Nothing was loosened by dropping the bit: an
     * account with a dead session and the bit ON was never able to send, and a signed-in
     * healthy account nobody had flipped was never unable to. Autopilot is the one
     * permission; this is capability.
     */
    const state: AccountState = s.status === 'CHALLENGED' ? 'broken' : usable ? 'ready' : 'setup'

    /**
     * ONE next action, not a list.
     *
     * A to-do list nothing can tick off is a nag rather than information — the reason
     * the old "Needs you" panel was deleted. Ordered by what actually blocks first, so
     * following it always moves the account forward.
     */
    const todo =
      s.status === 'CHALLENGED'
        ? 'Instagram flagged this account. Check it by hand, then release the halt here.'
        : /**
             * ONE SWITCH, 2026-08-08. Every session-less row ends the same way now — the
             * sign-in IS the onboarding, and there is no second step to mention. It used to
             * be followed by "Auto-send is off", which named a control that no longer exists.
             *
             * The EVIDENCE is kept in front of the sentence, because §3.5 is the difference
             * between "a cookie was never written" and "Instagram revoked one we had", and
             * those are not the same fact about an account.
             */
          s.sessionInvalidAt !== null
          ? `Found signed out ${relativeLabel(s.sessionInvalidAt)}. Sign in once — the switch does the rest.`
          : /**
               * `initialised` is still distinguished, and deliberately so: a profile directory
               * WITHOUT a session already holds the device identity a hand login wrote (`mid`,
               * `ig_did`), so that re-login is cheaper AND safer than a first one — Instagram
               * sees a device it already knows. Collapsing the two would hide the difference
               * between "expired" and "never", which is a real fact about the account.
               */
            !profile.hasSession
            ? profile.initialised
              ? 'Signed out. Sign in once — the switch does the rest.'
              : 'Sign in once — the switch does the rest.'
            : null

    return {
      id: s.id,
      handle: s.handle,
      name: operatorName(s.displayName),
      status: s.status,
      state,
      connected: usable,
      connecting: connecting.has(s.handle),
      fleetMember: s.fleetMember,
      sentThisWeek: week.get(s.id) ?? 0,
      sentToday: todayUsed.get(s.id) ?? 0,
      dailyCap: s.dailyCap,
      categories: s.categories.filter((c) => c.enabled).map((c) => c.category.name),
      todo,
    }
  })

  /**
   * Grouped by the NEXT THING TO DO, not by status.
   *
   * Status groups ("active", "paused") answer a question nobody asks. These answer "what
   * is stopping this account sending", which is the only reason to open the page — and
   * each account appears in exactly one group, the first that applies, so the counts sum
   * to the total and nothing is double-reported.
   */
  const taken = new Set<string>()
  const take = (pick: (r: AccountRow) => boolean): AccountRow[] => {
    const got = rows.filter((r) => !taken.has(r.id) && pick(r))
    for (const r of got) taken.add(r.id)
    return got
  }

  /*
    OUT OF THE ROTATION FIRST, because it is a fact about what the account IS rather than
    about what is currently wrong with it. Taken before the others so a burner that also
    happens to be signed out is described by the thing that matters.
  */
  const outOfFleet = take((r) => !r.fleetMember)
  const broken = take((r) => r.status === 'CHALLENGED')
  const needsLogin = take((r) => !r.connected)
  /**
   * "Ready, but waiting for a click" IS GONE — one switch, 2026-08-08.
   *
   * That group existed only to hold accounts whose `autoSendEnabled` bit was off, and the
   * bit is no longer readable as a state anyone can be in. Its rows fold into the groups that
   * describe a real remaining obstacle, and an account with none of those obstacles belongs
   * under "Sending on their own" — which is now true of it, because Autopilot is the only
   * thing between it and a send.
   */
  const ready = take(() => true)

  const groups: AccountGroup[] = [
    {
      key: 'broken',
      title: 'Needs you now',
      rows: broken,
    },
    {
      key: 'needs-login',
      title: 'Not signed in',
      rows: needsLogin,
    },
    {
      key: 'ready',
      title: 'Sending on their own',
      rows: ready,
    },
    {
      key: 'out-of-fleet',
      title: 'Not in the rotation — writes to nobody',
      rows: outOfFleet,
    },
  ]

  return {
    total: rows.length,
    groups: groups.filter((g) => g.rows.length > 0),
    summary: {
      ready: ready.length,
      needsLogin: needsLogin.length,
      broken: broken.length,
      /**
       * THE FOURTH BUCKET, ADDED 2026-08-26. The page's own comment calls these tiles a
       * PARTITION that "sum to the total", and with three of four rendered they did not:
       * @madaboutmarketingg and @tabishmukaddam1 were invisible in the summary while being
       * counted in `total`. A partition missing a part is worse than four loose numbers,
       * because the reader checks the arithmetic and it fails silently.
       */
      outOfFleet: outOfFleet.length,
    },
  }
}

/**
 * The `/accounts/login` queue.
 *
 * 61 hand logins is the real cost of the fleet plan, and they happen over days rather
 * than in one sitting. This is a WORKING QUEUE, not a report: one account at a time, in a
 * stable order, with what is done and what is left. A flat list of 61 handles is exactly
 * what someone abandons halfway through with no way to tell where they got to.
 */
/**
 * PHASE 9: where the fleet is on the cohort ladder.
 *
 * On the page because the ladder is otherwise invisible: an account that cannot be armed looks
 * exactly like one nobody has got round to arming. A refusal with no explanation is the
 * failure this project keeps rediscovering, and thirteen rungs is a long time to be guessing.
 */
export interface CohortLadderView {
  cohort: number
  total: number
  live: number
  connected: number
  flagged: number
  soakDays: number | null
  /** Null when this cohort may be armed; otherwise why not, in a sentence. */
  blockedBecause: string | null
  handles: string[]
}

export interface LoginQueueView {
  done: number
  remaining: number
  /** The ladder, oldest cohort first. */
  ladder: CohortLadderView[]
  /** The soak in force, so the page states the rule rather than only its effect. */
  soakDays: number
  /** Next up, in a stable order so the queue does not reshuffle between visits. */
  queue: { id: string; handle: string; name: string; addedAt: Date; hasProfileDir: boolean }[]
  /** Already logged in, newest first — the progress half. */
  connected: { handle: string; name: string }[]
}

export async function buildLoginQueue(now: Date = new Date()): Promise<LoginQueueView> {
  const senders = await prisma.senderAccount.findMany({ orderBy: [{ createdAt: 'asc' }, { handle: 'asc' }] })
  const [states, soakDays] = await Promise.all([readCohortStates(now), cohortSoakDays()])

  const ladder: CohortLadderView[] = states.map((st) => {
    const verdict = mayArmCohort({ cohort: st.cohort, states, soakDays, now })
    return {
      cohort: st.cohort,
      total: st.members.length,
      live: st.live,
      connected: st.members.filter((m) => m.hasSession).length,
      flagged: st.everChallenged,
      soakDays: st.soakStartedAt === null ? null : Math.floor(st.soakDays),
      blockedBecause: verdict.ok ? null : verdict.detail,
      handles: st.members.map((m) => m.handle),
    }
  })

  const queue: LoginQueueView['queue'] = []
  const connected: LoginQueueView['connected'] = []

  for (const s of senders) {
    const p = profileStatus(s.handle)
    // §3.5: a session PROVED dead belongs in the queue, not under "already logged in" —
    // the whole failure was a dead session reading as done.
    if (sessionUsable({ hasSessionOnDisk: p.hasSession, sessionInvalidAt: s.sessionInvalidAt })) {
      connected.push({ handle: s.handle, name: operatorName(s.displayName) })
    } else {
      queue.push({
        id: s.id,
        handle: s.handle,
        name: operatorName(s.displayName),
        addedAt: s.createdAt,
        /**
         * A profile directory WITHOUT a session is a real and different state: the
         * device identity (`mid`, `ig_did`) is already on disk and only the session has
         * expired. Re-logging in there is cheaper and safer than a first login, because
         * Instagram sees a device it already knows — so it is worth saying which is which
         * rather than lumping both under "not connected".
         */
        hasProfileDir: p.initialised,
      })
    }
  }

  return { done: connected.length, remaining: queue.length, ladder, soakDays, queue, connected }
}
