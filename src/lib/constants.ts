/**
 * SQLite has no enum type, so status columns are plain strings. These unions are
 * the single source of truth for the allowed values — every write goes through
 * them so a typo becomes a compile error instead of a silently invalid row.
 */

export const VERDICTS = ['CAMPAIGN', 'REVIEW', 'ORGANIC', 'UNCLASSIFIED'] as const
export type Verdict = (typeof VERDICTS)[number]

export const ATTEMPT_STATUSES = [
  'QUEUED', // created by the planner, not yet surfaced
  'READY', // waiting for a human tap (manual mode)
  'SENT', // delivered
  'SKIPPED', // superseded or cancelled before sending
  'FAILED', // send attempted and failed
  'REPLIED', // target replied — halts all senders to this target
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export const SENDER_STATUSES = ['ACTIVE', 'PAUSED', 'CHALLENGED'] as const
export type SenderStatus = (typeof SENDER_STATUSES)[number]

export const TARGET_KINDS = ['CHANNEL', 'BRAND'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export const RUN_STATUSES = ['OK', 'PARTIAL', 'FAILED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** Which ChannelDetector handles a target. Registry lives in src/detection/detectors. */
export const DETECTOR_KEYS = ['mom', 'passthrough'] as const
export type DetectorKey = (typeof DETECTOR_KEYS)[number]

/**
 * Instagram's own limits, for reference and for the guards in the governor.
 * Meta cut the hard outbound cap to 200/hour in Oct 2024. Community-observed
 * safe cold-DM volume is ~20/day for an aged, warmed account. Phase 1 peaks at
 * 2 DMs/day total, i.e. ~3% of capacity across three senders.
 */
export const IG_LIMITS = {
  hardCapPerHour: 200,
  safeColdDmsPerAccountPerDay: 20,
} as const

/** The publisher channels being watched in Phase 1. */
export const TARGET_HANDLES = {
  mom: 'madovermarketing_mom',
  viralbhayani: 'viralbhayani',
} as const

/**
 * Follower counts, for display only. A point-in-time snapshot (2026-07-29) rather
 * than a live figure — it exists so the dashboard can show scale at a glance, and
 * fetching it every render would be an Instagram request bought for nothing.
 */
export const FOLLOWER_SNAPSHOT: Record<string, string> = {
  madovermarketing_mom: '1.5M',
  viralbhayani: '15.6M',
}
