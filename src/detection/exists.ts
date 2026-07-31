import { profileUrl } from '@/lib/urls'

/**
 * Does this Instagram handle exist? Asked before adding a channel or an account.
 *
 * Anonymous, like all detection — no session, no credentials (decision 4). A typo'd
 * handle otherwise fails much later and much more confusingly: for a channel it
 * silently yields zero posts forever, and for a sending account it fails halfway
 * through a browser login when the profile turns out to be logged in as someone the
 * database has never heard of.
 *
 * `unknown` is a real and distinct answer. A network failure or an Instagram rate
 * limit must not be reported as "that account does not exist" — the caller decides
 * whether to proceed on doubt, and for adding a channel the right answer is to warn
 * and allow rather than block on our own connectivity.
 */
export type HandleCheck = 'exists' | 'missing' | 'unknown'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
}

export async function handleExists(handle: string): Promise<HandleCheck> {
  try {
    const res = await fetch(profileUrl(handle), {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    })
    if (res.status === 200) return 'exists'
    if (res.status === 404) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
