'use client'

import { useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { decideRefresh } from './refresh-decision'

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
 *
 * ── CHAPTER TWO: THE TIMER WAS THE OUTAGE (2026-09-04) ───────────────────────────────
 *
 * The first version called `router.refresh()` every `seconds` whether or not anything had
 * changed, and fired again on schedule while the previous refresh was still running. On the
 * hosted Linode — 2 GB, one vCPU, shared with eight other apps, 914 MB in swap — the web
 * process was OOM-killed twice in a day at 773 MB and 607 MB anon-rss. MEASURED, one render
 * peaks at only +22..32 MB of heap. The memory was a PILE-UP: a CPU-starved render took over
 * 60 s, nginx returned 504, the person retried, and every open tab kept re-rendering on its
 * 30-45 s timer, so ten-plus renders were alive at once. A blind timer on a slow box is a
 * load generator aimed at the box.
 *
 * So the component asks a cheap question first — `GET /api/pulse`, five aggregate queries
 * returning one `{ stamp }` string that moves whenever a page could (see
 * `src/app/api/pulse/stamp.ts`) — and re-renders ONLY when the answer differs from the last
 * one it saw:
 *
 *   - the FIRST successful poll records the baseline and refreshes nothing: the page was
 *     server-rendered a moment ago, and a refresh on mount is one more render for nothing;
 *   - a changed stamp → `startTransition(() => router.refresh())`, and the new stamp is
 *     remembered;
 *   - NEVER while `isPending` — a refresh is in flight. The tick is skipped and the stamp is
 *     NOT advanced, so the next tick sees the same difference and catches up once the
 *     transition settles. A slow refresh can no longer stack behind itself, which is the
 *     structural half of the fix;
 *   - hidden tab → no poll and no refresh (kept); on return to the tab, one poll, and a
 *     refresh only if the stamp moved (the "refresh on return" intent, gated on change);
 *   - a non-200, a redirect, or a non-JSON body do NOTHING. When the session expires the
 *     middleware answers the poll with the sign-in page — HTML, 200 after the redirect —
 *     and the one thing this must never do is refresh-loop or throw on it.
 *
 * The decision itself is `decideRefresh` in `./refresh-decision.ts`, PURE and unit-tested
 * in every direction; this file is the wiring. `tests/pulse-refresh.test.ts` also greps
 * this file for the old shape — an unconditional `router.refresh()` — and for any import
 * that would drag server modules into the browser bundle.
 *
 * The `seconds` prop and both call sites (`/` at 30, `/analytics` at 45) are unchanged: it
 * is the POLL cadence now, and a poll that finds nothing costs five cheap queries rather
 * than a render.
 */
export const PULSE_PATH = '/api/pulse'

/**
 * Ask the pulse. `null` means "no usable answer" — a network failure, an abort on unmount,
 * a non-200, a redirect to the sign-in page, a body that is not JSON, or JSON without a
 * string `stamp`. Every one of those is a reason to do nothing this tick, never to throw:
 * an exception inside a timer callback would surface as an unhandled rejection on a page
 * that is otherwise fine.
 */
async function readStamp(signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(PULSE_PATH, {
      cache: 'no-store',
      signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok || res.redirected) return null
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null
    const body: unknown = await res.json()
    const stamp = (body as { stamp?: unknown } | null)?.stamp
    return typeof stamp === 'string' ? stamp : null
  } catch {
    return null
  }
}

export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Refs, because the poll runs inside a timer closure created once per mount and must read
  // the CURRENT pending flag and baseline, not the values captured at the first render.
  const pendingRef = useRef(false)
  pendingRef.current = isPending
  const stampRef = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    // One poll at a time. A poll that outlives the interval (a slow server is exactly the
    // case this exists for) must not be joined by a second one; the next tick simply finds
    // this flag set and steps aside.
    let polling = false

    const poll = async () => {
      if (polling || document.hidden) return
      polling = true
      try {
        const next = await readStamp(controller.signal)
        if (next === null) return
        const decision = decideRefresh({
          prev: stampRef.current,
          next,
          pending: pendingRef.current,
          hidden: document.hidden,
        })
        if (decision === 'baseline') {
          stampRef.current = next
        } else if (decision === 'refresh') {
          stampRef.current = next
          startTransition(() => router.refresh())
        }
      } finally {
        polling = false
      }
    }

    const timer = setInterval(() => void poll(), seconds * 1000)
    // Poll on returning to the tab too — that is the moment a person is actually looking,
    // and the interval alone could leave them reading up to a full period of yesterday. The
    // poll refreshes only if something changed while they were away.
    const onVisible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      controller.abort()
    }
  }, [router, seconds, startTransition])

  return null
}