'use client'

import { useState, useTransition } from 'react'
import { signIn, signUp } from './auth-actions'

/**
 * The sign-in / sign-up form. One component, two modes, because the two differ only in
 * which action they call and what the copy says.
 *
 * Deliberately plain. This is the first thing anyone sees and it must not look like it
 * is doing something clever — a login page that looks unusual is a login page people
 * hesitate to type a password into.
 */
export function AuthForm({ mode, next }: { mode: 'sign-in' | 'sign-up'; next?: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, startTransition] = useTransition()

  const isSignUp = mode === 'sign-up'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      /**
       * On success the action calls `redirect()`, which throws a control-flow signal
       * rather than returning — so a returned value here always means failure. The
       * redirect signal must NOT be swallowed by a try/catch around this call, which
       * is why there isn't one.
       */
      const result = isSignUp
        ? await signUp(email, password, next, inviteCode)
        : await signIn(email, password, next)
      if (result && !result.ok) setError(result.message)
    })
  }

  return (
    <form className="authform" onSubmit={submit}>
      <h1>{isSignUp ? 'Create an account' : 'Sign in'}</h1>

      <label>
        <span>Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>

      {/*
        The invite code, sign-up only. The gate itself is on the SERVER — this field only
        carries the value, and a client that omits it is refused there. Rendering it here
        is about telling an invited person what they need, not about enforcing anything:
        a form field is never a security control.
      */}
      {isSignUp ? (
        <label>
          <span>Invite code</span>
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <small className="hint">
            Accounts are invite-only. Whoever runs this dashboard has the code. A new account can see
            everything and change nothing until they approve it.
          </small>
        </label>
      ) : null}

      <label>
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          /*
           * Tells a password manager whether to offer a saved password or to generate
           * one. Wrong value here is the difference between a manager filling the field
           * and silently doing nothing.
           */
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          required
        />
        {isSignUp ? <em>At least 10 characters.</em> : null}
      </label>

      {error ? <p className="autherr">{error}</p> : null}

      <button type="submit" className="primary" disabled={busy || !email || !password}>
        {busy ? 'One moment…' : isSignUp ? 'Create account' : 'Sign in'}
      </button>

      <p className="authalt">
        {isSignUp ? (
          <>
            Already have an account? <a href="/sign-in">Sign in</a>
          </>
        ) : (
          <>
            No account yet? <a href="/sign-up">Create one</a>
          </>
        )}
      </p>
    </form>
  )
}
