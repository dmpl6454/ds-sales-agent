-- Phase 5: the paced dispatcher needs to know WHEN an account was flagged, not just that
-- it is flagged.
--
-- The circuit breaker halts the WHOLE fleet when any account has been challenged recently:
-- every sender drives the same code path from the same residential IP with the same
-- behavioural signature, so a checkpoint on one is evidence about the pattern, not about
-- that account. Continuing to push the other 64 through it is the retry-into-enforcement
-- mistake at fleet scale.
--
-- A breaker keyed on the mere EXISTENCE of a CHALLENGED row could never be released except
-- by clearing it, and "a hard stop with no release is a bug wearing a safety feature's
-- clothes" is this project's own lesson — learned when the first reply retired a channel
-- permanently. With a timestamp there are two releases: a human clears the halt (the good
-- one), or the window passes (the fallback). The flagged account itself stays halted either
-- way; that stop is separate and is not on a timer.
--
-- Nullable and additive. No table rebuild: SQLite's ALTER TABLE ADD COLUMN is in-place.
--
-- Nothing to backfill — verified before writing this: all four senders are ACTIVE, so there
-- is no CHALLENGED row whose timestamp would be unknown. `assessFleetBreaker` still treats a
-- CHALLENGED account with a NULL challengedAt as recent rather than as old, because absence
-- of data must never harden into the permissive verdict.
ALTER TABLE "SenderAccount" ADD COLUMN "challengedAt" DATETIME;

-- Every code path that writes CHALLENGED must write this too, or the breaker silently
-- under-counts and permits. That is enforced in one place: `markChallenged` in
-- src/outreach/challenge.ts, which all four call sites now use.
CREATE INDEX "SenderAccount_status_challengedAt_idx" ON "SenderAccount"("status", "challengedAt");
