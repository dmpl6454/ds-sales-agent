'use client'

import { useState } from 'react'
import { addTarget } from '../actions'

/**
 * "Add targets" — the mockup's exact form (`_screen_isTargets.html`): one text field, a
 * role select, one Add button, one click. No preview step.
 *
 * Tabish's call (2026-09-23): match the mockup exactly rather than keep the two-step
 * check-then-commit flow `ImportForm` used. `addTarget` still validates each handle against
 * Instagram before writing anything — that is server-side correctness, not a UI preview, and
 * it is why a bad handle still cannot silently become a target. What is gone is the separate
 * "Check the list" click and the row-by-row preview before commit.
 *
 * `addTarget` takes one handle at a time, so a multi-line paste is split and each handle is
 * added in its own call; the mockup's placeholder promises "one per line" from a single-line
 * `<input>`, so the split also accepts commas and any whitespace.
 */
export function AddTargetsForm() {
  const [text, setText] = useState('')
  const [role, setRole] = useState<'WATCH' | 'PROSPECT'>('PROSPECT')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const submit = async () => {
    const handles = Array.from(new Set(text.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean)))
    if (handles.length === 0) return
    setBusy(true)
    setResult(null)
    let ok = 0
    const notes: string[] = []
    for (const handle of handles) {
      const r = await addTarget(handle, '', '', role)
      if (r.ok) ok++
      else notes.push(r.message)
    }
    setResult(
      handles.length === 1
        ? notes[0] ?? `@${handles[0]} added.`
        : `${ok} of ${handles.length} added.${notes.length > 0 ? ' ' + notes.join(' ') : ''}`,
    )
    if (ok > 0) setText('')
    setBusy(false)
  }

  return (
    <section>
      <h2>Add targets</h2>
      <div className="formbox">
        <div className="row addrow">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste handles, one per line"
            disabled={busy}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'WATCH' | 'PROSPECT')}
            disabled={busy}
          >
            <option value="WATCH">A page to watch for paid posts</option>
            <option value="PROSPECT">A company to message</option>
          </select>
          <button type="button" className="btn-primary" onClick={submit} disabled={busy || text.trim() === ''}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
      {result && <p className="account-message">{result}</p>}
    </section>
  )
}
