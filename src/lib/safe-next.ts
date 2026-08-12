/**
 * Sanitises the `?next=` destination carried through sign-in.
 *
 * Lives here rather than in `auth-actions.ts` because that file is `'use server'`, where
 * every export must be an async server action — a synchronous helper exported from it
 * fails the build. Being a plain module also means it is directly unit-testable, which
 * for an open-redirect guard is the difference between "believed correct" and "checked".
 */

/**
 * `next` arrives from a query parameter, so it is attacker-controlled and must never be
 * used as given. Only a same-origin absolute PATH survives.
 *
 * The three rejections, and what each one stops:
 *
 *   no value              → `/`. Nothing to honour.
 *   does not start `/`    → `https://evil.com` is a valid redirect target. This is the
 *                           obvious case.
 *   starts `//`           → `//evil.com` is PROTOCOL-RELATIVE: a browser reads it as
 *                           `https://evil.com`, so it leaves this origin while looking
 *                           like a path. This is the case that gets missed, and without
 *                           it the guard above is decoration.
 *
 * Why it matters here specifically: the phishing value of an open redirect on a login
 * page is that the login itself is genuine. Someone types a real password into the real
 * dashboard and is then handed to an attacker's page, with no wrong-looking step to
 * notice.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return '/'
  if (!next.startsWith('/')) return '/'
  if (next.startsWith('//')) return '/'
  /**
   * A backslash is treated as a path separator by browsers in some positions, so `/\evil.com`
   * can normalise to a protocol-relative URL. Rejecting it costs nothing — no legitimate
   * route in this app contains one.
   */
  if (next.includes('\\')) return '/'
  return next
}
