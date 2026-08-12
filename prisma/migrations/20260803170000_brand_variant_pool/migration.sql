-- Brand outreach: a separate message pool for brands, and a cap on new brand touches.
--
-- Hand-written and additive, per the migration rule in CLAUDE.md: `prisma migrate dev`
-- wants to RESET this database because of pre-existing drift on OutreachPair, so
-- migrations are written by hand and applied with `migrate deploy`.
--
-- WHY targetKind EXISTS
--
-- Variant selection in plan.ts is `where: { senderId, enabled: true }`, least-recently-
-- used. Keyed on the SENDER only — so without a discriminator the channel pool and the
-- brand pool are one pool, and the LRU would eventually hand a media-buying pitch to
-- @madovermarketing_mom and a publisher-partnership pitch to Royal Canin. Nothing would
-- report a problem; the message would simply be addressed to the wrong kind of reader.
--
-- DEFAULT 'CHANNEL' is load-bearing: all 48 existing variants are channel copy, and an
-- ADD COLUMN with a default rewrites nothing. Every pre-existing row keeps its meaning.

ALTER TABLE "MessageVariant" ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL';

-- The old index is a prefix of the new one, so it earns nothing once this exists.
DROP INDEX IF EXISTS "MessageVariant_senderId_lastUsedAt_idx";
CREATE INDEX "MessageVariant_senderId_targetKind_lastUsedAt_idx"
  ON "MessageVariant"("senderId", "targetKind", "lastUsedAt");

-- MAX_NEW_BRAND_TOUCHES_PER_DAY, as a Setting so it is editable without a redeploy.
--
-- Separate from SenderAccount.dailyCap on purpose, and the distinction is the point:
-- dailyCap protects the ACCOUNT (Instagram's per-sender spam heuristics), this protects
-- the PATTERN. Today the target list is two channels; after brand discovery it grows
-- with every paid post, forever — roughly 20 new prospects a month. A burst of first
-- touches to strangers reads differently from a steady drip, even at identical volume.
--
-- 2/day, chosen by Tabish. At ~20 discovered per month the queue drains faster than it
-- fills, so queue depth on the dashboard stays a real signal rather than decoration.
INSERT OR IGNORE INTO "Setting" ("key", "value", "updatedAt")
VALUES ('maxNewBrandTouchesPerDay', '2', CURRENT_TIMESTAMP);
