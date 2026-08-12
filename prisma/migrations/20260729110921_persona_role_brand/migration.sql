/*
  Warnings:

  - You are about to drop the column `personaTitle` on the `SenderAccount` table. All the data in the column will be lost.
  - Added the required column `personaBrand` to the `SenderAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `personaRole` to the `SenderAccount` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "sessionPath" TEXT,
    "sessionSavedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SenderAccount" ("autoSendEnabled", "createdAt", "dailyCap", "displayName", "handle", "id", "personaEmail", "personaName", "personaPhone", "sessionPath", "sessionSavedAt", "status", "updatedAt") SELECT "autoSendEnabled", "createdAt", "dailyCap", "displayName", "handle", "id", "personaEmail", "personaName", "personaPhone", "sessionPath", "sessionSavedAt", "status", "updatedAt" FROM "SenderAccount";
DROP TABLE "SenderAccount";
ALTER TABLE "new_SenderAccount" RENAME TO "SenderAccount";
CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");
CREATE INDEX "SenderAccount_status_idx" ON "SenderAccount"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
