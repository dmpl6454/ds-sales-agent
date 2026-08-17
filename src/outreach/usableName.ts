/**
 * IS THIS DISPLAY NAME SAFE TO PUT IN PROSE? PURE.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `BrandFirstTouchInput.brandName` is documented *"The brand's own name, as it should
 * appear in prose. Never a handle."* Nothing enforced it, and `brandTarget.ts` writes the
 * HANDLE into `displayName` whenever Instagram returns no full name. MEASURED by reading
 * the real stored bodies on 2026-08-13:
 *
 *     Hi agoracitycentre team,
 *     I saw agoracitycentre's placement with Viral Bhayani last week — nicely done.
 *     ...
 *     For agoracitycentre that would mean the same audience you just reached...
 *
 * THREE times in one message, not twice as the audit first recorded. A contract stated in
 * a comment with nothing checking it is not a contract.
 *
 * ── WHY THE OBVIOUS RULE IS WRONG, AND THIS ONE IS NARROW ─────────────────
 *
 * The tempting test is "does the display name normalise to the handle" — strip case and
 * punctuation and compare. MEASURED against the live 68 BRAND rows, that matches **47 of
 * them**, and most are perfectly good names: `Amazon MGM Studios` → `amazonmgmstudios`,
 * `Crocs India` → `crocsindia`, `KALKI Fashion` → `kalkifashion`, `Royal Canin India` →
 * `royalcanin.india`. Refusing those would degrade 47 pitches to the generic opening to fix
 * 21, which is a worse message for more prospects — the plan's own warning about refusing
 * "the handle prettified" cuts both ways.
 *
 * What actually makes a string read as a handle is the absence of human typography. A
 * person writing a company name puts a space in it, or a capital, or both. `agoracitycentre`
 * and `netflix_in` and `lego.mybrickhouse` have neither; `Amazon MGM Studios` has both.
 *
 * So the rule is: refuse only when the name normalises to the handle AND carries no
 * whitespace AND is entirely lower case. `TIPS` (handle `tips`) survives, which is right —
 * that is a real brand name a person typed in caps.
 *
 * ── WHICH DIRECTION IT FAILS IN ───────────────────────────────────────────
 *
 * Toward refusing. A refused name costs one pitch its specific opening and falls back to a
 * path that already exists and is tested; an accepted handle puts scraped-looking output in
 * front of a company that reads pitches for a living. Those are not comparable, so the tie
 * goes to refusal.
 */

/** Lower case, letters and digits only — so `Royal Canin India` and `royalcanin.india` meet. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The name to use in prose, or `null` when the stored one is really the handle.
 *
 * Callers must treat `null` as "name nothing" rather than substituting the handle
 * themselves — `brandFirstTouch` and `buildGreeting` both have a degraded path for it.
 */
export function usableBrandName(displayName: string | null | undefined, handle: string): string | null {
  const name = (displayName ?? '').trim()
  if (name === '') return null

  // Byte-identical to the handle. Checked separately so the rule stays total even if a
  // handle ever arrives with capitals in it.
  if (name === handle) return null

  const looksTyped = /\s/.test(name) || name !== name.toLowerCase()
  if (!looksTyped && normalise(name) === normalise(handle)) return null

  return name
}
