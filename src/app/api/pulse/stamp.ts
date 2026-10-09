/**
 * THE PULSE STAMP — one short string that changes whenever a dashboard page could.
 *
 * PURE, so the composition is unit-testable without a database and the route stays a thin
 * reader (`route.ts`). `auto-refresh.tsx` polls the route and re-renders a page ONLY when the
 * string it gets back differs from the one it last saw. Nothing here is a figure anyone reads;
 * it is a change DETECTOR, and it is deliberately coarse in the safe direction — a stamp that
 * moves when nothing on screen did costs one render, a stamp that stays still when something
 * did costs a stale screen until the next real change.
 *
 * ── WHY THIS EXISTS (2026-09-04) ─────────────────────────────────────────────────────
 *
 * The hosted dashboard shares a 2 GB / 1-vCPU Linode with eight other apps, 914 MB in swap,
 * and the web process was OOM-killed twice today (773 MB and 607 MB anon-rss). A single page
 * render peaks at only +22..32 MB heap, MEASURED — the memory came from a PILE-UP: a starved
 * render took over 60 s, nginx answered 504, the person retried, and every open tab fired
 * `router.refresh()` on its 30-45 s timer whether or not anything had changed, so ten-plus
 * renders were alive at once. The old `auto-refresh.tsx` was that timer. The fix is
 * structural rather than a bigger box: render nothing when nothing changed, and never let a
 * slow refresh stack behind itself.
 *
 * ── WHAT GOES IN, AND WHAT IS DELIBERATELY LEFT OUT ─────────────────────────────────
 *
 * Every table a page reads is covered by an aggregate over the columns that move when a
 * row a page shows moves:
 *
 *   OutreachAttempt   max(sentAt)      a delivery      — indexed ([sentAt]), an index-tail read
 *                     max(queuedAt)    a draft written — NOT indexed; a sequential scan of the
 *                     max(repliedAt)   a reply         — attempts table (a few thousand rows
 *                                                        today), single-digit milliseconds on
 *                                                        Postgres; one query returns all three
 *                     count(in flight) READY/QUEUED/SENDING — a status change with no timestamp
 *                                      (READY→SENDING→FAILED) still moves the count; indexed
 *                                      ([status])
 *   DetectedCampaign  max(detectedAt)  a post found    — indexed ([detectedAt])
 *                     count(*)         a post deleted changes nothing dated; the count catches it
 *   Setting           max(updatedAt)   a switch, a template, a verdict flip or a label written
 *                                      through a Setting — `@updatedAt`, a table of a few dozen rows
 *                     count(*)         a row created or deleted
 *   SenderAccount     max(updatedAt)   a sign-in, a challenge, a retirement — `@updatedAt`, ~7 rows
 *
 * SETTING IS A HOT TABLE, AND SIX OF ITS KEYS ARE EXCLUDED ON PURPOSE. The scheduler
 * heartbeat is rewritten every 60 s, device presence every 30 s, `dispatchState` on every
 * dispatch tick, the send lock on every browser drive, the pace clock on every send, and the
 * sending Mac's success stamp (`dispatchLastOkAt`) once a minute. Folded
 * into the stamp they would change it on nearly every poll, and change-detection would
 * silently become the blind 30-second timer it replaces — the pile-up back, wearing a
 * cleverer name. What those rows feed on screen is a RELATIVE AGE ("heartbeat 1 min old",
 * "tabish-mac beating 0 min"), which drifts by a minute between refreshes and is corrected by
 * the next real change; a send, a draft, a detection or a switch still refreshes the page. The
 * list lives here as literals because the route must not import the modules that own the
 * constants (`agent/index.ts` reaches the browser stack, `scheduler.ts` reaches node-cron);
 * `tests/pulse-refresh.test.ts` greps each owner's source so the literals cannot drift.
 *
 * NOT scoped to visible channels: a post on one of our own (hidden) pages moves the stamp
 * and costs one unnecessary render. Scoping would cost `visibleChannelIds()`'s query on
 * every poll to save a render that happens a handful of times a day.
 */

export const PULSE_IGNORED_SETTING_KEYS = [
  'schedulerHeartbeat', // scheduler.ts HEARTBEAT_KEY — every 60 s
  'devicePresence', // agent/index.ts DEVICE_PRESENCE_KEY — every 30 s per device
  'dispatchState', // dispatcher.ts DISPATCH_STATE_KEY — every dispatch tick
  'sendLock', // dispatcher.ts SEND_LOCK_KEY — every browser drive
  'fleetLastSendStartedAt', // paceClock.ts LAST_SEND_STARTED_KEY — every send; the send itself moves max(sentAt)
  'dispatchLastOkAt', // dispatchHealth.ts DISPATCH_OK_KEY — the sending Mac's completed ticks, once a minute
] as const

export type PulseParts = {
  lastSentAt: Date | null | undefined
  lastQueuedAt: Date | null | undefined
  lastRepliedAt: Date | null | undefined
  inFlight: number
  lastDetectedAt: Date | null | undefined
  postCount: number
  settingsUpdatedAt: Date | null | undefined
  settingCount: number
  senderUpdatedAt: Date | null | undefined
}

/**
 * A null or undefined date renders as `-`, so an empty table has a stable stamp rather than
 * the string "null" in one process and "undefined" in another. `getTime()` rather than an ISO
 * string: shorter, and immune to a locale or timezone formatter creeping in later.
 */
function mark(d: Date | null | undefined): string {
  return d ? String(d.getTime()) : '-'
}

/**
 * Deterministic: equal parts give equal strings, and any single part moving gives a
 * different string. Field order is fixed and joined with a separator that cannot appear in a
 * number, so two parts can never collide by concatenation ("1" + "23" vs "12" + "3").
 */
export function composeStamp(p: PulseParts): string {
  return [
    mark(p.lastSentAt),
    mark(p.lastQueuedAt),
    mark(p.lastRepliedAt),
    String(p.inFlight),
    mark(p.lastDetectedAt),
    String(p.postCount),
    mark(p.settingsUpdatedAt),
    String(p.settingCount),
    mark(p.senderUpdatedAt),
  ].join('|')
}