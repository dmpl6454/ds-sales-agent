/**
 * `pnpm ig:rejudge-channel <handle>` — re-judge a channel's already-judged in-window posts.
 * DRY RUN BY DEFAULT.
 *
 * ── WHY THIS EXISTS (2026-08-21) ──────────────────────────────────────────
 *
 * `ig:classify` selects `verdictSource: 'none'`, i.e. only posts nothing has judged yet, which
 * is right for draining a backlog and useless after an INPUT changes. When the classifier
 * gains a new input — the publisher context, or the own-marks strip on frame text — every
 * verdict already stored was formed without it, and there was no way to revisit them.
 *
 * The population this was written for: @filmygyan produced **42 CAMPAIGN verdicts since 20
 * August against @viralbhayani's 25**, almost all of them its own 10-year anniversary party
 * read as a paid placement, because the model was never told whose feed it was reading.
 * MEASURED on 14 of them: 9 flip to ORGANIC once it is told, while two genuine film promos
 * (release dates, booking links) hold at CAMPAIGN 95% — they never name their publisher, so
 * their prompt is byte-identical and they are structurally unable to move.
 *
 * ── THE GUARDS, EACH FOR A REASON THIS REPO HAS PAID FOR ──────────────────
 *
 *  - **DRY RUN IS THE DEFAULT.** Same as `ig:classify`, `ig:brands`, `ig:import` and the rest:
 *    the only commands that spend money or change verdicts must cost nothing when mistyped.
 *  - **A HUMAN LABEL IS NEVER TOUCHED.** `humanLabel` is the highest-authority verdict in the
 *    system and the only possible ground truth for video-only placements. `judgeWithFrame`
 *    refuses one anyway; this refuses to SELECT it, so the bound is not spent on rows that
 *    cannot move.
 *  - **IT GOES THROUGH `judgeWithFrame`**, the one judging path, so the frame permission table
 *    and the second-look rules apply exactly as in the pipeline. A private copy of the
 *    sequence is how 166 frames were saved in a day and never read.
 *  - **A FAILED CALL DECIDES NOTHING.** `judgeWithFrame` returning the caption verdict on a
 *    failed call is the existing contract; a row whose call failed is reported and left alone.
 *  - **BOUNDED** by `--limit` (default 40), because this spends a model call per post.
 *  - **SEMANTIC CHANNELS ONLY** (2026-10-09). It re-asks the caption of the MODEL, so on a
 *    `mom` channel it would hand `judgeWithFrame` a model ORGANIC for a post the
 *    `#Collaboration` rule called paid — and judge's second look would accept it and this
 *    script would write it, overturning a disclosure. The rule positive is never touched;
 *    `pnpm ig:second-look` is the command for that channel's negatives.
 *  - **IT KEEPS THE ROW'S OWN SIGNALS.** Only the `frame:*` evidence is replaced by what this
 *    run read; `detector:`, `model:`, the novelty scores and the rest describe how the row
 *    came to exist and are not this script's to erase.
 */
import { prisma } from '@/lib/db'
import { judgeWithFrame } from '@/detection/judge'
import { classifyCaption, modelVerdictToStored } from '@/detection/detectors/semantic'
import { publisherForPrompt } from '@/detection/publisherContext'
import { getDetector } from '@/detection/detectors'
import { detectionCutoff } from '@/lib/cutoff'
import { getSettings } from '@/lib/settings'
import { tagsForStoredPost } from '@/detection/tagEvidence'
import { readStringArray } from '@/lib/json'
import { env } from '@/lib/env'

const args = process.argv.slice(2)
const handle = args.find((a) => !a.startsWith('-'))?.replace(/^@/, '').toLowerCase()
const run = args.includes('--run')
const limitArg = args.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.split('=')[1]) : 40

async function main() {
  if (!handle) {
    console.log('usage: pnpm ig:rejudge-channel <handle> [--run] [--limit=40]')
    process.exit(1)
  }

  const target = await prisma.targetAccount.findUnique({
    where: { handle },
    select: { id: true, handle: true, displayName: true, optedOut: true, detectorKey: true },
  })
  if (!target) {
    console.log(`no target @${handle}`)
    process.exit(1)
  }

  /**
   * REFUSED BEFORE ANYTHING IS READ OR ASKED. The caption below is re-asked of the semantic
   * model, which is only the production caption path on a semantic channel. On `mom` it would
   * put a model's opinion where the publisher's own `#Collaboration` disclosure stands.
   */
  if (target.detectorKey !== 'semantic') {
    console.log(
      `@${target.handle} uses the "${target.detectorKey}" detector, not "semantic" — this command re-asks ` +
        `the caption of the model and would overwrite a rule verdict. Use pnpm ig:second-look for a mom channel.`,
    )
    process.exit(1)
  }

  const settings = await getSettings()
  const rows = await prisma.detectedCampaign.findMany({
    where: {
      targetId: target.id,
      postedAt: { gte: detectionCutoff() },
      /* Never re-judge a person's answer. */
      humanLabel: null,
      /* Only rows something has already decided — the unjudged are `ig:classify`'s job. */
      verdictSource: { not: 'none' },
    },
    orderBy: { postedAt: 'desc' },
    take: limit,
  })

  console.log(`@${target.handle}: ${rows.length} judged in-window post(s) to re-examine`)
  console.log(`mode: ${run ? 'RUN — verdicts will be written' : 'DRY RUN (pass --run to persist)'}`)
  console.log(`publisherAsContext: ${settings.publisherAsContext ? 'ON' : 'OFF'}\n`)

  const detector = getDetector(target.detectorKey)
  const ready = detector.readiness?.() ?? { ready: true }
  if (!ready.ready) {
    console.log(`  detector not ready: ${ready.reason ?? 'unknown'} — nothing to do`)
    return
  }

  let changed = 0
  let failed = 0
  for (const post of rows) {
    /**
     * The caption verdict this row already carries is what `judgeWithFrame` composes against,
     * exactly as the pipeline passes the caption-only verdict it just computed. Re-deriving it
     * here would be a second implementation of the sequence.
     */
    const before = post.verdict

    /**
     * THE CAPTION IS RE-ASKED HERE, with the publisher block, and that is deliberate.
     *
     * `judgeWithFrame` takes the caption verdict as an ARGUMENT — it does not recompute one
     * for a semantic channel — so handing it the stored verdict would compose the frame
     * against a verdict formed WITHOUT the new input, and handing it UNCLASSIFIED yields
     * UNCLASSIFIED, since the frame may never give an unjudged post a verdict. Found by
     * running it: the first version reported all 42 rows "undecided".
     *
     * This is the same two-step the pipeline performs (caption verdict, then
     * `judgeWithFrame`); the SEQUENCE that composes them still lives in one place.
     */
    /**
     * Both blocks built ONCE and handed to both calls below — the caption call here and the
     * frame call inside `judgeWithFrame` — so the two differ in exactly one input, the frame.
     * They were built twice (the tags) and derived twice (the publisher, once here and once
     * inside judge), which is two chances to drift for no gain.
     */
    const tagText = await tagsForStoredPost({
      shortcode: post.shortcode,
      taggedAccounts: post.taggedAccounts,
      rawPayload: post.rawPayload,
    })
    const publisherText = settings.publisherAsContext
      ? publisherForPrompt(post.caption, { handle: target.handle, displayName: target.displayName })
      : null
    const captionCall = await classifyCaption(post.caption, post.shortcode, null, tagText, publisherText)
    /* A failed call decides nothing — the stored verdict stands and the row is reported. */
    if (!captionCall) {
      failed += 1
      console.log(`  ${post.shortcode}  ${before} → (caption call failed) — left alone`)
      continue
    }

    const judged = await judgeWithFrame(
      {
        shortcode: post.shortcode,
        caption: post.caption,
        optedOut: target.optedOut,
        publisher: { handle: target.handle, displayName: target.displayName },
        publisherAsContext: settings.publisherAsContext,
        detectorKey: target.detectorKey,
        tagText,
        publisherText,
      },
      /* The caption verdict re-asked above, WITH the new input — see the note on that call. */
      modelVerdictToStored(captionCall.verdict),
    )

    if (judged.verdict === 'UNCLASSIFIED') {
      failed += 1
      console.log(`  ${post.shortcode}  ${before} → (call failed or undecided) — left alone`)
      continue
    }

    const moved = judged.verdict !== before
    if (moved) changed += 1
    console.log(
      `  ${post.shortcode}  ${before} → ${judged.verdict}${moved ? '   <<<< CHANGED' : ''}` +
        `\n      ${post.caption.replace(/\s+/g, ' ').slice(0, 110)}`,
    )

    if (run && moved) {
      await prisma.detectedCampaign.update({
        where: { id: post.id },
        data: {
          verdict: judged.verdict,
          /**
           * The row's own non-frame signals survive; only the footage evidence is replaced by
           * what this run read. Replacing the whole list erased `detector:semantic`, the model
           * name and the novelty scores from every row this command ever moved.
           */
          signals: JSON.stringify([
            ...readStringArray(post.signals).filter((sig) => !sig.startsWith('frame:')),
            ...judged.signals,
            'rejudged:publisher-context',
          ]),
          frameText: judged.frameText,
        },
      })
      await prisma.auditLog.create({
        data: {
          actor: `cli:${env.OPERATOR_NAME}`,
          action: 'post.rejudged',
          entity: `DetectedCampaign:${post.shortcode}`,
          detail: `${before} → ${judged.verdict} after re-judging @${target.handle} with the publisher context`,
        },
      })
    }
  }

  console.log(`\n${changed} of ${rows.length} changed · ${failed} undecided (left alone)`)
  if (!run && changed > 0) console.log('Nothing was written. Pass --run to persist.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
