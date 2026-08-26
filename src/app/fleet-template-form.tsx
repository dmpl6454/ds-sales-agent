'use client'

import { useState, useTransition } from 'react'
import { setFleetTemplateBody } from './actions'

/**
 * A SECOND FLEET'S STANDARD MESSAGE — and the one screen that renders its ABSENCE.
 *
 * ── WHY THIS IS NOT JUST A SECOND `TemplateForm` ──────────────────────────
 *
 * Tabish, 2026-08-26: *"a separate template message would be sent for the marketing and
 * brand category … keep it empty for now."* Empty is therefore the state this component
 * spends most of its life in, and empty is not a blank textarea waiting to be filled — it
 * is a live refusal: `evaluatePair` writes no draft and `evaluateResend` sends none for a
 * fleet with no copy, by name.
 *
 * NOTHING ELSE ON THE DASHBOARD WOULD SHOW THAT. The queue renders drafts, and there are
 * none; the skip appears in a planner log nobody reads. *"Nothing renders an absence"* is
 * this project's most expensive recurring failure — 158 minutes of silent outage, 166
 * unread cover frames, `fleetUsage().today` computed on every render and thrown away — so
 * the count of companies currently waiting on this text is rendered ON the box that fixes
 * it, in the state where it is true.
 *
 * The default fleet's editor deliberately does NOT do this, because its box is never
 * empty: clearing it restores the shipped copy and sending continues. Two boxes that look
 * alike and mean opposite things by being empty is exactly why they are two components
 * rather than one with a flag.
 */
export function FleetTemplateForm({
  slug,
  name,
  initialBody,
  waitingCompanies,
  senderCount,
}: {
  slug: string
  name: string
  /** The saved copy, or '' when nobody has written it. Never a placeholder. */
  initialBody: string
  /** Live prospects in this fleet — the people who receive nothing while this is empty. */
  waitingCompanies: number
  /** Pages that send for this fleet. Zero means the copy is not the only thing missing. */
  senderCount: number
}) {
  const [body, setBody] = useState(initialBody)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, startSave] = useTransition()

  const written = initialBody.trim().length > 0

  return (
    <div className="card">
      <div className="row-between">
        <p style={{ margin: 0, fontWeight: 500 }}>The {name} message</p>
        <span className="eyebrow">{written ? 'written' : 'not written yet'}</span>
      </div>

      {written ? (
        <p className="settingrow-consequence">
          Every message to a {name} company is exactly this text — nothing is added, no greeting, no
          signature. Companies in the other fleet never receive it.
        </p>
      ) : (
        /**
         * The refusal, stated where it can be fixed. Both halves are facts rather than
         * warnings: how many companies are affected, and whether a page even exists to
         * write to them — because "no message written" and "no page connected" are
         * different problems and writing the copy fixes only one of them.
         */
        <p className="settingrow-argument">
          Nothing is sent to the {waitingCompanies} {name} {waitingCompanies === 1 ? 'company' : 'companies'} until
          this is written. They are never sent the other fleet’s message instead.
          {senderCount === 0
            ? ` No page sends for this fleet yet either, so writing this alone will not start anything.`
            : ''}
        </p>
      )}

      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          setOutcome(null)
        }}
        rows={6}
        placeholder={`Not written yet — nothing goes to ${name} companies until it is.`}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.95rem', lineHeight: 1.5 }}
        aria-label={`The ${name} message`}
      />

      <div className="row-between" style={{ marginTop: '0.5rem' }}>
        <button
          className="btn-primary"
          disabled={saving || body.trim() === initialBody.trim()}
          onClick={() => startSave(async () => setOutcome(await setFleetTemplateBody(slug, body)))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn-quiet"
          disabled={saving || !written}
          onClick={() => startSave(async () => setOutcome(await setFleetTemplateBody(slug, null)))}
        >
          Clear it
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
