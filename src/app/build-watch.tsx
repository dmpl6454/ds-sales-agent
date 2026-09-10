'use client'

import { useEffect, useRef } from 'react'
import { decideReload } from './refresh-decision'
import { PULSE_PATH } from './auto-refresh'

/**
 * RELOAD THIS TAB WHEN THE SERVER'S BUILD CHANGES (2026-09-10).
 *
 * Mounted from the sidebar, so it is on every authenticated page — including the ones with
 * no data auto-refresh, which is where a stale tab lived longest. It asks the pulse for the
 * build the server is running and compares it with the build this page was rendered by (a
 * prop from the server component, never guessed client-side). Different means every server
 * action id in this bundle is dead, so the whole page reloads — once, and only while visible.
 * The comparison itself is `decideReload`, pure and tested in both directions.
 */
export function BuildWatch({ rendered, seconds = 30 }: { rendered: string; seconds?: number }) {
  const reloaded = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    let polling = false
    const poll = async () => {
      if (polling || reloaded.current || document.hidden) return
      polling = true
      try {
        const res = await fetch(PULSE_PATH, { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } })
        if (!res.ok || res.redirected) return
        if (!(res.headers.get('content-type') ?? '').includes('application/json')) return
        const body: unknown = await res.json()
        const live = (body as { build?: unknown } | null)?.build
        const decision = decideReload({ rendered, live: typeof live === 'string' ? live : null, hidden: document.hidden })
        if (decision === 'reload') {
          reloaded.current = true
          window.location.reload()
        }
      } catch {
        // A failed poll is a skip; the next tick asks again.
      } finally {
        polling = false
      }
    }
    const timer = setInterval(() => void poll(), seconds * 1000)
    const onVisible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      controller.abort()
    }
  }, [rendered, seconds])
  return null
}
