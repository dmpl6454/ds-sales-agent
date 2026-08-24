import { prisma } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { newMaterialFloor } from '@/lib/cutoff'
import { SKIP_REASONS } from '@/outreach/governor'
import { BRAND_BLOCKS, checkRecipientIsNotAPerson } from '@/outreach/brandGuards'
import { materialAllowance, campaignsNamingHandleRows } from '@/outreach/materialAllowance'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { eligibleFleetSenderIds, readSenderAvailability } from '@/outreach/availability'
import { fleetRingOrder, nextSender } from '@/outreach/rotation'
import { unavailableForTarget } from '@/outreach/categories'
import { usedCampaignIds } from '@/outreach/compose'

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

const REST_RULES: Record<string, { label: string; needsAPerson: boolean }> = {
  [SKIP_REASONS.MATERIAL_EXHAUSTED]: {
    label: 'every paid post we have seen from them has already been written about — the next message waits for their next one',
    needsAPerson: false,
  },
  [SKIP_REASONS.TARGET_REPLIED]: {
    label: 'they replied — every one of our pages pauses for seven days from the date they wrote, then resumes on its own',
    needsAPerson: false,
  },
  [SKIP_REASONS.TARGET_RECENTLY_CONTACTED]: {
    label: 'every one of our pages has written to them this week — they rest until the oldest of those is seven days old',
    needsAPerson: false,
  },
  [SKIP_REASONS.NO_NEW_MATERIAL]: {
    label: 'the page whose turn it is has already written about everything we have seen from them',
    needsAPerson: false,
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
    label: 'not one of our pages can write to them — every account in their rotation is signed out or flagged',
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
 * A bound on the ONE remaining per-row query, so this can never become an N+1.
 *
 * `NO_NEW_MATERIAL` is the only hold left that is genuinely per-PAIR: it asks whether the page
 * whose turn it is has already written about every campaign naming this recipient, which needs
 * `usedCampaignIds(pairId)`. It can only fire where the ELECTED pair has already delivered
 * (`touchesSoFar > 0` in the governor), and that set is small by construction because rotation
 * elects the page AFTER whoever wrote last. Bounded regardless: past this many the remainder is
 * counted clear and `pairChecksSkipped` says how many, rather than silently costing a query each.
 */
const PAIR_PRECISION_LIMIT = 80

export async function buildRestTally(now: Date = new Date()): Promise<RestTally> {
  const settings = await getSettings()
  const allowanceFloor = new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000)
  const materialFloor = newMaterialFloor(now)
  /* Preload from the EARLIER of the two floors: the stub narrows per caller, it cannot widen. */
  const preloadFloor = allowanceFloor < materialFloor ? allowanceFloor : materialFloor

  const [prospects, retired, watched, posts, deliveries, replies, pending, parked, pairs, eligibleSenderIds, unavailable] =
    await Promise.all([
      prisma.targetAccount.findMany({
        where: { role: 'PROSPECT', optedOut: false },
        /* `kind`/`brandCategory`/`campaignTalent`/`isVerified` are what the remaining guards
           need, and they are COLUMNS — reading them costs nothing on a query already being
           made, which is why closing those gaps needs no extra round trip. */
        select: {
          id: true,
          handle: true,
          displayName: true,
          kind: true,
          brandCategory: true,
          campaignTalent: true,
          isVerified: true,
        },
      }),
      prisma.targetAccount.count({ where: { role: 'PROSPECT', optedOut: true } }),
      prisma.targetAccount.count({ where: { role: 'WATCH' } }),
      prisma.detectedCampaign.findMany({
        where: { verdict: 'CAMPAIGN', postedAt: { gte: preloadFloor } },
        select: { id: true, postedAt: true, caption: true, taggedAccounts: true, brands: true },
      }),
      /* ALL delivered messages, not a window: rotation's `lastSenderTo` is all-time, and the
         ring rule wants each sender's most recent delivery "at any age". Ascending, so the last
         write per (target, sender) wins the map. */
      prisma.outreachAttempt.findMany({
        where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
        select: {
          sentAt: true,
          pair: { select: { targetId: true, senderId: true, sender: { select: { handle: true } } } },
        },
        orderBy: { sentAt: 'asc' },
      }),
      prisma.outreachAttempt.findMany({
        where: { replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours, now) }, replyHandledAt: null },
        select: { replyPostedAt: true, pair: { select: { targetId: true } } },
      }),
      prisma.outreachAttempt.findMany({
        where: { status: { in: ['QUEUED', 'READY', 'SENDING'] } },
        select: { pair: { select: { targetId: true } } },
      }),
      prisma.outreachAttempt.findMany({
        where: { status: 'FAILED', failureCode: { not: null } },
        select: { pair: { select: { targetId: true, senderId: true } } },
      }),
      prisma.outreachPair.findMany({
        where: { sender: { fleetMember: true } },
        select: { id: true, targetId: true, senderId: true, sender: { select: { id: true, handle: true, cohort: true } } },
      }),
      eligibleFleetSenderIds(),
      readSenderAvailability(),
    ])

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

  const lastBySenderPerTarget = new Map<string, Map<string, { sentAt: Date; handle: string }>>()
  const lastSenderPerTarget = new Map<string, string>()
  const deliveredPairKeys = new Set<string>()
  for (const d of deliveries) {
    if (!d.sentAt) continue
    const m = lastBySenderPerTarget.get(d.pair.targetId) ?? new Map<string, { sentAt: Date; handle: string }>()
    m.set(d.pair.senderId, { sentAt: d.sentAt, handle: d.pair.sender.handle })
    lastBySenderPerTarget.set(d.pair.targetId, m)
    lastSenderPerTarget.set(d.pair.targetId, d.pair.senderId)
    deliveredPairKeys.add(`${d.pair.targetId}:${d.pair.senderId}`)
  }

  const haltUntil = new Map<string, Date>()
  for (const r of replies) {
    if (!r.replyPostedAt) continue
    const at = new Date(r.replyPostedAt.getTime() + settings.replyResumeHours * 3_600_000)
    const cur = haltUntil.get(r.pair.targetId)
    if (!cur || at > cur) haltUntil.set(r.pair.targetId, at)
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
  for (const p of parked) {
    const m = blockedRoutes.get(p.pair.targetId) ?? new Map<string, string>()
    m.set(p.pair.senderId, 'an earlier message from this page may already have reached them')
    blockedRoutes.set(p.pair.targetId, m)
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
  const bump = (reason: string, at: Date | null) => {
    const b = buckets.get(reason) ?? { count: 0, next: null }
    b.count += 1
    if (at && (b.next === null || at < b.next)) b.next = at
    buckets.set(reason, b)
  }

  let clear = 0
  let queued = 0
  let pairChecksSkipped = 0
  /** Only a company whose ELECTED pair has already delivered can be held by NO_NEW_MATERIAL. */
  const needsPairCheck: Array<{ pairId: string; prospect: { handle: string; displayName: string | null } }> = []

  for (const p of prospects) {
    /* VERIFIED ONLY, checked where the governor checks it — third of its stops, before the
       reply halt. Measured 0 today, and it must still be a bucket rather than an assumption:
       a row that fails this is refused forever and would otherwise be counted as capacity. */
    if (p.isVerified !== true) {
      bump(SKIP_REASONS.TARGET_NOT_VERIFIED, null)
      continue
    }

    const halt = haltUntil.get(p.id)
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

    /* Whose turn is it? Rotation's own pure ring over the routes that already exist, so this
       cannot name a page the planner would not use. */
    const ring = fleetRingOrder(ringByTarget.get(p.id) ?? [])
    const turn = nextSender({
      ring,
      lastSenderId: lastSenderPerTarget.get(p.id) ?? null,
      unavailable: unavailableForTarget(unavailable, blockedRoutes, p.id),
      targetId: p.id,
    })
    /* NOBODY CAN WRITE TO THEM — and this used to fall through to `clear`, which counted a
       recipient no account can reach as spare capacity. `nextSender` refuses with `empty-ring`
       or `all-unavailable`; either way the answer is that this company is going nowhere. */
    if (!turn.ok) {
      bump(ROTATION_STUCK, null)
      continue
    }
    const electedId = turn.senderId

    const inWindow = [...(lastBySenderPerTarget.get(p.id)?.values() ?? [])]
      .filter((d) => d.sentAt >= allowanceFloor)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
    const camps = await campaignsNamingHandleRows(preloaded, p, allowanceFloor)
    const material = materialAllowance({ campaignsInWindow: camps.length, deliveredInWindow: inWindow.length })
    if (material.held) {
      /* Two releases, both real: a NEW paid post raises the allowance, or the allowance-th
         newest delivery ages out of the window and lowers the count. The clock is reported and
         the row is NOT called self-releasing, because the paid post is the release Tabish's
         rule intends and it is the one that usually comes first. */
      const nth = inWindow[material.allowance - 1]
      bump(
        SKIP_REASONS.MATERIAL_EXHAUSTED,
        nth ? new Date(nth.sentAt.getTime() + settings.defaultCooldownDays * 86_400_000) : null,
      )
      continue
    }

    const spacing = crossSpacingVerdict({
      now,
      windowDays: settings.defaultCooldownDays,
      crossPageGapHours: settings.crossPageGapHours,
      thisSenderId: electedId,
      eligibleSenderIds: [...eligibleSenderIds],
      lastDeliveryBySender: lastBySenderPerTarget.get(p.id) ?? new Map(),
    })
    if (spacing.held) {
      bump(SKIP_REASONS.TARGET_RECENTLY_CONTACTED, spacing.resumesAt ?? null)
      continue
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

    const key = `${p.id}:${electedId}`
    const electedPairId = pairIdByKey.get(key)
    if (electedPairId && deliveredPairKeys.has(key)) {
      if (needsPairCheck.length < PAIR_PRECISION_LIMIT) {
        needsPairCheck.push({ pairId: electedPairId, prospect: p })
        continue
      }
      pairChecksSkipped += 1
    }
    clear += 1
  }

  /* The last rule, and the only one that costs a query per row. `newMaterialFloor` — NOT the
     allowance window — because that is the floor the governor's own query uses. */
  for (const { pairId, prospect } of needsPairCheck) {
    const used = await usedCampaignIds(pairId)
    const rows = await campaignsNamingHandleRows(preloaded, prospect, materialFloor)
    const unused = rows.filter((r) => !used.includes(r.id)).length
    if (unused === 0) {
      bump(SKIP_REASONS.NO_NEW_MATERIAL, null)
    } else {
      clear += 1
    }
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
    watched,
    byReason,
    nextRelease: clocks.length > 0 ? new Date(Math.min(...clocks.map((d) => d.getTime()))) : null,
    needingAPerson: byReason.filter((r) => r.needsAPerson).reduce((n, r) => n + r.count, 0),
    pairChecksSkipped,
    measuredAt: now,
  }
}
