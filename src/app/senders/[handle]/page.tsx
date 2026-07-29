import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { istDayStart, daysAgo } from '@/lib/time'
import { validatePersona, renderMessage } from '@/outreach/render'
import { updateSenderPersona } from '../../actions'
import { StatusPill, When, Ago, Empty } from '../../ui'
import { SenderToggles } from './toggles'

export const dynamic = 'force-dynamic'

export default async function SenderDetail({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  const sender = await prisma.senderAccount.findUnique({
    where: { handle },
    include: {
      pairs: { include: { target: true } },
      variants: { orderBy: [{ timesUsed: 'desc' }, { label: 'asc' }] },
    },
  })
  if (!sender) notFound()

  const [today, week, total, attempts] = await Promise.all([
    prisma.outreachAttempt.count({
      where: { pair: { senderId: sender.id }, status: 'SENT', sentAt: { gte: istDayStart() } },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { senderId: sender.id }, status: 'SENT', sentAt: { gte: daysAgo(7) } },
    }),
    prisma.outreachAttempt.count({ where: { pair: { senderId: sender.id }, status: 'SENT' } }),
    prisma.outreachAttempt.findMany({
      where: { pair: { senderId: sender.id } },
      include: { pair: { include: { target: true } }, variant: true },
      orderBy: { queuedAt: 'desc' },
      take: 40,
    }),
  ])

  const problems = validatePersona(sender)

  // Live sample so the persona can be checked as it will actually appear.
  const sampleTarget = sender.pairs[0]?.target
  const sample =
    sampleTarget && sender.variants[0]
      ? renderMessage({
          persona: sender,
          target: sampleTarget,
          variantBody: sender.variants[0].body,
          hook: null,
        }).body
      : null

  return (
    <>
      <h1>@{sender.handle}</h1>
      <p className="sub">
        {sender.displayName} · sends to {sender.pairs.map((p) => `@${p.target.handle}`).join(', ') || '—'}
      </p>

      {problems.length > 0 ? (
        <div className="banner bad">
          <b>Sending is blocked.</b> These values appear in every message this account sends:
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {sender.status === 'CHALLENGED' ? (
        <div className="banner bad">
          <b>Instagram challenged this account.</b> It was paused automatically and will not be retried — retrying
          into a checkpoint is how accounts get permanently banned. Log in by hand, clear the challenge, then set it
          back to Active.
        </div>
      ) : null}

      <div className="grid c4">
        <div className="card stat">
          <div className="k">Status</div>
          <div className="v" style={{ fontSize: 18, paddingTop: 6 }}>
            <StatusPill status={sender.status} />
          </div>
        </div>
        <div className="card stat">
          <div className="k">Sent today</div>
          <div className="v">
            {today}
            <span className="dim" style={{ fontSize: 16 }}>
              /{sender.dailyCap}
            </span>
          </div>
          <div className="n">daily cap</div>
        </div>
        <div className="card stat">
          <div className="k">Last 7 days</div>
          <div className="v">{week}</div>
          <div className="n">{total} all time</div>
        </div>
        <div className="card stat">
          <div className="k">Session</div>
          <div className="v" style={{ fontSize: 18, paddingTop: 6 }}>
            {sender.sessionPath ? <span className="pill good">saved</span> : <span className="pill">none</span>}
          </div>
          <div className="n">{sender.sessionSavedAt ? <When at={sender.sessionSavedAt} /> : 'pnpm session:add'}</div>
        </div>
      </div>

      <h2>Controls</h2>
      <div className="card">
        <SenderToggles
          senderId={sender.id}
          status={sender.status}
          autoSendEnabled={sender.autoSendEnabled}
          globalAutopilot={env.AUTOPILOT_ENABLED}
        />
      </div>

      <h2>Persona</h2>
      <div className="card">
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Reproduced verbatim in every message. Role and brand are separate because the opening line needs
          “Co-founder <b>of</b> Bollywood Society” while the signature needs “Co-founder, Bollywood Society”.
        </p>
        <form action={updateSenderPersona.bind(null, sender.id)}>
          <div className="grid c2">
            <label className="field">
              <span>Instagram handle</span>
              <input type="text" name="handle" defaultValue={sender.handle} />
            </label>
            <label className="field">
              <span>Display name</span>
              <input type="text" name="displayName" defaultValue={sender.displayName} />
            </label>
            <label className="field">
              <span>Persona name</span>
              <input type="text" name="personaName" defaultValue={sender.personaName} />
            </label>
            <label className="field">
              <span>Role</span>
              <input type="text" name="personaRole" defaultValue={sender.personaRole} />
            </label>
            <label className="field">
              <span>Brand</span>
              <input type="text" name="personaBrand" defaultValue={sender.personaBrand} />
            </label>
            <label className="field">
              <span>Phone — +91 then 10 digits starting 6-9</span>
              <input type="text" name="personaPhone" defaultValue={sender.personaPhone} />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="text" name="personaEmail" defaultValue={sender.personaEmail} />
            </label>
            <label className="field">
              <span>Daily cap</span>
              <input type="number" name="dailyCap" min={1} max={20} defaultValue={sender.dailyCap} />
            </label>
          </div>
          <button className="primary" type="submit">
            Save persona
          </button>
        </form>
      </div>

      {sample ? (
        <>
          <h2>Sample message</h2>
          <div className="card">
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              To @{sampleTarget!.handle}, variant <code>{sender.variants[0]!.label}</code>, no hook.
            </p>
            <pre className="msg">{sample}</pre>
          </div>
        </>
      ) : null}

      <h2>Variants — {sender.variants.length}</h2>
      <div className="card pad0 scroll">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Used</th>
              <th>Last used</th>
              <th>Opening</th>
            </tr>
          </thead>
          <tbody>
            {sender.variants.map((v) => (
              <tr key={v.id}>
                <td className="mono nowrap">{v.label}</td>
                <td className="num">{v.timesUsed}</td>
                <td>
                  <Ago at={v.lastUsedAt} />
                </td>
                <td className="dim" style={{ fontSize: 12, maxWidth: 560 }}>
                  {v.body.split('\n')[0]?.slice(0, 140)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent attempts</h2>
      <div className="card pad0 scroll">
        {attempts.length === 0 ? (
          <Empty>Nothing queued yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>To</th>
                <th>Touch</th>
                <th>Status</th>
                <th>Sent at (IST)</th>
                <th>By</th>
                <th>Variant</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">
                    <Link href={`/targets/${a.pair.target.handle}`}>@{a.pair.target.handle}</Link>
                  </td>
                  <td className="num">{a.touchNumber}</td>
                  <td>
                    <StatusPill status={a.status} />
                  </td>
                  <td>
                    <When at={a.sentAt} />
                  </td>
                  <td className="dim nowrap">{a.sentBy ?? '—'}</td>
                  <td className="dim mono" style={{ fontSize: 11 }}>
                    {a.variant.label}
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
