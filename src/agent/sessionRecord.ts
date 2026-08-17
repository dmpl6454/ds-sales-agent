/**
 * PURE — the decision behind `reconcileSessionRecords` (src/agent/reconcile.ts), kept
 * free of the prisma import so the test exercises the rule without a database client.
 *
 * May the device agent record a login for this sender? True only when all three hold:
 * the disk on THIS machine holds a session, the database records no login, and nothing
 * has proven a session dead. The third conjunct is the direction that must fail closed:
 * `sessionInvalidAt` clears only on PROOF — an identity-verified login or a delivered
 * send (§3.5) — and a cookie surviving on disk is exactly the evidence that mark exists
 * to overrule.
 */
export interface SenderSessionFacts {
  sessionPath: string | null
  sessionInvalidAt: Date | null
}

export function needsSessionRecord(s: SenderSessionFacts, hasSessionOnDisk: boolean): boolean {
  return hasSessionOnDisk && s.sessionPath === null && s.sessionInvalidAt === null
}
