'use client'

import { useTransition } from 'react'
import { signOut } from './auth-actions'

/**
 * Sign out, and show who is signed in.
 *
 * The email is not decoration — it is what gets written to `sentBy` and
 * `AuditLog.actor`. Someone about to press "Send from @bollywoodsocietyy" should be able
 * to see which identity that send will be recorded against, on the same screen, without
 * checking anything.
 */
export function SignOutButton({ email }: { email: string }) {
  const [busy, start] = useTransition()

  return (
    <>
      {/* Dropped from the bar below 1200px, where the seven destinations need the room —
          a truncated address is worse than none. The button keeps the address as its
          `title` in every case, so the identity is always one hover away. */}
      <span className="topbar-email" title={`Sends are recorded as ${email}`}>
        {email}
      </span>
      <button
        type="button"
        onClick={() => start(async () => void (await signOut()))}
        disabled={busy}
        title={`Signed in as ${email}`}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </>
  )
}
