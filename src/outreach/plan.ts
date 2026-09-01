import { prisma } from '@/lib/db'
import { templateForSettings, type FleetTemplate } from './fleetTemplate'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { istDayStart } from '@/lib/time'
import { newMaterialFloor } from '@/lib/cutoff'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { evaluatePair, type GovernorDecision } from './governor'
import { crossSpacingVerdict } from './crossSpacing'
import { materialAllowance, campaignsNamingHandle, campaignsNamingHandleRows } from './materialAllowance'
import { eligibleFleetSenderIds } from './availability'
import { routeAllowed } from './routes'
import { readCategoryMemberships, categoriesFor } from './categories'
import { composeForPair, freshCampaignsFor } from './compose'
import {
  followUpForSettings,
  followUpPostReference,
  followUpSubject,
  renderFollowUp,
  type FollowUpTemplate,
} from './followUpTemplate'
import { readStringArray } from '@/lib/json'
import { describeRing, whoseTurn, type WhoseTurnResult } from './categories'
import { fleetRingOrder } from './rotation'
import { checkNewBrandTouchCap, checkRecipientIsNotAPerson } from './brandGuards'
import { readNewBrandTouchCounts } from './brandTouchCounts'
/**
 * The ONLY sender this file imports, since Phase 5. `browserSender` was here too and is
 * deliberately not any more: the planner prepares and `dispatchTick` delivers, so a second
 * import of something that drives a browser is the thing to notice if it ever comes back.
 */
import { manualAssistSender } from './senders/manual'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from './sessionHealth'
import { readSenderAvailability } from './availability'
import { replyHaltWhere } from './replyHalt'
import type { SendOutcome } from './senders/types'

/**
 * The outreach half of one slot: for every routing pair, ask the governor whether
 * it may be contacted, and if so build and dispatch the message.
 *
 * Detection is intentionally NOT a precondition. If the classifier breaks or the
 * channel simply had a quiet day, outreach still runs with an empty hook line. A
 * monitoring subsystem must never be able to silence the thing it monitors —
 * "sends nothing, reports nothing wrong" is the failure mode that actually costs
 * money.
 */

export interface PlanOutcome {
  pairKey: string
  eligible: boolean
  skipReason?: string
  skipDetail?: string
  attemptId?: string
  status?: string
  hookLine?: string | null
  error?: string
  /** Instagram showed a checkpoint on this dispatch. Halts the account for the rest of the run. */
  challenged?: boolean
}

export interface PlanSummary {
  outcomes: PlanOutcome[]
  queued: number
  sent: number
  failed: number
  skipped: number
}

/**
 * ONE SWITCH: ROUTES ARE NOT CHOSEN, THEY EXIST. Tabish, 2026-08-08 — *"The moment
 * autopilot is turned on there must be no more switches."*
 *
 * Every fleet sender is paired with every messageable target. `OutreachPair.enabled` and
 * the per-route chips that wrote it are gone (see the docblock where `PAIR_DISABLED` used
 * to be, in governor.ts), so a route no longer needs anyone's permission to exist.
 *
 * RETIREMENT IS `target.optedOut`, NEVER A MISSING ROW. That is the load-bearing part of
 * this design: a pair row is now created automatically, so "we removed the row" could not
 * survive one run as a way of never contacting somebody. `optedOut` is on the TARGET, is
 * checked independently by the governor and again by `gate.ts` at delivery, and is what
 * `removeTarget` sets. Retired targets are excluded here too, but only as housekeeping —
 * the promise is kept by the governor, not by this filter.
 *
 * THE EXCLUSIONS LIVE IN `routes.ts`, NOT HERE. `mayRouteExist` is the one definition of
 * which routes may exist — never self-pair, never pair one of OUR OWN PAGES to another,
 * never pair a retired target — and it is shared with every other path that creates a pair
 * row. It had to be extracted: MEASURED 2026-08-08, FIVE other paths created pairs directly
 * and applied none of it, `addTarget` being the live hole (it read every sender with no
 * filter, so adding `@bollywoodsocietyy` as a watched channel created two routes from our
 * own revenue pages to another). See the docblock there for the full reasoning, and
 * `tests/one-route-rule.test.ts` for what keeps the callers honest.
 *
 * The burner (`fleetMember: false`) gets no pairs at all: it is excluded from `fleet`
 * here and from the pairs query in `runOutreach`. Rehearsal sending to it stays reachable
 * through the on-demand path, which is a person pressing a button.
 *
 * IDEMPOTENT, AND NOT VIA `skipDuplicates`. This runs at the top of EVERY slot, so a second
 * call must create nothing and throw nothing. The obvious spelling —
 * `createMany({ skipDuplicates: true })` — is a PROVIDER TRAP and was caught by running it:
 *
 *   MEASURED on the generated clients, 2026-08-08: `skipDuplicates` appears 4 times in the
 *   POSTGRES client's `OutreachPairCreateManyArgs` and ZERO times in the SQLITE one (Prisma
 *   does not support it on SQLite). Production is Postgres and the test suite regenerates
 *   the SQLite client, so `pnpm typecheck` PASSED against Postgres while every call threw
 *   `Unknown argument 'skipDuplicates'` under the tests. A guard whose idempotency depends
 *   on which provider generated the client is not idempotent.
 *
 * So the existing rows are read and subtracted instead, which behaves identically on both
 * providers. `@@unique([senderId, targetId])` (verified present on the SQLite schema and on
 * the generated Postgres one) is still the real backstop: read-then-create is not atomic,
 * so two overlapping slots could both compute the same missing pair. That collision throws
 * P2002 rather than duplicating, and the next slot finds the row already there — the
 * conservative direction, and the reason the constraint must never be dropped.
 *
 * `enabled: true` is vestigial — nothing has read it since the switch was removed — but the
 * column is still NOT NULL, so it is still written. Whoever drops the column drops this.
 */
export async function ensureFleetPairs(): Promise<{ created: number }> {
  const [fleet, messageable, existing] = await Promise.all([
    prisma.senderAccount.findMany({
      where: { fleetMember: true },
      select: { id: true, handle: true, fleetMember: true },
    }),
    prisma.targetAccount.findMany({ where: { optedOut: false }, select: { id: true, handle: true, role: true } }),
    prisma.outreachPair.findMany({ select: { senderId: true, targetId: true } }),
  ])

  /**
   * The same set `fleetHandles()` returns, derived from the `fleet` read above rather than
   * asked for again — this function already holds exactly `where: { fleetMember: true }`.
   * The helper exists for the four callers that do NOT have that list in hand.
   */
  const ourHandles = new Set(fleet.map((s) => s.handle))
  /* One read for the whole sender × target walk below. */
  const memberships = await readCategoryMemberships()
  const already = new Set(existing.map((p) => `${p.senderId} ${p.targetId}`))

  const data = fleet.flatMap((s) =>
    messageable
      .filter((t) =>
        routeAllowed({
          senderHandle: s.handle,
          targetHandle: t.handle,
          senderCategories: categoriesFor(memberships.bySenderHandle, s.handle),
          targetCategories: categoriesFor(memberships.byTargetHandle, t.handle),
          ourHandles,
          // Read from the ROW, not written as `true` beside a query that says so. The
          // query and the literal are two statements of one fact and they drift; this
          // selects the column instead, so the predicate cannot disagree with the filter.
          senderIsFleetMember: s.fleetMember,
          // Already excluded by the query above; passed explicitly so the predicate is
          // asked the whole question rather than a convenient subset of it.
          targetOptedOut: false,
          // Read from the ROW for the same reason as `senderIsFleetMember` above. NOT
          // filtered in the query deliberately: a route that must not exist should be
          // REFUSED by the one predicate that defines routes, not quietly absent because
          // a `where` happened to exclude it. The 2026-08-13 lesson — excluding at the
          // query leaves the row and one query that happens not to read it.
          targetIsWatchOnly: t.role === 'WATCH',
        }),
      )
      .filter((t) => !already.has(`${s.id} ${t.id}`))
      .map((t) => ({
        senderId: s.id,
        targetId: t.id,
        cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
        enabled: true,
      })),
  )

  if (data.length === 0) return { created: 0 }

  const { count } = await prisma.outreachPair.createMany({ data })
  if (count > 0) log.info('created outreach pairs for the fleet', { created: count })
  return { created: count }
}

export async function runOutreach(): Promise<PlanSummary> {
  const settings = await getSettings()
  const now = new Date()
  const dayStart = istDayStart(now)

  await ensureFleetPairs()

  /**
   * Scoped to the FLEET. `ensureFleetPairs` only ever creates fleet rows, but historical
   * pairs for a non-fleet sender exist on disk — `@tabishmukaddam1`, the burner, has them —
   * and with the per-route switch gone there is nothing else left to keep those out of an
   * unattended run. The filter is the stop, so it belongs in the query rather than in a
   * `continue` further down where a later refactor could lose it.
   */
  const pairs = await prisma.outreachPair.findMany({
    where: { sender: { fleetMember: true } },
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })

  // Lifetime in-flight count: delivered, replied, OR prepared and waiting. Counting
  // the waiting ones is what makes MAX_TOTAL_SENDS=1 mean "one message exists",
  // rather than "one message was delivered while three more sat queued".
  // Incremented locally below so the ceiling also holds within a single slot.
  let totalSentEver = await prisma.outreachAttempt.count({
    where: { status: { in: [...IN_FLIGHT_STATUSES] } },
  })
  if (env.MAX_TOTAL_SENDS !== null && totalSentEver >= env.MAX_TOTAL_SENDS) {
    log.warn('lifetime send ceiling reached — sending nothing', {
      sent: totalSentEver,
      ceiling: env.MAX_TOTAL_SENDS,
      raiseWith: 'MAX_TOTAL_SENDS in .env',
    })
  }

  const outcomes: PlanOutcome[] = []

  /**
   * The in-run daily counters are GONE, and the cap they served is stronger than before.
   *
   * They existed because this loop delivered messages, so "how many has this target had
   * today" could change while the loop ran and the database count alone was stale. This
   * loop no longer delivers, so nothing here can move either number — the maps would be
   * read on every pair and written by nothing, which is a guard that cannot fire dressed
   * as one that can.
   *
   * The cap is enforced where the message actually goes out: `claimForAttempt` puts the
   * condition inside a write on a unique key, so two concurrent claimers cannot both pass
   * it. That is strictly better than a counter local to one run, which could never see a
   * dispatcher tick or the dashboard's Send button in another process.
   */

  /**
   * `challengedThisRun` is GONE from the planner, deliberately, and the equivalent set in
   * `deliver.ts` is not.
   *
   * It tracked accounts Instagram flagged DURING this run so no later pair would drive the
   * same profile again. That was necessary while the planner drove browsers. It no longer
   * does — nothing in this function can produce a checkpoint — so the set could never be
   * populated, and a guard whose trigger no code path can reach is the exact anti-pattern
   * this project keeps finding. It reads as thorough while doing nothing.
   *
   * What replaces it is not weaker: `deliver.ts` keeps both its own in-run set AND the
   * live status re-read immediately before opening a browser, and that is now the only
   * place a browser is opened to send.
   *
   * The live status read below stays, and covers what anything ELSE did — a dispatcher
   * tick, the dashboard, a concurrent CLI — so a draft is not prepared for an account that
   * has just been flagged.
   */

  /**
   * How many brands were opened for the FIRST time today — WRITTEN and DELIVERED, kept
   * apart. `brandTouchCounts.ts` holds both queries and the reasoning; the short version is
   * that this used to be one number counted over deliveries, nothing has ever been
   * delivered, so it was permanently 0 and only the per-run counter below bound. That made
   * "2 a day" mean "2 a run" — and once drafting joined the 15-minute clock it would have
   * meant ~192 a day.
   */
  const newBrandTouches = await readNewBrandTouchCounts(dayStart)
  /** ...and within this run, or every queued brand would pass the same stale check. */
  let brandFirstTouchesThisRun = 0

  /**
   * Every OTHER sender's persona, per sender. Distinctness is a property of the SET, so
   * the comparison needs all of them; loading once avoids a query per pair.
   */
  /**
   * Which accounts rotation must SKIP, with the reason.
   *
   * Built once per run and passed into the ring rather than re-derived inside it, so
   * `rotation.ts` stays pure. The reasons are carried as text because a refusal that
   * says "every sender is unavailable — alpha: flagged; bravo: never signed in" is
   * actionable and "nothing happened" is not.
   *
   * ── EVERY FACT HERE IS MACHINE-INDEPENDENT, AND THAT IS DELIBERATE ──────
   *
   * This map used to end with `!profileStatus(s.handle).hasSession` — a FILESYSTEM check
   * for a Chrome profile. It was harmless only because rotation was inert: `whoseTurn`
   * returned null for a target in no group, `Category` has always had 0 rows, and both
   * branches below read `if (turn && …)`, so the map was computed and never consulted.
   *
   * MEASURED 2026-08-13, before making rotation binding: the planner runs on the LINODE
   * (`schedulerHeartbeat` reads `machine: linode-detect`; every waiting draft was written
   * at :30/:31 UTC by the slot path there) and that host has **no `~/.ds-sales-agent`
   * directory at all** — profiles live on each operator's own device and the server may
   * never send. So the filesystem answer is `false` for EVERY account on the one machine
   * that drafts, and feeding it into a now-binding rotation would have returned
   * `all-unavailable` for every recipient and stopped drafting fleet-wide — silently, and
   * looking exactly like a planner that ran and found nothing to do.
   *
   * `readSenderAvailability` is the honest replacement, and it is SHARED with the dashboard
   * and with `ig:dedupe-drafts` so a page can never name a different account than the
   * planner will actually use. It asks only whether a hand login was once RECORDED
   * (`sessionPath`) and nothing has since PROVED it dead (`sessionInvalidAt`) — weaker than
   * `sessionUsable` on purpose, because it decides only whose turn it is to be WRITTEN to.
   * Whether a message may go OUT is re-asked at delivery by `gate.ts`, on the device that
   * actually sends, which is where it belongs.
   */
  const unavailableSenders = await readSenderAvailability()

  /**
   * The fleet ring per recipient, from the routes that ALREADY EXIST.
   *
   * `pairs` is scoped to `fleetMember: true` above, so grouping it is exactly the set of
   * senders allowed to write to each target — the `routes.ts` exclusions are already
   * applied to it. Building the ring any other way risks electing a sender with no route,
   * which would skip every real pair and write nothing while reporting a turn taken.
   *
   * Assembled once rather than per pair. `whoseTurn` is a function of the TARGET, so at 4
   * senders × 70 targets it would otherwise ask the same question 280 times to get 70
   * answers — and each one is three queries across an SSH tunnel at ~30 ms.
   */
  const fleetRingByTarget = new Map<string, ReturnType<typeof fleetRingOrder>>()
  {
    const sendersByTarget = new Map<string, { id: string; handle: string; cohort: number }[]>()
    for (const p of pairs) {
      const list = sendersByTarget.get(p.targetId) ?? []
      list.push({ id: p.sender.id, handle: p.sender.handle, cohort: p.sender.cohort })
      sendersByTarget.set(p.targetId, list)
    }
    for (const [targetId, rows] of sendersByTarget) fleetRingByTarget.set(targetId, fleetRingOrder(rows))
  }
  /** One answer per target, reused across that target's pairs. See above. */
  const turnByTarget = new Map<string, WhoseTurnResult>()

  /**
   * The ring rule's "all our pages" set — ONE query per run, not per pair. `/`'s query
   * budget is a ceiling over a bounded design, and this loop already runs per pair.
   */
  const eligibleSenderIds = await eligibleFleetSenderIds()

  /**
   * Which fleet each end belongs to — TWO queries for the whole run, not one per pair.
   * `templateForSettings` below reads it, and a lookup inside the loop would be an N+1 over
   * senders x targets, the defect this codebase has killed four times.
   */
  const memberships = await readCategoryMemberships()
  /**
   * Bodies each pair has already DELIVERED — one query for the whole run, not one per pair.
   * The planner walks every pair, and a read in there is the N+1 this file has killed four
   * times. Only the bodies are selected; nothing else is needed.
   */
  const deliveredBodiesByPair = new Map<string, string[]>()
  for (const row of await prisma.outreachAttempt.findMany({
    where: { status: { in: [...DELIVERED_STATUSES] } },
    select: { pairId: true, renderedBody: true },
  })) {
    const list = deliveredBodiesByPair.get(row.pairId)
    if (list) list.push(row.renderedBody.trim())
    else deliveredBodiesByPair.set(row.pairId, [row.renderedBody.trim()])
  }

  /**
   * WHAT EACH PAID POST WAS ABOUT — one query for the whole run, never one per pair.
   *
   * The planner decides `repeatsADeliveredBody` by rendering the EXACT follow-up body it
   * would write, and that body now names the post's subject when there is exactly one
   * (Tabish, 2026-09-01). The subject needs the post's `brands` and its PUBLISHER — the
   * latter only so `followUpSubject` can strip the channel's own marks and its own name out,
   * which is what keeps a competitor from being named. Resolving either per pair would be an
   * N+1 over senders x targets, the defect this file has killed four times.
   */
  const campaignSubjectById = new Map<string, { brands: string; publisher: { handle: string; displayName: string | null } }>(
    (
      await prisma.detectedCampaign.findMany({
        where: { verdict: 'CAMPAIGN', postedAt: { gte: newMaterialFloor(now) } },
        select: { id: true, brands: true, target: { select: { handle: true, displayName: true } } },
      })
    ).map((c) => [c.id, { brands: c.brands, publisher: c.target }]),
  )

  const fleetTemplateFor = (p: { sender: { handle: string }; target: { handle: string } }) =>
    templateForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, p.sender.handle),
      categoriesFor(memberships.byTargetHandle, p.target.handle),
    )

  /** What a SECOND message on this route says, from the same pure rule the gate asks. */
  const followUpTemplateFor = (p: { sender: { handle: string }; target: { handle: string } }): FollowUpTemplate =>
    followUpForSettings(
      settings,
      categoriesFor(memberships.bySenderHandle, p.sender.handle),
      categoriesFor(memberships.byTargetHandle, p.target.handle),
    )


  for (const pair of pairs) {
    const pairKey = `${pair.sender.handle}→${pair.target.handle}`

    /**
     * Campaigns for this target that this pair has NOT already written about. This is
     * what makes a follow-up a genuinely new message rather than a repeat.
     *
     * The definition of "used" lives in `compose.ts` and is called from here rather than
     * spelled out, because it was spelled out twice and the two copies disagreed: the
     * IN_FLIGHT filter existed in the composer and not in this count, so every discarded
     * draft burned a campaign for the NO_NEW_MATERIAL gate while the hook lookup still
     * considered it available. The since-retired `pnpm burner on` mass-SKIPped drafts by
     * design, so rehearsal mode silently consumed the pool — measured at 2 of 4 already gone
     * on one pair — until the gate reported no-new-material with fresh campaigns sitting
     * right there. The command is gone; anything else that mass-SKIPs drafts revives this.
     */
    const windowFloor = new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000)
    const [touches, replied, pairToday, ringDeliveries, pending, parked, freshCampaigns, targetCampaigns, targetDelivered] = await Promise.all([
      /**
       * Both counts here use DELIVERED_STATUSES, not 'SENT'.
       *
       * `REPLIED` replaces `SENT`, so a bare 'SENT' filter means **a reply loosens a
       * guard** — precisely backwards.
       */
      prisma.outreachAttempt.count({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
      }),
      prisma.outreachAttempt.findFirst({
        /* A reply halts for replyResumeHours (7 days), then releases itself; PAIR-scoped
           since 2026-09-01 on Tabish's instruction, `target` one Setting row away. The
           `where` is built by replyHalt.ts so the planner, the gate, the on-demand dialog
           and the screens that predict a hold cannot answer differently. */
        where: replyHaltWhere({
          scope: settings.replyHaltScope,
          senderId: pair.senderId,
          targetId: pair.targetId,
          resumeHours: settings.replyResumeHours,
          now,
        }),
        orderBy: { repliedAt: 'desc' },
        select: { repliedAt: true },
      }),
      // Five per day from THIS account to THIS recipient. Counted per pair, matching the gate.
      prisma.outreachAttempt.count({
        where: {
          pairId: pair.id,
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: dayStart },
        },
      }),
      /**
       * Every page's newest in-window delivery to this recipient — the ring rule's input
       * (crossSpacing.ts, 2026-08-19). Self INCLUDED on purpose: the predicate needs it to
       * answer "has EVERY page written", and never holds on self alone. Ascending order so
       * the map keeps each sender's newest.
       */
      prisma.outreachAttempt.findMany({
        where: {
          pair: { targetId: pair.targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000) },
        },
        orderBy: { sentAt: 'asc' },
        select: { sentAt: true, pair: { select: { senderId: true, sender: { select: { handle: true } } } } },
      }),
      // SENDING included: a browser mid-send is the most pending an attempt gets.
      prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: ['QUEUED', 'READY', 'SENDING'] } } }),
      /**
       * AN UNSETTLED PARKED FAILURE ON THIS PAIR — the duplicate guard (2026-08-21).
       *
       * FAILED appears in neither of the two counts above, so before this a parked attempt
       * made the pair look untouched and the planner drafted a fresh FIRST touch. MEASURED:
       * @bollywoodchronicle sent @indiagatefoods the identical message twice, 07:30 parked
       * `not-in-thread` and 12:39 delivered; and @sohamrockstrent collected six parked
       * drafts at three attempts each. `not-in-thread` is preferred when both exist because
       * "they may already have it" is the graver fact and deserves the sentence.
       */
      prisma.outreachAttempt.findFirst({
        where: { pairId: pair.id, status: 'FAILED', failureCode: { not: null } },
        orderBy: [{ failureCode: 'asc' }, { queuedAt: 'desc' }],
        select: { failureCode: true },
      }),
      /**
       * Is there anything NEW worth writing about?
       *
       * `newMaterialFloor` takes whichever is LATER: the hook-age window
       * (HOOK_MAX_AGE_HOURS, 72) or the detection cutoff (1 August). Both bound the same
       * question, and taking the later of the two means neither can be loosened by the
       * other.
       *
       * MEASURED, and not what it looks like: at HOOK_MAX_AGE_HOURS=72 from 3 August the
       * hook window reaches back to 31 Jul 12:00 UTC, which is EARLIER than the cutoff
       * (31 Jul 18:30 UTC = 1 Aug 00:00 IST). So the CUTOFF is the binding rule today.
       * Reading `hoursAgo(72)` and assuming the cutoff is redundant is wrong by six and a
       * half hours — the kind of near-miss an IST/UTC boundary produces.
       *
       * ── AND THE ROWS COME FROM THE SHARED LINKAGE NOW (2026-08-22) ─────────
       *
       * This was `count({ targetId: pair.targetId, … })` — a FOURTH copy of "campaigns for
       * this recipient", and `targetId` on `DetectedCampaign` is the CHANNEL THAT POSTED,
       * so it returned 0 for every prospect and `NO_NEW_MATERIAL` refused every follow-up
       * to every prospect permanently. `compose.ts` held the same bug for the on-demand
       * path; the allowance's own copy was fixed a day earlier and these two were not,
       * because nothing compared them. MEASURED: @amazonmgmstudios, 17 paid posts naming
       * it inside the window, 5 messages, capped forever — and 40 recipients the allowance
       * would have permitted another message to, every one refused by every sender.
       *
       * One implementation (`campaignsNamingHandleRows`), and `tests/naming-linkage.test.ts`
       * greps for a reintroduced `targetId` copy, because the defect is a query somebody
       * writes next rather than one that is here now.
       *
       * ── AND THE EXCLUSION IS THE SHARED SELECTOR NOW (2026-09-01) ──────────
       *
       * This filtered `usedCampaignIds(pair.id)` inline — a THIRD reading of a question
       * `compose.ts` answers twice. That was survivable while the exclusion was pair-scoped
       * and identical in all three; with the claim ledger it is not, because a count that
       * excluded only this pair's claims while `pickHook` excluded the whole recipient's
       * would let the governor report "there is new material" and the composer then find
       * none — a follow-up permitted with nothing to cite. `freshCampaignsFor` is the one
       * selector; the ROWS come back so the exact body can be rendered below.
       */
      freshCampaignsFor({ target: pair.target, targetId: pair.targetId, pairId: pair.id, now }),
      /**
       * ── THE RECIPIENT'S ALLOWANCE (2026-08-21) ─────────────────────────────
       *
       * Distinct paid posts naming this recipient inside the window, and messages ANY of our
       * pages delivered to them inside the SAME window. Target-scoped on purpose: the
       * per-pair versions above are what let one paid post fund five messages, because the
       * same campaign reads as "unused" for every sender and each sender's own first touch is
       * exempt from the pair rule. See materialAllowance.ts.
       */
      /**
       * Campaigns NAMING the recipient, not campaigns POSTED by them — `targetId` on
       * DetectedCampaign is the channel that posted, so the old count was zero for every
       * prospect forever and the unlock ("another paid post earns another message") could
       * never fire. Measured: skipped=851, queued=0, the whole fleet quiet. See
       * campaignsNamingHandle.
       */
      campaignsNamingHandle(prisma, { handle: pair.target.handle, displayName: pair.target.displayName }, windowFloor),
      prisma.outreachAttempt.count({
        where: {
          pair: { targetId: pair.targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: windowFloor },
        },
      }),
    ])

    const decision: GovernorDecision = evaluatePair({
      now,
      sender: { status: pair.sender.status },
      target: { optedOut: pair.target.optedOut, isVerified: pair.target.isVerified },
      touchesSoFar: touches,
      targetRepliedAt: replied?.repliedAt ?? null,
      pairSentTodayCount: pairToday,
      maxPerPairPerDay: settings.maxPerPairPerDay,
      crossSpacing: crossSpacingVerdict({
        now,
        windowDays: settings.defaultCooldownDays,
        crossPageGapHours: settings.crossPageGapHours,
        thisSenderId: pair.senderId,
        eligibleSenderIds,
        lastDeliveryBySender: new Map(
          ringDeliveries
            .filter((r) => r.sentAt !== null)
            .map((r) => [r.pair.senderId, { sentAt: r.sentAt!, handle: r.pair.sender.handle }]),
        ),
      }),
      hasPendingAttempt: pending > 0,
      parkedFailureCode: parked?.failureCode ?? null,
      /**
       * One message per detected paid post, asked about the RECIPIENT (2026-08-21). Both
       * counts over the same window — see materialAllowance.ts for why that matters.
       */
      material: materialAllowance({ campaignsInWindow: targetCampaigns, deliveredInWindow: targetDelivered }),
      unusedCampaignCount: freshCampaigns.length,
      totalSentEver,
      maxTotalSends: env.MAX_TOTAL_SENDS,
      /**
       * NOTHING IS DRAFTED FOR A FLEET WITH NO COPY (2026-08-26). The same pure rule the
       * gate and the composer ask, so a draft that passes here is a draft the composer can
       * actually write and the gate will not hold.
       */
      fleetTemplate: fleetTemplateFor(pair),
      followUpTemplate: followUpTemplateFor(pair),
      /**
       * ── WOULD THIS BE THE SAME BYTES THEY ALREADY HAVE? (2026-08-26) ────────
       *
       * With `singleTemplate` on, the body IS the fleet's template, so this is knowable
       * before composing. Measured: a byte-identical second message from one page to one
       * recipient is accepted by the composer and never delivered — 83% of touch-2 sends,
       * and six of six read threads showed the second message simply absent.
       *
       * Asked against the SAME template object the decision above is made with, so the
       * governor and the composer cannot disagree about what would be written.
       *
       * ── AND A FOLLOW-UP IS A DIFFERENT BODY, SO IT IS RENDERED (2026-09-01) ──
       *
       * A second message takes the FOLLOW-UP copy naming the post it claims, so comparing
       * against the first-touch template would be asking about a body that will not be
       * written. The exact bytes are rendered here from the same three inputs the composer
       * will use — the same template object, the same newest unclaimed post from the same
       * shared selector, the same `renderFollowUp`.
       *
       * A PREDICTION WOULD NOT HAVE BEEN ENOUGH, and the reason is specific: two paid posts
       * from ONE channel on ONE IST day produce the SAME reference, hence identical bytes.
       * Guessing "a follow-up always differs" would write a draft the gate then refuses as
       * a repeat — and `hasPendingAttempt` blocks a replacement, so that pair is wedged
       * until a person discards it. That is the self-locking stall this file records twice
       * (the parked-route one, and @madaboutmarketingg's fifteen recipients).
       */
      repeatsADeliveredBody: (() => {
        if (!settings.singleTemplate) return false
        const delivered = deliveredBodiesByPair.get(pair.id) ?? []
        if (delivered.length === 0) return false

        if (touches > 0) {
          const f = followUpTemplateFor(pair)
          /* No copy and no material are refusals in their own right, named above and below.
             Answering "would it repeat?" about a body that cannot exist would put the wrong
             sentence on the queue. */
          if (!f.ok) return false
          const newest = [...freshCampaigns].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())[0]
          if (!newest) return false
          const about = campaignSubjectById.get(newest.id)
          const subject = about
            ? followUpSubject(readStringArray(about.brands), about.publisher, pair.target)
            : null
          return delivered.includes(
            renderFollowUp(f.body, followUpPostReference({ postedAt: newest.postedAt, subject })).trim(),
          )
        }

        const t = fleetTemplateFor(pair)
        if (!t.ok) return false
        return delivered.includes(t.body.trim())
      })(),
    })

    if (!decision.eligible) {
      outcomes.push({ pairKey, eligible: false, skipReason: decision.reason, skipDetail: decision.detail })
      continue
    }

    /**
     * ── ROTATION ──────────────────────────────────────────────────────────
     *
     * If this target belongs to a category, only ONE sender writes to it this time —
     * the next in the ring — and every other pair for that target is skipped.
     *
     * Applied AFTER the governor rather than instead of it. Rotation answers "whose
     * turn", never "may we": a pair that fails cooldown, the reply halt, the caps or
     * the lifetime ceiling has already been refused above, and rotation must not be
     * able to resurrect it.
     *
     * A target in NO category IS NOW ROTATED THROUGH THE FLEET — since 2026-08-13 this is
     * the normal path, not the exemption. The sentence that stood here said "a target in NO
     * category behaves exactly as before — every enabled pair is considered independently",
     * offered as what made the phase shippable. `Category` never gained a row, so that
     * exemption was the only behaviour there had ever been, and what it produced was
     * measured: 8 recipients holding a draft from more than one sender, 7 of them from all
     * three, near-identical bodies under one phone number and one email.
     *
     * `whoseTurn` cannot return null any more, so there is no branch left that means
     * "everybody writes".
     */
    let turn = turnByTarget.get(pair.targetId)
    if (turn === undefined) {
      turn = await whoseTurn({
        targetId: pair.targetId,
        unavailable: unavailableSenders,
        fleet: fleetRingByTarget.get(pair.targetId) ?? [],
      })
      turnByTarget.set(pair.targetId, turn)
    }
    if (turn.choice.ok && turn.choice.senderId !== pair.senderId) {
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: 'not-this-senders-turn',
        skipDetail: `@${turn.choice.handle} is next in ${describeRing(turn)}`,
      })
      continue
    }
    if (!turn.choice.ok) {
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: turn.choice.reason,
        skipDetail: turn.choice.detail,
      })
      continue
    }

    /**
     * ── THE PERSONA GATE AND PERSONA VALIDATION ARE GONE (2026-08-18) ──────────
     *
     * The standard message is sent verbatim with no greeting and no signature (Tabish:
     * "no signature name whatsoever"), so nothing persona-shaped renders in any message.
     * A guard about fields no recipient sees is a guard about nothing — the same
     * reasoning that removed `validatePersona`'s name/role checks on 2026-08-07 when the
     * intro line went, now applied to the whole block.
     */

    if (pair.target.kind === 'BRAND') {
      /**
       * IS THIS RECIPIENT A PERSON? Asked FIRST of the three brand guards, because the
       * others are about timing and volume and this one is about the message being wrong
       * for whoever receives it. A refusal should name the real problem.
       *
       * 8 live BRAND rows carry a person-role category — see `checkRecipientIsNotAPerson`.
       */
      const personGate = checkRecipientIsNotAPerson({
        targetKind: pair.target.kind,
        brandCategory: pair.target.brandCategory,
        handle: pair.target.handle,
        campaignTalent: pair.target.campaignTalent,
      })
      if (!personGate.ok) {
        log.step('held — this recipient looks like a person, not a company', {
          target: pair.target.handle,
          category: pair.target.brandCategory,
        })
        outcomes.push({ pairKey, eligible: false, skipReason: personGate.reason, skipDetail: personGate.detail })
        continue
      }

      /**
       * Protects the PATTERN rather than the account: `dailyCap` is Instagram's per-sender
       * concern, this is that ten first-touches in one afternoon look like a scraped list
       * being worked through, whatever the volume. Only first touches count — a follow-up
       * is a continuing conversation already spaced by cooldown.
       */
      const capGate = checkNewBrandTouchCap({
        // The run's own first touches are added to the WAITING depth only: they are rows this
        // loop has written and left in the queue, and it delivers nothing
        // (`manualAssistSender`), so adding them to the delivered figure would claim messages
        // nobody received.
        waitingFirstTouches: newBrandTouches.waiting + brandFirstTouchesThisRun,
        maxWaitingNewBrandDrafts: settings.maxWaitingNewBrandDrafts,
        firstTouchesDeliveredToday: newBrandTouches.delivered,
        maxNewBrandTouchesPerDay: settings.maxNewBrandTouchesPerDay,
        isFirstTouch: decision.touchNumber === 1,
      })
      if (!capGate.ok) {
        outcomes.push({ pairKey, eligible: false, skipReason: capGate.reason, skipDetail: capGate.detail })
        continue
      }

      // Counted within this run too, or every brand in the queue would pass the same
      // check against a count that only refreshes next run — the shape of bug that lets
      // a cap of 2 send twenty.
      if (decision.touchNumber === 1) brandFirstTouchesThisRun++
    }

    /**
     * The account's status RIGHT NOW, not as it was when `pairs` was read.
     *
     * `pairs` is one query taken before this loop, so `pair.sender` is a snapshot, and
     * `CHALLENGED` is written to that same account by a dispatcher tick, by the dashboard,
     * and by the reply reader — none of which touch the snapshot. A stale ACTIVE here
     * means writing a draft for an account Instagram has just flagged.
     *
     * Lower stakes than it was: this stage no longer opens browsers, so the cost is a
     * pointless draft rather than a checkpoint retried. It is kept because the draft would
     * be pointless AND because the reason for it would be invisible — the dispatcher would
     * hold it fifteen minutes later with no clue on the planning side.
     */
    const liveSender = await prisma.senderAccount.findUnique({
      where: { id: pair.senderId },
      select: { status: true },
    })
    if (liveSender?.status !== 'ACTIVE') {
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: 'sender-not-active',
        skipDetail: `@${pair.sender.handle} is ${(liveSender?.status ?? 'missing').toLowerCase()} right now`,
      })
      continue
    }

    try {
      /**
       * No jitter here any more. This stage writes a database row; it does not drive a
       * browser, so there is nothing to space out and nothing that touches the clipboard.
       * Spacing moved to where the sends are — `pacing.ts`, as the fleet's minimum gap and
       * per-hour allowance, which apply across processes rather than only within one loop.
       */
      const result = await createAndDispatch({
        pair,
        touchNumber: decision.touchNumber,
        autopilotEnabled: settings.autopilotEnabled,
        /* Resolved by the same call the governor just passed, so the body written is the
           body the decision was made about. */
        fleetTemplate: fleetTemplateFor(pair),
        followUpTemplate: followUpTemplateFor(pair),
      })
      outcomes.push({ pairKey, eligible: true, ...result })

      // Any attempt that now exists counts against the ceiling, whether it will be
      // delivered by a tick or is waiting for a human.
      if (result.status === 'READY' || result.status === 'QUEUED') {
        totalSentEver += 1
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('outreach failed', { pair: pairKey, error: message })
      outcomes.push({ pairKey, eligible: true, error: message })
    }
  }

  const summary: PlanSummary = {
    outcomes,
    queued: outcomes.filter((o) => o.status === 'READY' || o.status === 'QUEUED').length,
    sent: outcomes.filter((o) => o.status === 'SENT').length,
    failed: outcomes.filter((o) => o.status === 'FAILED' || o.error).length,
    skipped: outcomes.filter((o) => !o.eligible).length,
  }

  log.info('outreach summary', {
    queued: summary.queued,
    sent: summary.sent,
    failed: summary.failed,
    skipped: summary.skipped,
    dryRun: env.DRY_RUN,
  })

  /**
   * WHY those skips, not just how many (2026-08-22).
   *
   * This logged `skipped=861` and nothing else, which is the exact failure the dispatcher's
   * `holdReasons` was added to fix — one level up, and worse, because the planner is where a
   * message either comes into existence or does not. Asked "why is the queue empty when 39
   * recipients have allowance room", the honest answer from the logs was *we cannot tell*:
   * every reason had been computed, recorded on the outcome, and then thrown away at the one
   * place a person reads.
   *
   * Counted per reason, top reasons named, so the shape of a quiet pass is visible at a
   * glance: `ring-complete` on most of a drained fleet is the 7-day rest working, while the
   * same number under `sender-not-active` or `no-session` would be an outage wearing its
   * costume.
   */
  if (summary.skipped > 0) {
    const byReason = new Map<string, number>()
    for (const o of outcomes) {
      if (o.eligible) continue
      const key = o.skipReason ?? 'unrecorded'
      byReason.set(key, (byReason.get(key) ?? 0) + 1)
    }
    log.info('outreach skips by reason', {
      total: summary.skipped,
      reasons: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}=${n}`)
        .join(' '),
    })
  }

  return summary
}

type PairWithRelations = Awaited<ReturnType<typeof prisma.outreachPair.findMany>> extends (infer T)[] ? T : never

async function createAndDispatch(args: {
  pair: Awaited<ReturnType<typeof prisma.outreachPair.findFirstOrThrow>> & {
    sender: Awaited<ReturnType<typeof prisma.senderAccount.findFirstOrThrow>>
    target: Awaited<ReturnType<typeof prisma.targetAccount.findFirstOrThrow>>
  }
  touchNumber: number
  autopilotEnabled: boolean
  /** The route's own standard message, already resolved by the caller. See fleetTemplate.ts. */
  fleetTemplate: FleetTemplate
  /** ...and what it says on a SECOND message. See followUpTemplate.ts. */
  followUpTemplate: FollowUpTemplate
}): Promise<Omit<PlanOutcome, 'pairKey' | 'eligible'>> {
  const { pair, touchNumber, autopilotEnabled, fleetTemplate, followUpTemplate } = args

  /**
   * WHAT to say — hook, variant pool, bespoke-or-follow-up — is decided in `compose.ts`,
   * which `onDemand.ts` also calls. It was inlined in both and the two drifted in three
   * separate ways within one session. See the header there.
   */
  const { body, hookLine, variantId, campaignId } = await composeForPair({
    pair,
    senderHandle: pair.sender.handle,
    touchNumber,
    fleetTemplate,
    followUpTemplate,
  })

  const attempt = await prisma.outreachAttempt.create({
    data: {
      pairId: pair.id,
      // Denormalised from the pair, and required by the schema so no create can omit
      // them. Every per-recipient and per-sender query reads these directly.
      senderId: pair.senderId,
      targetId: pair.targetId,
      campaignId,
      variantId,
      touchNumber,
      hookLine,
      renderedBody: body,
      status: 'QUEUED',
    },
  })

  // DRY_RUN stops here: the attempt exists and is auditable, but is never
  // surfaced for sending and never delivered.
  if (env.DRY_RUN) {
    await prisma.outreachAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SKIPPED', error: 'DRY_RUN' },
    })
    log.step('DRY_RUN — would have queued', {
      sender: pair.sender.handle,
      target: pair.target.handle,
      hook: hookLine ?? '(none)',
    })
    return { attemptId: attempt.id, status: 'SKIPPED', hookLine }
  }

  /**
   * ── THE PLANNER PREPARES. IT NO LONGER DELIVERS. Phase 5. ──────────────
   *
   * It used to drive a browser right here, inside the loop over pairs, whenever the four
   * autopilot yeses lined up. That was a SECOND send path, and it was the unpaced one:
   * nothing in it consulted the fleet's per-hour allowance, the active-hours window, the
   * circuit breaker, the minimum gap between sends, or the fleet-wide send lock. So the
   * stage of the slot that exists to *prepare* messages could emit a burst of them —
   * exactly the clustering the paced dispatcher was built to stop, from the one code path
   * the dispatcher could not see.
   *
   * There is now one way a message reaches a recipient unattended: `dispatchTick`. That is
   * the "one gate, two callers, never re-inline it" lesson applied to the send itself,
   * before it had a chance to bite twice.
   *
   * NOTHING IS DROPPED AND NOTHING IS LOOSENED. The attempt is READY, which is precisely
   * what the dispatcher picks up, and every one of the four yeses is checked again at
   * delivery by `gate.ts` — account ACTIVE, its own auto-send switch (when unattended),
   * a logged-in Chrome profile — plus the autopilot toggle in `decideDispatch`. Checking
   * them at delivery rather than at drafting is strictly better: a draft can sit for
   * minutes, and the state that matters is the state when the browser opens.
   *
   * The observable difference is timing. A message drafted at 11:00 goes out on a tick
   * within DISPATCH_INTERVAL_MINUTES instead of during the slot itself.
   */
  const outcome: SendOutcome = await manualAssistSender.send({
    attemptId: attempt.id,
    senderHandle: pair.sender.handle,
    sessionPath: pair.sender.sessionPath,
    targetHandle: pair.target.handle,
    body,
  })

  /**
   * Said out loud while drafting, because it is the one thing the operator can fix ahead
   * of time and the dispatcher would otherwise report it as a hold fifteen minutes later.
   *
   * ONE SWITCH, 2026-08-08: this used to require `pair.sender.autoSendEnabled` too, and
   * that made it UNDER-WARN to silence. The column defaults false and nothing writes it any
   * more — the per-account arming switch and the CLI verb that set it are both gone — so the
   * conjunct was false for every account and this warning could no longer fire at all. It
   * would have gone quiet exactly as the fleet grew and drafts started waiting on missing
   * sessions, which is the failure it exists to announce.
   *
   * The condition now names what actually holds the send: autopilot is on, so this draft is
   * meant to go out unattended, and the account has no usable session for the dispatcher to
   * use. `sessionUsable` rather than a `sessionPath` read, because a path in the database is
   * not a live session (§3.5) — and it is the same predicate `gate.ts` refuses with, so the
   * warning cannot promise a stop the gate does not enforce.
   */
  if (
    autopilotEnabled &&
    !sessionUsable({
      hasSessionOnDisk: profileStatus(pair.sender.handle).hasSession,
      sessionInvalidAt: pair.sender.sessionInvalidAt,
    })
  ) {
    log.warn('autopilot is on for this account but it has no Chrome profile — the draft will wait', {
      sender: pair.sender.handle,
      fix: `pnpm ig:login ${pair.sender.handle}`,
    })
  }

  await prisma.outreachAttempt.update({ where: { id: attempt.id }, data: { status: outcome.status } })
  return { attemptId: attempt.id, status: outcome.status, hookLine }
}

/**
 * `applyOutcome` is GONE, and it is worth saying why rather than leaving a reader to
 * wonder whether it was dropped by accident.
 *
 * It existed to record SENT / READY / FAILED-and-CHALLENGED for a send the planner had
 * just performed. The planner no longer performs sends (see `createAndDispatch`), so its
 * SENT and CHALLENGED branches became unreachable — a guard nobody can trigger, which is
 * the shape this codebase keeps finding and which reads as healthy precisely because the
 * only path that runs is the one that works.
 *
 * Every one of those recordings still happens, in `deliver.ts`, where the send now is:
 * `recordDelivered` for the fact, `markChallenged` for the halt, and READY for a failure
 * that can be retried.
 */

export type { PairWithRelations }
