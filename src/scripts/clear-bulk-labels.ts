/**
 * CLEAR THE LABELS THAT WERE NEVER JUDGEMENTS.
 *
 * ── WHAT HAPPENED ─────────────────────────────────────────────────────────
 *
 * On 2026-08-08, 21 posts were stamped `humanLabel: false` with a BYTE-IDENTICAL
 * `labelledAt` — one script, one second — under a single AuditLog row reading
 * *"paid=false x21 (review queue cleared on Tabish's instruction)"*. The script that wrote
 * them does not exist in this repo.
 *
 * Two of the 21 are the founding cases of the entire footage-reading feature:
 *
 *   DbtNU9UzWYU  the Thane bus — the frame reads `SWITCH` across the bumper
 *   Dbuk-oez_C0  the second case — the frame reads `SONY | 24 AUG | INDIAN GAME SHOW`
 *
 * CLAUDE.md documents both, at length, as genuinely paid. Both carried
 * `verdictSource: 'human'` asserting they were not — the highest-authority verdict in the
 * system, saying the two posts the capability exists to catch were ordinary.
 *
 * ── WHY CLEARING IS RIGHT, AND WHY IT NEEDED ASKING ───────────────────────
 *
 * A label stamped in the same millisecond as twenty others is a fact about the WRITE, not
 * about the post. `findBulkWrites` already treats them that way and excludes them from
 * `ig:accuracy` by default. But they were still being counted as ground truth by anything
 * that read `humanLabel` directly, and the binary-verdict change removes the "This was
 * paid" control that was the only way to fix them by hand.
 *
 * Labelling is Tabish's act, not a model's, so silently rewriting his rows would be the
 * same category of mistake as creating them. He was asked and chose to clear all 21.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * It does not decide the posts. It removes the human answer and lets each row fall back to
 * whatever the classifier concluded — `verdictSource` returns to the mechanism that
 * actually judged it. Asserting the opposite label would be minting ground truth from a
 * docblock, which is the same failure wearing the other hat.
 *
 * DRY RUN BY DEFAULT.
 */
import { prisma } from '../lib/db.js'

const RUN = process.argv.includes('--run')
const ACTOR = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

/** The two posts CLAUDE.md documents as genuinely paid, named so the output can be checked. */
const FOUNDING_CASES = new Set(['DbtNU9UzWYU', 'Dbuk-oez_C0'])

async function main() {
  const labelled = await prisma.detectedCampaign.findMany({
    where: { humanLabel: { not: null } },
    select: {
      shortcode: true,
      humanLabel: true,
      labelledAt: true,
      labelledBy: true,
      verdict: true,
      verdictSource: true,
      confidence: true,
      classifierReason: true,
      frameText: true,
      target: { select: { handle: true } },
    },
    orderBy: { labelledAt: 'asc' },
  })

  /**
   * A bulk write is a set of labels sharing a timestamp to the millisecond. Grouped rather
   * than hardcoded to a date: the rule is about the WRITE, and hardcoding 8 August would
   * miss the next one.
   */
  const groups = new Map<string, typeof labelled>()
  for (const row of labelled) {
    const key = row.labelledAt?.toISOString() ?? 'none'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const bulk = [...groups.entries()].filter(([, rows]) => rows.length > 1)
  const individual = [...groups.entries()].filter(([, rows]) => rows.length === 1)

  console.log(`Human labels stored: ${labelled.length}`)
  console.log(`  written one at a time: ${individual.length}`)
  console.log(`  written in bulk:       ${bulk.reduce((a, [, r]) => a + r.length, 0)} across ${bulk.length} write(s)\n`)

  if (bulk.length === 0) {
    console.log('No bulk writes found. Nothing to clear.')
    return
  }

  const toClear: string[] = []
  for (const [at, rows] of bulk) {
    console.log(`${'─'.repeat(72)}`)
    console.log(`BULK WRITE at ${at} — ${rows.length} labels in one millisecond, by ${rows[0]?.labelledBy ?? 'unknown'}`)
    console.log(`${'─'.repeat(72)}`)
    for (const r of rows) {
      toClear.push(r.shortcode)
      const flag = FOUNDING_CASES.has(r.shortcode) ? '  ← FOUNDING CASE of the footage feature' : ''
      console.log(`  ${r.shortcode}  @${r.target.handle}  labelled paid=${r.humanLabel}${flag}`)
      if (r.frameText) console.log(`      footage says: "${r.frameText.replace(/\s+/g, ' ').slice(0, 92)}"`)
    }
  }

  console.log(`\nClearing removes the human answer ONLY. Each post falls back to what the`)
  console.log(`classifier concluded; nothing is asserted paid on the strength of a docblock.`)

  if (!RUN) {
    console.log(`\nDRY RUN — would clear ${toClear.length} label(s). Pass --run to do it.`)
    return
  }

  const cleared = await prisma.detectedCampaign.updateMany({
    where: { shortcode: { in: toClear } },
    data: { humanLabel: null, labelledBy: null, labelledAt: null },
  })

  /**
   * `verdictSource` is deliberately NOT rewritten here. A row that reads `human` with no
   * human label is visibly inconsistent, which is better than this script inventing a
   * source it did not observe — and `rejudgeUnusedEvidence` will re-judge these rows on the
   * next detect pass, writing an honest source when it does.
   */
  await prisma.auditLog.create({
    data: {
      actor: ACTOR,
      action: 'post.labels.bulk.cleared',
      entity: `DetectedCampaign:${toClear.length}`,
      detail:
        `cleared ${cleared.count} labels written in bulk (one script, one second) — they were facts about the WRITE, ` +
        `not judgements about their posts. Includes the two founding cases of the footage feature. Tabish's decision, 2026-08-17.`,
    },
  })

  console.log(`\nCleared ${cleared.count} label(s). An audit row records what was done and why.`)
  const left = await prisma.detectedCampaign.count({ where: { humanLabel: { not: null } } })
  console.log(`Human labels remaining (each written one at a time): ${left}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
