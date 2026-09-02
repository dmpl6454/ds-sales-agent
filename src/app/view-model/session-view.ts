import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable, sessionRecorded } from '@/outreach/sessionHealth'
import { env } from '@/lib/env'

/**
 * ── "SIGNED IN" IS A DIFFERENT QUESTION ON THE HOSTED DASHBOARD ──────────────
 *
 * On a SENDING machine (`SEND_ENABLED`, localhost or the device) the truth about a session
 * is the cookie file on THIS disk: that is what the browser will actually find. On the
 * HOSTED dashboard (the Linode, `SEND_ENABLED=false`) there are no Chrome profiles at all,
 * so the disk always answers "never signed in". There the machine-independent DB record is
 * the right witness: `sessionPath` is what the device wrote when it connected (via the
 * relay or reconcile), `sessionInvalidAt` is what a failed send wrote.
 *
 * ── WHY THIS IS ONE MODULE, 2026-09-02 ────────────────────────────────────────
 *
 * This rule lived PRIVATELY in accounts-page.ts, so the machine-aware fix reached /senders
 * and nothing else. The landing page (AccountCard.state, AutopilotState.readyHandles and
 * needLoginHandles), the sidebar sign-in badge (nav.tsx) and /targets' sendersAble all kept
 * reading `profileStatus()` — local disk — and therefore told a hosted reader that all
 * seven signed-in, actively-sending accounts were "not signed in, so they cannot send"
 * while the fleet was delivering 9/hour. Tabish caught it from the live page. The
 * one-rule-several-callers drift, again; the rule lives here now and every dashboard
 * reader of "is this account signed in" imports it.
 */
export function sessionIsUsable(s: {
  handle: string
  sessionPath: string | null
  sessionInvalidAt: Date | null
}): boolean {
  return env.SEND_ENABLED
    ? sessionUsable({ hasSessionOnDisk: profileStatus(s.handle).hasSession, sessionInvalidAt: s.sessionInvalidAt })
    : sessionRecorded(s)
}