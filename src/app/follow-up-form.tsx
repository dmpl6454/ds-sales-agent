'use client'

import { useState, useTransition } from 'react'
import { setFollowUpBody } from './actions'

/**
 * THE SECOND MESSAGE — and the screen that renders its ABSENCE.
 *
 * ── WHY THIS IS A THIRD COMPONENT AND NOT A FLAG ON THE OTHER TWO ─────────
 *
 * The Autopilot page now carries up to three message boxes, and each one means something
 * DIFFERENT by being empty. That is exactly why `FleetTemplateForm` was split off from
 * `TemplateForm` on 2026-08-26, and the argument holds a third time:
 *
 *   the standard message  clearing restores the shipped copy. Sending continues.
 *   a second fleet's copy clearing means nobody wrote it; that fleet is refused.
 *   THIS ONE             clearing means no page ever writes a SECOND message to anyone.
 *                        Every first touch is untouched.
 *
 * Two boxes that look alike and mean opposite things by being empty is how somebody clears
 * the wrong one.
 *
 * ── AND EMPTY IS THE STATE IT SHIPS IN, SO EMPTY HAS TO SAY SOMETHING ─────
 *
 * With nothing written the planner drafts no follow-ups, so the queue shows none, and the
 * only trace is a skip reason in a log. *"Nothing renders an absence"* is this project's
 * most expensive recurring failure — a 158-minute silent outage, 166 unread cover frames, a
 * correct `fleetUsage().today` that reached no screen — so the number of companies currently
 * waiting on this text is rendered ON the box that fixes it.
 *
 * The empty state states the MEASURED reason there is no fallback, because the obvious
 * "just send the first message again" is the thing Instagram silently drops.
 */
export function FollowUpForm({
  slug,
  name,
  initialBody,
  waitingPairs,
}: {
  /** Null for the DEFAULT fleet, whose row is the bare `followUpBody` key. */
  slug: string | null
  /** How this fleet is named on screen. "" when there is only one fleet and it needs no name. */
  name: string
  /** The saved copy, or '' when nobody has written it. Never a placeholder. */
  initialBody: string
  /**
   * Pairs that have already written once and are holding for want of a second message —
   * the planner's own `no-follow-up-message-written` count, so this number is what would
   * actually be released rather than an estimate.
   */
  waitingPairs: number
}) {
  const [body, setBody] = useState(initialBody)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, startSave] = useTransition()

  const written = initialBody.trim().length > 0
  const title = name ? `The ${name} follow-up message` : 'The follow-up message'

  return (
    <div className="card">
      <div className="row-between">
        <p style={{ margin: 0, fontWeight: 500 }}>{title}</p>
        <span className="eyebrow">{written ? 'written' : 'not written yet'}</span>
      </div>

      {written ? (
        <p className="settingrow-consequence">
          Sent only to a company this page has already written to, and only when a paid post naming
          them has not been written about yet. <code>{'{{post}}'}</code> becomes that post — for
          example <em>your placement with @viralbhayani on 29 Aug</em>. Volume does not change: the
          allowance still permits one message per paid post.
        </p>
      ) : (
        /**
         * The refusal, stated where it can be fixed, with the measured reason there is no
         * fallback. Both halves are facts rather than warnings.
         */
        <p className="settingrow-argument">
          No second message is written, so no page writes to a company twice.{' '}
          {waitingPairs > 0
            ? `${waitingPairs} ${waitingPairs === 1 ? 'route is' : 'routes are'} waiting on this text right now.`
            : 'Nothing is waiting on it right now.'}{' '}
          Nothing falls back to sending the first message again — Instagram accepts a word-for-word
          repeat and never delivers it (measured: 83% of second messages never arrived).
        </p>
      )}

      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          setOutcome(null)
        }}
        rows={6}
        placeholder={'Hi,Following up on {{post}} — …'}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.95rem', lineHeight: 1.5 }}
        aria-label={title}
      />

      <div className="row-between" style={{ marginTop: '0.5rem' }}>
        <button
          className="btn-primary"
          disabled={saving || body.trim() === initialBody.trim()}
          onClick={() => startSave(async () => setOutcome(await setFollowUpBody(slug, body)))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn-quiet"
          disabled={saving || !written}
          onClick={() => startSave(async () => setOutcome(await setFollowUpBody(slug, null)))}
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
