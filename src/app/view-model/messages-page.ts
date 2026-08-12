import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { daysAgo, istDateKey } from '@/lib/time'
import { dispatchStatus, readPause } from '@/outreach/dispatcher'
import { replyCoverage } from '@/outreach/replyCheck'
import { profileUrl } from '@/lib/urls'
// Never a raw `displayName` — see the note on the import in `view-model.ts`.
import { operatorName } from '@/outreach/render'
/**
 * The SAME gate `sendNow` and `deliverWaiting` call. Not a copy of its rules, and not a
 * summary of them — see the docblock on `SendVerdict` for why that distinction is the whole
 * point of this import.
 */
import { recheckBeforeSend } from '@/outreach/gate'
// WHERE to fix a refusal. The gate says why; this says where. See the docblock in remedy.ts.
import { asSentence, remedyFor, withoutShellCommand, type Remedy } from '../messages/remedy'
import type { OnDemandRecipient, OnDemandSender } from '../on-demand'

/**
 * The `/messages` page: what is waiting, and what has actually gone out.
 *
 * One page for the whole life of a message, because "is anything waiting for me" and
 * "what did we send yesterday" are the same question asked at two moments, and splitting
 * them makes you check two places to find out whether the system is doing anything.
 */

/**
 * Why this draft cannot be sent — from the gate that would refuse it, never re-derived.
 *
 * ── THE DEFECT THIS FIXES ───────────────────────────────────────────────────
 *
 * A waiting draft rendered its body and a "Send from @x" button and said NOTHING about
 * whether that button would work. Measured against the live database on 2026-08-06, all four
 * waiting drafts would have been refused:
 *
 *     3 drafts   no-session      the account has never been logged in
 *     1 draft    target-replied  that channel answered on 31 July
 *
 * So the most prominent control on the page was, for every single row, a button that could
 * only produce an error — on a screen whose whole design principle is that *"nothing happened"
 * with no explanation is the failure this project keeps rediscovering*. The dispatcher panel
 * explains why the FLEET is idle; nothing explained why THIS message is.
 *
 * ── WHY IT IS COMPUTED AND NOT DESCRIBED ────────────────────────────────────
 *
 * `recheckBeforeSend` is the function `sendNow` and `deliverWaiting` both call. This page
 * calls the same one and renders its own `detail` sentence verbatim. Working the answer out
 * here instead would be the exact mistake `checkPersonaDistinct` was extracted to prevent, and
 * that `MAX_TOTAL_SENDS` made for two silent days: a page reporting a limit by a different
 * rule than the one enforcing it reads as headroom that does not exist.
 *
 * ── TWO VERDICTS, BECAUSE THEY ARE TWO QUESTIONS ────────────────────────────
 *
 * `attended` answers *would the button work* and `unattended` answers *will autopilot ever
 * send this*. They can still differ, because the unattended path checks a strict superset —
 * the cohort ladder — and discards overrides. (Until 2026-08-08 the per-account auto-send
 * switch was the other half of that superset; one-switch removed it.)
 *
 * That superset is also why `unattended` is only computed when `attended` permits: anything
 * refused with a human present is refused at least as hard without one, so a second pass in
 * the blocked case would cost six queries to learn nothing.
 */
export interface SendVerdict {
  ok: boolean
  /** The machine code, e.g. `no-session`. Never displayed — it is what `REMEDIES` is keyed on. */
  reason: string | null
  /**
   * The gate's own sentence, capitalised and terminated by `asSentence` and otherwise
   * VERBATIM. Formatted here rather than in the card so all twelve refusal codes are
   * testable — `tests/stopInventory.test.ts` reads every one of them as prose.
   */
  detail: string | null
  /**
   * Where an operator fixes it, resolved HERE rather than in the card.
   *
   * Two reasons, and the first is not stylistic. `waiting.tsx` is a `'use client'` module, so
   * importing `remedy.ts` from it pulled `gate.ts` -> `profile.ts` -> `better-sqlite3` -> `fs`
   * into the browser bundle: HTTP 500 on every route, invisible to `pnpm typecheck`. Second,
   * the view model is where this codebase puts interpretation — "the page itself does no
   * querying and no interpretation".
   */
  remedy: Remedy | null
}

export interface WaitingMessage {
  id: string
  senderHandle: string
  targetHandle: string
  targetName: string
  targetKind: string
  chars: number
  body: string
  hookLine: string | null
  queuedAt: Date
  touchNumber: number
  /** SENDING means a browser is driving it right now — visible so a crash is not a vanishing. */
  inFlight: boolean
  /** Failed before and still waiting. `attempts` exists so a stuck draft is countable. */
  attempts: number
  failureCode: string | null
  /**
   * The stored failure message, with any shell command stripped for the screen.
   *
   * The database keeps the exact bytes — in a log `Run: pnpm ig:login <handle>` is the useful
   * part. On a page for a CEO it is a developer instruction for something the Connect button
   * already does. See `withoutShellCommand`.
   */
  error: string | null
  /** Would "Send from @x" work right now, and if not, why not. */
  send: SendVerdict
  /**
   * Would autopilot ever send it. Only asked when `send.ok` — see the note above.
   * `null` means "not asked", which is NOT the same as "yes" and must not render as one.
   */
  auto: SendVerdict | null
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

export interface MessagesPageView {
  waiting: WaitingMessage[]
  uncertain: UncertainMessage[]
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
  /** Delivered today / this week. Counted the way the enforcer counts, never as 'SENT' alone. */
  sentToday: number
  sentThisWeek: number
  /**
   * Recipients that have used part of today's allowance, and how much.
   *
   * Read from the RESERVATION table rather than recomputed, so the page reports the same
   * number the guard enforces. A limit displayed by a different rule than the one
   * enforcing it is worse than showing no limit at all — it reads as headroom.
   */
  todayByRecipient: { handle: string; used: number }[]
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
  const today = istDateKey()

  const [waitingRaw, uncertainRaw, recentRaw, sentThisWeek, reservations, dispatch, pause, coverage, sendersRaw, recipientsRaw] = await Promise.all([
    prisma.outreachAttempt.findMany({
      // SENDING included, so a send interrupted by a crash stays visible rather than
      // vanishing from the tray with no way to reach it.
      where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
      /**
       * `pair` with both sides included, because `recheckBeforeSend` takes a `ResendAttempt`
       * and that is deliberately a STRUCTURAL type — so this page satisfies the same gate
       * `sendNow` does, with no second shape to keep in step.
       */
      include: { sender: { select: { handle: true } }, target: true, pair: { include: { sender: true, target: true } } },
      orderBy: { queuedAt: 'asc' },
    }),
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
    prisma.outreachAttempt.findMany({
      where: { status: { in: [...DELIVERED_STATUSES] } },
      include: { sender: { select: { handle: true } }, target: { select: { handle: true } } },
      orderBy: { sentAt: 'desc' },
      take: 50,
    }),
    prisma.outreachAttempt.count({
      where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: weekStart } },
    }),
    prisma.dailyReservation.groupBy({
      by: ['subjectId'],
      where: { day: today, scope: 'target' },
      _count: { _all: true },
    }),
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
    prisma.targetAccount.findMany({
      where: { optedOut: false },
      orderBy: [{ kind: 'asc' }, { handle: 'asc' }],
      select: { handle: true, displayName: true, optedOut: true },
    }),
  ])

  const targetHandles = new Map(
    (
      await prisma.targetAccount.findMany({
        where: { id: { in: reservations.map((r) => r.subjectId) } },
        select: { id: true, handle: true },
      })
    ).map((t) => [t.id, t.handle]),
  )

  /**
   * Ask the real gate about every waiting draft.
   *
   * Sequential rather than concurrent on purpose: `journal_mode = delete` takes a fresh shared
   * lock per read, and firing six queries × two verdicts × every draft at once is how
   * `SQLITE_BUSY` is provoked on a file three processes already share. The list is small by
   * construction — `maxUnansweredTouches` and the daily caps bound it — and a page that is
   * already `force-dynamic` can afford the round trips.
   */
  const verdicts = new Map<string, { send: SendVerdict; auto: SendVerdict | null }>()
  for (const a of waitingRaw) {
    const attended = await recheckBeforeSend(a, { unattended: false })
    const send: SendVerdict = attended.ok
      ? { ok: true, reason: null, detail: null, remedy: null }
      : { ok: false, reason: attended.reason, detail: asSentence(attended.detail), remedy: remedyFor(attended.reason) }

    // Only when the button would work — anything refused with a human present is refused at
    // least as hard without one, so the second pass would cost six queries to learn nothing.
    let auto: SendVerdict | null = null
    if (attended.ok) {
      const r = await recheckBeforeSend(a, { unattended: true })
      auto = r.ok
        ? { ok: true, reason: null, detail: null, remedy: null }
        : { ok: false, reason: r.reason, detail: asSentence(r.detail), remedy: remedyFor(r.reason) }
    }
    verdicts.set(a.id, { send, auto })
  }

  return {
    waiting: waitingRaw.map((a) => ({
      id: a.id,
      senderHandle: a.sender.handle,
      targetHandle: a.target.handle,
      targetName: operatorName(a.target.displayName),
      targetKind: a.target.kind,
      chars: a.renderedBody.length,
      body: a.renderedBody,
      hookLine: a.hookLine,
      queuedAt: a.queuedAt,
      touchNumber: a.touchNumber,
      inFlight: a.status === 'SENDING',
      attempts: a.attempts,
      failureCode: a.failureCode,
      error: withoutShellCommand(a.error),
      // Non-null by construction: every waiting row was put in the map above. The fallback is
      // deliberately the REFUSING shape — a missing verdict must never render as permission.
      send: verdicts.get(a.id)?.send ?? { ok: false, reason: null, detail: 'The send checks could not be read.', remedy: null },
      auto: verdicts.get(a.id)?.auto ?? null,
    })),
    uncertain: uncertainRaw.map((a) => ({
      id: a.id,
      senderHandle: a.sender.handle,
      targetHandle: a.target.handle,
      queuedAt: a.queuedAt,
      attempts: a.attempts,
      error: a.error,
      profileUrl: profileUrl(a.target.handle),
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
    sentToday: recentRaw.filter((a) => a.sentAt && a.sentAt >= new Date(`${today}T00:00:00+05:30`)).length,
    sentThisWeek,
    onDemandSenders: sendersRaw.map((x) => ({ handle: x.handle, name: operatorName(x.displayName), status: x.status })),
    onDemandRecipients: recipientsRaw.map((x) => ({
      handle: x.handle,
      name: operatorName(x.displayName),
      retired: x.optedOut,
    })),
    todayByRecipient: reservations
      .map((r) => ({ handle: targetHandles.get(r.subjectId) ?? r.subjectId, used: r._count._all }))
      .sort((a, b) => b.used - a.used),
  }
}
