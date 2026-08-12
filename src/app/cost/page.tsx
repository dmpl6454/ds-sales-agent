import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildCostView } from '../view-model'
import { buildCostCharts } from '../view-model/charts'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { StackedBars, BandedLine, type Series } from '../charts'

export const dynamic = 'force-dynamic'

/**
 * `/cost` — what detection costs. Money is its own question, and the person asking it is
 * not reading verdicts.
 *
 * ── THE CACHE-HIT RATE IS THE REASON THIS PAGE HAS TWO CHARTS ───────────────
 *
 * Spend is the obvious number and the boring one: this system costs cents. The chart that
 * earns its place is the cache-hit rate, because cached input is billed at roughly a
 * FIFTIETH of fresh input, and the classifier's system prompt is a module-level constant
 * with nothing interpolated into it precisely to keep that discount. A sustained drop
 * below the band does not mean "we are spending more" — it means somebody put a variable
 * into that constant, which is silent, permanent, and invisible in every other view.
 */

const SPEND_SERIES: Series[] = [
  { key: 'classify', label: 'Judging whether a post is paid', color: 'var(--ac)' },
  { key: 'resolve', label: 'Deciding if a handle is a company', color: 'var(--idle)' },
  { key: 'generate', label: 'Writing copy (switched off)', color: 'var(--ln-2)' },
]

export default async function CostPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, charts] = await Promise.all([buildCostView(), buildCostCharts(30)])

  const latest = [...charts.cache.points].reverse().find((p) => p.value !== null)
  const cacheNote =
    latest == null
      ? null
      : charts.cache.outOfBand > 0
        ? {
            text: `Below the expected band on ${charts.cache.outOfBand} of the last 30 days. That is worth reading the classify prompt for — a variable interpolated into a constant prompt destroys the discount silently and permanently.`,
            tone: 'bad' as const,
          }
        : { text: 'Inside the expected band. The prompt prefix is matching as it should.', tone: 'good' as const }

  return (
    <>
      <Nav current="/cost" email={user.email} />
      <div className="page">
        <PageHead title="Cost" sub="The only spending this system does: a model reads captions." />

        <ul className="statgrid" aria-label="Spend summary">
          <li>
            <strong>${v.spend.usd.toFixed(4)}</strong>
            <span>spent, lifetime</span>
          </li>
          <li>
            <strong>{v.spend.calls.toLocaleString('en-GB')}</strong>
            <span>calls to the model</span>
          </li>
          {/*
            FAILED CALLS ARE COUNTED, and never folded into the total above. A rising
            failure rate is exactly what a cost table hides by leaving it out — and a
            failed call is never recorded as a verdict, it yields UNCLASSIFIED, so these
            two numbers answer different questions and both have to be visible.
          */}
          <li className={v.spend.failed > 0 ? 'bad' : undefined}>
            <strong>{v.spend.failed}</strong>
            <span>failed — counted, never recorded as a verdict</span>
          </li>
          <li>
            {/* Null when nothing has been sent: "no calls" and "the cache never hits" are
                different facts, and a bare 0% would report the second. */}
            <strong>{v.spend.cachedShare === null ? '—' : `${Math.round(v.spend.cachedShare * 100)}%`}</strong>
            <span>of input served from cache</span>
          </li>
        </ul>

        <section className="grid-2">
          {charts.spend.any ? (
            <StackedBars
              series={SPEND_SERIES}
              buckets={charts.spend.buckets}
              caption="Spend by purpose"
              description="30 days · each purpose is its own bucket so classification spend is never blurred with the rest"
              unit="$"
              labelEvery={7}
              height={170}
            />
          ) : (
            <p className="empty">No model calls in the last 30 days.</p>
          )}

          <BandedLine
            points={charts.cache.points}
            bandLow={charts.cache.bandLow}
            bandHigh={charts.cache.bandHigh}
            caption="Cache-hit rate"
            description="Against the 95–98% this system has been measured to hold. A day with no calls breaks the line rather than dropping it to zero."
            note={cacheNote}
            height={170}
          />
        </section>

        <section>
          <h2>By kind of work</h2>
          <div className="rows">
            {v.byPurpose.map((p) => (
              <div className="rowitem" key={p.purpose}>
                <span>{purposeLabel(p.purpose)}</span>
                <span className="muted n" style={{ marginLeft: 'auto' }}>
                  {p.calls.toLocaleString('en-GB')} calls · ${p.usd.toFixed(4)}
                </span>
              </div>
            ))}
            {v.byPurpose.length === 0 ? <div className="rowitem muted">No calls made yet.</div> : null}
          </div>
        </section>

        <section>
          <h2>Classifying, by channel</h2>
          <div className="rows">
            {v.perChannel.map((c) => (
              <div className="rowitem" key={c.handle}>
                <span>@{c.handle}</span>
                <span className="muted n" style={{ marginLeft: 'auto' }}>
                  {c.calls.toLocaleString('en-GB')} posts judged · ${c.usd.toFixed(4)}
                </span>
              </div>
            ))}
            {v.perChannel.length === 0 ? <div className="rowitem muted">Nothing classified yet.</div> : null}
          </div>
          {/*
            A channel that costs nothing is not a channel nobody is watching. M.O.M
            discloses with #Collaboration, so its verdicts come from a deterministic rule
            and never reach the model — $0.0000 there is the system working, not a gap.
          */}
          <p className="blurb">
            A channel at $0.0000 is not unwatched — a channel that discloses its paid posts is judged by a rule
            rather than by the model, which costs nothing.
          </p>
        </section>
      </div>
    </>
  )
}

function purposeLabel(purpose: string): string {
  switch (purpose) {
    case 'classify':
      return 'Judging whether a post is paid'
    case 'generate':
      return 'Writing message copy (switched off)'
    case 'resolve':
      return 'Deciding whether a handle is a company'
    default:
      return purpose
  }
}
