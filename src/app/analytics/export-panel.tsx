'use client'

import { useState } from 'react'

/**
 * EXPORT SENT MESSAGES AS CSV (2026-08-18, Tabish's instruction). Filters build a URL for
 * `/api/export/messages`; the browser downloads the file with the session cookie it already
 * holds, so no state lives here beyond the filter values.
 */
export function ExportPanel({ senders }: { senders: string[] }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sender, setSender] = useState('')
  const [status, setStatus] = useState('delivered')

  const href = (() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (sender) p.set('sender', sender)
    if (status !== 'delivered') p.set('status', status)
    const qs = p.toString()
    return `/api/export/messages${qs ? `?${qs}` : ''}`
  })()

  return (
    <section>
      <h2>Export sent messages</h2>
      <div className="card">
        <div className="exportform">
          <label>
            <span>From (IST day)</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>To (IST day)</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span>Account</span>
            <select value={sender} onChange={(e) => setSender(e.target.value)}>
              <option value="">All accounts</option>
              {senders.map((h) => (
                <option key={h} value={h}>
                  @{h}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Rows</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="delivered">Delivered messages</option>
              <option value="replied">Replied only</option>
              <option value="all">Everything (drafts and failures too)</option>
            </select>
          </label>
          <a className="btn-primary" href={href} download>
            Download CSV
          </a>
        </div>
        <p className="cardnote">
          Columns: time (IST and UTC), sending account, recipient, status, how it was sent, message number, reply and
          thread link. Leave the dates blank for everything (up to 10,000 rows).
        </p>
      </div>
    </section>
  )
}
