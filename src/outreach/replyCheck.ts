import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { hoursAgo } from '@/lib/time'
import { profileStatus } from './browser/profile'
import { openAndReadThread } from './browser/readThread'
import { normalise } from './matching'
import { markChallenged } from './challenge'

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
 * The HALT stays per target: a reply to any sender stops them all. That was always right,
 * and it is the conservative direction.
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
  | { status: 'reply-found'; replyText: string }
  | { status: 'no-reply'; detail?: string }
  | { status: 'unreadable'; detail: string }
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
  /** Where a reply lands if no better row exists. Normally the attempt that surfaced it. */
  fallbackAttemptId: string
  now?: Date
}): Promise<ConversationResult> {
  const { senderId, senderHandle, targetId, targetHandle, fallbackAttemptId } = args
  const now = args.now ?? new Date()

  /**
   * Everything we have ever put in front of this recipient, from EVERY sender.
   *
   * Kept fleet-wide even though a thread only holds one sender's messages: it can only
   * make "not ours" a stricter test, and a body that appears in two threads (the same
   * variant reused) must never be read back as the recipient's words.
   */
  const ourBodies = (
    await prisma.outreachAttempt.findMany({
      where: { targetId, status: { in: [...DELIVERED_STATUSES] } },
      select: { renderedBody: true },
    })
  ).map((a) => a.renderedBody)

  let result
  try {
    result = await openAndReadThread(senderHandle, targetHandle, ourBodies)
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

  if (!result.ok) {
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
  if (result.url.includes('/direct/t/')) {
    await prisma.outreachAttempt
      .updateMany({
        where: { senderId, targetId, status: { in: [...DELIVERED_STATUSES] }, threadUrl: null },
        data: { threadUrl: result.url },
      })
      .catch(() => undefined)
  }

  const theirs = result.messages.filter((m) => !m.ours)

  /**
   * Only messages we have NOT already recorded count as a new reply.
   *
   * A thread holds the whole conversation, so `theirs.length > 0` is true forever once
   * someone answers even once. Recording on that alone meant every subsequent check
   * re-detected the SAME old message as fresh — re-halting outreach seconds after an
   * operator pressed "I have replied", making that button useless and the halt genuinely
   * inescapable again.
   *
   * Compared on normalised text against every reply already stored for this target,
   * HANDLED ONES INCLUDED: the whole point of handling one is that it stops counting, and
   * dropping it from the comparison would resurrect it.
   */
  const knownReplies = (
    await prisma.outreachAttempt.findMany({
      where: { targetId, replyText: { not: null } },
      select: { replyText: true },
    })
  ).map((r) => normalise(r.replyText!))

  /**
   * Replies recorded before `replyText` existed carry no text, cannot take part in the
   * comparison above, and would therefore be re-detected forever. The first read that can
   * see the thread BACKFILLS them and records nothing new — self-healing, and the safe
   * direction, because the existing halt is left standing.
   */
  const textless = await prisma.outreachAttempt.findMany({
    where: { targetId, repliedAt: { not: null }, replyText: null },
    orderBy: { repliedAt: 'desc' },
  })

  if (textless.length > 0 && theirs.length > 0) {
    await prisma.outreachAttempt.update({
      where: { id: textless[0]!.id },
      data: { replyText: theirs[theirs.length - 1]!.text.slice(0, 2000), replyCheckedAt: now },
    })
    log.step('backfilled reply text on an older record — nothing new recorded', {
      target: targetHandle,
      attemptId: textless[0]!.id,
    })
    return { status: 'no-reply', detail: 'backfilled text on an existing reply' }
  }

  const fresh = theirs.filter((m) => !knownReplies.includes(normalise(m.text)))

  if (fresh.length === 0) {
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
   * A NEW reply. Attached to the LATEST delivered attempt for this target rather than the
   * row that surfaced it — the reply answers the most recent thing we said, and attaching
   * it to an older attempt made the dashboard read "messaged 3 Aug / replied 31 Jul" as
   * though the conversation ran backwards.
   */
  const latest = await prisma.outreachAttempt.findFirst({
    where: { targetId, status: { in: [...DELIVERED_STATUSES] } },
    orderBy: { sentAt: 'desc' },
  })
  /**
   * Never overwrite a row that already carries a reply. If the newest delivered attempt
   * has one, the new message belongs on the row that surfaced it — otherwise a second
   * reply silently replaces the record of the first, destroying history in the one table
   * that exists to preserve it.
   */
  const attachToId = latest && latest.repliedAt === null ? latest.id : fallbackAttemptId

  // The thread exposes no machine-readable per-bubble timestamp without more scraping
  // than it is worth, so this is when we OBSERVED it, not when they wrote it.
  // `pnpm ig:reply <sender> <target> --at <ISO>` corrects it.
  const replyText = fresh[fresh.length - 1]!.text.slice(0, 2000)

  await prisma.$transaction([
    prisma.outreachAttempt.update({
      where: { id: attachToId },
      data: { repliedAt: now, status: 'REPLIED', replyText, replyCheckedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        actor: 'reply-check',
        action: 'reply.record.auto',
        entity: `OutreachAttempt:${attachToId}`,
        detail: `@${targetHandle} replied to @${senderHandle} (observed ${now.toISOString()}; time is observation, not the reply itself)`,
      },
    }),
  ])

  log.info('reply detected — outreach to this target is halted', {
    target: targetHandle,
    via: senderHandle,
    preview: replyText.slice(0, 80),
  })
  return { status: 'reply-found', replyText }
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

export async function checkForReplies(): Promise<ReplyCheckSummary> {
  const outcomes: ReplyCheckOutcome[] = []
  let checked = 0
  let repliesFound = 0
  let unreadable = 0
  let incomplete = 0
  const now = new Date()

  const candidates = prioritiseConversations(await openConversations(now))

  for (const c of candidates) {
    const pairKey = `${c.senderHandle}→${c.targetHandle}`

    if (checked >= MAX_REPLY_CHECKS_PER_RUN) {
      /**
       * The remaining conversations are DEFERRED, and that is reported rather than logged
       * and forgotten. At fleet size this number is the honest measure of how much of the
       * guard the sweep is actually providing — and it is why the just-in-time check
       * exists, since the ones about to be written to no longer depend on this budget.
       */
      const remaining = candidates.length - candidates.indexOf(c)
      log.step('reply check cap reached — the rest wait for the next run or for their own send', {
        cap: MAX_REPLY_CHECKS_PER_RUN,
        deferred: remaining,
      })
      return { checked, repliesFound, unreadable, incomplete, deferred: remaining, outcomes }
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
        deferred: candidates.length - candidates.indexOf(c) - 1,
        outcomes,
      }
    }
    if (result.status === 'unreadable') {
      unreadable += 1
      outcomes.push({ pairKey, status: 'unreadable', detail: result.detail })
      continue
    }
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

  return { checked, repliesFound, unreadable, incomplete, deferred: 0, outcomes }
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
    now,
  })

  if (result.status === 'reply-found') {
    return {
      ok: false,
      reason: 'reply-found',
      detail: `@${args.targetHandle} has replied — outreach to them is halted and a person should take over`,
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
