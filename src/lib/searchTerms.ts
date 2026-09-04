/**
 * ONE SEARCH TERM → THE STRINGS A `contains` FILTER MUST TRY, and why there are several.
 *
 * ── WHY THIS IS A MODULE AND NOT A LINE IN A VIEW MODEL (2026-09-04) ────────
 *
 * The fan-out below lived inline in `buildPaidPostsView` since 2026-08-25. On 2026-09-04
 * two more screens needed exactly the same behaviour — `/analytics`'s recipient filter and
 * `/targets`' search box, both from Tabish's ask that a person be able to find *who was
 * messaged for what* — and a rule with three hand-copied callers is how `gate.ts`,
 * `readThread.ts` and the Connect buttons each drifted here. So it is one function, PURE,
 * with the paid-posts search as its first caller and its behaviour unchanged byte for byte.
 *
 * ── WHY NOT `mode: 'insensitive'` ───────────────────────────────────────────
 *
 * Prisma's case-insensitive `contains` is POSTGRES-ONLY — on the SQLite client the argument
 * does not exist and the call throws. That is the `skipDuplicates` trap verbatim, and it is
 * invisible to `pnpm typecheck`, which runs against the Postgres schema while the suite runs
 * against SQLite. Rather than depend on which provider generated the client, the term is
 * matched in the casings a person actually types. Portable by construction; the cost is a
 * longer `OR`, evaluated once, over queries that are already bounded.
 *
 * ── WHAT THE FAN-OUT COVERS, MEASURED 2026-08-26 ────────────────────────────
 *
 * Tabish searched `arshad warsi` and got 2 rows while 3 paid posts named him:
 *
 *  1. **A SPACE is not an UNDERSCORE.** `contains` is a literal `LIKE`, and nothing
 *     normalised separators — so `arshad warsi` could never match `arshad_warsi` or
 *     `@arshad_warsi`, which is how every handle in this corpus is spelled. Hence the
 *     separator variants: `_`, `.`, and squashed.
 *  2. The casing fan-out generated lower and Title case but never ALL CAPS, and
 *     `captionEntities`' own work records that trade captions routinely open in caps.
 *
 * SEPARATOR VARIANTS RATHER THAN A STORED SEARCH COLUMN. The honest long-term answer is a
 * lower-cased, separator-squashed column written at storage time and matched once. That is
 * a schema change plus a backfill of thousands of rows, and this is a search box: the
 * variants are a handful more `contains` terms, and they are portable across both
 * providers, which `mode: 'insensitive'` is not.
 */

/** Below this a term matches too much of the corpus to mean anything; the box ignores it. */
export const MIN_SEARCH_LENGTH = 2

/**
 * A URL parameter is a string anyone can type. It is trimmed, bounded, and turned into
 * `null` when it is too short to be a search — never an error page, never a filter that
 * matches everything. The cap is generous for a name and small for a `LIKE`.
 */
export function normaliseSearch(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().slice(0, 80)
  return q.length >= MIN_SEARCH_LENGTH ? q : null
}

/** The same words with the separators a handle uses: "arshad warsi" → "arshad_warsi", "arshadwarsi". */
function separatorVariants(t: string): string[] {
  /* The SPACED form stays in the list (2026-09-04). The 26 Aug fan-out replaced it with the
     handle spellings, so "arshad warsi" matched `@arshad_warsi` and never a caption that wrote
     the name with a space — found by the first test written for this module. */
  return /\s/.test(t) ? [t, t.replace(/\s+/g, '_'), t.replace(/\s+/g, '.'), t.replace(/\s+/g, '')] : [t]
}

/**
 * The casings a person actually types: as typed, lower, UPPER, Title. De-duplicated, so a
 * term already in lower case does not cost two identical clauses.
 */
export function casings(query: string): string[] {
  return [
    ...new Set([
      query,
      query.toLowerCase(),
      query.toUpperCase(),
      query.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
    ]),
  ]
}

/**
 * Every string a `contains` filter should try for one typed term: each casing, and each
 * casing with the separators a handle would use. This is the paid-posts search's original
 * fan-out, moved here unchanged.
 */
export function searchTerms(query: string): string[] {
  return [...new Set(casings(query).flatMap(separatorVariants))]
}

/**
 * The Prisma `OR` clauses that match a TargetAccount by what a person calls it.
 *
 * `handle` gets every variant including the separator forms (handles are spelled with `_`
 * and `.`, never spaces); `displayName` gets the casings only — a display name is prose,
 * and a squashed "celinajaitly" is not how anyone spells "Celina Jaitly", so those clauses
 * would only lengthen the `OR` for no match. Shared by the three screens that can find a
 * recipient, so "who matches this term" is one answer everywhere.
 */
export function targetNameClauses(
  query: string,
): ({ handle: { contains: string } } | { displayName: { contains: string } })[] {
  return [
    ...searchTerms(query).map((t) => ({ handle: { contains: t } })),
    ...casings(query).map((t) => ({ displayName: { contains: t } })),
  ]
}
