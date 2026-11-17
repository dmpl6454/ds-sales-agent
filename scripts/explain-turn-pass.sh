#!/usr/bin/env bash
# explain-turn-pass.sh — WHY no page took over a company's turn. READ-ONLY. Run on the server.
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<sha>/scripts/explain-turn-pass.sh -o /tmp/etp.sh && bash /tmp/etp.sh
#
# Name sections to print only those (a browser console scrolls back one screen):  bash etp.sh 4 8
# Section 9 estimates the risk of switching the read requirement off:             bash etp.sh 9
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

# No arguments: every section. Otherwise only the numbered ones, e.g. `4 8`.
WANT=" $* "
want() { [[ "$WANT" == "  " || "$WANT" == *" $1 "* ]]; }

if want 1; then
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
fi

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
# Unaligned: no padding to the widest cell, so a row fits a console line instead of wrapping into five.
runc() { run -A -F ' | ' "$@"; }

if want 2; then
echo "== 2. The switches (a row here overrides the shipped default: both default to true) =="
run -c "BEGIN READ ONLY; SELECT key, value, \"updatedAt\" FROM \"Setting\" WHERE key IN ('passTurnWhenNothingNew','passTurnOnlyAfterRead','replyHaltScope') ORDER BY key; COMMIT;"
echo
fi

if want 3; then
echo "== 3. Our pages, as rotation sees them =="
run -c "BEGIN READ ONLY; $BASE SELECT '@' || handle AS page, CASE WHEN fleet THEN 'in rotation' ELSE 'out of rotation' END AS rotation,
  COALESCE(unavailable_why, 'can send') AS state, array_to_string(cats, ',') AS fleets FROM acct ORDER BY fleet DESC, handle; COMMIT;"
echo
fi

if want 4; then
echo "== 4. Every live verified company, by the rule that ends the turn pass (first rule that applies) =="
run -c "BEGIN READ ONLY; $BASE SELECT bucket, count(*) AS companies FROM classified GROUP BY bucket ORDER BY bucket; COMMIT;"
echo
fi

if want 5; then
echo "== 5. Up to 6 examples per rule =="
runc -c "BEGIN READ ONLY; $BASE SELECT bucket, '@' || handle AS company, '@' || elected AS turn_is_with, writers AS pages_wrote,
  COALESCE(out_list, '') AS messages_out, COALESCE(unread_list, '') AS unread_since_wrote
  FROM (SELECT c.*, row_number() OVER (PARTITION BY bucket ORDER BY handle) AS r FROM classified c) x
  WHERE r <= 6 ORDER BY bucket, handle; COMMIT;"
echo
fi

if want 6; then
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
fi

if want 7; then
echo "== 7. not-in-thread parks to live companies, by IST day they were queued (all pages) =="
run -c "BEGIN READ ONLY; SELECT to_char(a.\"queuedAt\" + interval '330 minutes', 'YYYY-MM-DD') AS ist_day, count(*) AS parks,
  count(DISTINCT a.\"targetId\") AS companies
  FROM \"OutreachAttempt\" a JOIN \"TargetAccount\" t ON t.id = a.\"targetId\"
  WHERE a.status = 'FAILED' AND a.\"failureCode\" = 'not-in-thread' AND NOT t.\"optedOut\" AND t.role = 'PROSPECT'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 30; COMMIT;"
echo
fi

if want 8; then
echo "== 8. Rule 5 — the companies waiting for a read: whose conversation, and can anything read it? =="
echo "   (the Mac's reply sweep can read a page only while it holds that page's sign-in)"
R5="r5 AS (SELECT tid FROM classified WHERE bucket LIKE '5%'),
uw AS (
  SELECT r5.tid, s.handle AS page, f.unavailable_why IS NULL AS readable
  FROM r5 JOIN pa ON pa.tid = r5.tid AND pa.wrote
    AND (pa.last_read IS NULL OR pa.last_read < greatest(pa.last_wrote, timestamp '2026-11-16 12:35:00'))
  JOIN \"SenderAccount\" s ON s.id = pa.sid JOIN acct f ON f.id = pa.sid
)"
run -c "BEGIN READ ONLY; $BASE, $R5 SELECT
  CASE WHEN all_readable THEN 'released as the Mac reads them' ELSE 'stuck: a page no Mac holds wrote to them' END AS outlook,
  count(*) AS companies FROM (SELECT tid, bool_and(readable) AS all_readable FROM uw GROUP BY tid) x
  GROUP BY 1 ORDER BY 1; COMMIT;"
run -c "BEGIN READ ONLY; $BASE, $R5 SELECT '@' || u.page AS unread_page,
  CASE WHEN u.readable THEN 'yes — a Mac holds it' ELSE 'no — ' || f.unavailable_why END AS can_be_read,
  count(*) AS companies_waiting_on_it
  FROM uw u JOIN acct f ON f.handle = u.page GROUP BY u.page, u.readable, f.unavailable_why ORDER BY 3 DESC, 1; COMMIT;"
echo "   every conversation the sweep still has to read since a page last wrote (all live companies, not only rule 5):"
run -c "BEGIN READ ONLY; $BASE SELECT '@' || s.handle AS page, count(*) AS conversations_unread_since_it_wrote
  FROM pa JOIN \"SenderAccount\" s ON s.id = pa.sid
  WHERE pa.wrote AND (pa.last_read IS NULL OR pa.last_read < greatest(pa.last_wrote, timestamp '2026-11-16 12:35:00'))
  GROUP BY s.handle ORDER BY 2 DESC; COMMIT;"
fi

if want 9; then
echo "== 9. The risk of switching the read requirement off (passTurnOnlyAfterRead): how many held companies probably answered unseen =="
echo "   Estimated, not observed. Reply rate from conversations we DID read after writing; reply delays from replies we DID see."
# Rough autoresponder phrasing. Rough on purpose: a reply with no text counts as possibly human.
AUTO='(thank(s| you) for (reaching out|contacting|your message|messaging)|out of (the )?office|auto.?reply|automated (message|response|reply)|we have received your (message|query|request|enquiry|inquiry)|our team will (get back|respond|revert)|will (get back|respond|revert) (to you )?(shortly|soon|within))'
R9="allc AS (
  SELECT a.\"targetId\" AS tid, a.\"senderId\" AS sid,
    max(a.\"sentAt\") FILTER (WHERE a.status IN ('SENT','REPLIED')) AS last_wrote,
    max(a.\"replyCheckedAt\") AS last_read,
    min(COALESCE(a.\"replyPostedAt\", a.\"repliedAt\")) FILTER (WHERE a.\"repliedAt\" IS NOT NULL OR a.\"replyPostedAt\" IS NOT NULL) AS reply_at,
    bool_or(a.\"repliedAt\" IS NOT NULL OR a.\"replyPostedAt\" IS NOT NULL) AS replied,
    bool_or((a.\"repliedAt\" IS NOT NULL OR a.\"replyPostedAt\" IS NOT NULL) AND NOT COALESCE(a.\"replyText\" ~* '$AUTO', false)) AS replied_human
  FROM \"OutreachAttempt\" a JOIN \"TargetAccount\" t ON t.id = a.\"targetId\" AND t.role = 'PROSPECT'
  GROUP BY 1, 2
  HAVING bool_or(a.status IN ('SENT','REPLIED') AND a.\"sentAt\" IS NOT NULL)
),
seen AS (SELECT *, (last_read >= last_wrote) AS read_after FROM allc),
rates AS (
  SELECT count(*) FILTER (WHERE read_after) AS n_read,
    count(*) FILTER (WHERE read_after AND replied) AS n_read_replied,
    count(*) FILTER (WHERE read_after AND replied_human) AS n_read_human,
    count(*) FILTER (WHERE replied AND NOT COALESCE(read_after, false)) AS n_replied_unread
  FROM seen
),
r AS (
  SELECT n_read_replied::numeric / nullif(n_read, 0) AS central,
    (n_read_replied + n_replied_unread)::numeric / nullif(n_read + n_replied_unread, 0) AS pessimistic,
    n_read_human::numeric / nullif(n_read, 0) AS human
  FROM rates
),
dly AS (
  SELECT EXTRACT(EPOCH FROM (c.reply_at - (SELECT max(a.\"sentAt\") FROM \"OutreachAttempt\" a
      WHERE a.\"targetId\" = c.tid AND a.\"senderId\" = c.sid AND a.status IN ('SENT','REPLIED') AND a.\"sentAt\" <= c.reply_at))) / 86400.0 AS d
  FROM allc c WHERE c.replied AND c.reply_at IS NOT NULL
),
dd AS (SELECT d FROM dly WHERE d IS NOT NULL),
uc AS (
  SELECT c.tid, c.handle, c.bucket, pa.sid, pa.last_wrote, pa.last_read,
    CASE WHEN pa.last_read >= pa.last_wrote THEN EXTRACT(EPOCH FROM (pa.last_read - pa.last_wrote)) / 86400.0 END AS g,
    EXTRACT(EPOCH FROM (nowu.n - pa.last_wrote)) / 86400.0 AS age
  FROM classified c JOIN pa ON pa.tid = c.tid AND pa.wrote
    AND (pa.last_read IS NULL OR pa.last_read < greatest(pa.last_wrote, timestamp '2026-11-16 12:35:00')), nowu
  WHERE c.bucket LIKE '5%'
),
ucf AS (
  SELECT uc.*,
    CASE WHEN uc.g IS NULL THEN 0 ELSE COALESCE((SELECT avg((dd.d <= uc.g)::int) FROM dd), 0) END AS fg,
    COALESCE((SELECT avg((dd.d <= uc.age)::int) FROM dd), 1) AS fa
  FROM uc
),
pc AS (
  SELECT ucf.*,
    /* LEAST ignores a NULL, so a missing rate must stay NULL explicitly, never become 0.999999. */
    CASE WHEN r.central IS NOT NULL THEN least(0.999999, r.central * (ucf.fa - ucf.fg) / nullif(1 - r.central * ucf.fg, 0)) END AS p_central,
    CASE WHEN r.pessimistic IS NOT NULL THEN least(0.999999, r.pessimistic * ucf.fa) END AS p_pess,
    CASE WHEN r.human IS NOT NULL THEN least(0.999999, r.human * (ucf.fa - ucf.fg) / nullif(1 - r.human * ucf.fg, 0)) END AS p_human
  FROM ucf, r
),
co AS (
  SELECT tid, handle,
    1 - exp(sum(ln(1 - p_central))) AS risk_central,
    1 - exp(sum(ln(1 - p_pess))) AS risk_pess,
    1 - exp(sum(ln(1 - p_human))) AS risk_human
  FROM pc GROUP BY tid, handle
)"
echo "-- 9a. Of the conversations we fully read after our last message, how many held a reply"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT n_read AS read_after_we_wrote, n_read_replied AS with_a_reply,
  round(100.0 * n_read_replied / nullif(n_read, 0), 1) AS reply_pct,
  n_read_human AS with_a_reply_not_obviously_automatic,
  round(100.0 * n_read_human / nullif(n_read, 0), 1) AS not_automatic_pct,
  n_replied_unread AS replies_seen_without_a_full_read FROM rates; COMMIT;"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT '@' || s.handle AS page, count(*) FILTER (WHERE read_after) AS read_after_we_wrote,
  count(*) FILTER (WHERE read_after AND replied) AS with_a_reply,
  round(100.0 * count(*) FILTER (WHERE read_after AND replied) / nullif(count(*) FILTER (WHERE read_after), 0), 1) AS reply_pct,
  count(*) AS conversations, to_char(max(last_read), 'DD Mon') AS last_read_any
  FROM seen JOIN \"SenderAccount\" s ON s.id = seen.sid GROUP BY s.handle ORDER BY s.handle; COMMIT;"
echo "-- 9b. How long after our message replies arrive (replies we saw, with a date)"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT count(*) AS dated_replies,
  round(100.0 * avg((d <= 1)::int), 0) AS within_1_day_pct, round(100.0 * avg((d <= 3)::int), 0) AS within_3_days_pct,
  round(100.0 * avg((d <= 7)::int), 0) AS within_7_days_pct, round(100.0 * avg((d <= 30)::int), 0) AS within_30_days_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::numeric, 1) AS median_days FROM dd; COMMIT;"
echo "-- 9c. Expected number of the rule-5 companies with an unseen reply"
echo "   central: that reply rate, a read after we wrote counts as looking · pessimistic: replies seen any way, and no read counts"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT count(*) AS companies,
  round(sum(risk_central), 1) AS expected_central, round(sum(risk_pess), 1) AS expected_pessimistic,
  round(sum(risk_human), 1) AS expected_not_automatic,
  count(*) FILTER (WHERE risk_central >= 0.10) AS companies_10pct_or_more_central FROM co; COMMIT;"
echo "-- 9d. The ten riskiest, and the unread conversation behind each"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT '@' || co.handle AS company, round(100 * co.risk_central, 0) AS risk_pct,
  string_agg('@' || s.handle || ' wrote ' || to_char(pc.last_wrote, 'DD Mon') ||
    CASE WHEN pc.last_read IS NULL THEN ', never read' ELSE ', read ' || to_char(pc.last_read, 'DD Mon') END, '; ' ORDER BY s.handle) AS unread_conversations
  FROM co JOIN pc ON pc.tid = co.tid JOIN \"SenderAccount\" s ON s.id = pc.sid
  GROUP BY co.handle, co.risk_central ORDER BY co.risk_central DESC, co.handle LIMIT 10; COMMIT;"
fi
