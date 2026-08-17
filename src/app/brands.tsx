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
      <p className="brandcap">
        {capLeft > 0
          ? `${capLeft} new brand${capLeft === 1 ? '' : 's'} may be contacted for the first time today.`
          : `Today's new-brand allowance is used. Follow-ups are unaffected.`}
      </p>

      {brands.confirmed.map((b) => (
        <ConfirmedBrand key={b.handle} brand={b} />
      ))}

      {brands.autoDecided.length > 0 && (
        <section>
          <h3>Decided automatically</h3>
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
        </section>
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
function ConfirmedBrand({ brand }: { brand: BrandsPanel['confirmed'][number] }) {
  return (
    <div className={`brandrow${brand.retired ? ' retired' : ''}`}>
      <div className="brandmain">
        <a href={`https://www.instagram.com/${brand.handle}/`} target="_blank" rel="noreferrer" className="brandname">
          {brand.name}
        </a>
        <span className="brandhandle">@{brand.handle}</span>
        {brand.retired ? <span className="pill">retired</span> : null}
      </div>
      <div className="brandmeta">
        {brand.category ? <span>{brand.category}</span> : null}
        {brand.discoveredOn ? <span>found in a paid post on {brand.discoveredOn}</span> : null}
        {brand.sent > 0 ? (
          <span>
            {brand.sent} message{brand.sent === 1 ? '' : 's'} sent
          </span>
        ) : null}
      </div>
    </div>
  )
}
