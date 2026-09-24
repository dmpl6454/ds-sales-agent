import Link from 'next/link'
import { prisma } from '@/lib/db'
import { sessionIsUsable } from './view-model/session-view'
import { getSettings } from '@/lib/settings'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { detectionCutoff } from '@/lib/cutoff'
import { visibleChannelFilter } from '@/detection/visibleChannels'
import { readHeartbeat } from '@/worker/scheduler'
import { buildVersion } from '@/lib/buildVersion'
import { BuildWatch } from './build-watch'
import { SignOutButton } from './sign-out-button'
import { ThemeToggle } from './chrome'

/**
 * The shell's navigation — a TOP BAR, since the DS Sales Agent redesign.
 *
 * ── WHY IT CHANGED BACK ───────────────────────────────────────────────────
 *
 * It was a bar of five links, then a rail with groups, and it is a bar again. That is not a
 * circle: the three faults the rail was built to fix were real, and the bar only gets to
 * return because each of them has an answer that does not need a sidebar.
 *
 *   no sense of place  Five words in a row said what exists, not where you are. Each entry
 *                      now owns a HUE — carried through to the page's own accent and the
 *                      wash behind it — so the whole screen says which section you are in,
 *                      not just the highlighted word.
 *   nowhere for state  Counts and the attention marker sit on the entry they concern,
 *                      exactly as they did in the rail. Nothing was dropped to fit.
 *   no room to grow    The nine-page plan settled at SEVEN, and seven fits across the top
 *                      without wrapping. The grouping the rail carried was only worth a
 *                      column of chrome while there were nine.
 *
 * What the bar buys back is the full width of the window for the content, on a console whose
 * widest objects are tables of sends.
 *
 * ── COUNTS ARE FETCHED HERE, DELIBERATELY ─────────────────────────────────
 *
 * This is an async server component, so every page keeps rendering `<Nav current="/x" />`
 * unchanged and none of them has to thread counts through. That was the constraint on the
 * step that introduced them and it still holds: the shell must not touch page logic, because
 * the risk in a redesign is a warning losing its home, and moving content is what does that.
 *
 * The queries are counts on indexed columns and every page is already `force-dynamic`.
 *
 * ── SEVEN ENTRIES, ALL OF THEM BUILT ──────────────────────────────────────
 *
 * `ENTRIES` is the single source of the IA. A bar entry that 404s is worse than one that is
 * missing, and half a page is worse than either — `pnpm ig:layout` opens every one of them in
 * a real browser and fails on a 404.
 */

interface NavCounts {
  waiting: number
  repliesToHandle: number
  prospects: number
  senders: number
  needSignIn: number
  /** Anything at all that wants a person. Drives the marker on Today. */
  needsAttention: number
  /** Channels being watched. Volume, not attention. */
  channels: number
  /** Paid campaigns detected in the last 7 days. */
  paidPosts: number
}

async function navCounts(): Promise<NavCounts> {
  /**
   * Settings first, because the replies badge counts only ACTIVE halts — a reply inside
   * its resume window (one day, Tabish 2026-08-07). Counting every un-handled reply
   * forever made the badge a nag that outlived the rule it reported.
   */
  const settings = await getSettings()
  const [waiting, repliesToHandle, prospects, senders, channels, paidPosts] = await Promise.all([
    prisma.outreachAttempt.count({ where: { status: 'READY' } }),
    /**
     * `replyPostedAt`, NOT `repliedAt` — the badge must count the halt by the rule that
     * ENFORCES it (2026-08-24).
     *
     * This filtered `repliedAt`, the sweep's OBSERVATION clock, while every enforcer — gate,
     * planner, on-demand, three view models — filters `replyPostedAt`, the date the reply was
     * WRITTEN. MEASURED when it was found: both queries returned 64, and 0 rows disagreed in
     * either direction, so the divergence was LATENT rather than live. It becomes visible the
     * first time a reply is undatable or discovered late: `replyPostedAt: null` never holds the
     * halt (Tabish's permissive rule) but would still have been counted here, so the badge would
     * summon a person to a halt the gate is not applying. Sixth entry in this project's "a page
     * reporting a rule by a different rule than the one enforcing it" family, and the cheapest
     * one to have closed before it fired.
     */
    prisma.outreachAttempt.count({
      where: { replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
    }),
    prisma.targetAccount.count({ where: { optedOut: false } }),
    prisma.senderAccount.findMany({
      select: {
        handle: true,
        status: true,
        sessionInvalidAt: true,
        // The hosted dashboard has no disk truth; the badge reads the device's record.
        sessionPath: true,
      },
    }),
    prisma.targetAccount.count({ where: { kind: 'CHANNEL', optedOut: false } }),
    /**
     * ── THE BADGE COUNTED A DIFFERENT SET THAN THE PAGE IT LINKS TO (2026-08-26) ──
     *
     * It was `{ verdict: 'CAMPAIGN', detectedAt: { gte: daysAgo(7) } }` — two gaps against
     * every other paid figure in the product, and Tabish read the pair side by side and
     * asked what the difference was:
     *
     *  1. NO CHANNEL SCOPE. Our own three pages were counted here and excluded everywhere
     *     else. `tests/visible-channels.test.ts` exists to catch precisely this and its file
     *     list did not include `nav.tsx` — *"the failure mode is a query nobody has written
     *     yet"*, and here it was a query nobody GREPPED. The list now covers this file.
     *  2. THE WRONG CLOCK. `detectedAt` is when WE STORED the row; the destination page
     *     headlines `postedAt` since the 1 August cutoff. A bare integer beside a link whose
     *     page shows a different integer for the same thing is the "a page reporting a rule
     *     by a different rule" family.
     *
     * It is `inWindow` now — the same predicate `totalDetected` uses — so the badge and the
     * number at the top of `/paid-posts` are the same set by construction.
     */
    prisma.detectedCampaign.count({
      where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() }, ...(await visibleChannelFilter()) },
    }),
  ])

  // §3.5: a session PROVED dead counts as needing a sign-in — and the read is HOST-AWARE
  // (2026-09-02): on the Linode the local disk said "7 need sign-in" about a fleet that was
  // signed in and sending. sessionIsUsable trusts the device's DB record there.
  const needSignIn = senders.filter((s) => !sessionIsUsable(s)).length
  const challenged = senders.filter((s) => s.status === 'CHALLENGED').length

  return {
    waiting,
    repliesToHandle,
    prospects,
    senders: senders.length,
    needSignIn,
    /**
     * Unaccounted-for sends were counted here until 2026-08-24 and are not any more: the
     * "Check the conversation" section they pointed at is gone (Tabish), so the badge was
     * summoning a person to a screen with nothing on it. A badge that cannot be cleared stops
     * being read — the same reason the replies badge counts only ACTIVE halts rather than every
     * un-handled reply forever.
     */
    needsAttention: repliesToHandle + challenged,
    channels,
    paidPosts,
  }
}

interface Entry {
  href: string
  label: string
  /**
   * The key the stylesheet matches on to set `--accent` for the whole page, via
   * `body:has([data-page='…'])`. It is a separate field from `href` rather than derived from
   * it because `/` cannot be a CSS identifier and `/paid-posts` would have to be un-slashed
   * anyway — deriving it would be two transformations to keep in step with one list.
   */
  page: string
  /**
   * The destination's hue. This is the entry's IDENTITY, not decoration: it tints the active
   * pill, the page's headings, every panel's lit edge and the wash behind the whole screen,
   * which is the thing that replaced the rail's grouping as the answer to "where am I".
   */
  dot: string
  /** Which count to show, if any. */
  count?: (c: NavCounts) => number
  /** True when the count means "this wants you", not "this is how many there are". */
  attention?: boolean
}

/**
 * `as const satisfies` rather than a type annotation: the annotation widened `href` to
 * `string`, and Next's typed routes need the literal. `satisfies` keeps the literals AND
 * still checks the shape, so a typo in a key is a compile error and a typo in a route is too.
 */
/**
 * SEVEN PAGES, the simple-sender redesign (2026-08-06). Autopilot is the landing page
 * because autopilot is the product — the front door answers "is it sending, and if not
 * what is stopping it". Targets absorbed Channels and Prospects; Senders absorbed
 * Accounts and Sign-ins; the queue and replies fold into Autopilot; history and the
 * old Today numbers live on Analytics. Rules is where the rationale prose went.
 */
const ENTRIES = [
  { href: '/', label: 'Autopilot', page: 'autopilot', dot: '#22d3ee', count: (c) => c.needsAttention, attention: true },
  { href: '/targets', label: 'Targets', page: 'targets', dot: '#ec4899', count: (c) => c.prospects },
  { href: '/paid-posts', label: 'Paid posts', page: 'paid-posts', dot: '#fb923c', count: (c) => c.paidPosts },
  { href: '/analytics', label: 'Analytics', page: 'analytics', dot: '#a78bfa' },
  // The count is a REQUEST, not a volume: how many accounts need signing in.
  { href: '/senders', label: 'Senders', page: 'senders', dot: '#f472b6', count: (c) => c.needSignIn, attention: true },
  { href: '/rules', label: 'Rules', page: 'rules', dot: '#facc15' },
  { href: '/cost', label: 'Cost', page: 'cost', dot: '#34d399' },
] as const satisfies readonly Entry[]

/**
 * `email` is optional so a page that has not been converted yet still compiles, and its absence
 * simply means no sign-out control — never a broken one. `tests/shell.test.ts` asserts every
 * authenticated page passes it, so "optional" does not become "forgotten".
 */
export async function Nav({ current, email }: { current: string; email?: string }) {
  const [counts, heartbeat] = await Promise.all([navCounts(), readHeartbeat()])

  /**
   * `/accounts/login` starts with `/accounts`, so a bare `startsWith` lights both. Longest
   * match wins, which is the only version that survives nested routes being added.
   */
  const activeHref = ENTRIES.map((e) => e.href)
    .filter((h) => (h === '/' ? current === '/' : current === h || current.startsWith(h + '/')))
    .sort((a, b) => b.length - a.length)[0]

  /**
   * The accent key for the WHOLE page, published on the bar because the stylesheet reaches it
   * from `body` with `:has()`. A route nobody matched keeps Autopilot's cyan rather than
   * falling through to an unset accent — an unset custom property resolves to nothing and
   * would paint the panels' lit edge black.
   */
  const page = ENTRIES.find((e) => e.href === activeHref)?.page ?? 'autopilot'

  /**
   * THE HEARTBEAT, ON EVERY SCREEN. A toggle that promises behaviour must show whether
   * anything is behind it: for a day this dashboard reported "Autopilot is ON — messages go
   * out at 11:00" with no process on earth able to send one, and on 2026-08-08 nothing ran
   * for twenty hours while the page said nothing at all.
   *
   * FRESHNESS IS NOT LIVENESS, so this reports what `readHeartbeat` measured and not a guess:
   * a beat older than its window is red, and "we have never seen one" is its own sentence
   * rather than a very old one. The mockup's word for the healthy state is "watching"; the
   * unhealthy states keep their full sentence, because that is the case where the operator
   * needs to know how stale rather than merely that it is.
   */
  const watching = heartbeat?.fresh === true
  const watchLabel =
    heartbeat === null
      ? 'never run'
      : heartbeat.fresh
        ? 'watching'
        : `last ran ${minutesAgo(new Date(heartbeat.beat.at))}`

  return (
    <nav className="topbar" data-page={page} aria-label="Sections">
      <div className="topbar-brand">
        <Link href="/">AI Sales Agent</Link>
      </div>

      <div className="topbar-nav">
        {ENTRIES.map((e) => {
          // `in` narrows the union that `as const` produces — every entry has a
          // different shape, so optional-chaining a key not all of them declare
          // does not typecheck. This keeps the literal routes AND the checks.
          const n = 'count' in e ? e.count(counts) : undefined
          const attention = 'attention' in e && e.attention === true
          const active = e.href === activeHref
          return (
            <Link
              key={e.href}
              href={e.href}
              className="topbar-item"
              // The hue is data, not a class: seven of them would be seven near-identical
              // rules, and the value is already stated once in ENTRIES.
              style={{ ['--dot' as string]: e.dot }}
              title={e.label}
              aria-current={active ? 'page' : undefined}
            >
              <span className="topbar-pip" aria-hidden="true" />
              {e.label}
              {n !== undefined && n > 0 && (
                <span className={attention ? 'rail-count attention' : 'rail-count'}>{n}</span>
              )}
            </Link>
          )
        })}
      </div>

      <div className="topbar-right">
        <div className="topbar-pulse" title={`Build ${buildVersion()}`}>
          <span className={`dot ${watching ? 'dot-good' : 'dot-bad'}`} />
          <span style={watching ? undefined : { color: 'var(--bad)' }}>{watchLabel}</span>
          {/*
            WHICH BUILD IS THIS SCREEN (2026-09-08). The hosted dashboard served yesterday's
            build for a day while the worker ran today's, and nothing said so. Baked in at
            build time (DS_BUILD_SHA), so it names the commit the bundle came from — not the
            server's disk. Every authenticated page reloads itself after a deploy, so no
            button ever calls a dead action id.
          */}
          <BuildWatch rendered={buildVersion()} />
        </div>

        <ThemeToggle />

        {/*
          SIGN OUT LIVES HERE, since step C.

          It was inside `/`'s health card — the one whose border and dot go amber or red. So
          whenever a draft was waiting, which is the ordinary state, the dashboard rendered an
          amber alarm box containing a dot, a warning sentence, "Last check read 168 posts" and
          Sign out. Two separate faults in one container: neutral facts wearing an alarm's
          colour, and a piece of furniture inside a control that is supposed to mean something
          is wrong.

          A container that changes colour must contain only things that colour is about.
          Sign-out is chrome, so it belongs with the navigation, out of the reading path.
        */}
        {email && <SignOutButton email={email} />}
      </div>
    </nav>
  )
}

/** Whole minutes, because a heartbeat age to the second reads as precision nobody needs. */
function minutesAgo(at: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000))
  if (mins < 1) return 'less than a minute ago'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`
}
