import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ── every authenticated page must render the shell ────────────────────────
 *
 * `src/app/page.tsx` — the page you land on — rendered NO navigation at all. Every other page
 * rendered `<Nav>`; that one never did, so arriving at the dashboard left a person with no
 * links anywhere. It was found on 2026-08-05 by asserting on the rendered HTML instead of on a
 * status code, and it is a large part of why the dashboard was described as confusing to use.
 *
 * A page forgetting the shell is invisible in every other check: it compiles, it renders, it
 * returns 200, and its own content is fine. Only the absence of something else is wrong. So
 * this reads the source of every page and asserts the shell is there.
 *
 * `/sign-in` and `/sign-up` are the exceptions BY DESIGN: they are the only public pages, and
 * showing a signed-out visitor links to places they cannot reach is why the nav was never put
 * in the root layout.
 */

const APP = join(process.cwd(), 'src', 'app')
const PUBLIC_PAGES = ['sign-in', 'sign-up']

function pageFiles(dir: string, rel: string[] = []): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...pageFiles(full, [...rel, entry]))
    } else if (entry === 'page.tsx') {
      out.push({ route: '/' + rel.join('/'), file: full })
    }
  }
  return out
}

const PAGES = pageFiles(APP)

describe('the shell', () => {
  it('finds every page in the app', () => {
    // A guard against this test silently covering nothing if the directory layout moves.
    expect(PAGES.length).toBeGreaterThanOrEqual(8)
    expect(PAGES.map((p) => p.route)).toContain('/')
  })

  /**
   * A retired route keeps a page.tsx whose ENTIRE body is a `redirect()` — no JSX at
   * all — so old bookmarks land somewhere real. Those render nothing and are exempt
   * from the shell assertions; anything that renders even one element is not.
   */
  const isRedirectOnly = (file: string) => {
    const src = readFileSync(file, 'utf8')
    return src.includes('redirect(') && !src.includes('<')
  }
  const authenticated = PAGES.filter((p) => !PUBLIC_PAGES.some((x) => p.route.includes(x)) && !isRedirectOnly(p.file))

  it('has authenticated pages to check', () => {
    expect(authenticated.length).toBeGreaterThanOrEqual(6)
  })

  it.each(authenticated.map((p) => [p.route, p.file]))('%s renders the sidebar', (_route, file) => {
    const src = readFileSync(file, 'utf8')
    expect(src, 'does not import Nav').toMatch(/import \{ Nav \}/)
    expect(src, 'imports Nav but never renders it').toMatch(/<Nav\s+current=/)
  })

  /**
   * The `current` prop must match the page's own route, or the rail highlights the wrong
   * place. `/accounts/login` passed `current="/accounts"` — harmless while Sign-ins was not a
   * destination, wrong the moment it became one.
   */
  it.each(authenticated.map((p) => [p.route, p.file]))('%s tells the sidebar its own route', (route, file) => {
    const src = readFileSync(file, 'utf8')
    const declared = src.match(/<Nav\s+current="([^"]+)"/)?.[1]
    expect(declared, `${route}: no current prop found`).toBeDefined()
    expect(declared, `${route}: says it is at "${declared}"`).toBe(route)
  })

  /**
   * ── AND EVERY AUTHENTICATED PAGE MUST HAND THE RAIL THE SIGNED-IN EMAIL ───
   *
   * Sign-out moved into the sidebar in step C, because on `/` it had been rendering INSIDE the
   * health card — the box whose border and dot turn amber or red. `status-attention` is the
   * ordinary state whenever a draft is waiting, so the dashboard routinely showed an alarm
   * containing a warning sentence, "Last check read 168 posts" and Sign out.
   *
   * `Nav`'s `email` prop is optional so the conversion could land page by page without a broken
   * intermediate state. That is exactly the shape of thing that then stays half-done — the
   * `{ ok: true }` fall-through, `thread.ts`'s private copy of a read that a docblock claimed
   * was shared — so the completeness is asserted rather than remembered.
   */
  it.each(authenticated.map((p) => [p.route, p.file]))('%s gives the sidebar the signed-in email', (route, file) => {
    const src = readFileSync(file, 'utf8')
    expect(src, `${route}: renders <Nav> without email, so there is no way to sign out`).toMatch(
      /<Nav\s+current="[^"]+"\s+email=\{user\.email\}\s*\/>/,
    )
  })

  /**
   * The health card must hold the dot and the sentence and nothing else.
   *
   * Asserted at the SOURCE because the defect is compositional rather than visual: `SignOutButton`
   * and the last-check figure were children of `.status`, and no screenshot review caught it for
   * two days. A geometry check cannot see it either — the box was laid out perfectly.
   */
  it('nothing neutral is rendered inside the health card', () => {
    const home = readFileSync(join(APP, 'page.tsx'), 'utf8')
    const card = home.slice(home.indexOf('className={`status status-'))
    const cardEnd = card.indexOf('</div>')
    const inside = card.slice(0, cardEnd)
    expect(inside, 'sign-out is back inside the alarm').not.toMatch(/SignOutButton/)
    expect(inside, 'the last-check figure is back inside the alarm').not.toMatch(/lastCheckLabel/)
    expect(inside, 'the check-now button is back inside the alarm').not.toMatch(/SyncButton/)
    // And the things that DO belong are still there, so this is not passing on an empty card.
    expect(inside).toMatch(/className="dot"/)
    expect(inside).toMatch(/headline/)
  })

  /** The public pages must NOT carry it. */
  it.each(PAGES.filter((p) => PUBLIC_PAGES.some((x) => p.route.includes(x))).map((p) => [p.route, p.file]))(
    '%s does not show links a signed-out visitor cannot use',
    (_route, file) => {
      expect(readFileSync(file, 'utf8')).not.toMatch(/<Nav\s/)
    },
  )
})
