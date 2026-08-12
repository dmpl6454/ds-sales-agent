import Link from 'next/link'
import { prisma } from '@/lib/db'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'
import { checkPersonaDistinct } from '@/outreach/brandGuards'
import { getSettings } from '@/lib/settings'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { daysAgo } from '@/lib/time'
import { readHeartbeat } from '@/worker/scheduler'
import { SignOutButton } from './sign-out-button'
import { RailToggle } from './chrome'

/**
 * The shell's navigation — a SIDEBAR, since 2026-08-05.
 *
 * ── WHY IT CHANGED ────────────────────────────────────────────────────────
 *
 * It was a horizontal bar of five links. Tabish's words: the dashboard is *"confusing to use
 * and quite dull"*. Three specific things were wrong and a bar cannot fix any of them:
 *
 *   no sense of place  Five words in a row say what exists, not where you are or how the
 *                      parts relate. A rail with GROUPS says both, because the grouping is
 *                      itself information: this system genuinely has an outreach half, a
 *                      fleet half, and setup.
 *   nowhere for state  "Three accounts need signing in" has no home in a bar. Counts and an
 *                      attention marker belong beside the destination they concern, which
 *                      removes the need for a to-do list — and the old "Needs you" list was
 *                      deleted for putting shell commands on screen, with nothing replacing
 *                      the idea.
 *   no room to grow    The plan splits `/` and `/messages` into nine single-job pages. Nine
 *                      items across the top is a second flat list to read.
 *
 * ── COUNTS ARE FETCHED HERE, DELIBERATELY ─────────────────────────────────
 *
 * This is an async server component, so every page keeps rendering `<Nav current="/x" />`
 * unchanged and none of them has to thread counts through. That was the constraint on this
 * step: the shell must not touch page logic, because the risk in this redesign is a warning
 * losing its home, and moving content is what does that.
 *
 * The queries are counts on indexed columns and every page is already `force-dynamic`.
 *
 * ── NINE ENTRIES, ALL OF THEM BUILT ───────────────────────────────────────
 *
 * `GROUPS` is the single source of the IA. It listed six while Conversations, Channels and Paid
 * posts were agreed but not built, deliberately — a rail entry that 404s is worse than one that
 * is missing, and half a page is worse than either. Steps C and D built all three, and
 * `pnpm ig:layout` opens every one of them in a real browser and fails on a 404.
 */

interface NavCounts {
  waiting: number
  repliesToHandle: number
  prospects: number
  senders: number
  needSignIn: number
  /** How many accounts cannot send because another account has the same identity. */
  sharedPersona: number
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
  const [waiting, repliesToHandle, prospects, senders, uncertain, channels, paidPosts] = await Promise.all([
    prisma.outreachAttempt.count({ where: { status: 'READY' } }),
    prisma.outreachAttempt.count({
      where: { repliedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
    }),
    prisma.targetAccount.count({ where: { optedOut: false } }),
    prisma.senderAccount.findMany({
      select: {
        handle: true,
        status: true,
        sessionInvalidAt: true,
        personaName: true,
        personaRole: true,
        personaBrand: true,
        personaPhone: true,
        personaEmail: true,
      },
    }),
    prisma.outreachAttempt.count({ where: { status: 'FAILED', failureCode: 'not-in-thread' } }),
    prisma.targetAccount.count({ where: { kind: 'CHANNEL', optedOut: false } }),
    prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN', detectedAt: { gte: daysAgo(7) } } }),
  ])

  // §3.5: a session PROVED dead counts as needing a sign-in — the badge said 3 while a
  // fourth account was logged out with a cookie still on disk.
  const needSignIn = senders.filter(
    (s) => !sessionUsable({ hasSessionOnDisk: profileStatus(s.handle).hasSession, sessionInvalidAt: s.sessionInvalidAt }),
  ).length
  const challenged = senders.filter((s) => s.status === 'CHALLENGED').length

  /**
   * The persona clash is counted through the SAME function that blocks the send, not by
   * comparing fields here. CLAUDE.md records why: a page working this out its own way can
   * disagree with the rule actually refusing, and the dashboard then shows headroom that does
   * not exist.
   */
  const sharedPersona = senders.filter(
    (me) =>
      !checkPersonaDistinct({
        persona: me,
        otherPersonas: senders.filter((o) => o.handle !== me.handle),
        targetKind: 'CHANNEL',
        gateChannels: settings.personaGateChannels,
      }).ok,
  ).length

  return {
    waiting,
    repliesToHandle,
    prospects,
    senders: senders.length,
    needSignIn,
    sharedPersona,
    needsAttention: repliesToHandle + uncertain + challenged + (sharedPersona > 0 ? 1 : 0),
    channels,
    paidPosts,
  }
}

interface Entry {
  href: string
  label: string
  /**
   * The two-letter code shown in the rail, and the only thing left when the rail is
   * collapsed. Deliberately NOT an icon set: an icon is a second vocabulary to learn
   * and to keep consistent, and at 10px "PP" is unambiguous where a glyph for "paid
   * posts" is a guess. It also cannot drift from the label the way a picture can.
   */
  code: string
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
const GROUPS = [
  {
    label: null,
    entries: [{ href: '/', label: 'Autopilot', code: 'AU', count: (c) => c.needsAttention, attention: true }],
  },
  {
    label: 'Outreach',
    entries: [
      { href: '/targets', label: 'Targets', code: 'TG', count: (c) => c.prospects },
      { href: '/paid-posts', label: 'Paid posts', code: 'PP', count: (c) => c.paidPosts },
      { href: '/analytics', label: 'Analytics', code: 'AN' },
    ],
  },
  {
    label: 'The fleet',
    // The count is a REQUEST, not a volume: how many accounts need signing in.
    entries: [{ href: '/senders', label: 'Senders', code: 'SE', count: (c) => c.needSignIn, attention: true }],
  },
  {
    label: null,
    entries: [
      { href: '/rules', label: 'Rules', code: 'RU' },
      { href: '/cost', label: 'Cost', code: 'CO' },
      { href: '/settings', label: 'Settings', code: 'ST' },
    ],
  },
] as const satisfies ReadonlyArray<{ label: string | null; entries: readonly Entry[] }>

/**
 * `email` is optional so a page that has not been converted yet still compiles, and its absence
 * simply means no sign-out control — never a broken one. `tests/shell.test.ts` asserts every
 * authenticated page passes it, so "optional" does not become "forgotten".
 */
/**
 * The rail's own geometry, in one place, because the sliding active marker needs to know
 * where each row sits and there is no honest source for that but the layout itself.
 *
 * These four numbers are the ONLY duplication between this file and `globals.css`, and a
 * mismatch is visible instantly (the marker sits beside the wrong row) rather than silently,
 * which is why it is acceptable to state them here rather than measure in the browser.
 * Measuring would mean a client component and a layout pass to draw two pixels.
 */
const ROW_H = 34
const GROUP_LABEL_H = 26
const GROUP_GAP_H = 16

/** Where the marker goes, walked exactly the way the rows are rendered below. */
function indicatorTop(activeHref: string | undefined): number | null {
  let y = 0
  for (const [i, group] of GROUPS.entries()) {
    if (i > 0) y += GROUP_GAP_H
    if (group.label) y += GROUP_LABEL_H
    for (const e of group.entries) {
      if (e.href === activeHref) return y
      y += ROW_H
    }
  }
  return null
}

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
  const activeHref = GROUPS.flatMap((g) => g.entries.map((e) => e.href))
    .filter((h) => (h === '/' ? current === '/' : current === h || current.startsWith(h + '/')))
    .sort((a, b) => b.length - a.length)[0]

  const top = indicatorTop(activeHref)

  return (
    <nav className="side" aria-label="Sections">
      <div className="rail-top">
        <Link href="/" className="rail-brand rail-when-open">
          Instagram Outreach
        </Link>
        <RailToggle />
      </div>

      <div className="rail-nav">
        {/* Hidden from assistive tech: `aria-current` on the row already says which is
            active, and a decorative bar announcing itself would say it twice. */}
        {top !== null && <div className="rail-indicator" style={{ top }} aria-hidden="true" />}

        {GROUPS.map((group, i) => (
          <div key={group.label ?? `group-${i}`}>
            {i > 0 && <div className="rail-gap" aria-hidden="true" />}
            {group.label && <p className="rail-group-label rail-when-open">{group.label}</p>}
            {group.entries.map((e) => {
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
                  className="rail-item"
                  title={e.label}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="rail-item-main">
                    <span className="rail-icon" aria-hidden="true">
                      {e.code}
                    </span>
                    <span className="rail-label rail-when-open">{e.label}</span>
                  </span>
                  {n !== undefined && n > 0 && (
                    <span className={attention ? 'rail-count attention' : 'rail-count'}>{n}</span>
                  )}
                </Link>
              )
            })}
          </div>
        ))}
      </div>

      <div className="rail-foot">
        <div className="rail-status rail-when-open">
          <p className="rail-group-label">Right now</p>

          {/*
            THE HEARTBEAT, ON EVERY SCREEN. A toggle that promises behaviour must show
            whether anything is behind it: for a day this dashboard reported "Autopilot is
            ON — messages go out at 11:00" with no process on earth able to send one, and
            on 2026-08-08 nothing ran for twenty hours while the page said nothing at all.

            FRESHNESS IS NOT LIVENESS, so this reports what `readHeartbeat` measured and
            not a guess: a beat older than its window is red, and "we have never seen one"
            is its own sentence rather than a very old one.
          */}
          <div className="rail-status-row">
            <span className={`dot ${heartbeat?.fresh ? 'dot-good' : 'dot-bad'}`} />
            <span className={heartbeat?.fresh ? 'muted' : undefined} style={heartbeat?.fresh ? undefined : { color: 'var(--bad)' }}>
              {heartbeat === null
                ? 'The watch has never run'
                : heartbeat.fresh
                  ? 'The watch is running'
                  : `The watch last ran ${minutesAgo(new Date(heartbeat.beat.at))}`}
            </span>
          </div>

          {/*
            Autopilot's own line is DERIVED, never the switch position. Three accounts
            sharing one signature means nothing can send whatever the switch says, and a
            rail claiming "on" over a fleet that cannot move is the exact failure the
            heartbeat line above exists to prevent, one level along.
          */}
          <div className="rail-status-row">
            <span className={`dot ${counts.sharedPersona > 0 ? 'dot-warn' : 'dot-idle'}`} />
            <span className="muted">
              {counts.sharedPersona > 0 ? 'Nothing can send' : 'Sending is clear to run'}
            </span>
          </div>
        </div>

        {/*
          The one sentence explaining why the whole dashboard looks idle, on every screen rather
          than on one page someone might not open. CONDITIONAL on the clash actually existing —
          a hardcoded "sending is paused" would become a lie the moment personas are fixed, and
          a stale banner is how an operator learns to ignore the real one.
        */}
        {counts.sharedPersona > 0 && (
          <p className="rail-note rail-when-open">
            {counts.sharedPersona} accounts share one identity.{' '}
            <Link href="/senders">Give each its own</Link>.
          </p>
        )}

        {/*
          SIGN OUT LIVES HERE, since step C.

          It was inside `/`'s health card — the one whose border and dot go amber or red. So
          whenever a draft was waiting, which is the ordinary state, the dashboard rendered an
          amber alarm box containing a dot, a warning sentence, "Last check read 168 posts" and
          Sign out. Two separate faults in one container: neutral facts wearing an alarm's colour,
          and a piece of furniture inside a control that is supposed to mean something is wrong.

          A container that changes colour must contain only things that colour is about. Sign-out
          is chrome, so it belongs with the navigation, at the bottom, out of the reading path.
        */}
        {email && (
          <div className="rail-user">
            <SignOutButton email={email} />
          </div>
        )}
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
