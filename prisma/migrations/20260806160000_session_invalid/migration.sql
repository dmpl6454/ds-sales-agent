-- THE LOGGED-OUT ACCOUNT (simple-sender plan §3.5).
--
-- `profileStatus().hasSession` is a filesystem check — does a `sessionid` cookie exist on
-- disk. Instagram revokes server-side, invisibly, so the cookie survives while every send
-- fails with "not logged in". Verified live 2026-08-06 on @tabishmukaddam1: dashboard said
-- "connected", two real sends failed, nothing was written anywhere, and the paced
-- dispatcher kept driving a browser at the dead session every fifteen minutes with the
-- circuit breaker silent (it watches `challenged` and `not-in-thread`, not login failures).
--
-- The fix is to RECORD THE EVIDENCE, never to poll: a send already proved the session is
-- dead, so a liveness probe on page render would re-learn it by driving a browser (~10 MB
-- of profile cache per session, measured). These two columns are that record.
--
-- Written ONLY through `markSessionInvalid` — one writer, like `markChallenged` and
-- `challengedAt`. Cleared only by proof: an identity-verified hand login, or a delivered
-- send. The gate then folds it into the EXISTING `no-session` stop as an input, so no new
-- rule is added and the stop inventory keeps its shape.
ALTER TABLE "SenderAccount" ADD COLUMN "sessionInvalidAt" DATETIME;
ALTER TABLE "SenderAccount" ADD COLUMN "sessionInvalidReason" TEXT;
