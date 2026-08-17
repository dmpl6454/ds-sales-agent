import { RESEND_BLOCKS } from '@/outreach/gate'

/**
 * ── WHAT TO DO ABOUT A REFUSAL ──────────────────────────────────────────────
 *
 * The gate says WHY a draft cannot be sent, in its own words. This says WHERE to fix it.
 *
 * The split is deliberate and it is the only reason this file exists separately. The verdict
 * and its sentence come wholly from `recheckBeforeSend` — a page that worked out "this cannot
 * send" for itself could disagree with the rule actually refusing, which is the mistake
 * `checkPersonaDistinct` was extracted to prevent and that `MAX_TOTAL_SENDS` made for two
 * silent days. But *which screen has the control* is not a rule about sending at all; it is a
 * fact about this dashboard's layout, and the gate must not know it.
 *
 * So: never re-derive the verdict here, and never put a reason sentence here either. Only the
 * destination.
 *
 * ── A MISSING REMEDY IS A REAL ANSWER ───────────────────────────────────────
 *
 * `href: null` means *there is no control, and that is correct* — a daily cap clears by
 * waiting, and a retired channel is meant to stay unreachable. It is NOT a gap to be filled in
 * later. In particular the two caps deliberately do NOT link to `/settings`: the knob exists
 * there, and offering "raise the cap" as the remedy for hitting a cap is the one thing the
 * project's top rule forbids — *never raise volume to make something work*.
 *
 * Every value of `RESEND_BLOCKS` must appear below. `tests/stopInventory.test.ts` fails
 * otherwise, so a new stop cannot be added without someone deciding what an operator does
 * about it — which is the whole premise of the inventory: every refusal is a sentence on a
 * screen, and a screen with no way forward is where an operator gives up.
 */
export const REMEDIES = {
  [RESEND_BLOCKS.NO_SESSION]: { href: '/senders', label: 'Sign this account in' },
  [RESEND_BLOCKS.SENDER_NOT_ACTIVE]: { href: '/senders', label: 'Look at this account' },
  [RESEND_BLOCKS.PERSONA_NOT_DISTINCT]: { href: '/senders', label: 'Give this account its own identity' },
  [RESEND_BLOCKS.COHORT_NOT_CLEARED]: { href: '/senders', label: 'See where this account is in the queue' },

  /**
   * Wherever the reply card and its "I have replied" button actually live — which is a fact
   * about this dashboard's layout, and precisely the kind of fact `gate.ts` must not hold.
   * Step D moved it from `/` to `/conversations`, and this line moved with it.
   *
   * Note this stop IS crossable — deliberately, by Tabish on 2026-08-03, so the on-demand
   * dialog can reach someone mid-conversation. It is not crossable from the plain Send button,
   * which carries no acknowledgement, so the remedy is to go and deal with the reply.
   */
  [RESEND_BLOCKS.TARGET_REPLIED]: { href: '/', label: 'Read the reply — messaging resumes by itself after a day' },

  /**
   * No control, on purpose. Retirement is the one promise the UI makes that has to survive
   * every other feature, so there is deliberately no "un-retire" button beside a draft.
   */
  /*
    "recipient", not "channel" — 95 of the 99 targets are companies. Seen on a real draft:
    "Channel is retired. This channel is retired." about a person.
  */
  [RESEND_BLOCKS.TARGET_OPTED_OUT]: { href: null, label: 'This recipient is retired — nothing to do here.' },

  /**
   * `/targets` is where the two kinds of target are visible and where a row can be changed
   * from one to the other, so this is the rare case where "where to fix it" is a real place
   * rather than `null`.
   *
   * A draft carrying this stop is almost certainly one written BEFORE the two types existed
   * — MEASURED on the day they shipped, 6 of them, aimed at our two competitors. The honest
   * remedy is to discard it, which is the control already on the card.
   */
  [RESEND_BLOCKS.TARGET_IS_WATCH_ONLY]: {
    href: '/targets',
    label: 'We watch this page to find who is buying from them — discard this draft',
  },

  // Both clear by waiting. See the note above on why neither links to /settings.
  [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED]: {
    href: null,
    label: 'Waits by itself — the spacing window opens again a week after the last message this recipient received from any of our pages.',
  },
  [RESEND_BLOCKS.TARGET_DAILY_CAP]: { href: null, label: 'The allowance resets at midnight IST.' },
  [RESEND_BLOCKS.SENDER_DAILY_CAP]: { href: null, label: 'The allowance resets at midnight IST.' },

  /**
   * The control is already on the card: discard it, and a fresh one is written with the
   * identity the account carries now. Re-rendering the stored body instead is refused on
   * purpose — it is what the send guards compare against, and an operator may have edited it.
   */
  [RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT]: {
    href: null,
    label: 'Discard it below and a fresh one will be written.',
  },

  /**
   * Same remedy as the persona stop above and for the same reason: the fix is a NEW body,
   * not an edit to this one. `href: null` is the real answer — there is no page to visit,
   * because nothing is misconfigured. The draft simply waited too long, and the next planning
   * pass writes a replacement with the right wording (or none, if the placement is now too
   * old to be worth naming, which `describeRecency` decides by returning null past 120 days).
   */
  [RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT]: {
    href: null,
    label: 'Discard it below; the next one will describe the timing correctly.',
  },

  /**
   * Reachable here for exactly one reason: a draft in SENDING is in the waiting list so that a
   * crash mid-send is visible rather than a vanishing. A browser is typing it, so there is
   * nothing to do and nothing has gone wrong.
   */
  [RESEND_BLOCKS.NOT_WAITING]: { href: null, label: 'Nothing to do — this one is already in flight.' },
} as const satisfies Record<string, { href: string | null; label: string }>

export type RemedyCode = keyof typeof REMEDIES

/**
 * The union of the entries above, so `href` keeps its LITERAL type all the way to `<Link>`.
 *
 * Widening it to `string` would compile here and fail at the `Link`, because Next's typed
 * routes need the literal — the same reason `nav.tsx` uses `as const satisfies` instead of a
 * type annotation. It also means a remedy pointing at a route that does not exist is a
 * compile error rather than a dead link an operator finds.
 */
export type Remedy = (typeof REMEDIES)[RemedyCode]

export function remedyFor(reason: string | null): Remedy | null {
  if (reason === null) return null
  // Membership, never a cast: an unrecognised reason renders its sentence with no link rather
  // than pointing an operator at a page that cannot help.
  return reason in REMEDIES ? REMEDIES[reason as RemedyCode] : null
}

/**
 * The gate's own words, punctuated so they read as prose. FORMATTING ONLY — not a rewrite.
 *
 * `gate.ts` writes its details as fragments, because they are also log lines: "account is not
 * connected", "channel already received 2 today", "this route is switched off". Dropped straight
 * after a sentence on the card they rendered as
 *
 *     This cannot be sent yet. account is not connected Sign this account in
 *
 * — lowercase mid-sentence, and running into the link with nothing between them. Found by
 * opening the page and READING it, with every assertion already green. Tests prevent
 * regression; reading prevents never-having-been-right.
 *
 * It capitalises and terminates. It changes no word, and it must not: the entire point is that
 * the operator sees what the gate actually said, not a paraphrase that could drift from it.
 */
export function asSentence(detail: string | null | undefined): string | null {
  if (!detail) return null
  const trimmed = detail.trim()
  if (trimmed.length === 0) return null
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalised) ? capitalised : capitalised + '.'
}

/**
 * A stored failure message, with any SHELL COMMAND taken out of it.
 *
 * `OutreachAttempt.error` is written by the send path and is a genuine record — it must keep its
 * exact bytes in the database, and in a log the command is the useful part. On screen it is not:
 * the live value is
 *
 *     Chrome profile for @tabishmukaddam1 is not logged in. Run: pnpm ig:login tabishmukaddam1
 *
 * and *"never put a shell command on the page"* is a rule here with a history — the deleted
 * "Needs you" list read `Send the next one: pnpm send` and `Check which channels are failing:
 * pnpm ig:audit`, every one of them a developer instruction standing in for something the page
 * could simply DO. This dashboard has a Connect button for exactly this. Found by reading the
 * rendered page after the redesign was otherwise finished.
 *
 * Only the trailing instruction is removed, and only when it is recognisably one. The rest of the
 * sentence is the operator's evidence about what happened and is never rewritten.
 */
export function withoutShellCommand(error: string | null | undefined): string | null {
  if (!error) return null
  const cleaned = error
    // "Run: pnpm x", "Run `pnpm x`", "run pnpm x" — to the end of the string.
    .replace(/\s*\bRun[:\s]+`?p?npm\s+[^`\n]*`?\s*\.?\s*$/i, '')
    .trim()
  return cleaned.length === 0 ? null : cleaned
}
