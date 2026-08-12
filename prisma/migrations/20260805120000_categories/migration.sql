-- Phase 3: categories, and rotation derived from history.
--
-- A category groups senders that are interchangeable for a kind of recipient — the first
-- is "Bollywood/Celebs". Per target, each successive paid post is pitched by the NEXT
-- sender in that category, never the same one twice in a row, wrapping forever.
--
-- WHY MEMBERSHIP IS A TABLE AND NOT A COLUMN
--
-- A sender can plausibly belong to more than one category later (a Bollywood page that
-- also fits "Fashion"), and a column would force that to be a schema change. More
-- importantly `position` has to live somewhere: rotation needs a STABLE ORDER, and
-- ordering by handle would reshuffle the ring every time an account is renamed.
--
-- WHY THERE IS NO CURSOR COLUMN HERE
--
-- Rotation is DERIVED from OutreachAttempt — "who sent the most recent message to this
-- target, and who comes after them" — not stored. A cursor is a second source of truth
-- that can drift from the send history, and this codebase has been bitten by exactly
-- that: `repliedAt` was read in six places and written in none, and the guard depending
-- on it had never once fired. Derived state cannot disagree with reality because it IS
-- reality, read back.
--
-- `enabled` on membership rather than deletion: removing a sender from a category must
-- not lose the record that it used to be in one, because the send history that rotation
-- reads is interpreted against that membership.

CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    -- Editable from the UI at runtime; a category is a business grouping, not a constant.
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

CREATE TABLE "CategorySender" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    -- The ring order. Stable across renames, which ordering by handle would not be.
    "position" INTEGER NOT NULL DEFAULT 0,
    -- Suspended rather than deleted: the send history rotation reads is interpreted
    -- against this membership, so losing it would rewrite the past.
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategorySender_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CategorySender_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CategorySender_categoryId_senderId_key" ON "CategorySender"("categoryId", "senderId");
CREATE INDEX "CategorySender_categoryId_position_idx" ON "CategorySender"("categoryId", "position");

CREATE TABLE "CategoryTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategoryTarget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CategoryTarget_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CategoryTarget_categoryId_targetId_key" ON "CategoryTarget"("categoryId", "targetId");
CREATE INDEX "CategoryTarget_targetId_idx" ON "CategoryTarget"("targetId");
