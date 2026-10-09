/**
 * `pnpm reclassify` — RETIRED (2026-10-09). It refuses, and says what to run instead.
 *
 * Kept as a refusal rather than deleted so the command still explains itself to anyone who
 * remembers it: a missing script reads as a broken install, while this sentence reads as a
 * decision.
 *
 * ── WHY IT WAS RETIRED ─────────────────────────────────────────────────────────────
 *
 * It re-ran each channel's detector over every stored caption and, with `--apply`, wrote the
 * result straight over `verdict`, `confidence`, `signals` and `brands`. Three things were
 * wrong with that, and every one of them is a rule this codebase already enforces elsewhere:
 *
 *   1. IT OVERWROTE HUMAN LABELS. It selected every row with no `humanLabel` filter, so a
 *      person's answer — the highest-authority verdict in the system and the only possible
 *      ground truth for a placement that lives in the footage — was replaced by a model's.
 *      Its own docblock claimed to "preserve any human label"; it preserved the label column
 *      and overwrote the verdict that column exists to settle.
 *   2. IT JUDGED OUTSIDE THE ONE JUDGING PATH. It called the detector and wrote the answer,
 *      never `judgeWithFrame` — so it reverted the M.O.M second look's results, and since the
 *      detector now returns the CAPTION verdict alone, `--apply` would have written
 *      caption-only verdicts over every footage escalation: the frame clearing posts, which
 *      `applyFrameSignal` exists to forbid.
 *   3. IT SPENT MONEY IN REPORT MODE. The dry run still called the model once per semantic
 *      row, across the whole corpus — the one command here whose default was not free.
 *
 * What replaces it, each going through `judgeWithFrame`, each dry-run by default, each
 * refusing human-labelled rows:
 *
 *   pnpm ig:rejudge-channel <handle>   re-judge a semantic channel after an INPUT changes
 *   pnpm ig:classify                   judge posts nothing has judged yet
 *   pnpm ig:second-look                re-judge the M.O.M rule's negatives
 */
console.log(
  [
    '',
    '  pnpm reclassify is retired — it is not safe to run.',
    '',
    '  It wrote detector verdicts straight over stored rows: over human labels, outside the one',
    '  judging path (so it would have undone every footage escalation and M.O.M second look),',
    '  and it called the model for every row even in report mode.',
    '',
    '  Use instead (each is a dry run unless you pass --run, and none touches a human answer):',
    '    pnpm ig:rejudge-channel <handle>   re-judge a semantic channel after an input changes',
    '    pnpm ig:classify                   judge posts nothing has judged yet',
    '    pnpm ig:second-look                re-judge the M.O.M rule’s negatives',
    '',
  ].join('\n'),
)
process.exitCode = 1
