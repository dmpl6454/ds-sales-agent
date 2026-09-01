import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { AuthShell } from '../auth-shell'

export const dynamic = 'force-dynamic'

/**
 * One of exactly two pages reachable without a session (see PUBLIC_PATHS in
 * src/middleware.ts). Locking this would lock out everyone permanently, including
 * whoever would have to fix it.
 *
 * The already-signed-in bounce lives HERE since 2026-09-01, VALIDATED — `currentUser()`
 * looks the session up, never mere cookie presence. It used to live in the middleware on
 * presence alone, and composed with the dashboard's validated redirect the other way that
 * was an infinite loop for anyone holding a DEAD cookie: Safari, carrying an expired
 * session, bounced /sign-in → / → /sign-in forever and could never reach the one form
 * that would have replaced it. A dead cookie now falls through to the form, and signing
 * in overwrites it.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  if (await currentUser()) redirect('/')
  const { next } = await searchParams
  return <AuthShell mode="sign-in" next={next} />
}
