'use client'

import { useTransition } from 'react'
import { setSenderStatus, setSenderAutoSend } from '../../actions'

/**
 * Pause/activate and the autopilot switch.
 *
 * Autopilot is two-key: this per-sender flag AND the deployment-level
 * AUTOPILOT_ENABLED env var. Flipping this alone cannot start unattended sending
 * on a machine that has not opted in.
 */
export function SenderToggles({
  senderId,
  status,
  autoSendEnabled,
  globalAutopilot,
}: {
  senderId: string
  status: string
  autoSendEnabled: boolean
  globalAutopilot: boolean
}) {
  const [pending, start] = useTransition()

  return (
    <>
      <div className="btnrow">
        {status === 'ACTIVE' ? (
          <button disabled={pending} onClick={() => start(() => setSenderStatus(senderId, 'PAUSED'))}>
            Pause sender
          </button>
        ) : (
          <button
            className="primary"
            disabled={pending}
            onClick={() => start(() => setSenderStatus(senderId, 'ACTIVE'))}
          >
            {status === 'CHALLENGED' ? 'Clear challenge & activate' : 'Activate sender'}
          </button>
        )}

        <button disabled={pending} onClick={() => start(() => setSenderAutoSend(senderId, !autoSendEnabled))}>
          {autoSendEnabled ? 'Switch to manual confirm' : 'Enable autopilot'}
        </button>
      </div>

      {autoSendEnabled && !globalAutopilot ? (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Autopilot is on for this sender but <code>AUTOPILOT_ENABLED=false</code> in the environment, so messages
          still wait for a human tap. Set it to <code>true</code> in <code>.env</code> to go unattended.
        </p>
      ) : null}
    </>
  )
}
