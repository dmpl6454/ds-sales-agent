import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { readStringArray } from '@/lib/json'
import { istDayStart, istDateKey, daysAgo, istStamp } from '@/lib/time'
import { validatePersona, prettifyBrand } from '@/outreach/render'
import { FOLLOWER_SNAPSHOT } from '@/lib/constants'

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
  /** One plain sentence. Never a stack trace, never a status code. */
  headline: string
  nextSlotLabel: string
  nowLabel: string

  replies: ReplyCard[]
  week: { detected: number; sent: number; replies: number }
  activity: ActivityDay[]
  channels: ChannelCard[]
  accounts: AccountCard[]

  /** Only non-empty before autopilot is switched on. */
  awaiting: AwaitingCard[]
  /** Things a human must do. Empty when there is nothing to do. */
  todos: string[]
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
  postsLogged: number
  lastContactedLabel: string
  halted: boolean
}

export interface AccountCard {
  handle: string
  name: string
  autopilot: boolean
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
  body: string
}

export async function buildCeoView(): Promise<CeoView> {
  const dayStart = istDayStart()
  const weekStart = daysAgo(7)

  const [senders, targets, lastRun, weekSent, weekReplies, recentSends, recentReplies, awaitingRaw] =
    await Promise.all([
      prisma.senderAccount.findMany({ orderBy: { handle: 'asc' } }),
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
        where: { status: { in: ['READY', 'QUEUED'] } },
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
  const noSession = senders.filter((s) => !s.sessionPath)
  const staleRun = !lastRun || Date.now() - lastRun.startedAt.getTime() > 26 * 3_600_000

  /**
   * Blockers are collected independently rather than in an if/else chain, so
   * "Needs you" is always the complete list. An earlier version picked the first
   * matching condition for both the headline and the to-do list, which meant a
   * reader could clear the one item shown, expect sending to start, and find it
   * still blocked by something never surfaced.
   *
   * The headline still shows only the most severe item — that is a summary. The
   * list underneath is the truth.
   */
  const blockers: { severity: Health; headline: string; todo?: string }[] = []

  if (challenged.length > 0) {
    const names = challenged.map((s) => `@${s.handle}`).join(', ')
    blockers.push({
      severity: 'broken',
      headline: `Instagram locked ${names}. Log in to that account, clear the prompt, then switch it back on.`,
      todo: `Clear the Instagram security prompt on ${names}, then run: pnpm agent resume ${challenged[0]!.handle}`,
    })
  }
  for (const s of personaBroken) {
    blockers.push({
      severity: 'broken',
      headline: 'Sending is paused: contact details on one of the accounts are invalid.',
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
  if (env.DRY_RUN) {
    blockers.push({
      severity: 'attention',
      headline: 'Practice mode: the agent is watching and deciding, but not sending anything.',
      todo: 'Turn off practice mode when ready to send for real (DRY_RUN=0 in .env)',
    })
  }
  for (const s of noSession) {
    blockers.push({
      severity: 'attention',
      headline:
        noSession.length === senders.length
          ? 'Watching channels, but no account is logged in yet — nothing can be sent.'
          : `${noSession.length} account(s) still need a one-time login before they can send.`,
      todo: `Log in to @${s.handle} once: pnpm session:add --sender=${s.handle}`,
    })
  }
  if (!env.AUTOPILOT_ENABLED) {
    blockers.push({
      severity: 'attention',
      headline: 'Running, but sending still needs a person to press send.',
      todo: 'Turn on automatic sending (AUTOPILOT_ENABLED=true in .env)',
    })
  } else {
    const notArmed = senders.filter((s) => !s.autoSendEnabled)
    for (const s of notArmed) {
      blockers.push({
        severity: 'attention',
        headline: 'Running, but sending still needs a person to press send.',
        todo: `Let @${s.handle} send by itself: pnpm agent autopilot on ${s.handle}`,
      })
    }
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
  const headline = worst?.headline ?? 'Running normally, sending by itself.'
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
    const [campaignsThisWeek, postsLogged, lastSent, halted] = await Promise.all([
      prisma.detectedCampaign.count({
        where: { targetId: t.id, verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } },
      }),
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
      postsLogged,
      lastContactedLabel: lastSent?.sentAt ? relative(lastSent.sentAt) : 'not yet',
      halted: halted > 0 || t.optedOut,
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

    if (s.status === 'CHALLENGED') {
      state = 'broken'
      note = 'locked by Instagram — needs you'
    } else if (problems.length > 0) {
      state = 'broken'
      note = 'contact details invalid'
    } else if (s.status === 'PAUSED') {
      state = 'setup'
      note = 'paused'
    } else if (!s.sessionPath) {
      state = 'setup'
      note = 'not logged in yet'
    } else if (!s.autoSendEnabled || !env.AUTOPILOT_ENABLED || env.DRY_RUN) {
      state = 'setup'
      note = 'sends need approval'
    } else {
      state = 'ready'
      note = 'sending automatically'
    }

    accounts.push({ handle: s.handle, name: s.displayName, autopilot: s.autoSendEnabled, sentThisWeek, state, note })
  }

  const awaiting: AwaitingCard[] = awaitingRaw.map((a) => ({
    id: a.id,
    targetName: a.pair.target.displayName,
    targetHandle: a.pair.target.handle,
    senderName: a.pair.sender.displayName,
    body: a.renderedBody,
  }))

  return {
    health,
    headline,
    nextSlotLabel: nextSlotLabel(),
    nowLabel: istStamp(),
    replies,
    week: { detected: weekDetected, sent: weekSent, replies: weekReplies },
    activity,
    channels,
    accounts,
    awaiting,
    todos,
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
