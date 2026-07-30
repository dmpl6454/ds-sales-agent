-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OutreachPair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "cooldownDays" INTEGER NOT NULL DEFAULT 5,
    "maxUnansweredTouches" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bespokeBody" TEXT,
    "bespokeNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutreachPair_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "SenderAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutreachPair_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TargetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OutreachPair" ("bespokeBody", "bespokeNote", "cooldownDays", "createdAt", "enabled", "id", "senderId", "targetId", "updatedAt") SELECT "bespokeBody", "bespokeNote", "cooldownDays", "createdAt", "enabled", "id", "senderId", "targetId", "updatedAt" FROM "OutreachPair";
DROP TABLE "OutreachPair";
ALTER TABLE "new_OutreachPair" RENAME TO "OutreachPair";
CREATE INDEX "OutreachPair_enabled_idx" ON "OutreachPair"("enabled");
CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key" ON "OutreachPair"("senderId", "targetId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
