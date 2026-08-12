import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { newMaterialFloor } from '@/lib/cutoff'
import { deepseekCostUsd } from '@/lib/modelCall'
import { observationFor } from '@/outreach/compose'
import { generateMessageBody } from '@/outreach/generate'
import { getSettings } from '@/lib/settings'

/**
 * `pnpm ig:generate` — write a message with the model, gate it, and PRINT it.
 *
 * DRY RUN BY DEFAULT and, unlike every other command here, `--run` does not mean "write to the
 * database". There is nothing to write: this exists so a real generated message to a real
 * prospect can be READ before anyone decides whether a model may write them at all.
 *
 *   pnpm ig:generate                     no API call at all. Shows what WOULD be asked.
 *   pnpm ig:generate --run               calls the model. ~$0.0002 per message.
 *   pnpm ig:generate --run --limit 3     bounds the spend.
 *   pnpm ig:generate --run --handle x    one recipient.
 *
 * It never creates an OutreachAttempt, never sends, and never turns `generateMessages` on.
 * Reading the output is the point — CLAUDE.md's rule that tests prevent regression while
 * reading prevents never-having-been-right, and every copy defect found in this project so
 * far was found by reading a rendered message rather than by a passing assertion.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const limitArg = args[args.indexOf('--limit') + 1]
const limit = args.includes('--limit') && limitArg ? Math.max(1, Number(limitArg) || 1) : 5
const handleArg = args[args.indexOf('--handle') + 1]
const onlyHandle = args.includes('--handle') && handleArg && !handleArg.startsWith('--') ? handleArg : null

const rule = (label: string) => console.log(`\n${'─'.repeat(78)}\n${label}\n${'─'.repeat(78)}`)

async function main() {
  const settings = await getSettings()

  const pairs = await prisma.outreachPair.findMany({
    where: {
      ...(onlyHandle ? { target: { handle: onlyHandle } } : {}),
      target: { optedOut: false, ...(onlyHandle ? { handle: onlyHandle } : {}) },
    },
    include: { sender: true, target: true },
    orderBy: [{ target: { kind: 'asc' } }, { target: { handle: 'asc' } }],
  })
  if (pairs.length === 0) {
    console.log(onlyHandle ? `no pair for @${onlyHandle}` : 'no pairs')
    return
  }

  /** One pair per recipient, so a dry run shows breadth rather than four senders to one target. */
  const seenTargets = new Set<string>()
  const chosen = pairs.filter((p) => {
    if (seenTargets.has(p.targetId)) return false
    seenTargets.add(p.targetId)
    return true
  }).slice(0, limit)

  console.log(
    run
      ? `── CALLING THE MODEL for ${chosen.length} recipient(s). Nothing is written or sent. ──`
      : `── DRY RUN: no API call, no spend. Add --run to actually generate. ──`,
  )
  console.log(`   generateMessages setting is currently ${settings.generateMessages ? 'ON' : 'OFF'} — ` +
    `${settings.generateMessages ? 'the planner WILL use generated bodies' : 'the planner uses hand-written variants'}`)

  /**
   * Cost is accumulated HERE rather than read back from `ModelCall`.
   *
   * `recordModelCall` is deliberately fire-and-forget so a cost row cannot block a
   * generation, which means the last row has usually not committed when a summary query runs.
   * The first version of this script read the table and reported "$0.000196 over 2 call(s)"
   * for three messages — a spend figure that undercounts is worse than none, and this is the
   * one command whose whole job is telling someone what generation costs.
   */
  const now = new Date()
  const usageTotal = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 }
  let calls = 0
  let passed = 0
  let refused = 0
  let failed = 0

  for (const pair of chosen) {
    // The same observation the planner would hand the model: a campaign we actually detected.
    const hook = await prisma.detectedCampaign.findFirst({
      where: { targetId: pair.targetId, verdict: 'CAMPAIGN', postedAt: { gte: newMaterialFloor(now) } },
      orderBy: [{ postedAt: 'desc' }],
    })
    // The SAME function the planner uses. A copy here would show a reader something the
    // planner would not actually produce, which is the one thing this command must not do.
    const observation = await observationFor(pair.target, hook)

    const priorBodies = (
      await prisma.outreachAttempt.findMany({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
        select: { renderedBody: true },
      })
    ).map((a) => a.renderedBody)

    rule(`@${pair.sender.handle} → @${pair.target.handle}   (${pair.target.kind})`)
    console.log(`observation given to the model : ${observation ?? '(none — it is told to reference nothing)'}`)
    console.log(`messages this recipient has    : ${priorBodies.length}`)

    if (!run) {
      console.log(`(dry run — no call made)`)
      continue
    }

    const result = await generateMessageBody({
      persona: pair.sender,
      target: pair.target,
      targetKind: pair.target.kind,
      observation,
      priorBodies,
    })

    if (result.usage) {
      calls += 1
      usageTotal.cachedInputTokens += result.usage.cachedInputTokens
      usageTotal.inputTokens += result.usage.inputTokens
      usageTotal.outputTokens += result.usage.outputTokens
      console.log(
        `tokens                         : ${result.usage.cachedInputTokens} cached + ${result.usage.inputTokens} fresh in, ${result.usage.outputTokens} out`,
      )
    }

    if (result.generated === null) {
      failed += 1
      console.log(`\nNO BODY: ${result.failure}`)
      console.log(`→ the planner would fall back to a hand-written variant.`)
      continue
    }

    /**
     * The gate verdict is printed BEFORE the message, so a reader sees the judgement and then
     * checks it against the words rather than forming an impression first.
     */
    if (result.verdict && !result.verdict.ok) {
      refused += 1
      console.log(`\nQUALITY GATE REFUSED IT:`)
      for (const p of result.verdict.problems) console.log(`  · ${p.code}: ${p.detail}`)
      console.log(`→ the planner would fall back to a hand-written variant.`)
    } else {
      passed += 1
      console.log(`\nQUALITY GATE PASSED`)
    }

    console.log(`\n${result.rendered}`)
  }

  console.log(`\n${'═'.repeat(78)}`)
  if (!run) {
    console.log(`dry run — nothing called, nothing spent, nothing written.`)
    console.log(`re-run with --run to generate ${chosen.length} message(s), roughly $${(chosen.length * 0.0002).toFixed(4)}.`)
    return
  }

  console.log(`passed the gate: ${passed}   refused: ${refused}   no body at all: ${failed}`)
  console.log(`spend this run : $${deepseekCostUsd(usageTotal).toFixed(6)} over ${calls} call(s)`)
  if (calls > 0) console.log(`               : $${(deepseekCostUsd(usageTotal) / calls).toFixed(6)} per message`)

  const cacheTotal = usageTotal.cachedInputTokens + usageTotal.inputTokens
  if (cacheTotal > 0) {
    /**
     * The FIRST call of a run is a cache miss by definition — there is no prefix to hit yet —
     * so a 3-message run tops out near 66% and a warning threshold of 50% would fire on a
     * healthy run. Judged against the calls that COULD have hit instead.
     */
    const couldHaveHit = calls - 1
    const rate = Math.round((usageTotal.cachedInputTokens / cacheTotal) * 100)
    console.log(
      `prompt cache   : ${rate}% of input tokens hit` +
        (rate >= 80
          ? ` — the constant system prompt is intact.`
          : couldHaveHit > 0
            ? `. A run's FIRST call always misses, so across ${calls} calls the ceiling is about ${Math.round((couldHaveHit / calls) * 100)}%. Below that, something is being interpolated into the system prompt.`
            : `. A single call after an idle period misses because the prefix had expired; that is not a fault.`),
    )
  }
  console.log(`\nNOTHING WAS WRITTEN OR SENT. Generation stays off until \`generateMessages\` is turned on.`)
}

/**
 * `recordModelCall` is fire-and-forget by design, so disconnecting immediately loses the last
 * cost row — observed as `prisma:error The database connection is not open` on the first real
 * run. A cost table that silently drops its most recent entry is worse than one that is slow.
 */
const settle = () => new Promise<void>((r) => setTimeout(r, 250))

main()
  .then(settle)
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
