/**
 * From a brand NAME (caption prose or OCR frame text) to an OFFICIAL Instagram page —
 * the one path this project measured unsafe, made safe by demanding IDENTITY.
 *
 * ── THE MEASUREMENT THIS MUST NEVER FORGET ─────────────────────────────────
 *
 * Constructing a handle from a name was wrong 4 times in 10, and 3 of the 4 wrong
 * handles EXIST — `@philips` is the global HQ with a verified badge; `@philipsindia`
 * ran the campaign. Existence is not identity, and a verified badge on the WRONG
 * account passes every existence check. So the bar here is identity-grade
 * (Tabish, 2026-08-19: "find verified channel or channel that is truly big and
 * legitimate"):
 *
 *   auto-accept = verified badge AND the profile's name covers every token of the
 *                 brand name
 *               | ≥ officialMinFollowers AND business account AND the profile's name
 *                 is EXACTLY the brand name (same tokens, nothing more)
 *   anything else → printed for a human, or nobody. NEVER a fuzzy accept.
 *
 * The subset direction matters: brand name "Philips India" is NOT covered by profile
 * name "Philips", so the global HQ cannot pass for the Indian advertiser. The reverse
 * (profile "Royal Canin India" for brand name "Royal Canin") passes on the badge arm —
 * the badge is Instagram asserting identity, and a national subsidiary is the right
 * inbox for its own market's placement.
 */

export function candidateHandlesFor(brandName: string): string[] {
  const flat = brandName.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return []
  const joined = flat.replace(/ /g, '')
  const dotted = flat.replace(/ /g, '.')
  const scored = flat.replace(/ /g, '_')
  const out = new Set([joined, dotted, scored])
  for (const base of [joined, dotted]) {
    out.add(`${base}.india`)
    out.add(`${base}india`)
    out.add(`${base}.official`)
    out.add(`${base}official`)
  }
  out.add(`${joined}_india`)
  out.add(`${joined}_official`)
  // Instagram handles: 1-30 chars; anything shorter than 3 is noise from OCR fragments.
  return [...out].filter((h) => h.length >= 3 && h.length <= 30)
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  )

/** The candidate profile's name covers EVERY token of the brand name (subset, not overlap). */
export function nameMatches(brandName: string, profileFullName: string | null): boolean {
  if (profileFullName === null) return false
  const want = tokens(brandName)
  if (want.size === 0) return false
  const have = tokens(profileFullName)
  if ([...want].every((t) => have.has(t))) return true
  /**
   * THE SAME NAME WITH AND WITHOUT A SPACE (2026-09-02). "Jio Star" tokenises to {jio, star}
   * and the verified page is named "JioStar" — one token — so the subset test refused the
   * correct, verified advertiser (measured live). Accept EQUALITY of the squashed strings
   * only: never containment, or "Star" would pass for JioStar and "Tips" for anything
   * beginning with it. The @philips trap holds: "philipsindia" !== "philips".
   */
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const sb = squash(brandName)
  return sb.length >= 3 && sb === squash(profileFullName)
}

/**
 * ── VERIFIED ONLY SINCE 2026-08-20 (Tabish) ────────────────────────────────
 *
 * *"we discover valid verified instagram accounts and add them as target and message
 * them."* The size arm is DELETED, not disabled: it required a follower count the feed
 * endpoint never returns, so it could only ever fire for the handles `BrandLookup` happened
 * to hold — a rule that reads like a second route in and was not one.
 *
 * So the whole bar is now: **Instagram says this account is verified, AND its name covers
 * every token of the brand name.** The badge is the only identity assertion here that is
 * not ours to make, and the name test is what stops a verified badge on the WRONG account
 * passing — the measured @philips / "Philips India" trap, still a fixture below.
 */
export function isOfficialMatch(input: {
  brandName: string
  fullName: string | null
  isVerified: boolean | null
}): boolean {
  return input.isVerified === true && nameMatches(input.brandName, input.fullName)
}

/**
 * ── WE ALREADY OWN THIS BRAND'S PAGE, SO THIS ONE IS A SECOND ACCOUNT ──────
 *
 * MEASURED 2026-08-25, from Tabish's screenshot of a media-buying pitch sitting in
 * @tips_india's inbox — the **Tripura Institute of Paramedical Sciences**, 2,863 followers,
 * verified. We already held `@tips`: "TIPS", **1,147,014 followers, category Publishers**,
 * a prospect since 12 August, messaged five times — the real music label, and the account
 * the post's own caption linked (*"Full song out now on @Tips Official Youtube channel"*).
 *
 * `isOfficialMatch` passed the college on both of its questions and could not have done
 * otherwise:
 *
 *   candidateHandlesFor("Tips")  →  tips, tips.india, tipsindia, tips.official,
 *                                   tipsofficial, tips_india, tips_official
 *   nameMatches("Tips", "TIPS")  →  want {tips} ⊆ have {tips}  →  TRUE
 *   verified badge               →  TRUE
 *
 * **The @philips trap only bites when the brand name has MORE tokens than the profile
 * name.** "Philips India" is not covered by "Philips", which is why that fixture works. A
 * ONE-TOKEN brand name makes the subset test vacuous: every verified account whose name is
 * that word passes, and the badge alone decides — which is precisely the "existence is not
 * identity" failure the badge was never able to answer on its own.
 *
 * Rather than weaken the name test (which would cost real regional pages like
 * @primevideoin), this asks the question the old rule never did: **do we already have a
 * live prospect by this name?** If we do, this candidate is a DIFFERENT account wearing the
 * same name, and a second account for one brand is a duplicate lead at best and a stranger's
 * inbox at worst. It is REPORTED for a person (`--accept` is still the deliberate door),
 * never silently dropped — the same discipline as every other near-miss in this file.
 *
 * Sized before shipping: exactly ONE pair of live prospects shares a display name today
 * (tips / tips_india), so this refuses one thing and it is the wrong one.
 */
export function duplicatesExistingProspect(
  profileFullName: string | null,
  candidateHandle: string,
  existing: readonly { handle: string; displayName: string | null }[],
): string | null {
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  const name = squash(profileFullName ?? '')
  /* Below three characters a "name" is OCR wreckage, and matching on it would refuse
     legitimate pages for sharing two letters. */
  if (name.length < 3) return null
  const candidate = candidateHandle.toLowerCase()
  for (const t of existing) {
    if (t.handle.toLowerCase() === candidate) continue
    if (squash(t.displayName ?? '') === name) return t.handle
  }
  return null
}
