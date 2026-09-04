import { prisma } from '@/lib/db'
import { memoView, viewKey } from '@/lib/viewMemo'
import { DELIVERED_STATUSES } from '@/lib/constants'
// ONE relative-time wording for the whole dashboard. See the docblock in lib/time.ts.
import { relativeLabel as relative } from '@/lib/time'
import { replyCoverage } from '@/outreach/replyCheck'
// The halt's OWN arithmetic — never a second copy. See replyHalt.ts.
import { replyHaltFloor } from '@/outreach/replyHalt'
import { getSettings } from '@/lib/settings'
import { profileUrl } from '@/lib/urls'
// Never a raw `displayName` — see the note on the import in `view-model.ts`.
import { operatorName } from '@/outreach/render'
// ONE mapping of a reply row, shared with Today's headline. See the docblock there.
import { toReplyCards, type ReplyCard } from '../view-model'

/**
 * `/conversations` — who replied, who is mid-conversation, and how current our picture is.
 *
 * ── WHY THIS IS ITS OWN PAGE (step D) ───────────────────────────────────────
 *
 * Two things were wrong and they were the same thing twice.
 *
 * The reply card lived on `/`, so the same reply appeared THREE times on one screen: in the
 * health headline, as a card with its text and buttons, and again as a row in "What happened".
 * A reply is the only event in this system that represents revenue, and repeating it three
 * times is how it stops being read.
 *
 * And reply COVERAGE lived inside the dispatcher's pace panel on `/messages`, next to the
 * fleet's hourly allowance. It is not a pacing number. It answers "how much of our picture of
 * these conversations is current", which is the question this page exists for.
 *
 * ── WHAT AN OPEN CONVERSATION IS, AND WHY THE SUMMARY IS NOT COMPUTED HERE ──
 *
 * `replyCoverage()` in `replyCheck.ts` already defines it — delivered, not yet replied to, the
 * recipient not retired, deduplicated per PAIR. This page calls that function rather than
 * counting rows itself. Instagram DMs are per account PAIR, and the sweep learned that the hard
 * way: a check through @a cannot see a reply sent to @b, and counting per TARGET recorded
 * verified silence for conversations nobody had read. A second definition here would be a
 * second chance to get that wrong.
 */

export interface OpenConversation {
  targetHandle: string
  targetName: string
  senderHandle: string
  /** How many we have delivered into this thread. */
  sentCount: number
  lastSentLabel: string
  /**
   * When this PAIR's thread was last actually read, or null for never.
   *
   * Null is a distinct fact and renders as one. `repliedAt == null` alone cannot tell "they
   * have not answered" from "nobody has ever looked", and for the first two days of this
   * system's life every conversation was the second while the dashboard showed the first.
   */
  lastReadLabel: string | null
  /**
   * There is deliberately no `stale` flag.
   *
   * The first version had one, computed against a hardcoded 24 hours — a second copy of a bound
   * that `REPLY_FRESHNESS_HOURS` already owns, which is how the page and the guard come to
   * disagree about what "recent" means. Nothing rendered it in the end either, and a field
   * nothing reads is worse than an absent one: `SEND_JITTER_MIN/MAX_SECONDS` were parsed,
   * range-checked, cross-validated and documented, and read by nothing at all.
   *
   * The aggregate stale count comes from `replyCoverage()`, which uses the real bound.
   */
  profileUrl: string
}

export interface ConversationsPageView {
  /** Replies waiting for a person. `replyHandledAt: null` is the whole point. */
  replies: ReplyCard[]
  open: OpenConversation[]
  coverage: Awaited<ReturnType<typeof replyCoverage>>
  /** Delivered messages, newest first — the history of every conversation. */
  recent: {
    id: string
    senderHandle: string
    targetHandle: string
    sentAt: Date | null
    sentBy: string | null
    threadUrl: string | null
    replied: boolean
    replyHandled: boolean
    replyText: string | null
  }[]
}

export async function buildConversationsPage(): Promise<ConversationsPageView> {
  const settings = await getSettings()
  const [unhandled, delivered, coverage] = await Promise.all([
    /**
     * Replies that are ACTIVELY HOLDING their recipient — the cards on `/`.
     *
     * ── THE WINDOW IS WHAT DISMISSES THE CARD NOW (2026-08-25) ────────────────
     *
     * This was `repliedAt: { not: null }, replyHandledAt: null` — every unhandled reply ever,
     * with no reference to the halt at all. That was survivable only while the card carried an
     * "I have replied" button to set that column. Both buttons were removed on Tabish's
     * instruction, so `replyHandledAt` is never written again and an unwindowed list would be a
     * notification with NO WAY OUT — the exact failure the original version of this query was
     * written to fix, arriving from the other end.
     *
     * So it now matches the enforcers exactly: `replyPostedAt >= replyHaltFloor(...)`, the same
     * filter `gate.ts`, `plan.ts` and `onDemand.ts` use. A card is on screen if and only if the
     * fleet is actually being held, and it leaves by itself when the fleet resumes. It also
     * keys on the WRITTEN clock, so a reply the sweep discovered late is counted from when the
     * person wrote it — and an undatable reply (`replyPostedAt: null`) never matches a `gte`,
     * which is correct: it does not halt, so it must not claim a hold.
     *
     * `nav.tsx`'s badge and `rest-tally.ts` were already windowed this way; this query was the
     * one that was not, so the count in the sidebar and the list under it would have started
     * disagreeing on 26 August, the day the first halt expires.
     */
    prisma.outreachAttempt.findMany({
      where: { replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
      include: { pair: { include: { sender: true, target: true } } },
      orderBy: { repliedAt: 'desc' },
    }),
    prisma.outreachAttempt.findMany({
      where: { status: { in: [...DELIVERED_STATUSES] } },
      include: { sender: { select: { handle: true } }, target: true, pair: { select: { id: true } } },
      orderBy: { sentAt: { sort: 'desc', nulls: 'last' } },
      take: 60,
    }),
    replyCoverage(),
  ])

  /**
   * Open conversations, per PAIR.
   *
   * Per pair and not per target, matching `replyCoverage` and matching Instagram: a session
   * logged in as @a can only read @a's thread. Deduplicating per target is what let a reply
   * sent to @b be recorded as verified silence, and rotation makes that the normal case since
   * spreading senders across one recipient is the entire point.
   */
  const byPair = new Map<string, OpenConversation & { lastSentAt: Date | null }>()
  for (const a of delivered) {
    if (a.repliedAt !== null) continue
    if (a.target.optedOut) continue
    const existing = byPair.get(a.pair.id)
    if (existing) {
      existing.sentCount += 1
      continue
    }
    byPair.set(a.pair.id, {
      targetHandle: a.target.handle,
      targetName: operatorName(a.target.displayName),
      senderHandle: a.sender.handle,
      sentCount: 1,
      lastSentAt: a.sentAt,
      lastSentLabel: relative(a.sentAt),
      lastReadLabel: a.replyCheckedAt === null ? null : relative(a.replyCheckedAt),
      profileUrl: profileUrl(a.target.handle),
    })
  }

  const open = [...byPair.values()]
    // Never-read first, then stalest. The same ordering `prioritiseConversations` uses for the
    // sweep's budget: the conversation where a missed reply does damage is the one about to be
    // written into, and fairness is the wrong criterion for a safety signal.
    .sort((a, b) => {
      if ((a.lastReadLabel === null) !== (b.lastReadLabel === null)) return a.lastReadLabel === null ? -1 : 1
      return (a.lastSentAt?.getTime() ?? 0) - (b.lastSentAt?.getTime() ?? 0)
    })
    .map(({ lastSentAt: _drop, ...rest }) => rest)

  return {
    replies: toReplyCards(unhandled, settings.replyResumeHours),
    open,
    coverage,
    recent: delivered.map((a) => ({
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
  }
}
