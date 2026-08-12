'use client'

import { useState } from 'react'
import { useConnect } from '../use-connect'
import type { LoginQueueView } from '../../view-model/accounts-page'

type Item = LoginQueueView['queue'][number]

/**
 * The queue itself: ONE account in focus, the rest listed behind it.
 *
 * Only one Chrome window is driven at a time — `connect.ts` keeps open contexts in a
 * module-level Map keyed by handle, and a person can only type one password at a time
 * anyway. The start-then-poll flow lives in `useConnect`, shared with the row button on
 * /senders; it was duplicated once and the copy that drifted burned a real login.
 */
export function LoginQueue({ queue }: { queue: Item[] }) {
  const [index, setIndex] = useState(0)
  const current = queue[index]

  if (queue.length === 0) {
    return (
      <section className="group">
        <h2>Every account is signed in</h2>
      </section>
    )
  }

  return (
    <>
      <section className="group">
        <h2>Next up</h2>
        {current && (
          <LoginCard
            key={current.handle}
            item={current}
            position={index + 1}
            of={queue.length}
            onDone={() => setIndex((i) => Math.min(i + 1, queue.length - 1))}
            onSkip={() => setIndex((i) => (i + 1) % queue.length)}
          />
        )}
      </section>

      {queue.length > 1 && (
        <section className="group">
          <h2>Waiting ({queue.length - 1})</h2>
          <ul className="plain-list">
            {queue.map((q, i) =>
              i === index ? null : (
                <li key={q.handle}>
                  <button className="link-quiet" onClick={() => setIndex(i)}>
                    @{q.handle}
                  </button>{' '}
                  <span className="muted">{q.name}</span>
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </>
  )
}

function LoginCard({
  item,
  position,
  of,
  onDone,
  onSkip,
}: {
  item: Item
  position: number
  of: number
  onDone: () => void
  onSkip: () => void
}) {
  const connect = useConnect(item.handle)

  return (
    <article className="login-card">
      <p className="login-position">
        {position} of {of}
      </p>
      <h3>@{item.handle}</h3>
      <p className="muted">{item.name}</p>

      <p className="login-note">
        {item.hasProfileDir
          ? 'Signed in here before — a routine re-login, not a new device.'
          : 'First sign-in. Complete it fully, including any code Instagram asks for.'}
      </p>

      <div className="account-actions">
        {connect.phase === 'idle' && <button onClick={connect.start}>Open Chrome and sign in</button>}
        {connect.phase === 'opening' && <button disabled>Opening Chrome…</button>}
        {connect.phase === 'waiting' && (
          <>
            <button disabled>Waiting for you to sign in…</button>
            <button className="link-quiet" onClick={connect.cancel}>
              cancel
            </button>
          </>
        )}
        {connect.phase === 'done' && <button onClick={onDone}>Next account →</button>}
        {connect.phase === 'error' && <button onClick={connect.start}>Try again</button>}
        {connect.phase !== 'waiting' && of > 1 && (
          <button className="link-quiet" onClick={onSkip}>
            skip for now
          </button>
        )}
      </div>

      {connect.detail && (
        <p className={connect.phase === 'error' ? 'account-message bad' : 'account-message'}>{connect.detail}</p>
      )}
    </article>
  )
}
