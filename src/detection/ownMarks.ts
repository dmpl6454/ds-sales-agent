/**
 * A PUBLISHER'S OWN MARKS ARE NOT EVIDENCE THAT SOMEBODY PAID THEM.
 *
 * ── THE MEASUREMENT (2026-08-21) ──────────────────────────────────────────
 *
 * Tabish: *"the detection mechanism has beautifully failed for filmigyan's posts … this was
 * their anniversary celebration."* He was right, and the database names the mechanism
 * exactly. Post `DcRTPMDTTjX`:
 *
 *     caption verdict   ORGANIC — "Publisher's own anniversary, not a paid promotion."
 *     signals           frame:escalated-to-campaign, frame:says-campaign
 *     frame text        "AglamorouscelebrationasFilmygyan | marks10amazingyearsintheindustry!
 *                        — in shot: FILMYGYAN"
 *     stored verdict    CAMPAIGN
 *
 * **The caption classifier got it right and the FOOTAGE overruled it on the publisher's own
 * watermark.** @filmygyan burns "FILMYGYAN" into every video, so OCR reports the channel's
 * own logo on every post and the frame stage reads it as a brand in shot. Every channel
 * watermarks its videos, so this is systematic rather than incidental: @filmygyan produced
 * **42 CAMPAIGN verdicts since 20 August against @viralbhayani's 25**, on a channel whose
 * genuine paid rate is a fraction of that.
 *
 * The control case proves the stage itself is sound and must not be weakened. Post
 * `DcRB5e1Cy_M`, same channel, same escalation path: the frame reads
 * `acerpure | BaDolby | 120Hz | FILMYGYAN`, and **that escalation is CORRECT** — a real
 * acerpure television placement the caption missed, which is precisely what reading the
 * footage was built for. So the answer is not to distrust the frame. It is to stop handing
 * the publisher its own name as evidence about itself.
 *
 * This is the same rule `brandCandidatesFor` already applies to handles — our own pages and
 * watched publishers are excluded BEFORE the lookup budget — arriving one modality late.
 *
 * ── AND THE SECOND HALF: INTERNAL SERIES CODES ARE NOT BRANDS ─────────────
 *
 * *"filmigyan uses #fg6 or any other as its own internal metric, there is no brand by that
 * name, similarly other organizations use the same trick with #bs2."* MEASURED across
 * CAMPAIGN posts since 20 August: **fg6 ×15, fg2 ×10, fg14 ×4, fg15 ×4, fg18 ×2, fg11 ×2,
 * FG18, FG17** — all stored as brand names, all meaningless. They reach the dashboard as
 * companies and they reach `{{brand}}`-shaped copy as names.
 *
 * The test is deliberately NOT "short token with digits" alone, because real brands look like
 * that (Zee5, 5Star, Fastrack). It is *the publisher's own initials followed by a number* —
 * `fg6` on @filmygyan, `bs2` on @bollywoodsocietyy — which is the pattern Tabish described
 * and which cannot be a third party by construction.
 */

/** Fold to comparable letters: lower case, strip everything that is not a-z0-9. */
export function normaliseMark(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Initialisms a channel plausibly uses for itself: the whole handle, and the first letter of
 * each word in the display name (`Filmy Gyan` → `fg`, `Bollywood Society` → `bs`).
 *
 * The handle itself is also split on its separators, so `manav.manglani` yields `mm`.
 */
export function selfInitialisms(handle: string, displayName: string | null): string[] {
  const out = new Set<string>()
  const words = (displayName ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length > 1) out.add(words.map((w) => w[0]!.toLowerCase()).join(''))
  const handleWords = handle.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (handleWords.length > 1) out.add(handleWords.map((w) => w[0]!.toLowerCase()).join(''))
  /**
   * A single run-together handle carries no separators, so derive the initialism from the
   * DISPLAY name's capitals where there are any (`FilmyGyan` → `fg`); otherwise there is
   * nothing to derive and the set stays empty rather than guessing.
   */
  const caps = (displayName ?? '').match(/[A-Z]/g)
  if (caps && caps.length > 1) out.add(caps.join('').toLowerCase())
  return [...out].filter((s) => s.length >= 2 && s.length <= 5)
}

/**
 * PURE. Is this token one of the publisher's own marks — its handle, its display name, or an
 * internal series code built from its initials?
 *
 * Conservative by design: it refuses a token only when it can point at WHICH of the
 * publisher's own names it matches. A brand this returns false for is simply judged as
 * before, so the failure direction is "we kept a token we could have dropped", never "we
 * dropped a real advertiser".
 */
export function isOwnMark(token: string, publisher: { handle: string; displayName: string | null }): boolean {
  const t = normaliseMark(token)
  if (t.length === 0) return false

  const handle = normaliseMark(publisher.handle)
  const name = normaliseMark(publisher.displayName ?? '')

  /* The publisher itself, however it was spelled or spaced ("F I L M Y G Y A N"). */
  if (t === handle || (name.length >= 3 && t === name)) return true

  /**
   * A watermark often carries the handle with an affix (`filmygyanofficial`, `thefilmygyan`).
   *
   * BOUNDED BY LENGTH, and that bound is the whole safety of this branch. OCR runs words
   * together, so an unbounded `includes` would drop a fragment like
   * `FilmygyanXAcerpure` — taking the real advertiser out with the watermark. A token more
   * than `AFFIX_SLACK` longer than the handle is prose or a collaboration, not a logo, and
   * prose about the publisher is something the classifier should read and judge (its caption
   * reason for the anniversary post was already "Publisher's own anniversary").
   */
  const AFFIX_SLACK = 8
  if (handle.length >= 6 && t.includes(handle) && t.length <= handle.length + AFFIX_SLACK) return true
  if (name.length >= 6 && t.includes(name) && t.length <= name.length + AFFIX_SLACK) return true

  /**
   * An internal series code: the publisher's initials immediately followed by a number, with
   * nothing else. `fg6`, `fg18`, `bs2`. The number is what makes it a code rather than a
   * word, and the initials are what make it THIS publisher's code rather than a brand.
   */
  const code = t.match(/^([a-z]{2,5})(\d{1,3})$/)
  if (code) {
    const stem = code[1]!
    if (selfInitialisms(publisher.handle, publisher.displayName).includes(stem)) return true
    /**
     * `fg` is not a PREFIX of `filmygyan` — it is an acronym of it. So the stem's letters
     * must appear in the handle IN ORDER, and its FIRST letter must be the handle's first
     * letter. That pairing is what keeps it tight: `fg6`→filmygyan and `bs2`→bollywoodsocietyy
     * match, while `ig11` does not (i ≠ f) and `zee5` does not (no z). Without the
     * first-letter anchor a two-letter subsequence would match almost any handle.
     */
    if (stem[0] === handle[0] && isSubsequence(stem, handle)) return true
  }

  return false
}

/** Are all of `needle`'s characters present in `hay`, in order? PURE. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i += 1
  return i === needle.length
}

/**
 * Strip the publisher's own marks out of OCR'd frame text before it becomes evidence.
 *
 * Splits on the separators `frameTextSummaryLine` builds with (`|`) and on commas, keeps
 * every fragment that is not purely the publisher's own mark, and returns `null` when
 * NOTHING survives — because "the only thing we could read was their own logo" is the same
 * fact as "we read no brand evidence", and it must not arrive at the classifier looking like
 * a finding.
 */
export function stripOwnMarksFromFrame(
  frameText: string | null,
  publisher: { handle: string; displayName: string | null },
): string | null {
  if (!frameText) return frameText
  /**
   * Split on BOTH separators `frameTextSummaryLine` uses: `|` between items and `—` between
   * the two size groups. Splitting on `|` alone put the second group's LABEL in the same
   * fragment as the previous group's last item, so dropping a watermark took a real title
   * card with it — caught by driving the verbatim frame of the post that started this.
   */
  const parts = frameText.split(/[|—]/)
  const kept = parts.filter((part) => {
    const body = part.includes(':') ? part.slice(part.indexOf(':') + 1) : part
    const words = body.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean)
    if (words.length === 0) return false
    /* Drop the fragment only when EVERY word in it is one of the publisher's own marks. */
    return !words.every((w) => isOwnMark(w, publisher))
  })
  const out = kept.join('|').trim()
  /* A line that is only its labels carries no evidence. */
  const hasContent = out.replace(/on screen:|in shot:/g, '').replace(/[|\s]/g, '').length > 0
  return hasContent ? out : null
}

/** Drop the publisher's own marks from an extracted brand list. PURE. */
export function stripOwnMarksFromBrands(
  brands: readonly string[],
  publisher: { handle: string; displayName: string | null },
): string[] {
  return brands.filter((b) => !isOwnMark(b, publisher))
}

/**
 * IS THIS TOKEN THE NAME OF A CHANNEL WE WATCH?
 *
 * `isOwnMark` answers that for the PUBLISHER of the post, and only in one direction — a token
 * that CONTAINS the handle (`thefilmygyan`, `filmygyanofficial`). MEASURED on `DcyE65LPYMj`:
 * the brand string `"Social Samosa"` squashes to `socialsamosa` while the handle is
 * `officialsocialsamosa`, so the containment runs the OTHER way, the publisher's own name
 * survived its own post, and it was spoken to a recipient as their placement.
 *
 * So this adds the REVERSE containment, bounded by the same slack: a token the handle or the
 * display name CONTAINS, within `AFFIX_SLACK` characters, is that channel's own name wearing or
 * missing an affix (`official`, `the`, `real`). It is bounded for the reason the forward branch
 * is — an unbounded reverse containment would let a short token match almost any channel, and
 * dropping a real advertiser is the expensive direction here.
 */
export function isChannelMark(
  token: string,
  channel: { handle: string; displayName: string | null },
): boolean {
  if (isOwnMark(token, channel)) return true

  const t = normaliseMark(token)
  /* Six is the same floor the forward affix branch uses: below it a token is too small to
     identify a channel, and matching one would strip a real short brand name. */
  if (t.length < 6) return false

  const AFFIX_SLACK = 8
  for (const raw of [channel.handle, channel.displayName ?? '']) {
    const c = normaliseMark(raw)
    if (c.length >= 6 && c.includes(t) && c.length <= t.length + AFFIX_SLACK) return true
  }
  return false
}

/**
 * EVERY CHANNEL WE WATCH IS A COMPETITOR — not only the one that published this post.
 *
 * `stripOwnMarksFromBrands` removes the PUBLISHER's marks, which is right for a display column
 * and not enough for a message: a round-up published by one watched page can name ANOTHER
 * watched page, and a brand string is all it takes to become a subject. That is how
 * *"your Social Samosa placement"* reached five companies on 2 September.
 *
 * The list passed here is every WATCH row, so a competitor's name can never become somebody's
 * placement whichever of them posted it. Tabish's rule is about the pages we monitor and it is
 * absolute: *"Never mention our competitors in this way never mention their names."*
 */
export function stripChannelMarksFromBrands(
  brands: readonly string[],
  channels: readonly { handle: string; displayName: string | null }[],
): string[] {
  return brands.filter((b) => !channels.some((c) => isChannelMark(b, c)))
}
