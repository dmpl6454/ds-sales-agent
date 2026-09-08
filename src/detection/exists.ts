import { anonGateCheck, anonGateRecordSuccess, anonGateRecordThrottle, isThrottleResponse } from './anonGate'
import { FEED_HEADERS, IG_HOST } from './feed'
import { assertSafeHandle } from '@/lib/urls'

/**
 * Does this Instagram handle exist? Asked before adding a channel, an account, or an
 * imported prospect.
 *
 * Anonymous, like all detection — no session, no credentials (decision 4). A typo'd handle
 * otherwise fails much later and much more confusingly: for a channel it silently yields
 * zero posts forever, and for a sending account it fails halfway through a browser login
 * when the profile turns out to be logged in as someone the database has never heard of.
 *
 * ── THIS CHECK COULD NOT FAIL, AND NOBODY HAD NOTICED ─────────────────────
 *
 * It used to fetch `instagram.com/<handle>/` and read the HTTP status:
 *
 *     if (res.status === 200) return 'exists'
 *     if (res.status === 404) return 'missing'
 *
 * **Instagram's web profile page returns HTTP 200 for a handle that does not exist.** It
 * serves the single-page-app shell and renders "Sorry, this page isn't available" in the
 * browser afterwards. MEASURED 2026-08-05: `@instagram` and `@qqqq_nope_nope_12345` both
 * returned 200, with response bodies 609,393 and 609,403 bytes — ten bytes apart, both the
 * same shell.
 *
 * So `'missing'` was unreachable and this function answered `'exists'` for every handle
 * anyone could type. `addTarget` has always shown "@x does not exist on Instagram" from a
 * branch no input could reach, and every guard built on it was decoration.
 *
 * That is this codebase's signature failure, and it is the SAME TRAP already recorded in
 * CLAUDE.md for `/api/v1/accounts/current_user/`: a www path answering 200 with the SPA
 * shell instead of the JSON its caller assumed. Found by running it, not by reading it —
 * the code looked obviously correct.
 *
 * ── WHAT ACTUALLY ANSWERS ─────────────────────────────────────────────────
 *
 * `web_profile_info`, the same endpoint `resolveBrand` uses. MEASURED, both directions:
 *
 *     madovermarketing_mom     400  {"message":"Asset asset://laser.provider/...deleted"}
 *     qqqq_nope_nope_12345     404  (html)
 *     zz_no_such_acct_918273   404  (html)
 *
 * The 400 is Meta's own broken business-category sub-vertical — documented at length in
 * `resolveBrand.ts`, where it is known to fail on precisely the accounts most likely to be
 * brands. It means the account EXISTS and Instagram cannot serialise its category, so it
 * must never be read as absence. That distinction is the whole reason this file cannot
 * just check for a 404 and call everything else missing.
 *
 * `unknown` stays a real and distinct answer. A network failure, a timeout or a throttle
 * must not be reported as "that account does not exist" — the caller decides whether to
 * proceed on doubt, and absence of data must never harden into a negative verdict.
 */
export type HandleCheck = 'exists' | 'missing' | 'unknown'

// ONE anonymous identity for every Instagram read — see the docblock on FEED_HEADERS (8 Sept 2026).
const ENDPOINT = `${IG_HOST}/api/v1/users/web_profile_info/?username=`
const HEADERS = FEED_HEADERS

/**
 * Meta's deleted-schema error. The account is there; its category cannot be serialised.
 *
 * Matched on the message rather than on the 400 alone, because a 400 for any OTHER reason
 * is genuinely something we do not understand, and answering `exists` to it would be
 * guessing in the permissive direction.
 */
const SCHEMA_BUG = 'has been deleted. You cannot use this schema'

/** PURE. Given a status and body, does this handle exist? Testable without the network. */
export function interpretExistence(status: number, body: string): HandleCheck {
  if (status === 200) return 'exists'
  if (status === 404) return 'missing'
  if (status === 400 && body.includes(SCHEMA_BUG)) return 'exists'
  // 429/401/403, an unrecognised 400, anything else: we did not get an answer.
  return 'unknown'
}

/**
 * What Instagram itself says the account IS — the facts the 200 body already carries and
 * `handleExists` used to throw away.
 *
 * ── WHY THIS EXISTS (2026-08-20) ──────────────────────────────────────────
 *
 * Tabish asked to watch "filmigyan". That handle EXISTS — a 219-follower fan page reading
 * "4K FOLLOWERS ON MAIN PAGE" — while the page he meant is @filmygyan, 31.6M, verified. A
 * yes/no existence check passes both identically, so the add would have succeeded and the
 * corpus would have quietly filled with a fan page's posts, whose CAMPAIGN verdicts mint
 * real prospects that get real DMs. Existence is not identity, measured once more.
 *
 * The fix is not a guard that refuses (a small unverified page can be a legitimate watch
 * choice) — it is putting the identity ON THE SCREEN at the moment of the add, so a wrong
 * account is visible to the person who just typed it, not discovered in the corpus weeks
 * later. The facts were in the response all along; this stops discarding them.
 */
export interface HandleFacts {
  name: string | null
  verified: boolean | null
  followers: number | null
}

/** PURE. Pull the identity facts out of a web_profile_info 200 body. Never throws. */
export function parseHandleFacts(body: string): HandleFacts | null {
  try {
    const u = JSON.parse(body)?.data?.user
    if (!u) return null
    return {
      name: typeof u.full_name === 'string' && u.full_name.trim() ? u.full_name.trim() : null,
      verified: typeof u.is_verified === 'boolean' ? u.is_verified : null,
      followers: typeof u.edge_followed_by?.count === 'number' ? u.edge_followed_by.count : null,
    }
  } catch {
    return null
  }
}

/**
 * One fetch, both answers: does the handle exist, and who does Instagram say it is.
 * Facts are BEST-EFFORT — `null` on the schema-bug 400 (the account exists, its payload
 * cannot be serialised) and on anything unreadable. A null fact renders as an honest
 * "could not read who this is", never as a verdict.
 */
export async function probeHandle(
  handle: string,
): Promise<{ check: HandleCheck; facts: HandleFacts | null }> {
  try {
    // A handle with a slash or a query character would otherwise be interpolated straight
    // into the URL. Rejecting it as unknown rather than throwing keeps a bulk import going.
    assertSafeHandle(handle)
  } catch {
    return { check: 'unknown', facts: null }
  }

  // A throttled host must answer "unknown", never "missing" — absence of data is not a verdict.
  if (!anonGateCheck().ok) return { check: 'unknown', facts: null }
  try {
    const res = await fetch(`${ENDPOINT}${encodeURIComponent(handle)}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    })
    /**
     * A 200 body carries the identity facts; a 400 might carry the schema error. Anything
     * else is not worth downloading to answer a yes/no question.
     */
    const body = res.status === 200 || res.status === 400 ? await res.text().catch(() => '') : ''
    if (isThrottleResponse(res.status, body)) {
      anonGateRecordThrottle('exists', res.status)
      return { check: 'unknown', facts: null }
    }
    if (res.status === 200) anonGateRecordSuccess('exists')
    const check = interpretExistence(res.status, body)
    return { check, facts: res.status === 200 ? parseHandleFacts(body) : null }
  } catch {
    return { check: 'unknown', facts: null }
  }
}

export async function handleExists(handle: string): Promise<HandleCheck> {
  return (await probeHandle(handle)).check
}
