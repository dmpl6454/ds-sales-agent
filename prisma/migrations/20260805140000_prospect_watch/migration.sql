-- Phase 7: a prospect can be messaged without being scraped four times a day.
--
-- Detection currently reads EVERY `kind = 'CHANNEL'` target, four pages each, four times a
-- day. At four channels that is 16 requests a slot and it has been measured healthy: 48/48
-- HTTP 200, median 1090ms. A provided list of 60 prospects makes it ~240 requests a slot
-- and ~1,000 a day against an anonymous, undocumented endpoint whose only current risk is
-- IP rate limiting — and it would buy almost nothing, because a cold first touch does not
-- need a hook from the recipient's own feed.
--
-- So watching is now a separate decision from messaging. `addTarget` still creates watched
-- channels (that is what a channel IS), and imported prospects arrive unwatched. Turning
-- watch on is one toggle, per target, when a prospect is worth following.
--
-- DEFAULT true, deliberately: every existing row is a channel that IS watched today, so
-- the default preserves current behaviour exactly. A default of false would silently stop
-- detection on both real channels the moment this migration ran — the kind of change that
-- looks like nothing happening.
ALTER TABLE "TargetAccount" ADD COLUMN "watchEnabled" BOOLEAN NOT NULL DEFAULT true;

-- What the detection pipeline asks on every slot, once the target list is 60 rows instead
-- of four.
CREATE INDEX "TargetAccount_kind_watchEnabled_idx" ON "TargetAccount"("kind", "watchEnabled");

-- Where this prospect came from, for the audit trail. `discoveredFromCampaignId` already
-- answers it for brands found in paid posts; nothing answered it for a pasted list, and
-- "why is this company in our database?" is a question that gets asked months later.
ALTER TABLE "TargetAccount" ADD COLUMN "importNote" TEXT;
