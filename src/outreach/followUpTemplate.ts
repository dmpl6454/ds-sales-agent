import { istDayMonth } from '@/lib/time'
import { stripOwnMarksFromBrands } from '@/detection/ownMarks'
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
export function followUpPostReference(post: { postedAt: Date; subject?: string | null }): string {
  const day = istDayMonth(post.postedAt)
  const subject = post.subject?.trim()
  return subject ? `your ${subject} placement on ${day}` : `your placement on ${day}`
}

/**
 * ── WHAT THE POST WAS ABOUT — the film, the product, the campaign (2026-09-01) ──
 *
 * Tabish, after the publisher name was removed: *"refer what the post was about. Basically,
 * the message should mention the post on say the 29th, rather than mentioning only the date
 * only of that paid post. Example if the paid post references a movie mention that movie
 * etc. Keep this futureproof."*
 *
 * The source is `DetectedCampaign.brands` — the entities the classifier read out of the
 * caption. It is the only stored fact about what a post is FOR, and it is deliberately not
 * `frameText`: OCR is FORBIDDEN from naming brands here, because the salon control frame
 * produced a DM claiming a collaboration with the signage behind a celebrity.
 *
 * ── MEASURED FIRST, OVER 681 IN-WINDOW PAID POSTS ─────────────────────────────
 *
 *   105 (15%)  no usable subject at all once own marks are stripped
 *   191 (28%)  exactly ONE subject — "TECNO", "Green Soul", "Titan Raga", "Toxic", "Tanishq"
 *   385 (57%)  several — ["Prime Video","The Revolutionaries","@primevideoIN","@Nikkhiladvani"]
 *
 * So this NAMES A SUBJECT ONLY WHEN THERE IS EXACTLY ONE, and otherwise renders the date
 * alone. Picking the first of several is a guess about what a post was "about", and the
 * measured data shows what that guess costs: `["Google India","Kerala Tourism"]` is two
 * unrelated advertisers on one round-up, so a first-wins rule would tell Kerala Tourism
 * about Google India — naming a third party, possibly their competitor, in a pitch. The same
 * refusal-rather-than-guess this codebase applies to a handle it cannot verify.
 *
 * FUTUREPROOF IS THE COVERAGE RISING BY ITSELF: every post that gains a cleaner subject
 * gains a named follow-up with no code change, and `captionEntities` is already the module
 * that improves it (987 → 2,810 distinct names when it last did).
 *
 * ── FOUR FILTERS, EACH FROM SOMETHING IN THE MEASURED DATA ────────────────────
 *
 *   own marks     `fg6`, `bs2`, `fg14` — a publisher's internal series codes, on 668
 *                 @filmygyan rows. `stripOwnMarksFromBrands` is the one rule and it also
 *                 removes the publisher's own NAME, which is what keeps a competitor out.
 *   raw handles   `brands` genuinely contains `"@primevideoIN"`, `"@sidsshaw"` — other
 *                 accounts, sometimes third parties. An @ never reaches a recipient.
 *   junk tokens   `"fyp"` came back as a whole post's only subject. A short or all-lowercase
 *                 token is a hashtag artefact, not a title; real ones here are `Toxic`,
 *                 `TECNO`, `Green Soul`. Rejecting one costs the date, which is the safe way
 *                 to be wrong.
 *   the recipient itself — "your Prime Video placement" said to @primevideoin is their own
 *                 name read back at them. Dropped, and the date is used instead.
 *
 * PURE. The publisher is an input to the FILTER and can never be an output: it is only ever
 * used to remove things, and `tests/follow-up-template.test.ts` drives a brands list
 * containing the publisher's own name and asserts it does not survive.
 */
export function followUpSubject(
  brands: readonly string[],
  publisher: { handle: string; displayName: string | null },
  recipient: { handle: string; displayName: string | null; campaignTalent: boolean },
): string | null {
  const mineSquashed = [recipient.handle, recipient.displayName]
    .filter((s): s is string => typeof s === 'string')
    .map(squashName)
    .filter((s) => s.length > 0)

  const usable = stripOwnMarksFromBrands(brands, publisher).filter((raw) => {
    const b = raw.trim()
    if (b.length < 3) return false
    if (b.includes('@')) return false
    /* All lower case is a hashtag artefact ("fyp"), never a title. */
    if (b === b.toLowerCase()) return false
    /* Their own name read back at them. */
    return !mineSquashed.includes(squashName(b))
  })
  if (usable.length !== 1) return null

  const subject = usable[0]!.trim()

  /**
   * ── AND WHOSE CAMPAIGN IS IT? THE FILTERS ABOVE DO NOT ANSWER THAT ────────
   *
   * CAUGHT BY RENDERING IT AGAINST LIVE PAIRS, which is the only way it was ever going to
   * surface. A post naming @jiohotstar carried exactly one surviving subject — **"Amazon
   * Prime"** — so every filter above passed and the message read *"We saw your Amazon Prime
   * placement on 31 Aug"* to a streaming platform that did not buy it.
   *
   * THE PRIMARY FAULT IS THAT IT IS FALSE. Tabish's rule about rivals is about the pages we
   * MONITOR — never naming a watched publisher, which the filter above makes structurally
   * impossible. This is the other kind of wrong: an invented claim about the RECIPIENT's own
   * marketing, addressed to the one party certain to know it did not happen. That is the
   * `{{brand}}` defect of 2026-08-05 verbatim, where a hook line told Royal Canin about a
   * collaboration with Amazon.
   *
   * One subject is not the same fact as one ADVERTISER. So the subject is only spoken when
   * it plausibly belongs to this recipient, and there are exactly two ways it can:
   *
   *   the recipient is TALENT — a person on a paid campaign post is there BECAUSE of the
   *     thing being promoted, so the film or product is what they were in. @tarasutaria and
   *     "Toxic", @thenameisyash and "Toxic: A Fairy Tale for Grown-Ups" — both correct, both
   *     from the live corpus.
   *   the subject SHARES A STEM with their own name — "Titan Raga" for @titan is their own
   *     product line, which is a fact about them rather than about somebody else.
   *
   * Anything else falls to the date. That is the same refusal-rather-than-guess this
   * codebase applies to a handle it cannot verify, and the cost of being wrong is one word
   * less in a sentence rather than a competitor's name in a pitch.
   */
  if (recipient.campaignTalent) return subject
  const squashed = squashName(subject)
  const theirs = mineSquashed.some(
    (mine) => mine.length >= 4 && squashed.length >= 4 && (squashed.includes(mine) || mine.includes(squashed)),
  )
  return theirs ? subject : null
}

/** Letters and digits only, lower case — enough to tell "Prime Video" from "primevideoin". */
function squashName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
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