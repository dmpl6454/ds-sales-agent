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

import { usableBrandName } from './usableName'

/** Everything the first touch needs to know. Assembled by the caller from the DB. */
export interface BrandFirstTouchInput {
  /**
   * The brand's own name, as it should appear in prose — and NEVER a handle.
   *
   * That sentence used to be the whole enforcement, and it failed: `brandTarget.ts` writes
   * the handle into `displayName` when Instagram returns no full name, so real drafts read
   * *"I saw agoracitycentre's placement…"*. The rule is now `usableBrandName`, asked HERE
   * rather than trusted from the caller — see the note in `brandFirstTouch`.
   */
  brandName: string
  /**
   * The recipient's handle, so this function can check the name against it itself.
   *
   * Required, not optional. An optional parameter is how a guard comes to be skipped at the
   * one call site nobody updated; making it required means the compiler names every caller.
   */
  handle: string
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

/** Every phrase `describeRecency` can emit. The order is longest-first so matching is greedy. */
const RECENCY_BANDS = ['a couple of months ago', 'this week', 'last week', 'recently'] as const

/**
 * WHICH RECENCY BAND DOES THIS ALREADY-WRITTEN BODY ASSERT? PURE.
 *
 * Read out of the rendered text rather than recomputed from the campaign, because the
 * stored body is the single source of truth downstream: the composer read-back compares
 * against exactly it, and an operator may have edited it by hand. What matters is what the
 * recipient will READ, not what we would write today.
 *
 * Anchored on the placement sentence — `…placement with <publisher> <band> — nicely done.`
 * — and not on the bare phrase, because "recently" is an ordinary English word that a
 * hand-edited body could use anywhere. Returns null when the body makes no dated claim,
 * which is the common case: the degraded opening names no placement at all.
 */
export function assertedRecency(body: string): string | null {
  const claim = /placement with .{1,60}?(?: (a couple of months ago|this week|last week|recently))? — nicely done/i.exec(
    body,
  )
  if (claim === null) return null
  const band = claim[1]?.toLowerCase() ?? null
  return band !== null && (RECENCY_BANDS as readonly string[]).includes(band) ? band : null
}

/**
 * HAS THE CLAIM IN THIS BODY DECAYED SINCE IT WAS WRITTEN? PURE.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * A body is rendered once, at draft time, and frozen. `describeRecency` bands `days <= 10`
 * as "last week". MEASURED 2026-08-13: the Amazon draft was written on 11 August about a
 * campaign 9 days old — correct then — and has not moved since. It now says "last week"
 * about a placement 11 days old, and it is still sitting in the queue. Every day Autopilot
 * stays off, every waiting draft's claim gets further from true.
 *
 * ── WHY IT REFUSES RATHER THAN RE-RENDERING ───────────────────────────────
 *
 * Silently re-rendering would change the bytes the send guards compare against — the
 * composer read-back and `bodyAppearedSince` both check the STORED body — and it would
 * overwrite an edit an operator made by hand. Same reasoning, and the same answer, as
 * `PERSONA_CHANGED_SINCE_DRAFT` beside it in `gate.ts`.
 *
 * A body that makes no dated claim can never be stale, which keeps the common path free.
 */
export function hookRecencyStale(input: { body: string; postedAt: Date | null; now: Date }): boolean {
  const asserted = assertedRecency(input.body)
  if (asserted === null) return false
  return describeRecency(input.postedAt, input.now) !== asserted
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
  const { publisherName, postedAt, now } = input
  const when = describeRecency(postedAt, now)

  /**
   * ASKED HERE, NOT TRUSTED FROM THE CALLER.
   *
   * The plan for this fix said to "assert it at the boundary rather than trusting the
   * caller: `brandPitch` should not be able to render a handle even if one is passed", and
   * that is exactly right for the reason this codebase keeps rediscovering — a rule enforced
   * at the call site is a rule that holds until somebody adds a second call site. There is
   * one today (`compose.ts`) and `pnpm ig:generate` is a plausible second.
   *
   * `null` means we have no name we are willing to put in prose, and the pitch then names
   * nobody rather than naming a handle.
   */
  const brandName = usableBrandName(input.brandName, input.handle)

  /**
   * A placement claim needs BOTH halves — the publisher we saw it on, and a name to put in
   * front of it. Without a usable name the sentence would have to become "I saw your
   * placement with Viral Bhayani", which is a claim about the recipient's marketing made
   * without being able to name them; the degraded opening is the honest alternative and it
   * already exists.
   */
  const canClaimPlacement = publisherName !== null && brandName !== null

  const opening = canClaimPlacement
    ? `I saw ${brandName}'s placement with ${publisherName}${when ? ` ${when}` : ''} — nicely done.`
    : // No verifiable claim available. State the general observation and move to the
      // proposition. Never fabricate a placement.
      `You are investing in placement on entertainment publishers, so I will be direct about why we may be worth a conversation.`

  const bridge = canClaimPlacement
    ? `Since you are already buying reach on entertainment publishers, this may be useful: we own that inventory rather than broker it.\n\n`
    : ``

  /**
   * "For <name>" becomes "For you" rather than dropping the sentence. The line carries the
   * whole proposition, and a message that skips it to avoid saying a name reads as truncated.
   */
  const forWhom = brandName === null ? 'For you' : `For ${brandName}`

  /**
   * "the same audience you just reached" is only true when a placement was named. Without
   * one it asserts something about the recipient we have not said we observed.
   */
  const audience = canClaimPlacement ? 'the same audience you just reached' : 'that audience'

  return `${opening}

${bridge}Digital Sukoon operates 200+ pages across Instagram, Facebook, YouTube and Snapchat — 169.2M followers combined, and over 30 crore (300M) views a day. Because the audience is ours, a brand buying directly pays media-buying rates rather than per-post influencer fees.

${forWhom} that would mean ${audience}, at a better rate, on a calendar you control.

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
