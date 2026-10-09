/**
 * ── THE AGENT IS STOPPING: START NOTHING NEW THAT DRIVES A BROWSER (2026-10-09) ────────
 *
 * `src/agent/main.ts` waits, on SIGTERM, for the job holding the send lock to finish, so a
 * restart does not kill a drive between the READY→SENDING claim and the thread check. Review
 * found the wait could CREATE the case it was built to prevent: stopping the tick loop stops
 * new TICKS, not the tick in flight, so a tick still evaluating drafts (or doing a pre-send
 * read) when the signal landed went on to claim and drive a message — and the bounded wait
 * then killed that drive at the deadline. Before the drain existed, the same signal exited
 * before any claim and cost nothing.
 *
 * So the stop is also a flag every browser path asks at the points where it would START
 * something: the send lock refuses new holders, the scheduled sender stops before its next
 * claim (beside the autopilot and sending-Mac re-checks), and the reply sweep stops between
 * conversations. What is already under way finishes; nothing new begins.
 *
 * A leaf module, because the dispatcher and the sender import each other's neighbours and this
 * must be readable from all three without a cycle.
 */
let stopping = false

export function requestBrowserShutdown(): void {
  stopping = true
}

export function browserShutdownRequested(): boolean {
  return stopping
}
