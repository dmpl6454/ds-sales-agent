/**
 * DIRECT evidence for the publisher-context input: re-judge @filmygyan's own CAMPAIGN
 * verdicts with and without it, and PRINT BOTH so the difference can be read.
 *
 * These posts have no ground truth, so the honest instrument is reading the output — the
 * discipline this repo calls "render the real thing and read it". WRITES NOTHING.
 */
import { prisma } from '@/lib/db';
import { classifyCaption } from '@/detection/detectors/semantic';
import { publisherForPrompt } from '@/detection/publisherContext';

async function main() {
  const target = await prisma.targetAccount.findUnique({
    where: { handle: 'filmygyan' },
    select: { id: true, handle: true, displayName: true },
  });
  if (!target) throw new Error('no filmygyan');

  const rows = await prisma.detectedCampaign.findMany({
    where: { targetId: target.id, verdict: 'CAMPAIGN', postedAt: { gte: new Date('2026-08-19T18:30:00Z') } },
    orderBy: { postedAt: 'desc' },
    take: 14,
    select: { shortcode: true, caption: true },
  });

  const pub = { handle: target.handle, displayName: target.displayName };
  let flipped = 0, named = 0;
  for (const r of rows) {
    const block = publisherForPrompt(r.caption, pub);
    if (block) named += 1;
    const before = await classifyCaption(r.caption, r.shortcode, null, null, null);
    const after = await classifyCaption(r.caption, r.shortcode, null, null, block);
    const b = before ? `${before.verdict} ${before.confidence}%` : 'call failed';
    const a = after ? `${after.verdict} ${after.confidence}%` : 'call failed';
    const moved = before && after && before.verdict !== after.verdict;
    if (moved) flipped += 1;
    console.log(`\n${r.shortcode}  names-publisher=${block ? 'YES' : 'no'}${moved ? '   <<<< CHANGED' : ''}`);
    console.log(`  before: ${b}  ${before?.reason ?? ''}`);
    console.log(`  after : ${a}  ${after?.reason ?? ''}`);
    console.log(`  caption: ${r.caption.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  console.log(`\n=== ${rows.length} posts · ${named} name their own publisher · ${flipped} changed verdict ===`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
