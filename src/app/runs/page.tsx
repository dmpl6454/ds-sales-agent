import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { readRecord } from '@/lib/json'
import { StatusPill, When, Empty } from '../ui'
import { SyncButton } from '../sync-button'

export const dynamic = 'force-dynamic'

interface ChannelDetail {
  handle?: string
  discovered?: number
  alreadyKnown?: number
  enriched?: number
  campaigns?: number
  unclassified?: number
  enrichFailures?: number
  error?: string
  parseFailure?: boolean
}

export default async function Runs() {
  const runs = await prisma.scrapeRun.findMany({ orderBy: { startedAt: 'desc' }, take: 80 })

  return (
    <>
      <h1>Runs</h1>
      <p className="sub">
        Every execution of the pipeline. Slots fire at {env.SLOTS.join(' / ')} {env.TZ}, plus catch-up on boot if one
        was missed.
      </p>

      <div className="banner info">
        <b>Reading a run.</b> <code>PARTIAL</code> means one stage had trouble but the pipeline continued —
        outreach is never blocked by a detection failure. The distinction that matters: <b>0 posts parsed</b> is an
        error worth chasing, while <b>30 parsed / 0 paid</b> is just a quiet day.
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="btnrow" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Run a slot now — takes about 15 seconds.</span>
          <SyncButton />
        </div>
      </div>

      <div className="card pad0 scroll">
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started (IST)</th>
                <th>Slot</th>
                <th>Status</th>
                <th>Seen</th>
                <th>New</th>
                <th>Campaigns</th>
                <th>Queued</th>
                <th>Sent</th>
                <th>Took</th>
                <th>Per channel</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const detail = readRecord(r.detail)
                const channels = Array.isArray(detail.channels) ? (detail.channels as ChannelDetail[]) : []
                const secs = r.finishedAt
                  ? ((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)
                  : null
                return (
                  <tr key={r.id}>
                    <td>
                      <When at={r.startedAt} />
                    </td>
                    <td className="mono nowrap">{r.slot}</td>
                    <td>
                      <StatusPill status={r.status} />
                      {r.error ? (
                        <div className="dim" style={{ fontSize: 11, maxWidth: 240 }}>
                          {r.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{r.postsSeen}</td>
                    <td className="num">{r.newPosts}</td>
                    <td className="num">{r.detected}</td>
                    <td className="num">{r.queued}</td>
                    <td className="num">{r.sent}</td>
                    <td className="num dim nowrap">{secs ? `${secs}s` : '—'}</td>
                    <td className="dim" style={{ fontSize: 11 }}>
                      {channels.length === 0
                        ? '—'
                        : channels.map((c, i) => (
                            <div key={i} className="nowrap">
                              @{c.handle}: {c.discovered ?? 0} seen, {c.enriched ?? 0} new, {c.campaigns ?? 0} paid
                              {c.parseFailure ? <span className="pill bad">parse fail</span> : null}
                              {c.error ? <span className="pill bad">error</span> : null}
                            </div>
                          ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
