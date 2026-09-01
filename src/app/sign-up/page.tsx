import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { AuthShell } from '../auth-shell'

export const dynamic = 'force-dynamic'

/**
 * Open registration, chosen deliberately by Tabish on 2026-08-03 after the exposure was
 * stated twice.
 *
 * What signing up here grants, stated plainly for whoever reads this next: the full
 * dashboard, including `Send from @<revenue account>`, connecting accounts, and removing
 * channels. There is no role model — `sendNow` checks the safety gate, not who is
 * asking — so a new account can DM from @madaboutmarketingg, @bollywoodsocietyy and
 * @bollywoodchronicle using the Chrome profiles a human logged into.
 *
 * The only thing limiting that today is the 127.0.0.1 bind. Before this page is
 * reachable from anywhere else, add roles. The User model has no `role` column yet and
 * is shaped to take one without a painful migration.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  /* Validated, never cookie presence — see the sign-in page for the redirect loop this
     placement fixes. */
  if (await currentUser()) redirect('/')
  const { next } = await searchParams
  return <AuthShell mode="sign-up" next={next} />
}
