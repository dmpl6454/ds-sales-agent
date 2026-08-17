'use client'

import { useState, useTransition } from 'react'
import { setSingleTemplateBody } from '../actions'

/**
 * The standard message's editor. One textarea, one Save, one Reset — and the refusal
 * comes back VERBATIM from `checkTemplateBody`, because the rule being enforced (a
 * too-short template refuses every send in the system) is exactly the kind a person
 * would otherwise discover hours later as a sending outage.
 *
 * `initialBody` is the EFFECTIVE middle — the saved override or the shipped copy — so
 * what the textarea shows is what a recipient would get, never a blank implying there
 * is no message.
 */
export function TemplateForm({ initialBody, edited }: { initialBody: string; edited: boolean }) {
  const [body, setBody] = useState(initialBody)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, startSave] = useTransition()

  return (
    <div className="card">
      <div className="row-between">
        <p style={{ margin: 0, fontWeight: 500 }}>The standard message</p>
        <span className="eyebrow">{edited ? 'edited' : 'shipped copy'}</span>
      </div>
      <p className="settingrow-consequence">
        Every first message is this text, with the greeting and your page&rsquo;s signature added
        automatically — the recipient&rsquo;s name and your page name are the only two things that
        vary. Messages already waiting keep the copy they were written with; if the old wording
        should not go out, discard them from the Autopilot page after saving.
      </p>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          setOutcome(null)
        }}
        rows={10}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.95rem', lineHeight: 1.5 }}
        aria-label="The standard message"
      />
      <div className="row-between" style={{ marginTop: '0.5rem' }}>
        <button
          className="btn-primary"
          disabled={saving || body.trim() === initialBody.trim()}
          onClick={() => startSave(async () => setOutcome(await setSingleTemplateBody(body)))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn-quiet"
          disabled={saving || !edited}
          onClick={() => startSave(async () => setOutcome(await setSingleTemplateBody(null)))}
        >
          Back to the shipped copy
        </button>
      </div>
      {outcome ? (
        <p className={outcome.ok ? 'settingrow-consequence' : 'settingrow-argument'} style={{ marginTop: '0.5rem' }}>
          {outcome.message}
        </p>
      ) : null}
    </div>
  )
}
