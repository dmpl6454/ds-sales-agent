import { prisma } from '@/lib/db'
import { writeStringArray } from '@/lib/json'
import { buildVocabulary, noveltyScore } from '@/detection/detectors/novelty'
import { modelVerdictToStored, classifyCaption, semanticReadiness, tooShortToJudge } from '@/detection/detectors/semantic'
import { judgeWithFrame } from '@/detection/judge'
import { tagsForStoredPost } from '@/detection/tagEvidence'
import { detectionCutoff } from '@/lib/cutoff'
import { getDetector } from '@/detection/detectors'

/**
 *   pnpm ig:classify                     what would happen, costing nothing
 *   pnpm ig:classify --run               classify for real
 *   pnpm ig:classify --run --limit 50    a bounded first pass
 *   pnpm ig:classify --channel viralbhayani
 *
 * Classifies posts already on disk. 719 of the 746 stored posts have never been
 * judged by anything — the corpus @viralbhayani's detector was deliberately
 * accumulating while there was no classifier to use it.
 *
 * DRY RUN IS THE DEFAULT, and it is not politeness. This is the only command here
 * that spends money, and the volume is unbounded by construction: pointing it at a
 * channel with 300 unjudged posts is 300 API calls. A default that costs nothing
 * means a mistyped handle costs nothing.
 *
 * Stage 1 runs in both modes, so a dry run reports exactly how many posts would
 * reach the model and therefore what the real run will cost — measured rather than
 * estimated, before any of it is spent.
 */

const argv = process.argv.slice(2)
const isRun = argv.includes('--run')
const channelArg = argv[argv.indexOf('--channel') + 1]
const channel = argv.includes('--channel') && channelArg && !channelArg.startsWith('--') ? channelArg : null
const limitArg = argv[argv.indexOf('--limit') + 1]
const limit = argv.includes('--limit') && limitArg ? Math.max(1, parseInt(limitArg, 10) || 0) : null

async function main(): Promise<void> {
  const ready = semanticReadiness()
  if (isRun && !ready.ready) {
    console.log(`\n  Cannot classify: ${ready.reason}\n`)
    console.log('  Set DEEPSEEK_API_KEY in .env, then run again.\n')
    process.exitCode = 1
    return
  }

  const targets = await prisma.targetAccount.findMany({
    where: channel ? { handle: channel.replace(/^@/, '') } : {},
    orderBy: { handle: 'asc' },
  })
  if (targets.length === 0) {
    console.log(`\n  No channel matching "${channel}".\n`)
    process.exitCode = 1
    return
  }

  console.log(isRun ? '\n  CLASSIFYING FOR REAL — this spends money.\n' : '\n  Dry run. Nothing is sent, nothing is spent.\n')

  /**
   * ASK THE DETECTOR, never assume the channel wants classifying.
   *
   * This iterated every TargetAccount and ignored `detectorKey` entirely — so it queued
   * @bollywoodchronicle and @bollywoodsocietyy, which are **our own sending accounts**,
   * added as rehearsal targets. 457 stored posts between them, 59 of which would have
   * reached the model. Real money, spent asking DeepSeek whether our own Bollywood pages
   * run paid campaigns.
   *
   * `passthrough.readiness()` already says "this channel has no classifier set up" in
   * exactly those words. The abstraction was right; this script simply never asked — the
   * same shape as the hardcoded `detectorKey === 'passthrough'` comparison that once
   * rendered "Paid campaigns found: 0" for a channel where half the output is commercial.
   *
   * A named `--channel` is still honoured: pointing this at one channel deliberately is a
   * decision, and the message says what it is doing.
   */
  const classifiable = targets.filter((t) => {
    const detector = getDetector(t.detectorKey)
    /**
     * `readiness` is OPTIONAL on the interface, and an absent one means READY.
     *
     * `mom` does not implement it because a deterministic rule set is always able to
     * judge — it needs no API key and cannot be unconfigured. Treating "no readiness
     * method" as not-ready would have silently excluded the one channel with exact
     * ground truth, which is the channel `pnpm ig:accuracy` measures everything against.
     */
    const ready = detector.readiness?.() ?? { ready: true }
    if (ready.ready) return true
    if (channel) {
      console.log(`  @${t.handle.padEnd(24)} skipped — ${ready.reason ?? 'no classifier configured'}`)
    }
    return false
  })

  const skipped = targets.length - classifiable.length
  if (skipped > 0 && !channel) {
    console.log(`  ${skipped} channel(s) have no classifier and are skipped (nothing to spend).\n`)
  }
  if (classifiable.length === 0) {
    console.log('  No channel here has a classifier configured. Nothing to do.\n')
    return
  }

  let totalCandidates = 0
  let totalFiltered = 0
  let totalShort = 0
  let totalClassified = 0
  let totalCampaigns = 0
  /** Posts the FOOTAGE moved, reported separately — see ChannelOutcome.frameFlagged. */
  let totalFrameFlagged = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  let outputTokens = 0

  for (const target of classifiable) {
    // Vocabulary from EVERYTHING stored for this channel, judged or not — the
    // baseline describes how the channel writes, which does not depend on verdicts.
    const all = await prisma.detectedCampaign.findMany({
      where: { targetId: target.id },
      select: { caption: true },
    })
    const vocab = buildVocabulary(all.map((c) => c.caption))

    /**
     * Only posts nothing has judged, and only those on/after the detection cutoff.
     *
     * Re-running must not re-bill work already done, and history must not be billed at
     * all: Tabish's scope is 1 August onwards, which drops 381 of 746 stored posts from
     * the paid backlog. They stay UNCLASSIFIED — a word that means *not judged* and has
     * never meant *organic*.
     *
     * Note the vocabulary above is built from EVERY caption, cutoff included. The baseline
     * describes how the channel writes, and shrinking it would make ordinary words look
     * novel and degrade the free filter that saves half the spend.
     */
    const pending = await prisma.detectedCampaign.findMany({
      where: {
        targetId: target.id,
        verdictSource: 'none',
        postedAt: { gte: detectionCutoff() },
      },
      orderBy: { postedAt: 'desc' },
      ...(limit ? { take: limit } : {}),
    })

    if (pending.length === 0) {
      console.log(`  @${target.handle.padEnd(24)} nothing unjudged`)
      continue
    }

    /**
     * TOO SHORT TO BE A PITCH is settled here, free, exactly as the detector does it.
     *
     * These are bare celebrity tags (`#kajol`), `Om Shanti 🙏`, `RIP 💔` and empty
     * captions. `classifyCaption` returns null for them, and this loop treats null as
     * "the call failed" and leaves them UNCLASSIFIED — so 27 posts were reported as
     * "reaching the model" on every dry run and then classified zero, an unjudged count
     * that no amount of re-running could clear. Same rule, same reason, same source
     * string as `semanticDetector.classify`.
     */
    const short = pending.filter((p) => tooShortToJudge(p.caption))
    const judgeable = pending.filter((p) => !tooShortToJudge(p.caption))
    const survivors = judgeable.filter((p) => noveltyScore(p.caption, vocab).worthClassifying)
    totalCandidates += pending.length
    totalFiltered += judgeable.length - survivors.length

    console.log(
      `  @${target.handle.padEnd(24)} ${pending.length} unjudged → ${survivors.length} reach the model ` +
        `(${short.length} too short to be a pitch, ${judgeable.length - survivors.length} filtered free)`,
    )

    if (!isRun) continue

    if (short.length > 0) {
      await prisma.detectedCampaign.updateMany({
        where: { id: { in: short.map((p) => p.id) } },
        data: {
          verdict: 'ORGANIC',
          confidence: 0,
          verdictSource: 'rules',
          signals: writeStringArray(['detector:semantic', 'too-short-to-be-a-pitch', 'backfill:ig:classify']),
        },
      })
      totalShort += short.length
    }

    for (const post of survivors) {
      /**
       * Built ONCE and given to both the caption call and the frame call inside
       * `judgeWithFrame`. Two constructions would be two chances to differ, and a
       * difference between those two calls is attributed to the FOOTAGE by
       * `applyFrameSignal` — so it would land as a false frame-driven escalation.
       */
      const tagText = await tagsForStoredPost(post)
      const judged = await classifyCaption(post.caption, post.shortcode, null, tagText)
      if (!judged) {
        // No verdict is left as no verdict. A failed call must not be recorded as
        // ORGANIC — that would be a fabricated judgement, indistinguishable later
        // from a real one.
        continue
      }

      /**
       * The model's answer as a stored verdict — one mapping, shared with the production
       * path, so this command cannot judge by a different rule than the pipeline it
       * backfills. That drift is exactly what `tests/one-judging-path.test.ts` exists for,
       * and it caught this file holding its own copy once already.
       */
      const captionVerdict = modelVerdictToStored(judged.verdict)

      /**
       * AND THEN READ THE FOOTAGE, through the same `judgeWithFrame` the pipeline and the
       * backfill use.
       *
       * This script had its OWN copy of the stages and no frame handling at all, which
       * made it the fourth caller of a rule that has already drifted three times here
       * (`gate.ts`, `readThread.ts`, the two Connect buttons). Left alone it would have
       * quietly produced caption-only verdicts for a corpus the pipeline now judges with
       * the frame — two backfills of the same posts disagreeing depending on which
       * command someone happened to run.
       *
       * It spends nothing extra on a retired target or a decisive caption; that decision
       * lives inside `judgeWithFrame` rather than being re-implemented per caller, which
       * is the entire point.
       */
      const framed = await judgeWithFrame(
        {
          shortcode: post.shortcode,
          caption: post.caption,
          optedOut: target.optedOut,
          publisher: { handle: target.handle, displayName: target.displayName },
          detectorKey: 'semantic', // only semantic channels reach this loop
          tagText,
        },
        captionVerdict,
      )
      const verdict = framed.verdict

      await prisma.detectedCampaign.update({
        where: { id: post.id },
        data: {
          verdict,
          confidence: judged.confidence,
          verdictSource: 'semantic',
          classifierModel: 'deepseek-v4-flash',
          classifierReason: judged.reason,
          brands: writeStringArray(judged.brands),
          signals: writeStringArray(['detector:semantic', 'backfill:ig:classify', ...framed.signals]),
          ...(framed.frameText ? { frameText: framed.frameText } : {}),
        },
      })

      totalClassified += 1
      if (framed.changedByFrame) totalFrameFlagged += 1
      if (verdict === 'CAMPAIGN') totalCampaigns += 1
      cacheHitTokens += judged.usage?.cacheHit ?? 0
      cacheMissTokens += judged.usage?.cacheMiss ?? 0
      outputTokens += judged.usage?.output ?? 0

      if (totalClassified % 25 === 0) console.log(`     … ${totalClassified} classified`)
    }
  }

  console.log('')
  if (!isRun) {
    console.log(`  ${totalCandidates} unjudged posts; ${totalCandidates - totalFiltered} would reach the model.`)
    console.log(`  Re-run with --run to classify them.\n`)
    return
  }

  console.log(`  classified : ${totalClassified}`)
  console.log(`  campaigns  : ${totalCampaigns}`)
  if (totalFrameFlagged > 0) {
    // Reported separately from campaigns on purpose: a frame-driven judgement is
    // measured by nothing in ig:accuracy (its labels are caption-derived), so merging
    // it into the campaign count would hide an unmeasured number inside a measured one.
    console.log(`  raised by the footage: ${totalFrameFlagged} (caption read ordinary, frame said otherwise)`)
  }
  // Reported rather than silent: these were judged, free, and are no longer a backlog.
  if (totalShort > 0) console.log(`  too short  : ${totalShort} settled free (no product, date or link fits)`)
  // Published rates, so the number is checkable rather than a black box.
  const cost = (cacheHitTokens / 1e6) * 0.0028 + (cacheMissTokens / 1e6) * 0.14 + (outputTokens / 1e6) * 0.28
  console.log(
    `  tokens     : ${cacheHitTokens} cached + ${cacheMissTokens} uncached in, ${outputTokens} out` +
      `  ≈ $${cost.toFixed(4)}`,
  )
  if (cacheHitTokens + cacheMissTokens > 0) {
    console.log(`  cache hit  : ${Math.round((cacheHitTokens / (cacheHitTokens + cacheMissTokens)) * 100)}%`)
  }
  console.log('')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
