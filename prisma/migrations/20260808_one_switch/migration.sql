-- ONE SWITCH (2026-08-08). Tabish: "The moment autopilot is turned on there must be no
-- more switches... The channels which are undecided must also be decided on their own."
--
-- Two consequences of removing the subordinate switches need schema support BEFORE any
-- read of them is removed, which is why this migration lands first.
--
--
-- 1. `SenderAccount.fleetMember` — WHAT STOPS THE BURNER SENDING TO REAL PROSPECTS.
--
-- Until today, three independent things kept @tabishmukaddam1 out of automatic outreach:
-- its own Auto-send switch, the per-route `OutreachPair.enabled` chips, and the safety
-- gate. The first two are being removed. That leaves NOTHING between a throwaway
-- rehearsal account and automatic DMs to real companies — the one-switch decision would
-- otherwise widen exposure as a side effect of simplifying a UI, which is exactly the
-- kind of quiet reversal CLAUDE.md exists to prevent.
--
-- So this is IDENTITY, not a switch: whether an account is part of the fleet at all. No
-- UI toggles it, and it is deliberately NOT the same question as "may this account send"
-- (that is still the gate's). DEFAULT true because every account that predates this
-- column is a real sending account; the one exception is named explicitly below rather
-- than inferred, because a rule that guesses which accounts are tests would eventually
-- guess wrong in the permitting direction.
ALTER TABLE "SenderAccount" ADD COLUMN "fleetMember" BOOLEAN NOT NULL DEFAULT true;
UPDATE "SenderAccount" SET "fleetMember" = false WHERE "handle" = 'tabishmukaddam1';

--
-- 2. `BrandLookup.decidedBy` / `modelConfidence` / `modelReason` — WHO DECIDED, AND WHY.
--
-- The manual "It's a company / Not a company" queue is being replaced by a model
-- resolver, because Instagram's category endpoint fails on precisely the accounts most
-- likely to be brands (Meta's deleted-schema bug: @adidas was unreadable). A model
-- deciding that a handle is a company is a decision that CREATES A PROSPECT and can end
-- in a DM to a real business, so it has to be auditable months later by someone who was
-- not here — which means recording the confidence and the one-line reason, not just the
-- verdict.
--
-- `decidedBy` also keeps the THREE sources distinguishable, and that is the load-bearing
-- part rather than bookkeeping. `verdictSource` exists on posts for the same reason: a
-- `#Collaboration` fact must never be counted alongside a model's opinion. Reading a
-- model's guess as though Instagram had stated it is how a wrong prospect becomes
-- permanent and invisible.
ALTER TABLE "BrandLookup" ADD COLUMN "decidedBy" TEXT;
ALTER TABLE "BrandLookup" ADD COLUMN "modelConfidence" INTEGER;
ALTER TABLE "BrandLookup" ADD COLUMN "modelReason" TEXT;

-- Backfill, in two statements so the two historic sources stay separable.
--
-- A settled row with a category was settled by the ENDPOINT — Instagram told us what the
-- account is and `classifyProfile` read it.
UPDATE "BrandLookup" SET "decidedBy" = 'endpoint'
 WHERE "kind" IN ('BRAND','PERSON') AND "category" IS NOT NULL;

-- A settled row with NO category could not have been settled by the endpoint (that is the
-- whole reason UNRESOLVED exists), so it came from one of the four historic dashboard
-- buttons — a person looked at the enrichment line and decided. Marked 'human' rather
-- than lumped in with 'endpoint', because "a person judged this" and "Instagram stated
-- this" are different kinds of evidence and a single value would erase the difference the
-- moment a third source (the model) starts writing to the same column.
UPDATE "BrandLookup" SET "decidedBy" = 'human'
 WHERE "kind" IN ('BRAND','PERSON') AND "category" IS NULL;

-- Deliberately left NULL: MISSING, UNRESOLVED and UNKNOWN rows. Nothing settled them, and
-- absence of a decision must not harden into a claim that someone made one — the failure
-- shape this codebase has produced four times (a filtered post recorded as ORGANIC, an
-- unreadable profile filed as PERSON, a dead endpoint read as "logged out").
