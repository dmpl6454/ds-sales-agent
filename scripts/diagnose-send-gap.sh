#!/usr/bin/env bash
# ONE-OFF DIAGNOSTIC for the 19-22 Oct 2026 delivery gap (4, 0, 1, 8 sends a day after 345 and 163
# on 17-18 Oct, then 54 / 202 / 80 on 23-25 Oct). Dates are deliberately hardcoded to that window.
#
# READ-ONLY. Every query runs inside `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` with a
# 120 s statement timeout; the shell half only lists, greps and reads logs. It writes nothing, restarts
# nothing, and prints no secret (pm2's environment is parsed, never printed).
#
# Run as root on the box:   bash scripts/diagnose-send-gap.sh 2>&1 | tee /root/send-gap-diag.txt
#
# What each section discriminates (Mac asleep / nothing permitted to send / a person or guard halted
# the fleet / the d196eb1 availability rule misfiring) is written beside its \echo heading. Built and
# adversarially checked by a review workflow, then executed end to end against a scratch Postgres
# 16.15 holding the production schema and production-shaped rows, and against log lines in the
# logger's exact format, before it was handed over.
cd /opt/ds-sales-agent && echo "== box build $(cat .version 2>/dev/null || echo '?') at $(TZ=Asia/Kolkata date '+%d %b %Y %H:%M') IST"; pm2 jlist 2>/dev/null | node -e 'try{const l=JSON.parse(require("fs").readFileSync(0));for(const p of l.filter(p=>p.name.startsWith("ds-sales")))console.log("   "+p.name+" "+p.pm2_env.status+" restarts="+p.pm2_env.restart_time+" up_since="+new Date(p.pm2_env.pm_uptime).toISOString())}catch(e){console.log("   (pm2 jlist unreadable)")}'; ls -l --time-style=+%F_%T /tmp/ig-backfill.log /tmp/ig-rejudge.log /tmp/ig-frames.log 2>/dev/null
sudo -u postgres psql -X -d ds_sales_agent -P pager=off <<'SQL'
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SET statement_timeout = '120s';
\pset null '-'
\echo
\echo '== Q1 DELIVERIES per IST day: who pressed send, gap since the RECIPIENT last heard from any page, how old the draft was'
WITH d AS (
  SELECT a."sentAt", a."sentBy", a."touchNumber", a."queuedAt",
         lag(a."sentAt") OVER (PARTITION BY a."targetId" ORDER BY a."sentAt", a."id") AS prev_sent
  FROM "OutreachAttempt" a
  WHERE a."status" IN ('SENT','REPLIED') AND a."sentAt" IS NOT NULL
)
SELECT ("sentAt" + interval '5 hours 30 minutes')::date AS ist_day,
       count(*) AS delivered,
       count(*) FILTER (WHERE "sentBy" LIKE 'autopilot:%') AS autopilot,
       count(*) FILTER (WHERE "sentBy" IS NULL OR "sentBy" NOT LIKE 'autopilot:%') AS by_person,
       count(*) FILTER (WHERE "touchNumber" = 1) AS pair_touch1,
       count(*) FILTER (WHERE prev_sent IS NULL) AS recip_first_ever,
       count(*) FILTER (WHERE "sentAt" - prev_sent < interval '7 days') AS gap_lt7d,
       count(*) FILTER (WHERE "sentAt" - prev_sent >= interval '7 days' AND "sentAt" - prev_sent < interval '8 days') AS gap_7to8d,
       count(*) FILTER (WHERE "sentAt" - prev_sent >= interval '8 days') AS gap_ge8d,
       count(*) FILTER (WHERE ("queuedAt" + interval '5 hours 30 minutes')::date = ("sentAt" + interval '5 hours 30 minutes')::date) AS drafted_same_day,
       count(*) FILTER (WHERE ("queuedAt" + interval '5 hours 30 minutes')::date < ("sentAt" + interval '5 hours 30 minutes')::date) AS drafted_earlier,
       min(("sentAt" + interval '5 hours 30 minutes')::time(0)) AS first_ist,
       max(("sentAt" + interval '5 hours 30 minutes')::time(0)) AS last_ist
FROM d
WHERE "sentAt" >= timestamp '2026-10-14 18:30:00'
GROUP BY 1 ORDER BY 1;

\echo
\echo '== Q2 DRAFT SUPPLY AND WHAT WAS SENDABLE: drafts written per IST day; at 12:00 IST each day and NOW, the waiting drafts of live pages, how many the 7-day material allowance held, how many only a reply held, and what was left'
WITH pts AS (
  SELECT to_char(g, 'DD Mon') || ' 12:00' AS at_ist, g::date AS ist_day, g + interval '12 hours' - interval '5 hours 30 minutes' AS t
  FROM generate_series(timestamp '2026-10-15', (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp, interval '1 day') g
  WHERE g + interval '12 hours' - interval '5 hours 30 minutes' <= (now() AT TIME ZONE 'UTC')
  UNION ALL
  SELECT 'now ' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'), NULL, (now() AT TIME ZONE 'UTC')
), pro AS MATERIALIZED (
  SELECT t."id", lower(t."handle") AS h,
         regexp_replace(lower(t."handle"), '[^a-z0-9]', '', 'g') AS hsq,
         regexp_replace(lower(t."displayName"), '[^a-z0-9]', '', 'g') AS dsq
  FROM "TargetAccount" t WHERE t."role" = 'PROSPECT'
), nm AS MATERIALIZED (
  SELECT DISTINCT p."id", v.n AS name FROM pro p CROSS JOIN LATERAL (VALUES (p.hsq), (p.dsq)) v(n) WHERE length(v.n) >= 4
  UNION
  SELECT p."id", regexp_replace(v.n, '(india|official|ind|in)$', '') FROM pro p CROSS JOIN LATERAL (VALUES (p.hsq), (p.dsq)) v(n)
  WHERE length(v.n) >= 4 AND length(regexp_replace(v.n, '(india|official|ind|in)$', '')) BETWEEN 5 AND length(v.n) - 1
), camp AS MATERIALIZED (
  SELECT c."id", c."postedAt", c."detectedAt", c."caption",
         CASE WHEN pg_input_is_valid(c."taggedAccounts", 'jsonb') AND jsonb_typeof(c."taggedAccounts"::jsonb) = 'array' THEN c."taggedAccounts"::jsonb ELSE '[]'::jsonb END AS tags,
         CASE WHEN pg_input_is_valid(c."brands", 'jsonb') AND jsonb_typeof(c."brands"::jsonb) = 'array' THEN c."brands"::jsonb ELSE '[]'::jsonb END AS brands
  FROM "DetectedCampaign" c
  WHERE c."verdict" = 'CAMPAIGN' AND c."postedAt" >= timestamp '2026-10-07 18:30:00'
), naming AS MATERIALIZED (
  SELECT DISTINCT x.cid, x.pid, camp."postedAt", camp."detectedAt" FROM (
    SELECT camp."id" AS cid, p."id" AS pid FROM camp CROSS JOIN LATERAL jsonb_array_elements_text(camp.tags) tg(v) JOIN pro p ON p.h = lower(tg.v)
    UNION ALL
    SELECT camp."id", p."id" FROM camp CROSS JOIN LATERAL regexp_matches(camp."caption", '@([A-Za-z0-9_.]+)', 'g') m JOIN pro p ON p.h = lower(m[1])
    UNION ALL
    SELECT camp."id", nm."id" FROM camp CROSS JOIN LATERAL jsonb_array_elements_text(camp.brands) b(v)
      JOIN nm ON nm.name = regexp_replace(lower(b.v), '[^a-z0-9]', '', 'g')
    WHERE length(regexp_replace(lower(b.v), '[^a-z0-9]', '', 'g')) >= 4
  ) x JOIN camp ON camp."id" = x.cid
), skip AS MATERIALIZED (
  SELECT substr("entity", 17) AS id, min("at") AS at FROM "AuditLog"
  WHERE "action" = 'attempt.skipped' AND "entity" LIKE 'OutreachAttempt:%' AND "at" >= timestamp '2026-09-01'
  GROUP BY 1
), drv AS MATERIALIZED (
  SELECT r."attemptId" AS id, min(r."createdAt") AS first_drive, max(r."createdAt") AS last_drive
  FROM "DailyReservation" r
  WHERE r."scope" = 'pair' AND r."attemptId" IS NOT NULL AND r."createdAt" >= timestamp '2026-09-01'
  GROUP BY 1
), cand AS MATERIALIZED (
  SELECT a."id", a."pairId", a."targetId", a."status", a."sentAt", s."handle",
         (s."fleetMember" AND s."handle" <> 'bollywoodchronicle') AS live,
         skip.at AS skipped_at, drv.last_drive,
         least(a."queuedAt", coalesce(drv.first_drive, a."queuedAt")) AS born
  FROM "OutreachAttempt" a
  JOIN "SenderAccount" s ON s."id" = a."senderId"
  LEFT JOIN skip ON skip.id = a."id"
  LEFT JOIN drv ON drv.id = a."id"
  WHERE a."status" IN ('READY','QUEUED','SENDING')
     OR (a."status" IN ('SENT','REPLIED','SKIPPED','FAILED') AND a."queuedAt" >= timestamp '2026-09-01')
), wait AS (
  SELECT p.at_ist, p.t, c.*
  FROM pts p JOIN cand c ON c.born <= p.t
   AND (c."status" IN ('READY','QUEUED','SENDING')
        OR (c."status" IN ('SENT','REPLIED') AND c."sentAt" > p.t)
        OR (c."status" = 'SKIPPED' AND c.skipped_at > p.t)
        OR (c."status" = 'FAILED' AND c.last_drive > p.t))
), judged AS (
  SELECT w.at_ist, w."handle", w.live,
         w.live AND (SELECT count(*) FROM "OutreachAttempt" x
                     WHERE x."targetId" = w."targetId" AND x."status" IN ('SENT','REPLIED')
                       AND x."sentAt" >= w.t - interval '7 days' AND x."sentAt" <= w.t)
                    >= greatest(1, (SELECT count(*) FROM naming n
                                    WHERE n.pid = w."targetId" AND n."postedAt" >= w.t - interval '7 days' AND n."detectedAt" <= w.t)) AS spent,
         w.live AND EXISTS (SELECT 1 FROM "OutreachAttempt" y
                            WHERE y."pairId" = w."pairId" AND y."repliedAt" <= w.t AND y."replyHandledAt" IS NULL
                              AND y."replyPostedAt" >= w.t - interval '168 hours') AS reply_held
  FROM wait w
), q AS (
  SELECT at_ist, count(*) AS waiting_all,
         count(*) FILTER (WHERE live) AS waiting_live,
         count(*) FILTER (WHERE spent) AS allowance_spent,
         count(*) FILTER (WHERE reply_held AND NOT spent) AS reply_held_only,
         count(*) FILTER (WHERE live AND NOT spent AND NOT reply_held) AS sendable_est
  FROM judged GROUP BY 1
), qp AS (
  SELECT at_ist, string_agg("handle" || '=' || n, ' ' ORDER BY n DESC) AS sendable_by_page
  FROM (SELECT at_ist, "handle", count(*) AS n FROM judged WHERE live AND NOT spent AND NOT reply_held GROUP BY 1, 2) z
  GROUP BY 1
), w AS (
  SELECT (a."queuedAt" + interval '5 hours 30 minutes')::date AS ist_day,
         count(*) AS written,
         count(*) FILTER (WHERE a."touchNumber" = 1) AS written_touch1,
         count(*) FILTER (WHERE a."status" IN ('SENT','REPLIED')) AS later_delivered,
         count(*) FILTER (WHERE a."status" = 'SKIPPED') AS later_skipped,
         count(*) FILTER (WHERE a."status" IN ('READY','QUEUED','SENDING')) AS still_waiting
  FROM "OutreachAttempt" a
  WHERE a."attempts" = 0 AND a."queuedAt" >= timestamp '2026-10-14 18:30:00'
  GROUP BY 1
)
SELECT p.at_ist,
       w.written, w.written_touch1, w.later_delivered, w.later_skipped, w.still_waiting,
       coalesce(q.waiting_all, 0) AS waiting_all, coalesce(q.waiting_live, 0) AS waiting_live,
       coalesce(q.allowance_spent, 0) AS allowance_spent, coalesce(q.reply_held_only, 0) AS reply_held_only,
       coalesce(q.sendable_est, 0) AS sendable_est, qp.sendable_by_page,
       (SELECT count(*) FROM (SELECT x."targetId" FROM "OutreachAttempt" x
                              WHERE x."status" IN ('SENT','REPLIED') AND x."sentAt" >= p.t - interval '7 days' AND x."sentAt" <= p.t
                              GROUP BY 1 HAVING count(DISTINCT x."senderId") >= 3) z) AS recips_ge3_pages_7d
FROM pts p LEFT JOIN w ON w.ist_day = p.ist_day LEFT JOIN q USING (at_ist) LEFT JOIN qp USING (at_ist)
ORDER BY p.t;

\echo
\echo '== Q3 SIGNS OF LIFE per IST day: Mac-only traces (deliveries, thread reads, replies seen, drive claims, Mac audit rows) vs box controls (posts stored, slot runs)'
WITH ev(src, ts) AS (
  SELECT 'deliver', a."sentAt" FROM "OutreachAttempt" a WHERE a."status" IN ('SENT','REPLIED')
  UNION ALL SELECT 'read', a."replyCheckedAt" FROM "OutreachAttempt" a
  UNION ALL SELECT 'reply', a."repliedAt" FROM "OutreachAttempt" a
  UNION ALL SELECT 'claim', r."createdAt" FROM "DailyReservation" r WHERE r."scope" = 'pair'
  UNION ALL SELECT 'nit_drive', (SELECT max(r."createdAt") FROM "DailyReservation" r WHERE r."attemptId" = a."id" AND r."scope" = 'pair')
            FROM "OutreachAttempt" a WHERE a."failureCode" = 'not-in-thread'
  UNION ALL SELECT 'nit_draft', a."queuedAt" FROM "OutreachAttempt" a WHERE a."failureCode" = 'not-in-thread'
  UNION ALL SELECT 'retry', a."queuedAt" FROM "OutreachAttempt" a WHERE a."attempts" > 0 AND a."status" IN ('READY','QUEUED') AND a."failureCode" IS NOT NULL
  UNION ALL SELECT 'macaudit', l."at" FROM "AuditLog" l
            WHERE l."actor" IN ('reply-check','dispatcher','autopilot')
               OR (l."actor" LIKE 'device:%' AND l."action" NOT LIKE 'device.enrol%')
               OR (l."actor" = 'system' AND l."action" = 'sender.session.restored')
  UNION ALL SELECT 'boxpost', c."detectedAt" FROM "DetectedCampaign" c
  UNION ALL SELECT 'boxslot', s."startedAt" FROM "ScrapeRun" s
), t AS (
  SELECT src, ts + interval '5 hours 30 minutes' AS ist FROM ev WHERE ts >= timestamp '2026-10-14 18:30:00'
)
SELECT ist::date AS ist_day,
       count(*) FILTER (WHERE src = 'deliver') AS delivered,
       count(*) FILTER (WHERE src = 'read') AS thread_reads,
       count(*) FILTER (WHERE src = 'reply') AS replies_seen,
       count(*) FILTER (WHERE src = 'claim') AS drive_claims,
       count(*) FILTER (WHERE src = 'macaudit') AS mac_audits,
       count(DISTINCT to_char(ist, 'HH24')) FILTER (WHERE src IN ('deliver','read','reply','claim','macaudit')) AS mac_hours,
       string_agg(DISTINCT to_char(ist, 'HH24'), ' ' ORDER BY to_char(ist, 'HH24'))
         FILTER (WHERE src IN ('deliver','read','reply','claim','macaudit')) AS mac_hours_list,
       count(*) FILTER (WHERE src = 'nit_drive') AS nit_by_drive_day,
       count(*) FILTER (WHERE src = 'nit_draft') AS nit_by_draft_day,
       count(*) FILTER (WHERE src = 'retry') AS retries_ready_by_queuedat,
       count(*) FILTER (WHERE src = 'boxpost') AS posts_stored,
       count(*) FILTER (WHERE src = 'boxslot') AS slot_runs
FROM t GROUP BY 1 ORDER BY 1;

\echo
\echo '== Q4 REPLIES: day the recipient WROTE vs day we SAW it (only the Mac''s sweep or a pre-send read records one)'
SELECT (a."repliedAt" + interval '5 hours 30 minutes')::date AS seen_ist_day,
       coalesce(((a."replyPostedAt" + interval '5 hours 30 minutes')::date)::text, 'undated') AS written_ist_day,
       count(*) AS replies
FROM "OutreachAttempt" a
WHERE a."repliedAt" >= timestamp '2026-10-14 18:30:00'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo
\echo '== Q5 SWITCHES, HALTS AND ACCOUNT EVENTS since 15 Oct IST (every row, oldest first)'
SELECT (l."at" + interval '5 hours 30 minutes')::timestamp(0) AS at_ist, l."actor", l."action",
       coalesce(s."handle", l."entity") AS entity, left(coalesce(l."detail", ''), 110) AS detail
FROM "AuditLog" l
LEFT JOIN "SenderAccount" s ON l."entity" IN ('SenderAccount:' || s."id", 'SenderAccount:' || s."handle")
WHERE l."at" >= timestamp '2026-10-14 18:30:00'
  AND l."action" IN ('autopilot.set','device.active.set','dispatch.paused','dispatch.resumed','dispatch.now',
                     'breaker.acknowledged','sender.challenged','sender.challenge.cleared','sender.session.invalid',
                     'sender.session.restored','sender.status','sender.retired','sender.deleted','sender.fleets.set',
                     'sender.rejoined-rotation','sender.login','sender.login.reconciled','device.paired','device.revoked',
                     'sync.now','setting.changed','attempt.parked-orphaned-sending')
ORDER BY l."at"
LIMIT 150;

\echo
\echo '== Q6 PLANNER VERDICTS per IST day (ScrapeRun.detail.outreach at each slot; reasons are average pairs per run, the rest are totals)'
WITH o AS (
  SELECT r."id" AS run, r."slot", (r."startedAt" + interval '5 hours 30 minutes')::date AS ist_day,
         e ->> 'skipReason' AS reason,
         coalesce(e ->> 'eligible' = 'true', false) AS eligible,
         e ->> 'status' AS status, (e ? 'error') AS errored,
         coalesce(e ->> 'skipDetail', '') AS detail,
         substring(e ->> 'pairKey' from '^([A-Za-z0-9_.]+)') AS sender,
         substring(e ->> 'pairKey' from '^[A-Za-z0-9_.]+.([A-Za-z0-9_.]+)$') AS target
  FROM "ScrapeRun" r
  CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(r."detail", 'jsonb') THEN r."detail"::jsonb -> 'outreach' END AS arr) x
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.arr) = 'array' THEN x.arr ELSE '[]'::jsonb END) e
  WHERE r."startedAt" >= timestamp '2026-10-14 18:30:00'
), u AS (
  SELECT o.*,
         CASE WHEN reason = 'all-unavailable' THEN regexp_count(detail, '; ') + 1 END AS segs,
         CASE WHEN reason = 'all-unavailable' THEN regexp_count(detail, ': signed in on no Mac') END AS unheld,
         CASE WHEN reason = 'all-unavailable' THEN regexp_count(detail, ': is the recipient') END AS self,
         CASE WHEN reason = 'all-unavailable' THEN regexp_count(detail, '(^|[ ;])bollywoodchronicle: signed in on no Mac') END AS chron,
         CASE WHEN reason = 'not-this-senders-turn' THEN substring(detail from '^@([A-Za-z0-9_.]+) is next in')
              WHEN eligible OR reason IN ('new-brand-daily-cap','recipient-is-a-person') THEN sender END AS elected
  FROM o
), elx AS (
  SELECT ist_day, string_agg(elected || '=' || n, ' ' ORDER BY n DESC) AS elected_recipients_total
  FROM (SELECT ist_day, elected, count(DISTINCT (run, target)) AS n FROM u WHERE elected IS NOT NULL GROUP BY 1, 2) z
  GROUP BY 1
), agg AS (
  SELECT ist_day, count(DISTINCT run) AS runs, string_agg(DISTINCT slot, ',') AS slots,
         round(count(*) FILTER (WHERE eligible AND status IN ('READY','QUEUED'))::numeric / count(DISTINCT run), 1) AS written,
         count(*) FILTER (WHERE eligible AND errored) AS errored_total,
         count(*) FILTER (WHERE eligible AND status = 'SKIPPED') AS dry_run_total,
         round(count(*) FILTER (WHERE reason = 'material-exhausted')::numeric / count(DISTINCT run)) AS material_exh,
         round(count(*) FILTER (WHERE reason = 'target-recently-contacted')::numeric / count(DISTINCT run)) AS ring_rest,
         round(count(*) FILTER (WHERE reason IN ('no-new-material-to-reference','no-post-we-can-describe'))::numeric / count(DISTINCT run)) AS no_material,
         round(count(*) FILTER (WHERE reason = 'all-unavailable')::numeric / count(DISTINCT run)) AS all_unavail,
         count(*) FILTER (WHERE reason = 'all-unavailable' AND unheld > 0 AND unheld + self = segs) AS every_page_unheld_total,
         count(*) FILTER (WHERE reason = 'all-unavailable' AND unheld - chron > 0 AND unheld + self < segs) AS live_page_unheld_total,
         round(count(*) FILTER (WHERE reason = 'new-brand-daily-cap')::numeric / count(DISTINCT run)) AS depth_cap,
         round(count(*) FILTER (WHERE reason = 'not-this-senders-turn')::numeric / count(DISTINCT run)) AS not_turn,
         round(count(*) FILTER (WHERE reason = 'pending-attempt-exists')::numeric / count(DISTINCT run)) AS pending,
         round(count(*) FILTER (WHERE reason = 'target-replied')::numeric / count(DISTINCT run)) AS replied,
         round(count(*) FILTER (WHERE reason = 'sender-not-active')::numeric / count(DISTINCT run)) AS sender_inactive
  FROM u GROUP BY 1
)
SELECT agg.*, elx.elected_recipients_total FROM agg LEFT JOIN elx USING (ist_day) ORDER BY 1;

\echo
\echo '== Q7 LATEST-ONLY STATE ROWS (no history: updatedAt is the last write only)'
SELECT s."key", (s."updatedAt" + interval '5 hours 30 minutes')::timestamp(0) AS updated_ist,
       round(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - s."updatedAt")) / 3600.0, 1) AS hours_ago,
       CASE WHEN s."key" IN ('devicePresence','sessionHolderSeen') THEN '(see Q8)' ELSE left(s."value", 200) END AS value_head
FROM "Setting" s
WHERE s."key" IN ('autopilotEnabled','activeDevice','dispatchPaused','breakerAcknowledgedAt','sendLock','dispatchState',
                  'dispatchLastOkAt','fleetLastSendStartedAt','devicePresence','sessionHolderSeen','planLastOkAt',
                  'detectLastOkAt','detectFeedOkAt','schedulerHeartbeat','slotRunning','defaultCooldownDays',
                  'replyResumeHours','replyHaltScope','maxPerPairPerDay','maxWaitingNewBrandDrafts','maxNewBrandTouchesPerDay',
                  'crossPageGapHours','fleetMinGapMinutes')
ORDER BY s."updatedAt" DESC;

\echo
\echo '== Q8 WHICH MAC HOLDS WHICH PAGE NOW: presence entries (last beat, build, handles) and the planner''s 72 h holder history'
SELECT 'presence' AS row_kind, e ->> 'device' AS name,
       CASE WHEN pg_input_is_valid(e ->> 'at', 'timestamptz') THEN ((((e ->> 'at')::timestamptz) AT TIME ZONE 'UTC') + interval '5 hours 30 minutes')::timestamp(0) END AS at_ist,
       CASE WHEN pg_input_is_valid(e ->> 'at', 'timestamptz') THEN round(extract(epoch FROM (now() - (e ->> 'at')::timestamptz)) / 60.0) END AS minutes_ago,
       'build ' || coalesce(e ->> 'version', '?') || ' ' || coalesce((e -> 'handles')::text, '(no handles field)') AS detail
FROM "Setting" s
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN NOT pg_input_is_valid(s."value", 'jsonb') THEN '[]'::jsonb WHEN jsonb_typeof(s."value"::jsonb) = 'array' THEN s."value"::jsonb ELSE '[]'::jsonb END) e
WHERE s."key" = 'devicePresence'
UNION ALL
SELECT 'holder-history', h.key,
       CASE WHEN pg_input_is_valid(h.value, 'timestamptz') THEN ((h.value::timestamptz AT TIME ZONE 'UTC') + interval '5 hours 30 minutes')::timestamp(0) END,
       CASE WHEN pg_input_is_valid(h.value, 'timestamptz') THEN round(extract(epoch FROM (now() - h.value::timestamptz)) / 60.0) END, NULL
FROM "Setting" s
CROSS JOIN LATERAL jsonb_each_text(CASE WHEN NOT pg_input_is_valid(s."value", 'jsonb') THEN '{}'::jsonb WHEN jsonb_typeof(s."value"::jsonb) = 'object' THEN s."value"::jsonb ELSE '{}'::jsonb END) h
WHERE s."key" = 'sessionHolderSeen'
ORDER BY 1, 3 DESC;

\echo
\echo '== Q9 SENDING ACCOUNTS AND THEIR QUEUE NOW (what the allowance holds now is the "now" row of Q2)'
SELECT s."handle", s."status", s."fleetMember" AS fleet, s."cohort",
       (s."sessionPath" IS NOT NULL) AS session_recorded,
       (s."sessionInvalidAt" + interval '5 hours 30 minutes')::timestamp(0) AS session_invalid_ist,
       (s."challengedAt" + interval '5 hours 30 minutes')::timestamp(0) AS challenged_ist,
       count(a."id") FILTER (WHERE a."status" = 'READY') AS ready,
       count(a."id") FILTER (WHERE a."status" IN ('QUEUED','SENDING')) AS queued_or_sending,
       count(a."id") FILTER (WHERE a."status" = 'FAILED' AND a."queuedAt" >= timestamp '2026-10-14 18:30:00') AS failed_since_15oct,
       (min(a."queuedAt") FILTER (WHERE a."status" = 'READY') + interval '5 hours 30 minutes')::timestamp(0) AS oldest_ready_ist,
       (max(a."sentAt") + interval '5 hours 30 minutes')::timestamp(0) AS last_delivery_ist
FROM "SenderAccount" s
LEFT JOIN "OutreachAttempt" a ON a."senderId" = s."id"
GROUP BY s."id"
ORDER BY s."fleetMember" DESC, s."handle";

\echo
\echo '== Q10 MATERIAL AND NEW RECIPIENTS per IST day posted: paid posts, which door, which of them name a live prospect (by tag or exact @handle / by brand string), prospects minted'
WITH days AS (
  SELECT g::date AS ist_day FROM generate_series(timestamp '2026-10-10', (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp, interval '1 day') g
), pro AS MATERIALIZED (
  SELECT t."id", lower(t."handle") AS h,
         regexp_replace(lower(t."handle"), '[^a-z0-9]', '', 'g') AS hsq,
         regexp_replace(lower(t."displayName"), '[^a-z0-9]', '', 'g') AS dsq
  FROM "TargetAccount" t WHERE t."role" = 'PROSPECT' AND t."optedOut" = false
), nm AS MATERIALIZED (
  SELECT DISTINCT p."id", v.n AS name FROM pro p CROSS JOIN LATERAL (VALUES (p.hsq), (p.dsq)) v(n) WHERE length(v.n) >= 4
  UNION
  SELECT p."id", regexp_replace(v.n, '(india|official|ind|in)$', '') FROM pro p CROSS JOIN LATERAL (VALUES (p.hsq), (p.dsq)) v(n)
  WHERE length(v.n) >= 4 AND length(regexp_replace(v.n, '(india|official|ind|in)$', '')) BETWEEN 5 AND length(v.n) - 1
), camp AS MATERIALIZED (
  SELECT c."id", (c."postedAt" + interval '5 hours 30 minutes')::date AS ist_day, c."caption",
         coalesce(c."rawPayload", '') LIKE '%"evidenceIncomplete":true%' AS official,
         CASE WHEN pg_input_is_valid(c."taggedAccounts", 'jsonb') AND jsonb_typeof(c."taggedAccounts"::jsonb) = 'array' THEN c."taggedAccounts"::jsonb ELSE '[]'::jsonb END AS tags,
         CASE WHEN pg_input_is_valid(c."brands", 'jsonb') AND jsonb_typeof(c."brands"::jsonb) = 'array' THEN c."brands"::jsonb ELSE '[]'::jsonb END AS brands
  FROM "DetectedCampaign" c
  WHERE c."verdict" = 'CAMPAIGN' AND c."postedAt" >= timestamp '2026-10-09 18:30:00'
), hits AS (
  SELECT camp.ist_day, camp."id" AS cid, p."id" AS pid, 'handle' AS arm FROM camp CROSS JOIN LATERAL jsonb_array_elements_text(camp.tags) tg(v) JOIN pro p ON p.h = lower(tg.v)
  UNION
  SELECT camp.ist_day, camp."id", p."id", 'handle' FROM camp CROSS JOIN LATERAL regexp_matches(camp."caption", '@([A-Za-z0-9_.]+)', 'g') m JOIN pro p ON p.h = lower(m[1])
  UNION
  SELECT camp.ist_day, camp."id", nm."id", 'brand' FROM camp CROSS JOIN LATERAL jsonb_array_elements_text(camp.brands) b(v)
    JOIN nm ON nm.name = regexp_replace(lower(b.v), '[^a-z0-9]', '', 'g')
  WHERE length(regexp_replace(lower(b.v), '[^a-z0-9]', '', 'g')) >= 4
), c AS (
  SELECT ist_day, count(*) AS paid_posts, count(*) FILTER (WHERE official) AS official_read,
         count(*) FILTER (WHERE jsonb_array_length(tags) > 0) AS with_tags,
         count(*) FILTER (WHERE "caption" LIKE '%@%') AS with_at
  FROM camp GROUP BY 1
), h AS (
  SELECT ist_day, count(DISTINCT cid) FILTER (WHERE arm = 'handle') AS naming_by_tag_or_at,
         count(DISTINCT cid) FILTER (WHERE arm = 'brand') AS naming_by_brand_string,
         count(DISTINCT cid) AS posts_naming_prospect, count(DISTINCT pid) AS prospects_named
  FROM hits GROUP BY 1
), p AS (
  SELECT ("createdAt" + interval '5 hours 30 minutes')::date AS ist_day, count(*) AS prospects_minted,
         count(*) FILTER (WHERE "isVerified" IS TRUE) AS minted_verified
  FROM "TargetAccount" WHERE "role" = 'PROSPECT' AND "createdAt" >= timestamp '2026-10-09 18:30:00' GROUP BY 1
)
SELECT days.ist_day, coalesce(c.paid_posts, 0) AS paid_posts, coalesce(c.official_read, 0) AS official_read,
       coalesce(c.with_tags, 0) AS with_tags, coalesce(c.with_at, 0) AS with_at,
       coalesce(h.naming_by_tag_or_at, 0) AS naming_by_tag_or_at, coalesce(h.naming_by_brand_string, 0) AS naming_by_brand,
       coalesce(h.posts_naming_prospect, 0) AS posts_naming_prospect, coalesce(h.prospects_named, 0) AS prospects_named,
       coalesce(p.prospects_minted, 0) AS prospects_minted, coalesce(p.minted_verified, 0) AS minted_verified
FROM days LEFT JOIN c USING (ist_day) LEFT JOIN h USING (ist_day) LEFT JOIN p USING (ist_day)
ORDER BY 1;

\echo
\echo '== Q11 DRAFTS DISCARDED per IST day, by who and why (the d196eb1 release carries the "signed in on no Mac" sentence)'
SELECT (l."at" + interval '5 hours 30 minutes')::date AS ist_day, l."actor",
       CASE WHEN l."detail" LIKE '%signed in on no Mac that has been online in the last 3 days%' THEN 'unheld-release'
            ELSE left(coalesce(l."detail", ''), 60) END AS why,
       coalesce(s."handle", '?') AS sender, count(*) AS drafts
FROM "AuditLog" l
LEFT JOIN "OutreachAttempt" a ON a."id" = substr(l."entity", 17)
LEFT JOIN "SenderAccount" s ON s."id" = a."senderId"
WHERE l."action" = 'attempt.skipped' AND l."entity" LIKE 'OutreachAttempt:%' AND l."at" >= timestamp '2026-10-14 18:30:00'
GROUP BY 1, 2, 3, 4 ORDER BY 1, 5 DESC
LIMIT 60;
SQL
L=/root/.pm2/logs
echo; echo "== G0 worker and web log files, per stream, oldest first by modification time (G1-G3 see back only as far as each stream's OLDEST file)"
for f in ds-sales-worker-out ds-sales-worker-error ds-sales-agent-out ds-sales-agent-error; do
  set -- $(ls -1tr "$L"/$f*.log* 2>/dev/null)
  if [ $# -eq 0 ]; then echo "   $f: no files"; continue; fi
  eval newest=\${$#}
  echo "   $f: $# file(s); oldest $(basename "$1"), first stamp in it: $(zcat -f "$1" 2>/dev/null | grep -m1 -oE '^[0-9]{1,2} [A-Z][a-z]{2} 20[0-9]{2}, [0-9]{2}:[0-9]{2}' || echo none); newest $(basename "$newest")"
done
echo; echo "== G1 planner passes per IST day (15-min passes, slots and 'Check now'): passes, drafts queued, passes that queued any, pairs that FAILED while drafting, and average skipped pairs per pass by reason"
zgrep -hE ' INFO  outreach (summary|skips by reason)  ' "$L"/ds-sales-worker-out*.log* "$L"/ds-sales-agent-out*.log* 2>/dev/null | awk '
{ if (!match($0, /^(1[5-9]|2[0-9]|3[01]) Oct 2026, /)) next; d = substr($0, 1, 2) + 0 }
/ INFO  outreach summary  / { p[d]++
  if (match($0, / queued=[0-9]+/)) { q = substr($0, RSTART + 8, RLENGTH - 8) + 0; Q[d] += q; if (q > 0) z[d]++ }
  if (match($0, / failed=[0-9]+/)) { f = substr($0, RSTART + 8, RLENGTH - 8) + 0; F[d] += f; if (f > 0) zf[d]++ }
  next }
{ s[d]++; n = split($0, fl, " "); for (i = 1; i <= n; i++) { t = fl[i]; sub(/^reasons=/, "", t); if (t ~ /^[a-z-]+=[0-9]+$/ && t !~ /^total=/) { split(t, kv, "="); R[d, kv[1]] += kv[2] } } }
END { nk = split("material-exhausted target-recently-contacted no-new-material-to-reference no-post-we-can-describe all-unavailable new-brand-daily-cap not-this-senders-turn pending-attempt-exists target-replied sender-not-active", K, " ")
  print "day    passes drafts passes_w_drafts failed passes_w_failed | avg/pass: mat_exh ring_rest no_new_mat no_desc all_unavail depth_cap not_turn pending replied inactive"
  for (d = 15; d <= 31; d++) { if (!(d in p) && !(d in s)) continue; printf "%2d Oct %6d %6d %15d %6d %15d |", d, p[d], Q[d], z[d], F[d], zf[d]
    for (k = 1; k <= nk; k++) printf " %d", (s[d] ? int(R[d, K[k]] / s[d] + 0.5) : 0); printf "\n" } }'
echo; echo "== G2 release verdicts, drafting and pass failures, scheduler starts/refusals and stops, per IST day (count, day, message)"
zgrep -hE 'no fleet account can send right now|released drafts for accounts no online Mac holds|keeps its drafts this pass|recording which Macs hold which accounts failed|releasing drafts for accounts no online Mac holds failed|outreach planning after detect failed|ERROR outreach failed |detection pass threw at top level|slot threw at top level|outreach stage threw|lifetime send ceiling reached|received SIG[A-Z]+ |scheduler starting|another scheduler is already running|exiting: the dashboard|taking over from a scheduler that died|worker failed to start' "$L"/ds-sales-worker-*.log* "$L"/ds-sales-agent-*.log* 2>/dev/null | awk '
{ if (!match($0, /^(1[5-9]|2[0-9]|3[01]) Oct 2026, [0-9:]+ [A-Z]+ +/)) next
  d = substr($0, 1, 6); m = substr($0, RLENGTH + 1)
  if (m ~ /^outreach failed/) sub(/  pair=[^ ]+ /, " ", m); else if (m !~ /released drafts/) sub(/  .*$/, "", m)
  print d " | " substr(m, 1, 150) }' | sort | uniq -c | head -80
echo; echo "== G3 detection passes that stored posts, per IST day (box control), and which door served the channels"
zgrep -h ' INFO  detection pass  newPosts=' "$L"/ds-sales-worker-out*.log* 2>/dev/null | awk '{ if (!match($0, /^(1[5-9]|2[0-9]|3[01]) Oct 2026, /)) next; d = substr($0, 1, 2) + 0; n[d]++; if (match($0, / paid=[0-9]+/)) P[d] += substr($0, RSTART + 6, RLENGTH - 6); if (match($0, /"graph":[0-9]+/)) G[d] += substr($0, RSTART + 8, RLENGTH - 8); if (match($0, /"anonymous":[0-9]+/)) A[d] += substr($0, RSTART + 12, RLENGTH - 12) } END { for (d = 15; d <= 31; d++) if (d in n) printf "%2d Oct passes_with_new_posts=%d paid=%d channel_reads graph=%d anonymous=%d\n", d, n[d], P[d], G[d], A[d] }'
echo; echo "== G4 ssh tunnel sessions per authorized key: per day the accepts (connects) and the sessions that ENDED (each counted once, by its IP and port), then every session that lasted 6 h or more"
J() { TZ=Asia/Kolkata journalctl -q -t sshd -t sshd-session --since '2026-10-15' --no-pager -o short-iso 2>/dev/null; }; NOW=$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M')
if [ -z "$(J | head -c1)" ]; then echo "   (no sshd lines in the journal; reading /var/log/auth.log* — times there are in the host's zone, $(date +%Z))"; J() { zcat -f /var/log/auth.log* 2>/dev/null | grep -E 'sshd(-session)?\['; }; NOW=$(date '+%Y-%m-%d %H:%M'); fi
{ ssh-keygen -lf /root/.ssh/authorized_keys 2>/dev/null | sed 's/^/KEY /'; J; } | awk -v now="$NOW" '
BEGIN { split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " "); for (i = 1; i <= 12; i++) MON[mn[i]] = sprintf("%02d", i) }
function mins(ts) { return ((substr(ts, 6, 2) == "11" ? 31 : 0) + substr(ts, 9, 2)) * 1440 + substr(ts, 12, 2) * 60 + substr(ts, 15, 2) }
$1 == "KEY" { c = ""; for (i = 4; i < NF; i++) c = c (c == "" ? "" : " ") $i; name[$3] = c; ord[++nk] = $3; next }
{ if ($1 ~ /^20[0-9][0-9]-[01][0-9]-[0-3][0-9]T/) ts = substr($1, 1, 10) " " substr($1, 12, 5)
  else if ($1 in MON) ts = "2026-" MON[$1] "-" sprintf("%02d", $2) " " substr($3, 1, 5)
  else next
  if (ts < "2026-10-15") next
  if (!match($0, /[0-9a-fA-F.:]+ port [0-9]+/)) next
  k = substr($0, RSTART, RLENGTH); d = substr(ts, 1, 10)
  if ($0 ~ /Accepted publickey/) {
    fp = ""; for (i = NF; i > 0; i--) if ($i ~ /^SHA256:/) { fp = $i; break }
    if (fp == "") next
    S[k] = fp; ST[k] = ts; delete E[k]; A[fp, d]++; if (!((fp, d) in A1)) A1[fp, d] = substr(ts, 12, 5); A2[fp, d] = substr(ts, 12, 5)
    seen[fp] = 1; D[d] = 1; next }
  if ($0 ~ /Disconnected from|Connection closed by|Connection reset by|timed out|Timeout, client not responding|Broken pipe|Read error/) {
    if (!(k in S) || (k in E)) next
    fp = S[k]; E[k] = ts; X[fp, d]++; if (!((fp, d) in X1)) X1[fp, d] = substr(ts, 12, 5); X2[fp, d] = substr(ts, 12, 5); D[d] = 1 } }
END {
  for (f in seen) { known = 0; for (i = 1; i <= nk; i++) if (ord[i] == f) known = 1; if (!known) { ord[++nk] = f; name[f] = "(key no longer in authorized_keys)" } }
  for (i = 1; i <= nk; i++) {
    f = ord[i]; print "-- " name[f] "  " f
    if (!(f in seen)) { print "   no accepted session since 15 Oct"; continue }
    for (m = 10; m <= 11; m++) for (dd = 1; dd <= 31; dd++) {
      d = sprintf("2026-%02d-%02d", m, dd); ha = ((f, d) in A); hx = ((f, d) in X); if (!ha && !hx) continue
      printf "   %s  accepts %3d %-13s  ended %3d %s\n", d, ha ? A[f, d] : 0, ha ? "(" A1[f, d] "-" A2[f, d] ")" : "", hx ? X[f, d] : 0, hx ? "(" X1[f, d] "-" X2[f, d] ")" : "" }
    n = 0
    for (k in S) if (S[k] == f) { h = mins((k in E) ? E[k] : now) - mins(ST[k])
      if (h >= 360) { line = sprintf("   session >= 6 h: %s -> %s  (%.1f h)", ST[k], (k in E) ? E[k] : "no end seen, as of " now, h / 60)
        j = ++n; while (j > 1 && L[j - 1] > line) { L[j] = L[j - 1]; j-- } L[j] = line } }
    for (j = 1; j <= n && j <= 20; j++) print L[j]; if (n > 20) print "   ... " n - 20 " more"
  } }
'