'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * KEEP THE PAGE CURRENT WHILE MESSAGES GO OUT EVERY MINUTE.
 *
 * Tabish, 2026-08-19: the queue "doesn't update real time as messages are being sent
 * every minute" — the landing page is server-rendered once and then stood still while
 * the numbers behind it moved sixty times an hour. At the old 15-minute cadence a
 * hand-refresh was fine; at one message a minute the page is stale before it is read.
 *
 * `router.refresh()` re-runs the server components in place — no full reload, scroll and
 * form state survive, and the poll pauses while the tab is hidden so a backgrounded
 * dashboard does not query the database all day for nobody. Renders nothing.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter()

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) router.refresh()
    }
    const timer = setInterval(tick, seconds * 1000)
    // Refresh immediately on returning to the tab too — that is the moment a person is
    // actually looking, and the interval alone could leave them reading up to a full
    // period of yesterday.
    const onVisible = () => {
      if (!document.hidden) router.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router, seconds])

  return null
}
