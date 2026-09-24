'use client'

import type { BrandsPanel } from './view-model'

/**
 * Companies found inside paid posts — the other half of the scope: message the channel
 * that posted, and the brands named in it.
 *
 * TWO LISTS, AND THE SPLIT IS STILL THE POINT — BUT ONE OF THEM CHANGED MEANING
 *
 * It used to be confirmed buyers beside handles A PERSON had to decide about, each with an
 * "It's a company" / "Not a company" pair of buttons. Those buttons existed for a real reason:
 * Instagram's category endpoint returns HTTP 400 for accounts that HAVE a business category
 * (Meta deleted the schema behind it), so the accounts most likely to be brands are exactly the
 * ones it cannot classify — and measured 2026-08-03, everything still readable is IDENTICAL for
 * @tilara.india (a brand) and @adityathackeray (a politician).
 *
 * Tabish, on being shown @adidas, @adidasindia, @crocs and @bonkerscorner sitting in that queue
 * under "could not read this account": *"How can adidas not be recognized as anything? I do not
 * want this option to select manually, correct it."*
 *
 * What fixed it was a different INPUT, not a button. The classifier is given the handle AND the
 * paid post it appeared in — evidence the category endpoint never had — and it runs from the
 * pipeline, so the queue is answered before anyone could open this page.
 *
 * So the second list is now a RECORD of what was decided automatically. It keeps the reason on
 * screen, because an automatic decision nobody can inspect is worse than a manual one: a
 * prospect created by a model months ago still has to be explicable today.
 */
export function BrandsPanelView({ brands }: { brands: BrandsPanel }) {
  const capLeft = Math.max(0, brands.newTouchCap - brands.newTouchesUsedToday)
  /*
    The denominator for every bar, computed ONCE from the rows actually rendered. A bar
    scaled per-row against itself would draw every brand full, which is a chart that
    cannot be read; scaled against a total nobody can see it would draw every brand
    empty. The busiest row in the list is the only honest full bar.
  */
  const busiest = Math.max(0, ...brands.confirmed.map((b) => b.sent))

  if (brands.confirmed.length === 0 && brands.autoDecided.length === 0) {
    return (
      <section>
        <h2>Brands</h2>
        <p className="none">
          No brands found yet. They are discovered inside paid posts, and decided automatically once a few
          campaigns have been detected.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2>
        Brands
        {/*
          THE TOTAL, whenever the list is truncated. The panel is bounded now (it was the
          unbounded read behind 145 of the page's 174 queries), and a shortened list with no
          total reads as the whole set — trading a slow page for a quietly wrong one.
          Same shape as the posts table's "showing the newest 100 of 223".
        */}
        <span className="h2note">
          {brands.confirmedTotal > brands.confirmed.length
            ? `newest ${brands.confirmed.length} of ${brands.confirmedTotal} confirmed`
            : `${brands.confirmed.length} confirmed`}
          {brands.autoDecided.length > 0 ? ` · ${brands.autoDecided.length} decided automatically` : ''}
        </span>
      </h2>

      {/*
        The cap is stated even when nothing is blocked by it. A limit that only appears at
        the moment it bites reads as a malfunction; stated up front it reads as a plan.
      */}
      {/*
        AN UNLIMITED CAP IS NOT A NUMBER, and printing it as one put the word "Infinity"
        on the page: `maxNewBrandTouchesPerDay` is a Setting that may be unset, and unset
        means no ceiling rather than a very large one. `capLeft` is then `Infinity`, which
        `${}` renders literally. The line is dropped entirely when there is no cap — a
        limit that does not exist has nothing to say, and "unlimited new brands may be
        contacted today" reads as a boast about the one number this page should be quiet
        about.
      */}
      {Number.isFinite(brands.newTouchCap) ? (
        <p className="brandcap">
          {capLeft > 0
            ? `${capLeft} new brand${capLeft === 1 ? '' : 's'} may be contacted for the first time today.`
            : `Today's new-brand allowance is used. Follow-ups are unaffected.`}
        </p>
      ) : null}

      {/*
        ONE PANEL OF BARS, which is the design's shape and the reason it is worth having:
        the list was thirty identical two-column rows, so nothing on it said which company
        mattered. The bar is MESSAGES SENT, scaled against the busiest brand in the list.

        Deliberately not "posts": the design's fixture says "3 posts", and a per-brand post
        count is a query nobody has written. A bar drawn from a number we do not hold would
        be a magnitude with nothing behind it, on the one page whose job is telling the
        truth about the numbers. A brand nobody has written to yet gets an empty track and
        says so in words beside it.
      */}
      <div className="card card-tint brandbars">
        {brands.confirmed.map((b) => (
          <ConfirmedBrand key={b.handle} brand={b} max={busiest} />
        ))}
      </div>

      {/*
        THE RECORD OF WHAT WAS DECIDED AUTOMATICALLY, folded. It is not a queue and has not
        been one since 2026-08-08 — nobody has to act on it — but it must stay reachable,
        because a prospect a model created months ago still has to be explicable today. The
        design draws brands and stops; this is the explanation behind them, one click down.
      */}
      {brands.autoDecided.length > 0 && (
        <details className="fold">
          <summary>How {brands.autoDecided.length} of these were decided</summary>
          {/*
            WHY this list exists at all, in the reader's terms. The old heading was "Instagram
            could not tell us what these are", which named the cause and left a job to do; this
            names the cause AND says the job is done.

            The last sentence is the safety property, stated rather than implied: not confident
            means LEFT ALONE. It is not "filed as not-a-company" — absence of confidence stays
            absence, which is the direction this codebase has failed in five times.
          */}
          <p className="undecided-why">
            When Instagram cannot say what an account is, the classifier decides from what it knows about the
            handle and the paid post it appeared in. When it is not confident, the account is left alone — never
            messaged, never queued for you.
          </p>
          <ul className="plain-list">
            {brands.autoDecided.map((d) => (
              <li key={d.handle}>
                {/*
                  `{' '}` is load-bearing. JSX drops the bare space between an expression and the
                  next line's text, and that exact bug reached this dashboard once already
                  ("themunder"), found in a screenshot rather than by any test.
                */}
                <strong>@{d.handle}</strong>{' '}
                {d.outcome === 'company' ? 'added as a prospect' : 'left alone (not confident it is a company)'}
                {d.reason ? <span className="muted"> — {d.reason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * A confirmed brand. Read-only, and now read-only everywhere.
 *
 * There was never an enable control here — the note used to say routes lived on the account rows
 * instead. As of 2026-08-08 there are no route controls anywhere: which routes exist is one rule
 * (`routeAllowed`) and they are created automatically, so "no route on" has stopped being a state
 * a person can put a brand into.
 */
function ConfirmedBrand({ brand, max }: { brand: BrandsPanel['confirmed'][number]; max: number }) {
  const pct = max > 0 ? Math.round((brand.sent / max) * 100) : 0
  return (
    <div className={`brandbar${brand.retired ? ' retired' : ''}`}>
      <div className="brandbar-name">
        <a href={`https://www.instagram.com/${brand.handle}/`} target="_blank" rel="noreferrer">
          {brand.name}
        </a>
        {brand.retired ? <span className="pill"> retired</span> : null}
      </div>
      <div className="brandbar-meta">
        <span className="brandbar-handle">@{brand.handle}</span>
        <span className="brandbar-note">
          {/*
            WHAT THE BAR IS, in words, on every row. A bar with no unit beside it is a
            proportion of something unstated, and this one is messages rather than the
            posts the design's fixture shows. `{' '}` is load-bearing: JSX drops the bare
            space between an expression and the next line's text, and that bug reached
            this dashboard once already ("themunder").
          */}
          {brand.sent > 0 ? (
            <>
              {brand.sent} message{brand.sent === 1 ? '' : 's'} sent
            </>
          ) : (
            <>not written to yet</>
          )}
          {brand.discoveredOn ? <> &middot; found {brand.discoveredOn}</> : null}
        </span>
      </div>
      <div className="brandbar-track">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
