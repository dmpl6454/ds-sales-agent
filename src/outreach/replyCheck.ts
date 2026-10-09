import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { hoursAgo, istStamp } from '@/lib/time'
import { getSettings } from '@/lib/settings'
import { profileStatus } from './browser/profile'
import { openAndReadThread } from './browser/readThread'
import { scanInbox } from './browser/inboxScan'
import { parseInboxAge, plausibleReplyDate } from './browser/threadDates'
import { triageInboxRow, snippetIsReplyText, matchInboxRow, matchInboxRowToTarget, shouldRecordInboxReply, threadIdFrom, type TargetRef } from './inboxTriage'
import { normalise } from './matching'
import { markChallenged } from './challenge'
import { thisMacRole } from './activeDevice'
import { browserShutdownRequested } from './shutdown'
import { createFailureMemory } from '@/detection/lookupCooldown'

/**
 * Checking open conversations for replies.
 *
 * WHY THIS EXISTS
 *
 * `OutreachAttempt.repliedAt` gates `TARGET_REPLIED` — the hardest stop in the system,
 * the one that halts every sender to a target the moment a human answers. Until 3 August
 * its only writers were two commands a person had to remember to run, nothing checked at
 * all, and the dashboard displayed "no reply" for conversations nobody had ever looked
 * at. That is the project's signature failure: the negative direction works perfectly, so
 * the gap is invisible.
 *
 * ── PHASE 6: WHY A SCHEDULED SWEEP CANNOT SCALE, AND WHAT REPLACES IT ─────
 *
 * The sweep runs twice a day and opens at most `MAX_REPLY_CHECKS_PER_RUN` browser
 * sessions, so its capacity is a CONSTANT — eight conversations a day — while the number
 * of conversations grows with the fleet. Do the arithmetic at the planned size: 60 open
 * conversations against 8 checks a day is a mean staleness of **7.5 days**, while the
 * paced dispatcher sends every twenty minutes. A follow-up would routinely go into a
 * conversation last read a week ago.
 *
 * Raising the cap is the obvious move and it is the wrong one: it multiplies unattended
 * browser sessions against revenue accounts to buy coverage of conversations that are not
 * about to be written to. CLAUDE.md declined that trade deliberately and the judgement
 * stands.
 *
 * The fix is to stop paying per TARGET and start paying per SEND. `ensureConversationChecked`
 * runs immediately before a follow-up is delivered, on exactly the thread that follow-up
 * would land in, and refuses the send if the thread cannot be read. Its cost is
 * proportional to messages sent — which the dispatcher already paces — rather than to how
 * many prospects exist. So coverage of what MATTERS is total at any fleet size, and the
 * sweep becomes what it should always have been: best-effort discovery for conversations
 * nobody is about to write to.
 *
 * ── AND A CORRECTION: A CHECK COVERS ONE THREAD, NOT ONE INBOX ────────────
 *
 * The previous version checked once per TARGET and skipped every other sender, reasoning
 * that "three senders to one channel is one inbox — triple the exposure for the same
 * fact". The first half is true from the recipient's side and the conclusion does not
 * follow: **Instagram direct messages are per account PAIR.** `@a`'s conversation with
 * `@t` and `@b`'s conversation with `@t` are different threads, and a session logged in as
 * `@a` can only read `@a`'s. So a reply sent to `@b` was invisible to a check made through
 * `@a`, which then stamped `replyCheckedAt` and recorded verified silence.
 *
 * That is "we could not read it, so call it no reply" wearing a different hat, and
 * rotation makes it the normal case rather than the exception — spreading many senders
 * across one recipient is the entire point of the fleet.
 *
 * This is a structural property of Instagram DMs, not something measured here; it is
 * stated as reasoning rather than as a measurement on purpose. Deduplication is now per
 * PAIR. The cap is unchanged, so this costs no extra browser sessions — it changes WHICH
 * conversations the same budget reads, and stops a check standing in for a thread it
 * never opened.
 *
 * The HALT's scope is `replyHaltScope` (replyHalt.ts) — per PAIR by default since 1 Sept,
 * Tabish's decision. That is why a reply must be RECORDED on the pair whose conversation
 * showed it (`recordReplyOnPair`, audit C2/H9): a reply written onto another page's row
 * halts that page and leaves the one they answered writing into the live thread.
 *
 * WHAT IT WILL NOT DO
 *
 * It never composes and never sends. `openAndReadThread` is read-only against Instagram
 * by construction. An unreadable thread is recorded as unreadable, never downgraded to
 * "no reply" — a DOM change must not be able to quietly disable the guard it feeds.
 */

/** Slots at which the sweep runs. A subset of SLOTS, deliberately. */
export const REPLY_CHECK_SLOTS = ['11:00', '20:00'] as const

/** Never re-check a conversation more often than this. */
const REPLY_CHECK_MIN_HOURS = 10

/** Ceiling on browser sessions opened by one sweep. A backlog must not become a burst. */
const MAX_REPLY_CHECKS_PER_RUN = 4

/** Inbox rows older than this are never opened to learn their thread id (see the scan). */
const OPEN_ROW_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * ── PAIRS WHOSE DOOR REFUSED, RESTED FOR A DAY (audit C1, 2026-10-09) ─────────────────
 *
 * When the inbox route cannot confirm WHO a conversation is with, the read refuses and never
 * stamps `replyCheckedAt` — correctly. But `openConversations` re-selects every never-checked
 * pair on every run and `prioritiseConversations` ranks them first, so a door-less recipient
 * the ring fanned out to four or five pages would hold the whole `MAX_REPLY_CHECKS_PER_RUN`
 * budget every half hour, forever: zero real reply reads, and dozens of inbox-route drives a
 * day from revenue accounts. Rules 26/36, one door along.
 *
 * So a refused pair goes to the back for 24 hours through the shared `lookupCooldown`
 * mechanism — in-process and time-based, a failure never becoming a verdict — and the pairs it
 * holds back are COUNTED into `deferred`, never silently dropped. A successful read forgets it.
 * The just-in-time read before a follow-up does not consult this: deliver.ts's attempt cap
 * already bounds that path, and a send must never skip the read it depends on.
 */
const doorRefusals = createFailureMemory()

/** Test seam: module state would otherwise leak between cases in one suite process. */
export function resetReplySweepMemory(): void {
  doorRefusals.reset()
}

/**
 * Thread ids learned by opening inbox rows, per sender and row title, for this process's
 * lifetime. A row carries no id in the DOM, so without this every sweep would click the same
 * unplaced strangers again. Bounded; an agent restart costs one relearning sweep.
 */
const resolvedRowThreads = new Map<string, string>()

/**
 * How recently a conversation must have been read for a follow-up into it to be allowed
 * without reading it again.
 *
 * 24 hours, against a sweep that runs twice daily: at today's size the sweep keeps
 * everything fresh and the just-in-time check almost never fires. At fleet size the sweep
 * covers a fraction and the just-in-time check covers every conversation that is actually
 * about to receive a message. The guard's strength stops depending on how many prospects
 * exist.
 */
export const REPLY_FRESHNESS_HOURS = 24

/**
 * The most of a reply's text that is stored — and therefore the most of it that is ever
 * COMPARED. Every write slices to this and the "is this bubble already recorded?" test slices
 * the bubble to it too (audit C2). They used to disagree: storage sliced, the comparison did
 * not, so a 2,500-character rate card a recipient pasted was "new" on every read forever and
 * each read held a follow-up. One constant, every write and the comparison.
 */
export const REPLY_TEXT_MAX = 2000

export interface ReplyCheckOutcome {
  pairKey: string
  status: 'reply-found' | 'no-reply' | 'unreadable' | 'incomplete' | 'skipped'
  detail?: string
}

export interface ReplyCheckSummary {
  checked: number
  repliesFound: number
  unreadable: number
  /**
   * Reads that SUCCEEDED and provably did not see the whole thread.
   *
   * Counted apart from `unreadable` because the two have different fixes — a DOM change
   * versus a race lost against Instagram's own re-render — and because a number that
   * silently rises is exactly what this project keeps finding late. MEASURED live
   * 2026-08-05: the completeness of this guard used to be decided by a jitter.
   */
  incomplete: number
  /** Conversations the cap could not reach this run. Reported, never silent. */
  deferred: number
  outcomes: ReplyCheckOutcome[]
  /** Senders whose whole inbox LIST was read this run (one browser drive each). */
  inboxesScanned?: number
  /** Replies recorded straight from inbox rows — halts that never cost a thread read. */
  inboxRepliesRecorded?: number
  /**
   * Rows where THEY wrote last and no target matched — usually an inbound enquiry from
   * an account we never messaged (the @fukra_insaan class) or an ambiguous display
   * name. Named so a person can look; never guessed at.
   */
  inboxUnmatched?: string[]
}

/** Is this a slot at which the sweep runs? */
export function isReplyCheckSlot(slot: string): boolean {
  return (REPLY_CHECK_SLOTS as readonly string[]).includes(slot)
}

// ── prioritisation ──────────────────────────────────────────────────────────

export interface ConversationCandidate {
  attemptId: string
  pairId: string
  senderId: string
  senderHandle: string
  targetId: string
  targetHandle: string
  replyCheckedAt: Date | null
  sentAt: Date | null
  /** A draft is waiting for THIS pair — we are about to write into this thread again. */
  hasWaitingDraft: boolean
}

/**
 * PURE. Which conversations to spend the run's budget on, in order.
 *
 * A cap forces a choice, and the previous ordering — oldest-checked first — made it on
 * fairness alone. Fairness is the wrong criterion for a safety guard: the conversation
 * where a missed reply does real damage is the one we are ABOUT TO WRITE INTO again,
 * because that is the "repeated unwanted contact" Meta's policy penalises, aimed at the
 * one person who engaged.
 *
 * So: pairs with a draft waiting first, then never-checked, then stalest. Ties broken on
 * the most recent send, because a reply usually arrives soon after a message.
 *
 * Extracted and pure so the ordering is testable without driving a browser — the rest of
 * this module cannot be tested at all without one.
 */
export function prioritiseConversations(candidates: readonly ConversationCandidate[]): ConversationCandidate[] {
  const rank = (c: ConversationCandidate): number => (c.hasWaitingDraft ? 0 : c.replyCheckedAt === null ? 1 : 2)
  return candidates.slice().sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    // Within a band: stalest check first (nulls already ranked above).
    const ca = a.replyCheckedAt?.getTime() ?? 0
    const cb = b.replyCheckedAt?.getTime() ?? 0
    if (ca !== cb) return ca - cb
    // Then most recently written to — where a reply is most likely to have arrived.
    return (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0)
  })
}

// ── reading ONE conversation ────────────────────────────────────────────────

export type ConversationResult =
  /**
   * `writtenAt` is the date the halt counts from (`replyPostedAt`), NULL for an undatable reply,
   * which holds nothing (audit H9): the caller words what the reply did from it rather than
   * asserting a pause that may not exist.
   */
  | { status: 'reply-found'; replyText: string; writtenAt: Date | null }
  | { status: 'no-reply'; detail?: string }
  /**
   * `doorRefused`: the inbox route opened a conversation that could not be confirmed as this
   * recipient's (audit C1). The sweep rests the pair on it — see `doorRefusals`.
   */
  | { status: 'unreadable'; detail: string; doorRefused?: true }
  /**
   * The thread opened and was read, and what came back was provably not all of it. A HOLD,
   * never a "no reply": `replyCheckedAt` is not stamped, exactly as for `unreadable`.
   */
  | { status: 'incomplete'; detail: string }
  /** Instagram challenged the account. It is halted; the caller must stop. */
  | { status: 'checkpoint'; detail: string }

/**
 * Open one conversation, read it, and record what is there.
 *
 * ONE implementation, two callers — the scheduled sweep and the just-in-time check before
 * a follow-up. The alternative was a second copy, and this codebase has already paid for
 * a second copy of a safety rule once: `sendNow` and `deliverWaiting` drifted until one of
 * them was missing five checks, including *they replied*.
 *
 * Never stamps `replyCheckedAt` unless the thread was actually read. "We looked and can
 * vouch for the silence" and "we could not read it" are different facts, and collapsing
 * them lets a layout change silently disable the hardest guard in the system.
 */
export async function checkConversation(args: {
  senderId: string
  senderHandle: string
  targetId: string
  targetHandle: string
  /**
   * The caller's own row of THIS PAIR: the sweep's candidate (a delivered message with no reply
   * yet) or, before a follow-up, the waiting draft itself. `recordReplyOnPair` prefers the
   * pair's newest free delivered row and only then uses this.
   */
  fallbackAttemptId: string
  /**
   * REQUIRED, so the compiler names both callers (audit C2). True when `fallbackAttemptId` is a
   * DRAFT that was never sent: a reply must never turn it REPLIED — that would count a message
   * nobody received as delivered, put its body in the completeness bar of every later read, and
   * leave the pair unreadable forever. A draft is SUPERSEDED (SKIPPED) instead.
   */
  fallbackIsDraft: boolean
  now?: Date
}): Promise<ConversationResult> {
  const { senderId, senderHandle, targetId, targetHandle, fallbackAttemptId, fallbackIsDraft } = args
  const now = args.now ?? new Date()

  /**
   * TWO SETS, TWO JOBS — see `ThreadBodies` in readThread.ts for the incident.
   *
   * `allOurs` stays fleet-wide: a body that exists in ANY of our threads must never be read
   * back as the recipient's words. `expected` is THIS PAIR's deliveries only, because a
   * thread holds one pair's conversation — the fleet-wide bar made completeness
   * unsatisfiable for every fanned-out recipient, so `replyCheckedAt` was never stamped and
   * a live rate negotiation went unrecorded while other pages kept writing.
   *
   * AND ONLY ROWS THAT WERE ACTUALLY SENT (audit C2). A REPLIED row with `sentAt: null` is a
   * draft an older reply path flipped to REPLIED — a message that never reached the thread.
   * In `expected` its body could never be found, so every read of that pair came back
   * `incomplete` forever, each one burning the full history scroll against a revenue profile.
   * `allOurs` is deliberately left unfiltered: classification errs towards "ours".
   */
  const delivered = await prisma.outreachAttempt.findMany({
    where: { targetId, status: { in: [...DELIVERED_STATUSES] } },
    select: { renderedBody: true, senderId: true, sentAt: true },
  })
  const allOurs = delivered.map((a) => a.renderedBody)
  const expected = delivered.filter((a) => a.senderId === senderId && a.sentAt !== null).map((a) => a.renderedBody)

  let result
  try {
    result = await openAndReadThread(senderHandle, targetHandle, { expected, allOurs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    /**
     * A checkpoint during a READ is still a checkpoint. Reading is lower risk than
     * sending, but it is the same account and the same enforcement surface — and since
     * Phase 5 it also trips the fleet circuit breaker, which is right: a flag is evidence
     * about the pattern rather than about the account.
     */
    if (/checkpoint|challenge|suspend/i.test(message)) {
      await markChallenged({
        senderId,
        handle: senderHandle,
        detail: `checkpoint while reading a thread: ${message.slice(0, 200)}`,
        actor: 'reply-check',
      })
      return { status: 'checkpoint', detail: 'checkpoint — account halted' }
    }

    log.warn('reply check failed', { sender: senderHandle, target: targetHandle, error: message })
    return { status: 'unreadable', detail: message.slice(0, 160) }
  }

  /**
   * A PARTIAL READ MAY NOT VOUCH FOR SILENCE, BUT A REPLY IT SAW IS A FACT (2026-09-03).
   *
   * `incomplete` used to return here with everything it had seen discarded. @maybelline_ind
   * answered the 1 Sept first touch; three pre-send reads on 2-3 Sept came back "saw 0 of 1"
   * and each threw away the reply bubble in hand, and the follow-up went into the answered
   * conversation at 12:45 on 3 Sept. So THEIR bubbles from an incomplete read flow into the
   * recording logic below; only the "nothing new → verified silence" stamp stays refused.
   */
  const partialTheirs =
    !result.ok && result.reason === 'incomplete' ? (result.messages ?? []).filter((m) => !m.ours) : []
  const partial = !result.ok
  const partialDetail = !result.ok ? result.detail : undefined
  if (partial && partialTheirs.length > 0) {
    log.step('partial read, but it saw a reply — recording that, vouching for nothing else', {
      sender: senderHandle,
      target: targetHandle,
      detail: partialDetail,
    })
  }

  if (!result.ok && partialTheirs.length === 0) {
    /**
     * NOT recorded as checked. Stamping `replyCheckedAt` after an unreadable thread would
     * convert a failure into an assertion of silence, and the dashboard would then show a
     * verified "no reply" for a conversation nobody could read.
     */
    log.warn('could not read thread — NOT recording as checked', {
      sender: senderHandle,
      target: targetHandle,
      reason: result.reason,
      detail: result.detail,
    })
    /**
     * `incomplete` is kept distinct all the way out. Both refuse to stamp `replyCheckedAt`,
     * so the safety behaviour is identical; what differs is what an operator should DO, and
     * collapsing them would render "the layout changed" and "we lost a race with Instagram's
     * re-render" as one sentence.
     */
    if (result.reason === 'incomplete') {
      return { status: 'incomplete', detail: result.detail ?? 'did not see the whole conversation' }
    }
    if (result.doorRefused) return { status: 'unreadable', detail: result.detail ?? result.reason, doorRefused: true }
    return { status: 'unreadable', detail: result.detail ?? result.reason }
  }

  /**
   * BACKFILL THE THREAD URL while we are standing in the thread.
   *
   * MEASURED 2026-08-19: every delivered message ever carried `threadUrl: null`, because
   * the send path's conversation opens as a panel over the profile and the URL never
   * changes — so the CSV export's thread column was empty end to end. This read HAS
   * navigated into the real conversation, so its URL is the one the send path could not
   * capture. Pair-scoped (a thread belongs to one sender-target pair), only where the
   * column is empty, and never allowed to fail the check it rides on.
   */
  if (result.ok && result.url.includes('/direct/t/')) {
    await prisma.outreachAttempt
      .updateMany({
        where: { senderId, targetId, status: { in: [...DELIVERED_STATUSES] }, threadUrl: null },
        data: { threadUrl: result.url },
      })
      .catch(() => undefined)
  }

  const theirs = result.ok ? result.messages.filter((m) => !m.ours) : partialTheirs

  /**
   * Only messages we have NOT already recorded count as a new reply.
   *
   * A thread holds the whole conversation, so `theirs.length > 0` is true forever once
   * someone answers even once. Recording on that alone meant every subsequent check
   * re-detected the SAME old message as fresh — re-halting outreach on every read.
   *
   * ── PAIR-SCOPED AND SLICE-CONSISTENT (audit C2, 2026-10-09) ──────────────
   *
   * This compared against every reply stored for the TARGET. A thread belongs to one pair, so
   * words recorded on ANOTHER page's row — an autoresponder sent to every page, a copy-paste, or
   * a reply the inbox scan parked on another page's row for want of one of its own — stopped
   * this page's thread from ever recording them, and its follow-up was driven into the answered
   * conversation. So: THIS PAIR's rows, with deliberately NO status filter, so a draft superseded
   * by a reply (SKIPPED, below) still counts as known. Both sides are cut to `REPLY_TEXT_MAX`,
   * because that is what storage keeps.
   *
   * (It used to say "HANDLED ONES INCLUDED". Moot: `replyHandledAt` has had no writer since the
   * early-release button was removed on 2026-08-25.)
   */
  const knownReplies = (
    await prisma.outreachAttempt.findMany({
      where: { senderId, targetId, replyText: { not: null } },
      select: { replyText: true },
    })
  ).map((r) => normalise(r.replyText!))

  /**
   * ── A TEXTLESS REPLY ROW IS A MARKER, AND NOTHING FILLS IT FROM THE THREAD (audit C2) ──
   *
   * A row with `repliedAt` set and `replyText: null` records THAT they wrote — an inbox state
   * snippet ("2 new messages", "…sent an attachment"), or a hand record (`pnpm ig:reply`,
   * `ig:thread --record-reply`). This read used to BACKFILL such a row with the newest bubble's
   * text and return "no reply" BEFORE asking whether that bubble was new — and the row it
   * picked was the TARGET's, any page's. A recipient who wrote "what are your rates?" days after
   * a textless marker had the question written onto the old row (with the old date, so the halt
   * saw nothing new), the read reported silence, and the follow-up went into the answered
   * thread. Which bubble a marker stands for cannot be known; guessing swallowed live replies.
   *
   * So a marker is left alone. If what it stood for was words, those words are recorded below
   * once, as their own reply, dated from their own thread separator — and the halt keys on that
   * date, so re-recording an old bubble does not lengthen anything (beyond the clamp to our last
   * send, which only ever over-holds). Do NOT replace the deleted backfill with matching a bubble
   * to a marker by date or position: separator parses mis-date replies early (@drongofilms, three
   * months), and a mis-dated new reply would be called "covered" and swallowed again.
   */
  const fresh = theirs.filter((m) => !knownReplies.includes(normalise(m.text.slice(0, REPLY_TEXT_MAX))))

  if (fresh.length === 0) {
    /* A partial read that saw only already-recorded replies still cannot vouch for silence. */
    if (partial) return { status: 'incomplete', detail: `${partialDetail ?? 'partial read'} — the reply it saw was already recorded` }
    await prisma.outreachAttempt.update({
      where: { id: fallbackAttemptId },
      data: { replyCheckedAt: now },
    })
    return {
      status: 'no-reply',
      detail: theirs.length > 0 ? `${theirs.length} earlier reply(ies), nothing new` : undefined,
    }
  }

  /**
   * The parsed separator is CLAMPED to a window that could be true — see
   * `plausibleReplyDate`. Unclamped, a mis-read separator dated @drongofilms' reply three
   * months early and the halt released nine minutes after they wrote to us. Target-wide on
   * purpose: under rotation it can only raise the lower bound, which over-holds.
   */
  const lastSentAt = (
    await prisma.outreachAttempt.findFirst({
      where: { targetId, status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null, lte: now } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    })
  )?.sentAt ?? null

  /**
   * ── THE NEWEST-DATED FRESH BUBBLE, NOT THE LAST BY POSITION (audit C2) ──
   *
   * `messages` is in FIRST-SEEN order (the observer, then the history scroll), not time order,
   * and the halt is dated from the bubble recorded. The last by position could be an old bubble,
   * dating the halt from last week while a reply from this morning sat in the same read. Each
   * bubble is dated through the same clamp; an undatable one sorts lowest, and a tie goes to the
   * later position, which was the old choice.
   */
  const pick = fresh
    .map((m) => ({ m, at: plausibleReplyDate({ parsed: m.approxAt, lastSentAt, observedAt: now }) }))
    .reduce((best, c) => (datedNoEarlier(c.at, best.at) ? c : best))
  const newest = pick.m
  const writtenAt = pick.at
  const replyText = newest.text.slice(0, REPLY_TEXT_MAX)

  /**
   * TWO CLOCKS, RECORDED SEPARATELY (2026-08-21). `repliedAt` is when WE SAW it — the
   * observation. `replyPostedAt` is when THEY WROTE it, from the thread's own date
   * separator above the bubble (`ThreadMessage.approxAt`), and it is what the halt reads.
   * NULL means the thread showed no parseable date above this reply — and per Tabish's rule
   * an undatable reply is recorded, listed for a person, and does NOT hold the halt, because
   * it may answer a conversation from long before the window.
   * `pnpm ig:reply <sender> <target> --at <ISO>` still corrects either by hand.
   *
   * ONLY A COMPLETE READ VOUCHES (audit C2, CLAUDE.md 3 Sept): a partial read that saw a reply
   * records it, but stamping `replyCheckedAt` would let the next follow-up skip the read as
   * "fresh" — into a conversation the last read provably did not see in full.
   */
  const recorded = await recordReplyOnPair({
    senderId,
    senderHandle,
    targetId,
    targetHandle,
    replyText,
    writtenAt,
    now,
    vouch: result.ok,
    callerRow: { id: fallbackAttemptId, isDraft: fallbackIsDraft },
    otherPage: null,
    audit: {
      action: 'reply.record.auto',
      detail: `@${targetHandle} replied to @${senderHandle} (observed ${now.toISOString()}; written ${writtenAt ? writtenAt.toISOString() : 'UNDATED — holds no automatic pause'}${newest.approxAt && writtenAt && newest.approxAt.getTime() !== writtenAt.getTime() ? `, clamped from the thread's ${newest.approxAt.toISOString()} which predates the message it answers` : ''})`,
    },
  })

  if (recorded.written === 'none') {
    /* Nothing was written. Still REPLY-FOUND, so the caller holds and the next read records it. A
       lost race was already alarmed by the writer; a pair with no row at all is alarmed here. */
    if (recorded.why !== 'raced') {
      log.alarm('a reply was seen but this conversation has no row to record it on — the send is held', {
        target: targetHandle,
        via: senderHandle,
        why: recorded.why,
      })
    }
  } else {
    log.info(writtenAt ? 'reply detected — this conversation is halted, counted from when they wrote' : 'reply detected — it carries no date, so it holds no automatic pause; listed for a person', {
      target: targetHandle,
      via: senderHandle,
      recordedOn: recorded.written,
      preview: replyText.slice(0, 80),
    })
  }
  return { status: 'reply-found', replyText, writtenAt }
}

/**
 * PURE. Should a bubble dated `candidate` replace the current pick dated `best`? Null — an
 * undatable bubble — sorts lowest; a tie goes to the candidate, i.e. the later position.
 */
export function datedNoEarlier(candidate: Date | null, best: Date | null): boolean {
  if (candidate === null) return best === null
  if (best === null) return true
  return candidate.getTime() >= best.getTime()
}

// ── the ONE writer of a reply ───────────────────────────────────────────────

/** The `error` a draft carries once a reply made it moot. */
export const SUPERSEDED_BY_REPLY = 'superseded — the recipient replied before this was sent'

export type ReplyRecord =
  /** This pair's newest delivered message with no reply yet now carries it (status REPLIED). */
  | { written: 'delivered'; attemptId: string }
  /** No free delivered row: this pair's waiting draft carries it and is SKIPPED, never sent. */
  | { written: 'superseded-draft'; attemptId: string }
  /** Every delivered row of this pair already carried a reply: written forward on the newest. */
  | { written: 'forward'; attemptId: string }
  /** Inbox only: this pair has no row of its own, so the lead sits on another page's row. */
  | { written: 'other-page'; attemptId: string }
  | { written: 'none'; why: 'raced' | 'no-row' | 'same-words-on-another-page' }

/** A conditional update whose row moved on throws P2025; that is a lost race, not a failure. */
function lostRace(err: unknown): false {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025') return false
  throw err
}

/**
 * Record a reply ON THE PAIR WHOSE CONVERSATION SHOWED IT — the ONE writer of reply text, shared
 * by the thread read and the inbox scan (audit C2 / H9, 2026-10-09).
 *
 * Two copies of "which row does a reply sit on" are how the thread path and the inbox drifted.
 * The thread path attached a new reply to the newest delivered row FOR THE TARGET — any page's.
 * Under the pair-scoped halt (Tabish, 1 Sept) that halted the page that was NOT answered and left
 * the answered one writing into the live thread: its next read found the text already "known"
 * (target-scoped), reported silence, and the follow-up went out. So, in order:
 *
 *   (a) this pair's newest delivered row with no reply — `sentAt: { not: null }` and
 *       `repliedAt: null` sit INSIDE the where, because Postgres sorts NULL FIRST under DESC and
 *       a sentAt-null row would otherwise be picked (SQLite sorts them last, so no SQLite test can
 *       see it); then the caller's own delivered row (the sweep's candidate).
 *   (b) else this pair's waiting DRAFT — the caller's (before a follow-up) or the newest
 *       READY/QUEUED one (the inbox) — SUPERSEDED to SKIPPED, never flipped to REPLIED. A REPLIED
 *       draft is a message nobody received counted as delivered: it inflates touch counts and
 *       claims, and its body joins the completeness bar of every later read, which then comes
 *       back "incomplete" forever. SKIPPED is in neither DELIVERED nor IN_FLIGHT, and every halt
 *       query, the known-texts test and `targetEverReplied` carry no status filter, so the row
 *       still halts and still counts. The status guard sits INSIDE the update (discard.ts's
 *       rule); a dashboard Send that claimed the draft meanwhile makes it throw P2025, and then
 *       NOTHING is written — the caller holds, and the next read records it on the sent row.
 *   (c) else every delivered row of this pair already carries a reply: the new one is written
 *       FORWARD onto the newest, so THIS pair's halt re-arms from its own date, and the reply it
 *       replaces is kept, verbatim, in the audit row (audit H9's recommended option).
 *   (d) else, the inbox scan only (`otherPage`): this pair has no row at all — a name-matched
 *       inbound message to a page that never wrote to them. It sits on another page's newest
 *       free row so the lead stays visible, unless the same words are already recorded on the
 *       target (that skip is what stops the @medlinkstrichology walk-down, and it applies only
 *       here — on this pair's own rows `shouldRecordInboxReply` already dedupes).
 *
 * Every write is one `$transaction` with its audit row(s). `vouch` — a COMPLETE thread read —
 * is the only thing that stamps `replyCheckedAt`.
 */
async function recordReplyOnPair(args: {
  senderId: string
  senderHandle: string
  targetId: string
  targetHandle: string
  /** NULL only from the inbox: a state snippet records THAT they wrote, never as their words. */
  replyText: string | null
  writtenAt: Date | null
  now: Date
  vouch: boolean
  /** The caller's own row of this pair — the sweep's delivered candidate or the pre-send draft. Null from the inbox. */
  callerRow: { id: string; isDraft: boolean } | null
  /** The inbox's escape hatch, case (d); null on the thread path. */
  otherPage: { snippet: string } | null
  audit: { action: 'reply.record.auto' | 'reply.record.inbox'; detail: string }
}): Promise<ReplyRecord> {
  const { senderId, senderHandle, targetId, targetHandle, now } = args
  const reply = {
    repliedAt: now,
    replyPostedAt: args.writtenAt,
    replyText: args.replyText,
    ...(args.vouch ? { replyCheckedAt: now } : {}),
  }
  const auditRow = (attemptId: string, action: string, detail: string) =>
    prisma.auditLog.create({ data: { actor: 'reply-check', action, entity: `OutreachAttempt:${attemptId}`, detail } })
  /* Raised here, once, for every branch: the row this reply was going onto moved on between the
     lookup and the guarded update (a dashboard Send claimed the draft, or a hand record landed). */
  const raced = (attemptId: string): ReplyRecord => {
    log.alarm('the row a reply was being recorded on changed meanwhile — nothing written; the next read records it', {
      pair: `${senderHandle}→${targetHandle}`,
      attemptId,
    })
    return { written: 'none', why: 'raced' }
  }

  // (a) this pair's newest FREE delivered row, else the caller's own delivered row.
  const free = await prisma.outreachAttempt.findFirst({
    where: { senderId, targetId, status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null }, repliedAt: null },
    orderBy: { sentAt: 'desc' },
    select: { id: true },
  })
  const deliveredId = free?.id ?? (args.callerRow && !args.callerRow.isDraft ? args.callerRow.id : null)
  if (deliveredId) {
    const done = await prisma
      .$transaction([
        prisma.outreachAttempt.update({ where: { id: deliveredId, repliedAt: null }, data: { ...reply, status: 'REPLIED' } }),
        auditRow(deliveredId, args.audit.action, args.audit.detail),
      ])
      .then(() => true, lostRace)
    return done ? { written: 'delivered', attemptId: deliveredId } : raced(deliveredId)
  }

  // (b) this pair's waiting draft, superseded — never REPLIED.
  const draftId = args.callerRow
    ? args.callerRow.isDraft
      ? args.callerRow.id
      : null
    : ((
        await prisma.outreachAttempt.findFirst({
          where: { senderId, targetId, status: { in: ['READY', 'QUEUED'] }, repliedAt: null },
          orderBy: { queuedAt: 'desc' },
          select: { id: true },
        })
      )?.id ?? null)
  if (draftId) {
    const done = await prisma
      .$transaction([
        prisma.outreachAttempt.update({
          where: { id: draftId, status: { in: ['READY', 'QUEUED'] }, repliedAt: null },
          data: { ...reply, status: 'SKIPPED', error: SUPERSEDED_BY_REPLY },
        }),
        auditRow(draftId, args.audit.action, `${args.audit.detail} — recorded on @${senderHandle}'s waiting message, which is withdrawn unsent`),
        auditRow(
          draftId,
          'attempt.superseded-by-reply',
          `@${senderHandle}'s waiting message to @${targetHandle} will not be sent: they replied in this conversation before it went out`,
        ),
      ])
      .then(() => true, lostRace)
    return done ? { written: 'superseded-draft', attemptId: draftId } : raced(draftId)
  }

  // (c) every delivered row of this pair already carries a reply: write forward on the newest.
  const newestOwn = await prisma.outreachAttempt.findFirst({
    where: { senderId, targetId, status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, replyText: true, replyPostedAt: true },
  })
  if (newestOwn) {
    const replaced =
      newestOwn.replyText === null
        ? 'a reply recorded without its words'
        : `the earlier reply "${newestOwn.replyText}"`
    const done = await prisma
      .$transaction([
        prisma.outreachAttempt.update({ where: { id: newestOwn.id }, data: { ...reply, status: 'REPLIED' } }),
        auditRow(
          newestOwn.id,
          args.audit.action,
          `${args.audit.detail} — every message in this conversation already carried a reply, so it is written forward on the newest, replacing ${replaced} (written ${newestOwn.replyPostedAt ? newestOwn.replyPostedAt.toISOString() : 'undated'})`,
        ),
      ])
      .then(() => true, lostRace)
    return done ? { written: 'forward', attemptId: newestOwn.id } : raced(newestOwn.id)
  }

  // (d) the inbox only: no row of this pair at all — keep the lead visible on another page's row.
  if (!args.otherPage) return { written: 'none', why: 'no-row' }
  const other = await prisma.outreachAttempt.findFirst({
    where: { targetId, status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null }, repliedAt: null },
    orderBy: { sentAt: 'desc' },
    select: { id: true },
  })
  if (!other) return { written: 'none', why: 'no-row' }
  /* And the same words must not be recorded twice across pairs — on THIS branch only. */
  if (snippetIsReplyText(args.otherPage.snippet)) {
    const known = await prisma.outreachAttempt.findMany({
      where: { targetId, repliedAt: { not: null }, replyText: { not: null } },
      select: { replyText: true },
    })
    const snipNorm = normalise(args.otherPage.snippet)
    if (
      known.some((k) => {
        const kn = normalise(k.replyText ?? '')
        return kn.length > 0 && (kn.startsWith(snipNorm) || snipNorm.startsWith(kn))
      })
    ) {
      return { written: 'none', why: 'same-words-on-another-page' }
    }
  }
  const done = await prisma
    .$transaction([
      prisma.outreachAttempt.update({ where: { id: other.id, repliedAt: null }, data: { ...reply, status: 'REPLIED' } }),
      auditRow(
        other.id,
        args.audit.action,
        `${args.audit.detail} — @${senderHandle} has no message of ours in this conversation, so it is kept on another page's row to stay visible; @${senderHandle} reads its own thread before writing to them`,
      ),
    ])
    .then(() => true, lostRace)
  return done ? { written: 'other-page', attemptId: other.id } : raced(other.id)
}

// ── the scheduled sweep ─────────────────────────────────────────────────────

/**
 * Conversations worth opening, one per PAIR.
 *
 * Per pair, not per target: a session logged in as `@a` can only read `@a`'s thread, so
 * checking one sender's conversation says nothing about another's. See the module header.
 */
async function openConversations(now: Date): Promise<ConversationCandidate[]> {
  const cutoff = hoursAgo(REPLY_CHECK_MIN_HOURS, now)

  const rows = await prisma.outreachAttempt.findMany({
    where: {
      status: { in: [...DELIVERED_STATUSES] },
      repliedAt: null,
      OR: [{ replyCheckedAt: null }, { replyCheckedAt: { lt: cutoff } }],
      pair: { target: { optedOut: false }, sender: { status: 'ACTIVE' } },
    },
    include: { pair: { include: { sender: true, target: true } } },
    orderBy: [{ replyCheckedAt: { sort: 'asc', nulls: 'first' } }, { sentAt: 'asc' }],
  })

  /** Pairs that have a draft waiting — the ones we are about to write into again. */
  const waiting = new Set(
    (
      await prisma.outreachAttempt.findMany({
        where: { status: { in: ['READY', 'QUEUED'] } },
        select: { pairId: true },
      })
    ).map((a) => a.pairId),
  )

  const byPair = new Map<string, ConversationCandidate>()
  for (const a of rows) {
    // One candidate per pair — the newest delivered message in that thread.
    if (byPair.has(a.pairId)) continue
    byPair.set(a.pairId, {
      attemptId: a.id,
      pairId: a.pairId,
      senderId: a.pair.senderId,
      senderHandle: a.pair.sender.handle,
      targetId: a.pair.targetId,
      targetHandle: a.pair.target.handle,
      replyCheckedAt: a.replyCheckedAt,
      sentAt: a.sentAt,
      hasWaitingDraft: waiting.has(a.pairId),
    })
  }
  return [...byPair.values()]
}

/**
 * ── PHASE 0: SCAN EVERY INBOX BEFORE OPENING ANY THREAD (2026-08-21) ──────
 *
 * One drive per sender reads the last-message state of EVERY conversation at once,
 * where the thread loop below pays a drive per conversation and covers four per run.
 * A row where THEY wrote last and no reply is recorded becomes a recorded reply — the
 * HALT, the safety-critical half — immediately; the thread loop remains the precise
 * layer that reads full text and date separators.
 *
 * `replyPostedAt` comes from the row's own age ("41m", "2d"), so a months-old reply
 * discovered today does not halt its target for seven days from today — Tabish's rule.
 * A row with no parseable age records the reply UNDATED, which does not halt.
 */
async function inboxPhase(
  now: Date,
): Promise<{ scanned: number; recorded: number; unmatched: string[]; checkpoint: boolean }> {
  const senders = await prisma.senderAccount.findMany({
    where: { status: 'ACTIVE', fleetMember: true },
    select: { id: true, handle: true },
  })
  const local = senders.filter((s) => profileStatus(s.handle).hasSession)
  if (local.length === 0) return { scanned: 0, recorded: 0, unmatched: [], checkpoint: false }

  const targets = await prisma.targetAccount.findMany({
    where: { optedOut: false },
    select: { id: true, handle: true, displayName: true },
  })

  let recorded = 0
  const unmatched: string[] = []

  for (const sender of local) {
    if (browserShutdownRequested()) {
      log.step('the agent is stopping — ending the inbox scan between accounts')
      break
    }
    if (!(await thisMacRole()).active) {
      log.step('the sending Mac changed mid-sweep — stopping the inbox scan here, no more browsers open on this Mac')
      break
    }
    /* Everything this sender ever delivered: the bodies for the ours/theirs snippet
       insurance, and the thread URLs that identify each conversation exactly. Loaded
       BEFORE the scan because the scan asks which rows are worth opening. */
    const delivered = await prisma.outreachAttempt.findMany({
      where: { senderId: sender.id, status: { in: [...DELIVERED_STATUSES] } },
      select: { renderedBody: true, threadUrl: true, targetId: true },
    })
    const ourBodies = delivered.map((a) => a.renderedBody)
    const targetById = new Map(targets.map((t) => [t.id, t]))
    const byThreadId = new Map<string, TargetRef>()
    for (const a of delivered) {
      const id = threadIdFrom(a.threadUrl)
      const t = targetById.get(a.targetId)
      if (id && t) byThreadId.set(id, t)
    }

    /**
     * A row is opened ONLY when the name rules cannot place it AND they wrote last — the
     * rows that until now were reported for a person ("Nykaa", "Maybelline New York -
     * India", both stored under their raw handle). The click reveals `/direct/t/<id>`,
     * which `matchInboxRow` resolves against this sender's own delivered threads.
     */
    const scan = await scanInbox(sender.handle, {
      needsThread: (row) => {
        if (row.threadUrl) return false
        /* Opened on an earlier sweep: reuse the id instead of clicking the row again. */
        const remembered = resolvedRowThreads.get(`${sender.handle}|${row.displayName}`)
        if (remembered) {
          row.threadUrl = remembered
          return false
        }
        /* Only recent rows: a 13-week-old unplaced stranger is not about to become a prospect,
           and opening it every half hour would hold the fleet lock for nothing. */
        const written = row.ageText ? parseInboxAge(row.ageText) : null
        if (!written || written.getTime() < Date.now() - OPEN_ROW_MAX_AGE_MS) return false
        return triageInboxRow(row, ourBodies) === 'theirs-last' && matchInboxRowToTarget(row.displayName, targets) === null
      },
    })
    if (scan.ok) {
      if (resolvedRowThreads.size > 5000) resolvedRowThreads.clear()
      for (const row of scan.rows) if (row.threadUrl) resolvedRowThreads.set(`${sender.handle}|${row.displayName}`, row.threadUrl)
    }
    if (!scan.ok) {
      if (scan.reason === 'checkpoint') {
        await markChallenged({
          senderId: sender.id,
          handle: sender.handle,
          detail: scan.detail ?? 'checkpoint during inbox scan',
          actor: 'reply-check',
        })
        /* Do not open more sessions from a flagged estate — same rule as the thread loop. */
        return { scanned: local.indexOf(sender) + 1, recorded, unmatched, checkpoint: true }
      }
      log.warn('inbox scan unreadable — this sender contributes nothing this run', {
        sender: sender.handle,
        detail: scan.detail,
      })
      continue
    }

    /* Logged so the sweep PROVES the thread identification is live rather than assumed:
       `withThreadLink` counts rows whose conversation id was learned by opening them. */
    log.info('inbox rows read', {
      sender: sender.handle,
      rows: scan.rows.length,
      withThreadLink: scan.rows.filter((r) => threadIdFrom(r.threadUrl) !== null).length,
      knownThreads: byThreadId.size,
    })

    for (const row of scan.rows) {
      if (triageInboxRow(row, ourBodies) !== 'theirs-last') continue

      const target = matchInboxRow(row, targets, byThreadId)
      if (!target) {
        unmatched.push(`${row.displayName} (${row.folder}, ${row.ageText ?? 'no age'}) via @${sender.handle}`)
        continue
      }

      /**
       * THE ROW DESCRIBES THIS SENDER'S THREAD, so the record-again decision is made
       * against THIS PAIR's recorded replies (`shouldRecordInboxReply` — measured: the
       * target-level version re-recorded the same "sent an attachment" state on every
       * sweep, walking down the target's attempt list one row per run).
       */
      const pairReplies = await prisma.outreachAttempt.findMany({
        where: { senderId: sender.id, targetId: target.id, repliedAt: { not: null } },
        select: { replyText: true },
      })
      if (!shouldRecordInboxReply({ snippet: row.snippet, pairReplyTexts: pairReplies.map((r) => r.replyText) })) {
        continue
      }

      /* Clamped like the thread path: an inbox age is floored by Instagram ("8h" covers
         8-9 hours), which can date a reply just before the message it answers. */
      const lastSentToTarget =
        (
          await prisma.outreachAttempt.findFirst({
            where: { targetId: target.id, status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null, lte: now } },
            orderBy: { sentAt: 'desc' },
            select: { sentAt: true },
          })
        )?.sentAt ?? null
      const replyPostedAt = plausibleReplyDate({
        parsed: row.ageText ? parseInboxAge(row.ageText, now) : null,
        lastSentAt: lastSentToTarget,
        observedAt: now,
      })
      const replyText = snippetIsReplyText(row.snippet) ? row.snippet.slice(0, REPLY_TEXT_MAX) : null

      /**
       * THROUGH THE ONE WRITER (audit C2), so the inbox and the thread read cannot disagree about
       * which row a reply sits on: this pair's free delivered row, else its waiting draft
       * (superseded — this closes the hole where a draft read "fresh" less than a day ago went
       * out without a read after a new inbox reply), else written forward on this pair's newest
       * row, else — only when this page has no row in the conversation at all — another page's
       * row, so an inbound lead stays visible. An inbox row never vouches for a conversation.
       */
      const outcome = await recordReplyOnPair({
        senderId: sender.id,
        senderHandle: sender.handle,
        targetId: target.id,
        targetHandle: target.handle,
        replyText,
        writtenAt: replyPostedAt,
        now,
        vouch: false,
        callerRow: null,
        otherPage: { snippet: row.snippet },
        audit: {
          action: 'reply.record.inbox',
          detail:
            `@${target.handle} wrote last in @${sender.handle}'s inbox (${row.folder}, age ${row.ageText ?? 'unknown'}; ` +
            `written ~${replyPostedAt ? replyPostedAt.toISOString() : 'UNDATED — holds no automatic pause'})`,
        },
      })

      if (outcome.written === 'none' || outcome.written === 'other-page') {
        /**
         * THIS PAIR'S OWN ROW WAS NOT WRITTEN, so nothing on it halts — and a stamp from a read
         * less than a day ago would let its next follow-up skip the read as "fresh" and go into
         * a conversation the inbox just showed them answering. Clearing this pair's freshness
         * forces that read; the reply is then recorded on the right pair. The stamps only order
         * the sweep and feed the coverage figure, so clearing them costs nothing that guards.
         */
        const cleared = await prisma.outreachAttempt.updateMany({
          where: { senderId: sender.id, targetId: target.id, replyCheckedAt: { not: null } },
          data: { replyCheckedAt: null },
        })
        if (cleared.count > 0) {
          log.step('an inbox reply could not sit on this conversation — its next follow-up will read the thread first', {
            pair: `${sender.handle}→${target.handle}`,
            outcome: outcome.written === 'none' ? outcome.why : 'kept on another page',
          })
        }
      }
      if (outcome.written === 'none') continue

      recorded += 1
      log.info(
        outcome.written === 'other-page'
          ? "reply recorded from the inbox list on another page's row, to stay visible — this page reads its thread before writing again"
          : replyPostedAt
            ? 'reply recorded from the inbox list — this conversation is halted, counted from when they wrote'
            : 'reply recorded from the inbox list — it carries no date, so it holds no automatic pause',
        {
          target: target.handle,
          via: sender.handle,
          folder: row.folder,
          age: row.ageText ?? 'unknown',
          recordedOn: outcome.written,
          preview: (replyText ?? row.snippet).slice(0, 80),
        },
      )
    }
  }

  return { scanned: local.length, recorded, unmatched, checkpoint: false }
}

export async function checkForReplies(): Promise<ReplyCheckSummary> {
  const outcomes: ReplyCheckOutcome[] = []
  /**
   * THE SEND FLOOR COVERS THE SWEEP TOO (9 Sept 2026). A reply sweep opens a revenue account's
   * Chrome profile and drives it — the same act as a send minus the paste — and until today the
   * only thing keeping the SERVER's scheduler from doing that was the accident that the server
   * had no profiles on disk. The day the schedule moved to a Mac that DOES hold them
   * (`DS_WATCH_MODE=scheduler`, SEND_ENABLED=false pinned), its 11:00 slot swept
   * @bollywoodsocietyy, @bollywoodchronicle and @bollywoodpaparazzii while the device agent on
   * the same Mac tried to send from @bollywoodpaparazzii — three drives failed `unknown`
   * because Chrome already held the profile. Two processes on one profile is the exact thing
   * this design forbids. So a process that may not send may not sweep either; the device
   * agent (SEND_ENABLED=true, under the send lock) is the one sweeper, as it has been since
   * 19 August.
   */
  if (!env.SEND_ENABLED) {
    log.info('reply sweep refused — SEND_ENABLED is false here, and a sweep drives the same browser profiles a send does')
    return { checked: 0, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0, outcomes, inboxesScanned: 0, inboxRepliesRecorded: 0, inboxUnmatched: [] }
  }
  /**
   * THE SENDING MAC (2026-09-10). The agent's `replyPass` asks before calling here; this asks
   * again for the CLI (`pnpm ig:replies`) and re-asks BETWEEN conversations below, because a
   * sweep that took the lock a second before the switch flipped kept opening Chrome on the
   * old Mac for minutes afterwards (MEASURED: three thread reads after standby was announced).
   */
  if (!(await thisMacRole()).active) {
    log.info('reply sweep refused — this Mac is not the selected sending Mac, and a sweep drives the same browser profiles a send does')
    return { checked: 0, repliesFound: 0, unreadable: 0, incomplete: 0, deferred: 0, outcomes, inboxesScanned: 0, inboxRepliesRecorded: 0, inboxUnmatched: [] }
  }
  let checked = 0
  let repliesFound = 0
  let unreadable = 0
  let incomplete = 0
  const now = new Date()

  const inbox = await inboxPhase(now)
  if (inbox.unmatched.length > 0) {
    log.info('inbox rows where THEY wrote last and no prospect matched — a person should look', {
      count: inbox.unmatched.length,
      rows: inbox.unmatched.slice(0, 10).join(' | '),
    })
  }
  if (inbox.checkpoint) {
    return {
      checked: 0,
      repliesFound: inbox.recorded,
      unreadable: 0,
      incomplete: 0,
      deferred: 0,
      outcomes,
      inboxesScanned: inbox.scanned,
      inboxRepliesRecorded: inbox.recorded,
      inboxUnmatched: inbox.unmatched,
    }
  }

  /* Candidates are computed AFTER the scan: a reply the scan just recorded takes its
     conversation out of the thread budget, which is the whole point of the scan. A pair whose
     inbox-route door refused inside the last day is held back and COUNTED (`doorRefusals`). */
  const ordered = doorRefusals.order(prioritiseConversations(await openConversations(now)), (c) => c.pairId)
  const candidates = ordered.queue
  const doorResting = ordered.coolingOff
  if (doorResting > 0) {
    log.step('conversations resting after the inbox route could not confirm the recipient — retried after a day', {
      count: doorResting,
    })
  }

  for (const c of candidates) {
    const pairKey = `${c.senderHandle}→${c.targetHandle}`
    if (browserShutdownRequested()) {
      log.step('the agent is stopping — ending the thread reads between conversations')
      break
    }
    if (!(await thisMacRole()).active) {
      log.step('the sending Mac changed mid-sweep — stopping the thread reads here, no more browsers open on this Mac')
      break
    }

    if (checked >= MAX_REPLY_CHECKS_PER_RUN) {
      /**
       * The remaining conversations are DEFERRED, and that is reported rather than logged
       * and forgotten. At fleet size this number is the honest measure of how much of the
       * guard the sweep is actually providing — and it is why the just-in-time check
       * exists, since the ones about to be written to no longer depend on this budget.
       */
      const remaining = candidates.length - candidates.indexOf(c) + doorResting
      log.step('reply check cap reached — the rest wait for the next run or for their own send', {
        cap: MAX_REPLY_CHECKS_PER_RUN,
        deferred: remaining,
      })
      return { checked, repliesFound, unreadable, incomplete, deferred: remaining, outcomes, inboxesScanned: inbox.scanned, inboxRepliesRecorded: inbox.recorded, inboxUnmatched: inbox.unmatched }
    }

    // No hand login means no session to read with. Not a failure — nothing to do.
    if (!profileStatus(c.senderHandle).hasSession) {
      outcomes.push({ pairKey, status: 'skipped', detail: 'account not connected' })
      continue
    }

    checked += 1
    log.step('checking for a reply', { sender: c.senderHandle, target: c.targetHandle })

    const result = await checkConversation({
      senderId: c.senderId,
      senderHandle: c.senderHandle,
      targetId: c.targetId,
      targetHandle: c.targetHandle,
      fallbackAttemptId: c.attemptId,
      // The sweep's candidate is a DELIVERED message of this pair with no reply yet.
      fallbackIsDraft: false,
      now,
    })

    if (result.status === 'checkpoint') {
      unreadable += 1
      outcomes.push({ pairKey, status: 'unreadable', detail: result.detail })
      // Stop the whole run: do not open more sessions from a flagged estate.
      return {
        checked,
        repliesFound,
        unreadable,
        incomplete,
        deferred: candidates.length - candidates.indexOf(c) - 1 + doorResting,
        outcomes,
      }
    }
    if (result.status === 'unreadable') {
      unreadable += 1
      outcomes.push({ pairKey, status: 'unreadable', detail: result.detail })
      // The door refused: rest this pair a day, or it takes a budget slot every run.
      if (result.doorRefused) doorRefusals.note(c.pairId)
      continue
    }
    // Every other outcome means the door opened onto this recipient's thread — forget any
    // earlier refusal so the pair competes normally again.
    doorRefusals.clear(c.pairId)
    if (result.status === 'incomplete') {
      incomplete += 1
      outcomes.push({ pairKey, status: 'incomplete', detail: result.detail })
      continue
    }
    if (result.status === 'reply-found') {
      repliesFound += 1
      outcomes.push({ pairKey, status: 'reply-found', detail: result.replyText.slice(0, 80) })
      continue
    }
    outcomes.push({ pairKey, status: 'no-reply', detail: result.detail })
  }

  return { checked, repliesFound, unreadable, incomplete, deferred: doorResting, outcomes, inboxesScanned: inbox.scanned, inboxRepliesRecorded: inbox.recorded, inboxUnmatched: inbox.unmatched }
}

// ── the just-in-time check, before a follow-up goes out ─────────────────────

export type EnsureResult =
  /** Safe to proceed: the thread was read just now, or recently enough to vouch for. */
  | { ok: true; reason: 'fresh' | 'checked-now' }
  /**
   * Do NOT send.
   *
   * `incomplete` is separate from `unreadable` on purpose: the thread WAS read and what came
   * back provably was not all of it. Same hold, different cause, different fix.
   */
  | {
      ok: false
      reason: 'reply-found' | 'unreadable' | 'incomplete' | 'checkpoint' | 'no-session'
      detail: string
    }

/**
 * Before writing into a conversation again, make sure we know what is in it.
 *
 * ── THE GUARANTEE THE SWEEP CANNOT GIVE ───────────────────────────────────
 *
 * The sweep's capacity is a constant and the number of conversations is not, so its
 * coverage falls as the fleet grows — silently, because "no reply recorded" looks
 * identical whether we checked yesterday or never. This runs on exactly the thread the
 * message is about to land in, at the moment it matters, so coverage of what matters does
 * not depend on the fleet's size at all. It costs one read per follow-up, and the
 * dispatcher already paces those.
 *
 * FIRST TOUCHES ARE EXEMPT, and that is not a shortcut: there is no conversation to read.
 * `openAndReadThread` would navigate to a profile that has never been messaged and find
 * no thread, which is indistinguishable from an unreadable one — so it would refuse every
 * first touch forever. The reply guard has nothing to say about a message to someone we
 * have never contacted.
 *
 * FAILS CLOSED. An unreadable thread holds the send. The alternative is sending into a
 * conversation we could not read, which is exactly the case this guard exists for.
 */
export async function ensureConversationChecked(args: {
  senderId: string
  senderHandle: string
  targetId: string
  targetHandle: string
  attemptId: string
  touchNumber: number
  now?: Date
}): Promise<EnsureResult> {
  const now = args.now ?? new Date()

  if (args.touchNumber <= 1) {
    return { ok: true, reason: 'fresh' }
  }

  /**
   * Freshness is measured on THIS PAIR's thread, not on the target.
   *
   * A check made through another sender read a different conversation entirely, so it
   * cannot vouch for this one. Measuring per target here would reintroduce the exact
   * mistake the module header corrects, at the one point where it matters most.
   */
  const lastChecked = await prisma.outreachAttempt.findFirst({
    where: {
      senderId: args.senderId,
      targetId: args.targetId,
      replyCheckedAt: { not: null },
    },
    orderBy: { replyCheckedAt: 'desc' },
    select: { replyCheckedAt: true },
  })

  if (lastChecked?.replyCheckedAt && lastChecked.replyCheckedAt >= hoursAgo(REPLY_FRESHNESS_HOURS, now)) {
    return { ok: true, reason: 'fresh' }
  }

  if (!profileStatus(args.senderHandle).hasSession) {
    return {
      ok: false,
      reason: 'no-session',
      detail: `@${args.senderHandle} is not connected, so this conversation cannot be read before writing into it again`,
    }
  }

  log.step('reading the conversation before writing into it again', {
    sender: args.senderHandle,
    target: args.targetHandle,
    touch: args.touchNumber,
  })

  const result = await checkConversation({
    senderId: args.senderId,
    senderHandle: args.senderHandle,
    targetId: args.targetId,
    targetHandle: args.targetHandle,
    fallbackAttemptId: args.attemptId,
    // The waiting follow-up itself — never sent, so a reply SUPERSEDES it rather than marking it REPLIED.
    fallbackIsDraft: true,
    now,
  })

  if (result.status === 'reply-found') {
    /* The window is a Setting. Unreadable, the sentence falls back to one that names no end
       time rather than inventing one — it is prose, and the reply is already recorded. */
    const resumeHours = await getSettings().then(
      (s) => s.replyResumeHours,
      () => null,
    )
    return {
      ok: false,
      reason: 'reply-found',
      detail: replyFoundDetail({
        targetHandle: args.targetHandle,
        senderHandle: args.senderHandle,
        writtenAt: result.writtenAt,
        resumeHours,
        now,
      }),
    }
  }
  if (result.status === 'checkpoint') {
    return { ok: false, reason: 'checkpoint', detail: result.detail }
  }
  if (result.status === 'unreadable') {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `the conversation with @${args.targetHandle} could not be read (${result.detail}), so it is not written into`,
    }
  }
  /**
   * A read that provably did not see the whole thread HOLDS, exactly as an unreadable one
   * does. The conclusion "no reply" is only worth anything if the read covered the
   * conversation, and here it demonstrably did not.
   */
  if (result.status === 'incomplete') {
    return {
      ok: false,
      reason: 'incomplete',
      detail: `only part of the conversation with @${args.targetHandle} was visible (${result.detail}), so it is not written into`,
    }
  }
  if (result.status === 'no-reply') return { ok: true, reason: 'checked-now' }

  /**
   * EXHAUSTIVE ON PURPOSE, and this is not decoration.
   *
   * This function used to end with a bare `return { ok: true, reason: 'checked-now' }` for
   * everything it had not explicitly handled. Adding `'incomplete'` to `ConversationResult`
   * therefore made an incomplete read PERMIT the send — silently, in the fail-open direction,
   * with no type error, because a fall-through return is perfectly valid code.
   *
   * Caught while making that very change. A `never` binding turns "a new outcome quietly
   * permits a send" into a compile error, which is the only version of this that survives the
   * next person adding a case.
   */
  const exhaustive: never = result
  throw new Error(`unhandled conversation result: ${JSON.stringify(exhaustive)}`)
}

/**
 * PURE. What a held follow-up says about the reply that held it (audit H9).
 *
 * It said "@x has replied — outreach to them is halted and a person should take over". That was
 * false three ways: under the pair-scoped halt (Tabish, 1 Sept) only THIS page pauses; nothing
 * waits for a person since the halt released itself (2026-08-07); and an UNDATED reply — or one
 * written longer ago than the window — pauses nothing at all. The sentence is copied into the
 * dispatcher's hold reasons and rendered on `/`, so it must say what the reply actually did.
 * True in both scopes: under `target` this page is among those paused.
 */
export function replyFoundDetail(args: {
  targetHandle: string
  senderHandle: string
  writtenAt: Date | null
  /** `replyResumeHours`; null when the Setting could not be read. */
  resumeHours: number | null
  now: Date
}): string {
  const who = `@${args.targetHandle} replied to @${args.senderHandle}`
  if (args.writtenAt === null) {
    return `${who} — the reply carries no date, so no automatic pause applies; it is listed for a person`
  }
  if (args.resumeHours === null) {
    return `${who} (written ${istStamp(args.writtenAt)} IST) — this page's messages to them pause from that date, then resume on their own`
  }
  const until = new Date(args.writtenAt.getTime() + args.resumeHours * 3_600_000)
  if (until > args.now) {
    return `${who} — this page's messages to them are paused until ${istStamp(until)} IST`
  }
  return `${who} (written ${istStamp(args.writtenAt)} IST) — longer ago than the pause window, so no automatic pause applies; it is listed for a person`
}

// ── coverage, for the dashboard ─────────────────────────────────────────────

export interface ReplyCoverage {
  /** Conversations with a delivered message, no recorded reply, not retired. */
  open: number
  /** Of those, how many have never been read. */
  neverChecked: number
  /** Of those, how many were last read longer ago than the freshness window. */
  stale: number
  /** Hours since the oldest open conversation was read. `null` when all are fresh. */
  oldestHours: number | null
}

/**
 * How much of the guard is actually in force.
 *
 * On screen because the failure being guarded against is invisible by construction: an
 * unchecked conversation and a checked-and-silent one look identical everywhere else in
 * the system. A number that quietly falls as the fleet grows is exactly the kind this
 * project keeps discovering after the fact.
 */
export async function replyCoverage(now: Date = new Date()): Promise<ReplyCoverage> {
  const floor = hoursAgo(REPLY_FRESHNESS_HOURS, now)

  const rows = await prisma.outreachAttempt.findMany({
    where: {
      status: { in: [...DELIVERED_STATUSES] },
      repliedAt: null,
      pair: { target: { optedOut: false } },
    },
    select: { pairId: true, replyCheckedAt: true },
    orderBy: { replyCheckedAt: { sort: 'desc', nulls: 'last' } },
  })

  // Newest check per pair — a conversation is as fresh as its most recent read.
  const byPair = new Map<string, Date | null>()
  for (const r of rows) if (!byPair.has(r.pairId)) byPair.set(r.pairId, r.replyCheckedAt)

  let neverChecked = 0
  let stale = 0
  let oldest: Date | null = null
  for (const checkedAt of byPair.values()) {
    if (checkedAt === null) {
      neverChecked += 1
      continue
    }
    if (checkedAt < floor) stale += 1
    if (oldest === null || checkedAt < oldest) oldest = checkedAt
  }

  return {
    open: byPair.size,
    neverChecked,
    stale,
    oldestHours: oldest === null ? null : Math.floor((now.getTime() - oldest.getTime()) / 3_600_000),
  }
}
