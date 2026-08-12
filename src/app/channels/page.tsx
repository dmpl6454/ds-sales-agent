import { redirect } from 'next/navigation'

/** Moved: `/channels` folded into `/targets` in the simple-sender redesign. */
export default function ChannelsMoved() {
  redirect('/targets')
}
