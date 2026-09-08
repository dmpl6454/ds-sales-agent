import { anonGateCheck, anonGateRecordSuccess, anonGateRecordThrottle, isThrottleResponse } from './anonGate'
import { log } from '@/lib/logger'
import { FEED_HEADERS, IG_HOST, REQUEST_TIMEOUT_MS } from './feed'
import { igGet } from './igHttp'

/**
 * What can we still learn about a handle whose category Instagram will not serve?
 *
 * THIS FILE DELIBERATELY DOES NOT CLASSIFY. It gathers facts for a human.
 *
 * Meta deleted the schema behind `ig_business_category_subvertical`, so
 * `users/web_profile_info` returns HTTP 400 for accounts that HAVE a business category —
 * precisely the accounts most likely to be brands. @tilara.india, @netflix_in and
 * @tseries.official are all unreachable that way. See resolveBrand.ts.
 *
 * WHY THERE IS NO AUTOMATIC FALLBACK, MEASURED 2026-08-03
 *
 * Three anonymous surfaces were tested against handles whose truth we know:
 *
 *   public profile HTML      200, an identical ~605KB React shell for EVERY handle.
 *                            No category, no og: tags, no business flags. (CLAUDE.md
 *                            already records that og:description scraping is dead.)
 *   ?__a=1&__d=dis           201, empty.
 *   feed/user/<h>/username/  200 — it REACHES accounts web_profile_info cannot serve.
 *
 * So the feed endpoint is the only surface that answers. But the only field that
 * separates a buyer from talent is `category_name`, and it exists on exactly one
 * endpoint — the broken one. The feed payload carries `account_type` and `is_verified`,
 * and measured across three handles:
 *
 *   @tilara.india     account_type=2  is_verified=true   <- a brand
 *   @netflix_in       account_type=2  is_verified=true   <- a brand
 *   @adityathackeray  account_type=2  is_verified=true   <- a POLITICIAN
 *
 * Identical. Classifying on `account_type` would file every verified actor and
 * politician in a film-promotion caption as a media buyer — the @bharat_reshma mistake
 * again, automated and at scale. A confident wrong answer is worse than a visible gap:
 * the gap gets looked at, the wrong answer gets messaged.
 *
 * What this DOES establish is genuinely useful and was previously unavailable: the
 * account is live and professional, so an UNRESOLVED row is "Meta's bug is hiding a real
 * account" rather than "this handle is dead". That plus the caption it appeared in makes
 * it a one-look decision for an operator instead of a guess by us.
 */

export interface HandleEnrichment {
  handle: string
  /** Did we reach the account at all? false = dead handle, or the endpoint refused. */
  reachable: boolean
  /**
   * Instagram's `account_type`. 1 = personal, 2 = business/creator, 3 = creator.
   * Recorded, NEVER used to decide brand-vs-person — see the header. A politician and a
   * brand both return 2.
   */
  accountType: number | null
  isVerified: boolean | null
  followers: number | null
  /** Profile display name, for the operator to recognise the company by. */
  fullName: string | null
  /** Why we could not reach it, when `reachable` is false. */
  reason: string | null
  /**
   * The HTTP status when the endpoint ANSWERED and refused (404 for a dead handle, 429 for
   * a throttle); null when the request never completed (timeout, reset) or succeeded.
   * Carried so a caller can tell "this handle does not exist" from "the network failed" —
   * the badge door was retrying dead handles at the front of every pass because both wore
   * the same `reachable: false`.
   */
  status: number | null
}

/**
 * Ask the FEED endpoint what it knows. Anonymous — no cookie, ever.
 *
 * Reuses `FEED_HEADERS` from `feed.ts` rather than redeclaring them: this is the same
 * endpoint detection already calls four times a day, and CLAUDE.md decision 4 is that
 * detection never attaches a session. One header set, one place to keep that true.
 */
export async function enrichHandle(handle: string): Promise<HandleEnrichment> {
  const h = handle.replace(/^@/, '').toLowerCase()
  const empty: HandleEnrichment = {
    handle: h,
    reachable: false,
    accountType: null,
    isVerified: null,
    followers: null,
    fullName: null,
    reason: null,
    status: null,
  }

  try {
    /**
     * BOUNDED. `fetch` has no default timeout, and an unbounded one here is what hung the
     * agent's brand pass for 70+ minutes on 2026-08-22 when the Mac's network dropped:
     * `brandPassRunning` stayed true, so brand discovery and the badge door were skipped
     * every 30 minutes until the socket happened to error. Same constant as the feed and
     * `exists.ts` — see REQUEST_TIMEOUT_MS's docblock for the measured cost of not having
     * it. A timeout surfaces as a thrown AbortError and lands in the catch below, which
     * already reports "not reachable", and NOT-REACHABLE IS NEVER A VERDICT here.
     */
    const gate = anonGateCheck('profile')
    if (!gate.ok) {
      // No request. Reported as a 429 so every caller's "back off" branch fires (see anonGate.ts).
      return { ...empty, reason: `HTTP 429 (anonymous reads throttled until ${gate.until.toISOString()})`, status: 429 }
    }
    const res = await igGet(`${IG_HOST}/api/v1/feed/user/${encodeURIComponent(h)}/username/`, {
      headers: FEED_HEADERS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })

    if (!res.ok) {
      // Not reachable is not the same as not a brand. It stays UNRESOLVED either way.
      // The status travels so the CALLER can tell a dead handle (404) from a throttle —
      // this function still never converts either into a verdict.
      const text = await res.text().catch(() => '')
      if (isThrottleResponse(res.status, text)) anonGateRecordThrottle('profile', res.status)
      return { ...empty, reason: `HTTP ${res.status}`, status: res.status }
    }
    anonGateRecordSuccess('profile')

    const body = (await res.json()) as {
      items?: Array<{ user?: Record<string, unknown> }>
      user?: Record<string, unknown>
    }
    /**
     * ── THE PAYLOAD CAN HAND BACK SOMEBODY ELSE'S IDENTITY ────────────────────────
     *
     * This used to read `body.items?.[0]?.user ?? body.user`. `items[0].user` is the owner
     * of the NEWEST POST in the feed, and on a co-authored post that is the COLLABORATOR,
     * not the account we asked about.
     *
     * MEASURED LIVE 2026-08-23, this endpoint, these handles:
     *
     *   asked @yamigautam   → items[0].user = @amazonmgmstudiosin "Amazon MGM Studios India"
     *   asked @akshaykumar  → items[0].user = @jiohotstar         "JioHotstar"
     *
     * and in BOTH cases `body.user` was correct ("Yami Gautam Dhar", "Akshay Kumar").
     *
     * That is not cosmetic. `is_verified` was being read off the collaborator too, so a
     * paid post's celebrity could be admitted on a STUDIO's badge — the VERIFIED ONLY rule
     * satisfied by the wrong account. It also stamped the studio's name onto the person's
     * row: 26 display names were shared between prospects, "Netflix India" across three
     * actors, and that name reaches message copy.
     *
     * So the identity is now CHECKED rather than assumed, `body.user` (the feed's own user
     * object) is preferred, and a payload that describes somebody else is NOT REACHABLE —
     * never a verdict, per this file's standing rule. "Existence is not identity" applied
     * one layer in: it is not enough that a user object came back.
     */
    const asked = h.toLowerCase()
    const isWhoWeAsked = (u?: Record<string, unknown>): boolean =>
      !!u && typeof u.username === 'string' && u.username.toLowerCase() === asked

    const fromItem = body.items?.[0]?.user
    const user = isWhoWeAsked(body.user) ? body.user : isWhoWeAsked(fromItem) ? fromItem : undefined
    if (!user) {
      const sawSomeone = body.user ?? fromItem
      if (!sawSomeone) return { ...empty, reason: 'no user object in payload' }
      const who = typeof sawSomeone.username === 'string' ? sawSomeone.username : 'unknown'
      return { ...empty, reason: `payload described @${who}, not @${h}` }
    }

    return {
      handle: h,
      reachable: true,
      accountType: typeof user.account_type === 'number' ? user.account_type : null,
      isVerified: typeof user.is_verified === 'boolean' ? user.is_verified : null,
      followers:
        typeof user.follower_count === 'number'
          ? user.follower_count
          : ((user.edge_followed_by as { count?: number } | undefined)?.count ?? null),
      fullName: typeof user.full_name === 'string' && user.full_name.trim() !== '' ? user.full_name.trim() : null,
      reason: null,
      status: null,
    }
  } catch (err) {
    log.step('handle enrichment failed', { handle: h, error: err instanceof Error ? err.message : String(err) })
    return { ...empty, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * A one-line, human-readable summary for the dashboard.
 *
 * Says what we know and — importantly — does not imply a verdict. "Professional account"
 * is a fact; "brand" would be a guess. The operator reads this, opens the profile, and
 * decides.
 */
export function describeEnrichment(e: HandleEnrichment): string {
  if (!e.reachable) return e.reason ? `could not read (${e.reason})` : 'could not read'

  const bits: string[] = []
  if (e.followers !== null) bits.push(`${formatFollowers(e.followers)} followers`)
  if (e.accountType === 2 || e.accountType === 3) bits.push('professional account')
  else if (e.accountType === 1) bits.push('personal account')
  if (e.isVerified) bits.push('verified')

  return bits.length > 0 ? bits.join(' · ') : 'live, but nothing else readable'
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
