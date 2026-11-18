#!/usr/bin/env bash
# explain-shelved.sh — READ-ONLY. Run on the box (the server), as root:   bash explain-shelved.sh
#
# Answers, in about a dozen lines, why messages are waiting or shelved right now:
#   - was a shelved draft returned to the queue (an `attempt.requeued` audit row), and what became of it:
#     delivered, still waiting, or shelved AGAIN as "page is gone" (which means the sending Mac still
#     runs the old page lookup — see scripts/mac-hotfix-probe-404.sh);
#   - what was written in the last 30 hours, by outcome, and when the shelved ones were written;
#   - whether any company holds more than one shelved draft;
#   - what the sending Mac's last send tick did and why it held, when it last reported in, and on which build.
#
# It writes nothing: every statement runs inside BEGIN READ ONLY. It prints no secret (no .env is opened;
# the Setting rows shown are the dispatcher's own state, the presence row, the selected Mac, the switch and
# the send lock). Times are IST.
#
# Written 18 Nov 2026, when the Mac's 10 Sept build shelved 41 introductions on a lookup that answers
# "not found" for real pages. Checked on a scratch Postgres 16 with the real schema in five states:
# nothing returned, one returned and shelved again, one returned and delivered, no Mac rows at all, no drafts.
set -uo pipefail
echo "-- explain-shelved.sh — read-only; times are IST"
# An override must keep -q, or psql prints BEGIN and COMMIT around the table.
PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"
trap 'rc=$?; if [[ $rc -ne 0 ]]; then echo "-- STOPPED (exit $rc): the query did not finish. Its error is on the lines just above this one."; fi' EXIT

read -r -d '' SQL <<'SQLEND' || true
WITH n AS (SELECT (now() AT TIME ZONE 'UTC') AS t),
a AS (SELECT o.id, o.status, o."failureCode" AS code, o.attempts, o."queuedAt" AS q, s.handle AS page, c.handle AS company FROM "OutreachAttempt" o JOIN "SenderAccount" s ON s.id=o."senderId" JOIN "TargetAccount" c ON c.id=o."targetId", n WHERE o."queuedAt" > n.t - interval '30 hours'),
rq AS (SELECT l.at, o.status, o."failureCode" AS code FROM "AuditLog" l LEFT JOIN "OutreachAttempt" o ON o.id=substr(l.entity,17), n WHERE l.action='attempt.requeued' AND l.at > n.t - interval '30 hours'),
d AS (SELECT value::jsonb AS j, "updatedAt" AS u FROM "Setting" WHERE key='dispatchState' AND left(ltrim(value),1)='{'),
p AS (SELECT e FROM "Setting" s, jsonb_array_elements(s.value::jsonb) AS e WHERE s.key='devicePresence' AND left(ltrim(s.value),1)='[')
SELECT what, says FROM (
SELECT 1 AS k, 'time now' AS what, to_char(n.t + interval '330 min','DD Mon HH24:MI')||' IST' AS says FROM n
UNION ALL SELECT 2, 'test re-queue', CASE WHEN count(*)=0 THEN 'NOT RUN: no draft was returned to the queue in the last 30 hours' ELSE count(*)||' returned, last at '||to_char(max(at) + interval '330 min','DD Mon HH24:MI')||' IST. Now: '||count(*) FILTER (WHERE status IN ('SENT','REPLIED'))||' delivered, '||count(*) FILTER (WHERE status IN ('READY','QUEUED','SENDING'))||' still waiting, '||count(*) FILTER (WHERE status='FAILED' AND code='profile-gone')||' shelved AGAIN as page-gone, '||count(*) FILTER (WHERE status IS NULL OR status NOT IN ('SENT','REPLIED','READY','QUEUED','SENDING') AND NOT (status='FAILED' AND code IS NOT DISTINCT FROM 'profile-gone'))||' other' END FROM rq
UNION ALL SELECT 3, 'drafts written, 30 h', count(*) FILTER (WHERE status='FAILED' AND code='profile-gone')||' shelved page-gone, '||count(*) FILTER (WHERE status IN ('READY','QUEUED'))||' waiting, '||count(*) FILTER (WHERE status='SENDING')||' being sent, '||count(*) FILTER (WHERE status IN ('SENT','REPLIED'))||' delivered, '||count(*) FILTER (WHERE status='FAILED' AND code IS DISTINCT FROM 'profile-gone')||' failed other, '||count(*) FILTER (WHERE status='SKIPPED')||' withdrawn' FROM a
UNION ALL SELECT 4, 'shelved: written at', coalesce(string_agg(c||' at '||to_char(h + interval '330 min','DD Mon HH24:MI'), ', ' ORDER BY h),'none') FROM (SELECT date_trunc('hour', q) + floor(extract(minute FROM q)/15)*interval '15 min' AS h, count(*) AS c FROM a WHERE status='FAILED' AND code='profile-gone' GROUP BY 1) g
UNION ALL SELECT 4, 'shelved: companies', count(*)||' drafts for '||count(DISTINCT company)||' companies'||coalesce('; more than one draft: '||(SELECT string_agg('@'||company||' x'||c, ', ') FROM (SELECT company, count(*) AS c FROM a WHERE status='FAILED' AND code='profile-gone' GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT 5) m),'') FROM a WHERE status='FAILED' AND code='profile-gone'
UNION ALL SELECT 5, 'not shelved', coalesce(string_agg('@'||page||' to @'||company||' '||status||coalesce('/'||code,'')||' tries '||attempts||' written '||to_char(q + interval '330 min','DD Mon HH24:MI'), '; ' ORDER BY q),'none') FROM (SELECT * FROM a WHERE NOT (status='FAILED' AND code IS NOT DISTINCT FROM 'profile-gone') ORDER BY q DESC LIMIT 4) w
UNION ALL SELECT 6, 'Mac last send tick', to_char(u + interval '330 min','DD Mon HH24:MI:SS')||' IST ('||round(extract(epoch FROM n.t - u))||' s ago): '||coalesce(j->>'action','?')||' / '||coalesce(j->>'reason','?')||', sent '||coalesce(j->>'sent','?')||', held '||coalesce(j->>'held','-') FROM d, n
UNION ALL SELECT 7, 'tick said', left(j->>'detail',200) FROM d
UNION ALL SELECT 8, 'held because', left(j->'holdReasons'->>0,200) FROM d WHERE jsonb_typeof(j->'holdReasons')='array'
UNION ALL SELECT 9, 'Mac online', coalesce(e->>'device','?')||': last reported in '||CASE WHEN (e->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' THEN to_char(((e->>'at')::timestamptz AT TIME ZONE 'UTC') + interval '330 min','DD Mon HH24:MI:SS')||' IST ('||round(extract(epoch FROM n.t - ((e->>'at')::timestamptz AT TIME ZONE 'UTC')))||' s ago)' ELSE coalesce(e->>'at','?') END||', build '||coalesce(e->>'version','?')||', pages '||coalesce((SELECT string_agg(x, ',') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e->'handles')='array' THEN e->'handles' ELSE '[]'::jsonb END) AS x),'none') FROM p, n
UNION ALL SELECT 10, v.key, coalesce(left(s.value,90)||' (changed '||to_char(s."updatedAt" + interval '330 min','DD Mon HH24:MI')||' IST)','(not set)') FROM (VALUES ('activeDevice'),('autopilotEnabled'),('sendLock')) AS v(key) LEFT JOIN "Setting" s ON s.key=v.key
) r ORDER BY k, what;
SQLEND

# Unaligned: no padding to the widest cell, so a row fits console lines instead of wrapping into five.
$PSQL -v ON_ERROR_STOP=1 -P footer=off -P pager=off -A -F ' | ' -c "SET statement_timeout = '60s'" -c "BEGIN READ ONLY; $SQL COMMIT;"
rc=$?
[[ $rc -eq 0 ]] && echo "-- end"
exit $rc
