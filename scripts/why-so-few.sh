#!/usr/bin/env bash
# why-so-few.sh — READ-ONLY. Run on the box (the server), as root:
#
#   bash why-so-few.sh
#
# Asked 18 Nov 2026: "only 12 messages sent today". A message needs either a company nobody has written to yet, or
# something new to say to one we have (a paid post of theirs found in the last 72 hours). This prints, day by day for
# the last ten days, how much of each kind of input arrived — so a quiet day can be told apart from a broken pipe:
#
#   1. per IST day: paid posts found, companies added, brand look-up verdicts written (by verdict), drafts written,
#      messages delivered
#   2. the brand look-ups filed "does not exist" (MISSING) in the last ten days, each with how many paid posts name
#      it — MISSING is never asked again, and since Instagram started answering 404 for real pages (the 18 Nov
#      incident) a real company can land there
#   3. the planner's own account of its last passes, from the worker's log: what it wrote and why it skipped the rest
#
# It writes nothing (every statement runs inside BEGIN READ ONLY) and prints no secret.
set -euo pipefail

PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"
LOG="${DS_WORKER_LOG:-${PM2_HOME:-/root/.pm2}/logs/ds-sales-worker-out.log}"
trap 'rc=$?; if [[ $rc -ne 0 ]]; then echo "-- STOPPED (exit $rc): a query did not finish. Its error is on the lines just above this one."; fi' EXIT

run() { $PSQL -v ON_ERROR_STOP=1 -P footer=off -P pager=off -c "SET statement_timeout = '120s'" -c "BEGIN READ ONLY; $1 COMMIT;"; }

# IST day boundaries over the naive-UTC values every timestamp column holds.
IST="interval '330 min'"
DAY="(date_trunc('day', (now() AT TIME ZONE 'UTC') + $IST) - $IST)"
d() { echo "to_char($1 + $IST, 'YYYY-MM-DD')"; }

echo "-- why-so-few.sh — read-only; days are IST"
echo

echo "== 1. What came in, and what went out, per day (last 10 days) =="
run "WITH days AS (SELECT to_char(g, 'YYYY-MM-DD') AS day FROM generate_series(($DAY + $IST) - interval '9 days', $DAY + $IST, interval '1 day') g),
paid AS (SELECT $(d '"detectedAt"') AS day, count(*) AS n FROM \"DetectedCampaign\" WHERE verdict = 'CAMPAIGN' AND \"detectedAt\" >= $DAY - interval '9 days' GROUP BY 1),
minted AS (SELECT $(d '"createdAt"') AS day, count(*) AS n FROM \"TargetAccount\" WHERE role = 'PROSPECT' AND \"createdAt\" >= $DAY - interval '9 days' GROUP BY 1),
looks AS (SELECT $(d '"updatedAt"') AS day,
    count(*) FILTER (WHERE kind = 'BRAND') AS brand, count(*) FILTER (WHERE kind = 'PERSON') AS person,
    count(*) FILTER (WHERE kind = 'MISSING') AS missing, count(*) FILTER (WHERE kind IN ('UNRESOLVED','UNKNOWN')) AS undecided
  FROM \"BrandLookup\" WHERE \"updatedAt\" >= $DAY - interval '9 days' GROUP BY 1),
drafts AS (SELECT $(d '"queuedAt"') AS day, count(*) AS n FROM \"OutreachAttempt\" WHERE \"queuedAt\" >= $DAY - interval '9 days' GROUP BY 1),
sent AS (SELECT $(d '"sentAt"') AS day, count(*) AS n FROM \"OutreachAttempt\" WHERE status IN ('SENT','REPLIED') AND \"sentAt\" >= $DAY - interval '9 days' GROUP BY 1)
SELECT days.day, coalesce(paid.n, 0) AS paid_posts_found, coalesce(minted.n, 0) AS companies_added,
  coalesce(looks.brand, 0) AS lookup_brand, coalesce(looks.person, 0) AS lookup_person,
  coalesce(looks.missing, 0) AS lookup_missing, coalesce(looks.undecided, 0) AS lookup_undecided,
  coalesce(drafts.n, 0) AS drafts_written, coalesce(sent.n, 0) AS delivered
FROM days LEFT JOIN paid USING (day) LEFT JOIN minted USING (day) LEFT JOIN looks USING (day)
  LEFT JOIN drafts USING (day) LEFT JOIN sent USING (day)
ORDER BY days.day;"
echo "   drafts_written counts by queuedAt, which a retry or a return to the queue moves; a look-up is counted on the"
echo "   day its verdict was last written."
echo

echo "== 2. Look-ups filed 'does not exist' in the last 10 days (never asked again), with the paid posts naming each =="
run "SELECT b.handle, to_char(b.\"updatedAt\" + $IST, 'DD Mon HH24:MI') AS filed_ist, coalesce(b.\"decidedBy\", '-') AS by,
  (SELECT count(*) FROM \"DetectedCampaign\" c WHERE c.verdict = 'CAMPAIGN' AND c.\"postedAt\" >= $DAY - interval '30 days'
     AND (lower(c.caption) ~ ('@' || replace(b.handle, '.', '\.') || '([^a-z0-9._]|$)')
          OR position('\"' || b.handle || '\"' in lower(c.\"taggedAccounts\")) > 0)) AS paid_posts_naming_it,
  (SELECT count(*) FROM \"TargetAccount\" t WHERE t.handle = b.handle) AS is_a_target
FROM \"BrandLookup\" b
WHERE b.kind = 'MISSING' AND b.\"updatedAt\" >= $DAY - interval '9 days'
ORDER BY b.\"updatedAt\" DESC LIMIT 40;"
run "SELECT count(*) FILTER (WHERE \"updatedAt\" >= $DAY - interval '9 days') AS missing_last_10_days,
  count(*) FILTER (WHERE \"updatedAt\" < $DAY - interval '9 days') AS missing_older, count(*) AS missing_all
FROM \"BrandLookup\" WHERE kind = 'MISSING';"
echo

echo "== 3. Companies we know, and how many have never had a message =="
run "SELECT count(*) FILTER (WHERE NOT \"optedOut\") AS live_prospects,
  count(*) FILTER (WHERE NOT \"optedOut\" AND \"isVerified\" IS TRUE) AS live_verified,
  count(*) FILTER (WHERE NOT \"optedOut\" AND NOT EXISTS (SELECT 1 FROM \"OutreachAttempt\" a WHERE a.\"targetId\" = t.id AND a.status IN ('SENT','REPLIED'))) AS live_never_messaged,
  count(*) FILTER (WHERE NOT \"optedOut\" AND \"isVerified\" IS TRUE AND NOT EXISTS (SELECT 1 FROM \"OutreachAttempt\" a WHERE a.\"targetId\" = t.id AND a.status IN ('SENT','REPLIED'))) AS verified_never_messaged
FROM \"TargetAccount\" t WHERE role = 'PROSPECT';"
echo

echo "== 4. The planner's last passes, in its own words (from $LOG) =="
if [[ -r "$LOG" ]]; then
  grep -a -E 'outreach summary|outreach skips by reason|turn passes' "$LOG" | tail -n 9 | cut -c1-600 || true
  echo "   (each pass prints a summary; the skip reasons and turn-pass line only when there is something to say)"
else
  echo "   cannot read $LOG — set DS_WORKER_LOG to the worker's pm2 output log"
fi
echo "-- end"
