import Link from 'next/link'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { istDayStart, istStamp, daysAgo, istDateKey } from '@/lib/time'
import { validatePersona } from '@/outreach/render'
import { Stat, StatusPill, VerdictPill, Ago, Empty } from './ui'
import { SyncButton } from './sync-button'
import { ReadyTray } from './ready-tray'

export const dynamic = 'force-dynamic'

/** Next scheduled slot in IST, derived from env.SLOTS. */
function nextSlot(): { slot: string; inMinutes: number } {
  const now = new Date()
  const dayStart = istDayStart(now)
  const mins = Math.floor((now.getTime() - dayStart.getTime()) / 60_000)
  const parsed = env.SLOTS.map((s) => {
    const [hh, mm] = s.split(':').map(Number)
    return { slot: s, minutes: hh! * 60 + mm! }
  }).sort((a, b) => a.minutes - b.minutes)

  const upcoming = parsed.find((p) => p.minutes > mins)
  if (upcoming) return { slot: upcoming.slot, inMinutes: upcoming.minutes - mins }
  // Wrapped to tomorrow.
  const first = parsed[0]!
  return { slot: first.slot, inMinutes: 1440 - mins + first.minutes }
}

export default async function Overview() {
  const settings = await getSettings()
  const dayStart = istDayStart()
  const next = nextSlot()

  const [lastRun, senders, todayCampaigns, sentToday, readyAttempts, reviewCount, weekRuns, totalCampaigns] =
    await Promise.all([
      prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      prisma.senderAccount.findMany({ orderBy: { handle: 'asc' } }),
      prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN', detectedAt: { gte: dayStart } } }),
      prisma.outreachAttempt.count({ where: { status: 'SENT', sentAt: { gte: dayStart } } }),
      prisma.outreachAttempt.findMany({
        where: { status: { in: ['READY', 'QUEUED'] } },
        include: { pair: { include: { sender: true, target: true } }, campaign: true, variant: true },
        orderBy: { queuedAt: 'asc' },
      }),
      prisma.detectedCampaign.count({ where: { verdict: 'REVIEW', humanLabel: null } }),
      prisma.scrapeRun.findMany({ where: { startedAt: { gte: daysAgo(7) } }, orderBy: { startedAt: 'asc' } }),
      prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN' } }),
    ])

  const personaProblems = senders.flatMap((s) => validatePersona(s).map((p) => ({ handle: s.handle, problem: p })))
  const challenged = senders.filter((s) => s.status === 'CHALLENGED')

  // Detections per day over the last 7 days, for the sparkline.
  const perDay = new Map<string, number>()
  for (const r of weekRuns) {
    const key = istDateKey(r.startedAt)
    perDay.set(key, (perDay.get(key) ?? 0) + r.detected)
  }
  const days = Array.from({ length: 7 }, (_, i) => istDateKey(daysAgo(6 - i)))
  const sparkValues = days.map((d) => perDay.get(d) ?? 0)
  const sparkMax = Math.max(1, ...sparkValues)

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        {istStamp()} IST · next slot <b>{next.slot}</b> in{' '}
        {next.inMinutes >= 60 ? `${Math.floor(next.inMinutes / 60)}h ${next.inMinutes % 60}m` : `${next.inMinutes}m`}
      </p>

      {env.DRY_RUN ? (
        <div className="banner warn">
          <b>DRY_RUN is on.</b> The pipeline runs fully — detects, classifies, plans outreach — but nothing is
          queued for sending and nothing is delivered. Use <code>pnpm preview</code> to read exactly what would go
          out. Set <code>DRY_RUN=0</code> in <code>.env</code> when you are ready.
        </div>
      ) : null}

      {personaProblems.length > 0 ? (
        <div className="banner bad">
          <b>Sending is blocked until the persona is valid.</b> These appear in every outgoing message, so the
          planner refuses to send rather than send them wrong:
          <ul>
            {personaProblems.map((p, i) => (
              <li key={i}>
                <code>@{p.handle}</code> — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {challenged.length > 0 ? (
        <div className="banner bad">
          <b>Instagram challenged {challenged.length} sender(s).</b> They are paused and will not be retried
          automatically — log in by hand, clear the checkpoint, then re-activate on{' '}
          <Link href="/senders">Senders</Link>: {challenged.map((s) => `@${s.handle}`).join(', ')}
        </div>
      ) : null}

      {lastRun?.status === 'PARTIAL' || lastRun?.status === 'FAILED' ? (
        <div className="banner warn">
          <b>Last run finished {lastRun.status}.</b> <span className="muted">{lastRun.error}</span>{' '}
          <Link href="/runs">See runs →</Link>
        </div>
      ) : null}

      <div className="grid c4">
        <Stat label="Campaigns today" value={todayCampaigns} note={`${totalCampaigns} all time`} />
        <Stat label="Sent today" value={sentToday} note={`cap ${settings.maxPerTargetPerDay}/target/day`} />
        <Stat label="Awaiting your tap" value={readyAttempts.length} note={env.DRY_RUN ? 'dry-run: none queued' : 'ready to send'} />
        <Stat label="Review queue" value={reviewCount} note="uncertain classifications" />
      </div>

      <h2>Ready to send</h2>
      <ReadyTray attempts={readyAttempts.map((a) => ({
        id: a.id,
        senderHandle: a.pair.sender.handle,
        senderDisplay: a.pair.sender.displayName,
        targetHandle: a.pair.target.handle,
        targetDisplay: a.pair.target.displayName,
        touchNumber: a.touchNumber,
        variantLabel: a.variant.label,
        hookLine: a.hookLine,
        body: a.renderedBody,
        campaignPermalink: a.campaign?.permalink ?? null,
        queuedAt: a.queuedAt.toISOString(),
      }))} />

      <h2>Detections, last 7 days</h2>
      <div className="card">
        <div className="spark">
          {sparkValues.map((v, i) => (
            <div key={i} style={{ height: `${Math.round((v / sparkMax) * 100)}%` }} title={`${days[i]}: ${v}`} />
          ))}
        </div>
        <div className="dim" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11 }}>
          <span>{days[0]}</span>
          <span>{days[6]} (today)</span>
        </div>
      </div>

      <h2>Routing matrix</h2>
      <div className="card pad0 scroll">
        <PairTable />
      </div>

      <h2>Last run</h2>
      <div className="card">
        {lastRun ? (
          <div className="btnrow" style={{ justifyContent: 'space-between' }}>
            <div>
              <StatusPill status={lastRun.status} /> <b>{lastRun.slot}</b>{' '}
              <span className="muted">
                · {lastRun.postsSeen} seen · {lastRun.newPosts} new · {lastRun.detected} campaigns ·{' '}
                {lastRun.sent} sent
              </span>{' '}
              <Ago at={lastRun.startedAt} />
            </div>
            <SyncButton />
          </div>
        ) : (
          <div className="btnrow" style={{ justifyContent: 'space-between' }}>
            <span className="dim">No runs yet.</span>
            <SyncButton />
          </div>
        )}
      </div>
    </>
  )
}

async function PairTable() {
  const pairs = await prisma.outreachPair.findMany({
    include: {
      sender: true,
      target: true,
      attempts: { where: { status: 'SENT' }, orderBy: { sentAt: 'desc' }, take: 1 },
    },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })

  if (pairs.length === 0) return <Empty>No routing pairs. Run `pnpm db:seed`.</Empty>

  return (
    <table>
      <thead>
        <tr>
          <th>From</th>
          <th>To</th>
          <th>Cooldown</th>
          <th>Last sent</th>
          <th>Touches</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map((p) => {
          const last = p.attempts[0]
          return (
            <tr key={p.id}>
              <td className="nowrap">
                <Link href={`/senders/${p.sender.handle}`}>@{p.sender.handle}</Link>
              </td>
              <td className="nowrap">
                <Link href={`/targets/${p.target.handle}`}>@{p.target.handle}</Link>
              </td>
              <td className="num">{p.cooldownDays}d</td>
              <td>
                <Ago at={last?.sentAt} />
              </td>
              <td className="num">{last?.touchNumber ?? 0}</td>
              <td>
                {p.target.optedOut ? (
                  <span className="pill bad">OPTED OUT</span>
                ) : p.enabled ? (
                  <span className="pill good">enabled</span>
                ) : (
                  <span className="pill">disabled</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
