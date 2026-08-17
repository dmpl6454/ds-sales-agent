-- The two kinds of target, made explicit.
--
-- Until now NOTHING stopped a message being addressed to a watched publisher. `routes.ts`
-- had four refusals and none was about what a target IS; `plan.ts` enrolled every
-- non-retired target as a live route. MEASURED the day this was written: @viralbhayani and
-- @madovermarketing_mom — our two COMPETITORS — each held 13 attempts and 4 pairs, with 6
-- drafts waiting to go out.
--
-- Neither obvious mechanism works, and both fail silently:
--
--   `kind = 'CHANNEL'`  is not "watched publisher". importProspects writes messageable
--                       prospects as CHANNEL, so this would have stopped messaging every
--                       imported prospect.
--   `optedOut = true`   short-circuits the FOOTAGE call in judge.ts, so it would have
--                       killed OCR-driven detection on the channel supplying most paid
--                       posts while leaving caption detection running.
--
-- DEFAULT 'PROSPECT' is deliberate: it is what the other host's older client writes for a
-- row it does not know this column exists on, and a row that silently cannot be messaged
-- is drafting stopping with nothing on screen to explain it. The backfill below is in the
-- SAME migration, so there is no window in which the default decides anything.
ALTER TABLE "TargetAccount" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'PROSPECT';

-- Backfill: a CHANNEL whose feed we actually read is a publisher we watch, never write to.
-- This is the ONLY place that derivation is used; from here on the column is authoritative
-- and every creator sets it explicitly.
UPDATE "TargetAccount" SET "role" = 'WATCH' WHERE "kind" = 'CHANNEL' AND "watchEnabled" = true;

-- Our own retired pages are CHANNELs with watching turned off, so the rule above leaves
-- them PROSPECT. They are already refused by routes.ts's `target-is-our-own-page`, but a
-- row that reads "we may message this" about a page we own is a lie waiting to be believed
-- by the next guard somebody writes.
UPDATE "TargetAccount" SET "role" = 'WATCH' WHERE "kind" = 'CHANNEL' AND "optedOut" = true;

CREATE INDEX "TargetAccount_role_idx" ON "TargetAccount"("role");
