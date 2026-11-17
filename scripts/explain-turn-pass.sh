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
echo "== 9. Risk of switching the read requirement off (passTurnOnlyAfterRead): which held companies may have answered unseen =="
echo "   A rough ESTIMATE. Read the range from as_seen to corrected, not one number."
# Rough autoresponder phrasing. A reply with no words (a like, an attachment) is not counted as words.
AUTO='(thank(s| you) for (reaching out|contacting|your message|messaging)|out of (the )?office|auto.?reply|automated (message|response|reply)|we.?ve received your|we have received your (message|query|request|enquiry|inquiry)|our team will (get back|respond|revert)|will (get back|respond|revert) (to you )?(shortly|soon|within)|we.?ll (get back|respond|revert))'
FLOOR="timestamp '2026-11-16 12:35:00'"
R9="/* Per page: is it read by a Mac, when its inbox check last found anything, and (for Mac-held pages) the stretch nothing
   could see: from the last inbox find before the 16 Nov fix (27 Oct at the latest) to that page's last send before it.
   A reply from that stretch was pushed down the inbox by the later sends, below what the check scrolls to. */
pg AS (
  SELECT f.id AS sid, f.handle, (f.unavailable_why IS NOT NULL) AS unheld, i.inbox_last,
    least(COALESCE(i.g1, timestamp '2026-10-27 00:00:00'), timestamp '2026-10-27 00:00:00') AS g1,
    (SELECT max(a.\"sentAt\") FROM \"OutreachAttempt\" a WHERE a.\"senderId\" = f.id AND a.status IN ('SENT','REPLIED')
       AND a.\"sentAt\" < $FLOOR) AS g2
  FROM acct f LEFT JOIN LATERAL (
    SELECT max(l.at) AS inbox_last, max(l.at) FILTER (WHERE l.at < $FLOOR) AS g1 FROM \"AuditLog\" l
    WHERE l.action = 'reply.record.inbox' AND l.detail LIKE '%in @' || f.handle || '''s inbox%') i ON true
),
conv AS (
  SELECT a.\"targetId\" AS tid, a.\"senderId\" AS sid,
    max(a.\"sentAt\") FILTER (WHERE a.status IN ('SENT','REPLIED')) AS last_wrote,
    max(a.\"replyCheckedAt\") AS last_read, max(a.\"repliedAt\") AS seen_at,
    bool_or(a.\"repliedAt\" IS NOT NULL OR a.\"replyPostedAt\" IS NOT NULL) AS replied,
    bool_or((a.\"repliedAt\" IS NOT NULL OR a.\"replyPostedAt\" IS NOT NULL) AND a.\"replyText\" IS NOT NULL
            AND a.\"replyText\" !~* '$AUTO') AS replied_words,
    /* Before 3 Sept the inbox check placed a row by NAME only; a company stored under its raw handle could not be placed. */
    bool_or(t.\"displayName\" IS NOT NULL AND regexp_replace(lower(t.\"displayName\"), '[^a-z0-9]', '', 'g')
            <> regexp_replace(lower(t.handle), '[^a-z0-9]', '', 'g')) AS name_placeable
  FROM \"OutreachAttempt\" a
  JOIN \"TargetAccount\" t ON t.id = a.\"targetId\" AND t.role = 'PROSPECT'
    AND lower(t.handle) NOT IN (SELECT lower(handle) FROM \"SenderAccount\")
  GROUP BY 1, 2
  HAVING bool_or(a.status IN ('SENT','REPLIED') AND a.\"sentAt\" IS NOT NULL)
),
/* Reply delays, every page. A reply date equal to one of our send times was clamped to it: 0 days. Otherwise the
   dated reply minus our latest message before it (the pair's, else the company's). */
dd AS (
  SELECT d, words FROM (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM \"OutreachAttempt\" x WHERE x.\"targetId\" = a.\"targetId\"
                 AND x.status IN ('SENT','REPLIED') AND x.\"sentAt\" = a.\"replyPostedAt\") THEN 0
      ELSE EXTRACT(EPOCH FROM (a.\"replyPostedAt\" - COALESCE(
        (SELECT max(x.\"sentAt\") FROM \"OutreachAttempt\" x WHERE x.\"targetId\" = a.\"targetId\" AND x.\"senderId\" = a.\"senderId\"
           AND x.status IN ('SENT','REPLIED') AND x.\"sentAt\" <= a.\"replyPostedAt\"),
        (SELECT max(x.\"sentAt\") FROM \"OutreachAttempt\" x WHERE x.\"targetId\" = a.\"targetId\"
           AND x.status IN ('SENT','REPLIED') AND x.\"sentAt\" <= a.\"replyPostedAt\")))) / 86400.0 END AS d,
      (a.\"replyText\" IS NOT NULL AND a.\"replyText\" !~* '$AUTO') AS words
    FROM \"OutreachAttempt\" a WHERE a.\"replyPostedAt\" IS NOT NULL
  ) x WHERE d IS NOT NULL
),
/* w: days a conversation of a page no Mac reads was watched after our last message (a read, a recorded reply, or the
   inbox check where it could place the company). lo..hi: for a Mac-held page, the days after our message nothing saw. */
cw AS (
  SELECT c.*, pg.unheld, pg.handle AS page,
    EXTRACT(EPOCH FROM (greatest(c.last_read, c.seen_at, CASE WHEN c.name_placeable
        OR pg.inbox_last >= timestamp '2026-09-03 08:00:00' THEN pg.inbox_last END) - c.last_wrote)) / 86400.0 AS w,
    EXTRACT(EPOCH FROM (nowu.n - c.last_wrote)) / 86400.0 AS age,
    EXTRACT(EPOCH FROM (greatest(pg.g1, c.last_read, c.last_wrote) - c.last_wrote)) / 86400.0 AS lo,
    EXTRACT(EPOCH FROM (pg.g2 - c.last_wrote)) / 86400.0 AS hi,
    (c.last_read IS NULL OR c.last_read < greatest(c.last_wrote, $FLOOR)) AS unread
  FROM conv c JOIN pg ON pg.sid = c.sid, nowu
),
/* F(x) = share of dated replies that came within x days. Three curves: all, words only, and without 0-day replies. */
cf AS (
  SELECT cw.*,
    CASE WHEN cw.replied THEN 1 WHEN cw.w > 0 THEN COALESCE(f.w_a, 0) ELSE 0 END AS fw,
    CASE WHEN cw.replied_words THEN 1 WHEN cw.w > 0 THEN COALESCE(f.w_w, 0) ELSE 0 END AS fw_words,
    CASE WHEN cw.replied THEN 1 WHEN cw.w > 0 THEN COALESCE(f.w_z, 0) ELSE 0 END AS fw_nz,
    COALESCE(f.age_a, 1) AS fa, COALESCE(f.age_w, 1) AS fa_words, COALESCE(f.age_z, 1) AS fa_nz,
    CASE WHEN cw.hi > cw.lo THEN greatest(0, COALESCE(f.hi_a, 1) - CASE WHEN cw.lo > 0 THEN COALESCE(f.lo_a, 0) ELSE 0 END) ELSE 0 END AS gap,
    CASE WHEN cw.hi > cw.lo THEN greatest(0, COALESCE(f.hi_w, 1) - CASE WHEN cw.lo > 0 THEN COALESCE(f.lo_w, 0) ELSE 0 END) ELSE 0 END AS gap_words,
    CASE WHEN cw.hi > cw.lo THEN greatest(0, COALESCE(f.hi_z, 1) - CASE WHEN cw.lo > 0 THEN COALESCE(f.lo_z, 0) ELSE 0 END) ELSE 0 END AS gap_nz
  FROM cw, LATERAL (
    SELECT avg((dd.d <= cw.w)::int) AS w_a, avg((dd.d <= cw.w)::int) FILTER (WHERE dd.words) AS w_w, avg((dd.d <= cw.w)::int) FILTER (WHERE dd.d > 0) AS w_z,
      avg((dd.d <= cw.age)::int) AS age_a, avg((dd.d <= cw.age)::int) FILTER (WHERE dd.words) AS age_w, avg((dd.d <= cw.age)::int) FILTER (WHERE dd.d > 0) AS age_z,
      avg((dd.d <= cw.lo)::int) AS lo_a, avg((dd.d <= cw.lo)::int) FILTER (WHERE dd.words) AS lo_w, avg((dd.d <= cw.lo)::int) FILTER (WHERE dd.d > 0) AS lo_z,
      avg((dd.d <= cw.hi)::int) AS hi_a, avg((dd.d <= cw.hi)::int) FILTER (WHERE dd.words) AS hi_w, avg((dd.d <= cw.hi)::int) FILTER (WHERE dd.d > 0) AS hi_z
    FROM dd) f
),
/* Per page: replies seen / conversations (as seen), and replies seen / the share of each conversation that was watched
   (corrected; unknown when nothing was watched — LEAST ignores a NULL, so it is guarded, never 100%). */
pr AS (
  SELECT sid, bool_or(unheld) AS unheld, count(*) AS convs, count(*) FILTER (WHERE replied) AS seen,
    count(*) FILTER (WHERE NOT name_placeable) AS not_nameable, sum(fw) AS watched,
    count(*) FILTER (WHERE replied)::numeric / nullif(count(*), 0) AS r_raw,
    count(*) FILTER (WHERE replied_words)::numeric / nullif(count(*), 0) AS r_raw_words,
    CASE WHEN sum(fw) > 0 THEN least(1, count(*) FILTER (WHERE replied)::numeric / sum(fw)) END AS r_corr,
    CASE WHEN sum(fw_words) > 0 THEN least(1, count(*) FILTER (WHERE replied_words)::numeric / sum(fw_words)) END AS r_words,
    CASE WHEN sum(fw_nz) > 0 THEN least(1, count(*) FILTER (WHERE replied)::numeric / sum(fw_nz)) END AS r_nz
  FROM cf GROUP BY sid
),
/* Every unread conversation of a live verified company with no recorded reply anywhere. Where a corrected rate is
   unknown it falls back to the rate as seen. */
hc AS (
  SELECT cl.tid, cl.handle, cl.bucket, cf.sid, cf.page, cf.unheld, cf.last_wrote, cf.w, cf.lo, cf.hi, cf.gap,
    least(0.999999, COALESCE(CASE WHEN cf.unheld THEN pr.r_raw * (cf.fa - cf.fw) / nullif(1 - pr.r_raw * cf.fw, 0)
      ELSE pr.r_raw * cf.gap / nullif(1 - pr.r_raw * (cf.fa - cf.gap), 0) END, 0)) AS p_raw,
    least(0.999999, COALESCE(CASE WHEN cf.unheld THEN COALESCE(pr.r_corr, pr.r_raw) * (cf.fa - cf.fw) / nullif(1 - COALESCE(pr.r_corr, pr.r_raw) * cf.fw, 0)
      ELSE pr.r_raw * cf.gap / nullif(1 - pr.r_raw * (cf.fa - cf.gap), 0) END, 0)) AS p_corr,
    least(0.999999, COALESCE(CASE WHEN cf.unheld THEN COALESCE(pr.r_words, pr.r_raw_words) * (cf.fa_words - cf.fw_words) / nullif(1 - COALESCE(pr.r_words, pr.r_raw_words) * cf.fw_words, 0)
      ELSE pr.r_raw_words * cf.gap_words / nullif(1 - pr.r_raw_words * (cf.fa_words - cf.gap_words), 0) END, 0)) AS p_words,
    least(0.999999, COALESCE(CASE WHEN cf.unheld THEN COALESCE(pr.r_nz, pr.r_raw) * (cf.fa_nz - cf.fw_nz) / nullif(1 - COALESCE(pr.r_nz, pr.r_raw) * cf.fw_nz, 0)
      ELSE pr.r_raw * cf.gap_nz / nullif(1 - pr.r_raw * (cf.fa_nz - cf.gap_nz), 0) END, 0)) AS p_nz
  FROM classified cl JOIN cf ON cf.tid = cl.tid AND cf.unread JOIN pr ON pr.sid = cf.sid
  WHERE NOT cl.replied
),
co AS (
  SELECT h.tid, h.handle, min(h.bucket) AS bucket,
    1 - exp(sum(ln(1 - h.p_raw))) AS risk_raw, 1 - exp(sum(ln(1 - h.p_corr))) AS risk_corr,
    1 - exp(sum(ln(1 - h.p_words))) AS risk_words, 1 - exp(sum(ln(1 - h.p_nz))) AS risk_nz,
    1 - exp(sum(ln(1 - CASE WHEN h.unheld THEN 0 ELSE h.p_corr END))) AS risk_mac_held,
    (SELECT count(*) FROM walk w WHERE w.tid = h.tid AND w.free
       AND NOT EXISTS (SELECT 1 FROM pa WHERE pa.tid = w.tid AND pa.sid = w.sid AND pa.wrote)) AS k
  FROM hc h GROUP BY h.tid, h.handle
)"
echo "-- 9a. Pages no Mac reads: how often their companies answered while something was still looking"
echo "   watched = conversations' worth actually watched (corrected = replies seen / watched). not_nameable = the August inbox check could not place them."
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT '@' || pg.handle AS page, pr.convs AS conversations, pr.seen AS replies_seen,
  round(100 * pr.r_raw, 1) AS seen_pct, round(pr.watched, 1) AS watched, round(100 * pr.r_corr, 1) AS corrected_pct,
  round(100 * pr.r_words, 1) AS words_pct, pr.not_nameable, to_char(pg.inbox_last, 'DD Mon') AS inbox_last_find,
  to_char((SELECT max(c.last_read) FROM conv c WHERE c.sid = pg.sid), 'DD Mon') AS last_read
  FROM pg JOIN pr ON pr.sid = pg.sid WHERE pg.unheld ORDER BY pg.handle; COMMIT;"
echo "-- 9b. Pages a Mac holds: only the stretch its reader was blind and later sends buried the rows counts"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT '@' || pg.handle AS page, pr.convs AS conversations, pr.seen AS replies_seen,
  round(100 * pr.r_raw, 1) AS seen_pct,
  CASE WHEN pg.g2 > pg.g1 THEN to_char(pg.g1, 'DD Mon') || ' to ' || to_char(pg.g2, 'DD Mon') ELSE 'none' END AS unseen_stretch
  FROM pg JOIN pr ON pr.sid = pg.sid WHERE NOT pg.unheld ORDER BY pg.handle; COMMIT;"
echo "-- 9c. How soon replies come (every page, dated replies)"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT count(*) AS dated_replies, round(100.0 * avg((d = 0)::int), 0) AS at_0_days_pct,
  round(100.0 * avg((d <= 1)::int), 0) AS within_1_day_pct, round(100.0 * avg((d <= 7)::int), 0) AS within_7_days_pct,
  round(100.0 * avg((d <= 30)::int), 0) AS within_30_days_pct, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::numeric, 1) AS median_days
  FROM dd; COMMIT;"
echo "-- 9d. Expected number with an unseen reply, by what the switch does to them (the first row is the decision)"
run -c "BEGIN READ ONLY; $BASE, $R9 SELECT CASE
    WHEN bucket LIKE '5%' THEN '1 held now - released at once'
    WHEN bucket LIKE '3%' OR bucket LIKE '4b%' THEN '2 held by a message out - released later'
    WHEN bucket LIKE '2%' OR bucket LIKE '4a%' OR bucket LIKE '7%' THEN '3 introduced anyway - no difference'
    WHEN bucket LIKE '6%' THEN '4 no page left to write - no difference'
    ELSE '5 no page can take a turn' END AS what_the_switch_does,
  count(*) AS companies, round(sum(risk_raw), 1) AS as_seen, round(sum(risk_corr), 1) AS corrected,
  round(sum(risk_words), 1) AS words_only, round(sum(risk_nz), 1) AS no_0_day,
  round(sum(risk_mac_held), 1) AS of_which_mac_held_pages,
  round(100 * (1 - exp(sum(ln(1 - least(0.999999, risk_corr))))), 0) AS chance_at_least_one_pct,
  round(sum(risk_corr * k), 1) AS unwanted_intros
  FROM co GROUP BY 1 ORDER BY 1; COMMIT;"
echo "-- 9e. The ten riskiest companies held now"
runc -c "BEGIN READ ONLY; $BASE, $R9 SELECT '@' || co.handle AS company, round(100 * co.risk_corr, 0) AS risk_pct, co.k AS intros_due,
  string_agg('@' || h.page || ' wrote ' || to_char(h.last_wrote, 'DD Mon') || CASE
      WHEN NOT h.unheld THEN ', unseen days ' || round(h.lo)::int || '-' || round(h.hi)::int
      WHEN h.w > 0 THEN ', watched ' || round(h.w)::int || ' d' ELSE ', never watched after' END, '; ' ORDER BY h.page)
    FILTER (WHERE h.p_corr > 0) AS conversations_at_risk
  FROM co JOIN hc h ON h.tid = co.tid WHERE co.bucket LIKE '5%'
  GROUP BY co.handle, co.risk_corr, co.k ORDER BY co.risk_corr DESC, co.handle LIMIT 10; COMMIT;"
echo "   Nothing later catches these: the Mac reads a thread only before a follow-up, its gate has no 'they know us' stop,"
echo "   and the server's check needs a recorded reply, which nothing can record on a page no Mac holds."
echo "   Not counted: replies by phone or WhatsApp to the number in the message — ask whoever answers it."
fi
