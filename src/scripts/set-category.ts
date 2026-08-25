import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { MARKETING_CATEGORY_SLUG } from '@/outreach/senderCategories'

/**
 * `pnpm ig:set-category <slug> sender|target <handle>...` — put an account in a fleet.
 * `--remove` takes it out. DRY RUN BY DEFAULT.
 *
 * The one thing needed to finish standing up a second fleet: `@madaboutmarketing` is added
 * from `/senders` like any other account (a hand login from the home IP is the one act in this
 * design that cannot be automated), and then it needs to be told WHICH fleet it sends for.
 * Without that it inherits the default category and would write to bollywood companies —
 * exactly what Tabish's rule forbids.
 *
 * A membership is `enabled: false` rather than deleted on `--remove`, matching the column's
 * own comment: rotation interprets send history against it, so removing the row would rewrite
 * the past.
 */
const args = process.argv.slice(2)
const run = args.includes('--run')
const remove = args.includes('--remove')
const positional = args.filter((a) => !a.startsWith('--'))
const [slug, kind, ...handles] = positional

async function main(): Promise<void> {
  if (!slug || (kind !== 'sender' && kind !== 'target') || handles.length === 0) {
    console.error('Usage: pnpm ig:set-category <slug> sender|target <handle>... [--remove] [--run]')
    console.error(`e.g.   pnpm ig:set-category ${MARKETING_CATEGORY_SLUG} sender madaboutmarketing --run`)
    process.exitCode = 1
    return
  }
  const category = await prisma.category.findUnique({ where: { slug } })
  if (!category) {
    console.error(`No category "${slug}". Run pnpm ig:setup-categories --run first.`)
    process.exitCode = 1
    return
  }

  for (const raw of handles) {
    const handle = raw.trim().replace(/^@/, '').toLowerCase()
    const row =
      kind === 'sender'
        ? await prisma.senderAccount.findUnique({ where: { handle }, select: { id: true } })
        : await prisma.targetAccount.findUnique({ where: { handle }, select: { id: true } })
    if (!row) {
      console.log(`  @${handle} — no such ${kind}. Nothing done.`)
      continue
    }
    console.log(`  @${handle} ${remove ? 'OUT OF' : 'INTO'} "${slug}"${run ? '' : '   [dry run]'}`)
    if (!run) continue

    if (kind === 'sender') {
      await prisma.categorySender.upsert({
        where: { categoryId_senderId: { categoryId: category.id, senderId: row.id } },
        create: { categoryId: category.id, senderId: row.id, enabled: !remove },
        update: { enabled: !remove },
      })
    } else {
      await prisma.categoryTarget.upsert({
        where: { categoryId_targetId: { categoryId: category.id, targetId: row.id } },
        create: { categoryId: category.id, targetId: row.id, enabled: !remove },
        update: { enabled: !remove },
      })
    }
    await prisma.auditLog.create({
      data: {
        actor: `cli:${env.OPERATOR_NAME}`,
        action: remove ? 'category.member.removed' : 'category.member.added',
        entity: `Category:${category.id}`,
        detail: `${kind} @${handle} ${remove ? 'removed from' : 'added to'} ${slug}`,
      },
    })
  }
  if (!run) console.log('\nDRY RUN. Re-run with --run to apply.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
