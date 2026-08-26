import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { buildGreeting } from '@/outreach/render'
import { classifyOpener, classifyTemplate, type OpenerShape } from '@/outreach/staleTemplate'
import { discardAttempt } from '@/outreach/discard'
import { getSettings } from '@/lib/settings'
import { readCategoryMemberships, categoriesFor } from '@/outreach/categories'
import { effectiveCategories, DEFAULT_CATEGORY_SLUG } from '@/outreach/senderCategories'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'

/**
 * `pnpm ig:discard-stale-drafts` — retire waiting drafts written against an older
 * message template, so the planner rewrites them with the current one. DRY RUN BY DEFAULT.
 *
 * ── WHY A DRAFT GOES STALE AT ALL ─────────────────────────────────────────
 *
 * A body is rendered ONCE and frozen, deliberately: the composer read-back compares against
 * exactly those bytes and an operator may have edited them. The cost is that changing
 * `renderMessage` leaves the whole queue carrying the previous copy with nothing on any
 * screen saying so. MEASURED the day the merged opener shipped: 46 of 46 waiting drafts,
 * the oldest six days old, every one of them still opening with a lone greeting — the exact
 * shape that made Instagram's inbox preview read "Hi Crocs India team," and nothing else.
 *
 * ── ORDERING, WHICH IS THE SAME TRAP AS `ig:dedupe-drafts` ────────────────
 *
 * RUN THIS ONLY AFTER THE NEW TEMPLATE IS DEPLOYED TO THE MACHINE THAT DRAFTS. The planner
 * runs on the Linode; until its copy of `render.ts` has the change, the next slot rewrites
 * every draft this removes IN THE OLD SHAPE, and all the run achieves is churn plus an audit
 * row apiece. The command cannot verify another host's bytes, so it prints the warning and
 * `--run` stays yours to type.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
 *
 * It discards through `discardAttempt`, the ONE writer, whose status guard lives INSIDE the
 * update — so a SENT, SENDING or REPLIED row cannot be touched however this is invoked, and
 * every removal leaves an audit row. `SKIPPED` is not an `IN_FLIGHT_STATUS`, so a discarded
 * draft does not burn the campaign or variant pool.
 *
 * And it never discards on `unknown`. `classifyOpener` answers `stale` / `current` /
 * `unknown`, and the third is what a HAND-EDITED body looks like — indistinguishable from a
 * rendering this does not recognise. Those are listed and left alone, because the
 * destructive direction here is `stale` and a queue is not garbage merely because a probe
 * could not read it.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const actor = `cli:${env.OPERATOR_NAME}`

const REASON = 'discarded as stale: written against the pre-2026-08-17 message template'

async function main(): Promise<void> {
  const waiting = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] } },
    select: {
      id: true,
      renderedBody: true,
      queuedAt: true,
      sender: { select: { handle: true } },
      target: { select: { handle: true, displayName: true, contactFirstName: true, kind: true } },
    },
    orderBy: { queuedAt: 'asc' },
  })

  if (waiting.length === 0) {
    console.log('No drafts are waiting. Nothing to do.')
    return
  }

  /**
   * The phrase comes from the EXPORTED CONSTANT, never from a copy typed here. Its first
   * line is enough to identify the template and short enough to survive an operator tidying
   * a later paragraph — the check is "was this built from the standard template", not "is it
   * byte-identical to it", because editing a draft is explicitly allowed.
   */
  const settings = await getSettings()
  // The EFFECTIVE template — the saved override when one exists, the shipped constant
  // otherwise. Reading only the constant classified every current draft stale the moment
  // an operator saved an edit, which is this broom pointed at exactly the wrong rows.
  const effectiveTemplate = settings.singleTemplateBody ?? SINGLE_TEMPLATE_MIDDLE
  const requiredPhrase = settings.singleTemplate ? (effectiveTemplate.split('\n')[0] ?? null) : null

  /**
   * ── ONE FLEET'S PHRASE CANNOT JUDGE ANOTHER FLEET'S DRAFT (2026-08-26) ────
   *
   * `requiredPhrase` above is the DEFAULT fleet's copy. Since a second fleet has its own
   * standard message (`fleetTemplate.ts`), measuring a marketing draft against it would
   * classify every one of them stale and offer to discard real, correct drafts — this
   * broom pointed at exactly the wrong rows, which is the bug the comment above records
   * being fixed once already.
   *
   * Rather than teach this command every fleet's copy, it REPORTS them and leaves them
   * alone: a broom that cannot judge a row must not sweep it, and the count says so rather
   * than the rows vanishing from the tally.
   */
  const memberships = await readCategoryMemberships()
  const otherFleet = (handle: string) =>
    effectiveCategories(categoriesFor(memberships.byTargetHandle, handle)).some(
      (c) => c !== DEFAULT_CATEGORY_SLUG,
    )
  console.log(
    settings.singleTemplate
      ? 'One standard message is in force, so a body from the old variant pools is out of date.\n'
      : 'No single template is in force; only the opener shape is checked.\n',
  )

  const buckets: Record<OpenerShape, { line: string; id: string }[]> = { stale: [], current: [], unknown: [] }

  let skippedOtherFleet = 0
  for (const d of waiting) {
    if (settings.singleTemplate && otherFleet(d.target.handle)) {
      skippedOtherFleet += 1
      continue
    }
    /**
     * The greeting comes from `buildGreeting` itself rather than being reconstructed here.
     * A probe that builds its own copy of what the writer emits is how `readThread.ts` drifted
     * from its own docblock for weeks; sharing the function is what makes the comparison mean
     * anything.
     */
    const greetingNow = buildGreeting({
      handle: d.target.handle,
      displayName: d.target.displayName,
      contactFirstName: d.target.contactFirstName,
      kind: d.target.kind,
    })

    const opener = classifyOpener({ renderedBody: d.renderedBody, greetingNow })
    const template = classifyTemplate({ renderedBody: d.renderedBody, requiredPhrase })

    /**
     * TWO INDEPENDENT REASONS A BODY CAN BE OUT OF DATE, and `stale` on EITHER is stale —
     * a draft only survives by being current on both. `unknown` still beats `stale`, because
     * the destructive direction must never win from a question we could not answer.
     */
    const shape: OpenerShape =
      opener.shape === 'unknown' || template.shape === 'unknown'
        ? 'unknown'
        : opener.shape === 'stale' || template.shape === 'stale'
          ? 'stale'
          : 'current'

    const reason =
      shape === 'stale'
        ? [opener.shape === 'stale' ? opener.detail : null, template.shape === 'stale' ? template.detail : null]
            .filter(Boolean)
            .join('; ')
        : shape === 'unknown'
          ? (opener.shape === 'unknown' ? opener.detail : template.detail)
          : opener.detail

    const age = d.queuedAt ? `${Math.floor((Date.now() - d.queuedAt.getTime()) / 86_400_000)}d old` : 'undated'
    buckets[shape].push({
      id: d.id,
      line: `  ${d.sender.handle} → @${d.target.handle}  (${age})  ${reason}`,
    })
  }

  console.log(`${waiting.length} draft(s) waiting.\n`)
  if (skippedOtherFleet > 0) {
    /* REPORTED, never silent — a bounded sweep that does not say what it left out reads as
       "covered everything", which is the truncation lesson this repo has recorded four times. */
    console.log(
      `${skippedOtherFleet} draft(s) belong to another fleet and were NOT judged — this command ` +
        `only knows the default fleet's copy.\n`,
    )
  }

  if (buckets.current.length > 0) {
    console.log(`CURRENT TEMPLATE — left alone (${buckets.current.length}):`)
    for (const r of buckets.current) console.log(r.line)
    console.log()
  }

  /**
   * Printed even when empty. "We could not read N of these" is exactly the number that
   * disappears when a report only lists what it acted on, and it is the number that says a
   * probe has stopped working.
   */
  console.log(`COULD NOT TELL — left alone, never discarded (${buckets.unknown.length}):`)
  for (const r of buckets.unknown) console.log(r.line)
  if (buckets.unknown.length === 0) console.log('  (none)')
  console.log()

  console.log(`STALE TEMPLATE (${buckets.stale.length}):`)
  for (const r of buckets.stale) console.log(r.line)
  if (buckets.stale.length === 0) console.log('  (none)')
  console.log()

  if (buckets.stale.length === 0) {
    console.log('Nothing to discard.')
    return
  }

  if (!run) {
    console.log(`DRY RUN. ${buckets.stale.length} draft(s) would be discarded. Re-run with --run.`)
    console.log()
    console.log('BEFORE YOU DO: the current template must already be deployed to the machine that')
    console.log('drafts, or the next slot rewrites every one of these in the old shape and the only')
    console.log('lasting effect is the audit trail.')
    return
  }

  let done = 0
  for (const r of buckets.stale) {
    const result = await discardAttempt({ attemptId: r.id, reason: REASON, actor })
    if (result.ok) done++
    else console.log(`  refused: ${result.message}`)
  }
  console.log(`Discarded ${done} stale draft(s). The planner rewrites them at the next slot, with the current template.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
