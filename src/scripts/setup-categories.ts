import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  MARKETING_CATEGORY_SLUG,
  MARKETING_CHANNEL_HANDLES,
  DEFAULT_CATEGORY_SLUG,
} from '@/outreach/senderCategories'
import { handleExists } from '@/detection/exists'
import { enrichHandle } from '@/detection/enrichHandle'

/**
 * `pnpm ig:setup-categories` — stand up the SECOND fleet. DRY RUN BY DEFAULT.
 *
 * ── WHAT TABISH ASKED FOR (2026-08-25) ────────────────────────────────────
 *
 * *"we are to have two categories of senders and monitoring targets … the second category
 * would consist of target channels: madovermarketing, socialsamosa, afaqs, exchange4media,
 * Marketingmentalist … Only targets obtained from them are to be messaged using a new sender
 * that I would be adding (it is called madaboutmarketing)."*
 *
 * This does four things and refuses to guess at any of them:
 *
 *   1. creates the `marketing` category (the `bollywood` one is the ABSENCE of a membership —
 *      see `senderCategories.ts`; creating a row for it would mean migrating 500 targets and
 *      5 senders to change nothing);
 *   2. adds the four missing channels as WATCH targets, each verified against Instagram
 *      first — a wrong watch page is not harmless, its CAMPAIGN posts mint real prospects
 *      that get real DMs, which is the @filmigyan measurement (6 of 14 handles as typed
 *      resolved to wrong accounts that EXIST);
 *   3. puts all five channels in `marketing`;
 *   4. moves the prospects DISCOVERED FROM those channels into `marketing`, so a bollywood
 *      page stops writing to them.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * **It creates no sender.** `@madaboutmarketing` does not exist yet — Tabish adds it himself,
 * from the real form, because a sending account needs a hand login from the home IP and that
 * is the one act in this design that cannot be automated. Until it exists the marketing
 * prospects have NO sender, which is exactly his instruction: *"for madovermarketing no
 * messages are to be sent currently to targets obtained from them."* They sit, correctly
 * unreachable, rather than being written to by the wrong fleet.
 *
 * **It never moves a prospect that a bollywood post also names.** His own exception —
 * *"unless they are present common elsewhere"* — so a company both fleets found stays
 * reachable by both. MEASURED before this shipped: of the 41 prospects discovered from
 * @madovermarketing_mom, **0** are tagged on any other channel's paid post, so on today's data
 * every one moves. The check is still made, because that is a fact about today and not a rule.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const actor = `cli:${env.OPERATOR_NAME}`

async function main(): Promise<void> {
  console.log(`Second fleet: "${MARKETING_CATEGORY_SLUG}" (the first is the absence of a membership: "${DEFAULT_CATEGORY_SLUG}")\n`)

  /* ── 1. the category ─────────────────────────────────────────────────── */
  let category = await prisma.category.findUnique({ where: { slug: MARKETING_CATEGORY_SLUG } })
  if (category) {
    console.log(`  category "${MARKETING_CATEGORY_SLUG}" already exists`)
  } else {
    console.log(`  create category "${MARKETING_CATEGORY_SLUG}"${run ? '' : '   [dry run]'}`)
    if (run) {
      category = await prisma.category.create({
        data: {
          name: 'Marketing & advertising trade',
          slug: MARKETING_CATEGORY_SLUG,
          note: 'Trade press watched for paid posts. Its prospects are messaged only by its own senders.',
        },
      })
      await prisma.auditLog.create({
        data: { actor, action: 'category.created', entity: `Category:${category.id}`, detail: MARKETING_CATEGORY_SLUG },
      })
    }
  }

  /* ── 2 & 3. the channels ─────────────────────────────────────────────── */
  console.log('\n  channels:')
  for (const handle of MARKETING_CHANNEL_HANDLES) {
    let target = await prisma.targetAccount.findUnique({ where: { handle } })

    if (!target) {
      /**
       * VERIFIED AGAINST INSTAGRAM BEFORE IT IS ADDED, never on the strength of the typed
       * string. `handleExists` reads `web_profile_info`, which 404s for a missing handle —
       * `instagram.com/<handle>/` returns 200 for accounts that do not exist and would make
       * this check unreachable.
       */
      const exists = await handleExists(handle)
      if (exists !== 'exists') {
        console.log(`    @${handle} — Instagram says "${exists}". NOT ADDED; check the handle.`)
        continue
      }
      const who = await enrichHandle(handle)
      console.log(
        `    @${handle} — add as WATCH  (${who.fullName ?? 'no name'}${who.isVerified === true ? ', verified' : who.isVerified === false ? ', UNVERIFIED' : ''})${run ? '' : '   [dry run]'}`,
      )
      if (run) {
        target = await prisma.targetAccount.create({
          data: {
            handle,
            displayName: who.fullName ?? handle,
            kind: 'CHANNEL',
            role: 'WATCH',
            /* `semantic`, not `mom`: `mom` is a hand-written #Collaboration rule for ONE
               publisher, and applying it to another channel would silently mislabel its posts. */
            detectorKey: 'semantic',
            watchEnabled: true,
          },
        })
        await prisma.auditLog.create({
          data: {
            actor,
            action: 'target.added',
            entity: `TargetAccount:${target.id}`,
            detail: `@${handle} added as a WATCH page for the ${MARKETING_CATEGORY_SLUG} fleet`,
          },
        })
      }
    } else {
      console.log(`    @${handle} — already a ${target.role} target`)
    }

    if (!run || !category || !target) continue
    await prisma.categoryTarget.upsert({
      where: { categoryId_targetId: { categoryId: category.id, targetId: target.id } },
      create: { categoryId: category.id, targetId: target.id },
      update: { enabled: true },
    })
  }

  /* ── 4. the prospects those channels found ───────────────────────────── */
  console.log('\n  prospects discovered from those channels:')
  /* `discoveredFromCampaignId` is a plain column, not a relation, so this is two steps:
     the campaigns those channels posted, then the prospects minted from them. */
  const marketingCampaigns = await prisma.detectedCampaign.findMany({
    where: { target: { handle: { in: [...MARKETING_CHANNEL_HANDLES] } } },
    select: { id: true },
  })
  const discovered = await prisma.targetAccount.findMany({
    where: {
      role: 'PROSPECT',
      discoveredFromCampaignId: { in: marketingCampaigns.map((c) => c.id) },
    },
    select: { id: true, handle: true, optedOut: true },
  })

  let moved = 0
  let sharedWithBollywood = 0
  for (const p of discovered) {
    /**
     * "UNLESS THEY ARE PRESENT COMMON ELSEWHERE" — his exception, enforced rather than
     * assumed. A company also asserted on another channel's paid post belongs to both fleets,
     * so it is left in the default category and stays reachable by the pages already writing
     * to it. Checked per row because it is a fact about today's corpus, not a rule.
     */
    const alsoBollywood = await prisma.detectedCampaign.findFirst({
      where: {
        verdict: 'CAMPAIGN',
        taggedAccounts: { contains: `"${p.handle}"` },
        target: { handle: { notIn: [...MARKETING_CHANNEL_HANDLES] } },
      },
      select: { id: true },
    })
    if (alsoBollywood) {
      sharedWithBollywood += 1
      continue
    }
    moved += 1
    if (!run || !category) continue
    await prisma.categoryTarget.upsert({
      where: { categoryId_targetId: { categoryId: category.id, targetId: p.id } },
      create: { categoryId: category.id, targetId: p.id },
      update: { enabled: true },
    })
  }

  console.log(`    ${discovered.length} found · ${moved} moved to ${MARKETING_CATEGORY_SLUG} · ${sharedWithBollywood} left in both (named on a bollywood post too)`)

  if (run && category && moved > 0) {
    await prisma.auditLog.create({
      data: {
        actor,
        action: 'category.targets.assigned',
        entity: `Category:${category.id}`,
        detail: `${moved} prospect(s) discovered from ${MARKETING_CATEGORY_SLUG} channels moved into it; ${sharedWithBollywood} left shared`,
      },
    })
  }

  if (!run) {
    console.log('\nDRY RUN. Re-run with --run to apply. Nothing is deleted and no sender is created —')
    console.log('add @madaboutmarketing from /senders yourself, and put it in this category there.')
    return
  }
  console.log('\nDone. Those prospects now have NO sender until a marketing account is added,')
  console.log('which is the instruction: no messages to them from the bollywood fleet.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
