/**
 * Every page's first block: what this page is, in a noun phrase and a sentence.
 *
 * It exists as a component rather than as markup each page repeats because the heading is
 * the one thing `pnpm ig:layout` asserts per page — it opens each route in a real browser
 * and fails if the page does not render its own heading. Nine hand-written copies is nine
 * chances for one of them to drift into a heading that no longer matches the bar entry
 * that points at it.
 *
 * THE THEME CONTROL USED TO LIVE HERE and now lives in the bar, which is where the mockup
 * puts it. It was rendered once per page, so it moved as you navigated — chrome that shifts
 * position between screens reads as content. The bar is rendered by every authenticated
 * page too, so nothing lost a home in the move.
 *
 * `sub` is optional and genuinely so: a page that has nothing to add should say nothing
 * rather than pad. Most have something worth saying.
 *
 * `aside` is the design's right-hand slot on the heading row — the clock and the next slot
 * on Autopilot. It is a SEPARATE prop from `sub` rather than a longer subtitle because the
 * two align differently: `sub` sits under the title inside the measure cap, `aside` sits on
 * the title's own baseline at the far edge. Folding the clock into `sub` put a number that
 * changes every minute inside a sentence that describes the page.
 */
export function PageHead({ title, sub, aside }: { title: string; sub?: string; aside?: string }) {
  return (
    <header className={aside ? 'page-head page-head-baseline' : 'page-head'}>
      <div className="page-head-text">
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {aside ? <span className="page-head-aside">{aside}</span> : null}
    </header>
  )
}
