import type { AutopilotState } from '../view-model'

/**
 * WILL THE QUEUE MOVE, AND THROUGH WHICH MAC — one derivation, every screen.
 *
 * ── WHY THIS EXISTS (audit H8, 2026-10-09) ──────────────────────────────────
 *
 * The switch card, the "what is stopping it" summary and the queue each decided "is the fleet
 * on" for themselves, from two different values. The card read the FLEET row
 * (`settings.autopilotFleetWide`); the queue read `settings.autopilotEnabled`, which is
 * `env.AUTOPILOT_ENABLED && row` — the ENFORCEMENT value, env-floored, and false on the Linode
 * by design. So the hosted landing page said "Autopilot is ON — the Studio sends by itself"
 * and, a screen lower, "Autopilot is off, so none of these are going out", about the same
 * fleet in the same render. **`settings.autopilotEnabled` is a fact about THIS machine's
 * permission to send. No screen may read it**; `tests/autopilot-display-source.test.ts` pins
 * that by grep.
 *
 * And "on" was never the whole question. With the row ON and no Mac selected, or the selected
 * Mac asleep, the card says nothing sends — while the queue, asked only "is the switch on",
 * promised ETAs. So this is the switch card's OWN branch order (autopilot.tsx), lifted out so
 * the card, the summary and the queue cannot disagree: switch, then a selected Mac, then that
 * Mac beating, then an account able to use it.
 *
 * ── THE 2026-08-20 LESSON THIS CARRIES FORWARD ───────────────────────────────
 *
 * Tabish switched Autopilot OFF, the dispatcher correctly held every tick on `autopilot-off`
 * — and "Up next" went on showing "clear to send on the next tick" with "in ~1 min" ETAs. The
 * gate cannot catch that: AUTO_SEND_OFF went in the one-switch change, so `recheckBeforeSend`
 * says nothing about the switch and answers `ok` for a draft nothing will send. A countdown is
 * a promise; only `moving` may show one.
 *
 * PURE, and `import type` only, because the 'use client' switch imports it: a runtime import
 * of a server module from here is the `waiting.tsx -> gate.ts -> better-sqlite3` trap that
 * returned HTTP 500 on every route.
 */
export type QueueMotion =
  | { kind: 'moving'; mac: string }
  | { kind: 'switch-off' }
  | { kind: 'no-mac' }
  | { kind: 'mac-offline'; mac: string }
  | { kind: 'no-account-ready'; mac: string }

/** The switch card's branch order, exactly. `on` is the FLEET row (view-model.ts), never the floored value. */
export function queueMotion(a: Pick<AutopilotState, 'on' | 'sendingMac' | 'readyHandles'>): QueueMotion {
  if (!a.on) return { kind: 'switch-off' }
  const mac = a.sendingMac.selected
  if (!mac) return { kind: 'no-mac' }
  if (!a.sendingMac.online) return { kind: 'mac-offline', mac }
  if (a.readyHandles.length === 0) return { kind: 'no-account-ready', mac }
  return { kind: 'moving', mac }
}

/**
 * Why nothing goes out, in the switch card's own words — the clause after "Autopilot is ON,
 * but …" (or "Autopilot is off"). Null for `moving`: there is nothing stopping it to name.
 */
export function motionHoldReason(m: QueueMotion): string | null {
  switch (m.kind) {
    case 'moving':
      return null
    case 'switch-off':
      return 'Autopilot is off'
    case 'no-mac':
      return 'no Mac is selected to send'
    case 'mac-offline':
      return `${m.mac} — the sending Mac — is not online`
    case 'no-account-ready':
      return 'no account is ready to use it'
  }
}

/** When a waiting draft's turn comes, if not on the pace: the ETA cell's wording. Null for `moving`. */
export function motionWaitsFor(m: QueueMotion): { eta: string; until: string } | null {
  switch (m.kind) {
    case 'moving':
      return null
    case 'switch-off':
      return { eta: 'when Autopilot is on', until: 'Autopilot to be switched on' }
    case 'no-mac':
      return { eta: 'when a sending Mac is chosen', until: 'a sending Mac to be chosen' }
    case 'mac-offline':
      return { eta: `when ${m.mac} is back online`, until: `${m.mac} to come back online` }
    case 'no-account-ready':
      return { eta: 'when an account is signed in', until: 'an account to be signed in' }
  }
}
