import { prisma } from '@/lib/db'
import { memoView, viewKey } from '@/lib/viewMemo'
import { getSettings } from '@/lib/settings'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { istDayStart } from '@/lib/time'
import { newMaterialFloor } from '@/lib/cutoff'
import { SKIP_REASONS } from '@/outreach/governor'
import { BRAND_BLOCKS, checkRecipientIsNotAPerson } from '@/outreach/brandGuards'
import { materialAllowance, campaignsNamingHandleRows } from '@/outreach/materialAllowance'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { replyHaltFloor, replyHaltKey } from '@/outreach/replyHalt'
import { eligibleFleetSenders, readSenderAvailability } from '@/outreach/availability'
import { fleetRingOrder, nextSender } from '@/outreach/rotation'
import { categoriesFor, readCategoryMemberships, ringMembersFor, unavailableForTarget } from '@/outreach/categories'
import { parkBlocksRoute } from '@/outreach/parkedRows'
import { readPersonHandles } from '@/outreach/compose'
import { watchMarksFrom } from '@/detection/ownMarks'
import { followUpForSettings, followUpSubject } from '@/outreach/followUpTemplate'
import { readStringArray } from '@/lib/json'

/**
 * HOW MANY COMPANIES ARE RESTING RIGHT NOW, OUT OF HOW MANY — and which rule holds each.
 *
 * Tabish, 2026-08-24: *"If outreach is on hold for majority of the targets … then it must be
 * clearly depicted in the UI, currently a user does not know how many targets are on hold from
 * total (which would keep on increasing and changing)."*
 *
 * He is right that it was invisible, and right that it is the majority: MEASURED the day this
 * shipped, **448 of 463** live companies were held by at least one rule and nothing on any
 * screen said so. What the Autopilot page showed was `waitingTotal 10` and `heldWaiting 6` —
 * the DRAFTS that exist — and drafts are the tip of it: a company with no draft *because the
 * planner refused to write one* is invisible to every count on that page, and that refusal is
 * the whole population this answers for.
 *
 * ── WHY THIS IS MEASURED LIVE AND NOT PERSISTED BY THE PLANNER ─────────────
 *
 * The obvious cheaper design is to persist the planner's own per-reason tally — it already
 * computes a `skipReason` per pair every 15 minutes, logs a grouped total, and throws it away.
 * Rejected, because that tally is a SNAPSHOT written by a pass: the page would then show a
 * figure that is right about the past and silently wrong whenever the planner is late,
 * throwing, or simply between passes. That is a fresh page beside a stale stamp — the exact
 * alarm signature `readPassHealth` exists to catch — promoted to a headline number. Tabish's
 * own words are *"which would keep on increasing and changing"*, and a number that changes is
 * one that has to be measured at the moment it is read.
 *
 * ── AND IT USES THE ENFORCERS' OWN FUNCTIONS, NOT A BULK LOOKALIKE ─────────
 *
 * The expensive part is the material allowance: `campaignsNamingHandleRows` is a query PER
 * TARGET and there are 463 of them — an N+1 over a list whose size is a product decision,
 * which this project has already had to kill twice (`buildBrandsPanel`, `buildChannelCards`).
 *
 * The way out is NOT to re-implement the linkage in bulk. That function is structurally typed
 * over its Prisma client, and its `where` clause is a PREFILTER whose exact test
 * (`mentionsHandleExactly || brandStringsNameProspect`) runs in JS on whatever comes back. So
 * a stub whose `findMany` returns the in-window CAMPAIGN posts, loaded ONCE, is a superset in
 * and the enforcer's own predicate deciding: the same answer for 1 query instead of 463.
 * MEASURED: 468 posts × 473 prospects = 403 ms of matching, and this builder runs concurrently
 * with the page's other loaders, so it costs no wall-clock the page was not already spending.
 * A number from a re-implementation is not a measurement of what the system does; this one is.
 *
 * **THE STUB MUST HONOUR THE DATE BOUND IT IS ASKED FOR, and this is the trap.** The JS filter
 * tests NAMING only — the `postedAt` floor lives in the `where` clause and nothing downstream
 * re-checks it. So a stub that ignored `args` and returned the widest window would be a
 * superset in the one dimension the exact test cannot compensate for, and would over-count
 * every caller that passes a narrower floor. There are two such floors in play and they are
 * genuinely different: the allowance uses the 7-day cooldown window, while
 * `NO_NEW_MATERIAL` uses `newMaterialFloor` (72 h, or the 1 August cutoff, whichever is
 * later). The stub reads `args.where.postedAt.gte` and filters, so each caller gets exactly
 * the window it asked for, and the preload spans the EARLIER of the two floors so neither can
 * be served short.
 *
 * ── THE DENOMINATOR EXCLUDES RETIRED ROWS, AND REPORTS THEM SEPARATELY ─────
 *
 * A retired (`optedOut`) company can never be written to again — the one promise the UI makes
 * that outranks every feature — so counting those rows as "resting" would pad the share with
 * rows that are not waiting for anything. They get their own figure.
 *
 * ── ATTRIBUTION IS THE GOVERNOR'S OWN PRECEDENCE, SO THE ROWS SUM EXACTLY ──
 *
 * A company can be held by several rules at once, and counting each rule independently gives a
 * breakdown that sums to more than the total and cannot be read. Each company is therefore
 * attributed to the FIRST rule that holds it in `evaluatePair`'s order — replied → pending →
 * parked → material → nothing-new → ring — which is the sentence the planner would actually
 * give for it. `byReason` sums exactly to `resting`.
 */

/**
 * THE AGGREGATE SENTENCE PER RULE — and it must NOT be a per-row detail.
 *
 * The first version passed `materialAllowanceDetail(material)` straight through as the bucket
 * label, which reads correctly and is wrong: that sentence is about ONE company ("no paid post
 * of theirs has been detected and 5 of our pages have already written"), and it was being shown
 * over 373 companies of which most had heard from exactly one page. An aggregate described by a
 * sample of itself is this project's most repeated defect wearing a new hat, so the per-row
 * detail stays where it belongs — on a row — and a bucket gets a sentence about the RULE.
 *
 * Keyed on the governor's own reason codes and TOTAL over the reasons this tally can emit, in
 * the manner `STOP_LABELS` is total over `RESEND_BLOCKS` — `tests/rest-tally.test.ts` fails if a
 * reason is ever bumped without a sentence, because the alternative is a bucket rendering an
 * empty string on a page a CEO reads. `/rules` still owns the long-form prose for each rule;
 * this owns the short phrase a count needs.
 *
 * `needsAPerson` is the operator's actual question. Everything else here arrives by itself — a
 * paid post lands, a clock expires, the dispatcher takes the draft — and exactly one of these
 * cannot: an unaccounted-for send has no control on any screen since 2026-08-24, so it clears
 * only if somebody changes something.
 */
/**
 * Rotation could not elect anybody — every account in this recipient's ring is signed out or
 * flagged. Not one of the governor's reasons because it is decided AFTER the governor, by
 * `nextSender`; it has its own key so it can never fall through to "clear", which is what the
 * first version of this file did.
 */
const ROTATION_STUCK = 'no-account-can-write'

/**
 * ── A FLEET WITH NO SENDER IS NOT A FLEET WITH SIGNED-OUT SENDERS (2026-08-26) ──
 *
 * `nextSender` refuses two ways and they were collapsed into one sentence: `all-unavailable`
 * means every page in their ring is signed out or flagged — a fault, someone should sign in.
 * `empty-ring` means their ring has NO PAGE IN IT AT ALL, which for a second fleet is not a
 * fault but the state it was deliberately shipped in: Tabish's own instruction was that the
 * marketing companies get *"no messages… currently"* until `@madaboutmarketing` is connected.
 *
 * MEASURED the day the two were split: 28 companies were being reported as "every account in
 * their rotation is signed out or flagged" when every one of them was a marketing-fleet
 * prospect whose fleet has no page yet. That sentence sends a person to look for a broken
 * sign-in that does not exist, and hides the one action that would actually release them.
 */
const NO_PAGE_FOR_FLEET = 'no-page-sends-for-their-fleet'

/**
 * THE HALF OF THE MATERIAL RULE THAT IS WAITING FOR A FIRST PAID POST, NOT A NEXT ONE.
 *
 * Both are `MATERIAL_EXHAUSTED` at the governor and both are correct, but they are opposite
 * facts to read and collapsing them produced a sentence Tabish could not parse: *"every paid
 * post we have seen from them has already been written about — the next message waits for their
 * next one."*
 *
 * MEASURED the day he asked: of 423 companies the material rule was holding, **208 (49%) have
 * ZERO paid posts naming them inside the window** — the single commonest shape is
 * `campaigns=0 delivered=1`, 145 companies. For every one of those the sentence is FALSE: there
 * is no paid post of theirs that has been written about, and there is no "their next one" to
 * wait for either. They are held by the `max(1, …)` FLOOR — the deliberate rule that a company
 * with no detected paid post still gets one message, so a hand-imported prospect is not
 * unreachable forever — and what they are waiting for is a FIRST post, from any channel we
 * watch. (60 of them read `campaigns=0 delivered=5`, which is the 20-21 August five-page
 * fan-out that pre-dates the one-message-per-paid-post rule.)
 *
 * BOTH SENTENCES WERE TIGHTENED BY READING THE RENDERED ROWS, which is the only way either
 * error was ever going to surface. The first said "once for every paid post" — false for the
 * ~40 companies at `campaigns=1 delivered=5`, who had five. The second said "their one
 * introduction" — false for the 60 at `campaigns=0 delivered=5`, who had five. Neither is a
 * wording nit: an aggregate sentence has to be true of every row it counts, and both were
 * describing the commonest shape as though it were the only one.
 *
 * So the bucket splits on `campaigns === 0`. Same enforcer verdict, same window, two sentences —
 * because a reader deciding whether to act needs to know whether the thing they are waiting for
 * has ever happened.
 */
const AWAITING_FIRST_POST = 'awaiting-a-first-paid-post'

/**
 * `clock` is the honest release phrase for a bucket whose release is NOT a timestamp.
 * Without it the band's null-clock fallback reads "any minute" — which is right for a
 * per-minute re-check like rotation, and wrong for "waiting for their next paid post",
 * where nothing is imminent and nothing is broken. Tabish read exactly that ambiguity
 * off the live table on 2026-09-01.
 */
const REST_RULES: Record<string, { label: string; needsAPerson: boolean; clock?: string }> = {
  [SKIP_REASONS.MATERIAL_EXHAUSTED]: {
    label:
      'they have had a message for every paid post of theirs we have found — the next one waits until a channel we watch posts about them again',
    needsAPerson: false,
  },
  [AWAITING_FIRST_POST]: {
    label:
      'no paid post of theirs in the last 7 days — they have already been written to, so the next message waits until a channel we watch posts about them again',
    needsAPerson: false,
  },
  [SKIP_REASONS.FOLLOW_UP_SAME_DAY]: {
    /**
     * The clock is the only remedy, so `clock` carries it and no control is offered — see
     * `REMEDIES`, where this is deliberately `href: null`. A button here would imply a fault
     * where there is none, which is the defect this dashboard's own design keeps correcting.
     */
    label:
      'the page whose turn it is already wrote to them today — a second message from the same page waits for tomorrow',
    needsAPerson: false,
    clock: 'tomorrow',
  },
  [SKIP_REASONS.TARGET_REPLIED]: {
    label: 'they replied — every one of our pages pauses for seven days from the date they wrote, then resumes on its own',
    needsAPerson: false,
  },
  [SKIP_REASONS.TARGET_RECENTLY_CONTACTED]: {
    label: 'every page that writes to them has written to them this week — they rest until the oldest of those is seven days old',
    needsAPerson: false,
  },
  [SKIP_REASONS.NO_NEW_MATERIAL]: {
    label: 'every paid post of theirs has already been claimed by a message — the next one waits until a channel we watch posts about them again',
    needsAPerson: false,
    clock: 'their next paid post',
  },
  [SKIP_REASONS.NO_DESCRIBABLE_POST]: {
    /**
     * Self-releasing, like NO_NEW_MATERIAL beside it: the release is a new paid post whose
     * subject is theirs, which detection finds by itself. A follow-up that cites only a date
     * is never written (2026-09-01, Tabish: "an amateur message with no context").
     */
    label:
      'their recent paid posts name no film, product or campaign of their own — a follow-up must say what the post was about, so the next message waits for a post whose subject is theirs',
    needsAPerson: false,
    clock: 'a post whose subject is theirs',
  },
  [SKIP_REASONS.NO_FOLLOW_UP_TEMPLATE]: {
    /**
     * The one bucket on this page whose remedy is a TEXTAREA, which is why it needs a person
     * and why the sentence names the box. Everything else here arrives by itself.
     *
     * It is bumped LAST, matching the governor: reported earlier it would swallow every
     * held follow-up in the fleet — including the ones waiting on a paid post or on the ring,
     * neither of which writing the copy releases. That is the `DIFFERENT_CATEGORY` mistake of
     * 2026-08-31, where 245 correct refusals wore a label saying *go and write a template*.
     * Here the count IS the number of companies a saved textarea would release.
     */
    label:
      'the page whose turn it is has already written to them once, and no follow-up message is written — a second message has to say something different from the first',
    needsAPerson: true,
  },
  [BRAND_BLOCKS.RECIPIENT_IS_A_PERSON]: {
    label: 'Instagram lists them as a profession rather than a company — a media-buying pitch would be the wrong message',
    needsAPerson: true,
  },
  [SKIP_REASONS.TARGET_NOT_VERIFIED]: {
    label: 'no verified badge on Instagram — only verified accounts are ever messaged',
    needsAPerson: true,
  },
  [ROTATION_STUCK]: {
    /**
     * Three inputs land here, not two: signed out, flagged, AND a parked route ("an earlier
     * message from this page may already have reached them"). The old sentence named only
     * the first two — so @wowmomos, whose one-page marketing ring is parked on an uncertain
     * send, read as "signed out or flagged" on a day every account was healthy, sending a
     * person hunting a broken sign-in that does not exist. The same defect this file already
     * records for `empty-ring`, one bucket over.
     */
    label:
      'not one of our pages can write to them — each page in their rotation is signed out, flagged, or holding an earlier send that may already have reached them',
    needsAPerson: true,
  },
  [NO_PAGE_FOR_FLEET]: {
    label: 'no page sends for their fleet yet — they wait for an account to be put in it, not for a paid post',
    needsAPerson: true,
  },
}

/** One rule, how many companies it is holding, and when the soonest of them frees up. */
export interface RestReason {
  /** The governor's own reason code. A screen cannot invent a rule name this way. */
  reason: string
  /** The enforcer's own sentence where it has one, so the page cannot describe it differently. */
  label: string
  count: number
  /**
   * Does clearing this need a person?
   *
   * The distinction is the whole value of the breakdown: "resting for a week" and "waiting for
   * somebody to do something" are the same number and opposite facts about whether to act.
   */
  needsAPerson: boolean
  /** The soonest instant any company in this row frees up, where that is a clock at all. */
  nextReleaseAt: Date | null
  /**
   * What actually releases this bucket when there is no timestamp — "their next paid post",
   * never a clock. Null = the band's own fallback ("any minute" / "not on a person"). Set
   * per bucket in REST_RULES; a screen cannot invent a release this way.
   */
  clockLabel: string | null
}

export interface RestTally {
  /** Live companies we may write to. Retired rows and watched pages are not in here. */
  total: number
  /**
   * Held by a rule right now.
   *
   * A company whose message is ALREADY WRITTEN is deliberately NOT counted here — it is not
   * resting, it is next, and the queue below is where it belongs. Counting it as held inflated
   * the share to 100% on a fleet that was about to send: measured 473/473 with the draft-holders
   * in, 464/473 with them out.
   */
  resting: number
  /** No rule is holding them right now. */
  clear: number
  /** Companies whose message is already written and waiting in the queue. Not "resting". */
  queued: number
  /** Retired, counted apart because they are not waiting for anything. */
  retired: number
  /**
   * Watched publisher pages, counted apart so this figure can be RECONCILED against the
   * total the /targets subtitle shows — which is every `TargetAccount` row there is, retired
   * and watched included. Two adjacent counts of different populations with nothing saying so
   * is the contradiction this project keeps recording; total + queued + retired + watched is
   * that number.
   */
  watched: number
  /** Sums exactly to `resting`, largest first. */
  byReason: RestReason[]
  /**
   * PER FLEET, how many companies are held for want of a FOLLOW-UP MESSAGE (2026-09-01).
   *
   * A subset of `byReason`'s `no-follow-up-message-written` bucket, split by the fleet whose
   * textarea would release it — because that textarea is PER FLEET and a box showing the
   * fleet-wide number would over-state what saving it does. Accumulated in the same pass at
   * no cost: `followUpForSettings` already answers with the slug.
   */
  noFollowUpByFleet: Record<string, number>
  /** The soonest any resting company frees itself. */
  nextRelease: Date | null
  /** Resting companies that will not clear unless a person changes something. */
  needingAPerson: number
  /** When this was read. The figure moves all day, so a screen must be able to say when. */
  measuredAt: Date
  /**
   * Companies whose per-pair check was skipped because the bound below was reached. Counted
   * into `clear`, and REPORTED: a bounded pass that hides what it skipped reads as "covered
   * everything" when it did not.
   */
  pairChecksSkipped: number
}

/**
 * ── THERE IS NO PER-ROW QUERY LEFT, AND THE CAP THAT BOUNDED ONE IS GONE ───
 *
 * `NO_NEW_MATERIAL` is the only hold that is genuinely per-PAIR: it asks whether the page whose
 * turn it is has already written about every campaign naming this recipient. That used to mean
 * `usedCampaignIds(pairId)` once per prospect, capped at 80 so it could not become an N+1 —
 * past the cap the remainder was counted clear and `pairChecksSkipped` said how many.
 *
 * MEASURED 2026-08-25 by logging the SQL: **50 of this builder's 62 queries were that one
 * call**, and since `/` and `/targets` both load it, both were over the ceilings `ig:layout`
 * enforces (182/160 and 148/120). A cap is the right answer to a per-row query; not being
 * per-row is a better one. The usage is preloaded in the Promise.all below — two columns, one
 * round trip — and the check is now a map lookup.
 *
 * So the cap is deleted rather than raised, `pairChecksSkipped` is structurally 0, and the
 * breakdown stopped being an approximation above 80 rows. The field survives so the shape of
 * `RestTally` does not move under its callers; nothing can make it non-zero any more.
 */

/**
 * Memoised (single-flight, 10 s) — see `src/lib/viewMemo.ts`. The key deliberately EXCLUDES
 * `now`: it defaults to the current instant, so keying on it would make every call a miss
 * and the memo decorative. Production callers pass nothing; a test that passes an explicit
 * clock runs with the memo off (VITEST) and gets exactly the instant it asked for.
 */
export async function buildRestTally(now: Date = new Date()): Promise<RestTally> {
  return memoView(viewKey('restTally'), () => computeRestTally(now))
}

async function computeRestTally(now: Date): Promise<RestTally> {
  const settings = await getSettings()
  const allowanceFloor = new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000)
  const materialFloor = newMaterialFloor(now)
  /* Preload from the EARLIER of the two floors: the stub narrows per caller, it cannot widen. */
  const preloadFloor = allowanceFloor < materialFloor ? allowanceFloor : materialFloor

  const [targetRows, posts, attempts, pairs, eligibleFleet, unavailable, campaignUsage, memberships] =
    await Promise.all([
      /**
       * EVERY target row in ONE query, partitioned in JS.
       *
       * This was three — live prospects, a retired count, a watched count — and `/`'s query
       * budget is a CEILING OVER A BOUNDED DESIGN, not a number to raise when something new
       * arrives: `pnpm ig:layout` measured 161 against a ceiling of 160 the first time this
       * builder ran on the Autopilot page. Three round trips to partition 557 rows by two
       * columns is the wrong trade over an SSH tunnel, and the columns are tiny.
       *
       * `kind`/`brandCategory`/`campaignTalent`/`isVerified` are what the remaining guards
       * need, and they are COLUMNS — reading them costs nothing on a query already being made.
       */
      prisma.targetAccount.findMany({
        select: {
          id: true,
          handle: true,
          displayName: true,
          kind: true,
          brandCategory: true,
          campaignTalent: true,
          isVerified: true,
          role: true,
          optedOut: true,
        },
      }),
      prisma.detectedCampaign.findMany({
        where: { verdict: 'CAMPAIGN', postedAt: { gte: preloadFloor } },
        /* The enforcer's projection PLUS the publisher — `followUpSubject`'s filter input
           (strip the channel's own marks and name) so this tally can predict
           NO_DESCRIBABLE_POST by the composer's own rule. A join on a query already made,
           never a query per row. ONE line: the visible-channels grep carves it out by this
           exact shape. */
        // eslint-disable-next-line prettier/prettier
        select: { id: true, postedAt: true, caption: true, taggedAccounts: true, brands: true, target: { select: { handle: true, displayName: true } } },
      }),
      /**
       * ONE READ OF `OutreachAttempt` FOR THE WHOLE BUILDER (2026-09-04).
       *
       * This was THREE queries over one table — delivered, replied, in-flight-and-parked —
       * each with its own `where`. Three round trips over an SSH tunnel to partition rows by
       * columns already in the select is the trade this builder's own docblock refuses for
       * `targetAccount`, and `/` measured **161 against a ceiling of 160** the day two more
       * facts were needed. A budget is a ceiling over a bounded design; the answer is fewer
       * queries, never a bigger number.
       *
       * Four different facts come out of it and they want four different filters, all applied
       * in JS below:
       *   delivered        `status in DELIVERED && sentAt` — ALL-TIME, because rotation's
       *                    `lastSenderTo` is all-time and the ring rule wants each sender's
       *                    most recent delivery at any age.
       *   ever replied     `replyPostedAt` — never expires; retires the standard message.
       *   the active halt  that, windowed and unhandled — the gate's own `replyHaltWhere`.
       *   pending / parked `status in QUEUED|READY|SENDING`, and FAILED with a code.
       *
       * Ascending by `sentAt`, so the last write per (target, sender) still wins the map. A
       * reply row with no `sentAt` sorts first and the delivery loop skips it on `!sentAt`.
       */
      prisma.outreachAttempt.findMany({
        where: {
          OR: [
            { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
            { replyPostedAt: { not: null } },
            { status: { in: ['QUEUED', 'READY', 'SENDING'] } },
            { status: 'FAILED', failureCode: { not: null } },
          ],
        },
        select: {
          status: true,
          sentAt: true,
          replyPostedAt: true,
          replyHandledAt: true,
          failureCode: true,
          queuedAt: true,
          pair: { select: { targetId: true, senderId: true, sender: { select: { handle: true } } } },
        },
        orderBy: { sentAt: 'asc' },
      }),
      prisma.outreachPair.findMany({
        where: { sender: { fleetMember: true } },
        select: { id: true, targetId: true, senderId: true, sender: { select: { id: true, handle: true, cohort: true } } },
      }),
      eligibleFleetSenders(),
      readSenderAvailability(),
      /**
       * ── WHICH CAMPAIGNS EACH PAIR HAS ALREADY WRITTEN ABOUT, IN ONE QUERY ────
       *
       * This was `usedCampaignIds(electedPairId)` INSIDE the prospect loop — one round trip
       * per row, capped at `PAIR_PRECISION_LIMIT` so it could not run away. MEASURED
       * 2026-08-25 by logging the SQL: **50 of `buildRestTally`'s 62 queries were this one
       * call**, and because `/` and `/targets` both load this builder it put them at 182/160
       * and 148/120 — over the ceilings `pnpm ig:layout` enforces.
       *
       * The cap was the right answer while the query was per-row; the better answer is not to
       * be per-row. Same move `preloaded` already makes for the allowance one screen up: load
       * the superset ONCE and let the exact test run in JS.
       *
       * Two tiny columns over every attempt that carries a campaign — the same rows
       * `usedCampaignIds` would have read one pair at a time, minus the round trips. The
       * `status` filter is `IN_FLIGHT_STATUSES` verbatim rather than a hand-written list,
       * because a discarded draft must not burn a campaign and that rule lives there.
       */
      prisma.outreachAttempt.findMany({
        where: { campaignId: { not: null }, status: { in: [...IN_FLIGHT_STATUSES] } },
        /* `targetId` since the claim ledger went per RECIPIENT (2026-09-01): the selector
           excludes the whole recipient's claims, so this tally must too — see below. The
           denormalised column, exactly what `claimedCampaignIds` reads. */
        select: { pairId: true, targetId: true, campaignId: true },
      }),
      /* Which fleet each end belongs to — the follow-up copy is per fleet. React-cached, so
         this is free on a page whose other builders already ask for it. */
      readCategoryMemberships(),
    ])

  /** pairId → the campaigns that pair has already used. The map `usedCampaignIds` returned. */
  const usedByPair = new Map<string, string[]>()
  /**
   * targetId → every campaign ANY page has claimed against that recipient — the ledger's
   * own scope (2026-09-01). `freshCampaignsFor` excludes the UNION of the pair's uses and
   * the recipient's claims, so a tally that excluded only the pair's would report material
   * where the governor finds none: a post claimed by page A read as "fresh" here for pages
   * B–D, filing a fully-claimed company under the ring rule or "clear to write" instead of
   * under the material rules. Same rows, one more column, zero extra queries.
   */
  const claimedByTarget = new Map<string, string[]>()
  for (const row of campaignUsage) {
    if (row.campaignId === null) continue
    const list = usedByPair.get(row.pairId)
    if (list) list.push(row.campaignId)
    else usedByPair.set(row.pairId, [row.campaignId])
    const claims = claimedByTarget.get(row.targetId)
    if (claims) claims.push(row.campaignId)
    else claimedByTarget.set(row.targetId, [row.campaignId])
  }

  const prospects = targetRows.filter((t) => t.role === 'PROSPECT' && !t.optedOut)
  const retired = targetRows.filter((t) => t.role === 'PROSPECT' && t.optedOut).length
  const watchRows = targetRows.filter((t) => t.role === 'WATCH')
  const watched = watchRows.length

  /**
   * THE TWO FACTS `followUpSubject` NEEDS, and only one of them costs a query (2026-09-04).
   *
   * The competitor list is FREE: every target row is already in memory above, so the WATCH
   * partition is the same JS filter the count uses. The PERSON verdicts are one batched
   * `BrandLookup` read over the prospects on screen — a lookup per prospect would be the N+1
   * this builder's own docblock records killing.
   *
   * This panel PREDICTS what the governor refuses, so it must read the same two facts the
   * planner reads or it will promise a follow-up the planner will not write.
   */
  const watchChannels = watchMarksFrom(watchRows)
  const personHandles = await readPersonHandles(prospects.map((p) => p.handle))

  /**
   * WHICH RECIPIENTS HAVE EVER REPLIED — the second half of `isFollowUp` (2026-09-04).
   *
   * UNWINDOWED on purpose: this is not the seven-day halt above, it is the permanent fact that
   * a company has answered us, and once it has, no page sends them the standard message again.
   * The panel must read the same fact the planner does or it will predict a first touch the
   * planner will refuse to write.
   */
  /* The four partitions of the one read above. Plain JS over rows already in memory. */
  const deliveries = attempts.filter(
    (a) => a.sentAt !== null && (DELIVERED_STATUSES as readonly string[]).includes(a.status),
  )
  const inFlightAndParked = attempts.filter(
    (a) =>
      ['QUEUED', 'READY', 'SENDING'].includes(a.status) || (a.status === 'FAILED' && a.failureCode !== null),
  )
  const allReplies = attempts.filter((a) => a.replyPostedAt !== null)

  const everRepliedTargetIds = new Set(allReplies.map((r) => r.pair.targetId))

  /**
   * The ACTIVE halts — the windowed, unhandled subset of the same read. The filter is the one
   * `replyHaltWhere` builds for the gate, applied here in JS so the two cannot drift.
   */
  const replies = allReplies.filter(
    (r) =>
      r.replyHandledAt === null &&
      r.replyPostedAt !== null &&
      r.replyPostedAt >= replyHaltFloor(settings.replyResumeHours, now),
  )
  const pending = inFlightAndParked.filter((a) => a.status !== 'FAILED')
  /* `parkBlocksRoute`, the rule `readBlockedRoutes` applies for the planner: every park rests its
     route except an 'unreadable' one older than a week. Mirrored from the same function, not
     re-derived, or this panel would name a page the planner will not elect. */
  const parked = inFlightAndParked.filter((a) => a.status === 'FAILED' && parkBlocksRoute(a, now))

  /** The enforcer's own linkage, fed from one query. The floor is honoured — see the docblock. */
  const preloaded = {
    detectedCampaign: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) => {
        const floor: Date | undefined = args?.where?.postedAt?.gte
        return floor ? posts.filter((p) => p.postedAt >= floor) : posts
      },
    },
  }

  /** id → the post's brands and publisher, for the describable-post prediction. In memory already. */
  const postById = new Map(posts.map((c) => [c.id, c]))

  const lastBySenderPerTarget = new Map<string, Map<string, { sentAt: Date; handle: string }>>()
  /**
   * ── EVERY DELIVERY PER RECIPIENT, NOT THE LAST ONE PER SENDER (2026-08-26) ──
   *
   * The allowance was being fed `lastBySenderPerTarget`, which holds ONE entry per sender —
   * so `deliveredInWindow` was a count of DISTINCT PAGES (at most five) where the enforcer
   * counts DELIVERED MESSAGES (`plan.ts`, `gate.ts`: `outreachAttempt.count` over
   * DELIVERED_STATUSES). For a recipient who received eight messages from five pages the
   * planner sees 8 and this panel saw 5, so the panel could call a recipient CLEAR that the
   * planner refuses — a screen reporting a rule by a different rule than the one enforcing
   * it, in the panel whose entire job is explaining why nothing is sending.
   *
   * The per-sender map is still needed and still built: `crossSpacingVerdict` is a
   * per-SENDER question (the ring rule) and the release clock reads the allowance-th newest
   * delivery. Two shapes over one already-loaded array; no extra query.
   */
  const allDeliveriesPerTarget = new Map<string, Date[]>()
  const lastSenderPerTarget = new Map<string, string>()
  const deliveredPairKeys = new Set<string>()
  const sentTodayPairKeys = new Set<string>()
  for (const d of deliveries) {
    if (!d.sentAt) continue
    const list = allDeliveriesPerTarget.get(d.pair.targetId)
    if (list) list.push(d.sentAt)
    else allDeliveriesPerTarget.set(d.pair.targetId, [d.sentAt])
    const m = lastBySenderPerTarget.get(d.pair.targetId) ?? new Map<string, { sentAt: Date; handle: string }>()
    m.set(d.pair.senderId, { sentAt: d.sentAt, handle: d.pair.sender.handle })
    lastBySenderPerTarget.set(d.pair.targetId, m)
    lastSenderPerTarget.set(d.pair.targetId, d.pair.senderId)
    deliveredPairKeys.add(`${d.pair.targetId}:${d.pair.senderId}`)
    /* A delivery from THIS page to THIS recipient today (IST) — the same boundary the pair cap
       is counted against, so the two cannot name different days across midnight. */
    if (d.sentAt >= istDayStart(now)) sentTodayPairKeys.add(`${d.pair.targetId}:${d.pair.senderId}`)
  }

  /** Keyed by `replyHaltKey`, so this tally groups replies the way the gate scopes them. */
  const haltUntil = new Map<string, Date>()
  for (const r of replies) {
    if (!r.replyPostedAt) continue
    const at = new Date(r.replyPostedAt.getTime() + settings.replyResumeHours * 3_600_000)
    const key = replyHaltKey(settings.replyHaltScope, { senderId: r.pair.senderId, targetId: r.pair.targetId })
    const cur = haltUntil.get(key)
    if (!cur || at > cur) haltUntil.set(key, at)
  }

  const pendingTargets = new Set(pending.map((p) => p.pair.targetId))
  /**
   * Routes this recipient's pages cannot use, in the shape rotation wants.
   *
   * Since 2026-08-24 a parked route is not a per-RECIPIENT hold at all: rotation skips that
   * page and the recipient's other pages take their turn (`readBlockedRoutes`). So it is fed
   * into the same `unavailable` map the planner's rotation reads, rather than counted as a
   * reason — a page reporting a hold the enforcer stopped applying is the drift this whole
   * file is built to avoid. Where EVERY page is parked, `nextSender` answers
   * `all-unavailable` and it lands in the rotation-stuck bucket, named rather than silent.
   */
  const blockedRoutes = new Map<string, Map<string, string>>()
  const blockRoute = (targetId: string, senderId: string, why: string) => {
    const m = blockedRoutes.get(targetId) ?? new Map<string, string>()
    m.set(senderId, why)
    blockedRoutes.set(targetId, m)
  }
  for (const p of parked) {
    blockRoute(
      p.pair.targetId,
      p.pair.senderId,
      p.failureCode === 'not-in-thread'
        ? 'an earlier message from this page may already have reached them'
        : p.failureCode === 'unreadable'
          ? 'this page could not read its conversation with them, so it rests for a week'
          : `an earlier message from this page is parked (${p.failureCode})`,
    )
  }
  /**
   * ── AND A REPLY HALTS ONE PAGE, NOT THE RECIPIENT (2026-09-04) ────────────
   *
   * The same widening `readBlockedRoutes` makes for the planner, mirrored here from rows this
   * builder already holds. Without it this panel would name the halted page as "next" while the
   * planner elected a different one — a page reporting a rule by a different rule than the one
   * enforcing it, which is the drift this whole file exists to prevent.
   *
   * Only under the PAIR scope: when the halt is fleet-wide there is no clear page to pass to,
   * and the tally must not invent one. `haltUntil` above is keyed by `replyHaltKey`, which is
   * the target id under the target scope, so the pair check is the scope check.
   */
  if (settings.replyHaltScope === 'pair') {
    /* Every row in `replies` is already an ACTIVE halt — the query filters on the floor and on
       `replyHandledAt: null`, which is the same `where` the gate builds from `replyHaltWhere`. */
    for (const r of replies) {
      if (!r.replyPostedAt) continue
      blockRoute(r.pair.targetId, r.pair.senderId, 'they replied to this page, so it is holding for a week')
    }
  }

  const ringByTarget = new Map<string, { id: string; handle: string; cohort: number }[]>()
  const pairIdByKey = new Map<string, string>()
  for (const p of pairs) {
    const list = ringByTarget.get(p.targetId) ?? []
    list.push(p.sender)
    ringByTarget.set(p.targetId, list)
    pairIdByKey.set(`${p.targetId}:${p.senderId}`, p.id)
  }

  const buckets = new Map<string, { count: number; next: Date | null }>()
  /** Fleet slug → companies held for want of that fleet's follow-up copy. See the interface. */
  const noFollowUpByFleet: Record<string, number> = {}
  const bump = (reason: string, at: Date | null) => {
    const b = buckets.get(reason) ?? { count: 0, next: null }
    b.count += 1
    if (at && (b.next === null || at < b.next)) b.next = at
    buckets.set(reason, b)
  }

  let clear = 0
  let queued = 0
  let pairChecksSkipped = 0
  /** Bounded count of the one per-row query. See PAIR_PRECISION_LIMIT. */
  let pairChecksDone = 0

  for (const p of prospects) {
    /* VERIFIED ONLY, checked where the governor checks it — third of its stops, before the
       reply halt. Measured 0 today, and it must still be a bucket rather than an assumption:
       a row that fails this is refused forever and would otherwise be counted as capacity. */
    if (p.isVerified !== true) {
      bump(SKIP_REASONS.TARGET_NOT_VERIFIED, null)
      continue
    }

    /**
     * ── WHOSE TURN, COMPUTED BEFORE THE REPLY CHECK (2026-09-01) ──────────────
     *
     * Election is PURE and query-free here — a ring over maps already in hand — so hoisting
     * the computation above the reply check costs nothing, and it is now needed there: with
     * the halt PAIR-scoped (Tabish, 2026-09-01) "is this company reply-held?" has no answer
     * until you know WHICH page would write to them. A reply to a page that is not next in
     * the ring does not stop this company being written to at all.
     *
     * Only the COMPUTATION moved. The refusal below stays exactly where it was, so the bucket
     * ORDER is unchanged and `tests/rest-tally.test.ts`'s precedence assertions still describe
     * the planner's own order.
     */
    /* Filtered by fleet exactly as the planner's ring is (plan.ts) — a page the recipient's fleet
       refuses must not be elected here either, or this panel names a turn the planner never takes. */
    const ring = fleetRingOrder(ringMembersFor(ringByTarget.get(p.id) ?? [], p.handle, memberships))
    const turn = nextSender({
      ring,
      lastSenderId: lastSenderPerTarget.get(p.id) ?? null,
      unavailable: unavailableForTarget(unavailable, blockedRoutes, p.id),
      targetId: p.id,
    })

    /**
     * Under `pair` scope the halt belongs to ONE conversation, so this asks about the page
     * that would actually write. When rotation can elect nobody there is no conversation to
     * ask about, and the refusal below is the truer answer anyway.
     */
    const halt = haltUntil.get(
      /* `replyHaltKey` ignores the sender under `target` scope, so the empty string is only
         ever reached on a route that has no elected page under `pair` scope — where "no page
         would write" is the honest answer and the refusal below states it. */
      replyHaltKey(settings.replyHaltScope, { senderId: turn.ok ? turn.senderId : '', targetId: p.id }),
    )
    if (halt) {
      bump(SKIP_REASONS.TARGET_REPLIED, halt)
      continue
    }

    /* ALREADY WRITTEN, so not resting — see `resting` on the interface. Counted and skipped
       before every other rule, matching the governor's own precedence (`hasPendingAttempt` is
       checked there before the parked and material rules), so a company with a draft is never
       also attributed to a hold it is not waiting on. */
    if (pendingTargets.has(p.id)) {
      queued += 1
      continue
    }

    /* NOBODY CAN WRITE TO THEM — and this used to fall through to `clear`, which counted a
       recipient no account can reach as spare capacity. `nextSender` refuses with `empty-ring`
       or `all-unavailable`; either way the answer is that this company is going nowhere. */
    if (!turn.ok) {
      /* Two refusals, two facts — see NO_PAGE_FOR_FLEET. */
      bump(turn.reason === 'empty-ring' ? NO_PAGE_FOR_FLEET : ROTATION_STUCK, null)
      continue
    }
    const electedId = turn.senderId

    /* MESSAGES, not pages — the enforcer's own unit. See allDeliveriesPerTarget. */
    const inWindow = (allDeliveriesPerTarget.get(p.id) ?? [])
      .filter((sentAt) => sentAt >= allowanceFloor)
      .sort((a, b) => b.getTime() - a.getTime())
    const camps = await campaignsNamingHandleRows(preloaded, p, allowanceFloor)
    const material = materialAllowance({ campaignsInWindow: camps.length, deliveredInWindow: inWindow.length })
    if (material.held) {
      /* Two releases, both real: a NEW paid post raises the allowance, or the allowance-th
         newest delivery ages out of the window and lowers the count. The clock is reported and
         the row is NOT called self-releasing, because the paid post is the release Tabish's
         rule intends and it is the one that usually comes first. */
      const nth = inWindow[material.allowance - 1]
      /* `nth` is a Date now rather than a {sentAt} row — see allDeliveriesPerTarget. */
      /* Split on whether a paid post of theirs has been FOUND at all — see AWAITING_FIRST_POST. */
      bump(
        camps.length === 0 ? AWAITING_FIRST_POST : SKIP_REASONS.MATERIAL_EXHAUSTED,
        nth ? new Date(nth.getTime() + settings.defaultCooldownDays * 86_400_000) : null,
      )
      continue
    }

    /**
     * NOTHING NEW TO SAY — and it is asked BEFORE the ring rule because that is the order
     * `evaluatePair` asks them in (governor.ts: NO_NEW_MATERIAL, then TARGET_RECENTLY_CONTACTED).
     *
     * IT WAS THE OTHER WAY ROUND AND FOUR COMPANIES WERE FILED UNDER THE WRONG RULE. Measured by
     * running this tally and the planner side by side over all 473: they agreed on
     * resting-vs-not for 473 of 473 and on the exact RULE for 469 — the four misses were
     * @amazonmgmstudios, @amazonmgmstudiosin, @abhishek_as_it_is and @realpz, each held by both
     * rules, where this said "every one of our pages has written to them this week" (with a
     * release date) and the planner said "nothing new to reference". Both hold them, so the
     * headline never moved; the SENTENCE and the CLOCK were wrong, which is the whole point of
     * the breakdown. The order test now names this rule so the inversion cannot come back.
     *
     * It is the only hold that costs a query per row, so it stays bounded — and it can only fire
     * where the ELECTED pair has already delivered (`touchesSoFar > 0` in the governor), which is
     * a small set by construction because rotation elects the page AFTER whoever wrote last.
     */
    const key = `${p.id}:${electedId}`
    const electedPairId = pairIdByKey.get(key)
    if (electedPairId && (deliveredPairKeys.has(key) || everRepliedTargetIds.has(p.id))) {
      /**
       * NO LONGER CAPPED, because it no longer costs a query. `PAIR_PRECISION_LIMIT` existed
       * only to bound the round trips; with the usage preloaded above this is a map lookup,
       * so every prospect is now checked exactly and `pairChecksSkipped` is structurally 0 —
       * the breakdown stopped being an approximation above 80 rows as a side effect.
       */
      pairChecksDone += 1
      /* The selector's own exclusion: the pair's uses UNION the recipient's claims —
         `freshCampaignsFor` verbatim. Pair-only here would file a fully-claimed company
         under a later rule; see `claimedByTarget` above. */
      const used = new Set([...(usedByPair.get(electedPairId) ?? []), ...(claimedByTarget.get(p.id) ?? [])])
      /* `newMaterialFloor`, NOT the allowance window — that is the floor the governor's own
         query uses, and the two are genuinely different (72h vs 7 days). */
      const rows = await campaignsNamingHandleRows(preloaded, p, materialFloor)
      const unclaimed = rows.filter((r) => !used.has(r.id))
      if (unclaimed.length === 0) {
        bump(SKIP_REASONS.NO_NEW_MATERIAL, null)
        continue
      }
      /**
       * ── AND CAN ANY OF THEM BE DESCRIBED? (2026-09-01) ────────────────────
       *
       * The governor's next stop, in the governor's own position: a follow-up must say what
       * the post was about (the date-only fallback is deleted), so unclaimed posts none of
       * which `followUpSubject` attributes to this recipient hold the pair exactly as no
       * posts at all would. Same subject rule the composer picks with, over the preloaded
       * rows — no query per prospect.
       */
      const describable = unclaimed.some((r) => {
        const post = postById.get(r.id)
        return post
          ? followUpSubject(
              readStringArray(post.brands),
              post.target,
              { handle: p.handle, displayName: p.displayName, isPerson: personHandles.has(p.handle) },
              watchChannels,
            ) !== null
          : false
      })
      if (!describable) {
        bump(SKIP_REASONS.NO_DESCRIBABLE_POST, null)
        continue
      }
    }

    const spacing = crossSpacingVerdict({
      now,
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: electedId,
      /* Fleet-wide; the verdict narrows it to this recipient's fleet (M12), from the same
         memberships the ring above was filtered by. */
      eligibleSenders: eligibleFleet,
      targetHandle: p.handle,
      memberships,
      lastDeliveryBySender: lastBySenderPerTarget.get(p.id) ?? new Map(),
    })
    if (spacing.held) {
      bump(SKIP_REASONS.TARGET_RECENTLY_CONTACTED, spacing.resumesAt ?? null)
      continue
    }

    /**
     * ── AND HAS THIS PAGE ALREADY WRITTEN, WITH NOTHING NEW TO SAY IT WITH? ──
     *
     * The governor's LAST stop, in the governor's own position: everything above holds a
     * company for a reason a textarea cannot fix, so only what reaches here is genuinely
     * waiting on the follow-up copy. `deliveredPairKeys` is `touchesSoFar > 0` for the
     * ELECTED pair, which is exactly the condition the governor applies.
     */
    /* `isFollowUp`'s two facts, mirrored: this pair's own history OR a reply from this
       recipient to ANY page. A page that has never written to a company that has already
       answered us still writes a follow-up, never the introduction. */
    if (deliveredPairKeys.has(`${p.id}:${electedId}`) || everRepliedTargetIds.has(p.id)) {
      /* And a second message from ONE page waits for tomorrow — the governor's own arm, in the
         governor's own position, ahead of the template check for the same reason. */
      if (sentTodayPairKeys.has(`${p.id}:${electedId}`)) {
        bump(SKIP_REASONS.FOLLOW_UP_SAME_DAY, null)
        continue
      }
      const followUp = followUpForSettings(
        settings,
        /* The elected page's handle, from the ring already in hand — memberships are keyed by
           handle and a second lookup would be a query per row. */
        categoriesFor(memberships.bySenderHandle, ring.find((r) => r.senderId === electedId)?.handle ?? ''),
        categoriesFor(memberships.byTargetHandle, p.handle),
      )
      if (!followUp.ok) {
        bump(SKIP_REASONS.NO_FOLLOW_UP_TEMPLATE, null)
        /* Split by the fleet whose box would release it. `slug` is null only for the two
           refusals that are not "nobody wrote it" (cross-fleet, ambiguous), and neither is
           fixed by writing copy — so they are counted in the bucket and in no box. */
        if (followUp.slug) noFollowUpByFleet[followUp.slug] = (noFollowUpByFleet[followUp.slug] ?? 0) + 1
        continue
      }
    }

    /**
     * IS THIS RECIPIENT A PERSON? Asked LAST, because that is where `plan.ts` asks it — after
     * the governor and after rotation — so a person who is also material-held is attributed to
     * the material rule, exactly as the planner would report it.
     *
     * THIS IS THE GAP THAT MATTERED. Without it the tally read *"4 have nothing holding them
     * back"* while those four were @rahuldevofficial, @shalini.passi, @faisal_miya__photuwale
     * and @ksubbaraj — BRAND rows carrying a person-role category, refused permanently, never
     * written to since they were created on 12-13 August. A figure whose error direction
     * OVERSTATES capacity is the one kind this project cannot ship: it is the `MAX_TOTAL_SENDS`
     * failure, where a limit reported by a different rule than the one enforcing it read as
     * headroom.
     */
    const person = checkRecipientIsNotAPerson({
      targetKind: p.kind,
      brandCategory: p.brandCategory,
      handle: p.handle,
      campaignTalent: p.campaignTalent,
    })
    if (!person.ok) {
      bump(BRAND_BLOCKS.RECIPIENT_IS_A_PERSON, null)
      continue
    }

    clear += 1
  }

  const byReason: RestReason[] = [...buckets.entries()]
    .map(([reason, b]) => {
      const rule = REST_RULES[reason]
      /* A bucket with no sentence would render an empty line on a page a CEO reads.
         `tests/rest-tally.test.ts` asserts the table is total over every reason this can
         emit, so reaching here means a reason was added without one — say so rather than
         showing nothing, and fail the test that should have caught it. */
      return {
        reason,
        label: rule?.label ?? `held by ${reason}`,
        count: b.count,
        needsAPerson: rule?.needsAPerson ?? true,
        nextReleaseAt: b.next,
        clockLabel: rule?.clock ?? null,
      }
    })
    .sort((a, b) => b.count - a.count)

  const resting = byReason.reduce((n, r) => n + r.count, 0)
  /* resting + clear + queued === total, by construction: every prospect takes exactly one of
     the three paths in the loop above. Asserted in tests/rest-tally.test.ts against live data. */
  const clocks = byReason.map((r) => r.nextReleaseAt).filter((d): d is Date => d !== null)

  return {
    total: prospects.length,
    resting,
    clear,
    queued,
    retired,
    noFollowUpByFleet,
    watched,
    byReason,
    nextRelease: clocks.length > 0 ? new Date(Math.min(...clocks.map((d) => d.getTime()))) : null,
    needingAPerson: byReason.filter((r) => r.needsAPerson).reduce((n, r) => n + r.count, 0),
    pairChecksSkipped,
    measuredAt: now,
  }
}
