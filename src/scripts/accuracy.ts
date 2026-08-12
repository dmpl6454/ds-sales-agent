/**
 *   pnpm ig:accuracy
 *
 * Measures the classifier against the ONE channel where ground truth exists.
 *
 * @madovermarketing_mom discloses paid work with #Collaboration, so its rule-based
 * verdict is a LABEL, not an opinion. The disclosure hashtags are stripped before the
 * caption reaches the model, so it cannot read the answer — it has to reach the same
 * conclusion from the words alone. That makes this a real held-out test rather than a
 * demonstration.
 *
 * Why it is worth a command rather than a one-off script: the prompt is the classifier.
 * Editing it is editing behaviour, and without a number attached, "improving" the
 * wording is indistinguishable from breaking it. Measured 2026-08-03 while tightening
 * the prompt: 67% → 85% → 96% correct, false alarms 9 → 4 → 1, recall 100% throughout.
 *
 * RECALL IS THE ONE TO PROTECT. A missed paid post is invisible and unappealable; a
 * false alarm surfaces as a draft a human reads before anything is sent. Never trade
 * recall for precision here.
 *
 * Costs a few tenths of a cent per run (27 captions).
 */
import { prisma } from '@/lib/db'
import { classifyCaption } from '@/detection/detectors/semantic'
import { readFrameText } from '@/detection/ocr'
import { applyFrameSignal, type FrameEvidence } from '@/detection/frameSignal'
import type { Verdict } from '@/lib/constants'

/**
 * `--no-frames` measures the CAPTION ALONE, which is what this harness did before the
 * footage was read at all. Keep both numbers when you change either input: the gate is
 * "did adding frame text move recall or precision", and that question needs a before.
 */
const useFrames = !process.argv.includes('--no-frames')

const t = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: 'madovermarketing_mom' } })
const posts = await prisma.detectedCampaign.findMany({
  where: { targetId: t.id, verdictSource: 'rules' },
  select: { caption: true, verdict: true, shortcode: true },
})

let tp = 0, tn = 0, fp = 0, fn = 0
let withFrameText = 0
let skipped = 0
/** Labelled-PAID posts the footage rescued from ORGANIC into the review queue. The win. */
let rescued = 0
/** Labelled-ORGANIC posts the footage pushed into the review queue. The cost, in attention. */
let extraReview = 0
const errors: string[] = []
const frameMoves: string[] = []

for (const p of posts) {
  // Strip the disclosure tags so the model cannot simply read the answer.
  const blind = p.caption.replace(/#(collaboration|collab|ad|sponsored|paidpartnership|partnership)\b/gi, '')

  /**
   * THIS HARNESS RUNS THE PRODUCTION PATH, in the production ORDER.
   *
   * Caption first, alone. Then — only if that verdict is ORGANIC or REVIEW — the frame
   * text, then `applyFrameSignal`. Anything else measures a pipeline that does not exist:
   * calling once WITH frame text would let the footage produce a CAMPAIGN, which the real
   * detector forbids, and would report a false-alarm rate for verdicts it cannot reach.
   */
  const captionCall = await classifyCaption(blind)
  if (!captionCall) { skipped++; continue }
  const captionOnly: Verdict =
    captionCall.verdict === 'CAMPAIGN' && captionCall.confidence < 70 ? 'REVIEW' : captionCall.verdict

  let withFrame: Verdict = captionOnly
  let evidence: FrameEvidence = { kind: 'read', hadText: false }
  if (useFrames && (captionOnly === 'ORGANIC' || captionOnly === 'REVIEW')) {
    const frame = await readFrameText(p.shortcode)
    evidence = frame.evidence
    if (frame.prompt) {
      withFrameText++
      const frameCall = await classifyCaption(blind, undefined, frame.prompt)
      if (frameCall) {
        withFrame =
          frameCall.verdict === 'CAMPAIGN' && frameCall.confidence < 70 ? 'REVIEW' : frameCall.verdict
      }
    }
  }

  const final = applyFrameSignal(captionOnly, withFrame, evidence).verdict
  const truth = p.verdict === 'CAMPAIGN'

  /**
   * `pred` stays "CAMPAIGN and confident", UNCHANGED, so the four headline numbers remain
   * comparable with every measurement in CLAUDE.md. A frame-driven move lands in REVIEW,
   * which scores here exactly as ORGANIC does — deliberately, because a review request is
   * not a claim that the post is paid. The two counters below are what make that move
   * visible at all; without them the whole feature could work or misfire and every printed
   * figure would be byte-identical.
   */
  const pred = final === 'CAMPAIGN' && captionCall.confidence >= 70
  if (final === 'REVIEW' && captionOnly === 'ORGANIC') {
    if (truth) { rescued++; frameMoves.push(`RESCUED  ${p.shortcode} :: ${p.caption.replace(/\s+/g,' ').slice(0,70)}`) }
    else { extraReview++; frameMoves.push(`to review ${p.shortcode} :: ${p.caption.replace(/\s+/g,' ').slice(0,70)}`) }
  }

  if (truth && pred) tp++
  else if (!truth && !pred) tn++
  else if (!truth && pred) { fp++; errors.push(`FP [${captionCall.confidence}%] ${captionCall.reason} :: ${p.caption.replace(/\s+/g,' ').slice(0,90)}`) }
  else { fn++; errors.push(`FN [${final} ${captionCall.confidence}%] ${captionCall.reason} :: ${p.caption.replace(/\s+/g,' ').slice(0,90)}`) }
}

const n = tp + tn + fp + fn
console.log(`\nGround truth = #Collaboration disclosure (hashtag REMOVED before the model saw it)`)
console.log(`input: caption${useFrames ? ` first, then cover-frame text where the caption said ordinary (${withFrameText} of ${posts.length} reached the frame call)` : ' ONLY (--no-frames)'}`)
console.log(`n=${n}   truePaid=${tp+fn}  trueOrganic=${tn+fp}${skipped ? `  (${skipped} skipped: the call failed)` : ''}\n`)
console.log(`  correct   : ${tp + tn}/${n} = ${Math.round(((tp+tn)/n)*100)}%`)
console.log(`  caught    : ${tp}/${tp+fn} paid posts  (recall ${tp+fn ? Math.round((tp/(tp+fn))*100) : 0}%)`)
console.log(`  precision : ${tp+fp ? Math.round((tp/(tp+fp))*100) : 0}%  (${fp} false alarms)`)
console.log(`\n  confusion: TP=${tp} TN=${tn} FP=${fp} FN=${fn}`)

console.log(`\n  what the FOOTAGE changed (invisible to the four figures above):`)
console.log(`    ${rescued} labelled-paid post(s) raised to review that the caption alone called ordinary`)
console.log(`    ${extraReview} labelled-organic post(s) raised to review — the cost, paid in attention`)
if (frameMoves.length) for (const m of frameMoves) console.log(`    ${m}`)

if (errors.length) { console.log('\n  mistakes:'); for (const e of errors) console.log('   ' + e) }

/**
 * WHAT THIS NUMBER STILL DOES NOT MEAN, said here so it cannot be quoted without it.
 *
 * The labels are #Collaboration disclosures — CAPTION-derived. So this measures caption
 * classification, and now also whether adding frame text HARMS it. It cannot measure
 * recall on placements that live only in the footage: a post whose label came from its
 * caption cannot be evidence about a post whose caption says nothing. That number comes
 * only from human answers on flagged posts (`humanLabel`), and it accumulates as those
 * are settled on /paid-posts.
 */
console.log(`\nThis measures CAPTION classification, and whether frame text harms it.`)
console.log(`It cannot measure recall on placements that live only in the footage — those`)
console.log(`are counted only as you settle flagged posts on /paid-posts.`)
