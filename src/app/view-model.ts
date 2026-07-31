import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { readStringArray } from '@/lib/json'
import { istDayStart, istDateKey, daysAgo, istStamp } from '@/lib/time'
import { validatePersona, prettifyBrand } from '@/outreach/render'
import { FOLLOWER_SNAPSHOT } from '@/lib/constants'
import { profileStatus } from '@/outreach/browser/profile'
import { isConnecting } from '@/outreach/browser/connect'
import { getSettings } from '@/lib/settings'

/**
 * Everything the CEO page shows, assembled in one place.
 *
 * The page itself does no querying and no interpretation — it renders sentences
 * this file produces. Keeping the judgement here (what counts as "healthy", how
 * an event reads in English) means the view stays a view, and the wording can be
 * changed without touching layout.
 */

export type Health = 'healthy' | 'attention' | 'broken'

export interface CeoView {
  health: Health
  /** Last check, phrased so it cannot be mistaken for the 7-day totals below. */
  lastCheckLabel: string
  /** One plain sentence. Never a stack trace, never a status code. */
  headline: string
  nextSlotLabel: string
  nowLabel: string

  replies: ReplyCard[]
  week: { detected: number; sent: number; replies: number }
  activity: ActivityDay[]
  channels: ChannelCard[]
  accounts: AccountCard[]

  /** Messages written and ready to send. */
  awaiting: AwaitingCard[]
  /** Things a human must do. Empty when there is nothing to do. */
  todos: string[]

  autopilot: AutopilotState
}

export interface RouteToggle {
  targetHandle: string
  targetName: string
  enabled: boolean
  /** Target is marked never-contact; the route cannot be turned on. */
  targetRetired: boolean
}

export interface AutopilotState {
  /** The dashboard toggle. Sending happens by itself when this and an armed account line up. */
  on: boolean
  /**
   * AUTOPILOT_ENABLED in .env. A hard floor — with this false the toggle cannot be
   * switched on at all, so a compromised or misclicked dashboard cannot start
   * unattended sending on a deployment that never opted in.
   */
  allowedByEnv: boolean
  /** Accounts that are armed AND have a logged-in Chrome profile. */
  readyHandles: string[]
  /** Armed, but no hand login yet — the toggle will not help these. */
  needLoginHandles: string[]
}

export interface ReplyCard {
  targetName: string
  targetHandle: string
  senderName: string
  whenLabel: string
  preview: string | null
}

export interface ActivityEvent {
  timeLabel: string
  sentence: string
  kind: 'sent' | 'reply' | 'detected'
}

export interface ActivityDay {
  dayLabel: string
  events: ActivityEvent[]
}

export interface ChannelCard {
  name: string
  handle: string
  followers: string
  campaignsThisWeek: number
  postsThisWeek: number
  postsLogged: number
  lastContactedLabel: string
  halted: boolean
  /**
   * True when this channel's posts are deliberately NOT classified.
   *
   * This matters more than it looks. @viralbhayani never discloses paid posts, so
   * our verdict count for them is 0 — and showing a bare "0 paid campaigns" would
   * tell a reader they do no paid work, which is the opposite of the truth
   * (roughly half their output is commercial). The card says "not classified"
   * instead of a number that would actively mislead.
   */
  unclassified: boolean
  /** Retired: kept for its history, never contacted again. */
  retired: boolean
  /** Has this channel ever been sent a message? Governs delete vs retire. */
  everContacted: boolean
}

export interface AccountCard {
  handle: string
  name: string
  autopilot: boolean
  /** A hand login has happened, so this account CAN send unattended. */
  canSendAutomatically: boolean
  /** A Chrome window is open right now waiting for this account to be logged in. */
  connecting: boolean
  /** Which channels this account is allowed to message. */
  routes: RouteToggle[]
  sentThisWeek: number
  /**
   * ready  — logged in, healthy, armed: will send by itself
   * setup  — nothing wrong, but a step is outstanding (login, autopilot off)
   * broken — needs a human: locked by Instagram, or invalid details
   *
   * Three states rather than two because green beside "not logged in yet" reads
   * as healthy at a glance, which is precisely what a status light must not do.
   */
  state: 'ready' | 'setup' | 'broken'
  note: string
}

export interface AwaitingCard {
  id: string
  targetName: string
  targetHandle: string
  senderName: string
  senderHandle: string
  body: string
  /** A hand login has happened for this sender, so automated sending can work. */
  canSendAutomatically: boolean
  /** True while a browser is mid-send. Blocks the button so one click means one send. */
  inFlight: boolean
}

export async function buildCeoView(): Promise<CeoView> {
  const dayStart = istDayStart()
  const weekStart = daysAgo(7)
  const settings = await getSettings()

  const [senders, targets, lastRun, weekSent, weekReplies, recentSends, recentReplies, awaitingRaw] =
    await Promise.all([
      prisma.senderAccount.findMany({
        orderBy: { handle: 'asc' },
        include: { pairs: { include: { target: true } } },
      }),
      prisma.targetAccount.findMany({
        where: { kind: 'CHANNEL' },
        include: { pairs: { include: { sender: true } } },
        orderBy: { handle: 'asc' },
      }),
      prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      prisma.outreachAttempt.count({ where: { status: 'SENT', sentAt: { gte: weekStart } } }),
      prisma.outreachAttempt.count({ where: { repliedAt: { gte: weekStart } } }),
      prisma.outreachAttempt.findMany({
        where: { sentAt: { gte: daysAgo(14) } },
        include: { pair: { include: { sender: true, target: true } }, campaign: true },
        orderBy: { sentAt: 'desc' },
        take: 40,
      }),
      prisma.outreachAttempt.findMany({
        where: { repliedAt: { not: null } },
        include: { pair: { include: { sender: true, target: true } } },
        orderBy: { repliedAt: 'desc' },
      }),
      prisma.outreachAttempt.findMany({
        // SENDING is included so a send interrupted by a crash stays visible rather
        // than vanishing from the tray with no way to reach it.
        where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
        include: { pair: { include: { sender: true, target: true } } },
        orderBy: { queuedAt: 'asc' },
      }),
    ])

  const weekDetected = await prisma.detectedCampaign.count({
    where: { verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } },
  })

  // ── Health ────────────────────────────────────────────────────────────────
  const challenged = senders.filter((s) => s.status === 'CHALLENGED')
  const paused = senders.filter((s) => s.status === 'PAUSED')
  const personaBroken = senders.filter((s) => validatePersona(s).length > 0)
  const staleRun = !lastRun || Date.now() - lastRun.startedAt.getTime() > 26 * 3_600_000

  const totalSent = await prisma.outreachAttempt.count({ where: { status: { in: ['SENT', 'REPLIED'] } } })
  const ceilingReached = env.MAX_TOTAL_SENDS !== null && totalSent >= env.MAX_TOTAL_SENDS

  /**
   * Blockers are collected independently rather than in an if/else chain, so
   * "Needs you" is always the complete list. An earlier version picked the first
   * matching condition for both the headline and the to-do list, which meant a
   * reader could clear the one item shown, expect sending to start, and find it
   * still blocked by something never surfaced.
   *
   * The headline shows only the most severe item — that is a summary. The list
   * underneath is the truth.
   */
  const blockers: { severity: Health; headline: string; todo?: string }[] = []

  if (challenged.length > 0) {
    const names = challenged.map((s) => `@${s.handle}`).join(', ')
    blockers.push({
      severity: 'broken',
      headline: `Instagram locked ${names}. Log in to that account, clear the prompt, then switch it back on.`,
      todo: `Clear the Instagram security prompt on ${names}, then: pnpm agent resume ${challenged[0]!.handle}`,
    })
  }
  for (const s of personaBroken) {
    blockers.push({
      severity: 'broken',
      headline: 'Nothing can be prepared: contact details on one of the accounts are invalid.',
      todo: `Fix contact details on @${s.handle}: ${validatePersona(s)[0]}`,
    })
  }
  if (staleRun) {
    blockers.push({
      severity: 'broken',
      headline: lastRun
        ? 'The agent has not checked the channels in over a day. It may not be running.'
        : 'The agent has not started watching yet.',
      todo: 'Start the agent: pnpm worker',
    })
  }
  if (awaitingRaw.length > 0) {
    blockers.push({
      severity: 'attention',
      headline: `${awaitingRaw.length} message${awaitingRaw.length === 1 ? '' : 's'} written and waiting for you to send.`,
      todo: `Send the next one: pnpm send`,
    })
  }
  if (env.DRY_RUN) {
    blockers.push({
      severity: 'attention',
      headline: 'Practice mode: watching and deciding, but writing nothing to send.',
      todo: 'Turn off practice mode when ready (DRY_RUN=0 in .env)',
    })
  }
  if (ceilingReached) {
    blockers.push({
      severity: 'attention',
      headline: `Send limit reached — ${totalSent} of ${env.MAX_TOTAL_SENDS} messages used. Watching, but preparing nothing new.`,
      todo: `Raise the send limit when ready (MAX_TOTAL_SENDS in .env)`,
    })
  }
  if (paused.length > 0) {
    blockers.push({
      severity: 'attention',
      headline: `${paused.map((s) => `@${s.handle}`).join(', ')} is paused.`,
      todo: `Resume @${paused[0]!.handle}: pnpm agent resume ${paused[0]!.handle}`,
    })
  }
  if (lastRun && lastRun.status !== 'OK' && !staleRun) {
    blockers.push({
      severity: 'attention',
      headline: 'The last check hit a problem. It will try again at the next scheduled time.',
    })
  }

  const worst = blockers.find((b) => b.severity === 'broken') ?? blockers[0]
  const health: Health = worst?.severity ?? 'healthy'
  const headline = worst?.headline ?? 'Watching normally. Nothing to send right now.'
  const todos: string[] = blockers.map((b) => b.todo).filter((t): t is string => Boolean(t))

  // ── Replies ───────────────────────────────────────────────────────────────
  const replies: ReplyCard[] = recentReplies.map((r) => ({
    targetName: r.pair.target.displayName,
    targetHandle: r.pair.target.handle,
    senderName: r.pair.sender.displayName,
    whenLabel: relative(r.repliedAt),
    preview: r.error && r.error.length > 0 ? r.error : null,
  }))
  if (replies.length > 0) {
    todos.unshift(`Reply to ${replies.map((r) => r.targetName).join(', ')}`)
  }

  // ── Activity, as sentences, grouped by day ────────────────────────────────
  const events: { at: Date; event: ActivityEvent }[] = []

  for (const a of recentSends) {
    if (!a.sentAt) continue
    const brand = a.campaign ? readStringArray(a.campaign.brands).map(prettifyBrand)[0] : null
    const hook = brand ? `, referencing their ${brand} campaign` : ''
    events.push({
      at: a.sentAt,
      event: {
        timeLabel: timeOnly(a.sentAt),
        kind: 'sent',
        sentence: `Messaged ${a.pair.target.displayName} as ${a.pair.sender.displayName}${hook}`,
      },
    })
  }
  for (const r of recentReplies) {
    if (!r.repliedAt) continue
    events.push({
      at: r.repliedAt,
      event: {
        timeLabel: timeOnly(r.repliedAt),
        kind: 'reply',
        sentence: `${r.pair.target.displayName} replied — all outreach to them is on hold`,
      },
    })
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime())

  const byDay = new Map<string, ActivityEvent[]>()
  for (const e of events) {
    const key = istDateKey(e.at)
    const list = byDay.get(key) ?? []
    list.push(e.event)
    byDay.set(key, list)
  }
  const activity: ActivityDay[] = [...byDay.entries()].slice(0, 7).map(([key, evs]) => ({
    dayLabel: dayLabel(key),
    events: evs,
  }))

  // ── Channels ──────────────────────────────────────────────────────────────
  const channels: ChannelCard[] = []
  for (const t of targets) {
    const [campaignsThisWeek, postsThisWeek, postsLogged, lastSent, halted] = await Promise.all([
      prisma.detectedCampaign.count({
        where: { targetId: t.id, verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } },
      }),
      prisma.detectedCampaign.count({ where: { targetId: t.id, detectedAt: { gte: weekStart } } }),
      prisma.detectedCampaign.count({ where: { targetId: t.id } }),
      prisma.outreachAttempt.findFirst({
        where: { pair: { targetId: t.id }, status: { in: ['SENT', 'REPLIED'] } },
        orderBy: { sentAt: 'desc' },
      }),
      prisma.outreachAttempt.count({ where: { pair: { targetId: t.id }, repliedAt: { not: null } } }),
    ])
    channels.push({
      name: t.displayName,
      handle: t.handle,
      followers: FOLLOWER_SNAPSHOT[t.handle] ?? '—',
      campaignsThisWeek,
      postsThisWeek,
      postsLogged,
      lastContactedLabel: lastSent?.sentAt ? relative(lastSent.sentAt) : 'not yet',
      halted: halted > 0 || t.optedOut,
      unclassified: t.detectorKey === 'passthrough',
      retired: t.optedOut,
      everContacted: lastSent !== null,
    })
  }

  // ── Our accounts ──────────────────────────────────────────────────────────
  const accounts: AccountCard[] = []
  for (const s of senders) {
    const sentThisWeek = await prisma.outreachAttempt.count({
      where: { pair: { senderId: s.id }, status: 'SENT', sentAt: { gte: weekStart } },
    })
    const problems = validatePersona(s)
    let state: AccountCard['state']
    let note: string

    const hasProfile = profileStatus(s.handle).hasSession

    if (s.status === 'CHALLENGED') {
      state = 'broken'
      note = 'locked by Instagram — needs you'
    } else if (problems.length > 0) {
      state = 'broken'
      note = 'contact details invalid'
    } else if (!hasProfile) {
      // The most common outstanding step, and the dashboard now owns it — pointing
      // at a terminal command from a button-driven page just sends people away.
      state = 'setup'
      note = 'not connected — press Connect'
    } else if (s.status === 'PAUSED') {
      state = 'setup'
      note = 'paused'
    } else {
      state = 'ready'
      note = s.autoSendEnabled ? (sentThisWeek > 0 ? 'sending by itself' : 'armed — will send by itself') : 'ready'
    }

    accounts.push({
      handle: s.handle,
      name: s.displayName,
      autopilot: s.autoSendEnabled,
      canSendAutomatically: hasProfile,
      connecting: isConnecting(s.handle),
      routes: s.pairs
        .map((p) => ({
          targetHandle: p.target.handle,
          targetName: p.target.displayName,
          enabled: p.enabled,
          targetRetired: p.target.optedOut,
        }))
        .sort((a, b) => a.targetHandle.localeCompare(b.targetHandle)),
      sentThisWeek,
      state,
      note,
    })
  }

  const autopilot: AutopilotState = {
    on: settings.autopilotEnabled,
    allowedByEnv: env.AUTOPILOT_ENABLED,
    readyHandles: senders
      .filter((s) => s.autoSendEnabled && s.status === 'ACTIVE' && profileStatus(s.handle).hasSession)
      .map((s) => s.handle),
    needLoginHandles: senders
      .filter((s) => s.autoSendEnabled && !profileStatus(s.handle).hasSession)
      .map((s) => s.handle),
  }

  const awaiting: AwaitingCard[] = awaitingRaw.map((a) => ({
    id: a.id,
    targetName: a.pair.target.displayName,
    targetHandle: a.pair.target.handle,
    senderName: a.pair.sender.displayName,
    senderHandle: a.pair.sender.handle,
    body: a.renderedBody,
    // Filesystem check only — it says a hand login happened, not that the session
    // is still valid. Whether the session works is answered by the send itself,
    // which verifies the logged-in account before it types anything.
    canSendAutomatically: profileStatus(a.pair.sender.handle).hasSession && a.pair.sender.status === 'ACTIVE',
    inFlight: a.status === 'SENDING',
  }))

  const lastCheckLabel = lastRun
    ? `Last check read ${lastRun.postsSeen} posts · ${lastRun.newPosts} new`
    : 'No check has run yet'

  return {
    health,
    headline,
    lastCheckLabel,
    nextSlotLabel: nextSlotLabel(),
    nowLabel: istStamp(),
    replies,
    week: { detected: weekDetected, sent: weekSent, replies: weekReplies },
    activity,
    channels,
    accounts,
    awaiting,
    todos,
    autopilot,
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

function timeOnly(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

function relative(at: Date | null): string {
  if (!at) return 'never'
  const mins = Math.floor((Date.now() - at.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  const days = Math.floor(mins / 1440)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function dayLabel(dateKey: string): string {
  const today = istDateKey()
  const yesterday = istDateKey(daysAgo(1))
  if (dateKey === today) return 'Today'
  if (dateKey === yesterday) return 'Yesterday'
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  )
}

function nextSlotLabel(): string {
  const now = new Date()
  const dayStart = istDayStart(now)
  const mins = Math.floor((now.getTime() - dayStart.getTime()) / 60_000)
  const parsed = env.SLOTS.map((s) => {
    const [hh, mm] = s.split(':').map(Number)
    return { slot: s, minutes: hh! * 60 + mm! }
  }).sort((a, b) => a.minutes - b.minutes)

  const upcoming = parsed.find((p) => p.minutes > mins)
  if (upcoming) {
    const delta = upcoming.minutes - mins
    const inWords = delta >= 60 ? `${Math.floor(delta / 60)}h ${delta % 60}m` : `${delta}m`
    return `Next check today at ${upcoming.slot} · in ${inWords}`
  }
  return `Next check tomorrow at ${parsed[0]!.slot}`
}
