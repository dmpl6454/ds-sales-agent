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

const ENDPOINT = 'https://www.instagram.com/api/v1/users/web_profile_info/?username='

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  // The gate. Without it this endpoint answers with a login wall rather than JSON.
  'x-ig-app-id': '936619743392459',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.instagram.com/',
}

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

export async function handleExists(handle: string): Promise<HandleCheck> {
  try {
    // A handle with a slash or a query character would otherwise be interpolated straight
    // into the URL. Rejecting it as unknown rather than throwing keeps a bulk import going.
    assertSafeHandle(handle)
  } catch {
    return 'unknown'
  }

  try {
    const res = await fetch(`${ENDPOINT}${encodeURIComponent(handle)}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    })
    /**
     * The body is only read when it might carry the schema error, so the happy path does
     * not download a profile payload to answer a yes/no question.
     */
    const body = res.status === 400 ? await res.text().catch(() => '') : ''
    return interpretExistence(res.status, body)
  } catch {
    return 'unknown'
  }
}
