import { redirect } from 'next/navigation'

/** Moved: the queue and manual send live on `/` (Autopilot) since the simple-sender redesign. */
export default function MessagesMoved() {
  redirect('/')
}
