-- Phase 2: the per-recipient envelope, as a database invariant.
--
-- WHY A TABLE AND NOT A COUNT
--
-- The per-recipient cap is enforced today by counting today's delivered messages and
-- comparing against a limit. That is a CHECK-THEN-ACT: two concurrent runs both count 0,
-- both pass, both send. CLAUDE.md records this exact shape biting twice in one day —
-- `sendNow`'s idempotency and the first slot lock — and the fix both times was the same:
-- put the condition in the WRITE.
--
-- A reservation row does that. To send the Nth message to a recipient today you must
-- first CREATE the row (day, 'target', targetId, N). The unique index makes that succeed
-- exactly once, however many processes try. There is no window between the test and the
-- set, because they are the same statement.
--
-- WHY IT MUST EXIST BEFORE ROTATION
--
-- `cooldownDays` is PER PAIR. With 63 senders rotating through one category, a recipient
-- can be messaged every single day while every individual pair stays comfortably inside
-- its 7-day cooldown — 63 pairs x one message a week is nine messages a day into one
-- inbox, with no rule anywhere broken. Rotation solves sender risk and does nothing for
-- recipient risk. This table is the only thing that closes that, which is why Phase 2
-- lands before Phase 3.
--
-- `attemptId` is nullable and NOT unique: a reservation is made before the send and the
-- attempt is stamped onto it, and a reservation released after a definitely-failed send
-- is deleted rather than left holding a slot. A cap that counts failures would silently
-- become a cap on ATTEMPTS rather than on messages received.

CREATE TABLE "DailyReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- IST day key, "2026-08-04". IST because every other date boundary here is IST.
    "day" TEXT NOT NULL,
    -- 'target' | 'sender' | 'fleet'. One table, because Phase 5's fleet-wide per-hour
    -- reservations are the same mechanism asked a different question.
    "scope" TEXT NOT NULL,
    -- The target id, the sender id, or the literal 'fleet'.
    "subjectId" TEXT NOT NULL,
    -- 1-based position within the day's allowance. THE UNIQUE PART.
    "seq" INTEGER NOT NULL,
    "attemptId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "DailyReservation_day_scope_subjectId_seq_key"
    ON "DailyReservation"("day", "scope", "subjectId", "seq");

-- Looked up when an attempt is retried, so a second try reuses its own reservation
-- rather than consuming another slot of the recipient's daily allowance.
CREATE INDEX "DailyReservation_attemptId_idx" ON "DailyReservation"("attemptId");
CREATE INDEX "DailyReservation_day_scope_subjectId_idx" ON "DailyReservation"("day", "scope", "subjectId");
