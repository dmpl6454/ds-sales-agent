-- What OCR read off the post's cover frame, one line, for the review queue.
-- Read locally and free (Apple Vision); NULL means no frame was read, which is NOT
-- the same as "the footage was clean" -- see the schema comment and the frame:* signals.
ALTER TABLE "DetectedCampaign" ADD COLUMN "frameText" TEXT;
