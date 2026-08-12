import { ThemeToggle } from './chrome'

/**
 * Every page's first block: what this page is, in a noun phrase and a sentence, with the
 * theme control on the right.
 *
 * It exists as a component rather than as markup each page repeats because the heading is
 * the one thing `pnpm ig:layout` asserts per page — it opens each route in a real browser
 * and fails if the page does not render its own heading. Nine hand-written copies is nine
 * chances for one of them to drift into a heading that no longer matches the rail entry
 * that points at it.
 *
 * `sub` is optional and genuinely so: a page that has nothing to add should say nothing
 * rather than pad. Most have something worth saying.
 */
export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      <ThemeToggle />
    </header>
  )
}
