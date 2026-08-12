import { redirect } from 'next/navigation'

/** Moved: `/accounts` became `/senders` in the simple-sender redesign. Redirect only. */
export default function AccountsMoved() {
  redirect('/senders')
}
