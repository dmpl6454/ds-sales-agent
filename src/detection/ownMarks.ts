import type { FrameText } from './ocr'

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
 *
 * This is the rule for CAPTION BRAND STRINGS. OCR'd footage uses `isOwnFrameMark`: OCR runs a
 * collaboration card into one word, and this function's affix slack and series-code
 * subsequence read `FILMYGYANxACER` or `VH1` as the publisher's own.
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
 * The words a channel wraps around its OWN name in a watermark (`thefilmygyan`,
 * `FILMYGYAN OFFICIAL`, `filmygyantv`). FIXED and SMALL on purpose: none of these is an
 * advertiser, so a token that is the handle plus only these can never be a placement. A
 * leftover outside this list — `xacer`, `presents`, `posetoh` — is something else sharing the
 * frame with the logo, and the frame keeps it.
 */
const FRAME_WATERMARK_AFFIXES: ReadonlySet<string> = new Set([
  'the',
  'official',
  'real',
  'india',
  'in',
  'tv',
  'media',
  'hq',
])

/**
 * PURE. Is this OCR'd word the publisher's own mark? The FRAME rule — deliberately narrower than
 * `isOwnMark`, which was written for CAPTION brand strings and stays as it is for them.
 *
 * ── WHY FOOTAGE CANNOT SHARE THE CAPTION RULE (review, 2026-10-09) ───────────────────
 *
 * OCR runs words together, so a collaboration card arrives as ONE word: `FILMYGYANxACER`,
 * `ViralBhayaniXNykaa`, `PINKVILLAxLAKME`. Every one is within `isOwnMark`'s 8-character affix
 * slack of the handle, so the caption rule read the card as the logo and DROPPED THE
 * ADVERTISER WITH IT. Its series-code arm (first letter + any in-order subsequence of the
 * handle) dropped real code-shaped brands the same way — `VH1` under @viralbhayani, `MG4` under
 * @madovermarketing_mom, `TCL55` under @trolls_official, `FLY91` under @filmygyan, `VO5` under
 * @voompla. When that was the frame's only text, `judge.ts` made no call and filed the post
 * `frame:only-own-marks`, which nothing retries: a genuine placement missed permanently, the
 * one error this project refuses to make.
 *
 * So a word is the publisher's own only when it can be POINTED AT:
 *
 *   - it IS the handle or the display name (normalised, so `@filmygyan`, `F I L M Y G Y A N`);
 *   - it is the handle or the display name with nothing around it but `FRAME_WATERMARK_AFFIXES`;
 *   - it is a series code whose stem is one of `selfInitialisms` — the publisher's DERIVABLE
 *     initials — and never the subsequence arm. That arm cannot be kept even as a fallback for
 *     a channel with no derivable initials: `FLY91` and `VO5` are exactly that case.
 *
 * The cost, stated: under @filmygyan's real display name (`F I L M Y G Y A N`) no initialism is
 * derivable, so a frame reading `fg6` is KEPT and sent. The fg codes were measured in CAPTIONS,
 * where `isOwnMark` still removes them; in footage a lone `fg6` costs one classifier call the
 * model has no reason to escalate, which is the cheap direction.
 */
export function isOwnFrameMark(token: string, publisher: { handle: string; displayName: string | null }): boolean {
  const t = normaliseMark(token)
  if (t.length === 0) return false

  const handle = normaliseMark(publisher.handle)
  const name = normaliseMark(publisher.displayName ?? '')

  if (t === handle || (name.length >= 3 && t === name)) return true

  /* Six is `isOwnMark`'s floor for the same reason: below it a core is too short to identify
     a channel inside a longer word. */
  const isAffix = (s: string) => s === '' || FRAME_WATERMARK_AFFIXES.has(s)
  for (const core of [handle, name]) {
    if (core.length < 6) continue
    const at = t.indexOf(core)
    if (at >= 0 && isAffix(t.slice(0, at)) && isAffix(t.slice(at + core.length))) return true
  }

  const code = t.match(/^([a-z]{2,5})(\d{1,3})$/)
  return code !== null && selfInitialisms(publisher.handle, publisher.displayName).includes(code[1]!)
}

/**
 * PURE. Strip the publisher's own marks out of OCR'd frame text before it becomes evidence —
 * on the STRUCTURED text, item by item, never on a rendered string.
 *
 * ── THE STRING VERSION WAS A NO-OP FOR TWO MONTHS (found 2026-10-09) ─────────────────
 *
 * Its predecessor, `stripOwnMarksFromFrame`, split a string on `|` and `—` and took the text
 * after the first `:` — the SUMMARY-LINE format (`on screen: … — in shot: …`), which is what
 * its tests fed it. `judge.ts` fed it the fenced PROMPT block instead, whose groups are
 * separated by newlines and whose last item shares a fragment with the `[END FRAME-TEXT-…]`
 * fence and the constant trailing sentence. Measured on the real format:
 *
 *   anniversary frame (trailing watermark)   unchanged — the logo reached the model
 *   a frame that is ONLY the watermark       unchanged — `frame:only-own-marks` unreachable
 *   watermark first in a later group         deleted the PREVIOUS group's last real item
 *   watermark first in the first group       deleted the `[BEGIN FRAME-TEXT-…]` fence itself,
 *                                            leaving an END with no BEGIN
 *
 * So the 21 August @filmygyan fix had never applied on any path, and on one shape it broke
 * the injection fence. Filtering the arrays OCR produced and rendering AFTER is the only form
 * that cannot touch a neighbour or a delimiter: there is no delimiter in an array.
 *
 * ── THE DROP RULE, AND WHY IT IS TWO TESTS ──────────────────────────────────────────
 *
 * OCR returns LINE-level items, so a two-word logo arrives as ONE item. An item is dropped iff
 *
 *   (a) the WHOLE item is an own mark — catching `VIRAL BHAYANI`, `FILMY GYAN`,
 *       `F I L M Y G Y A N`, `RVCJ MEDIA`, `FILMYGYAN OFFICIAL`, which a per-word test lets
 *       through because no single word is the name; or
 *   (b) EVERY word of it is an own mark (`FILMYGYAN`, `@filmygyan`).
 *
 * Both ask `isOwnFrameMark`, NEVER the caption `isOwnMark`. The caption rule's affix slack and
 * series-code subsequence drop `Filmygyan x Acer` run together (`FILMYGYANxACER`, which is how
 * OCR emits it), `FILMYGYAN PRESENTS`, `Pose toh FILMYGYAN`, `VH1`, `MG4` — the shape of a real
 * collaboration or a real product. Dropping a real advertiser is the expensive direction here;
 * keeping a logo we could have dropped is merely the status quo.
 *
 * `engine` and `dropped` are carried through: `dropped` counts observations that sanitised
 * away to nothing, which is a fact about the OCR, not about the publisher.
 */
export function stripOwnMarksFromFrameText(
  ft: FrameText,
  publisher: { handle: string; displayName: string | null },
): FrameText {
  const isOwnItem = (item: string): boolean => {
    if (isOwnFrameMark(item, publisher)) return true
    const words = item.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean)
    return words.length > 0 && words.every((w) => isOwnFrameMark(w, publisher))
  }
  const keep = (items: readonly string[]) => items.filter((item) => !isOwnItem(item))
  return {
    overlay: keep(ft.overlay),
    smaller: keep(ft.smaller),
    misread: keep(ft.misread),
    dropped: ft.dropped,
    engine: ft.engine,
  }
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

/**
 * THE COMPETITOR LIST, from rows a caller already holds.
 *
 * Exists so a VIEW MODEL never has to write `.displayName` itself. `tests/labels.test.ts`
 * refuses a raw `displayName` read in `src/app/view-model/**` because a stored one is often
 * just the handle and must never reach a screen — and that guard is right, and this read is
 * not that: a channel's name here is only ever an input to a FILTER, used to REMOVE things and
 * structurally unable to be output (`followUpSubject` returns only members of `brands`).
 *
 * Putting the mapping in the module that owns the concept keeps the guard at full strength
 * rather than adding a carve-out to it — a narrower fix than teaching the grep an exception.
 */
export function watchMarksFrom(
  rows: readonly { handle: string; displayName: string | null }[],
): { handle: string; displayName: string | null }[] {
  return rows.map((r) => ({ handle: r.handle, displayName: r.displayName }))
}
