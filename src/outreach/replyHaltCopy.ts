import type { ReplyHaltScope } from './replyHalt'

/**
 * EVERY SENTENCE A SCREEN SAYS ABOUT A REPLY HALT — one owner, both scopes (audit H9, 2026-10-09).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Tabish chose the PAIR scope on 2026-09-01 (replyHalt.ts records the risk he was shown): a reply
 * pauses only the page that got it, and rotation hands the turn to the recipient's other pages.
 * The gate, the planner, rotation and the on-demand dialog all enforce that through
 * `replyHaltWhere`. The screens did not: /rules said a reply "halts every account writing to that
 * recipient", the landing page said "every account writing to them is paused, not just the one they
 * answered", the alarm said "outreach to them is paused", /targets said "messaging pauses for seven
 * days" on the same row that named the next page writing to them. Every one of those described the
 * scope he had replaced — a screen reporting a rule by a different rule than the one enforcing it,
 * which is this project's most-repeated defect — and every one hard-coded "seven days" while the
 * window is a Setting (`replyResumeHours`).
 *
 * So each sentence is a function of the scope and the window, written ONCE, here.
 * `tests/reply-halt-screens.test.ts` fails if a fleet-wide reply phrase appears in any other file
 * under src/app or src/outreach.
 *
 * ── THE DIRECTION OF THE FALLBACK ───────────────────────────────────────────
 *
 * Any scope other than `pair` gets the WIDER sentence, matching `parseReplyHaltScope` (an
 * unreadable value reads as `target`). A screen may never claim a narrower halt than the gate
 * enforces.
 *
 * PURE, and `import type` only: `prospects/list.tsx` and the blockers card are client components,
 * and a runtime import that reaches the database from here is the `waiting.tsx -> gate.ts ->
 * better-sqlite3` trap that returned HTTP 500 on every route. Dates arrive formatted for the same
 * reason (`lib/time.ts` imports the env).
 */

const DAY_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/**
 * How long a reply pauses, in words — TOTAL over every value the Setting accepts (any whole number
 * of hours ≥ 1, no upper bound): whole days 1–10 in words, larger whole days in digits, anything
 * else in hours, with the singular handled. Never a literal "seven days".
 */
export function replyHaltSpan(hours: number): string {
  if (hours > 0 && hours % 24 === 0) {
    const d = hours / 24
    if (d <= DAY_WORDS.length) return `${DAY_WORDS[d - 1]} ${d === 1 ? 'day' : 'days'}`
    return `${d} days`
  }
  return hours === 1 ? '1 hour' : `${hours} hours`
}

/** Does a reply under this scope stop EVERY page? True for anything but `pair` — see the fallback note. */
export function replyBlocksEveryPage(scope: ReplyHaltScope | string): boolean {
  return scope !== 'pair'
}

/** The rule in one sentence — /rules, and the "what is stopping it" verdict. */
export function replyHaltRule(scope: ReplyHaltScope | string, hours: number): string {
  const span = replyHaltSpan(hours)
  return replyBlocksEveryPage(scope)
    ? `A reply pauses every one of our pages writing to that recipient for ${span}, counted from when they wrote, then messaging resumes by itself.`
    : `A reply pauses only the page it was sent to, for ${span} counted from when they wrote, then that page resumes by itself. Our other pages may still write to them in rotation meanwhile.`
}

/** The landing page's alarm headline when replies are waiting. */
export function replyAlarmHeadline(scope: ReplyHaltScope | string, r: { count: number; name: string }): string {
  if (replyBlocksEveryPage(scope)) {
    return r.count === 1 ? `${r.name} replied — outreach to them is paused` : `${r.count} recipients replied — outreach to them is paused`
  }
  return r.count === 1
    ? `${r.name} replied — the page they answered is paused`
    : `${r.count} recipients replied — the pages they answered are paused`
}

/**
 * One reply in the activity feed. THREE states, not two: an UNDATED reply (`replyPostedAt` null)
 * halts nothing at all (replyHalt.ts, Tabish's rule), so "the pause has since released" would be
 * a sentence about a pause that never happened.
 */
export function replyFeedSentence(
  scope: ReplyHaltScope | string,
  r: { target: string; senderHandle: string; state: 'holding' | 'released' | 'undated'; hours: number },
): string {
  switch (r.state) {
    case 'holding':
      return replyBlocksEveryPage(scope)
        ? `${r.target} replied — all outreach to them is on hold`
        : `${r.target} replied to @${r.senderHandle} — that page is paused`
    case 'released':
      return `${r.target} replied — the ${replyHaltSpan(r.hours)} pause has since released`
    case 'undated':
      return `${r.target} replied — the reply carries no date, so no automatic pause applied`
  }
}

/** The line under "They replied — paused" on the landing page. */
export function replyLede(scope: ReplyHaltScope | string): string {
  return replyBlocksEveryPage(scope)
    ? 'Every account writing to them is paused, not just the one they answered.'
    : 'Only the page they answered is paused. Our other pages may still write to them in rotation.'
}

/** The "Replies" item in "what is stopping it". */
export function replyBlockerCopy(
  scope: ReplyHaltScope | string,
  n: number,
  hours: number,
): { headline: string; verdict: string } {
  const headline = replyBlocksEveryPage(scope)
    ? n === 1
      ? 'One recipient replied and is on hold'
      : `${n} recipients replied and are on hold`
    : n === 1
      ? 'One recipient replied — the page they answered is paused'
      : `${n} recipients replied — the pages they answered are paused`
  return { headline, verdict: `${replyHaltRule(scope, hours)} Nothing needs pressing — the reply is kept either way.` }
}

/**
 * The reply line on a /targets row. Null when nothing holds them.
 *
 * Under `pair` it names WHICH pages are paused, and says the other pages may still write ONLY when
 * that row's own turn says a page will (`nextWillWrite`) — with a one-page ring, or every other
 * page parked or signed out, the same row prints "Nothing will be written", and a constant clause
 * would contradict it.
 */
export function prospectReplyNote(
  scope: ReplyHaltScope | string,
  replies: { senderHandles: readonly string[]; freesIst: string } | null,
  nextWillWrite: boolean,
): string | null {
  if (replies === null) return null
  if (replyBlocksEveryPage(scope)) {
    return `They replied — every one of our pages is paused until ${replies.freesIst} IST, then messaging resumes on its own.`
  }
  const pages = replies.senderHandles.map((h) => `@${h}`)
  const named = pages.length <= 1 ? (pages[0] ?? 'this page') : `${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`
  const verb = pages.length <= 1 ? 'that page is' : 'those pages are'
  return `They replied to ${named} — ${verb} paused until ${replies.freesIst} IST${nextWillWrite ? '; our other pages may still write to them' : ''}.`
}

/** Under `target` scope, /targets must not name a next page: every page is held until the reply frees. */
export function prospectTargetHaltSentence(freesIst: string): string {
  return `Nothing is written to them until ${freesIst} IST — they replied, and a reply pauses every page.`
}

/**
 * The gate's TARGET_REPLIED detail — shown on / through the dispatcher's hold reasons. True in BOTH
 * scopes: under `target` this page is among those paused.
 */
export function replyHeldDetail(isoWritten: string): string {
  return `they replied (written ${isoWritten}) — this page's messages to them pause from that date, then resume on their own`
}

/** Why rotation passes over a page a recipient replied to (route blockers, pair scope only). */
export function replyRouteReason(hours: number): string {
  return `they replied to this page, so it is holding for ${replyHaltSpan(hours)}`
}

/** The queue's held-row sentence for a reply-held draft. */
export function replyQueueHold(scope: ReplyHaltScope | string, hours: number): string {
  return replyBlocksEveryPage(scope)
    ? `they replied — resumes on its own ${replyHaltSpan(hours)} after they wrote`
    : `they replied to this page — it resumes on its own ${replyHaltSpan(hours)} after they wrote`
}

/**
 * The resting tally's TARGET_REPLIED bucket. Under `pair` a company lands there only when EVERY
 * page in its rotation is reply-paused (rest-tally.ts), so that is what it says.
 */
export function restReplyLabel(scope: ReplyHaltScope | string, hours: number): string {
  const span = replyHaltSpan(hours)
  return replyBlocksEveryPage(scope)
    ? `they replied — every one of our pages pauses for ${span} from the date they wrote, then resumes on its own`
    : `they replied to every page in their rotation — the first of them resumes ${span} after they wrote to it`
}
