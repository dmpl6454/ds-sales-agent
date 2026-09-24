/**
 * CHARTS — hand-rolled, server-rendered SVG. No chart library, on purpose.
 *
 * Every page here is `force-dynamic`, so a client charting library would ship a bundle to
 * pages whose measured problem is time-to-first-byte, and then hydrate in order to draw
 * something that never changes after render. These components emit finished SVG in the
 * same pass as the rest of the page: zero client JavaScript, nothing to hydrate, and they
 * work inside `<Suspense>` like any other server output.
 *
 * ── RULES EVERY CHART IN THIS FILE FOLLOWS ──────────────────────────────────
 *
 * COLOUR COMES FROM TOKENS, never from a hex literal. `fill="var(--ac)"` resolves against
 * the live theme, so the same markup is correct in light and dark and after a toggle. A
 * hardcoded palette is how the old stylesheet ended up with 49 hex values and a theme
 * switch that only half worked.
 *
 * EVERY CHART CARRIES ITS NUMBERS IN TEXT. `<title>` and `<desc>` are not decoration —
 * a chart is the one element on a page whose content is invisible to a screen reader, to
 * a text search, and to anyone who cannot distinguish the two colours being compared. If
 * the sentence in `desc` cannot be written, the chart is not saying anything.
 *
 * "NO DATA YET" AND "NOTHING TO REPORT" ARE DIFFERENT FACTS. Every component takes an
 * explicit empty state and refuses to draw axes around nothing — an empty grid reads as a
 * measured zero, which is the same error as UNCLASSIFIED rendering as ORGANIC.
 */

export interface Series {
  key: string
  label: string
  /** A CSS token reference, e.g. `var(--ac)`. Never a hex literal. */
  color: string
  /**
   * Drawn as a dashed outline rather than a fill. Reserved for a series that is an
   * ABSENCE — "not judged" is not a quantity of anything, it is the part of the corpus
   * nobody has looked at, and giving it a solid fill puts it in the same visual class as
   * the verdicts it is explicitly not one of.
   */
  outline?: boolean
}

export interface Bucket {
  key: string
  /** Short axis label, e.g. "5 Aug". Only some are rendered; see `labelEvery`. */
  label: string
  /** One value per series, in the same order as `series`. */
  values: number[]
}

/**
 * A stacked column per bucket. Used for posts-per-day-by-verdict and for spend-by-purpose.
 *
 * The y-axis starts at zero and says so with a gridline. It is never truncated: a bar
 * chart with a clipped baseline exaggerates differences, which on a page about whether a
 * safety limit is being approached is not a stylistic choice.
 */
/**
 * WHEN THE SECTION'S OWN <h2> ALREADY SAYS IT.
 *
 * Every chart here states its subject in its own `figcaption`, which is right when the
 * chart IS the section. On the pages where the design puts an <h2> above the card —
 * usually because a control sits on the same line as it — that caption becomes a second
 * copy of the heading directly under it.
 *
 * `captionHidden` moves the <h3> out of SIGHT and leaves it everywhere else: it stays in
 * the accessibility tree, it stays the `aria-label` and the SVG `<title>`, and a screen
 * reader still meets a titled figure. It is NOT `display: none`, which would take the
 * figure's accessible name away and leave a chart announced as nothing at all.
 */
export function StackedBars({
  series,
  buckets,
  caption,
  description,
  captionHidden = false,
  unit = '',
  labelEvery = 3,
  height = 200,
  hideAxis = false,
  yAxisLabel,
  showSummary = false,
  showBucketTooltip = false,
  hideLegend = false,
}: {
  series: Series[]
  buckets: Bucket[]
  caption: string
  description: string
  captionHidden?: boolean
  unit?: string
  labelEvery?: number
  height?: number
  /**
   * MATCH THE MOCKUP'S "What detection found" EXACTLY: bars against a bare panel, a
   * legend underneath, and nothing else — no gridlines, no numeral scale, no date row.
   * The numbers and dates are not lost; they still ride in `aria-label`/`<desc>` and on
   * each bar's own `<title>`, so a screen reader and a hover both still get them. This
   * flag exists because `StackedBars` is also the cost page's "spend by purpose" chart,
   * which has no mockup counterpart and keeps its scale — the two must be able to differ.
   */
  hideAxis?: boolean
  /**
   * A short vertical title for the y-axis label column, e.g. "Detections" — set on the
   * detection chart alone (2026-09-24), never on the cost chart, which has no unit-of-
   * measure ambiguity a title would resolve. Rendered rotated inside its own slim column
   * so it costs almost no horizontal room; see `.chart-axis-title` in globals.css. Has no
   * effect under `hideAxis` — a title for an axis nobody draws is a caption for nothing.
   */
  yAxisLabel?: string
  /**
   * A compact "Total N · paid A · ordinary B · not judged C" row above the plot, summing
   * exactly the `buckets` already passed in — no second query, so it can never disagree
   * with what the bars themselves show for this window.
   */
  showSummary?: boolean
  /**
   * ONE combined tooltip per day instead of one per coloured segment. Per-segment
   * `<title>`s (below) already carry every number and are the accessible source of truth;
   * this adds a full-height, transparent hit target drawn ON TOP of each day's bars whose
   * single `<title>` reads the whole day at once — date, every series, and the total —
   * which is what a reader hovering a stacked column actually wants, rather than having to
   * find the exact pixel row of the segment they are curious about. The visible brighten-
   * on-hover still lands on the real bars underneath via `:has()` (see `.chart-bucket` in
   * globals.css), so covering them with an invisible rect does not mute that feedback.
   */
  showBucketTooltip?: boolean
  /**
   * `showSummary` already states every series' total, with the same swatches, right above
   * the plot — repeating that as a legend underneath it is the same fact a third time
   * (the bars themselves being the second), which is what a reader learns to stop reading.
   * Set on the detection chart alone; the cost chart has no summary row of its own, so its
   * legend is still the only place its colours are named.
   */
  hideLegend?: boolean
}) {
  if (buckets.length === 0) {
    return <p className="empty">Nothing has been recorded yet, so there is nothing to plot.</p>
  }

  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0))
  const peak = Math.max(...totals, 1)
  const top = niceCeiling(peak)

  /* Matches `.chartbox-ylabel`'s extra 16px column in globals.css: the x-axis label row
     spans the whole card, so it must skip the same gutter width the rotated title takes
     up, or every date would sit ~16px left of the bar it names. */
  const padL = yAxisLabel ? 34 + 16 : 34
  const padB = 20
  const padT = 8
  const plot = height - padB - padT
  const step = 100 / buckets.length
  /* 0.62 -> 0.7: a wider bar reads as more deliberate at a glance, and the gap it gives up
     was already generous — at 0.62 two neighbouring bars had nearly as much air between
     them as either bar's own width. */
  const barW = step * 0.7
  const scale = (v: number) => (v / top) * plot

  const ticks = [0, top / 2, top]

  /* Per-series lifetime-of-the-window totals, for the summary row. Reduced straight from
     `buckets` — the same array the bars are drawn from — so the row can never show a
     number the chart beside it disagrees with. */
  const seriesTotals = series.map((s, si) => buckets.reduce((a, b) => a + (b.values[si] ?? 0), 0))
  const grandTotal = seriesTotals.reduce((a, n) => a + n, 0)

  return (
    <figure className={yAxisLabel ? 'chartbox chartbox-ylabel' : 'chartbox'}>
      {/*
        THE CAPTION AND THE (OPTIONAL) SUMMARY ARE ONE GRID ITEM, NOT TWO.

        `.chart-axis-y` pins itself to row 2 (see globals.css) on the assumption that
        exactly one row of "header" content comes before the plot — true when the header
        was always a bare `<figcaption>`. `showSummary` adds a second header line, and grid
        auto-placement's cursor only ever moves FORWARD: once the summary row claims row 2,
        the axis's later, unrelated auto-search for "the next free row" does not backtrack
        into row 2 even though its own column there is still empty — it lands one row too
        low, off by exactly the summary's height. Wrapping both lines in one `<div>` keeps
        the header to a single grid row (row 1) regardless of whether the summary renders,
        so row 2 is always the plot's row and this pin never has to know how tall the
        header above it is.
      */}
      <div className="chartbox-head">
        <figcaption>
          <h3 className={captionHidden ? 'vh' : undefined}>{caption}</h3>
          <p className="page-sub">{description}</p>
        </figcaption>

        {showSummary && (
          <div className="chart-summary" role="group" aria-label={`Totals for ${description}`}>
            <span className="chart-summary-item chart-summary-total">
              <strong>{grandTotal.toLocaleString('en-GB')}</strong>
              {unit === '$' ? ' total $' : ' total'}
            </span>
            {series.map((s, si) => (
              <span className="chart-summary-item" key={s.key}>
                <span
                  className="chart-swatch"
                  style={s.outline ? { border: `1px dashed ${s.color}`, background: 'none' } : { background: s.color }}
                />
                {s.label}: <strong>{seriesTotals[si]!.toLocaleString('en-GB')}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      <svg
        /* `chart-full` under `hideAxis`: the grid's left column is the y-axis label
           gutter (34px), reserved by `grid-template-columns` whether or not anything
           is drawn there. With the axis hidden nothing ever occupies it, so without
           this the plot rendered ~46px narrower than the card for no reason visible
           on screen — the bars, and the reader's sense of how full the card is,
           both lost that width to a column with nothing in it. */
        className={hideAxis ? 'chart chart-full' : 'chart'}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. ${describeStack(series, buckets, unit)}`}
        style={{ height }}
      >
        <title>{caption}</title>
        <desc>{describeStack(series, buckets, unit)}</desc>

        {!hideAxis &&
          ticks.map((t) => (
            <line
              key={t}
              className="chart-grid"
              x1={0}
              x2={100}
              y1={padT + plot - scale(t)}
              y2={padT + plot - scale(t)}
              vectorEffect="non-scaling-stroke"
            />
          ))}

        {buckets.map((b, i) => {
          let acc = 0
          const segments = series.map((s, si) => {
            const v = b.values[si] ?? 0
            const h = scale(v)
            const y = padT + plot - acc - h
            acc += h
            if (v === 0) return null
            return (
              <rect
                key={`${b.key}-${s.key}`}
                /* Hover/focus feedback only — see `.chart-bar` in globals.css. The `<title>`
                   below is the real tooltip content (every value already rides in it and in
                   `aria-label`/`<desc>`, per this file's own rule); the CSS just gives the
                   segment a visible reaction so a reader discovers it is inspectable at all. */
                className="chart-bar"
                x={i * step + (step - barW) / 2}
                y={y}
                width={barW}
                height={h}
                fill={s.outline ? 'none' : s.color}
                stroke={s.outline ? s.color : 'none'}
                strokeDasharray={s.outline ? '2 2' : undefined}
                vectorEffect={s.outline ? 'non-scaling-stroke' : undefined}
              >
                <title>{`${b.label} · ${s.label}: ${v}${unit}`}</title>
              </rect>
            )
          })

          if (!showBucketTooltip) return segments

          const dayTotal = b.values.reduce((a, v) => a + (v ?? 0), 0)
          const perSeries = series.map((s, si) => `${s.label} ${b.values[si] ?? 0}${unit}`).join(', ')
          return (
            <g className="chart-bucket" key={b.key}>
              {segments}
              {/* Spans the whole DAY (not just the bar) and the full plot height, so the
                  combined tooltip fires from the gap either side of the bar too — a reader
                  should not have to land on a 0.7-fraction-wide column to get the date. */}
              <rect
                className="chart-hit"
                x={i * step}
                y={padT}
                width={step}
                height={plot}
                fill="transparent"
              >
                <title>{`${b.label} — ${perSeries} · total ${dayTotal}${unit}`}</title>
              </rect>
            </g>
          )
        })}
      </svg>

      {/* The axis labels sit OUTSIDE the SVG. The chart stretches with
          `preserveAspectRatio="none"`, which would distort any text inside it — so the
          scale is drawn in HTML, where it stays the size it was designed at.

          Skipped entirely under `hideAxis` — the numbers are not lost, they are still in
          `aria-label`, `<desc>` and each bar's own `<title>` above; this only removes what
          a sighted reader sees, to match the mockup's bare-panel-plus-legend drawing. */}
      {!hideAxis && (
        <>
          {yAxisLabel && (
            <span className="chart-axis-title" aria-hidden="true" style={{ height }}>
              {yAxisLabel}
            </span>
          )}
          <div className="chart-axis-y" aria-hidden="true" style={{ height }}>
            {[...ticks].reverse().map((t) => (
              <span key={t}>{formatTick(t, unit)}</span>
            ))}
          </div>
          <div className="chart-axis-x" aria-hidden="true" style={{ paddingLeft: padL }}>
            {buckets.map((b, i) => (
              <span key={b.key}>{i % labelEvery === 0 ? b.label : ''}</span>
            ))}
          </div>
        </>
      )}

      {!hideLegend && <Legend series={series} />}
    </figure>
  )
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span className="chart-key" key={s.key}>
          <span
            className="chart-swatch"
            style={
              s.outline
                ? { border: `1px dashed ${s.color}`, background: 'none' }
                : { background: s.color }
            }
          />
          {s.label}
        </span>
      ))}
    </div>
  )
}

export type RunOutcome = 'ok' | 'partial' | 'failed'

/**
 * ONE CELL PER RUN, in order, oldest first.
 *
 * A health signal read from ONE sample cannot show a trend. The old dashboard looked only
 * at the newest `ScrapeRun`, so eight failing slots out of twelve across two days read
 * exactly like one unlucky fetch — and on the next success it read like nothing had ever
 * been wrong. The strip is the fix, and it is a strip rather than a number because the
 * shape of the failures (a run of them, or one here and there) is the whole diagnosis.
 */
export function RunStrip({
  runs,
  caption,
  description,
}: {
  runs: Array<{ key: string; outcome: RunOutcome; title: string }>
  caption: string
  description: string
}) {
  if (runs.length === 0) {
    return (
      <figure className="chartbox">
        <figcaption>
          <h3>{caption}</h3>
        </figcaption>
        <p className="empty">No runs recorded in this window.</p>
      </figure>
    )
  }

  const ok = runs.filter((r) => r.outcome === 'ok').length
  const partial = runs.filter((r) => r.outcome === 'partial').length
  const failed = runs.filter((r) => r.outcome === 'failed').length

  return (
    <figure className="chartbox">
      <figcaption>
        <h3>{caption}</h3>
        <p className="page-sub">{description}</p>
      </figcaption>

      <div
        className="runstrip"
        role="img"
        aria-label={`${runs.length} runs: ${ok} completed, ${partial} partial, ${failed} failed.`}
      >
        {runs.map((r) => (
          <span key={r.key} className={`runcell run-${r.outcome}`} title={r.title} />
        ))}
      </div>

      {/*
        The counts in text beneath, because the strip answers "what shape" and a person
        also needs "how many" — and because a colour-blind reader gets nothing from the
        strip alone. PARTIAL is named rather than folded into either neighbour: a run that
        read some channels and not others is not a success and is not an outage.
      */}
      <p className="blurb">
        {ok} completed · {partial} partial · {failed} failed, over the last {runs.length} runs.
      </p>
    </figure>
  )
}

/**
 * A funnel where every step names WHAT IT LOST and why.
 *
 * The drop-off sentence is the point of the chart, not a caption on it. On this system the
 * interesting number is almost never how many were sent — it is which guard held the rest,
 * because that is the thing an operator can act on.
 */
export function Funnel({
  steps,
  caption,
  description,
}: {
  steps: Array<{ key: string; label: string; n: number; drop: string | null }>
  caption: string
  description: string
}) {
  const top = Math.max(...steps.map((s) => s.n), 1)

  return (
    <figure className="chartbox">
      <figcaption>
        <h3>{caption}</h3>
        <p className="page-sub">{description}</p>
      </figcaption>

      <div className="stack">
        {steps.map((s) => (
          <div key={s.key}>
            <div className="row-between">
              <span>{s.label}</span>
              <span className="muted n">{s.n}</span>
            </div>
            <div className="funnel-track">
              <span className="funnel-bar" style={{ width: `${(s.n / top) * 100}%` }} />
            </div>
            {/* `null` means "nothing was lost here", which is a different fact from "we do
                not know what was lost" — so it renders nothing rather than an em dash. */}
            {s.drop ? <p className="blurb" style={{ margin: '4px 0 0' }}>{s.drop}</p> : null}
          </div>
        ))}
      </div>
    </figure>
  )
}

/**
 * THE WATCH WINDOW — the most important picture in this product.
 *
 * The anonymous feed is a WINDOW, not an archive: it is `feedDepth` posts deep, the channel
 * posts `postsPerDay`, so the readable corpus survives roughly `survivalHours` and a post
 * that scrolls out of it can never be re-scraped by anyone, ever. No endpoint hands it back.
 *
 * So downtime has a boundary in it. Under `survivalHours` a gap is RECOVERABLE — one pass
 * gets everything back. Past it, posts are gone for good. Those two facts are the same
 * colour on a bare uptime chart and they are not the same thing at all, which is why this
 * draws the boundary explicitly instead of plotting availability.
 *
 * The copy says "this is not about sending" because the previous wording lived in the
 * autopilot card and ended "whatever this toggle says" — so with autopilot correctly off,
 * the most serious alarm in the system read as irrelevant.
 */
export function WatchWindow({
  survivalHours,
  downtimeHours,
  postsLost,
  feedDepth,
  postsPerDay,
  severity,
  neverRun,
}: {
  survivalHours: number
  /** Hours since the watch last ran. 0 when it is running now. */
  downtimeHours: number
  /** How many posts are already unrecoverable. 0 when nothing has been lost. */
  postsLost: number
  feedDepth: number
  postsPerDay: number
  severity: 'ok' | 'at-risk' | 'losing-posts'
  /** No watch has ever run, so loss is UNCOUNTED rather than zero. */
  neverRun: boolean
}) {
  /**
   * The tone comes from `assessWatch`'s severity, NOT from the numbers.
   *
   * Deriving it here from `postsLost > 0` would read the never-run case — where the count
   * is 0 because nothing was counted — as healthy, and paint the most serious state in the
   * system green. The pure function already made this judgement; a screen that re-makes it
   * is a screen that can disagree with it.
   */
  const tone = severity === 'losing-posts' ? 'bad' : severity === 'at-risk' ? 'warn' : 'good'

  // The bar spans two survival windows, so a gap at the boundary is visible either side.
  const span = Math.max(survivalHours * 2, downtimeHours * 1.2, 1)
  const pct = (h: number) => `${Math.min(100, (h / span) * 100)}%`

  /**
   * Four sentences for four states, and the never-run one is not a variant of the others.
   * "0 posts lost" would be a claim; "we cannot say" is the fact.
   */
  const summary = neverRun
    ? `No watch has ever run on this machine, so nothing has been read and no estimate of what was missed is possible.`
    : severity === 'losing-posts'
      ? `The watch has been down ${round(downtimeHours)} hours, past the ${survivalHours}-hour window. An estimated ${postsLost} posts have scrolled out of the feed and cannot be fetched again by anyone.`
      : severity === 'at-risk'
        ? `The watch has been down ${round(downtimeHours)} hours. That is still inside the ${survivalHours}-hour window, so one pass recovers everything — but only until the window closes.`
        : `The watch is running. The readable corpus survives about ${survivalHours} hours.`

  return (
    <figure className="chartbox">
      <figcaption>
        <h3>Watch health — the {survivalHours}-hour window</h3>
        <p className="page-sub">
          Posts scroll out of the anonymous feed after about {survivalHours} hours and cannot be
          fetched again. <strong>This is not about sending.</strong>
        </p>
      </figcaption>

      <div className="watchbar" role="img" aria-label={summary}>
        <span className="watch-track" />
        <span className={`watch-window watch-${tone}`} style={{ width: pct(survivalHours) }} />
        {downtimeHours > 0 && (
          <span
            className={`watch-gap watch-gap-${tone}`}
            style={{ width: pct(downtimeHours) }}
            title={summary}
          />
        )}
      </div>

      <div className="watch-scale" aria-hidden="true">
        <span>now</span>
        <span>{survivalHours}h — the edge of the corpus</span>
      </div>

      <p className={`reason reason-${tone}`}>{summary}</p>

      <p className="blurb">
        Measured, not chosen: the feed is {feedDepth} posts deep and the channel posts about{' '}
        {postsPerDay} a day.
      </p>
    </figure>
  )
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** A round number at or above the peak, so the top gridline is readable. */
function niceCeiling(peak: number): number {
  if (peak <= 5) return 5
  const mag = 10 ** Math.floor(Math.log10(peak))
  return Math.ceil(peak / (mag / 2)) * (mag / 2)
}

function formatTick(t: number, unit: string): string {
  const n = t >= 100 ? Math.round(t) : Math.round(t * 100) / 100
  return unit === '$' ? `$${n}` : String(n)
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * The chart's content, as a sentence. This is what a screen reader gets, and it is also
 * the honesty check on the chart itself: a total per series and the range covered.
 */
function describeStack(series: Series[], buckets: Bucket[], unit: string): string {
  const totals = series.map((s, si) => {
    const sum = buckets.reduce((a, b) => a + (b.values[si] ?? 0), 0)
    return `${s.label} ${unit === '$' ? '$' : ''}${Math.round(sum * 100) / 100}`
  })
  const first = buckets[0]?.label ?? ''
  const last = buckets[buckets.length - 1]?.label ?? ''
  return `${first} to ${last}. Totals: ${totals.join(', ')}.`
}

/**
 * A LINE AGAINST AN EXPECTED BAND.
 *
 * The band is the point: a value is not "high" or "low" in the abstract, it is inside or
 * outside the range this system has been measured to sit in. Drawing the expectation makes
 * a six-day drift legible as a drift rather than as fourteen unremarkable numbers.
 *
 * Gaps are GAPS. A `null` day breaks the line instead of dropping it to zero — a day with
 * no calls is not a day the cache missed everything, and joining across it would draw a
 * cliff that never happened.
 */
export function BandedLine({
  points,
  bandLow,
  bandHigh,
  caption,
  description,
  captionHidden = false,
  note,
  height = 150,
}: {
  points: Array<{ key: string; label: string; value: number | null }>
  bandLow: number
  bandHigh: number
  caption: string
  description: string
  /** See the note on StackedBars: the section's own heading already says it. */
  captionHidden?: boolean
  note?: { text: string; tone: 'good' | 'warn' | 'bad' } | null
  height?: number
}) {
  const real = points.filter((p) => p.value !== null) as Array<{ key: string; label: string; value: number }>
  if (real.length === 0) {
    return (
      <figure className="chartbox">
        <figcaption>
          <h3>{caption}</h3>
          <p className="page-sub">{description}</p>
        </figcaption>
        <p className="empty">No calls have been made in this window, so there is no rate to plot.</p>
      </figure>
    )
  }

  const lo = Math.min(...real.map((p) => p.value), bandLow) - 0.02
  const hi = Math.max(...real.map((p) => p.value), bandHigh) + 0.01
  const y = (v: number) => ((hi - v) / (hi - lo)) * height
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * 100

  /* One polyline per unbroken run, so a gap stays a gap. */
  const runs: string[] = []
  let current: string[] = []
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 1) runs.push(current.join(' '))
      current = []
      return
    }
    current.push(`${x(i)},${y(p.value)}`)
  })
  if (current.length > 1) runs.push(current.join(' '))

  const pct = (v: number) => `${Math.round(v * 100)}%`

  return (
    <figure className="chartbox">
      <figcaption>
        <h3 className={captionHidden ? 'vh' : undefined}>{caption}</h3>
        <p className="page-sub">{description}</p>
      </figcaption>

      <svg
        className="chart"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. ${description} Latest ${pct(real[real.length - 1]!.value)}, expected between ${pct(bandLow)} and ${pct(bandHigh)}.`}
        style={{ height }}
      >
        <title>{caption}</title>
        <desc>{`Ranges from ${pct(Math.min(...real.map((p) => p.value)))} to ${pct(Math.max(...real.map((p) => p.value)))}. The shaded band is the expected ${pct(bandLow)} to ${pct(bandHigh)}.`}</desc>

        <rect x={0} y={y(bandHigh)} width={100} height={Math.max(0, y(bandLow) - y(bandHigh))} fill="var(--good-sub)" />
        {runs.map((pts, i) => (
          <polyline
            key={i}
            points={pts}
            fill="none"
            stroke="var(--ac)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="chart-axis-y" aria-hidden="true" style={{ height }}>
        <span>{pct(hi)}</span>
        <span>{pct(lo)}</span>
      </div>
      <div className="chart-axis-x" aria-hidden="true">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>

      {note ? <p className={`blurb note-${note.tone}`}>{note.text}</p> : null}
    </figure>
  )
}

/**
 * MESSAGES SENT, LAST 14 DAYS — an area chart, which is what the design asks for here.
 *
 * ── WHY THIS ONE IS AN AREA AND THE OTHERS ARE NOT ──────────────────────────
 *
 * Every other chart on this page reports a COMPOSITION (what a day's posts were judged to
 * be, where the funnel lost people) and a filled area under a single line would invite the
 * reader to add two series that must not be added. This one is a single quantity over
 * time, so the fill carries no claim beyond the line itself — it is emphasis, not a second
 * number.
 *
 * The gradient is defined with a document-unique id. Two of these on one page sharing
 * `url(#trendFill)` would silently take the first one's stops, which renders correctly
 * until the day somebody adds a second trend and then looks like a colour bug.
 *
 * A DAY WITH NOTHING SENT IS A ZERO, NOT A GAP. `BandedLine` above breaks its line at a
 * null because "no calls were made, so there is no rate" is genuinely unmeasurable; a day
 * on which nothing was delivered is a measured zero and drawing it as a hole would hide
 * exactly the outage this chart exists to show.
 */
export function SendsTrend({
  points,
  peak,
  total,
  caption,
  description,
  captionHidden = false,
  height = 100,
}: {
  points: Array<{ key: string; label: string; n: number }>
  peak: number
  total: number
  caption: string
  description: string
  /** See the note on StackedBars: the section's own heading already says it. */
  captionHidden?: boolean
  height?: number
}) {
  /* A SERVER component, so there is no `useId` to reach for — the slug comes from the
     caption, which is what actually distinguishes two of these on one page. */
  const id = caption.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sends'
  if (points.length === 0 || total === 0) {
    return (
      <figure className="chartbox">
        <figcaption>
          <h3>{caption}</h3>
          <p className="page-sub">{description}</p>
        </figcaption>
        <p className="empty">Nothing has been delivered in the last {points.length} days, so there is no trend to plot.</p>
      </figure>
    )
  }

  const w = Math.max(1, points.length - 1)
  /* The scale is the window's own busiest day, never a constant: a fixed ceiling makes a
     quiet fortnight read as a flat line at the floor and a busy one clip. */
  const top = Math.max(1, peak)
  const x = (i: number) => (i / w) * 100
  const y = (n: number) => height - (n / top) * height

  const line = points.map((p, i) => `${round(x(i))},${round(y(p.n))}`).join(' ')
  const area = `M 0,${height} L ${points.map((p, i) => `${round(x(i))},${round(y(p.n))}`).join(' L ')} L 100,${height} Z`

  const busiest = points.reduce((a, b) => (b.n > a.n ? b : a))

  return (
    <figure className="chartbox">
      <figcaption>
        <h3 className={captionHidden ? 'vh' : undefined}>{caption}</h3>
        <p className="page-sub">{description}</p>
      </figcaption>

      <svg
        className="chart"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. ${total} delivered over ${points.length} days, busiest ${busiest.label} with ${busiest.n}.`}
        style={{ height }}
      >
        <title>{caption}</title>
        <desc>{`${total} messages delivered across ${points.length} days. The busiest was ${busiest.label} with ${busiest.n}.`}</desc>
        <defs>
          <linearGradient id={`trend-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ac)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--ac)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#trend-${id})`} />
        <polyline
          points={line}
          fill="none"
          stroke="var(--ac)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="chart-axis-x" aria-hidden="true">
        <span>{points[0]?.label}</span>
        <span>today</span>
      </div>
    </figure>
  )
}
