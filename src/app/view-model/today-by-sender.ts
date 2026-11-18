import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { memoView, viewKey } from '@/lib/viewMemo'

/**
 * TODAY, BY SENDING PAGE (18 Nov 2026, Sudhanshu: *"add todays insight in the insight also which profile message
 * was sent from"*).
 *
 * `/analytics` stated today's TOTAL in one sentence and every per-page figure on it was LIFETIME ("By sender"), so
 * "what went out today, and from which of our pages" — the question on the first day of sending after sixteen silent
 * days — had no answer on any screen. This is that answer: one row per page, with the messages it delivered today
 * underneath, newest first.
 *
 * ── WHAT EACH FIGURE MEANS (and the review of 18 Nov that made each one honest) ──────────────────────────────
 *
 * - **sent** — delivered (SENT or REPLIED) since midnight IST, counted by an UNCAPPED group-by. The message LIST is
 *   capped; the COUNTS never are, so on a big day a page that sent only in the morning cannot drop off the section.
 * - **replies found** — replies whose `repliedAt` (when the reply check RECORDED them) is today. A reply can be days or
 *   weeks old when the check reaches its conversation, so this is "found today", never "came in today".
 * - **waiting** — drafts from this page READY, QUEUED or SENDING right now.
 * - **stopped** — drafts from this page that are FAILED and were last queued today. `queuedAt` is when a draft was
 *   written or last re-queued after a retryable failure, NOT when it failed (nothing records that), so this is the
 *   closest honest reading: today's drafts that did not go out. On 18 Nov this was all 40 introductions; a section
 *   that left them out would have said "nothing happened" on the day everything went wrong.
 * - **follow-up** (a message's chip) — this PAGE's second or later message to that company (`touchNumber > 1`), the
 *   same rule as the history table further down the same page (messages/sent.tsx) and /paid-posts, so the two lists
 *   never disagree about one message. It is a fact about this page's history, not about the copy: a page's FIRST
 *   message to a company that had already answered another page carries the follow-up text (compose.ts), and is
 *   not chipped here. A review weighed switching to "carried the follow-up copy" and kept the shared rule.
 *
 * ONE DAY BOUNDARY, FROM THE CALLER. The page takes one `now`, derives midnight IST from it, and hands the same
 * moment to `fleetUsage` and to this builder: two clocks read a few seconds apart straddle midnight on the last
 * render of the day, and the section then said "312 have gone out" over rows from the new, empty day.
 */

export const TODAY_ROWS_CAP = 400

export interface TodayMessage {
  id: string
  sentAt: Date
  targetHandle: string
  /** This page's second or later message to this company — see the module docblock. */
  followUp: boolean
  /** A reply is recorded on this message — on any day, not only today. */
  replied: boolean
  threadUrl: string | null
}

export interface TodayPage {
  handle: string
  /** Delivered today by this page — uncapped. */
  sent: number
  /** Replies RECORDED today on this page's messages, whenever those messages went out. */
  repliesFound: number
  /** Drafts from this page waiting or mid-send right now. */
  waiting: number
  /** This page's drafts that are FAILED and were last queued today. */
  stopped: number
  lastSentAt: Date | null
  /** Newest first. Only the newest `TODAY_ROWS_CAP` across the fleet are read. */
  messages: TodayMessage[]
}

export interface TodayBySender {
  dayStart: Date
  /** Delivered today, uncapped — from the caller. */
  total: number
  /** How many messages are listed. Less than `total` only when the list cap bound. */
  shown: number
  /** The LISTS are capped. The per-page COUNTS never are. */
  capped: boolean
  repliesFound: number
  stopped: number
  pages: TodayPage[]
}

export interface DeliveredRow {
  id: string
  senderId: string
  sentAt: Date | null
  touchNumber: number
  status: string
  repliedAt: Date | null
  threadUrl: string | null
  targetHandle: string
}

export interface PageCounts {
  sent: number
  lastSentAt: Date | null
}

/**
 * PURE: assemble the section. Kept apart from the queries so both directions are testable without a database.
 *
 * A page appears when it delivered, a reply was found, a draft is waiting or a draft was stopped today. Pages are
 * ordered by messages sent today, then by handle, so the order is stable between refreshes.
 */
export function groupTodayBySender(input: {
  dayStart: Date
  total: number
  rows: readonly DeliveredRow[]
  deliveredBySender: ReadonlyMap<string, PageCounts>
  repliesBySender: ReadonlyMap<string, number>
  waitingBySender: ReadonlyMap<string, number>
  stoppedBySender: ReadonlyMap<string, number>
  senders: readonly { id: string; handle: string }[]
}): TodayBySender {
  const handleById = new Map(input.senders.map((s) => [s.id, s.handle]))
  const pages = new Map<string, TodayPage>()
  const pageFor = (senderId: string): TodayPage | null => {
    const handle = handleById.get(senderId)
    if (!handle) return null
    let p = pages.get(senderId)
    if (!p) {
      p = { handle, sent: 0, repliesFound: 0, waiting: 0, stopped: 0, lastSentAt: null, messages: [] }
      pages.set(senderId, p)
    }
    return p
  }

  for (const [senderId, c] of input.deliveredBySender) {
    const p = c.sent > 0 ? pageFor(senderId) : null
    if (!p) continue
    p.sent = c.sent
    p.lastSentAt = c.lastSentAt
  }
  const setCount = (m: ReadonlyMap<string, number>, field: 'repliesFound' | 'waiting' | 'stopped') => {
    for (const [senderId, n] of m) {
      const p = n > 0 ? pageFor(senderId) : null
      if (p) p[field] = n
    }
  }
  setCount(input.repliesBySender, 'repliesFound')
  setCount(input.waitingBySender, 'waiting')
  setCount(input.stoppedBySender, 'stopped')

  let shown = 0
  for (const r of input.rows) {
    // A delivered row with no `sentAt` cannot be placed on a day; the query excludes it, and so does this.
    if (!r.sentAt) continue
    shown += 1
    const p = pageFor(r.senderId)
    if (!p) continue
    p.messages.push({
      id: r.id,
      sentAt: r.sentAt,
      targetHandle: r.targetHandle,
      followUp: r.touchNumber > 1,
      replied: r.status === 'REPLIED' || r.repliedAt !== null,
      threadUrl: r.threadUrl,
    })
  }

  const list = [...pages.values()]
  for (const p of list) p.messages.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || a.id.localeCompare(b.id))
  list.sort((a, b) => b.sent - a.sent || a.handle.localeCompare(b.handle))

  const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
  return {
    dayStart: input.dayStart,
    // Never report fewer than were listed: the caller's count and these rows are two reads a moment apart.
    total: Math.max(input.total, shown),
    shown,
    capped: input.total > shown,
    repliesFound: sum(input.repliesBySender),
    stopped: sum(input.stoppedBySender),
    pages: list,
  }
}

interface TodayArgs {
  /** Midnight IST for the render — the SAME boundary the caller handed `fleetUsage`. */
  dayStart: Date
  /** `fleetUsage(now).today` — the uncapped count. */
  deliveredToday: number
  senders: readonly { id: string; handle: string }[]
}

/**
 * Through `memoView`, like every builder a page calls (tests/view-memo.test.ts): the page refreshes itself every 45 s
 * and a burst of open tabs must compute this once. Keyed on the day, the day's count and the senders, so a new
 * delivery is a new key rather than a ten-second-old answer.
 */
export async function buildTodayBySender(args: TodayArgs): Promise<TodayBySender> {
  return memoView(
    viewKey('todayBySender', { day: args.dayStart, delivered: args.deliveredToday, senders: args.senders.map((s) => s.id) }),
    () => computeTodayBySender(args),
  )
}

async function computeTodayBySender(args: TodayArgs): Promise<TodayBySender> {
  const { dayStart } = args
  const delivered = { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: dayStart } }
  const [counts, raw, replies, waiting, stopped] = await Promise.all([
    prisma.outreachAttempt.groupBy({ by: ['senderId'], where: delivered, _count: { _all: true }, _max: { sentAt: true } }),
    prisma.outreachAttempt.findMany({
      where: delivered,
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: TODAY_ROWS_CAP,
      select: {
        id: true,
        senderId: true,
        sentAt: true,
        touchNumber: true,
        status: true,
        repliedAt: true,
        threadUrl: true,
        target: { select: { handle: true } },
      },
    }),
    prisma.outreachAttempt.groupBy({ by: ['senderId'], where: { repliedAt: { gte: dayStart } }, _count: { _all: true } }),
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
      _count: { _all: true },
    }),
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { status: 'FAILED', queuedAt: { gte: dayStart } },
      _count: { _all: true },
    }),
  ])
  return groupTodayBySender({
    dayStart,
    total: args.deliveredToday,
    rows: raw.map((r) => ({
      id: r.id,
      senderId: r.senderId,
      sentAt: r.sentAt,
      touchNumber: r.touchNumber,
      status: r.status,
      repliedAt: r.repliedAt,
      threadUrl: r.threadUrl,
      targetHandle: r.target.handle,
    })),
    deliveredBySender: new Map(counts.map((c) => [c.senderId, { sent: c._count._all, lastSentAt: c._max.sentAt ?? null }])),
    repliesBySender: new Map(replies.map((r) => [r.senderId, r._count._all])),
    waitingBySender: new Map(waiting.map((r) => [r.senderId, r._count._all])),
    stoppedBySender: new Map(stopped.map((r) => [r.senderId, r._count._all])),
    senders: args.senders,
  })
}
