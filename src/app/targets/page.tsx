import Link from 'next/link'
import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { Ago, Empty } from '../ui'

export const dynamic = 'force-dynamic'

export default async function Targets() {
  const dayStart = istDayStart()
  const targets = await prisma.targetAccount.findMany({
    include: {
      campaigns: { where: { verdict: 'CAMPAIGN' }, select: { id: true } },
      pairs: {
        include: {
          sender: true,
          attempts: { where: { status: 'SENT' }, orderBy: { sentAt: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: { handle: 'asc' },
  })

  const sentTodayByTarget = new Map<string, number>()
  for (const t of targets) {
    const n = await prisma.outreachAttempt.count({
      where: { pair: { targetId: t.id }, status: 'SENT', sentAt: { gte: dayStart } },
    })
    sentTodayByTarget.set(t.id, n)
  }

  return (
    <>
      <h1>Targets</h1>
      <p className="sub">Accounts we send to. Phase 1 watches two publisher channels.</p>

      {targets.length === 0 ? (
        <div className="card">
          <Empty>No targets. Run `pnpm db:seed`.</Empty>
        </div>
      ) : (
        <div className="grid c2">
          {targets.map((t) => {
            const lastSent = t.pairs
              .flatMap((p) => p.attempts)
              .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0]
            return (
              <div key={t.id} className="card">
                <div className="btnrow" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <Link href={`/targets/${t.handle}`}>
                      <b>@{t.handle}</b>
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t.displayName}
                    </div>
                  </div>
                  <div className="btnrow">
                    {t.optedOut ? <span className="pill bad">OPTED OUT</span> : null}
                    <span className="pill">{t.detectorKey}</span>
                  </div>
                </div>

                <table style={{ marginTop: 12 }}>
                  <tbody>
                    <tr>
                      <td className="muted">Greeting name</td>
                      <td>
                        {t.contactFirstName ? (
                          <b>{t.contactFirstName}</b>
                        ) : (
                          <span className="pill warn">not set — addresses the publication</span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Campaigns detected</td>
                      <td className="num">{t.campaigns.length}</td>
                    </tr>
                    <tr>
                      <td className="muted">Sent today</td>
                      <td className="num">{sentTodayByTarget.get(t.id) ?? 0}</td>
                    </tr>
                    <tr>
                      <td className="muted">Last contacted</td>
                      <td>
                        <Ago at={lastSent?.sentAt} />
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Senders</td>
                      <td>{t.pairs.map((p) => `@${p.sender.handle}`).join(', ') || '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
