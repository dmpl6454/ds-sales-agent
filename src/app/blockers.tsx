import Link from 'next/link'
import type { Route } from 'next'
import type { Blocker } from './view-model/blockers'

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
      <p className="blurb">{summary}</p>

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
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
