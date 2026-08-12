import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { istDayStart } from '@/lib/time'
import { newMaterialFloor } from '@/lib/cutoff'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { evaluatePair, type GovernorDecision } from './governor'
import { routeAllowed } from './routes'
import { validatePersona } from './render'
import { composeForPair, usedCampaignIds } from './compose'
import { whoseTurn } from './categories'
import { checkNewBrandTouchCap, checkPersonaDistinct } from './brandGuards'
/**
 * The ONLY sender this file imports, since Phase 5. `browserSender` was here too and is
 * deliberately not any more: the planner prepares and `dispatchTick` delivers, so a second
 * import of something that drives a browser is the thing to notice if it ever comes back.
 */
import { manualAssistSender } from './senders/manual'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from './sessionHealth'
import { replyHaltFloor } from './replyHalt'
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
    prisma.senderAccount.findMany({ where: { fleetMember: true }, select: { id: true, handle: true } }),
    prisma.targetAccount.findMany({ where: { optedOut: false }, select: { id: true, handle: true } }),
    prisma.outreachPair.findMany({ select: { senderId: true, targetId: true } }),
  ])

  /**
   * The same set `fleetHandles()` returns, derived from the `fleet` read above rather than
   * asked for again — this function already holds exactly `where: { fleetMember: true }`.
   * The helper exists for the four callers that do NOT have that list in hand.
   */
  const ourHandles = new Set(fleet.map((s) => s.handle))
  const already = new Set(existing.map((p) => `${p.senderId} ${p.targetId}`))

  const data = fleet.flatMap((s) =>
    messageable
      .filter((t) =>
        routeAllowed({
          senderHandle: s.handle,
          targetHandle: t.handle,
          ourHandles,
          // Already excluded by the query above; passed explicitly so the predicate is
          // asked the whole question rather than a convenient subset of it.
          targetOptedOut: false,
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
   * How many brands were contacted for the FIRST time today, across every sender.
   *
   * Counted by `touchNumber: 1` on a BRAND target rather than by "distinct targets",
   * because that is exactly what the cap is about: opening a new conversation with a
   * stranger. A follow-up carries touchNumber > 1 and is never counted.
   */
  const newBrandTouchesToday = await prisma.outreachAttempt.count({
    where: {
      touchNumber: 1,
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { gte: dayStart },
      pair: { target: { kind: 'BRAND' } },
    },
  })
  /** ...and within this run, or every queued brand would pass the same stale check. */
  let brandFirstTouchesThisRun = 0

  /**
   * Every OTHER sender's persona, per sender. Distinctness is a property of the SET, so
   * the comparison needs all of them; loading once avoids a query per pair.
   */
  const allSenders = await prisma.senderAccount.findMany({
    select: {
      id: true,
      personaName: true,
      personaRole: true,
      personaBrand: true,
      personaPhone: true,
      personaEmail: true,
    },
  })
  const otherPersonasBySender = new Map(
    allSenders.map((s) => [s.id, allSenders.filter((o) => o.id !== s.id)]),
  )

  /**
   * Which accounts rotation must SKIP, with the reason.
   *
   * Built once per run and passed into the ring rather than re-derived inside it, so
   * `rotation.ts` stays pure. The reasons are carried as text because a refusal that
   * says "every sender in this category is unavailable — alpha: flagged; bravo: not
   * connected" is actionable and "nothing happened" is not.
   *
   * `challengedThisRun` is added to this as the run proceeds, so an account flagged
   * mid-slot stops being offered a turn immediately.
   */
  const unavailableSenders = new Map<string, string>()
  for (const s of await prisma.senderAccount.findMany({
    select: { id: true, handle: true, status: true, sessionInvalidAt: true },
  })) {
    if (s.status === 'CHALLENGED') unavailableSenders.set(s.id, 'flagged by Instagram')
    else if (s.status !== 'ACTIVE') unavailableSenders.set(s.id, s.status.toLowerCase())
    // §3.5: two different facts, two different fixes, so two different sentences. A dead
    // session was PROVED dead by a real send; "not connected" means no login ever happened.
    else if (s.sessionInvalidAt !== null) unavailableSenders.set(s.id, 'logged out — needs signing in again')
    else if (!profileStatus(s.handle).hasSession) unavailableSenders.set(s.id, 'not connected')
  }

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
    const alreadyUsedIds = await usedCampaignIds(pair.id)

    const [lastSent, touches, replied, targetToday, senderToday, pending, unusedCampaignCount] = await Promise.all([
      /**
       * All three of these count DELIVERED_STATUSES, not 'SENT'.
       *
       * `REPLIED` replaces `SENT`, so a bare 'SENT' filter means **a reply loosens a
       * guard** — precisely backwards. Two of the three were unreachable in that
       * direction (a reply from this target trips TARGET_REPLIED first, which halts
       * every sender to them), but `senderSentTodayCount` was genuinely reachable:
       * the reply guard is per-TARGET while this cap is per-SENDER, so a reply from
       * target X lowered the sender's day count and bought it one extra message to a
       * different target Y. At a dailyCap of 5 against 1-2 actual sends that is
       * academic today, and it would stop being academic exactly when volume rose.
       */
      prisma.outreachAttempt.findFirst({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      }),
      prisma.outreachAttempt.count({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
      }),
      prisma.outreachAttempt.findFirst({
        // A reply halts for replyResumeHours, then releases itself — see replyHalt.ts.
        where: {
          pair: { targetId: pair.targetId },
          repliedAt: { gte: replyHaltFloor(settings.replyResumeHours) },
          replyHandledAt: null,
        },
        orderBy: { repliedAt: 'desc' },
        select: { repliedAt: true },
      }),
      prisma.outreachAttempt.count({
        where: {
          pair: { targetId: pair.targetId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: dayStart },
        },
      }),
      prisma.outreachAttempt.count({
        where: {
          pair: { senderId: pair.senderId },
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: dayStart },
        },
      }),
      // SENDING included: a browser mid-send is the most pending an attempt gets.
      prisma.outreachAttempt.count({ where: { pairId: pair.id, status: { in: ['QUEUED', 'READY', 'SENDING'] } } }),
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
       */
      prisma.detectedCampaign.count({
        where: {
          targetId: pair.targetId,
          verdict: 'CAMPAIGN',
          postedAt: { gte: newMaterialFloor(now) },
          id: { notIn: alreadyUsedIds },
        },
      }),
    ])

    const decision: GovernorDecision = evaluatePair({
      now,
      pair: {
        cooldownDays: pair.cooldownDays,
        maxUnansweredTouches: pair.maxUnansweredTouches,
      },
      sender: { status: pair.sender.status, dailyCap: pair.sender.dailyCap },
      target: { optedOut: pair.target.optedOut },
      lastSentAt: lastSent?.sentAt ?? null,
      touchesSoFar: touches,
      targetRepliedAt: replied?.repliedAt ?? null,
      targetSentTodayCount: targetToday,
      senderSentTodayCount: senderToday,
      maxPerTargetPerDay: settings.maxPerTargetPerDay,
      hasPendingAttempt: pending > 0,
      unusedCampaignCount,
      totalSentEver,
      maxTotalSends: env.MAX_TOTAL_SENDS,
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
     * A target in NO category behaves exactly as before — every enabled pair is
     * considered independently. That is what makes this phase shippable: nothing
     * changes for anyone until a human puts a target in a category.
     */
    const turn = await whoseTurn({ targetId: pair.targetId, unavailable: unavailableSenders })
    if (turn && turn.choice.ok && turn.choice.senderId !== pair.senderId) {
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: 'not-this-senders-turn',
        skipDetail: `@${turn.choice.handle} is next in ${turn.categoryName}`,
      })
      continue
    }
    if (turn && !turn.choice.ok) {
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: turn.choice.reason,
        skipDetail: turn.choice.detail,
      })
      continue
    }

    // A malformed persona would be reproduced in every message this sender ever
    // sends, so it blocks the send rather than producing a flawed one.
    const personaProblems = validatePersona(pair.sender)
    if (personaProblems.length > 0) {
      log.alarm('sender persona is invalid — refusing to send', {
        sender: pair.sender.handle,
        problems: personaProblems,
      })
      outcomes.push({
        pairKey,
        eligible: false,
        skipReason: 'invalid-persona',
        skipDetail: personaProblems.join('; '),
      })
      continue
    }

    /**
     * The two guards that exist only for brands. AFTER the governor, never instead of it:
     * a brand target has already passed cooldown, new-material, the unanswered-touch cap,
     * both daily caps, opt-out, replies and the lifetime ceiling to get here.
     *
     * Both are pure functions in `brandGuards.ts` so each is tested firing AND permitting.
     */
    /**
     * ── THE PERSONA GATE, now covering CHANNELS too (decision 6) ──────────
     *
     * Checked for every target kind, before the brand-only guards below. It used to sit
     * inside the `kind === 'BRAND'` block, which is why it is lifted out here rather
     * than duplicated: one call, one rule, both audiences.
     *
     * With every account still carrying *Kapil Jain, Co-founder, Bollywood Society*
     * this stops everything. That is the accepted consequence, not a bug — and it is
     * visible on the dashboard rather than silent.
     */
    const personaGate = checkPersonaDistinct({
      persona: pair.sender,
      otherPersonas: otherPersonasBySender.get(pair.senderId) ?? [],
      targetKind: pair.target.kind,
      gateChannels: settings.personaGateChannels,
    })
    if (!personaGate.ok) {
      log.step('held — this account\'s persona is not its own', {
        sender: pair.sender.handle,
        target: pair.target.handle,
      })
      outcomes.push({ pairKey, eligible: false, skipReason: personaGate.reason, skipDetail: personaGate.detail })
      continue
    }

    if (pair.target.kind === 'BRAND') {
      /**
       * Protects the PATTERN rather than the account: `dailyCap` is Instagram's per-sender
       * concern, this is that ten first-touches in one afternoon look like a scraped list
       * being worked through, whatever the volume. Only first touches count — a follow-up
       * is a continuing conversation already spaced by cooldown.
       */
      const capGate = checkNewBrandTouchCap({
        newBrandTouchesToday: newBrandTouchesToday + brandFirstTouchesThisRun,
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
}): Promise<Omit<PlanOutcome, 'pairKey' | 'eligible'>> {
  const { pair, touchNumber, autopilotEnabled } = args

  /**
   * WHAT to say — hook, variant pool, bespoke-or-follow-up — is decided in `compose.ts`,
   * which `onDemand.ts` also calls. It was inlined in both and the two drifted in three
   * separate ways within one session. See the header there.
   */
  const { body, hookLine, variantId, campaignId } = await composeForPair({
    pair,
    senderHandle: pair.sender.handle,
    touchNumber,
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
