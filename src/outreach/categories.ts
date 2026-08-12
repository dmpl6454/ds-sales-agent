import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { nextSender, type RingMember, type RotationChoice } from './rotation'

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

export interface WhoseTurnResult {
  categoryId: string
  categoryName: string
  choice: RotationChoice
  lastSenderId: string | null
}

/**
 * Whose turn is it to write to this recipient?
 *
 * `unavailable` is supplied by the caller — it knows which accounts are CHALLENGED, not
 * connected, or out of daily allowance, and rotation should not re-derive that. Keeping
 * the reasons as strings means a refusal can say WHICH accounts were unavailable and
 * why, rather than "nothing happened".
 */
export async function whoseTurn(args: {
  targetId: string
  unavailable?: ReadonlyMap<string, string>
}): Promise<WhoseTurnResult | null> {
  const categories = await categoriesForTarget(args.targetId)
  if (categories.length === 0) return null

  /**
   * One category per target for now, and the FIRST is used when there are several.
   *
   * Deliberately not silently merging rings: two categories rotating through one
   * recipient is a business decision about who may pitch them, and inventing an answer
   * would make that decision invisible. The dashboard shows category membership, so a
   * target in two is visible rather than mysterious.
   */
  const category = categories[0]!
  const [ring, lastSenderId] = await Promise.all([ringFor(category.id), lastSenderTo(args.targetId)])

  return {
    categoryId: category.id,
    categoryName: category.name,
    lastSenderId,
    choice: nextSender({
      ring,
      lastSenderId,
      unavailable: args.unavailable,
      targetId: args.targetId,
    }),
  }
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
