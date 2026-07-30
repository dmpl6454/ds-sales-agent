'use client'

import { useState, useTransition } from 'react'
import { syncNow } from './actions'

/**
 * "Check now" — runs a slot immediately instead of waiting for the schedule.
 *
 * A run takes ~15s, so the pending state is not cosmetic; without it the button
 * looks broken. Phrased as checking rather than syncing, because that is what a
 * non-engineer is asking it to do.
 */
export function SyncButton() {
  const [pending, start] = useTransition()
  const [result, setResult] = useState<string | null>(null)

  return (
    <span className="sync">
      {result ? <span className="sync-result">{result}</span> : null}
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(null)
            try {
              const r = await syncNow()
              const bits = [`${r.detected} campaign${r.detected === 1 ? '' : 's'} found`]
              if (r.repliesFound > 0) bits.push(`${r.repliesFound} reply`)
              if (r.sent > 0) bits.push(`${r.sent} sent`)
              setResult(bits.join(' · '))
            } catch (e) {
              setResult(`could not check: ${e instanceof Error ? e.message : String(e)}`)
            }
          })
        }
      >
        {pending ? 'Checking…' : 'Check now'}
      </button>
    </span>
  )
}
