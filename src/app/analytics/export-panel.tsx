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
      <h2>Export</h2>
      {/*
        ONE ROW, CONTENT-SIZED, NO CAPTIONS ABOVE THE CONTROLS — the mockup's own layout.
        The labels are still here for anyone using a screen reader; `.vh` hides them from
        sight without taking them out of the accessibility tree, the same treatment
        `channel-filter.tsx` already uses for its search box.
      */}
      <div className="card">
        <div className="exportform">
          <label>
            <span className="vh">Account</span>
            <select value={sender} onChange={(e) => setSender(e.target.value)}>
              <option value="">Every account</option>
              {senders.map((h) => (
                <option key={h} value={h}>
                  @{h}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="vh">From (IST day)</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="vh">To (IST day)</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className="vh">Rows</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="delivered">Delivered only</option>
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
