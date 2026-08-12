import { redirect } from 'next/navigation'

/** Moved: `/prospects` folded into `/targets` in the simple-sender redesign. */
export default function ProspectsMoved() {
  redirect('/targets')
}
