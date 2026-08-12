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
export function StackedBars({
  series,
  buckets,
  caption,
  description,
  unit = '',
  labelEvery = 3,
  height = 200,
}: {
  series: Series[]
  buckets: Bucket[]
  caption: string
  description: string
  unit?: string
  labelEvery?: number
  height?: number
}) {
  if (buckets.length === 0) {
    return <p className="empty">Nothing has been recorded yet, so there is nothing to plot.</p>
  }

  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0))
  const peak = Math.max(...totals, 1)
  const top = niceCeiling(peak)

  const padL = 34
  const padB = 20
  const padT = 8
  const plot = height - padB - padT
  const step = 100 / buckets.length
  const barW = step * 0.62
  const scale = (v: number) => (v / top) * plot

  const ticks = [0, top / 2, top]

  return (
    <figure className="chartbox">
      <figcaption>
        <h3>{caption}</h3>
        <p className="page-sub">{description}</p>
      </figcaption>

      <svg
        className="chart"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. ${describeStack(series, buckets, unit)}`}
        style={{ height }}
      >
        <title>{caption}</title>
        <desc>{describeStack(series, buckets, unit)}</desc>

        {ticks.map((t) => (
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
          return series.map((s, si) => {
            const v = b.values[si] ?? 0
            const h = scale(v)
            const y = padT + plot - acc - h
            acc += h
            if (v === 0) return null
            return (
              <rect
                key={`${b.key}-${s.key}`}
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
        })}
      </svg>

      {/* The axis labels sit OUTSIDE the SVG. The chart stretches with
          `preserveAspectRatio="none"`, which would distort any text inside it — so the
          scale is drawn in HTML, where it stays the size it was designed at. */}
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

      <Legend series={series} />
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
  note,
  height = 150,
}: {
  points: Array<{ key: string; label: string; value: number | null }>
  bandLow: number
  bandHigh: number
  caption: string
  description: string
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
        <h3>{caption}</h3>
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
