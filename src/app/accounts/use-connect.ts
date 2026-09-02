'use client'

import { useEffect, useRef, useState } from 'react'
import { connectAccount, checkConnect, abortConnect } from '../actions'
import type { ConnectState } from '@/outreach/browser/connect'

/**
 * The ONE client-side connect flow: open the Chrome window, then poll "done yet?"
 * until the server says signed in, wrong account, or gone.
 *
 * Extracted 2026-08-07 because there were two Connect buttons and only one polled.
 * The row button on /senders fired `connectAccount` once and told the operator to
 * reload — so on 2026-08-07 Tabish signed in to @bollywoodchronicle in the window it
 * opened and NOTHING ever asked Instagram whether he had: `finish()` never ran, the
 * window was never closed (cookies flush on close), `recordConnected` never wrote, and
 * the page kept saying "session expired" about an account that was signed in. The queue
 * card had the correct poll all along — one flow, two callers, one of them wrong, which
 * is the exact drift `gate.ts` and `readThread.ts` were extracted to stop.
 */
export type ConnectPhase = 'idle' | 'opening' | 'waiting' | 'done' | 'error'

const POLL_MS = 2500

export function useConnect(handle: string, opts?: { onConnected?: () => void }) {
  const [phase, setPhase] = useState<ConnectPhase>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (poll.current) {
      clearInterval(poll.current)
      poll.current = null
    }
  }

  /**
   * Polling stops on unmount, always. Without this, navigating away leaves an interval
   * hitting a server action for an account nobody is looking at — and a few of those
   * turn a working page into a load generator.
   */
  useEffect(() => stopPolling, [])

  /** Every server state gets its own sentence — lumping them is how `connected` once rendered as an error. */
  const settle = (r: ConnectState): void => {
    switch (r.state) {
      case 'connected':
        stopPolling()
        setPhase('done')
        setDetail(`@${handle} is signed in — confirmed with Instagram.`)
        opts?.onConnected?.()
        return
      case 'wrong-account':
        stopPolling()
        setPhase('error')
        setDetail(`That window is signed in as @${r.actual}, not @${r.expected}. Sign out there, then try again.`)
        return
      case 'closed':
      case 'error':
        stopPolling()
        setPhase('error')
        setDetail(r.message)
        return
      case 'waiting':
        setPhase('waiting')
        setDetail(r.message)
        return
      case 'opening':
        return
    }
  }

  const start = async (device?: string) => {
    setPhase('opening')
    setDetail(null)
    // `device` is ignored on a machine that drives Chrome directly (localhost); on the
    // hosted dashboard it names which Mac's agent opens the sign-in window.
    const first = await connectAccount(handle, device)
    settle(first)
    if (first.state === 'waiting') {
      poll.current = setInterval(async () => {
        settle(await checkConnect(handle))
      }, POLL_MS)
    }
  }

  const cancel = async () => {
    stopPolling()
    await abortConnect(handle)
    setPhase('idle')
    setDetail(null)
  }

  return { phase, detail, start, cancel }
}
