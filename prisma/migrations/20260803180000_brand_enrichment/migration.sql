-- Facts about brand handles Instagram's category endpoint will not serve.
--
-- Hand-written and additive (nullable ADD COLUMN only), per CLAUDE.md's migration rule:
-- `prisma migrate dev` wants to RESET this database because of pre-existing drift on
-- OutreachPair, so migrations are written by hand and applied with `migrate deploy`.
--
-- WHY THESE COLUMNS EXIST
--
-- Meta deleted the schema behind `ig_business_category_subvertical`, so
-- users/web_profile_info returns HTTP 400 for accounts that HAVE a business category —
-- precisely the accounts most likely to be brands. 18 of 19 UNRESOLVED handles turned out
-- to be live professional accounts hidden by that bug, including @tilara.india,
-- @netflix_in, @tseries.official and @fastrackworld.
--
-- These hold FACTS, not a verdict. Measured 2026-08-03: @tilara.india (a brand) and
-- @adityathackeray (a politician) produce the IDENTICAL enrichment string —
-- "professional account · verified" — because the only field that separates a buyer from
-- talent is `category_name`, and it exists on exactly one endpoint: the broken one.
--
-- So `enrichment` is never parsed back into a classification. Any rule over it would file
-- every verified actor and politician in a film-promotion caption as a media buyer, which
-- is the @bharat_reshma mistake automated and at scale. A confident wrong answer is worse
-- than a visible gap: the gap gets looked at, the wrong answer gets messaged.

ALTER TABLE "BrandLookup" ADD COLUMN "enrichment" TEXT;
ALTER TABLE "BrandLookup" ADD COLUMN "reachable" BOOLEAN;
