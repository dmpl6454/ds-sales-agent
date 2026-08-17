import { prisma } from '@/lib/db'
import { judgeWithFrame } from '@/detection/judge'
import { tagsForStoredPost } from '@/detection/tagEvidence'
import { detectionCutoff } from '@/lib/cutoff'
import { readStringArray, writeStringArray } from '@/lib/json'

/**
 *   pnpm ig:second-look            DRY RUN — count and name what would be re-judged
 *   pnpm ig:second-look --run      spend the calls and write escalations
 *   pnpm ig:second-look --limit N  bound a first pass
 *
 * THE BACKLOG HALF of the M.O.M second look (the pipeline half runs on every detect pass
 * since 2026-08-17 — see SECOND_LOOK_DETECTORS in judge.ts). MEASURED the day this was
 * written: 61 in-window @madovermarketing_mom posts were rule-negative and NOTHING had
 * ever read them — the exact population CLAUDE.md has called "missed with certainty"
 * since the 13 August audit.
 *
 * ── RUN THIS ON THE SERVER, and the script is honest if you do not ────────────────────
 *
 * Frames live on the machine that detected them, and detection runs on the Linode. Run
 * from a laptop this would truthfully read "no frame saved" about frames sitting on the
 * server's disk — and the rejudge pass already made that mistake once, retiring 4 posts
 * from a retry queue on the evidence of the wrong machine's disk. So machine-dependent
 * ABSENCE signals (`frame:not-saved`, `frame:no-ocr-engine`) are never persisted by this
 * script: a re-judge may only record what it actually READ.
 *
 * What it never touches: rule POSITIVES (label-grade disclosures), human-labelled posts
 * (their answers outrank every model), and anything already carrying
 * `second-look:judged`. A failed call writes nothing at all, so the post stays
 * selectable — `frame:call-failed` taught that lesson at a cost of 83 posts.
 */
const argv = process.argv.slice(2)
const isRun = argv.includes('--run')
const limitArg = argv[argv.indexOf('--limit') + 1]
const limit = argv.includes('--limit') && limitArg && !limitArg.startsWith('--') ? Number(limitArg) : null

/** Signals that describe THIS MACHINE's disk, not the post. Never persisted from here. */
const MACHINE_LOCAL_ABSENCE = new Set(['frame:not-saved', 'frame:no-ocr-engine'])

async function main(): Promise<void> {
  const targets = await prisma.targetAccount.findMany({
    where: { detectorKey: 'mom' },
    select: { id: true, handle: true, optedOut: true },
  })
  if (targets.length === 0) {
    console.log('No channel uses the mom detector — nothing to do.')
    return
  }

  for (const target of targets) {
    const pending = await prisma.detectedCampaign.findMany({
      where: {
        targetId: target.id,
        verdict: 'ORGANIC',
        verdictSource: 'rules',
        humanLabel: null,
        postedAt: { gte: detectionCutoff() },
        NOT: { signals: { contains: 'second-look:judged' } },
      },
      orderBy: { postedAt: 'desc' },
      ...(limit ? { take: limit } : {}),
    })

    console.log(
      `@${target.handle}: ${pending.length} rule-negative post(s) the model has never read` +
        (isRun ? '' : ' — dry run, pass --run to judge them'),
    )
    if (!isRun) continue

    let escalated = 0
    let agreed = 0
    let failed = 0
    for (const post of pending) {
      const judged = await judgeWithFrame(
        {
          shortcode: post.shortcode,
          caption: post.caption,
          optedOut: target.optedOut,
          detectorKey: 'mom',
          tagText: await tagsForStoredPost({
            shortcode: post.shortcode,
            taggedAccounts: post.taggedAccounts,
            rawPayload: post.rawPayload,
          }),
        },
        'ORGANIC',
      )

      if (judged.secondLook === null) {
        // The caption call failed. Nothing is written, so the post stays selectable —
        // a failed call recorded as a verdict is how 83 posts went permanently unjudged.
        failed += 1
        continue
      }

      const keptSignals = judged.signals.filter((sig) => !MACHINE_LOCAL_ABSENCE.has(sig))
      await prisma.detectedCampaign.update({
        where: { id: post.id },
        data: {
          verdict: judged.verdict,
          confidence: judged.secondLook.confidence,
          verdictSource: 'semantic',
          classifierModel: 'deepseek-v4-flash',
          classifierReason: judged.secondLook.reason,
          brands: writeStringArray(
            [...new Set([...readStringArray(post.brands), ...judged.secondLook.brands])],
          ),
          signals: writeStringArray([
            ...readStringArray(post.signals),
            'backfill:ig:second-look',
            ...keptSignals,
          ]),
          ...(judged.frameText ? { frameText: judged.frameText } : {}),
        },
      })

      if (judged.verdict === 'CAMPAIGN') {
        escalated += 1
        // Print every escalation IN FULL — the 17 August re-judge shipped 11 escalations
        // and the instruction that survives it is: read them before trusting them.
        console.log(`  ESCALATED ${post.shortcode}: ${judged.secondLook.reason}`)
      } else {
        agreed += 1
      }
    }

    await prisma.auditLog.create({
      data: {
        actor: 'cli:ig:second-look',
        action: 'post.second-look.backfill',
        entity: `TargetAccount:${target.handle}`,
        detail: `judged ${escalated + agreed} rule-negative post(s): ${escalated} escalated to CAMPAIGN, ${agreed} confirmed ordinary, ${failed} call(s) failed and left retryable`,
      },
    })
    console.log(
      `@${target.handle}: ${escalated} escalated, ${agreed} confirmed ordinary, ${failed} failed (still selectable). ` +
        `Read the escalations on /paid-posts — the cross undoes any of them.`,
    )
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err)
    await prisma.$disconnect()
    process.exit(1)
  })
