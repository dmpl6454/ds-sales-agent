import { AuthShell } from '../auth-shell'

export const dynamic = 'force-dynamic'

/**
 * One of exactly two pages reachable without a session (see PUBLIC_PATHS in
 * src/middleware.ts). Locking this would lock out everyone permanently, including
 * whoever would have to fix it.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  return <AuthShell mode="sign-in" next={next} />
}
