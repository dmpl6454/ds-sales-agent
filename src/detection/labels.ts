import { prisma } from '@/lib/db'

/**
 * ── ONE LABELLED SET, THREE SOURCES, PROVENANCE ON EVERY ROW ──────────────────────────
 *
 * `pnpm ig:accuracy` scored ONE channel and one source: @madovermarketing_mom's
 * `#Collaboration` disclosures. Everything else this system knows to be true was invisible
 * to it:
 *
 *   - **human answers** were structurally excluded (the harness scopes to
 *     `verdictSource: 'rules'`), and they are the ONLY possible ground truth for a paid
 *     placement that lives in the footage — the class the whole OCR feature exists for.
 *   - **`KnownPaidPost`** — 33 shortcodes Tabish supplied — is read by no code at all.
 *
 * So the harness measured 21 paid posts on the one channel where the classifier never runs
 * in production (M.O.M's detector is `mom`, a hashtag rule), while @viralbhayani supplies
 * most of the paid posts and had nothing to score against.
 *
 * ── SOURCES ARE NEVER MERGED SILENTLY ─────────────────────────────────────────────────
 *
 * A `#Collaboration` hashtag is a FACT — the publisher disclosed it. A human answer is a
 * JUDGEMENT. `KnownPaidPost` is a third thing again: Tabish's own list, from outside this
 * system. `verdictSource` already exists to keep a fact apart from an opinion, and adding
 * them together into one figure would throw that distinction away at exactly the moment it
 * starts to matter. Every row carries where it came from, and the harness prints the mix.
 */

/**
 * The hashtags a publisher uses to say "I was paid for this".
 *
 * Kept in ONE place and exported so the harness, the labelled set and the blinding step in
 * `ig:accuracy` cannot drift — the harness strips exactly these before the model sees the
 * caption, and a label derived from a tag the blinding does not remove would let the model
 * read the answer. That is the difference between a held-out test and a demonstration.
 *
 * Word-boundary anchored: `#adventure` must not read as `#ad`.
 */
export const DISCLOSURE_PATTERN =
  /#(collaboration|collab|ad|sponsored|paidpartnership|paid_partnership|partnership)\b/i

export const LABEL_SOURCES = {
  /** The publisher tagged their own post. A fact about the post. */
  DISCLOSURE: 'disclosure',
  /** A person answered the review queue. The highest authority, and a judgement. */
  HUMAN: 'human',
  /** Tabish's own list of posts he knows were paid, supplied from outside this system. */
  KNOWN_PAID: 'known-paid',
} as const

export type LabelSource = (typeof LABEL_SOURCES)[keyof typeof LABEL_SOURCES]

export interface LabelRow {
  shortcode: string
  /** Lowercase handle of the channel that posted it. */
  channel: string
  /** The answer this label asserts. */
  paid: boolean
  source: LabelSource
  /** When the label came into being, where that is known. Null for a disclosure. */
  at: Date | null
}

/**
 * ── LABELS WRITTEN IN BULK ARE NOT ANSWERS, AND THIS IS HOW THEY ARE FOUND ────────────
 *
 * MEASURED: 21 posts share the byte-identical `labelledAt` of `2026-08-08 11:04:04.042`,
 * written by a script that is not in this repo, all saying "not paid" — and two of them are
 * the founding cases of the footage feature (the Thane bus with SWITCH across the bumper,
 * and the Sony game show). They are `verdictSource: 'human'`, which is the highest-authority
 * verdict in the system, so a harness that included them would score the two posts this
 * capability exists to catch as correct misses.
 *
 * The rule is deliberately about the WRITE and not about the answer: a label stamped in the
 * same millisecond as twenty others was not a judgement about *this* post, whatever it says.
 * That is a property anyone can check against the database, rather than an opinion about
 * which answers look wrong — and it leaves individually-given answers, which are exactly
 * what the harness is missing, fully in scope.
 *
 * PURE, so both directions are testable: a genuine run of answers a person gave one after
 * another has distinct timestamps and survives; a bulk write does not.
 *
 * It never CHANGES a label. Phase 7 of the repair plan is Tabish's decision, and the whole
 * point of surfacing these is that nothing rewrites them automatically.
 */
export const BULK_WRITE_MIN = 5

export function findBulkWrites<T extends { at: Date | null }>(rows: readonly T[]): {
  bulk: T[]
  individual: T[]
  /** One entry per bulk write, so a report can name when it happened and how big it was. */
  groups: Array<{ at: Date; count: number }>
} {
  const byStamp = new Map<number, T[]>()
  const undated: T[] = []
  for (const r of rows) {
    if (r.at === null) {
      undated.push(r)
      continue
    }
    const k = r.at.getTime()
    byStamp.set(k, [...(byStamp.get(k) ?? []), r])
  }

  const bulk: T[] = []
  const individual: T[] = [...undated]
  const groups: Array<{ at: Date; count: number }> = []
  for (const [ms, group] of byStamp) {
    if (group.length >= BULK_WRITE_MIN) {
      bulk.push(...group)
      groups.push({ at: new Date(ms), count: group.length })
    } else {
      individual.push(...group)
    }
  }
  groups.sort((a, b) => b.count - a.count)
  return { bulk, individual, groups }
}

export interface LabelledSet {
  rows: LabelRow[]
  /** Excluded by `findBulkWrites`, kept so the report can name them rather than hide them. */
  excludedBulk: LabelRow[]
  bulkGroups: Array<{ at: Date; count: number }>
  /**
   * `KnownPaidPost` shortcodes that are NOT in the corpus, so cannot be scored.
   *
   * Reported rather than dropped. MEASURED: **0 of the 33 are in the corpus** and their
   * captions cannot be fetched anonymously, so this list is the whole of that source until
   * those feeds are read further back. A source contributing nothing must say so; silence
   * reads as "there was nothing to add".
   */
  knownPaidNotInCorpus: string[]
}

/**
 * Every label this system holds, with its provenance.
 *
 * ── NOT SCOPED TO THE DETECTION CUTOFF, AND THAT IS DELIBERATE ────────────────────────
 *
 * The first version of this applied `detectionCutoff()`, on the reasoning that production
 * never judges a pre-August post so scoring one measures a question nobody asks. Running it
 * showed the cost: **n fell from 80 to 65 and the paid labels from 21 to 17**, silently
 * resetting the baseline every figure in CLAUDE.md is measured against.
 *
 * The reasoning was wrong as well as expensive. The cutoff is a decision about which posts
 * are WORTH judging, not a claim about what the classifier can read — a caption from July
 * exercises the prompt exactly as one from August does. This is the same rule CLAUDE.md
 * already states for `buildVocabulary`, which must learn from every stored caption: a
 * measurement gets better with more ground truth, and shrinking the set to match a
 * product-scope rule makes the number worse for no gain.
 *
 * The cutoff belongs to the pipeline. A held-out test may use every label there is.
 */
export async function readLabelledSet(opts: { includeBulk?: boolean } = {}): Promise<LabelledSet> {

  const [disclosureRows, humanRows, knownPaid] = await Promise.all([
    /**
     * ── THE DISCLOSURE SOURCE, READ FROM THE CAPTION ON EVERY CHANNEL ─────────────────
     *
     * This used to be `verdictSource: 'rules'` scoped to the `mom` detector — which made
     * the disclosure source a property of ONE channel's configuration rather than of what
     * publishers actually wrote. MEASURED across all 2,830 stored posts:
     *
     *   @viralbhayani   **2 posts carry `#Ad`** (both Vivo), out of 1,005
     *   @madovermarketing_mom  22 of 86, and one of them is `#Ad` rather than `#Collaboration`
     *
     * CLAUDE.md states flatly that @viralbhayani *"Never"* discloses and that
     * `#ad`/`#sponsored`/`#collaboration` was `0/48`. That was true of the 48 posts measured;
     * it is not true of the 1,005 now stored. Two labels is not many — and they are the only
     * FACT-grade ground truth that has ever existed for the channel supplying most of the
     * paid posts this system finds, so reaching them matters more than their count suggests.
     */
    prisma.detectedCampaign.findMany({
      select: {
        shortcode: true,
        caption: true,
        target: { select: { handle: true, detectorKey: true } },
      },
    }),
    prisma.detectedCampaign.findMany({
      where: { humanLabel: { not: null } },
      select: {
        shortcode: true,
        humanLabel: true,
        labelledAt: true,
        target: { select: { handle: true } },
      },
    }),
    prisma.knownPaidPost.findMany({ select: { shortcode: true } }),
  ])

  /**
   * ── AND THE ASYMMETRY THAT DECIDES WHETHER THIS MEASURES ANYTHING ────────────────────
   *
   * A disclosure hashtag present is a label on ANY channel: the publisher said so.
   *
   * A disclosure hashtag ABSENT is a label on almost no channel. It means "not paid" only
   * where the publisher discloses reliably, and the only evidence we have of that is a
   * hand-written detector asserting the convention — which is exactly what `detectorKey:
   * 'mom'` is. MEASURED there: 22 of 86 posts carry one, and CLAUDE.md records that 0
   * ORGANIC posts do, so the rule is sound on that corpus.
   *
   * On @viralbhayani absence means nothing at all, because the channel does not disclose.
   * Treating it as a negative label would mint **1,003 fake ORGANIC labels** against 2 real
   * positives, and the harness would then report something like 99% accuracy for a channel
   * it has barely measured. That is this codebase's most-repeated failure — *absence of
   * data hardening into a negative verdict* — arriving in the one place whose entire job is
   * to tell the truth about the numbers.
   *
   * So: positives from everywhere, negatives only from a channel that discloses reliably.
   */
  const disclosure: LabelRow[] = disclosureRows.flatMap((p) => {
    const disclosed = DISCLOSURE_PATTERN.test(p.caption)
    const reliable = p.target.detectorKey === 'mom'
    if (!disclosed && !reliable) return []
    return [
      {
        shortcode: p.shortcode,
        channel: p.target.handle,
        paid: disclosed,
        source: LABEL_SOURCES.DISCLOSURE,
        at: null,
      },
    ]
  })

  const human: LabelRow[] = humanRows.map((p) => ({
    shortcode: p.shortcode,
    channel: p.target.handle,
    paid: p.humanLabel === true,
    source: LABEL_SOURCES.HUMAN,
    at: p.labelledAt,
  }))

  const split = findBulkWrites(human)
  const humanKept = opts.includeBulk ? human : split.individual

  /**
   * `KnownPaidPost` contributes only where the post is actually stored. A shortcode with no
   * caption in the corpus cannot be shown to the classifier, so it is not a label that can
   * be scored — it is a label WAITING for a backfill, and the difference is reported.
   */
  const wanted = knownPaid.map((k) => k.shortcode)
  const present = wanted.length
    ? await prisma.detectedCampaign.findMany({
        where: { shortcode: { in: wanted } },
        select: { shortcode: true, target: { select: { handle: true } } },
      })
    : []
  const presentBy = new Map(present.map((p) => [p.shortcode, p.target.handle]))
  const known: LabelRow[] = present.map((p) => ({
    shortcode: p.shortcode,
    channel: p.target.handle,
    paid: true, // the list is "posts I know were paid"; it asserts nothing about the rest
    source: LABEL_SOURCES.KNOWN_PAID,
    at: null,
  }))

  /**
   * A post can carry more than one label. The order below is the authority order this
   * system already uses: a person's answer outranks everything, then Tabish's own list,
   * then the publisher's disclosure. First one wins, and nothing is averaged — two sources
   * disagreeing is a fact worth keeping, not a number to split the difference on.
   */
  const seen = new Set<string>()
  const rows: LabelRow[] = []
  for (const r of [...humanKept, ...known, ...disclosure]) {
    if (seen.has(r.shortcode)) continue
    seen.add(r.shortcode)
    rows.push(r)
  }

  return {
    rows,
    excludedBulk: opts.includeBulk ? [] : split.bulk,
    bulkGroups: split.groups,
    knownPaidNotInCorpus: wanted.filter((s) => !presentBy.has(s)),
  }
}
