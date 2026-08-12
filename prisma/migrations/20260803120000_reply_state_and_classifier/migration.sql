-- Reply state and classifier provenance.
--
-- Hand-written rather than generated: `migrate dev` wanted to RESET the database
-- because of pre-existing drift on OutreachPair (cooldownDays default 5 -> 7,
-- changed outside migration history). Every change below is purely additive --
-- ADD COLUMN with a default or nullable -- so no existing row is rewritten and no
-- data is lost. This is the flow DEPLOY-PLAYBOOK.md section 14 prescribes for
-- production: diff first, confirm additive, apply by hand.

-- Reply content and per-conversation state.
ALTER TABLE "OutreachAttempt" ADD COLUMN "replyText"      TEXT;
ALTER TABLE "OutreachAttempt" ADD COLUMN "replyCheckedAt" DATETIME;
ALTER TABLE "OutreachAttempt" ADD COLUMN "replyHandledAt" DATETIME;
ALTER TABLE "OutreachAttempt" ADD COLUMN "replyHandledBy" TEXT;

-- Classifier provenance: a rules verdict and a semantic verdict are different
-- claims and must not be presented as the same thing.
ALTER TABLE "DetectedCampaign" ADD COLUMN "verdictSource"    TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "DetectedCampaign" ADD COLUMN "classifierModel"  TEXT;
ALTER TABLE "DetectedCampaign" ADD COLUMN "classifierReason" TEXT;
ALTER TABLE "DetectedCampaign" ADD COLUMN "taggedAccounts"   TEXT NOT NULL DEFAULT '[]';

-- Existing rows: every verdict on disk came from the rule-based detectors
-- (mom) or from passthrough, which classifies nothing. Backfill accordingly so
-- nothing already stored is mistaken for a semantic judgement.
UPDATE "DetectedCampaign" SET "verdictSource" = 'rules'
  WHERE "verdict" IN ('CAMPAIGN', 'ORGANIC', 'REVIEW');
