import { cache } from 'react'
import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { fleetRingOrder, nextSender, type RingMember, type RotationChoice } from './rotation'
import { sameCategory } from './senderCategories'

/**
 * The database half of rotation: read the ring and the history, then ask the pure
 * function whose turn it is.
 *
 * Split exactly like `gate.ts` and `governor.ts` — the DECISION is pure and tested in
 * both directions, this half is queries only. If you find yourself adding an `if` here,
 * it belongs in `rotation.ts` with a test.
 */

export interface CategorySummary {
  id: string
  name: string
  slug: string
  note: string | null
  senderCount: number
  targetCount: number
}

/** "Bollywood/Celebs" -> "bollywood-celebs". Stable, and safe in a URL. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export async function listCategories(): Promise<CategorySummary[]> {
  const rows = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { senders: true, targets: true } },
    },
  })
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    note: c.note,
    senderCount: c._count.senders,
    targetCount: c._count.targets,
  }))
}

/**
 * The ring for a category, in position order.
 *
 * Disabled memberships are INCLUDED in the returned list with `enabled: false` rather
 * than filtered out here, because `ringOrder` is where that decision belongs and hiding
 * them at the query would make the pure function untestable against real data.
 */
export async function ringFor(categoryId: string): Promise<RingMember[]> {
  const rows = await prisma.categorySender.findMany({
    where: { categoryId },
    orderBy: { position: 'asc' },
    include: { sender: { select: { id: true, handle: true } } },
  })
  return rows.map((r) => ({
    senderId: r.sender.id,
    handle: r.sender.handle,
    position: r.position,
    enabled: r.enabled,
  }))
}

/**
 * Who wrote to this target most recently — the whole of rotation's state.
 *
 * DELIVERED_STATUSES, not 'SENT'. `REPLIED` REPLACES `SENT`, so a bare 'SENT' filter
 * would forget that a sender ever wrote the moment the recipient answered — and rotation
 * would then hand that same account the next message, into the one conversation where
 * repeating a sender is most obviously wrong.
 *
 * Only DELIVERED messages count. A draft that was never sent, or a send that failed, did
 * not reach the recipient, so it is still that sender's turn. This is precisely what a
 * stored cursor gets wrong: advanced at dispatch, it would silently skip an account whose
 * message never landed.
 */
export async function lastSenderTo(targetId: string): Promise<string | null> {
  const row = await prisma.outreachAttempt.findFirst({
    where: { targetId, status: { in: [...DELIVERED_STATUSES] } },
    orderBy: { sentAt: 'desc' },
    select: { senderId: true },
  })
  return row?.senderId ?? null
}

/** Every category this target belongs to, enabled ones first. */
export async function categoriesForTarget(targetId: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.categoryTarget.findMany({
    where: { targetId, enabled: true },
    include: { category: { select: { id: true, name: true } } },
  })
  return rows.map((r) => r.category)
}

/**
 * WHICH ring decided this.
 *
 * Carried rather than inferred, because "@a is next in the Bollywood group" and "@a is next
 * in the fleet rotation" are different facts and a refusal that names the wrong one sends
 * an operator to a group that does not exist. `/messages` and `/targets` render this.
 */
export type RingKind = 'group' | 'fleet'

export interface WhoseTurnResult {
  ring: RingKind
  /** The group, when one decided. Null on the fleet ring — there is no row to link to. */
  categoryId: string | null
  categoryName: string | null
  choice: RotationChoice
  lastSenderId: string | null
}

/** How to name the ring in a sentence a person reads. PURE. */
export function describeRing(r: Pick<WhoseTurnResult, 'ring' | 'categoryName'>): string {
  return r.ring === 'group' ? (r.categoryName ?? 'this group') : 'the fleet rotation'
}

/**
 * The fleet ring FOR ONE RECIPIENT: every fleet sender that has a route to them.
 *
 * Built from the pair rows rather than from `SenderAccount` directly, and that is the
 * safety content of this function. `routes.ts` refuses some routes outright — never
 * self-pair, never pair one of OUR OWN PAGES to another — so a ring assembled from "all
 * fleet accounts" could name a sender with no pair to this target. Rotation would then
 * elect it, every real pair would be skipped as "not their turn", and the recipient would
 * get nothing while the log claimed a turn had been taken. Reading the routes that actually
 * exist makes that unreachable instead of merely unlikely.
 */
export async function fleetRingFor(targetId: string): Promise<RingMember[]> {
  const [rows, target, memberships] = await Promise.all([
    prisma.outreachPair.findMany({
      where: { targetId, sender: { fleetMember: true } },
      select: { sender: { select: { id: true, handle: true, cohort: true } } },
    }),
    prisma.targetAccount.findUnique({ where: { id: targetId }, select: { handle: true } }),
    readCategoryMemberships(),
  ])
  return fleetRingOrder(ringMembersFor(rows.map((r) => r.sender), target?.handle ?? '', memberships))
}

/**
 * ── A RING MUST NOT NAME A SENDER THE GATE WILL REFUSE (2026-08-26) ────────
 *
 * MEASURED the hour @madaboutmarketingg joined the marketing fleet: it still held **60 pair
 * rows to bollywood companies** from its old life, `routes.ts` refuses to CREATE such a route
 * and `gate.ts` refuses to SEND on one — but the RING was built from the pair rows that exist,
 * so it was in the ring for all 60, and rotation had **elected it for 15 of them**
 * (@dharmaticent, @amazonmgmstudios, @universalmusicgroup, …).
 *
 * Rotation elects ONE sender per recipient. So each of those 15 bollywood companies had its
 * turn assigned to a page the gate refuses with `different-category`, every other page was
 * skipped as `not-this-senders-turn`, and the turn only advances on a DELIVERY that can never
 * happen. **A self-locking stall** — the same one the parked-route fix records, arriving
 * through the fleet rule instead.
 *
 * This is the exact argument `fleetRingFor`'s own docblock already makes about building the
 * ring from `SenderAccount` directly: a ring that can name a sender with no usable route
 * writes nothing while the log claims a turn was taken. Nothing is weakened — the pair stays
 * refused at both ends — this only stops rotation ELECTING a page that is already forbidden,
 * so the recipient's own fleet takes its turn.
 */
export function ringMembersFor<T extends { id: string; handle: string; cohort: number }>(
  senders: readonly T[],
  targetHandle: string,
  memberships: CategoryMemberships,
): T[] {
  const targetCats = categoriesFor(memberships.byTargetHandle, targetHandle)
  return senders.filter((s) => sameCategory(categoriesFor(memberships.bySenderHandle, s.handle), targetCats))
}

/**
 * ROUTES A RECIPIENT'S OWN PAGES CANNOT USE — and rotation must skip them, not stall on them.
 *
 * ── THE STALL THIS CLOSES, MEASURED ───────────────────────────────────────
 *
 * An unsettled `not-in-thread` park refuses its PAIR at both the governor and the gate, and
 * that refusal is correct and permanent: the recipient may already hold that page's message,
 * so that page must never write to them again. What was wrong is what happened next.
 * `unavailable` carried ACCOUNT facts only (`readSenderAvailability`: flagged, signed out), so
 * rotation went on electing the parked page, `plan.ts` refused it with
 * `uncertain-delivery-unsettled`, and every OTHER pair — eligible on every rule — was skipped
 * as `not-this-senders-turn`. Nothing was ever drafted, and the turn only advances on a
 * DELIVERY, which a parked pair can never produce. A self-locking stall.
 *
 * MEASURED 2026-08-24: 18 parked rows across 14 recipients, and for 10 of them the parked page
 * was the elected one. Nine were otherwise writable — @sonypicturesin, @saarthakoberoi,
 * @smritisingh29, @sabazad, @danubeproperties, @acegroupofficial, @zeemarathiofficial,
 * @sachintendulkar, @ohhmydogindia — each with FOUR clean routes and no draft. @sabazad and
 * @zeemarathiofficial were minted on 21 August and had never received anything at all.
 *
 * ── WHY IT LIVES INSIDE ROTATION AND NOT AT THE CALLERS ───────────────────
 *
 * `whoseTurn`'s own docblock says `unavailable` "must carry MACHINE-INDEPENDENT facts only",
 * and a parked route is exactly that — a row in the shared database. Loading it HERE rather
 * than asking each caller to merge it in is the discipline this file already argues for: the
 * planner, the dashboard's "next message comes from @x", `ig:dedupe-drafts` and the hand-off
 * broom all ask rotation the same question, and a fact reaching one of them and not the others
 * is the drift `gate.ts` and `messageEntry.ts` were extracted to stop. No caller can forget it.
 *
 * NOTHING IS WEAKENED. The pair stays refused at the governor and at the gate; this only stops
 * rotation from ELECTING a page that is already forbidden, so the recipient's other pages take
 * their turn. If every page is parked, `nextSender` returns `all-unavailable` and says so —
 * fail-closed, and named, rather than a silent skip.
 */
export async function readBlockedRoutes(
  targetIds?: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const rows = await prisma.outreachAttempt.findMany({
    where: {
      status: 'FAILED',
      failureCode: { not: null },
      ...(targetIds ? { targetId: { in: [...new Set(targetIds)] } } : {}),
    },
    select: { failureCode: true, pair: { select: { targetId: true, senderId: true, sender: { select: { handle: true } } } } },
  })
  const out = new Map<string, Map<string, string>>()
  for (const r of rows) {
    const m = out.get(r.pair.targetId) ?? new Map<string, string>()
    m.set(
      r.pair.senderId,
      r.failureCode === 'not-in-thread'
        ? 'an earlier message from this page may already have reached them'
        : `an earlier message from this page is parked (${r.failureCode})`,
    )
    out.set(r.pair.targetId, m)
  }
  return out
}

/** PURE. The account facts, plus any route this recipient's pages cannot use. */
export function unavailableForTarget(
  fleetWide: ReadonlyMap<string, string> | undefined,
  blocked: ReadonlyMap<string, ReadonlyMap<string, string>>,
  targetId: string,
): ReadonlyMap<string, string> {
  const routes = blocked.get(targetId)
  if (!routes || routes.size === 0) return fleetWide ?? new Map()
  const merged = new Map<string, string>(fleetWide ?? [])
  /* The ROUTE reason wins where both apply: "signed out" and "they may already have our
     message" are different facts, and the second is the one specific to this recipient. */
  for (const [senderId, why] of routes) merged.set(senderId, why)
  return merged
}

/**
 * Whose turn is it to write to this recipient?
 *
 * NEVER NULL SINCE 2026-08-13, and that is the whole fix. It used to return null for a
 * target in no group; both branches at the one call site read `if (turn && …)`, so null
 * meant *no rotation at all* — and `Category` has had 0 rows since it was created, so null
 * was the only answer this function had ever given. Every sender drafted to every
 * recipient. See `fleetRingOrder` for the measurement.
 *
 * A target in a group uses that group's ring. A target in none uses the fleet. There is no
 * third case, so there is no way back to "everybody writes" by accident: a caller that
 * forgets to handle a refusal now fails to compile rather than falling through to the
 * permissive branch.
 *
 * `unavailable` is supplied by the caller — it knows which accounts are CHALLENGED, signed
 * out, or out of daily allowance, and rotation should not re-derive that. It must carry
 * MACHINE-INDEPENDENT facts only; see `sessionRecorded` in sessionHealth.ts for why a
 * filesystem check belongs nowhere near this. Keeping the reasons as strings means a
 * refusal can say WHICH accounts were unavailable and why, rather than "nothing happened".
 *
 * `fleet` is an optional pre-loaded ring. The planner asks this once per TARGET across a
 * run of many pairs and passes the ring it already holds; a lone caller (a page, a CLI)
 * omits it and this reads the routes itself. Same answer either way — the parameter buys
 * queries, never a different verdict.
 */
export async function whoseTurn(args: {
  targetId: string
  unavailable?: ReadonlyMap<string, string>
  fleet?: readonly RingMember[]
}): Promise<WhoseTurnResult> {
  const categories = await categoriesForTarget(args.targetId)

  /**
   * One category per target for now, and the FIRST is used when there are several.
   *
   * Deliberately not silently merging rings: two categories rotating through one
   * recipient is a business decision about who may pitch them, and inventing an answer
   * would make that decision invisible. The dashboard shows category membership, so a
   * target in two is visible rather than mysterious.
   */
  const category = categories[0] ?? null

  const [ring, lastSenderId, blocked] = await Promise.all([
    category !== null
      ? ringFor(category.id)
      : (args.fleet ?? (await fleetRingFor(args.targetId))),
    lastSenderTo(args.targetId),
    /* Loaded here so no caller can forget it — see `readBlockedRoutes`. */
    readBlockedRoutes([args.targetId]),
  ])

  return decideTurn({
    targetId: args.targetId,
    category,
    ring,
    lastSenderId,
    unavailable: unavailableForTarget(args.unavailable, blocked, args.targetId),
  })
}

/**
 * THE DECISION, shared by both loaders. No database, no clock.
 *
 * Split out when `whoseTurnForMany` arrived, because the alternative was a second copy of
 * "which ring, and what does that mean" — and one rule with several callers drifting apart
 * is the failure this codebase has now recorded five times (`gate.ts`, `readThread.ts`, the
 * two Connect buttons, `judge.ts`). The loaders differ only in how many round trips they
 * spend; the answer they compose is this function, once.
 */
function decideTurn(input: {
  targetId: string
  category: { id: string; name: string } | null
  ring: readonly RingMember[]
  lastSenderId: string | null
  unavailable?: ReadonlyMap<string, string>
}): WhoseTurnResult {
  return {
    ring: input.category !== null ? 'group' : 'fleet',
    categoryId: input.category?.id ?? null,
    categoryName: input.category?.name ?? null,
    lastSenderId: input.lastSenderId,
    choice: nextSender({
      ring: input.ring,
      lastSenderId: input.lastSenderId,
      unavailable: input.unavailable,
      targetId: input.targetId,
    }),
  }
}

/**
 * Whose turn it is for MANY recipients, in a bounded number of queries.
 *
 * ── WHY A BATCH LOADER EXISTS AT ALL ──────────────────────────────────────
 *
 * `whoseTurn` costs three queries. `/targets` renders a line per recipient, and at the
 * measured 72 targets that is 216 round trips — each ~28-37 ms across the SSH tunnel,
 * because SSH multiplexes every channel over one TCP stream and concurrency barely helps.
 * That is the same unbounded-N+1 that made `buildBrandsPanel` a ten-second page, and adding
 * a second one in the commit that fixes rotation would be a poor trade.
 *
 * FOUR queries regardless of how many recipients are asked about. The rings, the group
 * memberships and the delivery history are all read in full and joined in memory.
 *
 * `lastSenderTo` is the only subtle one: it wants the most recent DELIVERED sender PER
 * target, which SQL would express as a window function Prisma cannot emit. Reading the
 * delivered rows newest-first and keeping the first sighting of each target gives the same
 * answer, and the set is bounded by messages actually sent — 0 today, and bounded by the
 * fleet's own caps forever after.
 */
export async function whoseTurnForMany(
  targetIds: readonly string[],
  unavailable?: ReadonlyMap<string, string>,
): Promise<Map<string, WhoseTurnResult>> {
  const out = new Map<string, WhoseTurnResult>()
  if (targetIds.length === 0) return out
  const ids = [...new Set(targetIds)]

  const [pairRows, groupRows, ringRows, delivered, blocked, memberships, targetRows] = await Promise.all([
    prisma.outreachPair.findMany({
      where: { targetId: { in: ids }, sender: { fleetMember: true } },
      select: { targetId: true, sender: { select: { id: true, handle: true, cohort: true } } },
    }),
    prisma.categoryTarget.findMany({
      where: { targetId: { in: ids }, enabled: true },
      select: { targetId: true, category: { select: { id: true, name: true } } },
    }),
    prisma.categorySender.findMany({
      orderBy: { position: 'asc' },
      select: {
        categoryId: true,
        position: true,
        enabled: true,
        sender: { select: { id: true, handle: true } },
      },
    }),
    prisma.outreachAttempt.findMany({
      where: { targetId: { in: ids }, status: { in: [...DELIVERED_STATUSES] } },
      orderBy: { sentAt: 'desc' },
      select: { targetId: true, senderId: true },
    }),
    /* ONE batched query for the whole page, not one per target. */
    readBlockedRoutes(ids),
    /* Cached per request; see readCategoryMemberships. Needed so the ring cannot name a
       sender the gate refuses — see ringMembersFor. */
    readCategoryMemberships(),
    prisma.targetAccount.findMany({ where: { id: { in: ids } }, select: { id: true, handle: true } }),
  ])
  const handleById = new Map(targetRows.map((t) => [t.id, t.handle]))

  const fleetByTarget = new Map<string, { id: string; handle: string; cohort: number }[]>()
  for (const p of pairRows) {
    const list = fleetByTarget.get(p.targetId) ?? []
    list.push(p.sender)
    fleetByTarget.set(p.targetId, list)
  }

  /** First sighting wins, because the rows arrived newest-first. */
  const lastSenderByTarget = new Map<string, string>()
  for (const a of delivered) if (!lastSenderByTarget.has(a.targetId)) lastSenderByTarget.set(a.targetId, a.senderId)

  const groupByTarget = new Map<string, { id: string; name: string }>()
  for (const g of groupRows) if (!groupByTarget.has(g.targetId)) groupByTarget.set(g.targetId, g.category)

  const ringByCategory = new Map<string, RingMember[]>()
  for (const r of ringRows) {
    const list = ringByCategory.get(r.categoryId) ?? []
    list.push({ senderId: r.sender.id, handle: r.sender.handle, position: r.position, enabled: r.enabled })
    ringByCategory.set(r.categoryId, list)
  }

  for (const targetId of ids) {
    const category = groupByTarget.get(targetId) ?? null
    const ring =
      category !== null
        ? (ringByCategory.get(category.id) ?? [])
        : fleetRingOrder(
            ringMembersFor(fleetByTarget.get(targetId) ?? [], handleById.get(targetId) ?? '', memberships),
          )
    out.set(
      targetId,
      decideTurn({
        targetId,
        category,
        ring,
        lastSenderId: lastSenderByTarget.get(targetId) ?? null,
        unavailable: unavailableForTarget(unavailable, blocked, targetId),
      }),
    )
  }
  return out
}

/** Create a category, or return the existing one with that slug. Idempotent by design. */
export async function ensureCategory(name: string, note?: string): Promise<{ id: string; slug: string }> {
  const slug = slugify(name)
  const existing = await prisma.category.findUnique({ where: { slug }, select: { id: true, slug: true } })
  if (existing) return existing
  const created = await prisma.category.create({
    data: { name, slug, note: note ?? null },
    select: { id: true, slug: true },
  })
  return created
}

/**
 * Put a sender in a category at the end of the ring.
 *
 * ADDING IS NEVER THE SAME ACT AS SENDING. Membership alone changes nothing: the sender
 * still needs its own auto-send switch, a logged-in profile, an enabled pair with the
 * target, and the autopilot toggle. This mirrors `addSender`/`addTarget`, which create
 * pairs DISABLED for the same reason — someone arranging a category to see how it looks
 * must not thereby start messaging people.
 */
export async function addSenderToCategory(categoryId: string, senderId: string): Promise<void> {
  const last = await prisma.categorySender.findFirst({
    where: { categoryId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  await prisma.categorySender.upsert({
    where: { categoryId_senderId: { categoryId, senderId } },
    update: {},
    create: { categoryId, senderId, position: (last?.position ?? -1) + 1 },
  })
}

/**
 * Take a sender out of the rotation WITHOUT deleting the membership.
 *
 * The send history rotation reads is interpreted against this membership, so deleting
 * the row would rewrite the past — "who wrote last" could then name an account the ring
 * has no record of. Suspension keeps the history legible and is reversible.
 */
export async function setSenderEnabled(categoryId: string, senderId: string, enabled: boolean): Promise<void> {
  await prisma.categorySender.updateMany({ where: { categoryId, senderId }, data: { enabled } })
}

export async function addTargetToCategory(categoryId: string, targetId: string): Promise<void> {
  await prisma.categoryTarget.upsert({
    where: { categoryId_targetId: { categoryId, targetId } },
    update: {},
    create: { categoryId, targetId },
  })
}

export async function setTargetEnabled(categoryId: string, targetId: string, enabled: boolean): Promise<void> {
  await prisma.categoryTarget.updateMany({ where: { categoryId, targetId }, data: { enabled } })
}

/** Reorder the ring. Positions are rewritten from the given order, densely. */
export async function reorderRing(categoryId: string, senderIdsInOrder: readonly string[]): Promise<void> {
  for (let i = 0; i < senderIdsInOrder.length; i++) {
    await prisma.categorySender.updateMany({
      where: { categoryId, senderId: senderIdsInOrder[i]! },
      data: { position: i },
    })
  }
}

/**
 * WHICH CATEGORY DOES EACH SENDER AND EACH RECIPIENT BELONG TO?
 *
 * Keyed by HANDLE, because `routes.ts` asks in handles — a sender row and a target row for
 * the same account are two different ids, and an id-keyed map would silently answer for the
 * wrong one (the same trap `ourHandles` carries a comment about).
 *
 * TWO QUERIES for the whole fleet, loaded once by each caller and passed down, rather than a
 * lookup per pair: `ensureFleetPairs` walks senders × targets, and a query in there is an N+1
 * over a list whose size is a product decision — the defect this codebase has killed three
 * times (`buildBrandsPanel`, `buildChannelCards`, `rest-tally`).
 *
 * An EMPTY list for a handle is the correct and common answer, and it does not mean
 * "unrestricted": `effectiveCategories` reads it as the default category. See
 * `senderCategories.ts`.
 */
export interface CategoryMemberships {
  bySenderHandle: ReadonlyMap<string, string[]>
  byTargetHandle: ReadonlyMap<string, string[]>
}

export const readCategoryMemberships = cache(async (): Promise<CategoryMemberships> => {
  const [senderRows, targetRows] = await Promise.all([
    prisma.categorySender.findMany({
      where: { enabled: true },
      select: { category: { select: { slug: true } }, sender: { select: { handle: true } } },
    }),
    prisma.categoryTarget.findMany({
      where: { enabled: true },
      select: { category: { select: { slug: true } }, target: { select: { handle: true } } },
    }),
  ])
  const bySenderHandle = new Map<string, string[]>()
  for (const r of senderRows) {
    const k = r.sender.handle.toLowerCase()
    const list = bySenderHandle.get(k)
    if (list) list.push(r.category.slug)
    else bySenderHandle.set(k, [r.category.slug])
  }
  const byTargetHandle = new Map<string, string[]>()
  for (const r of targetRows) {
    const k = r.target.handle.toLowerCase()
    const list = byTargetHandle.get(k)
    if (list) list.push(r.category.slug)
    else byTargetHandle.set(k, [r.category.slug])
  }
  return { bySenderHandle, byTargetHandle }
})

/** The categories one handle belongs to, or `[]` — which `effectiveCategories` reads as the default. */
export function categoriesFor(map: ReadonlyMap<string, string[]>, handle: string): readonly string[] {
  return map.get(handle.toLowerCase()) ?? []
}
