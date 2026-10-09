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
  [RESEND_BLOCKS.TARGET_REPLIED]: { href: '/', label: 'Read the reply — messaging resumes by itself seven days after they wrote' },

  /**
   * A stop whose remedy is a control on another screen must NAME that screen — the gate says
   * WHY, this says WHERE — and `href: null` is reserved for stops with no control at all.
   *
   * The two parked stops used to be a matched pair, both pointing here. They are not any more:
   * re-queue / discard still exist for a capped failure, and the "check the conversation"
   * buttons for an unaccounted-for send were removed on 2026-08-24, so that one is now genuinely
   * a stop with nothing to press.
   */
  /**
   * No control, deliberately. The release is a NEW paid post from that recipient, which
   * detection finds by itself — there is nothing for a person to press, and offering a button
   * would imply the wait is a fault. `href: null` is a real answer here.
   */
  [RESEND_BLOCKS.MATERIAL_EXHAUSTED]: { href: null, label: 'Waits for their next paid post — nothing to do' },
  /**
   * NO CONTROL SINCE 2026-08-24, and that is a change of answer rather than a change of rule.
   *
   * This used to read *'Open the conversation and say whether it arrived — under "check the
   * conversation"'*, and that section is gone on Tabish's instruction. `href: null` is the only
   * honest value left: the stop still holds, the row still sits in FAILED, and there is now
   * nothing on any screen to press. Naming a screen that cannot answer the refusal is the
   * failure this file exists to prevent, and it would be the fifth entry in that series.
   */
  [RESEND_BLOCKS.UNCERTAIN_DELIVERY]: {
    href: null,
    label: 'An earlier message to them may already have arrived — this route stays closed',
  },
  /**
   * Still a control, and still on the landing page — but that list now shows only drafts the
   * retry cap actually gave up on (`attempts >= MAX_DELIVERY_ATTEMPTS`), so a stop pointing at
   * it is pointing at a row that is genuinely there.
   */
  [RESEND_BLOCKS.PARKED_FAILURE]: {
    href: '/',
    label: 'Re-queue or discard the parked message — under "Gave up after repeated failures"',
  },

  /**
   * No control, on purpose. A deleted or renamed page cannot be reached by any button; the stop
   * lifts by itself after a week and one anonymous probe asks again. If it stays gone, retire the
   * recipient (`pnpm ig:retire-target`).
   */
  [RESEND_BLOCKS.TARGET_UNREACHABLE]: {
    href: null,
    label: 'Their Instagram page no longer exists — nothing to do here; it is re-checked after a week',
  },

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
  [RESEND_BLOCKS.TARGET_NOT_VERIFIED]: {
    href: '/targets',
    label: 'Only verified accounts are messaged — find the company’s verified page, or discard this draft',
  },
  /**
   * Nothing to press, and that is true rather than a missing control: the planner discards
   * these at the top of every pass (`staleIntroductions.ts`), whether or not autopilot is on,
   * so the page's turn is not held behind a draft that can never be sent. There is no Discard
   * control on a waiting draft on `/`, so pointing at one would point at nothing.
   */
  [RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US]: {
    href: null,
    label:
      'Nothing to press — the next planning pass discards it and writes a follow-up that names a post of theirs, when one exists.',
  },
  /**
   * Two fleets, and they never write to each other's companies (2026-08-25, Tabish). A draft
   * carrying this was written before the categories existed, or the memberships changed under
   * it. The remedy is /targets, where a recipient can be put in BOTH categories — which is the
   * supported way to say "this company belongs to both", his own "unless they are present
   * common elsewhere".
   */
  [RESEND_BLOCKS.DIFFERENT_CATEGORY]: {
    href: '/targets',
    label: 'This page sends for a different fleet — add this company to that fleet, or discard the draft',
  },

  /**
   * A TEXTAREA, not a judgement call — which is why this one HAS an href where the spacing
   * rules deliberately do not. Nothing about the recipient is wrong; nobody has written that
   * fleet's copy yet, and the moment they do every held draft for it clears by itself.
   */
  /**
   * ── THERE IS A CONTROL NOW, AND THE LABEL HAD TO CHANGE WITH IT (2026-09-01) ──
   *
   * This read *"It clears when a follow-up says something different from the first message"*
   * with `href: null`, and that was correct on the day it was written: nothing in the product
   * could produce a different second message, so there was no screen to send anyone to.
   * There is one now — the follow-up box on the Autopilot page — and `href: null` is reserved
   * for stops with NO control at all, not for stops whose control someone forgot to name.
   *
   * THE LABEL DOES NOT PROMISE THIS ROW GOES OUT, deliberately. A draft already written with
   * the first message's bytes stays a repeat whatever is typed into that box; what the copy
   * changes is what the planner writes NEXT. Saying "these go out" here would be the
   * `MAX_TOTAL_SENDS` shape — a screen promising a release the enforcer will not give.
   */
  [RESEND_BLOCKS.IDENTICAL_TO_A_SENT_MESSAGE]: {
    href: '/',
    label:
      'Write the follow-up message on the Autopilot page — then a second message names a new paid post instead of repeating the first.',
  },

  [RESEND_BLOCKS.FLEET_TEMPLATE_NOT_SET]: {
    href: '/',
    label: 'Write this fleet\u2019s standard message on the Autopilot page and these go out.',
  },

  /**
   * A TEXTAREA, like the fleet template above and for the same reason \u2014 nothing about this
   * recipient is wrong, there is simply no second message written yet, and the moment there
   * is, every draft holding on this clears by itself.
   *
   * It is deliberately NOT the same label as the standard message's: two boxes on that page
   * mean opposite things by being empty, and sending someone to "the Autopilot page" without
   * saying WHICH box is how they edit the wrong one.
   */
  [RESEND_BLOCKS.FOLLOW_UP_TEMPLATE_NOT_SET]: {
    href: '/',
    label: 'Write the follow-up message on the Autopilot page \u2014 a second message has to differ from the first.',
  },

  /**
   * A draft from before follow-ups were required to name the post's subject (2026-09-01).
   * Discarding is the whole remedy: the planner writes a replacement by itself the moment a
   * post whose subject is theirs exists, and never writes another date-only one.
   */
  [RESEND_BLOCKS.FOLLOW_UP_CITES_ONLY_A_DATE]: {
    href: '/',
    label: 'Discard it \u2014 it only cites a date. The planner writes a follow-up that names what the post was about, when such a post exists.',
  },

  // Clears by waiting — five a day from one account to one recipient.
  [RESEND_BLOCKS.PAIR_DAILY_CAP]: { href: null, label: 'The allowance resets at midnight IST.' },
  /* Nothing a person can press releases this — the remedy is the clock, and offering a button
     would imply a fault where there is none. */
  [RESEND_BLOCKS.FOLLOW_UP_SAME_DAY]: { href: null, label: 'It goes out tomorrow.' },

  /**
   * No control, deliberately. The remedy for "every page that writes to this person already
   * has" is to leave them alone, and offering a way to shorten the window would be offering
   * to do the thing the rule exists to stop.
   */
  [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED]: {
    href: null,
    label: 'Waits by itself — once every page that writes to this recipient has written, they rest a week.',
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
