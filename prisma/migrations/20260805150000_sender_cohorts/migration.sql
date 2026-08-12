-- Phase 9: 61 new sending accounts arrive as a COHORT LADDER, not a bulk import.
--
-- This is the phase that actually changes exposure. Everything before it made the system
-- safer at four accounts; this multiplies the number of real Instagram business assets the
-- automation touches by sixteen, and each of the 61 needs a hand login that writes device
-- identity which cannot be rebuilt.
--
-- The ladder is the whole safety mechanism: a few accounts go live, they are WATCHED for a
-- stated period, and only then may the next few be armed. The alternative — arming 61
-- accounts and finding out together — is the shape of failure this project has spent its
-- entire history designing against.
--
-- ONE COLUMN, and the soak is DERIVED rather than stored. `cohort` records which group an
-- account belongs to; how long that group has been sending, and whether anything went wrong,
-- is computed from `OutreachAttempt` and `SenderAccount.challengedAt`. That follows Phase 3's
-- decision that rotation state is derived from send history rather than held in a cursor —
-- a stored "cohort 2 cleared on the 12th" can drift from what actually happened, and this
-- codebase has been bitten by exactly that.
--
-- DEFAULT 1, so every existing account is cohort 1. That is honest: the four accounts that
-- exist today are the baseline the ladder measures against, and one of them has done every
-- send so far.
ALTER TABLE "SenderAccount" ADD COLUMN "cohort" INTEGER NOT NULL DEFAULT 1;

-- The ladder reads "every sender in cohort N" on every arming decision and on every
-- dashboard render of /accounts.
CREATE INDEX "SenderAccount_cohort_idx" ON "SenderAccount"("cohort");
