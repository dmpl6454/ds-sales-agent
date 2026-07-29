import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { readStringArray } from '@/lib/json'
import { updateTarget } from '../../actions'
import { StatusPill, VerdictPill, When, Ago, Empty } from '../../ui'
import { AttemptActions } from './attempt-actions'

export const dynamic = 'force-dynamic'

/**
 * The "who, when, how many" page the brief asked for: every campaign detected on
 * this channel and every message ever queued to it, with exact send timestamps
 * and who tapped send.
 */
export default async function TargetDetail({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  const target = await prisma.targetAccount.findUnique({
    where: { handle },
    include: {
      pairs: { include: { sender: true }, orderBy: { sender: { handle: 'asc' } } },
      campaigns: { orderBy: [{ postedAt: 'desc' }], take: 60 },
    },
  })
  if (!target) notFound()

  const attempts = await prisma.outreachAttempt.findMany({
    where: { pair: { targetId: target.id } },
    include: { pair: { include: { sender: true } }, variant: true, campaign: true },
    orderBy: { queuedAt: 'desc' },
  })

  const campaignCount = target.campaigns.filter((c) => c.verdict === 'CAMPAIGN').length
  const sentCount = attempts.filter((a) => a.status === 'SENT').length
  const replied = attempts.find((a) => a.repliedAt !== null)

  return (
    <>
      <h1>@{target.handle}</h1>
      <p className="sub">
        {target.displayName} ·{' '}
        <a href={`https://instagram.com/${target.handle}`} target="_blank" rel="noreferrer">
          view on Instagram ↗
        </a>{' '}
        · detector <code>{target.detectorKey}</code>
      </p>

      {replied ? (
        <div className="banner good">
          <b>This target replied</b> <When at={replied.repliedAt} />. Every sender to this target is halted — the
          governor checks replies across the whole target, not per pair.
        </div>
      ) : null}

      {target.optedOut ? (
        <div className="banner bad">
          <b>Opted out.</b> No sender will ever contact this target again while this is set.
        </div>
      ) : null}

      <div className="grid c4">
        <div className="card stat">
          <div className="k">Campaigns detected</div>
          <div className="v">{campaignCount}</div>
          <div className="n">{target.campaigns.length} posts observed</div>
        </div>
        <div className="card stat">
          <div className="k">Messages sent</div>
          <div className="v">{sentCount}</div>
          <div className="n">{attempts.length} queued all time</div>
        </div>
        <div className="card stat">
          <div className="k">Senders routed</div>
          <div className="v">{target.pairs.length}</div>
          <div className="n">{target.pairs.map((p) => `@${p.sender.handle}`).join(', ')}</div>
        </div>
        <div className="card stat">
          <div className="k">Cooldown</div>
          <div className="v">{target.pairs[0]?.cooldownDays ?? '—'}d</div>
          <div className="n">per sender→target pair</div>
        </div>
      </div>

      <h2>Details</h2>
      <div className="card">
        <form action={updateTarget.bind(null, target.id)}>
          <div className="grid c2">
            <label className="field">
              <span>Display name</span>
              <input type="text" name="displayName" defaultValue={target.displayName} />
            </label>
            <label className="field">
              <span>Greeting first name — leave blank to address the publication</span>
              <input
                type="text"
                name="contactFirstName"
                defaultValue={target.contactFirstName ?? ''}
                placeholder="e.g. Sumeet"
              />
            </label>
          </div>
          <label className="btnrow" style={{ marginBottom: 12 }}>
            <input type="checkbox" name="optedOut" defaultChecked={target.optedOut} style={{ width: 'auto' }} />
            <span className="muted">Opted out — never contact again</span>
          </label>
          <button className="primary" type="submit">
            Save
          </button>
        </form>
      </div>

      <h2>Outreach history</h2>
      <div className="card pad0 scroll">
        {attempts.length === 0 ? (
          <Empty>No messages queued yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Touch</th>
                <th>Status</th>
                <th>Sent at (IST)</th>
                <th>By</th>
                <th>Variant</th>
                <th>Hook</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">
                    <Link href={`/senders/${a.pair.sender.handle}`}>@{a.pair.sender.handle}</Link>
                  </td>
                  <td className="num">{a.touchNumber}</td>
                  <td>
                    <StatusPill status={a.status} />
                  </td>
                  <td>
                    <When at={a.sentAt} />
                  </td>
                  <td className="nowrap dim">{a.sentBy ?? '—'}</td>
                  <td className="dim mono" style={{ fontSize: 11 }}>
                    {a.variant.label}
                  </td>
                  <td className="dim" style={{ fontSize: 11, maxWidth: 220 }}>
                    {a.campaign ? (
                      <a href={a.campaign.permalink} target="_blank" rel="noreferrer">
                        {a.campaign.shortcode} ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <AttemptActions attemptId={a.id} status={a.status} body={a.renderedBody} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Posts observed</h2>
      <div className="card pad0 scroll">
        {target.campaigns.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Post</th>
                <th>Posted</th>
                <th>Verdict</th>
                <th>Brands</th>
                <th>Caption</th>
              </tr>
            </thead>
            <tbody>
              {target.campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="nowrap">
                    <a href={c.permalink} target="_blank" rel="noreferrer" className="mono">
                      {c.shortcode} ↗
                    </a>
                  </td>
                  <td className="nowrap">
                    <Ago at={c.postedAt} />
                  </td>
                  <td>
                    <VerdictPill verdict={c.verdict} />
                  </td>
                  <td className="nowrap">
                    {readStringArray(c.brands).join(', ') || <span className="dim">—</span>}
                  </td>
                  <td className="dim" style={{ fontSize: 12, maxWidth: 460 }}>
                    {c.caption.slice(0, 180)}
                    {c.caption.length > 180 ? '…' : ''}
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
