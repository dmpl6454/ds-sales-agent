#!/usr/bin/env bash
# official-caption-probe.sh — READ-ONLY. Run on the box (the server), as root, as a FILE (one line; it does not paste):
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<commit>/scripts/official-caption-probe.sh -o /tmp/ocp.sh && bash /tmp/ocp.sh
#
#   bash /tmp/ocp.sh          every section
#   bash /tmp/ocp.sh 3        one section (1 to 5) — the box's console scrolls back about one screen
#   bash /tmp/ocp.sh 3 4      several
#   DS_READ_SKIP=25 bash /tmp/ocp.sh 4         section 4's NEXT 25 rows (it prints 25 at a time)
#   DS_STEP_LIMIT=10min bash /tmp/ocp.sh 3     allow each query longer than the default 120s
#   bash /tmp/ocp.sh | grep '^-- '             THE SHORT ANSWER: the first line, one line each for sections 2, 3 and 5,
#                                              and "-- end" or "-- STOPPED". Run this first; it fits on one screen
#
# WHY (25 Nov 2026). Since 15 Oct posts reach us through Meta's official read (Business Discovery), which carries no
# tags and no collaborators. src/detection/graphFeed.ts also says its captions come with the "@" removed — FROM META'S
# DOCUMENTATION, never checked against a stored caption. A follow-up needs a new paid post that names a company we
# already hold, and today a post names a company only through a tag, an "@handle" in the caption, or a brand string
# equal to the company's name (src/outreach/materialAllowance.ts). If the "@" is gone but the handle is still there as
# a bare word, paid posts are naming companies we hold and funding nothing. This measures that from the database:
#
#   1. per IST day (last 14): posts stored through the official read and through the anonymous read, and how many of
#      each were judged CAMPAIGN
#   2. the "@" question: how many official-read captions of the last 14 days still carry an "@", against the same
#      channels' anonymous-read captions from 15 Sep-14 Oct 2026 (the 30 days before the anonymous read was walled);
#      up to 5 examples; one line of conclusion
#   3. bare handles: official-read CAMPAIGN posts of the last 72 hours / 7 days / 14 days crossed with every live
#      verified company — the caption holds the company's handle as a standalone word, and today's rule does not
#      credit the post to that company through an "@handle" or a tag. Then, for the same posts, how many "@handle"
#      mentions today's rule does credit, and how many it sees and does not (a full stop after, or letter case)
#   4. 25 of those matches to READ, shortest handle first — a person judges whether they are real mentions
#   5. what counting them could release, for the 72-hour window (the only posts that can still fund a follow-up)
#
# THE RULES, exactly (change them here and in the labels together):
#   official read     the row's rawPayload contains the bytes "evidenceIncomplete":true (EVIDENCE_INCOMPLETE_MARKER,
#                     src/detection/evidence.ts). A row loses the marker when the anonymous feed later re-reads the
#                     post whole, so "anonymous read" here means "no marker now".
#   live verified     TargetAccount role PROSPECT, optedOut false, isVerified true.
#   standalone word   the handle, any letter case, NOT preceded by a letter, digit, "_", ".", "#", "@" or "/", and NOT
#                     followed by a letter, digit or "_", nor by a "." that is itself followed by a letter or digit.
#                     So "#zee5", "@zee5", "zee5.com", "x/zee5" and "zee5_marathi" are not the word zee5; "zee5." is.
#                     Letters are a-z only: a handle touching a non-Latin letter counts as standalone.
#   credited today    what campaignsNamingHandleRows does on Postgres: the row passes its database prefilter (the
#                     caption contains "@handle" in the stored letter case, or the tags contain "handle", or the post
#                     has any brand string) AND (the caption has "@handle" ending at a non-handle character, any case
#                     · a tag equals the handle · a brand string equals the company's name or handle, squashed, with
#                     at most one of india/official/ind/in stripped from the company side).
#                     The prefilter is modelled as a plain substring test, which is how Prisma's `contains` reads on
#                     Postgres; that is from the code and its comments, not from a query log.
#   "@handle" whole   an "@" straight before the handle, and the handle ends the way a standalone word may end. Today's
#                     own test is narrower: it refuses "@handle." (a full stop after), and its prefilter refuses
#                     "@Handle" in another letter case on a post with no brand string. Section 3 counts both.
#   distinctive       a handle of 8 or more characters, or one containing a digit, "_" or ".". The rest are short
#                     plain words (vibe, toxic, tips, ace) and are reported apart: likely an ordinary word.
#   person            BrandLookup says kind PERSON for that handle.
#   windows           by postedAt, as the planner counts: 72 hours is HOOK_MAX_AGE_HOURS's default and 7 days is
#                     DEFAULT_COOLDOWN_DAYS's. The app's .env is not read here; section 5 prints the Setting rows.
#
# It writes nothing (every statement runs inside BEGIN READ ONLY), reads through the local postgres superuser rather
# than the app's DATABASE_URL, and prints no secret — captions are public posts. Needs Postgres 16
# (pg_input_is_valid, regexp_instr); it says so and stops on anything older.
set -euo pipefail

# A failed step must not look like a finished run: the output is often filtered for its '-- ' lines, which would hide
# psql's own error. Installed before anything can exit.
SAID=""
trap 'rc=$?; if [[ $rc -ne 0 && -z "$SAID" ]]; then echo "-- STOPPED (exit $rc): a query did not finish. Its error is on the lines just above this one, and nothing after it ran. If it says statement timeout, run again with DS_STEP_LIMIT=10min in front (spelled exactly like that)."; fi' EXIT
stop() { echo "-- STOPPED: $1"; SAID=1; exit 2; }

# Zero is refused: to Postgres a zero timeout means NO limit. So is a leading zero: Postgres reads 010min as octal.
STEP_LIMIT="${DS_STEP_LIMIT:-120s}"
[[ "$STEP_LIMIT" =~ ^[1-9][0-9]*(ms|s|min|h)$ ]] || stop "DS_STEP_LIMIT must be a whole number above zero, with no leading zero, followed by ms, s, min or h — for example 120s, 10min or 1h. Got: $STEP_LIMIT"

# Section 4 prints 25 rows; this skips that many first, to read further down the list.
READ_SKIP="${DS_READ_SKIP:-0}"
[[ "$READ_SKIP" =~ ^(0|[1-9][0-9]{0,5})$ ]] || stop "DS_READ_SKIP must be a whole number from 0 to 999999 — for example 25. Got: $READ_SKIP"

for a in "$@"; do
  case "$a" in 1|2|3|4|5) ;; *) stop "unknown section '$a' — use 1 to 5 (one or several), or nothing for all" ;; esac
done
WANT=" $* "
want() { [[ "$WANT" == "  " || "$WANT" == *" $1 "* ]]; }

PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"

# jit off: nothing here runs long enough to repay compiling it. statement_timeout: a step stops with an error rather
# than hanging in silence.
# -q again here, so an override that forgets it does not print SET, BEGIN and COMMIT around every table.
psqlc() { $PSQL -q -v ON_ERROR_STOP=1 -P footer=off -P pager=off "$@"; }
run()  { psqlc -c "SET jit = off" -c "SET statement_timeout = '$STEP_LIMIT'" -c "BEGIN READ ONLY; $1 COMMIT;"; }
# Unaligned: no padding to the widest cell, so a caption fits a console line instead of wrapping into five.
runc() { psqlc -A -F ' | ' -c "SET jit = off" -c "SET statement_timeout = '$STEP_LIMIT'" -c "BEGIN READ ONLY; $1 COMMIT;"; }
# One bare value, for a decision the script itself has to make.
runv() { psqlc -A -t -c "SET jit = off" -c "SET statement_timeout = '$STEP_LIMIT'" -c "BEGIN READ ONLY; $1 COMMIT;"; }

echo "-- official-caption-probe.sh — read-only; days and times are IST; each query stops after $STEP_LIMIT"

VER="$(runv "SELECT current_setting('server_version_num');")"
[[ "$VER" =~ ^[0-9]+$ ]] || stop "could not read the Postgres version (got: '$VER')"
(( VER >= 160000 )) || stop "this needs Postgres 16 or later (pg_input_is_valid, regexp_instr); the server reports $VER"
echo

# ── Shared by sections 3, 4 and 5 ───────────────────────────────────────────────────────────────────────────────────
# posts   official-read CAMPAIGN posts that have a caption, posted in the last __BACK__ — the heredoc is quoted, so
#         each section puts its own reach in: 14 days for sections 3 and 4, 72 hours for section 5
# cos     live verified companies, each with its escaped handle, its standalone-word pattern and the squashed names the
#         brand-string rule compares (brandStringsNameProspect)
# m       every (post, company) whose caption contains the handle at all — a plain substring test first, so the
#         regular expressions run on a few thousand pairs and not on the whole cross join. at_or_tag = today's rule
#         credits the post to the company through an "@handle" or a tag
# hits    the pairs this script is about: the handle stands alone in the caption, and neither an "@handle" nor a tag
#         credits the post to that company today. `brand` says whether a brand string already does.
BASE="$(cat <<'SQL'
WITH nowu AS (SELECT (now() AT TIME ZONE 'UTC') AS n),
win(ord, label, back) AS (VALUES (1, '72 hours', interval '72 hours'), (2, '7 days', interval '7 days'),
                                 (3, '14 days', interval '14 days')),
posts AS MATERIALIZED (
  SELECT d.id AS pid, d.shortcode, d."postedAt" AS posted, d.caption, lower(d.caption) AS lc,
    d."taggedAccounts" AS tagged_raw, d.brands <> '[]' AS has_brands,
    /* The two JSON cells are read the way the app reads them (JSON.parse: anything unreadable, or not a list, is an
       empty list; only strings count) and so that no cell can stop the query: a cell is opened only once Postgres says
       it is JSON, and a string in it only once Postgres says it can be turned into text — one written with a \u0000
       or half an emoji is skipped, and could not have equalled a handle anyway. */
    ARRAY(SELECT lower(CASE WHEN pg_input_is_valid(e::text, 'jsonb') THEN e::text::jsonb #>> '{}' END)
          FROM json_array_elements(CASE WHEN pg_input_is_valid(d."taggedAccounts", 'json') THEN
                 CASE WHEN json_typeof(d."taggedAccounts"::json) = 'array' THEN d."taggedAccounts"::json END END) e
          WHERE json_typeof(e) = 'string' AND pg_input_is_valid(e::text, 'jsonb')) AS tags_lc,
    ARRAY(SELECT z.sq
          FROM (SELECT regexp_replace(lower(CASE WHEN pg_input_is_valid(e::text, 'jsonb') THEN e::text::jsonb #>> '{}' END),
                                      '[^a-z0-9]', '', 'g') AS sq
                FROM json_array_elements(CASE WHEN pg_input_is_valid(d.brands, 'json') THEN
                       CASE WHEN json_typeof(d.brands::json) = 'array' THEN d.brands::json END END) e
                WHERE json_typeof(e) = 'string' AND pg_input_is_valid(e::text, 'jsonb')) z
          WHERE length(z.sq) >= 4) AS brands_sq
  FROM "DetectedCampaign" d, nowu
  WHERE d.verdict = 'CAMPAIGN'
    AND d."postedAt" >= nowu.n - interval '__BACK__'
    AND strpos(coalesce(d."rawPayload", ''), '"evidenceIncomplete":true') > 0
    AND d.caption ~ '[^[:space:]]'
),
cos AS MATERIALIZED (
  SELECT t.id AS cid, t.handle AS handle_raw, k.h,
    (length(k.h) >= 8 OR k.h ~ '[0-9_.]') AS distinctive,
    coalesce(b.kind = 'PERSON', false) AS person,
    /* the handle as a standalone word (group 2 is the handle itself) */
    '(^|[^a-z0-9_.#@/])(' || k.esc || ')($|[^a-z0-9_.]|[.]($|[^a-z0-9]))' AS bare_pat,
    /* today's own "@handle" test (mentionsHandleExactly): it refuses a "." straight after the handle */
    '@' || k.esc || '($|[^a-z0-9_.])' AS at_rule_pat,
    /* "@handle" written out whole, ending the way a standalone word may end */
    '@' || k.esc || '($|[^a-z0-9_.]|[.]($|[^a-z0-9]))' AS at_whole_pat,
    nm.names
  FROM "TargetAccount" t
  CROSS JOIN LATERAL (SELECT lower(t.handle) AS h,
                             regexp_replace(lower(t.handle), '([^a-z0-9_])', '\\\1', 'g') AS esc) k
  LEFT JOIN "BrandLookup" b ON b.handle = k.h
  CROSS JOIN LATERAL (
    /* brandStringsNameProspect: the display name and the handle, squashed, each kept only at 4+ characters, plus each
       with ONE of india / official / ind / in stripped when 5+ characters remain (first that applies, in that order). */
    SELECT coalesce(array_agg(DISTINCT st.v), '{}'::text[]) AS names
    FROM (VALUES (regexp_replace(lower(coalesce(t."displayName", '')), '[^a-z0-9]', '', 'g')),
                 (regexp_replace(lower(t.handle), '[^a-z0-9]', '', 'g'))) AS raw(n)
    CROSS JOIN LATERAL (VALUES (raw.n), (CASE
        WHEN right(raw.n, 5) = 'india'    AND length(raw.n) - 5 >= 5 THEN left(raw.n, length(raw.n) - 5)
        WHEN right(raw.n, 8) = 'official' AND length(raw.n) - 8 >= 5 THEN left(raw.n, length(raw.n) - 8)
        WHEN right(raw.n, 3) = 'ind'      AND length(raw.n) - 3 >= 5 THEN left(raw.n, length(raw.n) - 3)
        WHEN right(raw.n, 2) = 'in'       AND length(raw.n) - 2 >= 5 THEN left(raw.n, length(raw.n) - 2)
        ELSE raw.n END)) AS st(v)
    WHERE length(raw.n) >= 4
  ) nm
  WHERE t.role = 'PROSPECT' AND NOT t."optedOut" AND t."isVerified" IS TRUE AND t.handle <> ''
),
m AS MATERIALIZED (
  /* The company is the OUTER side on purpose — the LATERAL and its OFFSET 0 pin that. Each company's patterns are then
     used on its candidate captions back to back; Postgres keeps only a few compiled patterns at hand, and the other
     order compiles one afresh for nearly every pair (measured on the timing seed, one pass over 16,000 candidate
     pairs: 0.7 s this way round, 1.2 s the other; both give the same rows). */
  SELECT q.pid, c.cid, q.posted, c.distinctive, c.person, q.bare,
    (q.pre AND (q.at_rule OR q.tag)) AS at_or_tag, q.brand, q.at_whole, q.at_rule
  FROM cos c CROSS JOIN LATERAL (
    SELECT p.pid, p.posted,
      p.lc ~ c.bare_pat AS bare,
      /* campaignsNamingHandleRows' database prefilter: Postgres `contains` is case-sensitive */
      (strpos(p.caption, '@' || c.handle_raw) > 0 OR strpos(p.tagged_raw, '"' || c.handle_raw || '"') > 0 OR p.has_brands) AS pre,
      p.lc ~ c.at_rule_pat AS at_rule,
      c.h = ANY (p.tags_lc) AS tag,
      (p.brands_sq && c.names) AS brand,
      p.lc ~ c.at_whole_pat AS at_whole
    FROM posts p
    WHERE strpos(p.lc, c.h) > 0
    OFFSET 0
  ) q
),
hits AS MATERIALIZED (SELECT pid, cid, posted, distinctive, person, brand FROM m WHERE bare AND NOT at_or_tag)
SQL
)"
BASE14="${BASE//__BACK__/14 days}"
BASE72="${BASE//__BACK__/72 hours}"

if want 1; then
echo "== 1. Posts stored per day, by the read that stored them (last 14 IST days, by the day we stored each) =="
run "$(cat <<'SQL'
WITH day0 AS (SELECT date_trunc('day', (now() AT TIME ZONE 'UTC') + interval '330 min') - interval '330 min' AS d),
days AS (SELECT g AS start_utc FROM day0, generate_series(day0.d - interval '13 days', day0.d, interval '1 day') g),
c AS (
  SELECT date_trunc('day', x."detectedAt" + interval '330 min') - interval '330 min' AS start_utc,
    count(*) FILTER (WHERE x.official) AS o, count(*) FILTER (WHERE x.official AND x.verdict = 'CAMPAIGN') AS op,
    count(*) FILTER (WHERE NOT x.official) AS a, count(*) FILTER (WHERE NOT x.official AND x.verdict = 'CAMPAIGN') AS ap
  FROM (SELECT d."detectedAt", d.verdict,
               strpos(coalesce(d."rawPayload", ''), '"evidenceIncomplete":true') > 0 AS official
        FROM "DetectedCampaign" d, day0 WHERE d."detectedAt" >= day0.d - interval '13 days') x
  GROUP BY 1
),
r AS (
  SELECT days.start_utc, coalesce(c.o, 0) AS o, coalesce(c.op, 0) AS op, coalesce(c.a, 0) AS a, coalesce(c.ap, 0) AS ap
  FROM days LEFT JOIN c USING (start_utc)
)
SELECT ist_day_stored, official_stored, official_campaign, anonymous_stored, anonymous_campaign, official_pct_of_stored
FROM (
  SELECT 0 AS ord, r.start_utc,
    to_char(r.start_utc + interval '330 min', 'YYYY-MM-DD') || CASE WHEN r.start_utc = (SELECT d FROM day0) THEN ' so far' ELSE '' END AS ist_day_stored,
    r.o AS official_stored, r.op AS official_campaign, r.a AS anonymous_stored, r.ap AS anonymous_campaign,
    coalesce(round(100.0 * r.o / nullif(r.o + r.a, 0))::text, '-') AS official_pct_of_stored
  FROM r
  UNION ALL
  SELECT 1, NULL, 'all 14 days', sum(r.o), sum(r.op), sum(r.a), sum(r.ap),
    coalesce(round(100.0 * sum(r.o) / nullif(sum(r.o) + sum(r.a), 0))::text, '-')
  FROM r
) z ORDER BY ord, start_utc;
SQL
)"
run "$(cat <<'SQL'
SELECT count(*) FILTER (WHERE official) AS official_rows_ever,
  coalesce(to_char(min("detectedAt") FILTER (WHERE official) + interval '330 min', 'DD Mon YYYY HH24:MI'), '-') AS first_one_stored,
  coalesce(to_char(max("detectedAt") FILTER (WHERE official) + interval '330 min', 'DD Mon YYYY HH24:MI'), '-') AS newest_one_stored,
  count(*) FILTER (WHERE NOT official) AS anonymous_rows_ever,
  coalesce(to_char(max("detectedAt") FILTER (WHERE NOT official) + interval '330 min', 'DD Mon YYYY HH24:MI'), '-') AS newest_anonymous_stored
FROM (SELECT "detectedAt", strpos(coalesce("rawPayload", ''), '"evidenceIncomplete":true') > 0 AS official
      FROM "DetectedCampaign") x;
SQL
)"
echo "   official = the stored row carries the marker \"evidenceIncomplete\":true (the official read stored it); anonymous ="
echo "   it does not (the anonymous feed stored it, or re-read it whole later). campaign = verdict CAMPAIGN now."
echo "   Counted on the IST day the row was first stored (detectedAt), every channel."
echo
fi

if want 2; then
echo "== 2. Does the official read's caption still carry the \"@\"? =="
# o = official-read posts posted in the last 14 days; b = anonymous-read posts posted 15 Sep 00:00 to 15 Oct 00:00 IST.
G2="$(cat <<'SQL'
WITH nowu AS (SELECT (now() AT TIME ZONE 'UTC') AS n),
g AS MATERIALIZED (
  SELECT x.*, strpos(x.caption, '@') > 0 AS any_at,
    x.caption ~ '@[A-Za-z0-9_]' AS at_handle,
    x.caption ~ '(^|[^A-Za-z0-9._%+-])@[A-Za-z0-9_]' AS at_mention
  FROM (
    SELECT d."targetId" AS tid, d.shortcode, d."postedAt" AS posted, d.caption,
      CASE WHEN strpos(coalesce(d."rawPayload", ''), '"evidenceIncomplete":true') > 0
             THEN CASE WHEN d."postedAt" >= nowu.n - interval '14 days' THEN 'o' END
           WHEN d."postedAt" >= timestamp '2026-09-14 18:30:00' AND d."postedAt" < timestamp '2026-10-14 18:30:00' THEN 'b'
      END AS grp
    FROM "DetectedCampaign" d, nowu
    WHERE d.caption ~ '[^[:space:]]'
      AND (d."postedAt" >= nowu.n - interval '14 days'
           OR (d."postedAt" >= timestamp '2026-09-14 18:30:00' AND d."postedAt" < timestamp '2026-10-14 18:30:00'))
  ) x WHERE x.grp IS NOT NULL
),
och AS (SELECT DISTINCT tid FROM g WHERE grp = 'o'),
t AS (
  SELECT 1 AS ord, 'official read, posted in the last 14 days' AS captions_from, g.* FROM g WHERE grp = 'o'
  UNION ALL
  SELECT 2, 'anonymous read, posted 15 Sep-14 Oct, the same channels', g.* FROM g WHERE grp = 'b' AND tid IN (SELECT tid FROM och)
  UNION ALL
  SELECT 3, 'anonymous read, posted 15 Sep-14 Oct, every channel', g.* FROM g WHERE grp = 'b'
),
s AS (
  SELECT v.ord, v.captions_from, count(t.tid) AS n, count(*) FILTER (WHERE t.any_at) AS n_any,
    count(*) FILTER (WHERE t.at_handle) AS n_handle, count(*) FILTER (WHERE t.at_mention) AS n_mention
  FROM (VALUES (1, 'official read, posted in the last 14 days'),
               (2, 'anonymous read, posted 15 Sep-14 Oct, the same channels'),
               (3, 'anonymous read, posted 15 Sep-14 Oct, every channel')) AS v(ord, captions_from)
  LEFT JOIN t ON t.ord = v.ord
  GROUP BY v.ord, v.captions_from
)
SQL
)"
run "$G2 $(cat <<'SQL'
SELECT captions_from, n AS captions, n_any AS any_at_sign, n_handle AS at_then_handle_char,
  coalesce(round(100.0 * n_handle / nullif(n, 0), 1)::text, '-') AS pct,
  n_mention AS mention_shaped, coalesce(round(100.0 * n_mention / nullif(n, 0), 1)::text, '-') AS pct_mention_shaped
FROM s ORDER BY ord;
SQL
)"
echo "   captions = posts whose caption is not blank. any_at_sign = the caption has an \"@\" anywhere. at_then_handle_char ="
echo "   it has an \"@\" followed by a letter, digit or \"_\". mention_shaped = at least one such \"@\" is at the start or not"
echo "   preceded by a letter, digit, \".\", \"_\", \"%\", \"+\" or \"-\" — so not the middle of an e-mail address."
echo "   same channels = channels with an official-read caption in the last 14 days."
echo
BYCH="$(run "$G2 $(cat <<'SQL'
SELECT '@' || ta.handle AS channel,
  count(*) FILTER (WHERE g.grp = 'o') AS official_captions_14d,
  count(*) FILTER (WHERE g.grp = 'o' AND g.at_mention) AS official_mention_shaped,
  count(*) FILTER (WHERE g.grp = 'b') AS anonymous_captions_15sep_14oct,
  count(*) FILTER (WHERE g.grp = 'b' AND g.at_mention) AS anonymous_mention_shaped
FROM g JOIN "TargetAccount" ta ON ta.id = g.tid
WHERE g.tid IN (SELECT tid FROM och)
GROUP BY ta.handle ORDER BY 2 DESC, 1 LIMIT 15;
SQL
)")"
# Two lines are the header and its rule: a table with no rows says nothing a person can use.
if (( $(wc -l <<<"$BYCH") > 2 )); then
  echo "   by channel (up to 15, most official-read captions first):"
  echo "$BYCH"
else
  echo "   by channel: nothing to show — no channel has an official-read caption posted in the last 14 days."
fi
echo
N_EX="$(runv "$G2 SELECT count(*) FROM g WHERE grp = 'o' AND at_handle;")"
if [[ "$N_EX" =~ ^[0-9]+$ ]] && (( N_EX > 0 )); then
  echo "   official-read captions that carry an \"@\" followed by a handle character: $N_EX. Up to 5, mention-shaped first, then newest:"
  runc "$G2 $(cat <<'SQL'
SELECT shortcode, to_char(posted + interval '330 min', 'DD Mon HH24:MI') AS posted_ist,
  CASE WHEN at_mention THEN 'mention-shaped' ELSE 'inside an address' END AS shape,
  regexp_replace(substr(caption, greatest(1, pos - 50), 100), '[[:space:][:cntrl:]]+', ' ', 'g') AS caption_100_chars_around_the_at
FROM (SELECT g.*, CASE WHEN at_mention THEN regexp_instr(caption, '(^|[^A-Za-z0-9._%+-])(@[A-Za-z0-9_])', 1, 1, 0, 'c', 2)
                       ELSE regexp_instr(caption, '@[A-Za-z0-9_]') END AS pos
      FROM g WHERE grp = 'o' AND at_handle) e
ORDER BY at_mention DESC, posted DESC, shortcode LIMIT 5;
SQL
)"
else
  echo "   examples: none — no official-read caption of the last 14 days has an \"@\" followed by a handle character."
fi
echo
runv "$G2 $(cat <<'SQL'
, o AS (SELECT n, n_mention FROM s WHERE ord = 1),
b AS (SELECT s.n, s.n_mention, CASE WHEN s.ord = 2 THEN 'the same channels' ELSE 'every channel' END AS scope
      FROM s WHERE s.ord = CASE WHEN (SELECT n FROM s WHERE ord = 2) > 0 THEN 2 ELSE 3 END),
k AS (SELECT o.n AS o_n, o.n_mention AS o_at, b.n AS b_n, b.n_mention AS b_at, b.scope,
        CASE WHEN b.n > 0 THEN b.n_mention::numeric / b.n END AS b_rate,
        CASE WHEN o.n > 0 THEN o.n_mention::numeric / o.n END AS o_rate
      FROM o, b)
SELECT '-- 2. CONCLUSION: ' || CASE
  WHEN o_n = 0 THEN 'CANNOT TELL — no official-read post with a caption was posted in the last 14 days.'
  WHEN b_n = 0 OR b_at = 0 THEN 'CANNOT TELL — the baseline (anonymous read, 15 Sep-14 Oct, ' || scope || ') has '
    || CASE WHEN b_n = 0 THEN 'no captions' ELSE 'no mention-shaped "@" in ' || b_n || ' captions' END
    || ', so nothing says how many to expect. Official read: ' || o_at || ' of ' || o_n || '.'
  WHEN o_at = 0 AND o_n * b_rate >= 5 THEN 'STRIPPED — 0 of ' || o_n || ' official-read captions carry a mention-shaped "@"; at the baseline rate ('
    || round(100 * b_rate, 1) || '%, ' || scope || ') about ' || round(o_n * b_rate) || ' would.'
  WHEN o_at = 0 THEN 'CANNOT TELL YET — 0 of ' || o_n || ' official-read captions carry a mention-shaped "@", but at the baseline rate ('
    || round(100 * b_rate, 1) || '%, ' || scope || ') only about ' || round(o_n * b_rate, 1) || ' would: too few to rule out chance.'
  WHEN o_rate >= b_rate / 2 THEN 'NOT STRIPPED — ' || o_at || ' of ' || o_n || ' official-read captions (' || round(100 * o_rate, 1)
    || '%) carry a mention-shaped "@", against ' || round(100 * b_rate, 1) || '% in the baseline (' || scope || ').'
  ELSE 'MIXED — ' || o_at || ' of ' || o_n || ' official-read captions (' || round(100 * o_rate, 1)
    || '%) carry a mention-shaped "@", against ' || round(100 * b_rate, 1) || '% in the baseline (' || scope || '): some survive, most do not. Read the examples.'
  END
FROM k;
SQL
)"
echo "   (stripped = none where the baseline rate predicts 5 or more; not stripped = at least half the baseline rate;"
echo "   mixed = in between. The baseline is another month and the anonymous read's own captions — a comparison, not proof.)"
echo
fi

if want 3; then
echo "== 3. Bare handles: official-read CAMPAIGN posts that hold a live verified company's handle as a standalone word =="
echo "   what is crossed:"
run "$(cat <<'SQL'
WITH nowu AS (SELECT (now() AT TIME ZONE 'UTC') AS n),
win(ord, label, back) AS (VALUES (1, '72 hours', interval '72 hours'), (2, '7 days', interval '7 days'),
                                 (3, '14 days', interval '14 days')),
x AS (SELECT d."postedAt" AS posted, d.caption ~ '[^[:space:]]' AS has_caption,
        strpos(coalesce(d."rawPayload", ''), '"evidenceIncomplete":true') > 0 AS official
      FROM "DetectedCampaign" d, nowu
      WHERE d.verdict = 'CAMPAIGN' AND d."postedAt" >= nowu.n - interval '14 days')
SELECT w.label AS posted_in_the_last,
  count(*) FILTER (WHERE x.official) AS official_read_campaign_posts,
  count(*) FILTER (WHERE x.official AND x.has_caption) AS of_them_with_a_caption,
  count(*) FILTER (WHERE NOT x.official) AS anonymous_read_campaign_posts
FROM win w CROSS JOIN nowu LEFT JOIN x ON x.posted >= nowu.n - w.back
GROUP BY w.ord, w.label ORDER BY w.ord;
SQL
)"
run "$BASE14 $(cat <<'SQL'
SELECT count(*) AS live_verified_companies,
  count(*) FILTER (WHERE distinctive) AS with_a_distinctive_handle,
  count(*) FILTER (WHERE NOT distinctive) AS with_a_short_plain_word_handle,
  count(*) FILTER (WHERE person) AS brandlookup_says_person
FROM cos;
SQL
)"
echo "   the matches — the handle stands alone in the caption, and no \"@handle\" or tag credits the post to that company today:"
run "$BASE14 $(cat <<'SQL'
SELECT w.label AS posted_in_the_last,
  CASE WHEN grouping(h.distinctive) = 1 THEN 'all' WHEN h.distinctive THEN 'distinctive' ELSE 'short plain word' END AS handles,
  CASE WHEN grouping(h.person) = 1 THEN 'all' WHEN h.person THEN 'person' ELSE 'not marked a person' END AS company_is,
  count(h.pid) AS pairs, count(DISTINCT h.pid) AS posts, count(DISTINCT h.cid) AS companies,
  count(*) FILTER (WHERE h.brand) AS pairs_brand_credited,
  count(*) FILTER (WHERE NOT h.brand) AS pairs_uncredited,
  count(DISTINCT h.pid) FILTER (WHERE NOT h.brand) AS posts_uncredited,
  count(DISTINCT h.cid) FILTER (WHERE NOT h.brand) AS companies_uncredited
FROM win w CROSS JOIN nowu LEFT JOIN hits h ON h.posted >= nowu.n - w.back
GROUP BY GROUPING SETS ((w.ord, w.label), (w.ord, w.label, h.distinctive), (w.ord, w.label, h.distinctive, h.person))
/* A window with no match still prints its 'all' row, with zeros; the empty split rows are dropped. */
HAVING grouping(h.distinctive) = 1 OR count(h.pid) > 0
ORDER BY w.ord, grouping(h.distinctive) DESC, h.distinctive DESC, grouping(h.person) DESC, h.person;
SQL
)"
echo "   pair = one post and one company. Each window includes the shorter ones."
echo "   pairs_brand_credited = today's rule already credits that post to that company through a brand string, so a"
echo "   bare-handle rule would add nothing there; *_uncredited = no arm of today's rule credits it. posts and"
echo "   companies are distinct counts, so the rows of a window do not add up to its 'all' row."
echo
echo "   and where the \"@\" is still there — the same posts and companies, the caption holding \"@handle\":"
run "$BASE14 $(cat <<'SQL'
SELECT w.label AS posted_in_the_last,
  count(*) FILTER (WHERE x.at_or_tag) AS pairs_credited_by_at_or_tag,
  count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag) AS pairs_at_handle_not_credited,
  count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag AND NOT x.at_rule) AS of_them_full_stop_after,
  count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag AND x.at_rule) AS of_them_letter_case,
  count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag AND x.brand) AS of_them_brand_credited
FROM win w CROSS JOIN nowu LEFT JOIN m x ON x.posted >= nowu.n - w.back
GROUP BY w.ord, w.label ORDER BY w.ord;
SQL
)"
echo "   Counted over pairs whose caption holds the handle at all (a post that only TAGS a company is not here; the"
echo "   official read reports no tags). pairs_credited_by_at_or_tag = today's rule credits the post to the company"
echo "   through an \"@handle\" or a tag."
echo "   pairs_at_handle_not_credited = the caption has \"@handle\" written out whole, yet that does not credit it today:"
echo "   full_stop_after = today's test refuses an \"@handle\" followed by a full stop; letter_case = the caption spells"
echo "   the handle in another letter case and the post has no brand string, so the database prefilter never hands the"
echo "   row to the test. of_them_brand_credited = a brand string credits the post to that company anyway."
echo
# The same numbers as the tables above, on two lines that survive `grep '^-- '`: a console that shows one screen
# cannot show the tables whole. Counted from the same `hits` and `m` rows, by the same windows.
runv "$BASE14 $(cat <<'SQL'
SELECT '-- 3. BARE HANDLES nothing credits today (distinctive handles only) — last 72 hours: '
  || count(*) FILTER (WHERE z.d72) || ' pairs, ' || count(DISTINCT z.pid) FILTER (WHERE z.d72) || ' posts, '
  || count(DISTINCT z.cid) FILTER (WHERE z.d72) || ' companies ('
  || count(DISTINCT z.cid) FILTER (WHERE z.d72 AND z.person) || ' marked a person) · last 14 days: '
  || count(*) || ' pairs, ' || count(DISTINCT z.pid) || ' posts, ' || count(DISTINCT z.cid) || ' companies ('
  || count(DISTINCT z.cid) FILTER (WHERE z.person) || ' marked a person). Set aside as likely ordinary words: '
  || (SELECT count(*) FROM hits WHERE NOT distinctive AND NOT brand) || ' short-handle pairs in 14 days.'
FROM (SELECT h.pid, h.cid, h.person, h.posted >= nowu.n - interval '72 hours' AS d72
      FROM hits h, nowu WHERE h.distinctive AND NOT h.brand) z;
SQL
)"
runv "$BASE14 $(cat <<'SQL'
SELECT '-- 3. "@handle" in the same posts, last 14 days — credited today by an "@handle" or a tag: '
  || count(*) FILTER (WHERE x.at_or_tag) || ' pairs · written out whole yet NOT credited: '
  || count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag) || ' (a full stop after: '
  || count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag AND NOT x.at_rule) || ', letter case: '
  || count(*) FILTER (WHERE x.at_whole AND NOT x.at_or_tag AND x.at_rule) || ').'
FROM m x;
SQL
)"
echo
fi

if want 4; then
echo "== 4. Read them: distinctive matches from the last 14 days, SHORTEST handle first (at most 2 posts a handle, the newest; rows $((READ_SKIP + 1)) to $((READ_SKIP + 25))) =="
Q4="$(cat <<'SQL'
SELECT '@' || h AS handle, CASE WHEN person THEN 'person' ELSE '-' END AS person, shortcode,
  to_char(posted + interval '330 min', 'DD Mon HH24:MI') AS posted_ist, n_posts AS posts_matching_this_handle_14d,
  CASE WHEN brand THEN 'a brand string' ELSE 'nothing' END AS credited_today_by,
  regexp_replace(substr(src, greatest(1, pos - 50), 120), '[[:space:][:cntrl:]]+', ' ', 'g') AS caption_120_chars_around_the_word
FROM (
  SELECT x.pid, x.posted, x.person, x.brand, p.shortcode, c.h, regexp_instr(p.lc, c.bare_pat, 1, 1, 0, 'c', 2) AS pos,
    /* lower() can change a caption's length in some locales; then the lowered text is shown so the cut stays right. */
    CASE WHEN length(p.lc) = length(p.caption) THEN p.caption ELSE p.lc END AS src,
    count(*) OVER (PARTITION BY x.cid) AS n_posts,
    row_number() OVER (PARTITION BY x.cid ORDER BY x.posted DESC, x.pid) AS r
  FROM hits x JOIN posts p USING (pid) JOIN cos c USING (cid)
  WHERE x.distinctive
) e
WHERE r <= 2
ORDER BY length(h), h, posted DESC, pid LIMIT 25 OFFSET __SKIP__;
SQL
)"
READ4="$(runc "$BASE14 ${Q4//__SKIP__/$READ_SKIP}")"
ROWS4=$(( $(wc -l <<<"$READ4") - 1 ))
if (( ROWS4 > 0 )); then
  echo "$READ4"
  echo "   Same pairs as section 3's 14-day 'distinctive' row. For each, ask: is the caption naming that company's account,"
  echo "   or is it an ordinary word, another account's name, or part of a longer name?"
  if (( ROWS4 == 25 )); then echo "   There may be more. The next 25: DS_READ_SKIP=$((READ_SKIP + 25)) bash $0 4"; fi
elif (( READ_SKIP > 0 )); then
  echo "   none — there are no rows past row $READ_SKIP."
else
  echo "   none — no official-read CAMPAIGN post of the last 14 days holds a distinctive handle of a live verified company"
  echo "   as a standalone word without an \"@handle\" or tag already crediting it."
fi
echo
fi

if want 5; then
echo "== 5. What counting them could release — an ESTIMATE, for posts of the last 72 hours only =="
run "$BASE72 $(cat <<'SQL'
, f AS MATERIALIZED (SELECT hits.* FROM hits, nowu WHERE NOT hits.brand AND hits.posted >= nowu.n - interval '72 hours'),
claims AS MATERIALIZED (
  SELECT DISTINCT a."campaignId" AS pid, a."targetId" AS cid FROM "OutreachAttempt" a
  WHERE a."campaignId" IN (SELECT pid FROM f) AND a.status IN ('SENT', 'REPLIED', 'SENDING', 'READY', 'QUEUED')
),
recent AS MATERIALIZED (
  SELECT DISTINCT a."targetId" AS cid FROM "OutreachAttempt" a, nowu
  WHERE a.status IN ('SENT', 'REPLIED') AND a."sentAt" >= nowu.n - interval '7 days'
),
ever AS MATERIALIZED (
  SELECT DISTINCT a."targetId" AS cid FROM "OutreachAttempt" a
  WHERE a.status IN ('SENT', 'REPLIED') AND a."targetId" IN (SELECT cid FROM f)
),
per AS (
  SELECT f.cid, f.distinctive,
    bool_or(NOT EXISTS (SELECT 1 FROM claims k WHERE k.pid = f.pid AND k.cid = f.cid)) AS has_unclaimed,
    NOT EXISTS (SELECT 1 FROM recent r WHERE r.cid = f.cid) AS quiet,
    EXISTS (SELECT 1 FROM ever e WHERE e.cid = f.cid) AS written
  FROM f GROUP BY f.cid, f.distinctive
)
SELECT v.handles, coalesce(z.companies, 0) AS companies_matched, coalesce(z.quiet, 0) AS no_message_in_7_days,
  coalesce(z.unclaimed, 0) AS with_a_post_not_yet_claimed, coalesce(z.both_, 0) AS both,
  coalesce(z.both_written, 0) AS of_both_written_to_before
FROM (VALUES (1, 'all'), (2, 'distinctive'), (3, 'short plain word')) AS v(ord, handles)
LEFT JOIN (
  SELECT CASE WHEN grouping(distinctive) = 1 THEN 1 WHEN distinctive THEN 2 ELSE 3 END AS ord,
    count(*) AS companies, count(*) FILTER (WHERE quiet) AS quiet, count(*) FILTER (WHERE has_unclaimed) AS unclaimed,
    count(*) FILTER (WHERE quiet AND has_unclaimed) AS both_,
    count(*) FILTER (WHERE quiet AND has_unclaimed AND written) AS both_written
  FROM per GROUP BY GROUPING SETS ((), (distinctive))
) z USING (ord)
ORDER BY v.ord;
SQL
)"
# The 'distinctive' row of the table above on one line that survives `grep '^-- '`. Same CTEs, same rules.
EST5="$(runv "$BASE72 $(cat <<'SQL'
, f AS MATERIALIZED (SELECT hits.* FROM hits, nowu WHERE NOT hits.brand AND hits.distinctive AND hits.posted >= nowu.n - interval '72 hours'),
claims AS MATERIALIZED (
  SELECT DISTINCT a."campaignId" AS pid, a."targetId" AS cid FROM "OutreachAttempt" a
  WHERE a."campaignId" IN (SELECT pid FROM f) AND a.status IN ('SENT', 'REPLIED', 'SENDING', 'READY', 'QUEUED')
),
recent AS MATERIALIZED (
  SELECT DISTINCT a."targetId" AS cid FROM "OutreachAttempt" a, nowu
  WHERE a.status IN ('SENT', 'REPLIED') AND a."sentAt" >= nowu.n - interval '7 days'
),
ever AS MATERIALIZED (
  SELECT DISTINCT a."targetId" AS cid FROM "OutreachAttempt" a
  WHERE a.status IN ('SENT', 'REPLIED') AND a."targetId" IN (SELECT cid FROM f)
),
per AS (
  SELECT f.cid,
    bool_or(NOT EXISTS (SELECT 1 FROM claims k WHERE k.pid = f.pid AND k.cid = f.cid)) AS has_unclaimed,
    NOT EXISTS (SELECT 1 FROM recent r WHERE r.cid = f.cid) AS quiet,
    EXISTS (SELECT 1 FROM ever e WHERE e.cid = f.cid) AS written
  FROM f GROUP BY f.cid
)
SELECT '-- 5. ESTIMATE, last 72 hours, distinctive handles: ' || count(*) || ' companies matched · '
  || count(*) FILTER (WHERE quiet) || ' with no message in 7 days · '
  || count(*) FILTER (WHERE quiet AND has_unclaimed) || ' of those also have a post not yet claimed · '
  || count(*) FILTER (WHERE quiet AND has_unclaimed AND written) || ' of those were written to before (so the next message is a follow-up). A rough size, not a forecast.'
FROM per;
SQL
)")"
run "$BASE72 $(cat <<'SQL'
SELECT count(*) FILTER (WHERE h.brand) AS pairs_left_out_brand_credited,
  coalesce((SELECT value FROM "Setting" WHERE key = 'hookMaxAgeHours'), 'no row') AS setting_hook_max_age_hours,
  coalesce((SELECT value FROM "Setting" WHERE key = 'defaultCooldownDays'), 'no row') AS setting_default_cooldown_days,
  coalesce((SELECT value FROM "Setting" WHERE key = 'fleetMaxPerDay'), 'no row') AS setting_fleet_max_per_day,
  coalesce((SELECT value FROM "Setting" WHERE key = 'fleetMaxPerHour'), 'no row') AS setting_fleet_max_per_hour
FROM nowu LEFT JOIN hits h ON h.posted >= nowu.n - interval '72 hours';
SQL
)"
echo "   companies_matched = live verified companies with at least one official-read CAMPAIGN post of the last 72 hours"
echo "   that holds their handle as a standalone word and that NO arm of today's rule credits to them."
echo "   no_message_in_7_days = of them, no page delivered a message to the company in the last 7 days."
echo "   with_a_post_not_yet_claimed = of them, at least one such post has no delivered or waiting message to that"
echo "   company written about it. both = the two together. of_both_written_to_before = of those, some page has"
echo "   delivered to the company before, so a further message from that page is a follow-up — the kind that needs a"
echo "   new post. The rest of 'both' never had a delivered message: any page's first message to them is an"
echo "   introduction, which needs no post, so a bare-handle rule would add nothing there."
echo "   A rough size, not a forecast. LOWER in practice: a follow-up also needs a subject it can describe from the"
echo "   post; the turn order, a reply halt, the once-a-day rule, a page being signed in on the Mac and the pace caps"
echo "   printed above all still apply; and a match may not be a real mention (section 4). HIGHER in one way: a company"
echo "   messaged in the last 7 days can still be reached when it has more paid posts than messages — not counted here."
echo
echo "$EST5"
echo
fi
echo "-- end"
