'use client'

import { useState, useTransition } from 'react'
import { syncNow } from './actions'

/**
 * Manual slot trigger. A run takes ~15s (two profile renders plus enrichment),
 * so the pending state is not cosmetic — without it the button looks broken.
 */
export function SyncButton() {
  const [pending, start] = useTransition()
  const [result, setResult] = useState<string | null>(null)

  return (
    <div className="btnrow">
      {result ? <span className="muted mono">{result}</span> : null}
      <button
        className="primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(null)
            try {
              const r = await syncNow()
              setResult(`${r.status} · ${r.postsSeen} seen · ${r.detected} campaigns`)
            } catch (e) {
              setResult(`failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          })
        }
      >
        {pending ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  )
}
