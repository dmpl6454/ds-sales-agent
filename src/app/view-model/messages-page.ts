import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { daysAgo } from '@/lib/time'
import { dispatchStatus, readPause } from '@/outreach/dispatcher'
import { replyCoverage } from '@/outreach/replyCheck'
import { profileUrl } from '@/lib/urls'
// Never a raw `displayName` — see the note on the import in `view-model.ts`.
import { operatorName } from '@/outreach/render'
import { getSettings } from '@/lib/settings'
/**
 * The SAME counters `checkNewBrandTouchCap` reads in the planner. Not recomputed here —
 * a page reporting a cap by a different rule than the one enforcing it reads as headroom
 * that does not exist, which this codebase has now done twice (`MAX_TOTAL_SENDS`, and the
 * new-brand cap itself).
 */
import { readNewBrandTouchCounts } from '@/outreach/brandTouchCounts'
import { recheckBeforeSend } from '@/outreach/gate'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { crossSpacingVerdict, crossSpacingDetail } from '@/outreach/crossSpacing'
import { eligibleFleetSenderIds } from '@/outreach/availability'
import type { OnDemandRecipient, OnDemandSender } from '../on-demand'

/**
 * The `/messages` page: what is waiting, and what has actually gone out.
 *
 * One page for the whole life of a message, because "is anything waiting for me" and
 * "what did we send yesterday" are the same question asked at two moments, and splitting
 * them makes you check two places to find out whether the system is doing anything.
 */

/**
 * ── THE QUEUE IS A SUMMARY NOW (2026-08-18, Tabish) ─────────────────────────
 *
 * *"we do not need to see every draft as now we need only a single template message."*
 * Every draft carries the identical standard template, so twenty cards showing twenty
 * copies of one body earned nothing — and each card cost a real `recheckBeforeSend`
 * (~7 queries). The queue renders as counts per sender; the dispatcher's own hold
 * reasons (the pace band) say why nothing is moving, from the enforcer itself.
 */
export interface QueueBySender {
  handle: string
  count: number
}

/**
 * ── "UP NEXT" — WHAT ACTUALLY SENDS NEXT, NOT WHAT SITS AT THE FRONT ─────────
 *
 * (2026-08-19, Tabish: "the queue must be visible as an 'Up next' … I just want a queue
 * that updates like the number after every message is sent.")
 *
 * THE BUG THIS FIXES: the dispatcher drains READY oldest-first but HOLDS every draft that
 * fails the gate, and sends the first that passes. Most of the queue's front is held by
 * cross-page spacing ("heard from @X a day ago"), so those rows never move — while sends
 * happen from further down. Showing the raw oldest-first list therefore showed eight
 * permanently-stuck rows whose count dropped but whose faces never changed.
 *
 * So "Up next" is now the SENDABLE drafts in dispatch order — the ones whose target is not
 * spacing-held and not reply-halted — which is what the dispatcher will actually take. As
 * each sends (and as each fresh contact spacing-holds a target's other drafts), the list
 * advances, matching the count. The two dominant holds are computed in bulk (one query
 * each); rarer per-sender holds (cohort, session) are left to the head row's real gate.
 */
export interface UpNextRow {
  position: number
  senderHandle: string
  targetHandle: string
  /**
   * Minutes until this row's turn at the current pace — NULL when Autopilot is off,
   * because a countdown is a promise and with the switch off nothing is counting down.
   */
  etaMinutes: number | null
  /** Head of the queue only: the gate's verdict right now. Null further down. */
  note: string | null
  /** Head only: whether that verdict was a refusal. */
  held: boolean
}

export interface SentMessage {
  id: string
  senderHandle: string
  targetHandle: string
  sentAt: Date | null
  /** `autopilot:x` | `operator:x` | `override(...):x` | `cli:x`. Kept verbatim. */
  sentBy: string | null
  threadUrl: string | null
  replied: boolean
  replyHandled: boolean
  replyText: string | null
}

/**
 * A send that cleared the composer and never appeared in the thread.
 *
 * Its own list, and that is the point. Since Phase 5 these park in FAILED rather than
 * going back to READY, because READY is what the delivery loop picks up and re-sending is
 * wrong in both readings of what happened — the recipient may already have it, and the
 * account may be restricted. Parking a message where nothing automatic touches it is only
 * safe if a person can SEE it, so this list exists in the same commit as that change.
 */
export interface UncertainMessage {
  id: string
  senderHandle: string
  targetHandle: string
  queuedAt: Date
  attempts: number
  error: string | null
  /**
   * A link to the recipient's profile, so the operator can open the conversation and look.
   *
   * NOT the `pnpm ig:thread` command. "Never put a shell command on the page" is a rule
   * here with a history: the old "Needs you" list read `Send the next one: pnpm send` and
   * `Check which channels are failing: pnpm ig:audit`, which is a developer instruction
   * standing in for something the page could simply offer. The CLI still exists and is
   * still the right tool from a terminal; it is not what belongs in front of a CEO who has
   * to decide whether a message arrived.
   */
  profileUrl: string
}

/** A waiting draft that is resting, with the enforcer's sentence and when it frees up. */
export interface HeldRow {
  senderHandle: string
  targetHandle: string
  why: string
  resumesAt: Date
}

export interface MessagesPageView {
  /** Waiting drafts per sending account. The queue as counts, not cards. */
  queueBySender: QueueBySender[]
  /** The SENDABLE front of the queue in dispatch order, with the head's live gate verdict. */
  upNext: UpNextRow[]
  /** Drafts waiting but held right now for cross-page spacing or a reply. */
  heldWaiting: number
  /** The first held drafts, soonest release first — so "33 waiting" is never an invisible list. */
  heldUpNext: HeldRow[]
  /**
   * IS AUTOPILOT ON? The queue panel needs it, and rendering the panel without it was a
   * page claiming a send the enforcer refuses.
   *
   * MEASURED 2026-08-20: Tabish switched Autopilot OFF, the dispatcher correctly held
   * every tick on `autopilot-off` — and "Up next" went on showing "clear to send on the
   * next tick" over 8 rows with "in ~1 min" ETAs. The gate cannot catch this: AUTO_SEND_OFF
   * was deleted in the one-switch change (2026-08-08), so `recheckBeforeSend` says nothing
   * about the switch and answers `ok` for a draft nothing will send. The queue then looks
   * FROZEN — the same eight rows on every refresh — while the page insists they are going
   * out, which is exactly the "reports a limit by a different rule than the one enforcing
   * it" failure this file's history is full of.
   */
  autopilotOn: boolean
  waitingTotal: number
  uncertain: UncertainMessage[]
  /** Parked by the retry cap: repeated failures, provably undelivered. */
  parked: Array<{
    id: string
    senderHandle: string
    targetHandle: string
    attempts: number
    failureCode: string | null
    error: string | null
  }>
  recent: SentMessage[]
  /** What the paced dispatcher last did, and what is holding it. */
  dispatch: Awaited<ReturnType<typeof dispatchStatus>>
  /**
   * How much of the reply guard is actually in force.
   *
   * On screen because the failure it guards against is invisible everywhere else: an
   * unchecked conversation and a checked-and-silent one look identical in every other
   * view. The sweep's capacity is a constant while the number of conversations grows, so
   * this number falls quietly as the fleet does — the shape of problem this project keeps
   * discovering after the fact rather than before.
   */
  replyCoverage: Awaited<ReturnType<typeof replyCoverage>>
  /** Present when a person paused sending, so the banner can name them. */
  pause: { at: string; by: string; reason?: string } | null
  /**
   * Delivered today / this week. Counted the way the enforcer counts, never as 'SENT' alone.
   *
   * ── `sentToday` IS THE DISPATCHER'S OWN FIGURE, NOT A FILTER OVER THE RECENT LIST ──
   *
   * It used to be `recentRaw.filter(a => a.sentAt >= istMidnight).length`, and `recentRaw`
   * is `take: 50`. So the day's total was silently CAPPED at however many of today's sends
   * happened to be inside the newest fifty rows — on 2026-08-20, with 59 delivered before
   * 09:00 IST, it would have read 50 and gone on reading 50 for the rest of the day. A
   * ceiling wearing a count's clothes, which is the `MAX_TOTAL_SENDS` shape again: the
   * number and its label mean different things and the gap only opens on a busy day.
   *
   * It was never rendered, so nothing was ever visibly wrong — which is the only reason
   * this was cheap to fix rather than a figure somebody had trusted. It is now
   * `dispatchStatus().usage.today`, i.e. `fleetUsage()`, THE SAME uncapped count the pacing
   * guard reads, so the page cannot report the day by a different rule than the dispatcher.
   * `dispatch` is already awaited on this page, so this costs no extra query.
   */
  sentToday: number
  sentThisWeek: number
  /**
   * EVERY message ever delivered. Its own `count`, never `recent.length`.
   *
   * The Autopilot page had no delivered figure at all and no route to the history, so "what
   * has this thing actually sent" was answerable only on another page — and there only up to
   * the newest fifty. Tabish, 2026-08-21: *"it should reflect in analytics and autopilot page
   * accurately all the message thread with an ability to go even beyond."*
   */
  deliveredTotal: number
  /**
   * TODAY'S NEW-COMPANY ALLOWANCE — the cap that actually governs how many strangers hear
   * from us, and until 2026-08-17 it appeared on no screen an operator looks at.
   *
   * MEASURED that day: 61 of 77 companies had never been contacted, the cap was 2, and the
   * fleet's own pacing permits 33 a day — so the binding limit was 16x tighter than the
   * machinery around it and nothing said so. Tabish asked for it to be raised "or make it
   * more apparent in the UI"; it is now both.
   *
   * BOTH counters, never merged into one number. They answer different questions —
   * `created` bounds the draft backlog, `delivered` is how many strangers actually heard
   * from us — and they diverge. Read from `readNewBrandTouchCounts`, the same function the
   * planner asks, so the page cannot report the cap by a different rule than the one
   * enforcing it.
   */
  newCompanies: { cap: number; waiting: number; queueRoom: number; delivered: number; neverContacted: number }
  /**
   * Who "Send a message now" may pick from.
   *
   * On this page since step C: the on-demand send is an ACTION, not a place, and it belongs
   * beside the drafts it produces rather than on the landing page. Deliberately not in the
   * sidebar for the same reason.
   *
   * These are the minimal shapes the dialog reads. It does NOT get an `AccountCard`: that would
   * make Messages assemble routes, personas and per-account weekly counts to fill a dropdown.
   */
  onDemandSenders: OnDemandSender[]
  onDemandRecipients: OnDemandRecipient[]
}


export async function buildMessagesPage(): Promise<MessagesPageView> {
  const weekStart = daysAgo(7)

  const [
    waitingBySenderRaw,
    waitingTotal,
    uncertainRaw,
    parkedRaw,
    recentRaw,
    sentThisWeek,
    deliveredTotal,
    dispatch,
    pause,
    coverage,
    sendersRaw,
    recipientsRaw,
    upNextRaw,
    lastSendRow,
  ] = await Promise.all([
    /**
     * The queue as COUNTS PER SENDER. The per-draft card list — and the per-draft gate
     * loop behind it, ~7 queries a row — went on 2026-08-18 when every draft became the
     * same standard template: twenty copies of one body is not information, and the
     * refusal that matters fleet-wide is the dispatcher's own hold reason on the pace
     * band, which comes from the enforcer rather than from a per-row re-check.
     */
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
      _count: { _all: true },
    }),
    prisma.outreachAttempt.count({ where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } } }),
    /**
     * Sends we cannot account for. BOTH conditions, not either.
     *
     * `status: 'FAILED'` alone would sweep in ordinary failures, and `failureCode` alone
     * would keep showing an attempt after a person had already resolved it — the resolve
     * action clears the code precisely so that cannot happen, and so a settled incident
     * stops counting toward the circuit breaker.
     */
    prisma.outreachAttempt.findMany({
      where: { status: 'FAILED', failureCode: 'not-in-thread' },
      include: { sender: { select: { handle: true } }, target: { select: { handle: true } } },
      orderBy: { queuedAt: 'asc' },
    }),
    /**
     * Drafts the retry cap PARKED — repeated failures, provably undelivered (every code
     * except not-in-thread is in that class). Rendered with the failure named and two
     * controls, because parking is only safe while it is visible.
     */
    prisma.outreachAttempt.findMany({
      where: { status: 'FAILED', failureCode: { not: 'not-in-thread' } },
      include: { sender: { select: { handle: true } }, target: { select: { handle: true } } },
      orderBy: { queuedAt: 'asc' },
    }),
    prisma.outreachAttempt.findMany({
      where: { status: { in: [...DELIVERED_STATUSES] } },
      include: { sender: { select: { handle: true } }, target: { select: { handle: true } } },
      orderBy: { sentAt: 'desc' },
      take: 50,
    }),
    prisma.outreachAttempt.count({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: weekStart } },
    }),
    /* Lifetime, counted — the figure the landing page states beside today's. */
    prisma.outreachAttempt.count({ where: { status: { in: [...DELIVERED_STATUSES] } } }),
    dispatchStatus(),
    readPause(),
    replyCoverage(),
    /**
     * Every sender, and every recipient we may still write to, for the on-demand dialog.
     *
     * `optedOut` recipients are excluded HERE as well as being filtered in the component. Not
     * belt-and-braces for its own sake: retirement is the one promise the UI makes that has to
     * survive every other feature, and a retired channel should not reach a dropdown at all.
     */
    prisma.senderAccount.findMany({ orderBy: { handle: 'asc' }, select: { handle: true, displayName: true, status: true } }),
    /**
     * WATCHED PAGES ARE NOT OFFERED, and this is the third of the three places the two
     * target types have to be enforced.
     *
     * `prepareOnDemandSend` is deliberately EXEMPT from `routes.ts` — a person picking both
     * ends and being shown every rule they cross is a different act from a route appearing
     * because a brand was discovered — and it CREATES the pair it needs. So neither the
     * route rule nor the pair table can keep a competitor out of this dropdown; only not
     * offering it can, backed by `TARGET_IS_WATCH_ONLY` at the gate for anything that gets
     * past the UI.
     */
    prisma.targetAccount.findMany({
      where: { optedOut: false, role: { not: 'WATCH' } },
      orderBy: [{ kind: 'asc' }, { handle: 'asc' }],
      select: { handle: true, displayName: true, optedOut: true },
    }),
    /**
     * "Up next": ALL READY drafts in the dispatcher's pick order (`deliverWaiting` reads
     * READY by `queuedAt` ascending). Light select — the held/sendable partition below
     * needs only who-to-whom and the queue time, not the 238-char body. Fetching the whole
     * READY set is exactly what the dispatcher does, so this cannot claim an order the
     * dispatcher will not follow.
     */
    prisma.outreachAttempt.findMany({
      where: { status: 'READY' },
      select: {
        id: true,
        status: true,
        queuedAt: true,
        senderId: true,
        targetId: true,
        pair: { include: { sender: true, target: true } },
      },
      orderBy: { queuedAt: 'asc' },
    }),
    prisma.outreachAttempt.findFirst({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
  ])

  /**
   * Today's new-company allowance, from the planner's own counters, plus how many companies
   * are still waiting. Three cheap reads against a page that is already query-budgeted.
   */
  const [settings, newTouchCounts, neverContacted] = await Promise.all([
    getSettings(),
    readNewBrandTouchCounts(),
    prisma.targetAccount.count({ where: { role: 'PROSPECT', attempts: { none: {} } } }),
  ])

  /**
   * THE TWO DOMINANT HOLDS, COMPUTED IN BULK so "Up next" shows what will actually send
   * AND why the rest is resting. Both are the ENFORCERS' own rules, never a mirror:
   *
   *   spacing — `crossSpacingVerdict`, the same shared predicate the gate and the
   *             planner call (the ring rule, 2026-08-19). The UI holding a private
   *             copy of this rule is exactly how the old shape drifted.
   *   reply   — a target that replied within `replyResumeHours`, not yet handled
   *             (TARGET_REPLIED), resume time from the same arithmetic as replyHalt.ts.
   *
   * Three reads for the whole queue: deliveries-in-window, replies-in-window, and the
   * eligible-sender set.
   */
  const now = new Date()
  const cooldownFloor = new Date(now.getTime() - settings.defaultCooldownDays * 24 * 60 * 60 * 1000)
  const [recentDeliveries, repliedRows, eligibleSenderIds] = await Promise.all([
    prisma.outreachAttempt.findMany({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: cooldownFloor } },
      select: { targetId: true, sentAt: true, pair: { select: { senderId: true, sender: { select: { handle: true } } } } },
      orderBy: { sentAt: 'asc' },
    }),
    prisma.outreachAttempt.findMany({
      where: { repliedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
      select: { targetId: true, repliedAt: true },
    }),
    eligibleFleetSenderIds(),
  ])
  /** target → (senderId → that page's newest in-window delivery). Asc order: later rows win. */
  const deliveriesByTarget = new Map<string, Map<string, { sentAt: Date; handle: string }>>()
  for (const r of recentDeliveries) {
    if (r.sentAt === null) continue
    const m = deliveriesByTarget.get(r.targetId) ?? new Map<string, { sentAt: Date; handle: string }>()
    m.set(r.pair.senderId, { sentAt: r.sentAt, handle: r.pair.sender.handle })
    deliveriesByTarget.set(r.targetId, m)
  }
  /** target → when its reply halt releases (newest reply wins, matching replyHalt.ts). */
  const replyResumesAt = new Map<string, Date>()
  for (const r of repliedRows) {
    if (r.repliedAt === null) continue
    const resumes = new Date(r.repliedAt.getTime() + settings.replyResumeHours * 3_600_000)
    const prev = replyResumesAt.get(r.targetId)
    if (prev === undefined || resumes > prev) replyResumesAt.set(r.targetId, resumes)
  }

  /** Reply first, then spacing — the gate's own order, so the sentence names the deeper stop. */
  const holdFor = (draft: { senderId: string; targetId: string }): { why: string; resumesAt: Date } | null => {
    const replyResume = replyResumesAt.get(draft.targetId)
    if (replyResume !== undefined) {
      return { why: 'they replied — resumes on its own, or the moment "I have replied" is pressed', resumesAt: replyResume }
    }
    const v = crossSpacingVerdict({
      now,
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: draft.senderId,
      eligibleSenderIds,
      lastDeliveryBySender: deliveriesByTarget.get(draft.targetId) ?? new Map(),
    })
    return v.held ? { why: crossSpacingDetail(v)!, resumesAt: v.resumesAt } : null
  }

  const sendableDrafts: typeof upNextRaw = []
  const heldRows: HeldRow[] = []
  for (const a of upNextRaw) {
    const hold = holdFor(a)
    if (hold === null) sendableDrafts.push(a)
    else
      heldRows.push({
        senderHandle: a.pair.sender.handle,
        targetHandle: a.pair.target.handle,
        why: hold.why,
        resumesAt: hold.resumesAt,
      })
  }
  const heldWaiting = heldRows.length
  /** Soonest-releasing first: the row a reader wants is "what frees up next". */
  heldRows.sort((a, b) => a.resumesAt.getTime() - b.resumesAt.getTime())
  const heldUpNext = heldRows.slice(0, 8)

  /**
   * The head SENDABLE draft through the REAL gate — the same call the dispatcher makes on
   * its next tick, so the panel's status is the enforcer's own words and catches the rarer
   * holds (cohort, dead session) the two bulk checks above do not. One draft only.
   */
  const headVerdict =
    sendableDrafts.length > 0 ? await recheckBeforeSend(sendableDrafts[0]!, { unattended: true }) : null

  /**
   * When each row's turn comes at the current pace. An estimate, and presented as one: the
   * head goes as soon as the gap since the last delivery has passed (or immediately if it
   * already has), and each later row is one gap further on. The reply sweep and the switch
   * both stretch this — the panel says so rather than pretending.
   */
  const gapMinutes = dispatch.limits.minGapMinutes
  const sinceLastSend =
    lastSendRow?.sentAt == null ? null : Math.floor((Date.now() - lastSendRow.sentAt.getTime()) / 60_000)
  const headWait = sinceLastSend === null ? 0 : Math.max(0, gapMinutes - sinceLastSend)

  const upNext: UpNextRow[] = sendableDrafts.slice(0, 8).map((a, i) => ({
    position: i + 1,
    senderHandle: a.pair.sender.handle,
    targetHandle: a.pair.target.handle,
    // A countdown is a promise. With the switch off nothing is counting down, so the
    // panel is given nothing to count rather than a number that will not arrive.
    etaMinutes: settings.autopilotEnabled ? headWait + i * gapMinutes : null,
    note:
      i === 0 && headVerdict
        ? headVerdict.ok
          ? settings.autopilotEnabled
            ? 'clear to send on the next tick'
            : 'every check passes — waiting only for Autopilot to be switched on'
          : (headVerdict.detail ?? headVerdict.reason)
        : null,
    held: i === 0 && headVerdict !== null && !headVerdict.ok,
  }))

  /** Handles for the per-sender queue counts — one lookup for the whole group. */
  const senderHandles = new Map(
    (
      await prisma.senderAccount.findMany({
        where: { id: { in: waitingBySenderRaw.map((r) => r.senderId) } },
        select: { id: true, handle: true },
      })
    ).map((x) => [x.id, x.handle]),
  )

  return {
    waitingTotal,
    upNext,
    heldWaiting,
    heldUpNext,
    autopilotOn: settings.autopilotEnabled,
    queueBySender: waitingBySenderRaw
      .map((r) => ({ handle: senderHandles.get(r.senderId) ?? r.senderId, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    uncertain: uncertainRaw.map((a) => ({
      id: a.id,
      senderHandle: a.sender.handle,
      targetHandle: a.target.handle,
      queuedAt: a.queuedAt,
      attempts: a.attempts,
      error: a.error,
      profileUrl: profileUrl(a.target.handle),
    })),
    parked: parkedRaw.map((a) => ({
      id: a.id,
      senderHandle: a.sender.handle,
      targetHandle: a.target.handle,
      attempts: a.attempts,
      failureCode: a.failureCode,
      error: a.error,
    })),
    dispatch,
    pause,
    replyCoverage: coverage,
    recent: recentRaw.map((a) => ({
      id: a.id,
      senderHandle: a.sender.handle,
      targetHandle: a.target.handle,
      sentAt: a.sentAt,
      sentBy: a.sentBy,
      threadUrl: a.threadUrl,
      replied: a.repliedAt !== null,
      replyHandled: a.replyHandledAt !== null,
      replyText: a.replyText,
    })),
    sentToday: dispatch.usage.today,
    sentThisWeek,
    deliveredTotal,
    onDemandSenders: sendersRaw.map((x) => ({ handle: x.handle, name: operatorName(x.displayName), status: x.status })),
    onDemandRecipients: recipientsRaw.map((x) => ({
      handle: x.handle,
      name: operatorName(x.displayName),
      retired: x.optedOut,
    })),
    newCompanies: {
      cap: settings.maxNewBrandTouchesPerDay,
      waiting: newTouchCounts.waiting,
      queueRoom: settings.maxWaitingNewBrandDrafts,
      delivered: newTouchCounts.delivered,
      neverContacted,
    },
  }
}
