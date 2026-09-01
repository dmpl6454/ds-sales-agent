/**
 * HOW MANY MESSAGES HAS THIS RECIPIENT ACTUALLY EARNED?
 *
 * ── TABISH'S RULE, 2026-08-21 ─────────────────────────────────────────────
 *
 * *"If only a single paid post is detected for say a paid post done by sony (which refers
 * brand 'a') then we send a message to the brand only once unless we detect another paid post
 * made that same day or by another channel (we monitor) and only then."*
 *
 * ── WHAT WAS HAPPENING, MEASURED ──────────────────────────────────────────
 *
 * **133 recipients had heard from more than one of our pages, many from all five.**
 * @indiagatefoods received five messages from five different pages inside twelve hours, off
 * ONE detected paid post. That is the ring rule (2026-08-19) working exactly as specified —
 * "all five pages may reach one recipient within minutes of each other, then that recipient
 * rests seven days" is recorded in CLAUDE.md as his own call — and it is what he is now
 * asking to replace.
 *
 * ── THE MECHANISM WAS A SCOPE, NOT A MISSING RULE ─────────────────────────
 *
 * `NO_NEW_MATERIAL` already says a message needs something new to say. It was defeated twice
 * over, both times by being scoped to the PAIR rather than the RECIPIENT:
 *
 *   1. `unusedCampaignCount` counts campaigns not yet used *by this sender*, so the same
 *      single paid post is "unused" for all five senders at once.
 *   2. The check only runs when `touchesSoFar > 0`, and each sender's own pair has zero
 *      touches — so every one of the five is exempt as a first touch.
 *
 * So the fix is not another spacing rule stacked on top. It is to ask the question about the
 * PERSON receiving the messages, which is who the rule was always about.
 *
 * ── THE ALLOWANCE ─────────────────────────────────────────────────────────
 *
 * Inside the window, a recipient may receive at most as many messages as there are distinct
 * paid posts we detected naming them — **and never fewer than one**, because a prospect can
 * arrive without a campaign at all (a hand import, or `discoverOfficialPages` resolving an
 * untagged post) and must still be reachable once. Every additional paid post earns exactly
 * one more message, whether it came the same day or from a different watched channel, which is
 * his sentence turned into arithmetic.
 *
 * This REPLACES the fan-out, it does not add to it: the ring rule, the reply halt, the pair
 * daily cap and the verified-only bar all still apply on top, and each is stricter in a
 * different direction.
 */

export type MaterialVerdict =
  | { held: false; allowance: number; delivered: number }
  | { held: true; allowance: number; delivered: number; campaigns: number }

/**
 * PURE. May another of our pages write to this recipient, given what we have seen them buy?
 *
 * Both counts are over the SAME window, deliberately: comparing all-time deliveries against
 * recent campaigns would retire a recipient permanently the first time a campaign aged out,
 * and comparing recent deliveries against all-time campaigns would let one old paid post fund
 * a message every week forever. One window, both sides.
 */
export function materialAllowance(input: {
  /** Distinct paid posts naming this recipient inside the window. */
  campaignsInWindow: number
  /** Messages DELIVERED to this recipient by any of our pages inside the window. */
  deliveredInWindow: number
}): MaterialVerdict {
  const { campaignsInWindow, deliveredInWindow } = input
  /**
   * `max(1, …)`, and the 1 is load-bearing rather than defensive. A prospect with no campaign
   * — imported by hand, or discovered from a post that named nobody — would otherwise be
   * unreachable forever, which is absence of data hardening into a permanent refusal: this
   * codebase's most repeated defect, and it would present as "the queue never drains".
   */
  const allowance = Math.max(1, campaignsInWindow)
  if (deliveredInWindow >= allowance) {
    return { held: true, allowance, delivered: deliveredInWindow, campaigns: campaignsInWindow }
  }
  return { held: false, allowance, delivered: deliveredInWindow }
}

/**
 * The sentence a refusal shows — one writer, shared by the governor, the gate and the screen,
 * so a page can never describe this hold by a different rule than the one enforcing it.
 */
export function materialAllowanceDetail(v: MaterialVerdict): string | null {
  if (!v.held) return null
  const posts =
    v.campaigns === 0
      ? 'no paid post of theirs has been detected'
      : v.campaigns === 1
        ? 'one paid post of theirs has been detected'
        : `${v.campaigns} paid posts of theirs have been detected`
  const sent = v.delivered === 1 ? 'one of our pages has already written' : `${v.delivered} of our pages have already written`
  return `${posts} and ${sent} — the next message waits for the next paid post from them, on any channel we watch`
}

/**
 * ── HOW MANY PAID POSTS NAME THIS RECIPIENT? The unlock half of Tabish's rule ──
 *
 * *"…unless we detect another paid post made that same day or by another channel (we
 * monitor) and only then."*
 *
 * The first version counted `DetectedCampaign.targetId === recipient` — and `targetId` is
 * the CHANNEL that posted, so for a PROSPECT that count is zero forever. MEASURED the
 * evening it went live: the allowance clamped every recipient to max(1, 0) = 1, 133 of 139
 * verified prospects were at allowance, the planner logged `skipped=851 queued=0`, and the
 * fleet went quiet — the unlock could never fire, which silently strengthened his rule into
 * "one message per recipient, ever (per window)". His own report was the detector: *"the
 * queue also doesn't seem to move forward"*.
 *
 * What links a campaign to a prospect is the same evidence that MINTED the prospect:
 * handles Instagram itself asserts on the post — caption @mentions and media tags. Brand
 * STRINGS are deliberately not consulted ("fg6" was one); handles are asserted facts.
 *
 * ── PORTABLE BY CONSTRUCTION, EXACT IN JS ─────────────────────────────────
 *
 * The first draft used `caption ~* …`, which is Postgres-only — and `pnpm test` drives the
 * gate against SQLite, the two-provider trap this repo has already paid for. So the DATABASE
 * does a cheap `contains` prefilter (portable on both providers) and the BOUNDARY test runs
 * in JS, where it is exact and testable:
 *
 *   - a tag matches only as the QUOTED array element, so "zee5" never credits a post that
 *     tagged @zee5_marathi;
 *   - a caption mention must be @handle followed by a non-handle character or the end, so
 *     @zee5 never credits @zee5_marathi either. Dots in handles are regex-escaped
 *     (@manav.manglani must not wildcard).
 */
export function mentionsHandleExactly(row: { caption: string; taggedAccounts: string }, handle: string): boolean {
  try {
    const tags: unknown = JSON.parse(row.taggedAccounts || '[]')
    if (Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === handle.toLowerCase())) {
      return true
    }
  } catch {
    /* unreadable tags decide nothing — the caption test below still runs */
  }
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}($|[^a-z0-9_.])`, 'i').test(row.caption)
}

/**
 * ── AND A BRAND STRING THAT IS THE PROSPECT'S OWN NAME COUNTS TOO (2026-08-21) ──
 *
 * Tabish, on the "We message" column: *"the llm discovers what is mentioned in the caption
 * (say #sony but no tag to insta) and OCR and then messages targets accordingly."*
 * MEASURED that night: **45 in-window paid posts named an existing VERIFIED prospect in
 * their `brands` strings without tagging them** — "Amazon MGM Studios", "JioHotstar",
 * "Excel Entertainment" — and none of those posts unlocked a message, because brand
 * strings were excluded from this linkage wholesale.
 *
 * The original exclusion was about MINTING: `fg6` was stored as a brand name, so strings
 * must not create prospects. That reasoning stands and is untouched — this arm only
 * CREDITS a prospect that already exists and already passed the verified badge, and only
 * on EXACT name equality (squashed: case and separators removed, minimum four
 * characters). `fg6` can never equal a verified prospect's name; prose can never
 * substring-match its way in.
 */
/**
 * ── AN OFFICIAL PAGE IS THE BRAND'S NAME PLUS A REGION, AND EXACT EQUALITY MISSED THAT ──
 *
 * Tabish, 2026-08-23, reading the "We message" column on a @naughtyworld paid post whose
 * caption named *Prime Video*: *"the column only shows fukra insaan ... traitors is also a
 * target, its a prime tv show among other things."*
 *
 * MEASURED: `@primevideoin` is ALREADY a verified PROSPECT. The post named "Prime Video".
 * Squashed that is `primevideo`, the prospect's handle is `primevideoin`, and exact equality
 * says no — so a paid post naming a company we had already approved unlocked nothing, and
 * the column stayed silent about a lead we owned. The same miss covers `@kfcindia` for
 * "KFC", `@nutellaindia` for "Nutella", `@adidasindia` for "Adidas".
 *
 * The widening is a CLOSED ALLOWLIST of the suffixes an official page appends to its own
 * brand name, applied to BOTH sides, and never a prefix or substring test — prefix matching
 * is what would let `fg6`-class junk and single generic words back in, which is the whole
 * reason this arm was exact in the first place.
 *
 * THE @philips TRAP STILL HOLDS, and it is the fixture that proves the direction is safe:
 * brand "Philips India" against prospect `@philips`/"Philips" does NOT match, because
 * stripping a suffix from the prospect side leaves `philips`, which is not `philipsindia`.
 * The reverse — brand "Philips" crediting the verified prospect `@philipsindia` — DOES
 * match, and that is correct: Philips India is the account that ran the campaign.
 *
 * This arm still only ever CREDITS a prospect that already exists and already passed the
 * verified badge. Minting stays string-free.
 */
/**
 * ONLY THE PROSPECT'S NAME IS EVER STRIPPED. THE CAPTION'S IS NOT, AND THAT IS THE SAFETY.
 *
 * An official page appends a region to the brand's own name — `@primevideoin`,
 * `@netflix_in`, `@kfcindia`, `@tseries.official` — so stripping the PROSPECT side lets a
 * caption saying "Prime Video" credit `@primevideoin`. Stripping the CAPTION side would do
 * the opposite and is forbidden, for two reasons both found by driving it:
 *
 *   1. THE @philips TRAP, a permanent fixture here. "Philips India" stripped to `philips`
 *      would credit the GLOBAL page `@philips` for the INDIA campaign — the exact wrong-
 *      account match `isOfficialMatch` was built to refuse. Its test failed on the first
 *      run of this rule and is why the brand side is now never touched.
 *   2. THE ENGLISH PREPOSITION. "Vanshika Dhir in" squashes to `vanshikadhirin`; stripping
 *      `in` stems it to `vanshikadhir` and credits the ACTRESS for 20 posts that merely
 *      used her name in a sentence. @aanandlrai gained 20 the same way and @yamigautam 17
 *      — every one a person, inside a run whose headline (+170 credits) read as a success.
 *
 * So the test is: does the caption's brand string equal the prospect's name, or the
 * prospect's name with one regional suffix removed. Nothing else.
 */
const HANDLE_SUFFIXES = ['india', 'official', 'ind', 'in'] as const

/** Squash, then strip ONE trailing suffix from the given list if a real stem survives. */
function stemWith(squashed: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    if (squashed.length > suffix.length && squashed.endsWith(suffix)) {
      const stem = squashed.slice(0, -suffix.length)
      // A stem shorter than this is not a brand name, it is the wreckage of one —
      // "berlin" minus "in" is "berl", and that must never match a four-letter brand.
      if (stem.length >= 5) return stem
    }
  }
  return squashed
}

export function brandStringsNameProspect(
  brandsJson: string,
  prospect: { handle: string; displayName?: string | null },
): boolean {
  let arr: unknown
  try {
    arr = JSON.parse(brandsJson || '[]')
  } catch {
    return false
  }
  if (!Array.isArray(arr)) return false
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const names = [prospect.displayName ?? '', prospect.handle].map(squash).filter((n) => n.length >= 4)
  if (names.length === 0) return false
  const stems = new Set(names.map((n) => stemWith(n, HANDLE_SUFFIXES)))
  return arr.some((b) => {
    if (typeof b !== 'string') return false
    const squashed = squash(b)
    if (squashed.length < 4) return false
    if (names.includes(squashed)) return true
    return stems.has(squashed)
  })
}

/**
 * ── THE ROWS, so every rule that asks "which paid posts name this recipient?" asks ONE
 *    implementation (2026-08-22) ─────────────────────────────────────────────
 *
 * `campaignsNamingHandle` returns the COUNT for the allowance. `NO_NEW_MATERIAL` needs the
 * IDS — which campaigns this pair has not written about yet — and `pickHook` needs the
 * freshest of them. Both used to ask `DetectedCampaign.targetId`, i.e. **campaigns posted BY
 * the recipient**, which for a prospect is zero forever: exactly the defect found in this
 * file's own count on 2026-08-21, surviving one rule over. See `unusedCampaignCount`.
 */
export interface NamingCampaign {
  id: string
  postedAt: Date
  /**
   * `DetectedCampaign.targetId` — the CHANNEL THAT POSTED, never the recipient. The one
   * column in this file whose name lies about what it holds, which is why it is renamed
   * here and why that mistake has its own docblock in `compose.ts`.
   *
   * Carried since 2026-09-01 because the FOLLOW-UP message names the post it is written
   * about ("your placement with @viralbhayani on 30 Aug"), so the planner must be able to
   * render the exact body it is deciding about — the same discipline it already keeps for
   * `fleetTemplate`. It is the SCALAR id and not a joined handle on purpose: a relation
   * select here would cost an extra round trip on every page that preloads these rows, and
   * `/` runs at 156 against a ceiling of 160.
   */
  channelId: string
}

export async function campaignsNamingHandleRows(
  /* Structurally typed so tests can hand in a stub; `any`-shaped findMany because Prisma's
     own generic signature does not narrow through a structural constraint. */
  prismaClient: {
    detectedCampaign: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: (args: any) => Promise<
        Array<{ id?: string; postedAt?: Date; targetId?: string; caption: string; taggedAccounts: string; brands: string }>
      >
    }
  },
  prospect: { handle: string; displayName?: string | null },
  windowFloor: Date,
): Promise<NamingCampaign[]> {
  const handle = prospect.handle
  const candidates = await prismaClient.detectedCampaign.findMany({
    where: {
      verdict: 'CAMPAIGN',
      postedAt: { gte: windowFloor },
      /* The brands arm cannot be prefiltered portably (SQLite `contains` is
         case-insensitive, Postgres is not — the two-provider trap), so rows with any
         brand strings come back and the EXACT test runs in JS, where it is one rule on
         both providers. Bounded by the window either way. */
      OR: [
        { taggedAccounts: { contains: `"${handle}"` } },
        { caption: { contains: `@${handle}` } },
        { brands: { not: '[]' } },
      ],
    },
    select: { id: true, postedAt: true, targetId: true, caption: true, taggedAccounts: true, brands: true },
  })
  return candidates
    .filter((c) => mentionsHandleExactly(c, handle) || brandStringsNameProspect(c.brands, prospect))
    .map((c) => ({ id: c.id ?? '', postedAt: c.postedAt ?? new Date(0), channelId: c.targetId ?? '' }))
}

export async function campaignsNamingHandle(
  prismaClient: Parameters<typeof campaignsNamingHandleRows>[0],
  prospect: { handle: string; displayName?: string | null },
  windowFloor: Date,
): Promise<number> {
  return (await campaignsNamingHandleRows(prismaClient, prospect, windowFloor)).length
}
