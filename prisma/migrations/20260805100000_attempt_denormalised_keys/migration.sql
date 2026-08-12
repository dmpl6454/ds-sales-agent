-- Phase 1: who a message went TO and FROM, on the message itself.
--
-- WHY DENORMALISE AT ALL
--
-- `OutreachAttempt` only knows its `pairId`. Every question rotation and the
-- per-recipient cap ask is "what has this TARGET received today, from anyone" or "what
-- has this SENDER sent today, to anyone" — both of which currently require joining
-- through `OutreachPair`. At 31 pairs that is free. At 65 senders x 60 targets it is
-- 3,900 pairs and the planner already runs ~7 awaits per pair per slot (~27,300 queries),
-- which measurement identified as the real bottleneck rather than storage size.
--
-- WHY NOT NULL, AND WHY THAT NEEDS A TABLE REBUILD
--
-- SQLite cannot add a NOT NULL column without a default, and a sentinel default ('') is
-- a lie the moment a code path forgets to set the real value. That matters more here than
-- usual: a NULL `targetId` does not fail loudly, it silently drops the row out of every
-- per-recipient query — so the per-recipient cap would under-count and permit an extra
-- message to a real person. "Absence of data hardening into a wrong answer" is this
-- codebase's most repeated failure, and the fix is to make absence impossible.
--
-- So this is the standard SQLite 12-step rebuild rather than an ADD COLUMN. It is still
-- applied with `migrate deploy`, never `migrate dev` (which wants to RESET this database).
-- Every column and index is reproduced below; the two new ones are backfilled from the
-- pair each row already points at, so no existing row can come out NULL.
--
-- The rebuild is also what lets `targetId`/`senderId` carry real foreign keys, so a
-- deleted target cannot leave an attempt pointing at nothing.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campaignId" TEXT,
    "variantId" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "hookLine" TEXT,
    "renderedBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "sentBy" TEXT,
    "threadUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "repliedAt" DATETIME,
    "replyText" TEXT,
    "replyCheckedAt" DATETIME,
    "replyHandledAt" DATETIME,
    "replyHandledBy" TEXT,
    CONSTRAINT "OutreachAttempt_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "OutreachPair" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "DetectedCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutreachAttempt_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MessageVariant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Backfilled from the pair, so every existing row gets its real sender and target.
INSERT INTO "new_OutreachAttempt" (
    "id", "pairId", "senderId", "targetId", "campaignId", "variantId", "touchNumber",
    "hookLine", "renderedBody", "status", "queuedAt", "sentAt", "sentBy", "threadUrl",
    "error", "attempts", "failureCode", "repliedAt", "replyText", "replyCheckedAt",
    "replyHandledAt", "replyHandledBy"
)
SELECT
    a."id", a."pairId", p."senderId", p."targetId", a."campaignId", a."variantId",
    a."touchNumber", a."hookLine", a."renderedBody", a."status", a."queuedAt", a."sentAt",
    a."sentBy", a."threadUrl", a."error", a."attempts", a."failureCode", a."repliedAt",
    a."replyText", a."replyCheckedAt", a."replyHandledAt", a."replyHandledBy"
FROM "OutreachAttempt" a
JOIN "OutreachPair" p ON p."id" = a."pairId";

DROP TABLE "OutreachAttempt";
ALTER TABLE "new_OutreachAttempt" RENAME TO "OutreachAttempt";

-- The indexes that existed before...
CREATE INDEX "OutreachAttempt_pairId_sentAt_idx" ON "OutreachAttempt"("pairId", "sentAt");
CREATE INDEX "OutreachAttempt_status_idx" ON "OutreachAttempt"("status");
CREATE INDEX "OutreachAttempt_sentAt_idx" ON "OutreachAttempt"("sentAt");

-- ...and the ones rotation and the per-recipient cap need. Nothing indexed
-- OutreachAttempt by target, which is the single most common query the fleet will make:
-- "what has this recipient been sent today, by anyone".
CREATE INDEX "OutreachAttempt_targetId_sentAt_idx" ON "OutreachAttempt"("targetId", "sentAt");
CREATE INDEX "OutreachAttempt_senderId_sentAt_idx" ON "OutreachAttempt"("senderId", "sentAt");
CREATE INDEX "OutreachAttempt_targetId_status_idx" ON "OutreachAttempt"("targetId", "status");

PRAGMA foreign_keys=ON;

-- ── ModelCall: what generation actually costs ─────────────────────────────
--
-- Phase 8 generates a message per post. Today the only record of model spend is a number
-- printed by `ig:classify` and then lost, so "is this getting expensive" is unanswerable
-- after the fact. The classifier writes here too, because the same question applies to it
-- and one table answering it for both is better than two half-answers.
--
-- `cachedInputTokens` is separate from `inputTokens` deliberately: DeepSeek's cached input
-- is $0.0028/1M against $0.14/1M — FIFTY TIMES cheaper — so a cache hit rate that quietly
-- drops is a fifty-fold cost increase that shows up nowhere else. Interpolating anything
-- into the system prompt is what breaks it, and the only way to notice is to record the
-- split.
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 'classify' | 'generate' | 'quality' — what the call was FOR, not which model.
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    -- What it was about, when there is one. Free text; never parsed back into logic.
    "subject" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    -- A FAILED call is recorded too. A call that errored still cost latency, and a rising
    -- failure rate is exactly the thing a cost table would otherwise hide by omission.
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT
);

CREATE INDEX "ModelCall_at_idx" ON "ModelCall"("at");
CREATE INDEX "ModelCall_purpose_at_idx" ON "ModelCall"("purpose", "at");
