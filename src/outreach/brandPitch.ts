/**
 * The FIRST message to a brand, built from the campaign we actually saw.
 *
 * This is the strongest asset brand outreach has, and it is the reason
 * `TargetAccount.discoveredFromCampaignId` exists: we watched this specific company pay
 * this specific publisher for a specific placement, on a date. *"I saw your recent piece
 * with Mad Over Marketing"* is not a merge field — it is a verifiable fact about one
 * recipient, which is exactly what decision 3 asks for and what a spintax template can
 * never be.
 *
 * Tabish initially chose a generic category-level opening ("you're clearly investing in
 * influencer placement") and switched to this one after seeing the two side by side. Worth
 * recording why the generic version was the weaker choice: that paragraph is identical for
 * every brand, so it is a template with no variation aimed at people who read pitches for
 * a living — and Meta's written spam policy penalises repetition specifically. The
 * specific version costs one extra database read.
 *
 * PURE, and deliberately so. Every rule here is testable without a database, a clock or a
 * network call, like `governor.ts` and `gate.ts`. The two brand-classification bugs found
 * on 2026-08-03 shipped precisely because that logic sat inside an `await fetch()`.
 */

/** Everything the first touch needs to know. Assembled by the caller from the DB. */
export interface BrandFirstTouchInput {
  /** The brand's own name, as it should appear in prose. Never a handle. */
  brandName: string
  /**
   * The publisher whose post surfaced this brand, in prose — "Mad Over Marketing", not
   * "@madovermarketing_mom". A handle in the body reads like scraped output.
   */
  publisherName: string | null
  /** When that post went up. Used only for "last week" / "recently" phrasing. */
  postedAt: Date | null
  /** Now, injected so the phrasing is testable. */
  now: Date
}

const MS_PER_DAY = 86_400_000

/**
 * "last week" / "recently" / "earlier this year" — vague on purpose.
 *
 * A precise date ("your post of 29 July") reads like surveillance rather than attention,
 * and it is also the sort of claim that is embarrassing when the timestamp is wrong. The
 * bands are wide enough to be true even if `postedAt` is off by a day.
 */
export function describeRecency(postedAt: Date | null, now: Date): string | null {
  if (!postedAt) return null
  const days = Math.floor((now.getTime() - postedAt.getTime()) / MS_PER_DAY)
  // A future timestamp means bad data. Say nothing rather than something false.
  if (days < 0) return null
  if (days <= 2) return 'this week'
  if (days <= 10) return 'last week'
  if (days <= 45) return 'recently'
  if (days <= 120) return 'a couple of months ago'
  // Older than that, the recency is not a selling point and naming it invites "that was
  // ages ago". Reference the placement without dating it.
  return null
}

/**
 * The body of the first message to a brand — the MIDDLE only.
 *
 * `renderMessage()` supplies the greeting, the "I'm <name>, <title>." line, the closing
 * line and the signature block, so none of those appear here. It also means this body
 * passes through the same composer read-back guard as every other message, with no
 * special-casing at the send site.
 *
 * Degrades honestly. With no publisher name there is nothing verifiable to claim, so the
 * opening drops to the category observation rather than inventing a placement — an
 * invented hook is worse than none, which is why `buildHookLine` returns null rather than
 * guessing.
 */
export function brandFirstTouch(input: BrandFirstTouchInput): string {
  const { brandName, publisherName, postedAt, now } = input
  const when = describeRecency(postedAt, now)

  const opening =
    publisherName === null
      ? // No publisher: no specific claim is available. State the general observation and
        // move to the proposition. Never fabricate a placement.
        `You are investing in placement on entertainment publishers, so I will be direct about why we may be worth a conversation.`
      : `I saw ${brandName}'s placement with ${publisherName}${when ? ` ${when}` : ''} — nicely done.`

  const bridge =
    publisherName === null
      ? ``
      : `Since you are already buying reach on entertainment publishers, this may be useful: we own that inventory rather than broker it.\n\n`

  return `${opening}

${bridge}Digital Sukoon operates 200+ pages across Instagram, Facebook, YouTube and Snapchat — 169.2M followers combined, and over 30 crore (300M) views a day. Because the audience is ours, a brand buying directly pays media-buying rates rather than per-post influencer fees.

For ${brandName} that would mean the same audience you just reached, at a better rate, on a calendar you control.

Could I send a short plan with indicative numbers?`
}

/**
 * "@madovermarketing_mom" -> "Mad Over Marketing".
 *
 * A publisher handle must never appear raw in a message body: it reads like scraped data
 * and tells the recipient they are one row in a list. Known publishers are mapped by hand
 * because their real names are editorial facts, not something to derive from a handle —
 * "madovermarketing_mom" would otherwise become "Madovermarketing Mom".
 *
 * An unknown handle returns null, and `brandFirstTouch` then omits the claim entirely
 * rather than printing a mangled name. Add channels here as they are watched.
 */
const PUBLISHER_NAMES: Record<string, string> = {
  madovermarketing_mom: 'Mad Over Marketing',
  viralbhayani: 'Viral Bhayani',
}

export function publisherDisplayName(handle: string | null | undefined): string | null {
  if (!handle) return null
  return PUBLISHER_NAMES[handle.replace(/^@/, '').toLowerCase()] ?? null
}
