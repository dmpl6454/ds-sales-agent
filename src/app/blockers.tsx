'use client'

import Link from 'next/link'
import type { Route } from 'next'
import type { Blocker } from './view-model/blockers'
import { useState, useTransition } from 'react'
import { acknowledgeFleetBreaker } from './actions'

/**
 * "What is stopping it" — the answer to the only question this page asks.
 *
 * Every sentence here was produced by the guard that enforces it (`assessWatch`,
 * `recheckBeforeSend`). This component ARRANGES; it does not judge, and it must never
 * shorten, re-word or summarise a `verdict` string. The remedy link is the one thing the
 * UI owns: the gate says WHY, this says WHERE.
 *
 * The rank label is a fixed-width column on the left rather than a heading, so the four
 * categories line up and the eye can find "Watch health" without reading the sentences.
 * That matters because the list is ordered by irrecoverability rather than by loudness,
 * and the ordering is only useful if it is legible at a glance.
 */
export function BlockerList({ blockers, summary }: { blockers: Blocker[]; summary: string }) {
  return (
    <section>
      <h2>What is stopping it</h2>
      <p className="blurb lede">{summary}</p>

      {blockers.length === 0 ? (
        /*
          `.empty-quiet`, not `.empty`. A dashed border says "there could be something
          here and there is not"; a solid one says "this was checked and it is clear".
          Those are different facts, and this is the good one.
        */
        <p className="empty empty-quiet">Every check is clear.</p>
      ) : (
        <div className="stack">
          {blockers.map((b) => (
            <div key={b.key} className={`blocker blocker-${b.tone}`}>
              <div className="blocker-head">
                <span className="eyebrow blocker-rank">{b.rank}</span>
                <span className="blocker-headline">{b.headline}</span>
              </div>
              <p className="blocker-verdict">{b.verdict}</p>
              {b.remedy ? (
                <p className="blocker-remedy">
                  <Link href={b.remedy.href as Route}>{b.remedy.label}</Link>
                </p>
              ) : null}
              {/*
                THE RELEASE THE BREAKER'S OWN SENTENCE ASKS FOR. It says "nothing else is
                sent until someone has looked", and until 2026-08-26 there was no way to say
                you had — while the rate could not self-heal, because its denominator only
                grows by sending. It acknowledges what already happened; a new failure trips
                it again.
              */}
              {b.acknowledgeable ? <AcknowledgeBreaker /> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * "I have looked — resume the fleet."
 *
 * A REASON IS REQUIRED, and it is not ceremony: this row is the only lasting record of why a
 * halted fleet was resumed, and `not-in-thread` means *the recipient MAY already have it*.
 * Months later "resumed" tells nobody anything; "second messages were byte-identical and
 * Instagram was dropping them, fixed at the governor" tells them everything.
 *
 * It is a `<details>` rather than a bare button so the control cannot be pressed by
 * accident on the most consequential card on the page.
 */
function AcknowledgeBreaker() {
  const [reason, setReason] = useState('')
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, startSave] = useTransition()

  return (
    <details className="ack-breaker">
      <summary>I have looked — resume the fleet</summary>
      <p className="settingrow-consequence">
        This covers the failures that have already happened. If another message clears the composer and
        never arrives, the halt comes straight back.
      </p>
      <input
        value={reason}
        onChange={(e) => {
          setReason(e.target.value)
          setOutcome(null)
        }}
        placeholder="What did you find? e.g. second messages were identical and being dropped — fixed"
        aria-label="What you found"
        style={{ width: '100%' }}
      />
      <button
        className="btn-primary"
        style={{ marginTop: '0.5rem' }}
        disabled={busy || reason.trim().length < 10}
        onClick={() => startSave(async () => setOutcome(await acknowledgeFleetBreaker(reason)))}
      >
        {busy ? 'Recording…' : 'Resume the fleet'}
      </button>
      {outcome ? (
        <p className={outcome.ok ? 'settingrow-consequence' : 'settingrow-argument'}>{outcome.message}</p>
      ) : null}
    </details>
  )
}
