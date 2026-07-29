import Link from 'next/link'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { istDayStart, daysAgo } from '@/lib/time'
import { validatePersona } from '@/outreach/render'
import { IG_LIMITS } from '@/lib/constants'
import { StatusPill, Ago, Empty } from '../ui'

export const dynamic = 'force-dynamic'

export default async function Senders() {
  const dayStart = istDayStart()
  const senders = await prisma.senderAccount.findMany({
    include: { pairs: { include: { target: true } } },
    orderBy: { handle: 'asc' },
  })

  const rows = await Promise.all(
    senders.map(async (s) => {
      const [today, week, total, last] = await Promise.all([
        prisma.outreachAttempt.count({
          where: { pair: { senderId: s.id }, status: 'SENT', sentAt: { gte: dayStart } },
        }),
        prisma.outreachAttempt.count({
          where: { pair: { senderId: s.id }, status: 'SENT', sentAt: { gte: daysAgo(7) } },
        }),
        prisma.outreachAttempt.count({ where: { pair: { senderId: s.id }, status: 'SENT' } }),
        prisma.outreachAttempt.findFirst({
          where: { pair: { senderId: s.id }, status: 'SENT' },
          orderBy: { sentAt: 'desc' },
        }),
      ])
      return { sender: s, today, week, total, last, problems: validatePersona(s) }
    }),
  )

  const weekTotal = rows.reduce((n, r) => n + r.week, 0)
  const capacity = senders.length * IG_LIMITS.safeColdDmsPerAccountPerDay

  return (
    <>
      <h1>Senders</h1>
      <p className="sub">Accounts we own and send from. Credentials are never stored — only Playwright sessions.</p>

      <div className="banner info">
        <b>Headroom.</b> {senders.length} senders × ~{IG_LIMITS.safeColdDmsPerAccountPerDay} safe cold DMs/day ≈{' '}
        <b>{capacity}/day</b> of capacity. Last 7 days used <b>{weekTotal}</b>. Instagram&apos;s limit is not the
        constraint here — the size of the target list is.
      </div>

      {senders.length === 0 ? (
        <div className="card">
          <Empty>No senders. Run `pnpm db:seed`.</Empty>
        </div>
      ) : (
        <div className="card pad0 scroll">
          <table>
            <thead>
              <tr>
                <th>Handle</th>
                <th>Status</th>
                <th>Autopilot</th>
                <th>Session</th>
                <th>Today</th>
                <th>7d</th>
                <th>Total</th>
                <th>Last sent</th>
                <th>Targets</th>
                <th>Persona</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ sender: s, today, week, total, last, problems }) => (
                <tr key={s.id}>
                  <td className="nowrap">
                    <Link href={`/senders/${s.handle}`}>
                      <b>@{s.handle}</b>
                    </Link>
                    <div className="dim" style={{ fontSize: 11 }}>
                      {s.displayName}
                    </div>
                  </td>
                  <td>
                    <StatusPill status={s.status} />
                  </td>
                  <td>
                    {s.autoSendEnabled ? (
                      env.AUTOPILOT_ENABLED ? (
                        <span className="pill good">on</span>
                      ) : (
                        <span className="pill warn">on (env off)</span>
                      )
                    ) : (
                      <span className="pill">manual</span>
                    )}
                  </td>
                  <td>
                    {s.sessionPath ? (
                      <span className="pill good">saved</span>
                    ) : (
                      <span className="pill" title={`pnpm session:add --sender=${s.handle}`}>
                        none
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {today}
                    <span className="dim"> / {s.dailyCap}</span>
                  </td>
                  <td className="num">{week}</td>
                  <td className="num">{total}</td>
                  <td>
                    <Ago at={last?.sentAt} />
                  </td>
                  <td className="dim" style={{ fontSize: 12 }}>
                    {s.pairs.map((p) => `@${p.target.handle}`).join(', ') || '—'}
                  </td>
                  <td>
                    {problems.length === 0 ? (
                      <span className="pill good">valid</span>
                    ) : (
                      <span className="pill bad" title={problems.join('; ')}>
                        {problems.length} problem{problems.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
