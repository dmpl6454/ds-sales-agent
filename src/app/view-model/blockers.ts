import type { Remedy } from '../messages/remedy'

/**
 * WHAT IS STOPPING IT — ranked by what cannot be recovered.
 *
 * This is the answer to the only question the landing page asks. It is a PURE function so
 * the ORDERING is testable, because the ordering is the whole idea and it is not obvious:
 *
 *   1. WATCH HEALTH   a post that scrolls out of the anonymous feed can never be
 *                     re-scraped by anyone. No endpoint hands it back. It is the only
 *                     unrecoverable item on this page.
 *   2. FLEET HALT     a pause, or the circuit breaker. Recoverable, but it is the only
 *                     other item that stops EVERYTHING — so a held draft must never be
 *                     listed above the reason every draft is going nowhere.
 *   3. REPLIES        a person is waiting on a human. Recoverable, but the cost of being
 *                     late is borne by the one prospect who actually engaged.
 *   4. DRAFTS         written and held. Nothing is lost by waiting; the material is
 *                     stored and the Send button still works.
 *
 * Rank 4 used to be UNCERTAIN — a send Instagram accepted that never appeared, waiting
 * "forever until someone looks". Tabish removed the section that let anyone look
 * (2026-08-24), so an alarm about it could only point at a screen that cannot answer it.
 *
 * `assessWatch`'s own docblock records why watch health sits at the top, and the copy here
 * repeats its warning that THIS IS NOT ABOUT SENDING — the previous wording lived inside
 * the autopilot card and ended "whatever this toggle says", so with autopilot correctly
 * OFF the most serious alarm in the system read as irrelevant to a reader.
 *
 * ── IT NEVER WRITES A VERDICT OF ITS OWN ────────────────────────────────────
 *
 * Every `verdict` string handed to this function comes from the thing that ENFORCES it —
 * `assessWatch` for the window, `recheckBeforeSend` for a held draft. This function ranks
 * and frames; it does not judge. A page that computes its own version of a refusal is how
 * `/messages` came to render "Clear to send" over a draft the dispatcher then held
 * forever, for a reason that had been deleted from `REMEDIES` and appeared on no screen.
 */

export type BlockerTone = 'bad' | 'warn' | 'idle'

export interface Blocker {
  key: string
  /** The category, in the operator's words. Rendered as a fixed-width eyebrow. */
  rank: string
  /** One line: what is true right now. */
  headline: string
  /** Why, from whichever guard decided it. Never composed here. */
  verdict: string
  /** Where to go. `null` when the answer is "read this and decide", with nowhere to click. */
  remedy: { label: string; href: string } | null
  tone: BlockerTone
}

export interface BlockerInput {
  watch: {
    severity: 'ok' | 'at-risk' | 'losing-posts'
    neverRun: boolean
    postsLost: number
    downtimeHours: number
    survivalHours: number
  }
  /**
   * The fleet-wide circuit breaker, in its own words, or null when it is closed.
   *
   * Any account challenged in the last 24 hours halts the WHOLE fleet: all senders drive
   * one code path from one residential IP, so a checkpoint is evidence about the pattern
   * rather than about the account. A rising `not-in-thread` rate trips it too.
   */
  breaker: { reason: string } | null
  /** A person pressed pause, and who. Null when nobody has. */
  pausedBy: { at: string; by: string; reason?: string } | null
  /** Replies waiting for a person to take over. */
  repliesWaiting: number
  /** Drafts written and waiting. */
  draftsWaiting: number
  /**
   * The refusal the gate gave for the drafts that are held, and how many share it.
   *
   * Only the most common one is surfaced here: the point of this list is "what should I
   * fix first", and eleven copies of "no session" is one problem, not eleven.
   */
  topRefusal: { detail: string; count: number; remedy: Remedy | null } | null
}

export function rankBlockers(input: BlockerInput): Blocker[] {
  const out: Blocker[] = []

  /* ── 1. the only unrecoverable thing on the page ────────────────────────── */
  if (input.watch.neverRun) {
    out.push({
      key: 'watch',
      rank: 'Watch health',
      headline: 'The watch has never run on this machine',
      verdict:
        'Nothing has been read, so no estimate of what has been missed is possible. This is not about sending — it is about posts that can never be fetched again.',
      remedy: { label: 'See the window on Analytics', href: '/analytics' },
      tone: 'bad',
    })
  } else if (input.watch.severity === 'losing-posts') {
    out.push({
      key: 'watch',
      rank: 'Watch health',
      headline:
        input.watch.postsLost > 0
          ? `A ${hours(input.watch.downtimeHours)} gap has lost about ${input.watch.postsLost} posts for good`
          : `The watch has been down ${hours(input.watch.downtimeHours)}, past the window`,
      verdict: `Anything older than about ${input.watch.survivalHours} hours has scrolled out of the anonymous feed and can never be re-read. This is not about sending.`,
      remedy: { label: 'See the window on Analytics', href: '/analytics' },
      tone: 'bad',
    })
  } else if (input.watch.severity === 'at-risk') {
    out.push({
      key: 'watch',
      rank: 'Watch health',
      headline: `The watch has been down ${hours(input.watch.downtimeHours)} — still recoverable`,
      verdict: `Everything missed so far is still inside the ${input.watch.survivalHours}-hour feed window, so one pass gets it all back. That stops being true when the window closes.`,
      remedy: { label: 'See the window on Analytics', href: '/analytics' },
      tone: 'warn',
    })
  }

  /* ── 2. the whole fleet is halted ───────────────────────────────────────────
     Recoverable, so it sits below watch health — but it is the only other item that
     stops EVERYTHING, so it sits above everything else. A breaker trip with three
     drafts listed above it would bury the reason all three are going nowhere.        */
  if (input.pausedBy) {
    out.push({
      key: 'paused',
      rank: 'Paused',
      headline: `Sending was paused by ${input.pausedBy.by}`,
      verdict: input.pausedBy.reason
        ? `Paused at ${input.pausedBy.at}. Reason given: ${input.pausedBy.reason}`
        : `Paused at ${input.pausedBy.at}. No reason was recorded.`,
      remedy: null,
      tone: 'warn',
    })
  }

  if (input.breaker) {
    out.push({
      key: 'breaker',
      rank: 'Fleet halt',
      headline: 'Every account is halted, not just one',
      // The breaker's own sentence. It explains which of its two signals tripped.
      verdict: input.breaker.reason,
      remedy: { label: 'See the accounts', href: '/senders' },
      tone: 'bad',
    })
  }

  /* ── 3. someone is waiting on a person ──────────────────────────────────── */
  if (input.repliesWaiting > 0) {
    out.push({
      key: 'replies',
      rank: 'Replies',
      headline:
        input.repliesWaiting === 1
          ? 'One recipient replied and is on hold'
          : `${input.repliesWaiting} recipients replied and are on hold`,
      verdict:
        'A reply pauses every account writing to that recipient for seven days, then messaging resumes by itself. Nothing needs pressing — the reply is kept either way.',
      remedy: null,
      tone: 'warn',
    })
  }

  /*
    ── 4. WAS "UNCERTAIN", AND IS GONE (2026-08-24, Tabish) ──────────────────

    This rank held "N sends were accepted and never appeared … only a person looking at the
    conversation settles it" — a sentence naming a control that no longer exists, now that the
    "Check the conversation" section and its two buttons have been removed. An alarm pointing at
    a screen that cannot answer it is worse than no alarm: it is the "a page reporting a rule by
    a different rule than the one enforcing it" failure, in the one list that claims to say what
    to fix first. The rows still exist in `FAILED` and still block their own route at the gate;
    what is gone is the demand that somebody open eighteen Instagram conversations.
  */
  /* ── 5. nothing is lost by this one, which is why it is last ────────────── */
  if (input.draftsWaiting > 0 && input.topRefusal) {
    out.push({
      key: 'drafts',
      rank: 'Drafts',
      headline:
        input.topRefusal.count === input.draftsWaiting
          ? `${plural(input.draftsWaiting, 'draft is', 'drafts are')} written and held`
          : `${input.topRefusal.count} of ${input.draftsWaiting} held drafts share one reason`,
      // VERBATIM from the gate. Not re-worded, not summarised, not shortened.
      verdict: input.topRefusal.detail,
      remedy:
        input.topRefusal.remedy && input.topRefusal.remedy.href
          ? { label: input.topRefusal.remedy.label, href: input.topRefusal.remedy.href }
          : null,
      tone: 'idle',
    })
  }

  return out
}

/**
 * The sentence above the list, and the empty state.
 *
 * "Nothing is stopping it" is only true if autopilot is actually ON — with the switch off,
 * an empty blocker list means every OTHER condition is clear, which is a different and much
 * weaker claim. Collapsing the two would put "nothing is stopping it" above a fleet that
 * cannot send a single message, which is the exact shape of failure this page exists to
 * prevent.
 */
export function blockersSummary(blockers: Blocker[], autopilotOn: boolean): string {
  if (blockers.length === 0) {
    return autopilotOn
      ? 'Nothing is stopping it. Messages go out under the pace below.'
      : 'Every check below is clear. Autopilot itself is off, so nothing goes out on its own.'
  }
  const worst = blockers[0]
  return worst?.tone === 'bad'
    ? 'Ranked by what cannot be recovered. The first one is losing something permanently.'
    : 'Ranked by what cannot be recovered. A missed post is gone for good; a held draft is not.'
}

function hours(h: number): string {
  const n = Math.round(h)
  return n === 1 ? '1 hour' : `${n} hours`
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`
}
