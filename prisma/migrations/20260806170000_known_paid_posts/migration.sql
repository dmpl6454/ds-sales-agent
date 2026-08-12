-- Ground-truth labels from a person (simple-sender plan §3): 33 shortcodes across 9
-- brands that demonstrably paid Digital Sukoon's network. Stored now so the labels are
-- never lost; they become a second classifier-accuracy harness the day the captions
-- arrive (they cannot be fetched anonymously — measured, four endpoints, all dead).
CREATE TABLE "KnownPaidPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shortcode" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "KnownPaidPost_shortcode_key" ON "KnownPaidPost"("shortcode");
CREATE INDEX "KnownPaidPost_brand_idx" ON "KnownPaidPost"("brand");
