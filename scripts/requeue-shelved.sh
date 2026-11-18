#!/usr/bin/env bash
# requeue-shelved.sh — run on the box (the server), as root.
#
#   bash requeue-shelved.sh          LOOK ONLY. Counts the drafts shelved on the page lookup's word. Changes nothing.
#   bash requeue-shelved.sh --test   Returns ONE shelved draft to the queue, then watches for a few minutes what the
#                                    sending Mac does with it, and says so: delivered, shelved again, or still waiting.
#   bash requeue-shelved.sh --run    Returns up to 10 more. REFUSED until a returned draft has actually been delivered.
#
# WHAT THIS IS FOR (18 Nov 2026). The sending Mac's 10 Sept build asks Instagram's anonymous profile lookup whether a
# recipient exists before every send and shelves the draft as "page is gone" on a 404 — and that lookup now answers
# 404 for real pages. 41 introductions were shelved that way with no browser opened. The Mac is fixed by
# scripts/mac-hotfix-probe-404.sh (run ON the Mac). This script puts the shelved drafts back — and its --test is how
# anyone finds out whether the Mac really is fixed, because the server cannot see the Mac's files: a fixed Mac delivers
# the returned draft within a few minutes, an unfixed one shelves it again within one.
#
# WHAT IT RETURNS, and only this: a draft that is FAILED + profile-gone + whose error says "anonymous probe: not found"
# (so a page the BROWSER saw gone is never returned) + written since 16 Nov + to a recipient not retired since +
# whose company has exactly ONE such draft and no other message waiting, being sent, delivered or possibly delivered
# since 16 Nov. Anything else is counted and left for a person.
#
# WHAT RETURNING DOES: exactly what the dashboard's own re-queue does (requeueParkedAttempt) — status READY, tries 0,
# error and failure code cleared — plus one `attempt.requeued` audit row per draft. Its place in the queue is unchanged.
#
# THE PACE IS ENFORCED HERE, not left to memory: at most 10 returned in any 60 minutes (38 of the 41 are one account's,
# silent for sixteen days; all at once would be four times its busiest hour on record). DS_REQUEUE_PER_HOUR=20 raises
# it — that is a decision about account exposure, and it is recorded in each audit row.
#
# Exit: 0 done / delivered · 1 refused · 2 bad option · 3 the Mac shelved it again · 4 still waiting when the watch ended.
set -uo pipefail

MODE="${1:-look}"
# An override must keep -q, or psql prints BEGIN and COMMIT into the values this script reads.
PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"
PER_HOUR="${DS_REQUEUE_PER_HOUR:-10}"
WATCH_SECONDS="${DS_WATCH_SECONDS:-420}"
POLL_SECONDS="${DS_POLL_SECONDS:-10}"
BATCH=10
FLOOR="2026-11-16 00:00:00"
PROBE="%anonymous probe: not found%"

say() { printf '%s\n' "$*"; }
stop() { say ""; say "-- STOPPED: $1"; exit "${2:-1}"; }

say "-- requeue-shelved.sh ($MODE) — times are IST"
case "$MODE" in look|--test|--run) ;; *) stop "unknown option '$MODE' — use no option, --test or --run" 2 ;; esac
[[ "$PER_HOUR" =~ ^[1-9][0-9]?$ ]] && (( PER_HOUR <= 60 )) || stop "DS_REQUEUE_PER_HOUR must be a whole number from 1 to 60, got: $PER_HOUR" 2
[[ "$WATCH_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] || stop "DS_WATCH_SECONDS must be a whole number of seconds, got: $WATCH_SECONDS" 2
[[ "$POLL_SECONDS" =~ ^[1-9][0-9]?$ ]] || stop "DS_POLL_SECONDS must be a whole number of seconds, got: $POLL_SECONDS" 2

# One value or one row back, unaligned, no header. A failed query stops the script: nothing here may act on a guess.
q() { $PSQL -v ON_ERROR_STOP=1 -P pager=off -A -t -F '|' -c "SET statement_timeout = '60s'" -c "$1"; }
# `stop` inside a command substitution would only leave the subshell and hand its message back as the VALUE, so every
# capture is written  x="$(q …)" || db_fail  and the failure is handled here, in the main shell.
db_fail() { stop "a database query failed; its error is on the lines above. Nothing was changed by this step."; }
show() { q "$1" || db_fail; }

# `parks` = every draft shelved on the lookup's word. `cand` = the ones this script may return.
read -r -d '' CTE <<SQLEND || true
WITH parks AS (
  SELECT a.id, a."targetId", a."queuedAt"
  FROM "OutreachAttempt" a JOIN "TargetAccount" t ON t.id = a."targetId"
  WHERE a.status = 'FAILED' AND a."failureCode" = 'profile-gone' AND a.error LIKE '$PROBE'
    AND a."queuedAt" > timestamp '$FLOOR' AND t."optedOut" = false
), cand AS (
  SELECT p.id, p."queuedAt" FROM parks p
  WHERE (SELECT count(*) FROM parks p2 WHERE p2."targetId" = p."targetId") = 1
    AND NOT EXISTS (
      SELECT 1 FROM "OutreachAttempt" o
      WHERE o."targetId" = p."targetId" AND o.id <> p.id AND (
        o.status IN ('READY','QUEUED','SENDING')
        OR (o.status IN ('SENT','REPLIED') AND coalesce(o."sentAt", o."queuedAt") > timestamp '$FLOOR')
        OR (o.status = 'FAILED' AND o."failureCode" = 'not-in-thread' AND o."queuedAt" > timestamp '$FLOOR')))
), ret AS (
  SELECT l.at, o.id, o.status, o."failureCode" AS code, o.error, o."sentAt"
  FROM "AuditLog" l JOIN "OutreachAttempt" o ON o.id = substr(l.entity, 17)
  WHERE l.action = 'attempt.requeued' AND l.at > timestamp '$FLOOR'
)
SQLEND

# shelved | may be returned | returned so far | of those delivered | of those waiting | of those shelved again
# | DRAFTS returned in the last 60 min and not shelved again (a draft returned twice counts once: the pace is about
# messages that go out) | 1 = the Mac is not sending properly: of the returned drafts that have settled, the one returned
# LAST was shelved again (compared on the time each was RETURNED — a park carries no time of its own — and a tie,
# which is one batch, counts as shelved: the refusing direction)
STATE_SQL="$CTE SELECT (SELECT count(*) FROM parks), (SELECT count(*) FROM cand),
  (SELECT count(DISTINCT id) FROM ret),
  (SELECT count(DISTINCT id) FROM ret WHERE status IN ('SENT','REPLIED')),
  (SELECT count(DISTINCT id) FROM ret WHERE status IN ('READY','QUEUED','SENDING')),
  (SELECT count(DISTINCT id) FROM ret WHERE status = 'FAILED' AND code = 'profile-gone' AND error LIKE '$PROBE'),
  (SELECT count(DISTINCT id) FROM ret WHERE at > (now() AT TIME ZONE 'UTC') - interval '60 minutes' AND status <> 'FAILED'),
  (SELECT CASE WHEN max(at) FILTER (WHERE status = 'FAILED' AND code = 'profile-gone' AND error LIKE '$PROBE') >=
               coalesce(max(at) FILTER (WHERE status IN ('SENT','REPLIED')), timestamp '2000-01-01') THEN 1 ELSE 0 END FROM ret),
  to_char((now() AT TIME ZONE 'UTC') + interval '330 min', 'DD Mon HH24:MI');"

read_state() {
  local row; row="$(q "$STATE_SQL")" || db_fail
  IFS='|' read -r SHELVED ELIGIBLE RETURNED DELIVERED WAITING AGAIN LAST_HOUR UNFIXED NOW_IST <<<"$row"
  [[ "$SHELVED" =~ ^[0-9]+$ && "$UNFIXED" =~ ^[01]$ ]] || stop "could not read the queue's state (got: $row). Nothing was changed."
}

print_state() {
  say "   now $NOW_IST IST"
  say "   shelved on the page lookup's word since 16 Nov: $SHELVED   (this script may return: $ELIGIBLE; left for a person: $((SHELVED - ELIGIBLE)))"
  say "   returned to the queue so far: $RETURNED   — delivered $DELIVERED, still waiting $WAITING, shelved again $AGAIN"
}

mac_says() {
  # What the sending Mac last reported — the only window the server has onto it.
  show "SELECT '   Mac''s last send tick: ' || to_char(s.\"updatedAt\" + interval '330 min', 'HH24:MI:SS') || ' IST (' ||
      round(extract(epoch FROM (now() AT TIME ZONE 'UTC') - s.\"updatedAt\")) || ' s ago) — ' || left(s.value, 420)
    FROM \"Setting\" s WHERE s.key = 'dispatchState'
    UNION ALL SELECT '   Mac presence row last written: ' || to_char(s.\"updatedAt\" + interval '330 min', 'HH24:MI:SS') || ' IST (' ||
      round(extract(epoch FROM (now() AT TIME ZONE 'UTC') - s.\"updatedAt\")) || ' s ago)'
    FROM \"Setting\" s WHERE s.key = 'devicePresence';"
  say ""
}

# Returns up to $1 drafts; prints their ids, one per line.
#
# The pace and the batch size are re-counted INSIDE this step, behind a lock, and the pick, the update and the audit
# rows are one statement: a count read a moment earlier is not a guard (two runs started together would each release
# a batch), and a half-finished return cannot exist. The update re-checks the status, so a row that moved meanwhile
# is left alone. The lock ends with the transaction.
return_drafts() {
  local n="$1" detail="$2" out
  out="$(q "BEGIN; SELECT pg_advisory_xact_lock(1811202601); $CTE, lim AS (
      SELECT greatest(0, least($n,
        $BATCH - (SELECT count(DISTINCT id) FROM ret WHERE status IN ('READY','QUEUED','SENDING')),
        $PER_HOUR - (SELECT count(DISTINCT id) FROM ret WHERE at > (now() AT TIME ZONE 'UTC') - interval '60 minutes' AND status <> 'FAILED'))) AS n
    ), pick AS (
      SELECT a.id FROM \"OutreachAttempt\" a JOIN cand c ON c.id = a.id ORDER BY a.\"queuedAt\", a.id LIMIT (SELECT n FROM lim) FOR UPDATE OF a
    ), upd AS (
      UPDATE \"OutreachAttempt\" a SET status = 'READY', attempts = 0, error = NULL, \"failureCode\" = NULL
      FROM pick WHERE a.id = pick.id AND a.status = 'FAILED' AND a.\"failureCode\" = 'profile-gone' RETURNING a.id
    ), aud AS (
      INSERT INTO \"AuditLog\"(id, actor, action, entity, detail, at)
      SELECT 'c' || md5(random()::text || upd.id), 'console:root', 'attempt.requeued', 'OutreachAttempt:' || upd.id, '$detail', now() AT TIME ZONE 'UTC'
      FROM upd RETURNING entity
    ) SELECT substr(entity, 17) FROM aud; COMMIT;")" || return 1
  printf '%s\n' "$out" | grep . || true   # the lock's own (empty) result line is dropped
}

describe() { q "SELECT '@' || s.handle || ' to @' || t.handle FROM \"OutreachAttempt\" a JOIN \"SenderAccount\" s ON s.id = a.\"senderId\" JOIN \"TargetAccount\" t ON t.id = a.\"targetId\" WHERE a.id = '$1';" || echo "draft $1"; }

DETAIL="shelved by the sending Mac on a not-found from the anonymous page lookup, which answers not-found for real pages since Nov 2026; returned to the queue by requeue-shelved.sh (pace $PER_HOUR an hour)"

read_state
print_state

if [[ "$MODE" == "look" ]]; then
  if (( SHELVED - ELIGIBLE > 0 )); then
    say "   left for a person (a company with more than one shelved draft, or with another message out or delivered since 16 Nov):"
    show "$CTE SELECT '      @' || s.handle || ' to @' || t.handle FROM parks p JOIN \"OutreachAttempt\" a ON a.id = p.id JOIN \"SenderAccount\" s ON s.id = a.\"senderId\" JOIN \"TargetAccount\" t ON t.id = a.\"targetId\" WHERE p.id NOT IN (SELECT id FROM cand) ORDER BY 1 LIMIT 12;"
    say ""
  fi
  say "-- looked only; nothing was changed. Next: bash $0 --test"
  exit 0
fi

if [[ "$MODE" == "--test" ]]; then
  # A returned draft already waiting IS the test in progress: watch that one rather than adding a second.
  ID="$(q "$CTE SELECT id FROM ret WHERE status IN ('READY','QUEUED','SENDING') ORDER BY at LIMIT 1;")" || db_fail
  if [[ -n "$ID" ]]; then
    say "   a returned draft is already waiting ($(describe "$ID")) — watching that one; nothing new was returned"
  else
    (( ELIGIBLE > 0 )) || stop "there is no shelved draft this script may return. Nothing was changed."
    (( LAST_HOUR < PER_HOUR )) || stop "$LAST_HOUR were returned in the last 60 minutes and the pace is $PER_HOUR an hour. Nothing was changed."
    ID="$(return_drafts 1 "$DETAIL")" || db_fail
    [[ -n "$ID" && "$ID" != *$'\n'* ]] || stop "no draft was returned (another run may have just returned one, or the pace is spent). Run this again with no option to see the state."
    say "   returned ONE draft to the queue: $(describe "$ID")"
  fi
  say "   watching what the sending Mac does with it (up to $WATCH_SECONDS s; a fixed Mac delivers it, an unfixed one shelves it again)…"
  waited=0
  while :; do
    row="$(q "SELECT status, coalesce(\"failureCode\", '-'), attempts, coalesce(left(error, 160), '-') FROM \"OutreachAttempt\" WHERE id = '$ID';")" || db_fail
    [[ -n "$row" ]] || stop "the returned draft ($ID) can no longer be found. Nothing else was changed."
    IFS='|' read -r ST CODE TRIES ERR <<<"$row"
    case "$ST" in
      SENT|REPLIED)
        say "-- DELIVERED after about $waited s. The Mac is fixed and sending. Next: bash $0 --run   (returns up to $BATCH more; at most $PER_HOUR in any hour)"
        exit 0 ;;
      FAILED)
        if [[ "$CODE" == "profile-gone" && "$ERR" == *"anonymous probe: not found"* ]]; then
          say "-- SHELVED AGAIN after about $waited s, with no browser opened: the sending Mac still runs the OLD page lookup."
          say "   Nothing else was returned. On the Mac Studio, run the Mac fix (again if it was run) and read its LAST line —"
          say "   it must say 'DONE'. Then run this test again."
          exit 3
        fi
        say "-- The Mac tried it and it failed a different way: $CODE (tries $TRIES) — $ERR"
        say "   That is not the page lookup. The draft is parked where the dashboard shows it; nothing else was returned."
        exit 3 ;;
      SKIPPED)
        say "-- The draft was withdrawn by the planner while it waited ($ERR). Nothing else was returned. Run the test again."
        exit 4 ;;
    esac
    if (( waited >= WATCH_SECONDS )); then
      say "-- STILL WAITING after $waited s (status $ST, tries $TRIES). It has not been shelved again, which an unfixed Mac does within a minute or two,"
      say "   so either the Mac is holding it for a rule, or the Mac's agent is not running. What the Mac last reported:"
      mac_says
      say "   Run  bash $0 --test  again in a few minutes — it will watch this same draft and return nothing new."
      exit 4
    fi
    sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
  done
fi

# --run
(( DELIVERED > 0 )) || stop "no returned draft has been delivered yet, so nothing shows the Mac is fixed. Run  bash $0 --test  first. Nothing was changed."
(( UNFIXED == 0 )) || stop "a returned draft was shelved AGAIN and nothing returned after it has been delivered — the Mac is not sending properly. Run  bash $0 --test  first. Nothing was changed."
(( ELIGIBLE > 0 )) || { say "-- nothing left to return. Done."; exit 0; }
ROOM=$((BATCH - WAITING)); ALLOWED=$((PER_HOUR - LAST_HOUR)); N=$ROOM
(( ALLOWED < N )) && N=$ALLOWED
(( ELIGIBLE < N )) && N=$ELIGIBLE
if (( ROOM <= 0 )); then stop "$WAITING returned drafts are still waiting to go out — run this again when they have gone. Nothing was changed."; fi
if (( ALLOWED <= 0 )); then
  NEXT="$(q "$CTE SELECT to_char(min(at) + interval '60 minutes' + interval '330 min', 'HH24:MI') FROM ret WHERE at > (now() AT TIME ZONE 'UTC') - interval '60 minutes' AND status <> 'FAILED';")" || db_fail
  stop "$LAST_HOUR were returned in the last 60 minutes and the pace is $PER_HOUR an hour. The next may be returned at about $NEXT IST. Nothing was changed."
fi
IDS="$(return_drafts "$N" "$DETAIL")" || db_fail
COUNT="$(printf '%s' "$IDS" | grep -c . || true)"
if (( COUNT == 0 )); then say "   returned nothing: another run released a batch a moment ago, or the pace is spent."
else say "   returned $COUNT draft(s) to the queue. The Mac sends them about a minute apart."; fi
read_state
print_state
say "-- DONE. Run  bash $0 --run  again for the next batch, or with no option to see the state."
exit 0
