'use client'

import { useTransition } from 'react'
import { setPairCooldown, setPairEnabled } from '../actions'

/** Per-pair cooldown override and on/off, for tuning one route without the rest. */
export function PairControls({
  pairId,
  cooldownDays,
  enabled,
}: {
  pairId: string
  cooldownDays: number
  enabled: boolean
}) {
  const [pending, start] = useTransition()

  return (
    <div className="btnrow">
      <input
        type="number"
        min={0}
        max={365}
        defaultValue={cooldownDays}
        disabled={pending}
        style={{ width: 80 }}
        onBlur={(e) => {
          const v = Number(e.currentTarget.value)
          if (Number.isFinite(v) && v !== cooldownDays) start(() => setPairCooldown(pairId, v))
        }}
      />
      <span className="dim">days</span>
      <button disabled={pending} onClick={() => start(() => setPairEnabled(pairId, !enabled))}>
        {enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  )
}
