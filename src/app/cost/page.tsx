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

  /**
   * Classification is ONE call per post, so the classify bucket's call count IS the number
   * of posts judged. Read from `byPurpose` rather than summed over `perChannel`: the channel
   * rows fold calls whose subject no longer resolves into a 'no longer stored' bucket, and a
   * headline figure must not depend on whether a join still lands.
   */
  const postsJudged = v.byPurpose.find((p) => p.purpose === 'classify')?.calls ?? 0

  return (
    <>
      <Nav current="/cost" email={user.email} />
      <div className="page">
        <PageHead title="Cost" sub="The only spending this system does: a model reads captions." />

        {/*
          FOUR TILES, each a labelled figure rather than a figure with a caption under it.
          The eyebrow names the measure first, which is what makes "216 (3 failed)" legible
          as one fact about calls rather than as two numbers sharing a box.
        */}
        <div className="grid-4" aria-label="Spend summary">
          <div className="card card-tint">
            <div className="eyebrow">Lifetime spend</div>
            <div className="tile-n">${v.spend.usd.toFixed(4)}</div>
          </div>
          <div className="card card-tint">
            <div className="eyebrow">Calls</div>
            {/*
              FAILED CALLS ARE COUNTED, and never folded into the total beside them. A rising
              failure rate is exactly what a cost table hides by leaving it out — and a failed
              call is never recorded as a verdict, it yields UNCLASSIFIED, so these two numbers
              answer different questions and both have to be visible.
            */}
            <div className="tile-n">
              {v.spend.calls.toLocaleString('en-GB')}{' '}
              {v.spend.failed > 0 ? <span className="tile-sub bad">({v.spend.failed} failed)</span> : null}
            </div>
          </div>
          <div className="card card-tint">
            <div className="eyebrow">Cache hit</div>
            {/* Null when nothing has been sent: "no calls" and "the cache never hits" are
                different facts, and a bare 0% would report the second. */}
            <div className="tile-n" style={{ color: v.spend.cachedShare === null ? undefined : 'var(--good)' }}>
              {v.spend.cachedShare === null ? '—' : `${Math.round(v.spend.cachedShare * 100)}%`}
            </div>
          </div>
          <div className="card card-tint">
            <div className="eyebrow">Posts judged</div>
            <div className="tile-n">{postsJudged.toLocaleString('en-GB')}</div>
          </div>
        </div>

        {/*
          BY CHANNEL, as a table rather than a row list: these are four measures of the same
          kind across channels, so the reader's question is columnar ("which one costs more
          per post?") and a list of sentences cannot be scanned that way.

          The mockup's Cache-hit and Judged columns are NOT here, deliberately. Cache-hit is
          not measured per channel — the ledger records it fleet-wide — and Judged would be
          the Calls column under a second name, since classification is one call per post.
          Inventing either would put a figure on screen that no module computes, which is the
          one thing every number on these pages is supposed not to be.
        */}
        <section>
          <h2>By channel</h2>
          {/*
            The wash-panel row grid every other list on this redesign uses, not a plain
            `<table>` — see the CSS comment on `.qrows-cost`. Three real columns; Cache-hit
            and a separate Judged column are not here because nothing computes either per
            channel (stated in full below the table).
          */}
          <div className="qrows qrows-cost">
            <div className="qhead">
              <span>Channel</span>
              <span className="qright">Posts judged</span>
              <span className="qright">Spend</span>
            </div>
            {v.perChannel.map((c) => (
              <div className="qrow" key={c.handle}>
                <span className="qhandle">@{c.handle}</span>
                <span className="qright">{c.calls.toLocaleString('en-GB')}</span>
                <span className="qright">${c.usd.toFixed(4)}</span>
              </div>
            ))}
            {v.perChannel.length === 0 ? (
              <div className="qrow">
                <span className="muted">Nothing classified yet.</span>
              </div>
            ) : null}
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

        {/*
          BY PURPOSE, as cards: unlike the channels these are NOT comparable measures of one
          thing. Each purpose is a different job with a different reason for running or not,
          and the status is the point — `generate` sitting at zero is the system obeying a
          decision, not a channel that happens to be cheap.
        */}
        <section>
          <h2>By purpose</h2>
          <div className="grid-3">
            {v.byPurpose.map((p) => {
              const running = p.calls > 0
              return (
                <div
                  className="purpose"
                  key={p.purpose}
                  style={{ ['--rule' as string]: running ? 'var(--good)' : 'var(--idle)' }}
                >
                  <div className="purpose-top">
                    <span className="purpose-name">{purposeLabel(p.purpose)}</span>
                    <span className="purpose-status">{running ? 'running' : 'off'}</span>
                  </div>
                  <p className="purpose-note">{purposeNote(p.purpose)}</p>
                  <div className="purpose-figures">
                    {p.calls.toLocaleString('en-GB')} calls · ${p.usd.toFixed(4)}
                  </div>
                </div>
              )
            })}
            {v.byPurpose.length === 0 ? <p className="empty">No calls made yet.</p> : null}
          </div>
        </section>

        {/*
          ── THE CHARTS STAY, THOUGH THE MOCKUP HAS NEITHER ──────────────────────
          The cache-hit band is the reason this page exists at all: cached input is billed
          at roughly a fiftieth of fresh input, and a sustained drop below the band does not
          mean "we are spending more" — it means somebody interpolated a variable into the
          classifier's constant prompt, which is silent, permanent, and invisible in every
          other view. A mockup that predates that measurement is not a reason to delete it.
        */}
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
      </div>
    </>
  )
}

function purposeLabel(purpose: string): string {
  switch (purpose) {
    case 'classify':
      return 'Judge — paid vs ordinary'
    case 'generate':
      return 'Generate — message body'
    case 'resolve':
      return 'Resolve — brand from caption'
    default:
      return purpose
  }
}

/**
 * What each purpose is FOR, in one sentence.
 *
 * These are statements about how the pipeline works, not about the figures beside them, so
 * they are constants rather than anything derived — the same reason `STOP_LABELS` on /rules
 * is a total map. A purpose added to the ledger without a sentence here falls through to
 * empty rather than to a wrong one.
 */
function purposeNote(purpose: string): string {
  switch (purpose) {
    case 'classify':
      return 'Every post from a watched channel is judged once, then cached.'
    case 'generate':
      return 'Exists in code but switched off — every send today uses the hand-written template.'
    case 'resolve':
      return 'Only runs when the caption disclosure needs a brand name pulled out.'
    default:
      return ''
  }
}
