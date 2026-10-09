/**
 * Sanitises the `?next=` destination carried through sign-in.
 *
 * Lives here rather than in `auth-actions.ts` because that file is `'use server'`, where
 * every export must be an async server action — a synchronous helper exported from it
 * fails the build. Being a plain module also means it is directly unit-testable, which
 * for an open-redirect guard is the difference between "believed correct" and "checked".
 */

/**
 * A base to resolve against. `http` is a SPECIAL scheme, so it is parsed exactly as the
 * dashboard's own `https` origin is — backslashes, dot segments and all — and `.invalid` can
 * never be a real host, so nothing resolved against it can be mistaken for one.
 */
const RESOLVE_BASE = 'http://safe-next.invalid'

/**
 * `next` arrives from a query parameter, so it is attacker-controlled and must never be
 * used as given. Only a same-origin absolute PATH survives, and only in the exact form the
 * browser will navigate to.
 *
 * Why it matters here specifically: the phishing value of an open redirect on a login
 * page is that the login itself is genuine. Someone types a real password into the real
 * dashboard and is then handed to an attacker's page, with no wrong-looking step to
 * notice.
 *
 * ── THE GUARD MUST MODEL THE SINK, NOT THE STRING (2026-10-09) ──────────────────────
 *
 * This used to refuse four things — empty, not starting `/`, starting `//`, a backslash —
 * and return the rest. Every check was about the STRING. What decides where a person lands
 * is what the WHATWG URL parser and Next's client do with that string afterwards, and both
 * change it:
 *
 *   1. THE PARSER DELETES TAB, LF AND CR. `/\t/evil.com` passes every string check and
 *      resolves to `https://evil.com/` — `?next=/%09/evil.com`, after a genuine login. TAB is
 *      the live vector (Node refuses LF and CR in a header, after the session exists).
 *   2. THE PARSER COLLAPSES DOT SEGMENTS, `%2e` forms included. `/.//evil.com` has pathname
 *      `//evil.com`, which Next re-emits as the href `//evil.com` on its hard-navigation
 *      branch — protocol-relative, off-site.
 *   3. THE PARSER MAPS `\` TO `/` and percent-encodes raw characters, so the bytes checked
 *      are not the bytes navigated.
 *   4. NEXT'S CLIENT SPLITS THE REDIRECT HEADER ON THE FIRST `;`. The server sends
 *      `x-action-redirect: <next>;push` and keeps a `;` inside `next`; the client takes
 *      everything before the first one. `/.//evil.com;/../..` resolves to `/` here — the
 *      `..` pops the junk segment — and the client navigates to `/.//evil.com`.
 *
 * So the rule is the property, not a list of shapes: **the parser must change nothing.**
 * An accepted value is printable ASCII, contains no `;`, resolves to this origin, and its
 * resolved `pathname + search + hash` is byte-identical to the input — so the string checked
 * IS the string the browser goes to. Everything the app itself generates already has that
 * form: the middleware builds `next` from the parser's own serialised pathname and query,
 * which round-trip by construction. What now falls back to `/` is hand-typed: a raw space or
 * non-ASCII character, a `;`, a dot segment, a trailing bare `?` or `#`.
 *
 * Every refusal returns `/`, a same-origin page. An accepted value is returned UNCHANGED —
 * never canonicalised and handed back, because a security guard that rewrites its input is
 * guarding a value nobody checked.
 */
export function safeNext(next: string | null | undefined): string {
  /**
   * `typeof`, not truthiness: server-action arguments are client-serialised, and
   * `?next=a&next=b` reaches the action as an ARRAY. `startsWith` on an array throws — after
   * `createSession`, so a successful sign-in ended in an error page.
   */
  if (typeof next !== 'string' || next === '') return '/'
  /** One leading `/`, then printable ASCII with no space (0x21-0x7e). Refuses TAB/LF/CR. */
  if (!/^\/[\x21-\x7e]*$/.test(next)) return '/'
  /**
   * `//evil.com` is PROTOCOL-RELATIVE, and a backslash is mapped to `/` by the parser. Both
   * are subsumed by the origin and round-trip checks below; they stay as the readable first
   * statement of the two classic cases.
   */
  if (next.startsWith('//') || next.includes('\\')) return '/'
  /**
   * Next's CLIENT splits `x-action-redirect` on the first `;` while the server keeps it, so a
   * `;` means the browser would go somewhere other than the string validated here.
   */
  if (next.includes(';')) return '/'
  let u: URL
  try {
    u = new URL(next, RESOLVE_BASE)
  } catch {
    return '/'
  }
  if (u.origin !== RESOLVE_BASE) return '/'
  /**
   * CANONICAL: the parser that the browser and Next both run must not change one byte. This
   * is what refuses dot-segment collapse (`/.//evil.com`, `/%2e//x`), backslash mapping and
   * any percent-encoding the parser would apply — and it is why, with it in place, a value
   * truncated at a `;` could not resolve to a `//` path even if the `;` check went.
   */
  if (u.pathname + u.search + u.hash !== next) return '/'
  return next
}
