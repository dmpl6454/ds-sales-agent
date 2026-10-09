import { cache } from 'react'
import { readPresence } from '@/outreach/devicePresence'

/**
 * WHICH MACS ARE BEATING, read once per render — for the SCREENS only.
 *
 * `/` needs presence twice: the switch card (is the sending Mac online?) and the queue (which
 * accounts does the sending Mac hold a profile for? — audit H8). Request-cached exactly like
 * `getSettings`, so the second reader costs no query and `/` stays inside its budget, and so
 * the card and the queue cannot read two different heartbeats in one render.
 *
 * `readPresence` ITSELF is deliberately NOT cached: the send lock's `deviceIsBeating` must
 * re-read it every time it decides whether a foreign holder is alive, and outside a request
 * `cache` would not dedupe anyway — but a future caller inside one must not inherit a stale
 * answer to a liveness question.
 */
export const readPresenceForView = cache(readPresence)
