#!/usr/bin/env bash
# explain-turn-pass.sh — WHY no page took over a company's turn. READ-ONLY. Run on the server.
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<sha>/scripts/explain-turn-pass.sh -o /tmp/etp.sh && bash /tmp/etp.sh
#
# The planner logs `turn passes passed=… keptWhileIntroWaits=… waitingForARead=…` only when one of
# those is above zero, so a pass that ends on any other rule leaves NO trace — exactly the silence
# 17 Nov's first post-deploy log showed. This replays `passTurn` (src/outreach/rotation.ts) rule by
# rule over the live database, for every live verified prospect, and says which rule ended it.
#
# What it mirrors, and from where (re-read these if they change):
#   ring          whoseTurn → ringFor (a group) or the planner's fleet ring (pairs × same fleet,
#                 ordered cohort then handle); categories.ts, plan.ts
#   unavailable   readSenderAvailability (status, dead session, never signed in, not held by a Mac
#                 seen in 72 h) + readBlockedRoutes parks (any FAILED park; `unreadable` for 7 days)
#   last writer   readTurnHistory: newest delivered row WITH a sentAt, ties on the larger id
#   walk start    after the last writer if it is in the ring, else stableIndex (FNV-1a) — rotation.ts
#   pass rules    1 replied · 2 elected page never wrote · 3 elected page has a message out ·
#                 4 an available never-wrote page holds one (kept) / any page has one (no pass) ·
#                 6 no available never-wrote page · 5 a writing page's conversation unread since it
#                 wrote (after 2026-11-16 12:35 UTC) · otherwise a pass, IF there is nothing new to say
#
# What it does NOT know: whether there is something new to say (the planner's describable posts),
# and whether the planner ever asked rotation about a company (it asks only when some page's pair
# passes the governor). A company bucketed "would pass" with no pass in the log is one of those.
#
# Prints no secret: it reads through the local `postgres` superuser, never the app's DATABASE_URL.
set -euo pipefail

APP="${DS_APP_DIR:-/opt/ds-sales-agent}"
PSQL="${DS_PSQL:-sudo -u postgres psql -X -q -d ds_sales_agent}"

echo "== 1. Is the turn-pass build the one running? =="
if [[ -d "$APP" ]]; then
  echo "   deployed build: $(cat "$APP/.version" 2>/dev/null || echo 'no .version file')"
  if grep -q 'pass.holdsDraft.size > 0' "$APP/src/outreach/rotation.ts" 2>/dev/null; then
    echo "   turn-pass code on disk: yes (ad62a53 or later)"
  else
    echo "   turn-pass code on disk: NO — the deploy did not land; nothing below can be a pass"
  fi
  if command -v pm2 >/dev/null 2>&1; then
    # Only these fields: pm2 jlist carries the process ENVIRONMENT, which holds secrets.
    pm2 jlist 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let list = []; try { list = JSON.parse(s) } catch { console.log("   pm2 list unreadable"); return }
        const w = list.find((p) => p.name === "ds-sales-worker")
        if (!w) { console.log("   ds-sales-worker is not in pm2"); return }
        const e = w.pm2_env || {}
        console.log(`   worker: ${e.status} · started ${new Date(e.pm_uptime).toISOString()} · restarts ${e.restart_time}`)
      })' || true
    if [[ -f "$APP/.version" ]]; then
      echo "   files updated:  $(date -u -r "$APP/.version" +%Y-%m-%dT%H:%M:%SZ)  (the worker must have started AFTER this)"
    fi
  fi
else
  echo "   $APP not found — set DS_APP_DIR, or this is not the server (the database part still runs)"
fi
echo

BASE=$(cat <<'SQL'
WITH RECURSIVE
nowu AS (SELECT (now() AT TIME ZONE 'UTC') AS n),
hold_row AS (SELECT value FROM "Setting" WHERE key = 'sessionHolderSeen' AND value ~ '^\s*\{'),
pres AS (
  SELECT e FROM "Setting" s, jsonb_array_elements(s.value::jsonb) AS e
  WHERE s.key = 'devicePresence' AND s.value ~ '^\s*\[' AND jsonb_typeof(e) = 'object'
),
/* onlineSessionHolders: the rule is INERT unless a presence entry carries a `handles` array. */
witness AS (SELECT EXISTS (SELECT 1 FROM pres WHERE jsonb_typeof(e->'handles') = 'array') AS yes),
holders AS (
  SELECT lower(j.key) AS handle,
    CASE WHEN j.value ~ '^\d{4}-\d{2}-\d{2}T' THEN (j.value)::timestamptz AT TIME ZONE 'UTC' END AS at
  FROM hold_row, jsonb_each_text(hold_row.value::jsonb) AS j
  UNION ALL
  SELECT lower(h),
    CASE WHEN (p.e->>'at') ~ '^\d{4}-\d{2}-\d{2}T' THEN (p.e->>'at')::timestamptz AT TIME ZONE 'UTC' END
  FROM pres p,
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.e->'handles') = 'array' THEN p.e->'handles' ELSE '[]'::jsonb END) AS h
  WHERE jsonb_typeof(p.e->'at') = 'string'
),
acct AS (
  SELECT s.id, s.handle, s.cohort, s."fleetMember" AS fleet,
    CASE
      WHEN s.status = 'CHALLENGED' THEN 'flagged by Instagram'
      WHEN s.status <> 'ACTIVE' THEN lower(s.status)
      WHEN s."sessionInvalidAt" IS NOT NULL THEN 'logged out'
      WHEN s."sessionPath" IS NULL THEN 'never signed in'
      WHEN (SELECT yes FROM witness) AND NOT EXISTS (
        SELECT 1 FROM holders h, nowu WHERE h.handle = lower(s.handle) AND h.at >= nowu.n - interval '72 hours')
        THEN 'on no Mac seen in 72 h'
    END AS unavailable_why,
    COALESCE((SELECT array_agg(DISTINCT lower(c.slug)) FROM "CategorySender" cs JOIN "Category" c ON c.id = cs."categoryId"
              WHERE cs."senderId" = s.id AND cs.enabled), ARRAY['bollywood']) AS cats
  FROM "SenderAccount" s
),
pros AS (
  SELECT t.id, t.handle,
    COALESCE((SELECT array_agg(DISTINCT lower(c.slug)) FROM "CategoryTarget" ct JOIN "Category" c ON c.id = ct."categoryId"
              WHERE ct."targetId" = t.id AND ct.enabled), ARRAY['bollywood']) AS cats
  FROM "TargetAccount" t
  WHERE t.role = 'PROSPECT' AND NOT t."optedOut" AND t."isVerified" IS TRUE
),
pa AS (
  SELECT a."targetId" AS tid, a."senderId" AS sid,
    bool_or(a.status IN ('SENT','REPLIED')) AS wrote,
    max(a."sentAt") FILTER (WHERE a.status IN ('SENT','REPLIED')) AS last_wrote,
    max(a."replyCheckedAt") AS last_read,
    bool_or(a.status IN ('QUEUED','READY','SENDING')) AS draft_out,
    bool_or(a.status = 'FAILED' AND a."failureCode" = 'not-in-thread') AS park_out,
    min(a."queuedAt") FILTER (WHERE a.status = 'FAILED' AND a."failureCode" = 'not-in-thread') AS park_at,
    bool_or(a."repliedAt" IS NOT NULL OR a."replyPostedAt" IS NOT NULL) AS replied
  FROM "OutreachAttempt" a WHERE a."targetId" IN (SELECT id FROM pros)
  GROUP BY 1, 2
),
blocked AS (
  SELECT DISTINCT p."targetId" AS tid, p."senderId" AS sid
  FROM "OutreachAttempt" a JOIN "OutreachPair" p ON p.id = a."pairId", nowu
  WHERE a.status = 'FAILED' AND a."failureCode" IS NOT NULL
    AND (a."failureCode" <> 'unreadable' OR a."queuedAt" >= nowu.n - interval '7 days')
),
cat_t AS (
  SELECT DISTINCT ON (ct."targetId") ct."targetId" AS tid, ct."categoryId" AS cid
  FROM "CategoryTarget" ct WHERE ct.enabled AND ct."targetId" IN (SELECT id FROM pros)
  ORDER BY ct."targetId", ct."createdAt"
),
ring_raw AS (
  SELECT c.tid, s.id AS sid, cs.position AS k1, s.handle AS k2
  FROM cat_t c
  JOIN "CategorySender" cs ON cs."categoryId" = c.cid AND cs.enabled
  JOIN "SenderAccount" s ON s.id = cs."senderId" AND s."fleetMember"
  UNION ALL
  SELECT t.id, f.id, f.cohort, f.handle
  FROM pros t
  JOIN "OutreachPair" p ON p."targetId" = t.id
  JOIN acct f ON f.id = p."senderId" AND f.fleet
  WHERE f.cats && t.cats AND NOT EXISTS (SELECT 1 FROM cat_t c WHERE c.tid = t.id)
),
ring AS (
  SELECT r.tid, r.sid, f.handle,
    (row_number() OVER (PARTITION BY r.tid ORDER BY r.k1, r.k2 COLLATE "C") - 1)::int AS pos,
    (count(*) OVER (PARTITION BY r.tid))::int AS n,
    (f.unavailable_why IS NULL AND b.sid IS NULL) AS free
  FROM ring_raw r JOIN acct f ON f.id = r.sid
  LEFT JOIN blocked b ON b.tid = r.tid AND b.sid = r.sid
),
fnv(tid, i, h) AS (
  SELECT id, 0, 2166136261::bigint FROM pros
  UNION ALL
  SELECT f.tid, f.i + 1, ((f.h # ascii(substr(f.tid, f.i + 1, 1))::bigint) * 16777619) % 4294967296
  FROM fnv f WHERE f.i < length(f.tid)
),
lastw AS (
  SELECT DISTINCT ON (a."targetId") a."targetId" AS tid, a."senderId" AS sid
  FROM "OutreachAttempt" a
  WHERE a."targetId" IN (SELECT id FROM pros) AND a.status IN ('SENT','REPLIED') AND a."sentAt" IS NOT NULL
  ORDER BY a."targetId", a."sentAt" DESC, a.id COLLATE "C" DESC
),
startpos AS (
  SELECT t.id AS tid,
    COALESCE(
      (SELECT rg.pos + 1 FROM ring rg JOIN lastw l ON l.tid = rg.tid AND l.sid = rg.sid WHERE rg.tid = t.id),
      (SELECT abs(CASE WHEN fv.h >= 2147483648 THEN fv.h - 4294967296 ELSE fv.h END)
         FROM fnv fv WHERE fv.tid = t.id AND fv.i = length(t.id))
    ) AS raw_start
  FROM pros t
),
walk AS (
  SELECT rg.*, ((rg.pos - (sp.raw_start % rg.n)) + rg.n) % rg.n AS step
  FROM ring rg JOIN startpos sp ON sp.tid = rg.tid
),
elected AS (
  SELECT DISTINCT ON (w.tid) w.tid, w.sid, w.handle, w.step
  FROM walk w WHERE w.free ORDER BY w.tid, w.step
),
outs AS (
  SELECT pa.tid,
    string_agg('@' || s.handle || CASE WHEN pa.park_out THEN ' (parked ' || to_char(pa.park_at, 'DD Mon') || ')' ELSE ' (waiting)' END
               || CASE WHEN pa.wrote THEN '' ELSE ' [never delivered]' END, ', ' ORDER BY s.handle) AS list
  FROM pa JOIN "SenderAccount" s ON s.id = pa.sid
  WHERE pa.park_out OR pa.draft_out
  GROUP BY pa.tid
),
unread AS (
  SELECT pa.tid, string_agg('@' || s.handle, ', ' ORDER BY s.handle) AS list
  FROM pa JOIN "SenderAccount" s ON s.id = pa.sid
  WHERE pa.wrote AND (pa.last_read IS NULL OR pa.last_read < greatest(pa.last_wrote, timestamp '2026-11-16 12:35:00'))
  GROUP BY pa.tid
),
classified AS (
  SELECT t.id AS tid, t.handle, e.handle AS elected,
    COALESCE((SELECT bool_or(pa.replied) FROM pa WHERE pa.tid = t.id), false) AS replied,
    COALESCE((SELECT count(*) FROM pa WHERE pa.tid = t.id AND pa.wrote), 0) AS writers,
    o.list AS out_list, u.list AS unread_list,
    CASE
      WHEN COALESCE((SELECT bool_or(pa.replied) FROM pa WHERE pa.tid = t.id), false) THEN '1 replied — no pass, by design'
      WHEN e.sid IS NULL THEN '0 no page in their ring can take a turn'
      WHEN NOT EXISTS (SELECT 1 FROM pa WHERE pa.tid = t.id AND pa.sid = e.sid AND pa.wrote) THEN '2 the page whose turn it is never wrote — an ordinary introduction'
      WHEN EXISTS (SELECT 1 FROM pa WHERE pa.tid = t.id AND pa.sid = e.sid AND (pa.park_out OR pa.draft_out)) THEN '3 the page whose turn it is has a message out to them'
      WHEN EXISTS (SELECT 1 FROM walk w JOIN pa ON pa.tid = w.tid AND pa.sid = w.sid
                   WHERE w.tid = t.id AND w.sid <> e.sid AND w.free AND NOT pa.wrote AND (pa.park_out OR pa.draft_out))
        THEN '4a a never-wrote page''s introduction is already out (kept turn — logged)'
      WHEN o.list IS NOT NULL THEN '4b another page has a message out to them — no pass'
      WHEN NOT EXISTS (SELECT 1 FROM walk w WHERE w.tid = t.id AND w.sid <> e.sid AND w.free
                       AND NOT EXISTS (SELECT 1 FROM pa WHERE pa.tid = w.tid AND pa.sid = w.sid AND pa.wrote))
        THEN '6 no available page that never wrote to them'
      WHEN u.list IS NOT NULL THEN '5 waits for a writing page''s conversation to be read (logged)'
      ELSE '7 a pass is due IF there is nothing new to say (logged)'
    END AS bucket
  FROM pros t
  LEFT JOIN elected e ON e.tid = t.id
  LEFT JOIN outs o ON o.tid = t.id
  LEFT JOIN unread u ON u.tid = t.id
)
SQL
)

run() { $PSQL -v ON_ERROR_STOP=1 -P footer=off -P pager=off "$@"; }

echo "== 2. The switches (a row here overrides the shipped default: both default to true) =="
run -c "BEGIN READ ONLY; SELECT key, value, \"updatedAt\" FROM \"Setting\" WHERE key IN ('passTurnWhenNothingNew','passTurnOnlyAfterRead','replyHaltScope') ORDER BY key; COMMIT;"
echo

echo "== 3. Our pages, as rotation sees them =="
run -c "BEGIN READ ONLY; $BASE SELECT '@' || handle AS page, CASE WHEN fleet THEN 'in rotation' ELSE 'out of rotation' END AS rotation,
  COALESCE(unavailable_why, 'can send') AS state, array_to_string(cats, ',') AS fleets FROM acct ORDER BY fleet DESC, handle; COMMIT;"
echo

echo "== 4. Every live verified company, by the rule that ends the turn pass (first rule that applies) =="
run -c "BEGIN READ ONLY; $BASE SELECT bucket, count(*) AS companies FROM classified GROUP BY bucket ORDER BY bucket; COMMIT;"
echo

echo "== 5. Up to 6 examples per rule =="
run -c "BEGIN READ ONLY; $BASE SELECT bucket, '@' || handle AS company, '@' || elected AS turn_is_with, writers AS pages_wrote,
  COALESCE(out_list, '') AS messages_out, COALESCE(unread_list, '') AS unread_since_wrote
  FROM (SELECT c.*, row_number() OVER (PARTITION BY bucket ORDER BY handle) AS r FROM classified c) x
  WHERE r <= 6 ORDER BY bucket, handle; COMMIT;"
echo

echo "== 6. Messages out that block a pass (rule 4b), by page: a parked one may have reached them =="
run -c "BEGIN READ ONLY; $BASE SELECT '@' || s.handle AS page,
  count(*) FILTER (WHERE pa.park_out) AS parked_not_in_thread,
  count(*) FILTER (WHERE pa.draft_out) AS waiting,
  count(*) FILTER (WHERE NOT pa.wrote) AS page_never_delivered_to_them,
  to_char(min(pa.park_at), 'DD Mon') AS oldest_park, to_char(max(pa.park_at), 'DD Mon') AS newest_park
  FROM classified c JOIN pa ON pa.tid = c.tid AND (pa.park_out OR pa.draft_out)
  JOIN \"SenderAccount\" s ON s.id = pa.sid
  WHERE c.bucket LIKE '4b%' GROUP BY s.handle ORDER BY s.handle; COMMIT;"
echo

echo "== 7. not-in-thread parks to live companies, by IST day they were queued (all pages) =="
run -c "BEGIN READ ONLY; SELECT to_char(a.\"queuedAt\" + interval '330 minutes', 'YYYY-MM-DD') AS ist_day, count(*) AS parks,
  count(DISTINCT a.\"targetId\") AS companies
  FROM \"OutreachAttempt\" a JOIN \"TargetAccount\" t ON t.id = a.\"targetId\"
  WHERE a.status = 'FAILED' AND a.\"failureCode\" = 'not-in-thread' AND NOT t.\"optedOut\" AND t.role = 'PROSPECT'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 30; COMMIT;"
