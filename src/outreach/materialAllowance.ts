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

export async function campaignsNamingHandle(
  /* Structurally typed so tests can hand in a stub; `any`-shaped findMany because Prisma's
     own generic signature does not narrow through a structural constraint. */
  prismaClient: {
    detectedCampaign: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: (args: any) => Promise<Array<{ caption: string; taggedAccounts: string }>>
    }
  },
  handle: string,
  windowFloor: Date,
): Promise<number> {
  const candidates = await prismaClient.detectedCampaign.findMany({
    where: {
      verdict: 'CAMPAIGN',
      postedAt: { gte: windowFloor },
      OR: [{ taggedAccounts: { contains: `"${handle}"` } }, { caption: { contains: `@${handle}` } }],
    },
    select: { caption: true, taggedAccounts: true },
  })
  return candidates.filter((c) => mentionsHandleExactly(c, handle)).length
}
