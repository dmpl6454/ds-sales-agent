import { redirect } from 'next/navigation'

/**
 * Removed 2026-08-18 on Tabish's instruction ("Remove settings page"). The one control it
 * carried that still exists — the standard-message editor — lives on `/` (Autopilot).
 * Every cap it once edited was removed the same day; the surviving pair-daily limit is a
 * code default (`MAX_PER_PAIR_PER_DAY`), deliberately not a dashboard knob.
 */
export default function SettingsMoved() {
  redirect('/')
}
