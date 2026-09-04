import { prisma } from '@/lib/db'
import { memoView, viewKey } from '@/lib/viewMemo'
import { DEFAULT_CATEGORY_SLUG } from '@/outreach/senderCategories'
import type { TemplateSettings } from '@/outreach/fleetTemplate'

/**
 * THE SECOND FLEET'S STANDARD MESSAGE, AND HOW MANY COMPANIES ARE WAITING ON IT.
 *
 * ── WHY THE COUNT IS PART OF THIS AND NOT A NICETY ────────────────────────
 *
 * With no copy written, `evaluatePair` refuses to draft for that fleet — so the queue is
 * empty of them, the "Up next" list says nothing, and the only trace is a skip reason in a
 * planner log. The page would show a blank textarea and no indication that 35 real
 * companies are sitting behind it. That is *"nothing renders an absence"*, the failure this
 * project has now paid for with a 158-minute silent outage, 166 unread cover frames and a
 * correct `fleetUsage().today` that reached no screen.
 *
 * So the number travels WITH the box that fixes it.
 *
 * ── TWO QUERIES, NOT ONE PER FLEET ────────────────────────────────────────
 *
 * `/` is at 132 against a 160 query budget, and a budget is a ceiling over a bounded
 * design. A loop over fleets issuing a count each would be an N+1 over a list whose size is
 * a product decision — the defect killed four times here (`buildBrandsPanel`,
 * `buildChannelCards`, `buildRestTally`, `materialHolds`). Both reads are grouped.
 *
 * `_count.senders` counts MEMBERSHIPS, which is the honest number for "does a page send for
 * this fleet" — a membership is what `routeAllowed` reads, and an account that exists but is
 * in no category is in the DEFAULT fleet, not this one.
 */
export interface FleetTemplateRow {
  slug: string
  name: string
  /** The saved copy, or '' when nobody has written it. Never a placeholder or a fallback. */
  body: string
  /** Live, non-retired prospects in this fleet: who receives nothing while `body` is empty. */
  waitingCompanies: number
  /** Pages that send for this fleet. Zero means the copy is not the only thing missing. */
  senderCount: number
}

/** Memoised (single-flight, 10 s) on its inputs — see `src/lib/viewMemo.ts`. */
export async function buildFleetTemplates(settings: TemplateSettings): Promise<FleetTemplateRow[]> {
  return memoView(viewKey('FleetTemplates', [settings]), () => computeFleetTemplates(settings))
}

async function computeFleetTemplates(settings: TemplateSettings): Promise<FleetTemplateRow[]> {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, _count: { select: { senders: true } } },
  })

  /**
   * The DEFAULT fleet is excluded even if somebody creates a `Category` row for it: its copy
   * is `singleTemplateBody`, edited by the box above, and rendering a second editor for the
   * same message is how two controls come to disagree.
   */
  const others = categories.filter((c) => c.slug !== DEFAULT_CATEGORY_SLUG)
  if (others.length === 0) return []

  const live = await prisma.categoryTarget.groupBy({
    by: ['categoryId'],
    where: {
      categoryId: { in: others.map((c) => c.id) },
      enabled: true,
      target: { role: 'PROSPECT', optedOut: false },
    },
    _count: true,
  })
  const liveByCategory = new Map(live.map((r) => [r.categoryId, r._count]))

  return others.map((c) => ({
    slug: c.slug,
    name: c.name,
    body: settings.fleetTemplateBodies.get(c.slug) ?? '',
    waitingCompanies: liveByCategory.get(c.id) ?? 0,
    senderCount: c._count.senders,
  }))
}
