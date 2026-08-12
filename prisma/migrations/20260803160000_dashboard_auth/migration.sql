-- Dashboard authentication: operators sign in before they can reach anything.
--
-- Hand-written and purely additive (CREATE TABLE only), per the migration rule in
-- CLAUDE.md's gotchas and docs/HANDOFF.md: `prisma migrate dev` wants to RESET this
-- database because of pre-existing drift on OutreachPair, so migrations are written by
-- hand and applied with `migrate deploy`. Nothing below touches an existing row.
--
-- These tables hold DASHBOARD credentials, not Instagram ones. This repo still stores
-- no Instagram password anywhere; the send path drives a Chrome profile that was
-- logged into by hand. What this closes is different: there was no middleware.ts and
-- 18 server actions were exported, so anything that could reach the port could send a
-- DM from a revenue account.
--
-- Both hashes below are hashes on purpose:
--   User.passwordHash   scrypt, so a database read cannot recover the password.
--   Session.tokenHash   SHA-256, so a database read cannot recover a live session.
-- A session token is a bearer credential exactly like Instagram's `sessionid` — the
-- same reason this project refuses cookie transplants applies to our own tokens.

CREATE TABLE "User" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Session" (
  "tokenHash" TEXT PRIMARY KEY NOT NULL,
  "userId"    TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
