import Link from 'next/link'
import { prisma } from '@/lib/db'
import { readStringArray } from '@/lib/json'
import { VerdictPill, Ago, Empty } from '../ui'
import { ReviewButtons } from './review-buttons'

export const dynamic = 'force-dynamic'

/**
 * Every post observed on a watched channel, with why it was classified the way
 * it was. The REVIEW queue sits on top because those are the only rows that need
 * a decision.
 */
export default async function Campaigns({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string; target?: string }>
}) {
  const sp = await searchParams
  const where = {
    ...(sp.verdict ? { verdict: sp.verdict } : {}),
    ...(sp.target ? { target: { handle: sp.target } } : {}),
  }

  const [posts, review, counts, targets] = await Promise.all([
    prisma.detectedCampaign.findMany({
      where,
      include: { target: true },
      orderBy: [{ postedAt: 'desc' }, { detectedAt: 'desc' }],
      take: 200,
    }),
    prisma.detectedCampaign.findMany({
      where: { verdict: 'REVIEW', humanLabel: null },
      include: { target: true },
      orderBy: { postedAt: 'desc' },
    }),
    prisma.detectedCampaign.groupBy({ by: ['verdict'], _count: { _all: true } }),
    prisma.targetAccount.findMany({ orderBy: { handle: 'asc' } }),
  ])

  const countOf = (v: string) => counts.find((c) => c.verdict === v)?._count._all ?? 0

  return (
    <>
      <h1>Campaigns</h1>
      <p className="sub">
        Every post seen on a watched channel, and the rules that fired. Detection informs the message — it never
        gates it.
      </p>

      <div className="btnrow" style={{ marginBottom: 16 }}>
        <Link className="btn" href="/campaigns" data-active={!sp.verdict}>
          All ({counts.reduce((n, c) => n + c._count._all, 0)})
        </Link>
        <Link className="btn" href="/campaigns?verdict=CAMPAIGN">
          Campaign ({countOf('CAMPAIGN')})
        </Link>
        <Link className="btn" href="/campaigns?verdict=REVIEW">
          Review ({countOf('REVIEW')})
        </Link>
        <Link className="btn" href="/campaigns?verdict=UNCLASSIFIED">
          Unclassified ({countOf('UNCLASSIFIED')})
        </Link>
        <Link className="btn" href="/campaigns?verdict=ORGANIC">
          Organic ({countOf('ORGANIC')})
        </Link>
        <span className="dim">|</span>
        {targets.map((t) => (
          <Link key={t.id} className="btn" href={`/campaigns?target=${t.handle}`}>
            @{t.handle}
          </Link>
        ))}
      </div>

      {countOf('UNCLASSIFIED') > 0 ? (
        <div className="banner info">
          <b>Unclassified is by design, not a failure.</b> @viralbhayani never discloses paid posts — no hashtag,
          flag, or label separates a paid film campaign from an organic paparazzi shot, only the meaning of the
          words. Rules here would produce confident nonsense, so every post is stored with its caption and left
          unclassified. That corpus is what a semantic classifier gets built and validated against in Phase 1.5.
        </div>
      ) : null}

      {review.length > 0 ? (
        <>
          <h2>Review queue — {review.length} needing a decision</h2>
          <div className="grid" style={{ gap: 10 }}>
            {review.map((r) => (
              <div key={r.id} className="card">
                <div className="btnrow" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div>
                    <a href={r.permalink} target="_blank" rel="noreferrer" className="mono">
                      {r.shortcode} ↗
                    </a>{' '}
                    <span className="muted">@{r.target.handle}</span> · conf {r.confidence}
                  </div>
                  <ReviewButtons campaignId={r.id} />
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.caption.slice(0, 400)}
                  {r.caption.length > 400 ? '…' : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2>All observed posts</h2>
      <div className="card pad0 scroll">
        {posts.length === 0 ? (
          <Empty>Nothing yet. Hit “Sync now” on the overview, or run `pnpm run:slot`.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Post</th>
                <th>Channel</th>
                <th>Posted</th>
                <th>Verdict</th>
                <th>Brands</th>
                <th>Signals</th>
                <th>Engagement</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td className="nowrap">
                    <a href={p.permalink} target="_blank" rel="noreferrer" className="mono">
                      {p.shortcode} ↗
                    </a>
                  </td>
                  <td className="nowrap">
                    <Link href={`/targets/${p.target.handle}`}>@{p.target.handle}</Link>
                  </td>
                  <td className="nowrap">
                    <Ago at={p.postedAt} />
                  </td>
                  <td>
                    <VerdictPill verdict={p.verdict} />
                    {p.humanLabel !== null ? <span className="pill warn">labelled</span> : null}
                  </td>
                  <td>
                    {readStringArray(p.brands).length > 0 ? (
                      readStringArray(p.brands).map((b) => (
                        <span key={b} className="pill good" style={{ marginRight: 4 }}>
                          {b}
                        </span>
                      ))
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="mono dim" style={{ fontSize: 11 }}>
                    {readStringArray(p.signals).join(', ') || '—'}
                  </td>
                  <td className="num nowrap dim">
                    {p.likeCount?.toLocaleString() ?? '—'} likes · {p.commentCount?.toLocaleString() ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
