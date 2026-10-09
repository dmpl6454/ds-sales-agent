import { prisma } from '@/lib/db'
import { memoView, viewKey } from '@/lib/viewMemo'
import { normaliseSearch, targetNameClauses } from '@/lib/searchTerms'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { getSettings } from '@/lib/settings'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { prospectReplyNote, prospectTargetHaltSentence, replyBlocksEveryPage } from '@/outreach/replyHaltCopy'
import { istStamp } from '@/lib/time'
// Never a raw `displayName` — see the note on the import in `view-model.ts`.
import { operatorName } from '@/outreach/render'
/**
 * SERVER ONLY, and this file must stay server-only for it.
 *
 * `profileStatus` reads the credential directory and `prisma` opens the database, so a
 * `'use client'` module importing anything from here would pull `better-sqlite3` into the
 * browser bundle and return HTTP 500 on EVERY route — with `pnpm typecheck` passing
 * throughout. That has happened here once already (`waiting.tsx` → `remedy.ts` → `gate.ts`).
 * `prospects/list.tsx` imports `ProspectRow` with `import type`, which is erased at compile
 * time and carries no runtime edge; keep it that way.
 */
import { sessionIsUsable } from './session-view'
import { describeRing, whoseTurnForMany } from '@/outreach/categories'
import { readSenderAvailability } from '@/outreach/availability'
import { auditTarget, AUDIT_WHY_SENTENCE } from '@/outreach/targetAudit'
// PURE, and the same function `plan.ts` asks. Imported rather than mirrored: a page that
// re-derives a guard its own way is how a dashboard comes to disagree with the enforcer.
import { checkRecipientIsNotAPerson } from '@/outreach/brandGuards'
import { getDetector } from '@/detection/detectors'
import { fleetHandles } from '@/outreach/routes'
import { DETECT_INTERVAL_MINUTES } from '@/detection/cadence'

/**
 * The `/prospects` page: everyone we might write to, and what is actually switched on.
 *
 * ── WHY THIS IS NOT THE CHANNELS CARD GROWN LARGER ────────────────────────
 *
 * The existing channels view renders a chip per sender×target route. At four senders and
 * five channels that is twenty chips and it reads well. At 65 senders and 60 targets it is
 * **3,900**, which is not a display problem to solve with scrolling — it is the wrong
 * control. Nobody decides 3,900 routes one at a time.
 *
 * ── AND THEN THE ROUTES STOPPED BEING A DECISION AT ALL (one switch, 2026-08-08) ──
 *
 * The per-route toggle is gone, so this page no longer reports "2 of 8 routes on" either.
 * That count was the honest answer while a route was switchable; once every allowed route
 * exists by rule (`routeAllowed`, `ensureFleetPairs`) it measures nothing an operator can
 * act on, and a number nobody can change is furniture.
 *
 * What replaced it answers the same question — *will anything happen here?* — from ABILITY
 * rather than from configuration: how many fleet accounts can actually send (`sendersAble`),
 * and whether this recipient is retired. Both are facts; neither is a switch.
 */

export interface ProspectRow {
  handle: string
  displayName: string
  kind: string
  /**
   * WATCH or PROSPECT — the authoritative answer to "may we message them", and the thing the
   * list groups by since 2026-08-17.
   *
   * It used to group by `kind`, and CLAUDE.md says in as many words why that is a trap:
   * `kind === 'CHANNEL'` is NOT "a page we watch". `importProspects` creates messageable
   * prospects as CHANNEL, so the first imported list would have been filed under "pages we
   * watch" — the exact confusion the WATCH/PROSPECT column was introduced to end. The two
   * columns happen to agree on all 99 rows today, which is precisely why a reader would not
   * catch it.
   */
  role: string
  /** Are their posts read four times a day? Separate from whether they may be messaged. */
  watchEnabled: boolean
  /** The rotation group whose senders take turns writing to them. Null means the fleet ring. */
  category: string | null
  /**
   * WHICH ACCOUNT WRITES TO THEM NEXT — one sentence, from `whoseTurn`.
   *
   * The row used to read *"Messaged automatically by rotation while Autopilot is on (N
   * accounts able to send)"*, and every word of that was true except the one that mattered:
   * rotation was not happening. `whoseTurn` returned null for every recipient, so all N
   * accounts wrote, not one in turn. A count of accounts ABLE to send reads as a measure of
   * capacity; what a reader needs is the name of the account that will actually write.
   *
   * Composed in the view model from the same function the planner asks, so this row cannot
   * name an account the planner will not use.
   */
  nextSenderSentence: string
  /**
   * Will a message to them actually be written?
   *
   * The row appends "N accounts in the fleet can send right now" after the sentence, and
   * that suffix is only meaningful when something IS going to be written. For the 8 BRAND
   * rows that are people, the sentence is the planner's refusal and a fleet-capacity figure
   * beside it would put the promise straight back.
   */
  nextSenderWillWrite: boolean
  /**
   * NOTHING IS JUDGING THIS CHANNEL'S POSTS — from the detector's own `readiness()`.
   *
   * Never a `detectorKey === 'passthrough'` comparison. CLAUDE.md records that exact
   * shortcut rendering "Paid campaigns found: 0" for @viralbhayani the day its detector
   * changed, which is the misleading zero the flag exists to prevent. The detector states
   * whether it can judge; this asks it.
   *
   * Null when the channel is judged, or when it is not a channel at all.
   */
  unjudgedNote: string | null
  /**
   * ONE OF OUR OWN PAGES — the only posts where we know what was actually paid for.
   *
   * Watching for both was switched off on 2026-08-13 at 13:41 IST. That is a legitimate cost
   * saving and it has a consequence worth CHOOSING rather than discovering: these are the
   * only channels that can produce ground truth beyond M.O.M's `#Collaboration` hashtag, and
   * with reading off that labelled set stops growing. Surfaced here so it is a decision.
   */
  groundTruthNote: string | null
  /*
   * `totalPairs` went with the chips. It existed only as the denominator of "2 of 8 routes on",
   * and once nothing can change the numerator the pair count is not a fact about this prospect
   * that anyone acts on — it is the size of a table. Left out rather than left unrendered: a
   * field nobody reads is what a later change wires a new rule to.
   */
  /**
   * `optedOut`: retired, never to be contacted again.
   *
   * ONE field for this, named for what a reader sees. It used to be exposed as BOTH `optedOut`
   * and (via a chip) "retired", and two names for one fact is how a screen comes to state it
   * twice — the duplication the redesign removed. It is the one promise this UI makes that has
   * to survive every other feature, and the governor checks it independently of pairs.
   */
  retired: boolean
  /**
   * Which fleet this row belongs to (2026-08-25). EMPTY means the default — see
   * `senderCategories.ts`; it is not "any fleet may write", it is `bollywood`. Rendered so a
   * reader can tell at a glance why a marketing company is not being written to yet.
   */
  categories: string[]
  /** Messages actually delivered to them, ever. Counted the way the enforcer counts. */
  delivered: number
  /**
   * A reply to ANY of our pages is holding a halt right now — the chip. What the halt COVERS is the
   * scope's (pair by default since 2026-09-01: only the page they answered), and `replyNote` says it.
   */
  replied: boolean
  /**
   * The reply line, in the scope's own words (audit H9) — which pages are paused and until when.
   * A string, so the client list imports nothing. Null when no reply is holding them.
   */
  replyNote: string | null
  importNote: string | null
  /** "verified · 1.2M followers", with a review suffix when the audit rule flags it. Null = never looked. */
  legitimacy: string | null
}

/** 50 a page — the same bound as /paid-posts and the sent history, so one pagination idea. */
export const PROSPECTS_PAGE_SIZE = 50

export interface ProspectsInput {
  /** `?page=` — a string anyone can type; clamped into range, never trusted. */
  page?: number
  /** `?q=` — handle or name; normalised and bounded by `lib/searchTerms.ts`. */
  query?: string | null
}

export interface ProspectsPageView {
  /** The WATCH rows (all of them — a dozen) followed by ONE PAGE of the companies we message. */
  prospects: ProspectRow[]
  /** The messaged group's paging. `total` is the FILTERED total, counted by its own query. */
  paging: { page: number; pageCount: number; total: number; from: number; to: number }
  /** The search in force, echoed back so the box keeps what was typed. */
  query: string | null
  categories: { name: string; senders: number; targets: number }[]
  /**
   * How many fleet accounts can ACTUALLY send right now — ACTIVE, and holding a session
   * nothing has proved dead.
   *
   * One number for the page, not one per prospect: since routes stopped being switchable
   * (one switch, 2026-08-08) the answer is identical for every recipient, and computing it
   * per row would be 60 filesystem reads saying the same thing. It is the honest answer to
   * "will anything happen here" that the old chip wall buried — and it is ABILITY, so it
   * reads zero when the fleet is signed out even while Autopilot is on.
   */
  sendersAble: number
  /** Feeds being read every slot, and what that costs in requests. */
  watched: number
  /**
   * Requests per slot that watching currently implies.
   *
   * On screen because the cost of watching is invisible otherwise, and it is the reason
   * `watchEnabled` exists: four pages per target per slot turns 16 requests into ~240 once
   * a prospect list lands, against an anonymous endpoint whose only risk is rate limiting.
   */
  requestsPerSlot: number
  /**
   * THE SAME COST AT THE CADENCE THAT ACTUALLY RUNS.
   *
   * `requestsPerSlot` was computed here and rendered NOWHERE — CLAUDE.md claims "/targets
   * shows what watching currently costs in requests per slot" and it did not. A per-slot
   * figure is also the wrong unit now: detection left the four IST slots for its own
   * 15-minute clock on 2026-08-07, so "16 requests a slot" understates the real load 24×.
   * The risk being managed is a 429 that blinds detection entirely, and that risk is a
   * function of requests per DAY against an undocumented anonymous endpoint.
   */
  requestsPerDay: number
}

/** Pages the detection pipeline reads per channel per slot. Mirrors `MAX_PAGES` there. */
const PAGES_PER_CHANNEL = 4

/**
 * Memoised on BOTH inputs — each page and each search is its own answer. See
 * `src/lib/viewMemo.ts` for why every page builder is memoised at all.
 */
export async function buildProspectsPage(input?: ProspectsInput): Promise<ProspectsPageView> {
  return memoView(viewKey('prospectsPage', input ?? {}), () => computeProspectsPage(input))
}

async function computeProspectsPage(input?: ProspectsInput): Promise<ProspectsPageView> {
  // The "they replied" chip means "halted NOW", so it needs the halt's own window — and its
  // scope, because what a reply pauses is the scope's (audit H9).
  const settings = await getSettings()

  /**
   * ── PAGED, AND WHY (2026-09-04) ─────────────────────────────────────────────
   *
   * This page rendered every live prospect in one table — ~900 rows by 4 Sept, up from 91 in
   * mid-August — and for every one of them asked rotation whose turn it is
   * (`whoseTurnForMany`) and hydrated a row a person would never scroll to. On the hosted
   * 1-vCPU Linode that was measured at +13 MB heap and a multi-second render, on the day the
   * web process was OOM-killed twice by a pile-up of exactly such renders. So the messaged
   * group is 50 a page with a `?q=` search — the same GET-form shape as /paid-posts, state in
   * the URL — while the WATCH rows (a dozen, a different group with its own heading) are
   * always shown in full so "whose posts we read" never lands on page 18.
   *
   * COUNTED BEFORE THE ROWS, sequentially and on purpose: `skip` cannot be clamped without
   * the range, and an unclamped `?page=999` renders an empty table over a list that is not
   * empty. `handle` then `id` — an unstable sort silently repeats or drops a row across a
   * page boundary.
   */
  const query = normaliseSearch(input?.query)
  const nameWhere = query ? { OR: targetNameClauses(query) } : {}
  const messagedWhere = { optedOut: false, role: { not: 'WATCH' }, ...nameWhere }
  const total = await prisma.targetAccount.count({ where: messagedWhere })
  const pageCount = Math.max(1, Math.ceil(total / PROSPECTS_PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.floor(input?.page ?? 1)), pageCount)

  const targetInclude = {
    // The joined `pairs` (one row per sender, with its display name) went with the chips —
    // one switch, 2026-08-08. Nothing renders a sender name per prospect any more, and at
    // 65×60 that include was the page's largest query for a figure nobody could act on.
    _count: { select: { attempts: true } },
    categories: { include: { category: { select: { name: true } } } },
  } as const

  const [watchRows, pageRows, watched, categoryRows, fleetSenders] = await Promise.all([
    prisma.targetAccount.findMany({
      /**
       * RETIRED ROWS ARE NOT SHOWN AT ALL (2026-08-25, Tabish): *"also what does retired even
       * mean, just do not show retired targets in this column or anywhere … don't show retired
       * targets in the UI anywhere, user doesn't need to know."*
       *
       * `optedOut` is still the hardest promise in the system — the governor, the gate and
       * `routes.ts` each refuse it independently, and nothing here weakens that. What changes
       * is that a retired row is no longer a thing an operator has to read past: 69 of them
       * were listed under a heading about companies we message, every one carrying a chip
       * saying it is never messaged. A list whose rows contradict its own heading is noise.
       */
      where: { optedOut: false, role: 'WATCH', ...nameWhere },
      orderBy: [{ handle: 'asc' }, { id: 'asc' }],
      include: targetInclude,
    }),
    prisma.targetAccount.findMany({
      where: messagedWhere,
      orderBy: [{ handle: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PROSPECTS_PAGE_SIZE,
      take: PROSPECTS_PAGE_SIZE,
      include: targetInclude,
    }),
    /* Page-independent, so a COUNT rather than a filter over the rows in hand: the figure
       feeds the requests-per-day line, which is about the whole watch, not this page. */
    prisma.targetAccount.count({ where: { optedOut: false, kind: 'CHANNEL', watchEnabled: true } }),
    prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { senders: true, targets: true } } },
    }),
    /**
     * `fleetMember: true` is load-bearing, exactly as it is in `plan.ts` and `routes.ts`.
     * The burner (@tabishmukaddam1) is not in the rotation, so counting it would overstate
     * what will happen to a real prospect — and overstating that is the direction this
     * codebase must not fail in.
     */
    prisma.senderAccount.findMany({
      where: { fleetMember: true, status: 'ACTIVE' },
      select: { handle: true, sessionInvalidAt: true, sessionPath: true },
    }),
  ])

  /**
   * Composed exactly the way `plan.ts` composes it — a session AND nothing has since proved
   * it dead — but read HOST-AWARE (2026-09-02): on the hosted dashboard the local disk made
   * this 0 for a fleet that was actively sending. sessionIsUsable trusts the device's DB
   * record there and this machine's disk on a sending machine.
   */
  const sendersAble = fleetSenders.filter((s) => sessionIsUsable(s)).length

  /**
   * Delivered counts and reply state in ONE query rather than per row.
   *
   * At 60 prospects the per-row version is 120 extra queries every render. The planner's
   * per-pair loop is already the measured bottleneck at fleet size (~27,300 queries a
   * slot); a page that repeats the mistake would be the same bug in a place nobody
   * profiles.
   */
  const [deliveredRows, repliedRows] = await Promise.all([
    prisma.outreachAttempt.groupBy({
      by: ['targetId'],
      where: { status: { in: [...DELIVERED_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.outreachAttempt.findMany({
      // ACTIVE halts only — the chip says messaging is stopped, so it must use the same
      // window the gate does (see outreach/replyHalt.ts).
      where: { replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
      /* No longer `distinct` (audit H9): the row names WHICH pages a reply paused and when the last
         of them frees, so it needs one row per reply — still ONE query, low hundreds of rows. */
      select: { targetId: true, replyPostedAt: true, pair: { select: { sender: { select: { handle: true } } } } },
    }),
  ])
  const targets = [...watchRows, ...pageRows]
  const deliveredBy = new Map(deliveredRows.map((r) => [r.targetId, r._count._all]))
  /** target → the pages its active replies reached, and when the LAST of those halts frees. */
  const repliesByTarget = new Map<string, { senderHandles: string[]; frees: Date }>()
  for (const r of repliedRows) {
    if (r.replyPostedAt === null) continue
    const frees = new Date(r.replyPostedAt.getTime() + settings.replyResumeHours * 3_600_000)
    const cur = repliesByTarget.get(r.targetId) ?? { senderHandles: [], frees }
    if (!cur.senderHandles.includes(r.pair.sender.handle)) cur.senderHandles.push(r.pair.sender.handle)
    if (frees > cur.frees) cur.frees = frees
    repliesByTarget.set(r.targetId, cur)
  }
  const repliedSet = new Set(repliesByTarget.keys())

  /**
   * Whose turn it is, for every recipient at once.
   *
   * The batch loader, not `whoseTurn` in a loop: at 72 targets that would be 216 queries at
   * ~30 ms across the tunnel, which is the unbounded N+1 that made `buildBrandsPanel` a
   * ten-second page. Four queries here regardless of the count.
   */
  const turns = await whoseTurnForMany(
    targets.map((t) => t.id),
    await readSenderAvailability(),
  )

  /** Which handles are our own sending pages — the ground-truth set. */
  const ourHandles = await fleetHandles(prisma)

  /**
   * The sentence. Written HERE so `list.tsx` — a `'use client'` module — renders a string
   * and imports nothing: a value import reaching `categories.ts` would pull `@/lib/db` into
   * the browser bundle, which is the trace that once returned HTTP 500 on every route.
   *
   * Retired is not handled here; the row states that first and absolutely, because
   * `optedOut` is the one promise this UI has to keep through every other feature.
   */
  function nextSenderSentence(t: {
    id: string
    kind: string
    handle: string
    brandCategory: string | null
    campaignTalent: boolean
  }): { sentence: string; willWrite: boolean } {
    /**
     * ── THE PLANNER'S OWN REFUSAL COMES FIRST, OR THIS ROW PROMISES A MESSAGE THAT
     *    WILL NEVER BE WRITTEN ────────────────────────────────────────────────────────
     *
     * MEASURED 2026-08-13 on the live database: **8 of the 70 BRAND rows are human
     * beings** — five film directors including Karthik Subbaraj, the actor Rahul Dev,
     * Shalini Passi — and `checkRecipientIsNotAPerson` refuses every one of them in
     * `plan.ts`. It works: 0 of the 8 hold a draft. And this page said of each of them
     * *"Next message comes from @bollywoodchronicle, while Autopilot is on."*
     *
     * CLAUDE.md's rule is that the UI must never claim a halt the gate is not enforcing.
     * This is the mirror image and it is the worse direction: claiming a SEND that a
     * guard is refusing. It also defeats the reason those rows were deliberately LEFT for
     * a person to judge — the page was the one place someone would notice they are people,
     * and it was saying the opposite.
     *
     * Asked of the guard itself, never re-derived. `checkRecipientIsNotAPerson` is pure,
     * so importing it here costs nothing and cannot drift from what the planner asks.
     */
    const person = checkRecipientIsNotAPerson({
      targetKind: t.kind,
      brandCategory: t.brandCategory,
      handle: t.handle,
      campaignTalent: t.campaignTalent,
    })
    if (!person.ok) return { sentence: person.detail ?? 'Nothing is written to them.', willWrite: false }

    /**
     * UNDER A FLEET-WIDE HALT NO PAGE IS NEXT (audit H9). Rotation writes no reply blocker under
     * the `target` scope (`readBlockedRoutes`: a halt covering every page has no clear page to pass
     * to), so the turn below would name "@X writes next" while the gate holds every page — the
     * mirror image of the pair-scope defect this row used to have.
     */
    const reply = repliesByTarget.get(t.id)
    if (reply && replyBlocksEveryPage(settings.replyHaltScope)) {
      return { sentence: prospectTargetHaltSentence(istStamp(reply.frees)), willWrite: false }
    }

    const turn = turns.get(t.id)
    if (turn === undefined) return { sentence: 'Whose turn it is could not be read.', willWrite: false }
    if (!turn.choice.ok) {
      return {
        sentence:
          turn.choice.reason === 'empty-ring'
            ? 'No account is in the rotation for them, so nothing will be written.'
            : `Nothing will be written — ${turn.choice.detail}`,
        willWrite: false,
      }
    }
    const where = turn.ring === 'group' ? ` (${describeRing(turn)})` : ''
    return {
      sentence: `Next message comes from @${turn.choice.handle}${where}, while Autopilot is on. One account writes, not all of them.`,
      willWrite: true,
    }
  }

  /**
   * A WATCHED CHANNEL THAT NOTHING JUDGES IS THE FAILURE THIS SAYS OUT LOUD.
   *
   * Reading a feed and classifying none of it stores posts forever, finds zero paid
   * campaigns, and renders a card saying "not classified" — which an operator reads as
   * "they do no paid work". Asked of the detector, never of the key.
   */
  function unjudgedNote(kind: string, detectorKey: string, watchEnabled: boolean): string | null {
    if (kind !== 'CHANNEL' || !watchEnabled) return null
    const r = getDetector(detectorKey).readiness?.() ?? { ready: true }
    if (r.ready) return null
    /* The detector's own reason is a SENTENCE and usually already ends in a full
       stop, so appending one printed "…once a key is configured.. No paid post".
       Trimmed rather than reworded, because the reason is the detector's to write. */
    const reason = (r.reason ?? 'no classifier is set up').replace(/\s*\.\s*$/, '')
    return `Their posts are being read but nothing is judging them — ${reason}. No paid post here can be found until that changes.`
  }

  function groundTruthNote(
    kind: string,
    handle: string,
    watchEnabled: boolean,
    ours: ReadonlySet<string>,
  ): string | null {
    if (kind !== 'CHANNEL' || !ours.has(handle)) return null
    return watchEnabled
      ? 'One of our own pages. These are the only posts where we know what was actually paid for, which is what the accuracy check is measured against.'
      : 'One of our own pages, and reading it is off. That is a real saving, and it is also the only source of new ground truth we have besides M.O.M\u2019s disclosure hashtag \u2014 while it is off, that record stops growing.'
  }

  /**
   * The legitimacy line (Tabish, 2026-08-19: "targets identified should not be faulty").
   * NULL facts render NOTHING — "never looked" must not read as a verdict; the facts
   * arrive when `pnpm ig:audit-targets --run` is run from a home IP. The review suffix
   * comes from the same pure rule the audit command uses, so the page can never flag a
   * row the audit would pass.
   */
  function legitimacy(t: {
    role: string
    optedOut: boolean
    brandCategory: string | null
    isVerified: boolean | null
    followerCount: number | null
    campaignTalent: boolean
  }): string | null {
    if (t.role !== 'PROSPECT' || t.optedOut) return null
    if (t.isVerified === null && t.followerCount === null) return null
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)
    const parts = [
      t.isVerified === true ? 'verified' : t.isVerified === false ? 'unverified' : null,
      t.followerCount !== null ? `${fmt(t.followerCount)} followers` : null,
    ].filter(Boolean)
    const audit = auditTarget({
      brandCategory: t.brandCategory,
      isVerified: t.isVerified,
      followerCount: t.followerCount,
      exists: true,
      campaignTalent: t.campaignTalent,
    })
    return `${parts.join(' · ')}${audit.flag ? ` — review: ${AUDIT_WHY_SENTENCE[audit.why]}` : ''}`
  }

  const prospects: ProspectRow[] = targets.map((t) => {
    const next = nextSenderSentence(t)
    const reply = repliesByTarget.get(t.id)
    return {
    handle: t.handle,
    displayName: operatorName(t.displayName),
    kind: t.kind,
    role: t.role,
    watchEnabled: t.watchEnabled,
    category: t.categories.find((c) => c.enabled)?.category.name ?? null,
    nextSenderSentence: next.sentence,
    nextSenderWillWrite: next.willWrite,
    unjudgedNote: unjudgedNote(t.kind, t.detectorKey, t.watchEnabled),
    groundTruthNote: groundTruthNote(t.kind, t.handle, t.watchEnabled, ourHandles),
    retired: t.optedOut,
    /* ENABLED ONLY, like the `category` field four lines up and like accounts-page.ts. A
       suspended membership is not a fleet this row belongs to, and a chip that says it does
       is a screen reporting a rule by a different rule than the one enforcing it —
       `routeAllowed` reads `readCategoryMemberships`, which filters `enabled: true`. */
    categories: t.categories.filter((c) => c.enabled).map((c) => c.category.name),
    delivered: deliveredBy.get(t.id) ?? 0,
    replied: repliedSet.has(t.id),
    /* "our other pages may still write to them" only when THIS row's own turn says one will. */
    replyNote: prospectReplyNote(
      settings.replyHaltScope,
      reply ? { senderHandles: reply.senderHandles, freesIst: istStamp(reply.frees) } : null,
      next.willWrite,
    ),
    importNote: t.importNote,
    legitimacy: legitimacy(t),
    }
  })

  return {
    prospects,
    paging: {
      page,
      pageCount,
      total,
      from: total === 0 ? 0 : (page - 1) * PROSPECTS_PAGE_SIZE + 1,
      to: Math.min(page * PROSPECTS_PAGE_SIZE, total),
    },
    query,
    categories: categoryRows.map((c) => ({
      name: c.name,
      senders: c._count.senders,
      targets: c._count.targets,
    })),
    sendersAble,
    watched,
    requestsPerSlot: watched * PAGES_PER_CHANNEL,
    requestsPerDay: watched * PAGES_PER_CHANNEL * Math.round((24 * 60) / DETECT_INTERVAL_MINUTES),
  }
}
