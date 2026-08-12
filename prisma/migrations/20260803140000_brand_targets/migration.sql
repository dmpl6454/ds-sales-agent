-- Brand outreach: resolve @mentions in a paid post to messageable brand accounts.
--
-- Hand-written and purely additive (CREATE TABLE + nullable ADD COLUMN), per
-- DEPLOY-PLAYBOOK.md section 14. `migrate dev` would reset the database because of
-- pre-existing drift on OutreachPair; nothing below rewrites an existing row.

CREATE TABLE "BrandLookup" (
  "handle"      TEXT PRIMARY KEY NOT NULL,
  "kind"        TEXT NOT NULL,
  "category"    TEXT,
  "displayName" TEXT,
  "followers"   INTEGER,
  "checkedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BrandLookup_kind_idx" ON "BrandLookup"("kind");

ALTER TABLE "TargetAccount" ADD COLUMN "discoveredFromCampaignId" TEXT;
ALTER TABLE "TargetAccount" ADD COLUMN "brandCategory" TEXT;
