-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "personaRole" TEXT NOT NULL,
    "personaBrand" TEXT NOT NULL,
    "personaPhone" TEXT NOT NULL,
    "personaEmail" TEXT NOT NULL,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyCap" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "challengedAt" TIMESTAMP(3),
    "cohort" INTEGER NOT NULL DEFAULT 1,
    "sessionPath" TEXT,
    "sessionSavedAt" TIMESTAMP(3),
    "sessionInvalidAt" TIMESTAMP(3),
    "sessionInvalidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetAccount" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachPair" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "maxUnansweredTouches" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bespokeBody" TEXT,
    "bespokeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectedCampaign" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caption" TEXT NOT NULL,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "mediaType" TEXT,
    "brands" TEXT NOT NULL DEFAULT '[]',
    "signals" TEXT NOT NULL DEFAULT '[]',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL,
    "humanLabel" BOOLEAN,
    "labelledBy" TEXT,
    "labelledAt" TIMESTAMP(3),
    "verdictSource" TEXT NOT NULL DEFAULT 'none',
    "classifierModel" TEXT,
    "classifierReason" TEXT,
    "taggedAccounts" TEXT NOT NULL DEFAULT '[]',
    "rawPayload" TEXT,
    "frameText" TEXT,

    CONSTRAINT "DetectedCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campaignId" TEXT,
    "variantId" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "hookLine" TEXT,
    "renderedBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "threadUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "repliedAt" TIMESTAMP(3),
    "replyText" TEXT,
    "replyCheckedAt" TIMESTAMP(3),
    "replyHandledAt" TIMESTAMP(3),
    "replyHandledBy" TEXT,

    CONSTRAINT "OutreachAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "subject" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageVariant" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "postsSeen" INTEGER NOT NULL DEFAULT 0,
    "newPosts" INTEGER NOT NULL DEFAULT 0,
    "detected" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "detail" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleFeedback" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "wasActuallyPaid" BOOLEAN NOT NULL,
    "labelledBy" TEXT NOT NULL,
    "labelledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "RuleFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandLookup" (
    "handle" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT,
    "displayName" TEXT,
    "followers" INTEGER,
    "enrichment" TEXT,
    "reachable" BOOLEAN,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandLookup_pkey" PRIMARY KEY ("handle")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "DailyReservation" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "attemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorySender" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorySender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryTarget" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnownPaidPost" (
    "id" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownPaidPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");

-- CreateIndex
CREATE INDEX "SenderAccount_status_idx" ON "SenderAccount"("status");

-- CreateIndex
CREATE INDEX "SenderAccount_status_challengedAt_idx" ON "SenderAccount"("status", "challengedAt");

-- CreateIndex
CREATE INDEX "SenderAccount_cohort_idx" ON "SenderAccount"("cohort");

-- CreateIndex
CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");

-- CreateIndex
CREATE INDEX "TargetAccount_kind_idx" ON "TargetAccount"("kind");

-- CreateIndex
CREATE INDEX "TargetAccount_kind_watchEnabled_idx" ON "TargetAccount"("kind", "watchEnabled");

-- CreateIndex
CREATE INDEX "OutreachPair_enabled_idx" ON "OutreachPair"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key" ON "OutreachPair"("senderId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "DetectedCampaign_shortcode_key" ON "DetectedCampaign"("shortcode");

-- CreateIndex
CREATE INDEX "DetectedCampaign_targetId_postedAt_idx" ON "DetectedCampaign"("targetId", "postedAt");

-- CreateIndex
CREATE INDEX "DetectedCampaign_verdict_idx" ON "DetectedCampaign"("verdict");

-- CreateIndex
CREATE INDEX "DetectedCampaign_detectedAt_idx" ON "DetectedCampaign"("detectedAt");

-- CreateIndex
CREATE INDEX "OutreachAttempt_pairId_sentAt_idx" ON "OutreachAttempt"("pairId", "sentAt");

-- CreateIndex
CREATE INDEX "OutreachAttempt_status_idx" ON "OutreachAttempt"("status");

-- CreateIndex
CREATE INDEX "OutreachAttempt_sentAt_idx" ON "OutreachAttempt"("sentAt");

-- CreateIndex
CREATE INDEX "OutreachAttempt_targetId_sentAt_idx" ON "OutreachAttempt"("targetId", "sentAt");

-- CreateIndex
CREATE INDEX "OutreachAttempt_senderId_sentAt_idx" ON "OutreachAttempt"("senderId", "sentAt");

-- CreateIndex
CREATE INDEX "OutreachAttempt_targetId_status_idx" ON "OutreachAttempt"("targetId", "status");

-- CreateIndex
CREATE INDEX "ModelCall_at_idx" ON "ModelCall"("at");

-- CreateIndex
CREATE INDEX "ModelCall_purpose_at_idx" ON "ModelCall"("purpose", "at");

-- CreateIndex
CREATE INDEX "MessageVariant_senderId_targetKind_lastUsedAt_idx" ON "MessageVariant"("senderId", "targetKind", "lastUsedAt");

-- CreateIndex
CREATE INDEX "ScrapeRun_startedAt_idx" ON "ScrapeRun"("startedAt");

-- CreateIndex
CREATE INDEX "ScrapeRun_status_idx" ON "ScrapeRun"("status");

-- CreateIndex
CREATE INDEX "RuleFeedback_campaignId_idx" ON "RuleFeedback"("campaignId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_entity_idx" ON "AuditLog"("entity");

-- CreateIndex
CREATE INDEX "BrandLookup_kind_idx" ON "BrandLookup"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "DailyReservation_attemptId_idx" ON "DailyReservation"("attemptId");

-- CreateIndex
CREATE INDEX "DailyReservation_day_scope_subjectId_idx" ON "DailyReservation"("day", "scope", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReservation_day_scope_subjectId_seq_key" ON "DailyReservation"("day", "scope", "subjectId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "CategorySender_categoryId_position_idx" ON "CategorySender"("categoryId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CategorySender_categoryId_senderId_key" ON "CategorySender"("categoryId", "senderId");

-- CreateIndex
CREATE INDEX "CategoryTarget_targetId_idx" ON "CategoryTarget"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryTarget_categoryId_targetId_key" ON "CategoryTarget"("categoryId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "KnownPaidPost_shortcode_key" ON "KnownPaidPost"("shortcode");

-- CreateIndex
CREATE INDEX "KnownPaidPost_brand_idx" ON "KnownPaidPost"("brand");

-- AddForeignKey
ALTER TABLE "OutreachPair" ADD CONSTRAINT "OutreachPair_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachPair" ADD CONSTRAINT "OutreachPair_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectedCampaign" ADD CONSTRAINT "DetectedCampaign_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "OutreachPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "DetectedCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MessageVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageVariant" ADD CONSTRAINT "MessageVariant_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySender" ADD CONSTRAINT "CategorySender_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySender" ADD CONSTRAINT "CategorySender_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryTarget" ADD CONSTRAINT "CategoryTarget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryTarget" ADD CONSTRAINT "CategoryTarget_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

