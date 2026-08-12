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
      {/* Hidden with the rest of the rail's text when collapsed — at 76px there is no room
          for an address, and a truncated one is worse than none. The button keeps its
          label as a `title`, so the identity is still one hover away. */}
      <span className="rail-email rail-when-open" title={`Sends are recorded as ${email}`}>
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
