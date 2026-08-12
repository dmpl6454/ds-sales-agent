import { redirect } from 'next/navigation'

/** Moved: the sign-in queue lives on `/senders` since the simple-sender redesign. */
export default function LoginQueueMoved() {
  redirect('/senders')
}
