import { istDayMonth } from '@/lib/time'
import { DEFAULT_CATEGORY_SLUG } from './senderCategories'
import { routeFleets } from './fleetTemplate'

/**
 * THE SECOND MESSAGE — what a page says to a company it has already written to.
 *
 * ── THE WALL THIS RELEASES, MEASURED ──────────────────────────────────────────
 *
 * Since `singleTemplate` went on, every message is the fleet's one standard template, so
 * a SECOND message from one page to one recipient is a verbatim repeat of what is already
 * in that thread. Instagram accepts it and never delivers it — measured 2026-08-26: touch
 * 1 fails 5%, touch 2 fails **83%**, and six of six parked threads read back showed the
 * second message simply absent. `IDENTICAL_TO_A_SENT_MESSAGE` was added to stop the waste,
 * and its own docblock names the remedy: *"the rule lifts by itself the moment a follow-up
 * says something different."*
 *
 * Nothing said anything different, so it never lifted. MEASURED 2026-09-01: the planner's
 * dominant skip is `identical-to-a-message-they-already-have=1808`, about half of every
 * skip in the fleet. **This module is the something different.**
 *
 * ── AND IT IS NOT A VOLUME CHANGE ─────────────────────────────────────────────
 *
 * The ceiling is unchanged: `materialAllowance` still permits one message per paid post
 * naming a recipient, the per-pair daily cap, the ring rule and the one-minute fleet gap
 * are all untouched. What changes is REACHABILITY — pairs that were permanently held for
 * having nothing new to SAY can now say the thing they always had material for. The
 * release therefore arrives at the pace new paid posts arrive, not as a burst.
 *
 * ── UNSET REFUSES, FOR EVERY FLEET, AND THAT IS THE ASYMMETRY WITH fleetTemplate ──
 *
 * `fleetTemplate.ts` has a SHIPPED default-fleet body in the source, so "unset" there means
 * *nobody has overridden it* and the default fleet can never be empty. There is no shipped
 * follow-up copy and there must not be one: what a second message says is Tabish's to
 * write, and inventing it here would put words nobody chose into a real conversation with
 * a company that has already been pitched once.
 *
 *   | fleet         | no Setting row means                    |
 *   |---------------|-----------------------------------------|
 *   | bollywood     | NO FOLLOW-UP COPY EXISTS — refuse       |
 *   | anything else | NO FOLLOW-UP COPY EXISTS — refuse       |
 *
 * So this ships INERT: with nothing written, `evaluatePair` refuses to draft a follow-up
 * and `evaluateResend` refuses to send one, both by name, and the fleet behaves exactly as
 * it did the day before. That is the marketing-fleet pattern (2026-08-26) — ship the
 * refusal first, and let a textarea turn the feature on.
 *
 * The two alternatives to refusing are the ones this codebase keeps paying for: falling
 * back to the FIRST-touch template is the verbatim repeat Instagram drops, and an empty
 * body makes `distinctiveSlice` return null, which refuses every send in the system with
 * no sentence naming the cause.
 *
 * ── ONE VARYING TOKEN, `{{post}}`, AND IT IS REQUIRED ─────────────────────────
 *
 * Tabish's spec: the follow-up mentions the paid post it is for, in a "let's talk
 * tomorrow" register, with the same continuous spacing as the standard message ("Hi,We're
 * …"). `{{post}}` is the ONLY thing that varies and the SYSTEM renders it, from the post
 * the message actually claimed (`OutreachAttempt.campaignId`) — never from anything a
 * person types.
 *
 * It is REQUIRED rather than optional, and that is a correctness rule rather than a style
 * one: without it every follow-up from a page carries identical bytes, so follow-up #2
 * would be refused by `IDENTICAL_TO_A_SENT_MESSAGE` all over again — the wall this module
 * exists to release, rebuilt one storey up, discovered weeks later as a queue that stopped
 * draining. `checkFollowUpBody` refuses a body without it, at save time.
 *
 * Every OTHER `{{token}}` is refused for the reason `checkTemplateBody` refuses all of
 * them: nothing else is substituted, so braces would reach a real person as literal braces.
 *
 * PURE. No I/O, no clock — `istDayMonth` is a formatter, and the instant is passed in.
 */

export type FollowUpTemplate =
  | { ok: true; slug: string; body: string }
  | { ok: false; slug: string | null; reason: 'not-set' | 'ambiguous' | 'different-fleet'; detail: string }

/** The one thing that varies in a follow-up. Rendered by the system, never typed. */
export const FOLLOW_UP_POST_TOKEN = '{{post}}'

/**
 * The DEFAULT fleet's follow-up copy. A bare key with no colon, so it can never collide
 * with `followUpTemplateKey(slug)` below — the prefix scan in `settings.ts` matches
 * `followUpBody:` and this is not that.
 */
export const FOLLOW_UP_DEFAULT_KEY = 'followUpBody'

/**
 * One row PER SLUG for every non-default fleet, mirroring `fleetTemplateKey` exactly: a
 * third fleet costs one `Category` row and one of these, and nothing in this file changes.
 */
export function followUpTemplateKey(slug: string): string {
  return `${FOLLOW_UP_DEFAULT_KEY}:${slug.trim().toLowerCase()}`
}

/**
 * THE ROUTE'S OWN FOLLOW-UP COPY, or why there is none.
 *
 * Uses `routeFleets` — the SAME intersection `templateForRoute` and `sameCategory` compute —
 * so the standard message and the follow-up can never disagree about which fleet a route
 * belongs to. A route whose fleet is ambiguous or empty is refused here for the same reasons
 * it is refused there, and answering those cases rather than falling through means a caller
 * that forgot the category check gets a refusal instead of somebody else's copy.
 */
export function followUpForRoute(args: {
  senderCategories: readonly string[]
  targetCategories: readonly string[]
  /** Written copy per fleet slug, DEFAULT INCLUDED. Absent or blank = nobody has written it. */
  bodies: ReadonlyMap<string, string | null | undefined>
}): FollowUpTemplate {
  const fleets = routeFleets(args.senderCategories, args.targetCategories)

  if (fleets.length === 0) {
    return {
      ok: false,
      slug: null,
      reason: 'different-fleet',
      detail:
        'this page and this recipient belong to different fleets, so there is no follow-up ' +
        'message that covers the two of them',
    }
  }

  if (fleets.length > 1) {
    return {
      ok: false,
      slug: null,
      reason: 'ambiguous',
      detail:
        `this page sends for more than one fleet (${fleets.join(' and ')}) and each has its ` +
        `own follow-up message, so which one to send is not decided — put the page in a ` +
        `single fleet`,
    }
  }

  const slug = fleets[0]!
  const raw = args.bodies.get(slug)
  const body = typeof raw === 'string' ? raw.trim() : ''

  if (body.length === 0) {
    return {
      ok: false,
      slug,
      reason: 'not-set',
      detail:
        `no follow-up message is written for the ${slug} fleet, so this page has nothing new ` +
        `to say to a company it has already written to — write it on the Autopilot page and ` +
        `these go out`,
    }
  }

  return { ok: true, slug, body }
}

/**
 * The parts of `RuntimeSettings` this rule needs, STRUCTURALLY.
 *
 * Named as a shape rather than imported from `lib/settings.ts` for the reason
 * `TemplateSettings` is: `settings.ts` constructs a Prisma client transitively, and a pure
 * rule that opens a database connection in order to be loaded is the trap
 * `tests/pool-bounds` was written for.
 */
export interface FollowUpSettings {
  /** The DEFAULT fleet's follow-up copy. Null = nobody has written it. There is no shipped one. */
  followUpBody: string | null
  /** Per-slug follow-up copy for NON-default fleets. */
  followUpBodies: ReadonlyMap<string, string>
}

/**
 * ONE CALL, THREE CALLERS — the planner (refuses to draft), the gate (refuses to send) and
 * the composer (writes the bytes). Exactly the discipline `templateForSettings` keeps, and
 * for the same reason: three answers to one question is how they drift.
 */
export function followUpForSettings(
  settings: FollowUpSettings,
  senderCategories: readonly string[],
  targetCategories: readonly string[],
): FollowUpTemplate {
  const bodies = new Map<string, string | null | undefined>(settings.followUpBodies)
  bodies.set(DEFAULT_CATEGORY_SLUG, settings.followUpBody)
  return followUpForRoute({ senderCategories: senderCategories, targetCategories, bodies })
}

/**
 * HOW A FOLLOW-UP NAMES THE POST IT IS FOR — "your placement on 30 Aug", and NOTHING ELSE.
 *
 * ── WE NEVER NAME THE PUBLISHER. THIS FUNCTION CANNOT (2026-09-01, Tabish) ────
 *
 * The first version of this read `your placement with @${channelHandle} on 30 Aug`, and
 * that is a real defect that reached a real recipient before it was caught. **Every channel
 * we watch is a COMPETITOR** — @filmygyan, @viralbhayani, @voompla — so naming the publisher
 * puts a competitor's handle, by name, in a media-buying pitch to a company we want to sell
 * our own inventory to. It advertises them, and it tells the recipient exactly where we
 * watch. Tabish, on seeing it: *"Never mention our competitors in this way never mention
 * their names."*
 *
 * MEASURED before it was stopped: ONE delivered (@bollywoodchronicle → @arshad_warsi,
 * 07:04Z) and 28 waiting drafts, all discarded. The one that went cannot be unsent.
 *
 * **THE FIX IS THAT THE FUNCTION NO LONGER TAKES A HANDLE**, rather than a rule saying not
 * to pass one. A parameter that must never be used is a parameter somebody uses; the whole
 * `channelId` field added to `NamingCampaign` for it was removed with it, so there is no
 * publisher identity anywhere on the path from a claimed post to a rendered body. That is
 * the same discipline as `frameText` being forbidden from naming brands after the salon
 * control produced a DM claiming a collaboration with the signage behind a celebrity.
 *
 * WHAT IS LEFT IS THE DATE, and it is enough. It is the post's own public timestamp, it
 * identifies which placement is meant, it varies per post — which is what keeps two
 * follow-ups from being byte-identical — and it reveals nothing about how we found it. IST,
 * from the one formatter, so a DM and the dashboard cannot name different days across
 * midnight.
 *
 * TWO POSTS ON ONE DAY RENDER THE SAME REFERENCE, and that is handled rather than ignored:
 * `plan.ts` renders this exact body before deciding, so such a pair is refused as a repeat
 * instead of writing a draft the gate would wedge.
 */
export function followUpPostReference(post: { postedAt: Date }): string {
  return `your placement on ${istDayMonth(post.postedAt)}`
}

/**
 * The body a recipient actually receives. The ONLY substitution in the system.
 *
 * `split`/`join` rather than `String.replace`, because a `$` in the reference would be a
 * replacement pattern to `replace` — `$&` and `$'` are real handles' worth of trouble on a
 * string built from user-facing data, and this one goes to a stranger.
 */
export function renderFollowUp(body: string, postReference: string): string {
  return body.trim().split(FOLLOW_UP_POST_TOKEN).join(postReference)
}

/**
 * THE SHORTEST REFERENCE A REAL POST CAN PRODUCE, built by the real builder.
 *
 * `checkFollowUpBody` validates the RENDERED text, and the rendered length depends on the
 * reference — so the check must use the WORST case, which is the shortest, because
 * `distinctiveSlice` fails by having no line of 40+ characters left. A one-digit day is the
 * floor. Built rather than written as a literal, so it cannot go stale green the day the
 * wording changes.
 */
export const SHORTEST_POST_REFERENCE = followUpPostReference({
  /* A fixed instant, and the shortest day-and-month there is. `new Date()` here would make
     a pure module depend on the clock. */
  postedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
})