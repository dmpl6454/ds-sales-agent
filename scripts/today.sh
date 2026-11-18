#!/usr/bin/env bash
# today.sh — READ-ONLY. Run on the box (the server), as root:
#
#   bash today.sh          today so far (IST): the totals, each sending page's share, and the newest 15 messages
#                          with the page each was sent from
#   bash today.sh --all    the same, with every message delivered today
#
# Why this exists (18 Nov 2026): the hosted dashboard is an old build — its web tier needs a full deploy from a Mac,
# and the Mac that held that key is gone — so "what went out today, and from which page" had no screen. This answers
# it from the database directly. It writes nothing (every statement runs inside BEGIN READ ONLY) and prints no secret.
#
# "Today" is since midnight IST, the boundary the pacing rules use. Delivered = SENT or REPLIED (a message that was
# answered stays delivered). A reply is counted on the day the reply check FOUND it, which can be weeks after it was
# written; the written time is shown beside it.
#
# Two labels to read exactly (review, 18 Nov):
#   nth_from_page   the message's place in THIS PAGE's history with that company — 1 is this page's first. A page's
#                   first message to a company that already answered ANOTHER page carries the follow-up text, so 1 is
#                   not "an introduction"; it is "this page had not written to them before".
#   failed_*        drafts FAILED whose queuedAt is today. queuedAt is when a draft was written or last re-queued after
#                   a retryable failure — nothing records when it failed — so a draft written yesterday and shelved
#                   today is not counted, and one written days ago that failed again today may be.
set -uo pipefail

MODE="${1:-}"
case "$MODE" in ''|--all) ;; *) echo "-- STOPPED: unknown option '$MODE' — use no option or --all"; exit 2 ;; esac
LIMIT=15; [[ "$MODE" == "--all" ]] && LIMIT=100000

# An override must keep -q, or psql prints BEGIN and COMMIT around every table.
PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"
trap 'rc=$?; if [[ $rc -ne 0 ]]; then echo "-- STOPPED (exit $rc): a query did not finish. Its error is on the lines just above this one."; fi' EXIT

run() { $PSQL -v ON_ERROR_STOP=1 -P footer=off -P pager=off -A -F ' | ' -c "SET statement_timeout = '60s'" -c "BEGIN READ ONLY; $1 COMMIT;"; }

# Midnight IST, as the naive-UTC value every timestamp column here holds.
DAY="(date_trunc('day', (now() AT TIME ZONE 'UTC') + interval '330 min') - interval '330 min')"
IST="interval '330 min'"

echo "-- today.sh — read-only; today = since midnight IST"
echo

echo "== Today, all pages =="
run "SELECT to_char((now() AT TIME ZONE 'UTC') + $IST, 'DD Mon HH24:MI') || ' IST' AS now,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE status IN ('SENT','REPLIED') AND \"sentAt\" >= $DAY) AS delivered,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE status IN ('SENT','REPLIED') AND \"sentAt\" >= $DAY AND \"touchNumber\" = 1) AS first_from_page,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE status IN ('SENT','REPLIED') AND \"sentAt\" >= $DAY AND \"touchNumber\" > 1) AS again_from_page,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE \"repliedAt\" >= $DAY) AS replies_found,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE status IN ('READY','QUEUED','SENDING')) AS waiting_now,
  (SELECT count(*) FROM \"OutreachAttempt\" WHERE status = 'FAILED' AND \"queuedAt\" >= $DAY) AS failed_queued_today;"
echo

echo "== By sending page (pages with anything today, or a message waiting) =="
run "SELECT '@' || s.handle AS page,
  count(*) FILTER (WHERE a.status IN ('SENT','REPLIED') AND a.\"sentAt\" >= $DAY) AS delivered,
  count(*) FILTER (WHERE a.status IN ('SENT','REPLIED') AND a.\"sentAt\" >= $DAY AND a.\"touchNumber\" > 1) AS of_them_again,
  count(*) FILTER (WHERE a.\"repliedAt\" >= $DAY) AS replies_found,
  count(*) FILTER (WHERE a.status IN ('READY','QUEUED','SENDING')) AS waiting_now,
  count(*) FILTER (WHERE a.status = 'FAILED' AND a.\"queuedAt\" >= $DAY) AS failed_queued_today,
  coalesce(to_char(max(a.\"sentAt\") FILTER (WHERE a.status IN ('SENT','REPLIED') AND a.\"sentAt\" >= $DAY) + $IST, 'HH24:MI'), '-') AS last_sent
FROM \"OutreachAttempt\" a JOIN \"SenderAccount\" s ON s.id = a.\"senderId\"
GROUP BY s.handle
HAVING count(*) FILTER (WHERE (a.status IN ('SENT','REPLIED') AND a.\"sentAt\" >= $DAY) OR a.\"repliedAt\" >= $DAY
  OR a.status IN ('READY','QUEUED','SENDING') OR (a.status = 'FAILED' AND a.\"queuedAt\" >= $DAY)) > 0
ORDER BY 2 DESC, 1;"
echo

TOTAL="$(run "SELECT count(*) FROM \"OutreachAttempt\" WHERE status IN ('SENT','REPLIED') AND \"sentAt\" >= $DAY;" | tail -n 1)"
if [[ "$TOTAL" =~ ^[0-9]+$ ]] && (( TOTAL > LIMIT )); then
  echo "== Delivered today: newest $LIMIT of $TOTAL (bash $0 --all for every one) =="
else
  echo "== Delivered today, newest first =="
fi
run "SELECT to_char(a.\"sentAt\" + $IST, 'HH24:MI') AS at, '@' || s.handle AS from_page, '@' || t.handle AS to_company,
  a.\"touchNumber\" AS nth_from_page,
  CASE WHEN a.status = 'REPLIED' OR a.\"repliedAt\" IS NOT NULL THEN 'replied' ELSE '' END AS reply
FROM \"OutreachAttempt\" a JOIN \"SenderAccount\" s ON s.id = a.\"senderId\" JOIN \"TargetAccount\" t ON t.id = a.\"targetId\"
WHERE a.status IN ('SENT','REPLIED') AND a.\"sentAt\" >= $DAY
ORDER BY a.\"sentAt\" DESC, a.id LIMIT $LIMIT;"
echo

echo "== Replies the reply check found today (with when each was written) =="
run "SELECT to_char(a.\"repliedAt\" + $IST, 'HH24:MI') AS seen, '@' || t.handle AS company, 'to @' || s.handle AS page,
  coalesce('written ' || to_char(a.\"replyPostedAt\" + $IST, 'DD Mon HH24:MI'), 'written: not dated') AS written,
  coalesce(left(regexp_replace(a.\"replyText\", '[[:space:]]+', ' ', 'g'), 70), '(no text)') AS says
FROM \"OutreachAttempt\" a JOIN \"SenderAccount\" s ON s.id = a.\"senderId\" JOIN \"TargetAccount\" t ON t.id = a.\"targetId\"
WHERE a.\"repliedAt\" >= $DAY
ORDER BY a.\"repliedAt\" DESC, a.id LIMIT 20;"
echo "-- end"
