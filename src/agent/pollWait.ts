/**
 * HOW LONG THE LOOP WAITS BEFORE THE NEXT TICK. PURE, so the rule is tested rather than trusted.
 *
 * After a tick that DROVE a browser the loop sleeps only the remainder of its 30 s grid — a ~47 s
 * send leaves nothing to wait for, and the dispatcher's own gap refusal is what paces the fleet
 * (the 77 s period fix of 21-22 August). That reasoning is about sends, and it was applied to
 * every tick. MEASURED in the 9 October audit: with the queue all held (the documented steady
 * state) one tick walks every draft through the gate UNDER the fleet lock, which over the tunnel
 * takes longer than 30 s, so the remainder was negative, the next tick started at once, and the
 * dispatcher held the lock nearly continuously. The reply sweep and disk care in the same process
 * poll for that lock and are refused while it is held, so they ran only when a tick happened to
 * end inside one of their polls. A tick that drove nothing therefore waits the FULL interval, which
 * is what leaves the lock free for them. A thrown tick counts as one that drove nothing, so a
 * failure that takes a long time to surface cannot become a hot loop either.
 *
 * `retryInMs` still wins when it is sooner — a `too-soon` boundary or a busy lock — because a
 * hint may only ever wake the loop EARLIER, never later.
 */
export function nextPollWait(args: {
  pollMs: number
  elapsedMs: number
  drove: boolean
  retryInMs?: number
}): number {
  const grid = args.drove ? Math.max(args.pollMs - args.elapsedMs, 0) : args.pollMs
  return args.retryInMs !== undefined ? Math.min(grid, Math.max(args.retryInMs, 0)) : grid
}
