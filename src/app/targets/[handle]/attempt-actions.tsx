'use client'

import { useState, useTransition } from 'react'
import { markReplied } from '../../actions'

/**
 * Row actions on a historical attempt. "Replied" is the important one: it halts
 * every sender to this target, so it belongs next to the message that got the
 * reply rather than buried in settings.
 */
export function AttemptActions({
  attemptId,
  status,
  body,
}: {
  attemptId: string
  status: string
  body: string
}) {
  const [pending, start] = useTransition()
  const [show, setShow] = useState(false)

  return (
    <>
      <div className="btnrow">
        <button onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'View'}</button>
        {status === 'SENT' ? (
          <button
            disabled={pending}
            onClick={() => start(() => markReplied(attemptId))}
            title="Halts every sender to this target"
          >
            Replied
          </button>
        ) : null}
      </div>
      {show ? (
        <pre className="msg" style={{ marginTop: 8, maxWidth: 620 }}>
          {body}
        </pre>
      ) : null}
    </>
  )
}
