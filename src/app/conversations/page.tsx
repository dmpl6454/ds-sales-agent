import { redirect } from 'next/navigation'

/**
 * Moved in the simple-sender redesign: replies wait on `/` (Autopilot), the history and
 * open-thread picture live on `/analytics`.
 */
export default function ConversationsMoved() {
  redirect('/analytics')
}
