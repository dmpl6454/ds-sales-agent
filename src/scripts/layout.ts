/**
 * ── `pnpm ig:layout` — DOES THE DASHBOARD ACTUALLY LAY OUT? ─────────────────
 *
 * This exists because of one shipped bug and one false claim.
 *
 * THE BUG. The sidebar's first version put `display: grid; grid-template-columns: 15rem 1fr`
 * on `main`, which assumes exactly two children. Every page renders two — except `/`, which
 * renders eleven. So children 3, 5, 7, 9 and 11 landed in column ONE, underneath a sticky
 * full-height rail, and the home page became unreadable.
 *
 * THE FALSE CLAIM. It shipped because the verification asked whether the rail was PRESENT,
 * whether a link was marked active, whether the JS chunks loaded and whether an error boundary
 * appeared. **All five passed on a page whose layout was destroyed.** `globals.css` then
 * claimed "the geometry is now checked in a real browser" and no such check existed — the same
 * shape as `readThread.ts` claiming "one implementation, two callers" while `thread.ts` held a
 * full private copy.
 *
 * So: PRESENCE IS NOT LAYOUT. This opens every page in a real browser and asserts geometry.
 *
 *   1. the rail and the content column do not INTERSECT — the actual failure
 *   2. no element overflows the viewport horizontally — the page body must never scroll sideways
 *   3. the content column is wide enough to be readable
 *   4. every page renders its own heading, so a 200 with an error boundary cannot pass
 *   5. nothing on screen carries one of our internal labels
 *
 * At two widths, because the rail becomes a strip under 60rem and a media query is a second
 * layout nobody looks at.
 *
 * Reads a session token from DS_LAYOUT_TOKEN so it never needs a password. Mint one however
 * you like; it is only a cookie value.
 */
import { chromium, type Page } from 'playwright'
import { SESSION_COOKIE } from '@/lib/session-cookie'

const BASE = process.env.DS_LAYOUT_BASE ?? 'http://127.0.0.1:3100'
const TOKEN = process.env.DS_LAYOUT_TOKEN

/**
 * Every authenticated page, with a string that must appear on it and a QUERY BUDGET.
 *
 * ── WHAT THE BUDGET IS FOR, AND WHAT IT IS NOT ────────────────────────────────────────
 *
 * The defect it catches is a loop issuing one query per row — a count that GROWS WITH THE
 * DATA. `buildBrandsPanel` ran two queries per brand across an unbounded list: invisible at
 * 9 brands, a ten-second page at 68, a minute at 500. Nothing noticed for months, because
 * every other check on this page passes on a slow page as happily as on a fast one.
 *
 * FOUND ON THE FIRST REAL RUN, which is this check earning its keep before it was even
 * finished: `/` issued **559 queries** (measured twice, 1,577 ms) — after the brands N+1
 * had been killed. The cause was the per-draft gate loop in `buildMessagesPage` over an
 * unbounded queue, whose own comment claimed the list was "small by construction" because
 * `maxUnansweredTouches` and the daily caps bound it. Those bound SENDS. The list is now
 * capped at `WAITING_SHOWN` with the total shown beside it, which took `/` to 454.
 *
 * THE NUMBERS BELOW ARE CEILINGS OVER TODAY'S BOUNDED DESIGN, plus roughly a quarter of
 * headroom. That is a weaker statement than "no page may exceed 20 queries" and it is the
 * honest one: `/` legitimately asks the REAL gate about every draft it renders, because a
 * draft that does not say why it cannot be sent is the failure this dashboard is built
 * against. What the budget asserts is that the count stays a function of the LIMIT rather
 * than of the queue — so a new per-row loop, or an unbounded list added later, fails here.
 *
 * `/`'s 454 is high and is left as outstanding work rather than hidden: reducing it means
 * batching the gate's own reads, which is a change to a safety-critical function and wants
 * its own session. Raising a budget to make this pass is the one thing not to do.
 */
const PAGES: Array<{ path: string; heading: string; queryBudget: number }> = [
  // Bounded by WAITING_SHOWN (20) x the gate's own reads, plus the page's fixed work.
  { path: '/', heading: 'Autopilot', queryBudget: 520 },
  { path: '/targets', heading: 'Targets', queryBudget: 120 },
  { path: '/paid-posts', heading: 'Paid posts', queryBudget: 120 },
  { path: '/analytics', heading: 'Analytics', queryBudget: 125 },
  { path: '/senders', heading: 'Senders', queryBudget: 35 },
  { path: '/rules', heading: 'Rules', queryBudget: 30 },
  { path: '/cost', heading: 'Cost', queryBudget: 30 },
  { path: '/settings', heading: 'Settings', queryBudget: 25 },
]

/**
 * Internal bookkeeping that must never be on screen. `operatorName` strips these; this is the
 * end-to-end check that it is actually applied, which a unit test on the function cannot give.
 */
const INTERNAL_LABELS = ['(test target)', '(rehearsal target)', '(trial)']

const VIEWPORTS = [
  { name: 'wide', width: 1440, height: 900 },
  // Below the 60rem breakpoint, where the rail becomes a horizontal strip.
  { name: 'narrow', width: 800, height: 900 },
]

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function intersects(a: Box, b: Box): boolean {
  // Touching edges are fine; a shared pixel is not.
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

let failures = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    console.log(`   ✓ ${label}`)
  } else {
    failures++
    console.log(`   ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

/**
 * NO NAMED INNER FUNCTIONS IN HERE. Not a style preference — tsx/esbuild's `keepNames` wraps a
 * named function (which includes `const rect = (el) => …`, since the const gives it a name) in a
 * `__name()` helper that does not exist inside the page, and the call throws
 * `ReferenceError: __name is not defined`. It is in CLAUDE.md's trap list and it cost twenty
 * minutes once; the first version of this file hit it immediately. Everything below is inline.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    const railEl = document.querySelector('nav.side')

    const railRect = railEl ? railEl.getBoundingClientRect() : null
    const mainRect = main ? main.getBoundingClientRect() : null

    /**
     * The widest thing on the page, and WHAT it is. A bare `scrollWidth > clientWidth` says
     * "something overflows" and leaves you hunting; naming the element is the difference
     * between a finding and a chore.
     */
    let widest: { tag: string; cls: string; right: number } | null = null
    const all = Array.from(document.querySelectorAll('main *'))
    for (let i = 0; i < all.length; i++) {
      const el = all[i]!
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (!widest || r.right > widest.right) {
        widest = { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), right: r.right }
      }
    }

    /**
     * Direct children of `main` — the count the broken CSS silently depended on.
     *
     * The rail ITSELF is one of them, because every page renders `<Nav>` inside its own
     * component rather than in the root layout (so `/sign-in` shows no links). It is excluded
     * here: the first version of this script did not, and duly reported that the rail
     * overlapped the rail, on every page, forever. A checker that always fails is worth as
     * little as one that always passes.
     */
    const children: Array<{ tag: string; cls: string; x: number; y: number; width: number; height: number }> = []
    const kids = Array.from(main ? main.children : [])
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!
      if (c === railEl) continue
      const r = c.getBoundingClientRect()
      children.push({
        tag: c.tagName.toLowerCase(),
        cls: String(c.className || '').slice(0, 40),
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })
    }

    /**
     * Page text with the rail's own text removed.
     *
     * Every rail entry is a page NAME, so `body.innerText.includes('Today')` was satisfied by
     * the sidebar on all nine pages — a heading check that could not fail. Exactly the
     * tautology CLAUDE.md warns about: check the thing that changes, not the thing that is
     * there either way.
     */
    let pageText = ''
    const outside = Array.from(main ? main.children : [])
    for (let i = 0; i < outside.length; i++) {
      if (outside[i] === railEl) continue
      pageText += (outside[i] as HTMLElement).innerText + '\n'
    }

    /**
     * ── THE CHILD-COUNT ASSUMPTION, TESTED DIRECTLY ──────────────────────────
     *
     * Appends a probe block to `main` and measures where it lands. If the layout puts content
     * beside the rail because of a rule that cares how many children there are, the probe is the
     * child that falls underneath it.
     *
     * This exists because the obvious check turned out to be unfalsifiable. Reintroducing the
     * exact CSS that shipped and broke `/` —
     *
     *     body:has(.side) main { display: grid; grid-template-columns: 15rem 1fr }
     *
     * — and re-running this script produced almost NO failures, because splitting `/` in step C
     * left every page rendering exactly two children: the rail, and one `div.page`. A two-column
     * grid with two children works. The bug did not go away; it went LATENT, and it returns the
     * moment any page renders a second block outside `.page`, which is what `/` did eleven times.
     *
     * So the property to assert is not "the current children happen to clear the rail" — that is
     * true by luck — but "a block added to this page WOULD clear it". The probe is removed
     * immediately; nothing is left behind.
     */
    let probe: { x: number; y: number; width: number; height: number } | null = null
    let mainDisplay = ''
    if (main) {
      mainDisplay = getComputedStyle(main).display
      const el = document.createElement('div')
      el.style.height = '20px'
      el.textContent = 'probe'
      main.appendChild(el)
      const r = el.getBoundingClientRect()
      probe = { x: r.x, y: r.y, width: r.width, height: r.height }
      main.removeChild(el)
    }

    return {
      rail: railRect ? { x: railRect.x, y: railRect.y, width: railRect.width, height: railRect.height } : null,
      main: mainRect ? { x: mainRect.x, y: mainRect.y, width: mainRect.width, height: mainRect.height } : null,
      probe,
      mainDisplay,
      children,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      widest,
      pageText,
      text: document.body.innerText,
      hasErrorBoundary: /Application error|Unhandled Runtime Error|This page could/i.test(document.body.innerText),
    }
  })
}

/**
 * Read and zero the server's query counter.
 *
 * `enabled: false` is a FAILURE rather than a skip. Counting is off unless the server was
 * started with `DS_QUERY_COUNT=1`, and a budget check that quietly passes when nobody is
 * counting is precisely the reassuring falsehood this file was written against — the same
 * shape as `framesRead` collapsing "no engine" into "no text found".
 */
async function readQueryCount(page: Page): Promise<number | null> {
  const res = await page.request.get(BASE + '/api/query-count')
  if (!res.ok()) return null
  const body = (await res.json()) as { enabled: boolean; queries?: number }
  if (!body.enabled) return null
  return body.queries ?? null
}

async function main() {
  if (!TOKEN) {
    console.error('Set DS_LAYOUT_TOKEN to a valid dashboard session token.')
    process.exit(2)
  }

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const url = new URL(BASE)
  await ctx.addCookies([
    { name: SESSION_COOKIE, value: TOKEN, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
  ])
  const page = await ctx.newPage()

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    console.log(`\n══ ${vp.name} — ${vp.width}×${vp.height} ══`)

    for (const p of PAGES) {
      /**
       * Zero the counter IMMEDIATELY before navigating, so what is measured is this page's
       * render and not whatever the previous assertions cost. The read is discarded.
       */
      const budgetOn = vp === VIEWPORTS[0]
      if (budgetOn) await readQueryCount(page)

      const res = await page.goto(BASE + p.path, { waitUntil: 'networkidle' })
      console.log(`\n ${p.path}  (HTTP ${res?.status()})`)

      // A redirect is a 200 at the browser level, so check where we actually ended up.
      const landed = new URL(page.url()).pathname
      check(landed === p.path, `stayed on ${p.path}`, landed !== p.path ? `redirected to ${landed}` : '')
      if (landed !== p.path) continue

      /**
       * ── THE QUERY BUDGET ──────────────────────────────────────────────────────────
       *
       * Read FIRST, before the asset fetches and the geometry probes below, so nothing
       * this script does is attributed to the page. Measured once per page, at the wide
       * viewport only: the query count is a property of the render, not of the width, and
       * asserting it twice would only make a failure appear twice.
       *
       * This is the check the ten-second dashboard needed and did not have. Geometry,
       * assets, headings and error boundaries all passed on `/` while it issued 174
       * queries over a tunnel; the page was laid out perfectly and took ten seconds.
       */
      if (budgetOn) {
        const queries = await readQueryCount(page)
        if (queries === null) {
          check(false, 'the server is counting queries', 'start it with DS_QUERY_COUNT=1')
        } else {
          check(
            queries <= p.queryBudget,
            `stays within its query budget (${queries}/${p.queryBudget})`,
            `${queries} queries to render one page — look for a loop issuing one per row`,
          )
        }
      }

      const m = await measure(page)

      /**
       * ── EVERY ASSET THE PAGE REFERENCES MUST ACTUALLY LOAD ──────────────────
       *
       * A 200 on the page says nothing about its stylesheet. Found while verifying this very
       * script: `pnpm build` had been run while `pnpm start` was live — the trap CLAUDE.md
       * already records — so the HTML referenced a replaced chunk and
       * `/_next/static/chunks/*.css` returned **HTTP 500 with the body "Internal Server Error"**.
       * The dashboard was rendering with NO CSS AT ALL, and this script still passed seven of
       * its nine checks on that page: the rail was present, nothing overlapped, no error
       * boundary, the heading was there. Geometry assertions on an unstyled page are almost all
       * vacuously true, because without a rail there is nothing to collide with.
       *
       * So the assets are fetched. It is three requests and it turns an invisible catastrophe
       * into a named failure.
       */
      const assets = await page.evaluate(() => {
        const out: string[] = []
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        for (let i = 0; i < links.length; i++) out.push((links[i] as HTMLLinkElement).href)
        const scripts = Array.from(document.querySelectorAll('script[src]'))
        for (let i = 0; i < scripts.length; i++) out.push((scripts[i] as HTMLScriptElement).src)
        return out
      })
      const broken: string[] = []
      for (const a of assets) {
        const r = await page.request.get(a)
        if (!r.ok()) broken.push(`${r.status()} ${a.replace(BASE, '')}`)
      }
      check(assets.length > 0, 'the page references a stylesheet or script at all')
      check(broken.length === 0, `all ${assets.length} assets load`, broken.join(' · '))

      /**
       * And a stylesheet that loads is not the same as a stylesheet that APPLIES. This asks the
       * browser for a value only our own CSS sets, so a served-but-ignored file still fails.
       */
      const styled = await page.evaluate(() => {
        const rail = document.querySelector('nav.side')
        return rail ? getComputedStyle(rail).display : ''
      })
      check(styled === 'flex', 'our stylesheet is actually applied', `nav.side display: "${styled}"`)

      check(!m.hasErrorBoundary, 'no error boundary')
      // `pageText`, not `text`: the rail lists every page NAME, so checking the whole body
      // made this assertion satisfied by the sidebar on all nine pages — unfailable.
      check(m.pageText.includes(p.heading), `renders its own heading "${p.heading}"`)
      check(m.rail !== null, 'the sidebar is present')

      if (m.rail && m.main) {
        /**
         * THE ASSERTION THE ORIGINAL BUG WOULD HAVE FAILED — and note WHICH boxes it compares.
         *
         * Not the rail against `main`. Every page renders `<Nav>` inside itself, so the rail is
         * a child of `main`, and below the 60rem breakpoint it is `position: static` and stacks
         * above the content — at which point `main`'s box legitimately CONTAINS the rail and
         * "they overlap" is the correct layout, not a defect. The first version of this script
         * asserted it anyway and reported seven false failures at 800px.
         *
         * What must never overlap is the rail and the page's own CONTENT, child by child. That
         * is exactly where the real bug showed: `main`'s box spanned both columns while children
         * 3, 5, 7, 9 and 11 sat underneath the rail. A container that clears the rail proves
         * nothing about what is inside it, and it holds at both widths.
         */
        const overlapping = m.children.filter((c) => c.width > 0 && c.height > 0 && intersects(m.rail!, c))
        check(
          overlapping.length === 0,
          `all ${m.children.length} content blocks clear the rail`,
          overlapping.map((c) => `${c.tag}.${c.cls} at ${Math.round(c.x)},${Math.round(c.y)}`).join(' · '),
        )

        /**
         * And the check above is only true by luck unless this one holds. Every page currently
         * renders ONE content block, so "the children clear the rail" would stay green under the
         * very CSS that destroyed `/`. This asks whether a block ADDED to the page would clear
         * it — the property, rather than today's arrangement of it.
         */
        check(
          m.probe !== null && !intersects(m.rail, m.probe),
          'a block added to this page would clear the rail too',
          m.probe ? `probe landed at ${Math.round(m.probe.x)},${Math.round(m.probe.y)}` : 'no probe',
        )
      }

      /**
       * A fixed rail plus padding cannot care how many children a page has. A grid or flex
       * container on `main` can, and did. Stated as an assertion rather than as a comment,
       * because `globals.css` claimed the geometry was checked when nothing checked it.
       */
      check(
        m.mainDisplay !== 'grid' && m.mainDisplay !== 'flex' && m.mainDisplay !== 'inline-grid' && m.mainDisplay !== 'inline-flex',
        'main is not a container whose layout depends on child count',
        `display: ${m.mainDisplay}`,
      )

      check(
        m.docScrollWidth <= m.docClientWidth + 1,
        'the page does not scroll sideways',
        `scrollWidth=${m.docScrollWidth} clientWidth=${m.docClientWidth} widest=${m.widest?.tag}.${m.widest?.cls}`,
      )

      /**
       * The width of the CONTENT BLOCK, not of `main`.
       *
       * `main` spans the viewport whatever happens inside it, so measuring it made this check
       * unfailable — found by reintroducing the grid bug, which crushed the content into a 15rem
       * column and left this assertion green. Measure the thing that carries the text.
       */
      const widestBlock = Math.max(0, ...m.children.map((c) => c.width))
      check(
        widestBlock > 320,
        'the content column is wide enough to read',
        `widest content block = ${Math.round(widestBlock)}px inside a ${Math.round(m.main?.width ?? 0)}px main`,
      )

      const leaked = INTERNAL_LABELS.filter((l) => m.text.includes(l))
      check(leaked.length === 0, 'no internal labels on screen', leaked.join(', '))
    }
  }

  await browser.close()
  console.log(failures === 0 ? '\nALL LAYOUT CHECKS PASSED' : `\n${failures} LAYOUT CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
