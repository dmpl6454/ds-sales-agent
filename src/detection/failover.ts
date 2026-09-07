/**
 * failover.ts — when should a DEVICE (an operator's Mac) read the feeds instead of the server?
 *
 * Detection lives on the Linode, and since 4 Sept 2026 Instagram has been refusing that IP's
 * anonymous reads for hours at a stretch (see anonGate.ts). A Mac running the device agent
 * sits on a residential IP of its own, already runs the badge door and brand discovery from
 * it, and holds everything a detection pass needs (the database, the OCR helper, the model
 * key). So when the server has read nothing for a while, a device reads for it. The pipeline
 * is idempotent on shortcode, both hosts stamp the same `detectFeedOkAt`, and the server's
 * planner drafts from whatever either of them stored.
 *
 * PURE, and deliberately conservative in the two directions that matter:
 *   - a device never reads while ITS OWN gate is closed — its IP is being told to wait too;
 *   - "no host has ever recorded a read" is UNKNOWN, not blind — a fresh deployment must not
 *     double its request volume on the strength of a row that has not been written yet.
 */
export const DETECTION_FAILOVER_INTERVAL_MS = 15 * 60_000

/** No feed page fetched anywhere for this long means the detection host is blind, not quiet. */
export const DETECTION_FAILOVER_AFTER_MS = 20 * 60_000

export interface FailoverInput {
  /** `detectFeedOkAt` — the last time ANY host fetched a feed page. */
  feedOkAt: Date | null
  /** `detectThrottledUntil` — the server's own recorded cooldown, if it is in the future. */
  serverThrottledUntil: Date | null
  /** This device's anonGate verdict. */
  thisHostGateOpen: boolean
  now: Date
}

export function decideDetectionFailover(input: FailoverInput): { run: boolean; reason: string } {
  if (!input.thisHostGateOpen) {
    return { run: false, reason: 'this machine is in its own anonymous-read cooldown' }
  }
  if (input.serverThrottledUntil && input.serverThrottledUntil.getTime() > input.now.getTime()) {
    return {
      run: true,
      reason: `the detection host is in a cooldown until ${input.serverThrottledUntil.toISOString()}`,
    }
  }
  if (!input.feedOkAt) {
    return { run: false, reason: 'no host has recorded a feed read yet — unknown is not blind' }
  }
  const ageMs = input.now.getTime() - input.feedOkAt.getTime()
  if (ageMs > DETECTION_FAILOVER_AFTER_MS) {
    return { run: true, reason: `no feed page has been read anywhere for ${Math.round(ageMs / 60_000)} minutes` }
  }
  return { run: false, reason: `a feed page was read ${Math.round(ageMs / 60_000)} minutes ago` }
}
