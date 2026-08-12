import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildCostView } from '../view-model'
import { Nav } from '../nav'

export const dynamic = 'force-dynamic'

/**
 * `/cost` — what detection costs. Split out of Paid posts by the simple-sender redesign:
 * money is its own question, and the person asking it is not reading verdicts.
 */
export default async function CostPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const v = await buildCostView()

  return (
    <>
      <Nav current="/cost" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Cost</h1>
          <p className="page-sub">The only spending this system does: a model reads captions.</p>
        </header>

        <section className="group">
          <ul className="summary-row">
            <li>
              <strong>${v.spend.usd.toFixed(4)}</strong>
              <span>spent, lifetime</span>
            </li>
            <li>
              <strong>{v.spend.calls}</strong>
              <span>calls to the model</span>
            </li>
            <li className={v.spend.failed > 0 ? 'bad' : undefined}>
              <strong>{v.spend.failed}</strong>
              <span>failed — counted, and never recorded as a verdict</span>
            </li>
            <li>
              {/* Null when nothing has been sent: "no calls" and "the cache never hits" are
                  different facts, and a bare 0% would report the second. */}
              <strong>{v.spend.cachedShare === null ? '—' : `${Math.round(v.spend.cachedShare * 100)}%`}</strong>
              <span>of input served from cache</span>
            </li>
          </ul>
        </section>

        <section className="group">
          <h2>By kind of work</h2>
          <ul className="plain-list">
            {v.byPurpose.map((p) => (
              <li key={p.purpose}>
                {purposeLabel(p.purpose)} — {p.calls} calls, ${p.usd.toFixed(4)}
              </li>
            ))}
            {v.byPurpose.length === 0 ? <li className="muted">No calls made yet.</li> : null}
          </ul>
        </section>

        <section className="group">
          <h2>Classifying, by channel</h2>
          <ul className="plain-list">
            {v.perChannel.map((c) => (
              <li key={c.handle}>
                @{c.handle} — {c.calls} posts judged, ${c.usd.toFixed(4)}
              </li>
            ))}
            {v.perChannel.length === 0 ? <li className="muted">Nothing classified yet.</li> : null}
          </ul>
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
