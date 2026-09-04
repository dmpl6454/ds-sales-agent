import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG } from '@/outreach/senderCategories'
import { readCategoryMemberships, categoriesFor } from '@/outreach/categories'
import { routeAllowed, fleetHandles } from '@/outreach/routes'

/**
 *   pnpm ig:sender-fleets            — DRY RUN, the default
 *   pnpm ig:sender-fleets --run      — write the memberships and the routes
 *
 * EVERY BOLLYWOOD PAGE ALSO SENDS FOR MARKETING (2026-09-04, Tabish).
 *
 * *"we need all Bollywood senders to now also be marketing category senders. Hence, they would
 * now be part of two rings (both marketing and Bollywood) and send messages accordingly."*
 *
 * ── WHY THIS IS A SCRIPT AND NOT A SEED ─────────────────────────────────────
 *
 * MEASURED on the live database before it ran: ONE `Category` row (`marketing`) and ONE
 * `CategorySender` row (@madaboutmarketingg). The four bollywood pages held NO membership at
 * all, because bollywood has always been the ABSENCE of one — `effectiveCategories([])`
 * returns the default. So "add marketing to the bollywood senders" cannot be expressed by
 * editing a row that does not exist.
 *
 * ── WHAT IT DOES, AND THE ORDER IS THE CORRECTNESS ──────────────────────────
 *
 *   1. Creates the `bollywood` Category row if it is missing, so the fleet a page belongs to
 *      is something an operator can SEE and tick rather than an absence they must know about.
 *      This changes no behaviour by itself: an explicit `bollywood` membership and no
 *      membership read identically through `effectiveCategories`.
 *   2. Gives every page currently in the rotation an explicit membership for the fleet it
 *      already sends for, and ADDS marketing to the bollywood ones.
 *   3. THEN creates the routes the new memberships permit, through the real `routeAllowed`.
 *
 * Memberships before routes, fourth time in this codebase: `routeAllowed` READS the
 * memberships, so routes created first would be computed against the OLD fleets.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * @madaboutmarketingg is NOT given bollywood. Tabish asked for the bollywood pages to also
 * send for marketing, not for the marketing page to start pitching film companies, and its
 * standard copy names Mad About Marketing. An operator can tick it on `/senders` in one click
 * if he wants that; guessing it here would be the script deciding something he did not say.
 *
 * Accounts OUTSIDE the rotation (`fleetMember: false` — the rehearsal burner
 * @tabishmukaddam1 and the retired @bachelorssociety) are untouched. That is the "none" state:
 * a page with no fleet writes to nobody, and putting the burner in a fleet is the exact
 * exposure the 26 August one-click incident produced.
 *
 * DRY RUN BY DEFAULT, like every command here that creates routes to real companies.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')

/** The fleets each page in the rotation should hold after this. */
function wantedFleets(handle: string, currently: readonly string[]): string[] {
  /* A page already in the marketing fleet stays exactly there — see the docblock. */
  if (currently.includes(MARKETING_CATEGORY_SLUG)) return [...new Set(currently)]
  /* Everything else in the rotation is a bollywood page, whether by an explicit membership or
     by the absence of one, and gains marketing beside it. */
  return [...new Set([...currently, DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG])]
}

async function main() {
  console.log(run ? 'WRITING\n' : 'DRY RUN — nothing is written. Add --run.\n')

  const senders = await prisma.senderAccount.findMany({
    where: { fleetMember: true },
    select: { id: true, handle: true, status: true },
    orderBy: { handle: 'asc' },
  })
  if (senders.length === 0) {
    console.log('No accounts are in the rotation. Nothing to do.')
    return
  }

  /* Step 1 — the bollywood row, so the fleet is nameable on screen. */
  let bollywood = await prisma.category.findUnique({ where: { slug: DEFAULT_CATEGORY_SLUG } })
  if (!bollywood) {
    console.log(`+ Category "${DEFAULT_CATEGORY_SLUG}" (Bollywood & entertainment) — it does not exist yet`)
    if (run) {
      bollywood = await prisma.category.create({
        data: { slug: DEFAULT_CATEGORY_SLUG, name: 'Bollywood & entertainment' },
      })
    }
  }
  const marketing = await prisma.category.findUnique({ where: { slug: MARKETING_CATEGORY_SLUG } })
  if (!marketing) {
    console.error(`REFUSING: there is no "${MARKETING_CATEGORY_SLUG}" fleet. Run pnpm ig:setup-categories first.`)
    process.exitCode = 1
    return
  }

  const memberships = await readCategoryMemberships()
  const bySlug = new Map([
    [MARKETING_CATEGORY_SLUG, marketing],
    ...(bollywood ? ([[DEFAULT_CATEGORY_SLUG, bollywood]] as const) : []),
  ])

  /* Step 2 — memberships. */
  const plan: { handle: string; senderId: string; adding: string[]; after: string[] }[] = []
  for (const s of senders) {
    const currently = categoriesFor(memberships.bySenderHandle, s.handle)
    const after = wantedFleets(s.handle, currently)
    const adding = after.filter((a) => !currently.includes(a))
    plan.push({ handle: s.handle, senderId: s.id, adding, after })
    console.log(
      `  @${s.handle} (${s.status}): ${currently.length ? currently.join(' + ') : '(no membership — bollywood by absence)'}` +
        `  ->  ${after.join(' + ')}${adding.length ? `   [+${adding.join(', ')}]` : '   [no change]'}`,
    )
  }

  if (run) {
    for (const p of plan) {
      for (const slug of p.after) {
        const cat = bySlug.get(slug)
        if (!cat) continue
        await prisma.categorySender.upsert({
          where: { categoryId_senderId: { categoryId: cat.id, senderId: p.senderId } },
          create: { categoryId: cat.id, senderId: p.senderId, enabled: true },
          update: { enabled: true },
        })
      }
      if (p.adding.length > 0) {
        await prisma.auditLog.create({
          data: {
            actor: `cli:${env.OPERATOR_NAME}`,
            action: 'sender.fleets.set',
            entity: `SenderAccount:${p.handle}`,
            detail: `${p.after.join(' + ')}; added ${p.adding.join(', ')} (ig:sender-fleets, 2026-09-04)`,
          },
        })
      }
    }
  }

  /* Step 3 — routes, with the memberships already written. */
  /* Sender fleets come from the PLAN, not from a re-read: in a dry run nothing was written,
     and in a real run the plan is exactly what was. Target memberships are untouched by this
     script, so the read above is still current for them. */
  const effective = new Map(plan.map((p) => [p.handle, p.after]))
  const ourHandles = await fleetHandles(prisma)
  const targets = await prisma.targetAccount.findMany({
    select: { id: true, handle: true, optedOut: true, role: true },
  })
  const targetCats = memberships

  let createdTotal = 0
  console.log('')
  for (const p of plan) {
    const existing = new Set(
      (await prisma.outreachPair.findMany({ where: { senderId: p.senderId }, select: { targetId: true } })).map(
        (x) => x.targetId,
      ),
    )
    const toCreate = targets.filter(
      (t) =>
        !existing.has(t.id) &&
        routeAllowed({
          senderHandle: p.handle,
          targetHandle: t.handle,
          senderCategories: effective.get(p.handle) ?? [],
          targetCategories: categoriesFor(targetCats.byTargetHandle, t.handle),
          ourHandles,
          senderIsFleetMember: true,
          targetOptedOut: t.optedOut,
          targetIsWatchOnly: t.role === 'WATCH',
        }),
    )
    createdTotal += toCreate.length
    console.log(`  @${p.handle}: ${toCreate.length} new route(s)`)
    if (run && toCreate.length > 0) {
      await prisma.outreachPair.createMany({
        data: toCreate.map((t) => ({
          senderId: p.senderId,
          targetId: t.id,
          cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
          enabled: true,
        })),
      })
    }
  }

  console.log(`\n${run ? 'Created' : 'Would create'} ${createdTotal} route(s) in total.`)
  if (!run) console.log('\nNothing was written. Re-run with --run.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
