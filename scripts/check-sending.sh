#!/usr/bin/env bash
# WHY ISN'T IT SENDING? — a read-only check you run on the SENDING MAC, not on the server.
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<sha>/scripts/check-sending.sh -o /tmp/ds-check.sh && bash /tmp/ds-check.sh
#
# It exists because the question keeps coming from the Mac. On 26 Oct a database check written
# for the box was pasted into the Mac's terminal, and every line failed: there is no
# /opt/ds-sales-agent and no `postgres` user there. But the Mac does not NEED the box for this. Its
# agent already reads the server's Postgres through the SSH tunnel, using DATABASE_URL in
# ~/ds-sales-agent/.env. So this script uses that same connection with the agent's own `pg`
# module, and reads the agent's own logs beside it. One paste answers both halves.
#
# It is a FILE run by bash, never a block pasted into zsh. The Mac's shell is zsh, and a pasted
# block meets zsh's `!` history expansion, its NOMATCH error on unmatched globs, and comments it
# does not allow at the prompt. All three are gone when bash reads a file.
#
# READ-ONLY by construction. The session is `default_transaction_read_only = on` with a 60 s
# statement timeout before the first query, and the script stops if Postgres does not confirm it,
# so a write would be refused by Postgres itself. The shell half only lists and reads files; its one
# temp file is removed on exit. It prints NO secret: DATABASE_URL is passed to the driver, never
# echoed, and pg's messages name the host and user, never the password.
#
# TWO LOGS, and the second is the one that names faults. launchd writes the agent's stdout to
# watch.log and its STDERR to watch.error.log (scripts/install-watch.sh), and src/lib/logger.ts
# sends info and step lines to stdout but every warn, error and alarm to stderr. So "device tick
# failed", "Can't reach database server", "logged out" and "checkpoint" are never in watch.log.
# The first version of this script read only watch.log, and a review caught it.
#
# What each section separates is written in its heading. The common answer since the Instagram
# wall (15 Oct) is the seven-day material allowance on an exhausted list: F shows most live
# recipients resting, G shows when their rest ends AND whether any page can still introduce
# itself to them, and the log shows "no paid post of theirs has been detected…" on every held
# draft. Every other answer is a fault with a named fix: the Mac asleep or its agent stopped, the
# tunnel down, the server out of connection slots, autopilot off, another Mac selected, a sign-in
# gone, a stuck lock, or the server's planner failing.
set -u

APP="${DS_APP_DIR:-$HOME/ds-sales-agent}"
DATA="${DS_DATA_DIR:-$HOME/.ds-sales-agent-data}"
LOGFILE="$DATA/logs/watch.log"
ERRLOG="$DATA/logs/watch.error.log"

echo "== DS Sales Agent — read-only sending check, $(TZ=Asia/Kolkata date '+%d %b %Y %H:%M') IST, on $(hostname -s 2>/dev/null || hostname)"

if [ -d "$APP" ]; then
  echo "   agent install: $APP, build $(cat "$APP/.version" 2>/dev/null || echo 'unknown (no .version)')"
else
  echo "   NO AGENT INSTALL at $APP — this Mac cannot send at all. Run the installer (DS Sales Agent.app) here."
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -z "$NODE_BIN" ] && [ -x "$HOME/.ds-sales-agent-runtime/bin/node" ] && NODE_BIN="$HOME/.ds-sales-agent-runtime/bin/node"

# ─── 1. THE SHARED DATABASE, through this Mac's own tunnel ──────────────────────────────────────
if [ -d "$APP" ] && [ -n "$NODE_BIN" ]; then
  JS="$(mktemp "${TMPDIR:-/tmp}/ds-check.XXXXXX")"
  trap 'rm -f "$JS" "$JS.cjs"' EXIT
  mv "$JS" "$JS.cjs" && JS="$JS.cjs"
  cat > "$JS" <<'NODE'
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const app = process.env.DS_CHECK_APP
const req = require('module').createRequire(path.join(app, 'package.json'))

function out(s) { process.stdout.write(s + '\n') }

let url = null
let deviceName = os.hostname()
try {
  const parsed = req('dotenv').parse(fs.readFileSync(path.join(app, '.env')))
  url = typeof parsed.DATABASE_URL === 'string' ? parsed.DATABASE_URL : null
  // The same rule as deviceId() in src/outreach/devicePresence.ts, so section C can say whether
  // activeDevice names THIS Mac. A device name is not a secret.
  if (typeof parsed.DS_DEVICE_NAME === 'string' && parsed.DS_DEVICE_NAME.trim()) deviceName = parsed.DS_DEVICE_NAME.trim()
} catch (e) {
  out('   could not read ' + path.join(app, '.env') + ' (' + (e.code || e.message) + ') — the agent cannot start without it')
}
const isPg = url !== null && /^postgres(ql)?:\/\//.test(url)
if (url !== null && isPg === false) out('   DATABASE_URL in .env is not a Postgres URL — this Mac is not pointed at the server, so it sends nothing')
out('   this Mac\'s device name (what activeDevice must say for it to send): ' + deviceName)

function cell(v) {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}
function table(title, rows) {
  out('')
  out('== ' + title)
  if (rows.length === 0) { out('   (none)'); return }
  const cols = Object.keys(rows[0])
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  out('   ' + cols.map((c, i) => c.padEnd(w[i])).join(' | '))
  for (const r of rows) out('   ' + cols.map((c, i) => cell(r[c]).padEnd(w[i])).join(' | '))
}
function ist(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const s = d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  return s + ' IST (' + (mins >= 0 ? mins + ' min ago' : 'in ' + -mins + ' min') + ')'
}

// What a failed connect means, by its code. Every one of these used to be blamed on the tunnel,
// and reinstalling a healthy tunnel does nothing for a server that is out of connection slots (the
// 22 Aug outage, 53300) or a .env with the wrong password (28P01).
function whyUnreachable(e) {
  const code = String(e.code || '')
  const msg = String(e.message || e)
  if (code === '53300' || /too many connections|reserved for roles/i.test(msg)) {
    return [
      'The tunnel is UP — the server answered — but its Postgres is out of connection slots.',
      'Something is holding connections (on 22 Aug it was a `pnpm local` dashboard on a Mac). The agent cannot',
      'connect either, so nothing sends until they are freed. Stop any local dashboard, then check the box.',
    ]
  }
  if (['28P01', '28000', '3D000'].includes(code) || /password|SASL|does not exist/i.test(msg)) {
    return [
      'The server answered and REJECTED the login in ~/ds-sales-agent/.env (wrong password or database).',
      'The tunnel is fine. Re-pair this Mac (open DS Sales Agent.app) to get a fresh DATABASE_URL.',
    ]
  }
  return [
    'The tunnel\'s local port did not answer (or the server behind it did not), so the agent cannot reach the',
    'database either and cannot send while this fails.',
    'Check:  launchctl list | grep digitalsukoon     (the .tunnel job should show a PID)',
    'Fix:    cd ~/ds-sales-agent && bash scripts/install-tunnel.sh install',
  ]
}

// Every timestamp column is `timestamp WITHOUT time zone` holding UTC. So "now" is
// `now() AT TIME ZONE 'UTC'`, and every date or time is rendered as TEXT in SQL. Returned as a
// value, pg would read it as Mac-local time and shift it 5h30.
const NOW = `(now() AT TIME ZONE 'UTC')`
const IST = (col) => `to_char(${col} + interval '5 hours 30 minutes', 'DD Mon HH24:MI')`
const LIVE = `t.role = 'PROSPECT' AND t."optedOut" = false AND t."isVerified" IS TRUE`
// The allowance window is Setting.defaultCooldownDays, 7 unless someone changed it (gate.ts).
const WIN = `(SELECT coalesce((SELECT value::int FROM "Setting" WHERE key = 'defaultCooldownDays' AND value ~ '^[0-9]+$'), 7))`
// Midnight IST at the start of the 7th day back, as a UTC-naive timestamp — so section A's oldest
// row is a WHOLE day, not the afternoon a rolling 8x24 h window happens to start on.
const SEVEN_IST_DAYS = `(date_trunc('day', ${NOW} + interval '5 hours 30 minutes') - interval '7 days' - interval '5 hours 30 minutes')`

// One row per resting recipient (heard from a page inside the window), and whether time alone can
// release it. A follow-up needs a NEW paid post naming them (governor NO_NEW_MATERIAL), so when
// their rest ends only a page that has NEVER delivered to them may write — an introduction — and
// only if they have never replied (isFollowUp: touchesSoFar > 0 || targetHasEverReplied). This is
// an approximation of rotation: it does not know which page rotation elects next, whether that page
// is held by an online Mac, or whether a park blocks it. It says which recipients time CANNOT free.
const RESTING = `
  WITH x AS (
    SELECT a."targetId", max(a."sentAt") AS last_sent
    FROM "OutreachAttempt" a JOIN "TargetAccount" t ON t.id = a."targetId"
    WHERE a.status IN ('SENT','REPLIED') AND ${LIVE}
    GROUP BY a."targetId"
    HAVING max(a."sentAt") >= ${NOW} - ${WIN} * interval '1 day'
  ), y AS (
    SELECT x.*,
      (NOT EXISTS (SELECT 1 FROM "OutreachAttempt" r WHERE r."targetId" = x."targetId" AND r."replyPostedAt" IS NOT NULL)
       AND EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
                   WHERE p."targetId" = x."targetId" AND s."fleetMember" = true AND s.status = 'ACTIVE'
                     AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" d WHERE d."pairId" = p.id AND d.status IN ('SENT','REPLIED')))
      ) AS a_page_can_introduce
    FROM x)`

const Q = [
  ['A  deliveries per IST day, the last 7 days plus today (a missing day sent nothing). Low or zero days after a big day are the seven-day rule — a fault only if N shows the waiting drafts held by something else', `
    SELECT to_char(d, 'DD Mon') AS ist_day, n AS delivered, ap AS by_autopilot, f AS first_ist, l AS last_ist
    FROM (SELECT ("sentAt" + interval '5 hours 30 minutes')::date AS d, count(*) AS n,
                 count(*) FILTER (WHERE "sentBy" LIKE 'autopilot:%') AS ap,
                 to_char(min("sentAt") + interval '5 hours 30 minutes', 'HH24:MI') AS f,
                 to_char(max("sentAt") + interval '5 hours 30 minutes', 'HH24:MI') AS l
          FROM "OutreachAttempt"
          WHERE status IN ('SENT','REPLIED') AND "sentAt" >= ${SEVEN_IST_DAYS}
          GROUP BY 1) x
    ORDER BY d`],
  ['B  the queue now, per sending page. READY waits to be sent (oldest_draft_written is when the draft was WRITTEN). SENDING is a drive in progress — stuck only if C shows no sendLock, or a sendLock more than ~6 min old', `
    SELECT s.handle AS sender, a.status, count(*) AS drafts,
           CASE WHEN a.status = 'SENDING' THEN NULL ELSE ${IST('min(a."queuedAt")')} END AS oldest_draft_written_ist
    FROM "OutreachAttempt" a JOIN "SenderAccount" s ON s.id = a."senderId"
    WHERE a.status IN ('READY','QUEUED','SENDING')
    GROUP BY 1, 2 ORDER BY 1, 2`],
  ['C  the switches and the stamps — autopilot must read true, activeDevice must be this Mac\'s device name (above); planLastOkAt / dispatchLastOkAt should be minutes old', `
    SELECT key, left(value, 240) AS value, ${IST('"updatedAt"')} AS updated_ist,
           round(extract(epoch FROM ${NOW} - "updatedAt") / 60) AS mins_ago
    FROM "Setting"
    WHERE key IN ('autopilotEnabled','activeDevice','dispatchState','dispatchLastOkAt','sendLock','slotRunning',
                  'planLastOkAt','detectLastOkAt','detectFeedOkAt','detectThrottledUntil','schedulerHeartbeat')
    ORDER BY key`, 'vertical'],
  ['D  which Macs have beaten, and the accounts each one holds', `
    SELECT value FROM "Setting" WHERE key = 'devicePresence'`, 'presence'],
  ['E  sending pages — a dead session or a flag stops that page; in_rotation=no pages never send automatically', `
    SELECT s.handle, s.status, s."fleetMember" AS in_rotation, s.cohort,
           ${IST('s."sessionSavedAt"')} AS signed_in_ist,
           ${IST('s."sessionInvalidAt"')} AS session_dead_ist,
           ${IST('s."challengedAt"')} AS flagged_ist,
           (SELECT count(*) FROM "OutreachAttempt" a
             WHERE a."senderId" = s.id AND a.status IN ('SENT','REPLIED') AND a."sentAt" >= ${NOW} - interval '24 hours') AS sent_24h
    FROM "SenderAccount" s ORDER BY s.handle`],
  ['F  who can be written to. never_messaged can get a first message; resting heard from a page inside the window; resting_time_cannot_free have had every page write to them (or replied) — only a NEW paid post naming them frees those', `
    ${RESTING}
    SELECT (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}) AS live_recipients,
           (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}
              AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status IN ('SENT','REPLIED','FAILED'))) AS never_messaged,
           (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}
              AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status IN ('SENT','REPLIED'))
              AND EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status = 'FAILED')) AS never_delivered_but_parked,
           (SELECT count(*) FROM y) AS resting,
           (SELECT count(*) FROM y WHERE a_page_can_introduce = false) AS resting_time_cannot_free,
           ${WIN} AS window_days`],
  ['G  resting recipients by the IST day their rest ends. could_be_introduced: a page that has never written to them exists. needs_a_new_paid_post: every page has written (or they replied), so the date alone frees nothing', `
    ${RESTING}
    SELECT to_char(d, 'DD Mon') AS rest_ends_ist, n AS recipients, intro AS could_be_introduced, n - intro AS needs_a_new_paid_post
    FROM (SELECT (last_sent + ${WIN} * interval '1 day' + interval '5 hours 30 minutes')::date AS d,
                 count(*) AS n, count(*) FILTER (WHERE a_page_can_introduce) AS intro
          FROM y GROUP BY 1) z
    ORDER BY d`],
  ['H  new material — detection still finding posts, paid posts, and new companies to write to', `
    SELECT (SELECT ${IST('max("detectedAt")')} FROM "DetectedCampaign") AS newest_post_seen_ist,
           (SELECT count(*) FROM "DetectedCampaign" WHERE "detectedAt" >= ${NOW} - interval '24 hours') AS posts_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '24 hours') AS paid_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '7 days') AS paid_7d,
           (SELECT count(*) FROM "TargetAccount" WHERE role = 'PROSPECT' AND "createdAt" >= ${NOW} - interval '7 days') AS new_prospects_7d`],
  ['I  the server\'s last slot runs (4 a day) — a status other than OK, or an error, means the planner or detection is failing there', `
    SELECT slot, ${IST('"startedAt"')} AS started_ist, status, "newPosts" AS new_posts, queued, left(coalesce(error, ''), 160) AS error
    FROM "ScrapeRun" ORDER BY "startedAt" DESC LIMIT 4`],
  ['I2 the newest planned slot\'s verdicts — one row per reason a route got no new draft; "draft FAILED" means the planner threw on that route', `
    WITH r AS (SELECT "startedAt", detail FROM "ScrapeRun" WHERE detail LIKE '%"outreach"%' ORDER BY "startedAt" DESC LIMIT 1),
    o AS (SELECT r."startedAt", e FROM r, LATERAL jsonb_array_elements(
            CASE WHEN pg_input_is_valid(r.detail, 'jsonb') AND jsonb_typeof(r.detail::jsonb -> 'outreach') = 'array'
                 THEN r.detail::jsonb -> 'outreach' ELSE '[]'::jsonb END) e)
    SELECT ${IST('max("startedAt")')} AS slot_ist,
           CASE WHEN e ->> 'error' IS NOT NULL THEN 'draft FAILED: ' || left(regexp_replace(e ->> 'error', '@[A-Za-z0-9._]+', '@…', 'g'), 70)
                WHEN e ->> 'skipReason' IS NOT NULL THEN e ->> 'skipReason'
                WHEN e ->> 'status' IN ('READY','QUEUED') THEN '(a draft was written)'
                WHEN e ->> 'eligible' = 'true' THEN '(eligible, status ' || coalesce(e ->> 'status', 'none') || ')'
                ELSE '(other)' END AS outcome,
           count(*) AS routes
    FROM o GROUP BY 2 ORDER BY 3 DESC LIMIT 15`],
  ['J  failures — parked drafts queued in the last 3 days, by cause (a rising not-in-thread count trips the fleet breaker)', `
    SELECT coalesce("failureCode", '(none)') AS failure, count(*) AS parked
    FROM "OutreachAttempt" WHERE status = 'FAILED' AND "queuedAt" >= ${NOW} - interval '3 days'
    GROUP BY 1 ORDER BY 2 DESC`],
  ['K  replies in the last 7 days (by when they wrote) — each one pauses the page it answered for 7 days', `
    SELECT count(*) AS replies, count(DISTINCT "targetId") AS recipients
    FROM "OutreachAttempt" WHERE "replyPostedAt" >= ${NOW} - interval '7 days'`],
  ['L  which fixes are live on the server — audit rows only their planners write (permanent, so any row means deployed)', `
    SELECT 'f4dc4b1: drafts to retired recipients discarded' AS fix, count(*) AS audit_rows, ${IST('max(at)')} AS newest_ist
      FROM "AuditLog" WHERE action = 'attempt.skipped' AND actor = 'planner' AND detail LIKE 'this recipient is retired%'
    UNION ALL
    SELECT 'd196eb1: drafts of a page no Mac holds released', count(*), ${IST('max(at)')}
      FROM "AuditLog" WHERE action = 'attempt.skipped' AND detail LIKE '%so no Mac can send this%'
    UNION ALL
    SELECT 'drafts to RETIRED recipients still waiting now', count(*), NULL
      FROM "OutreachAttempt" a JOIN "OutreachPair" p ON p.id = a."pairId" JOIN "TargetAccount" t ON t.id = p."targetId"
      WHERE a.status IN ('READY','QUEUED') AND t."optedOut" = true`],
  ['P  the server\'s connection slots (on 22 Aug a full pool stopped everything)', `
    SELECT count(*) AS connections_in_use, current_setting('max_connections') AS max_connections FROM pg_stat_activity`],
]

async function main() {
  if (url === null || isPg === false) return
  const { Client } = req('pg')
  // query_timeout is the CLIENT's bound: statement_timeout is enforced by the server and cannot
  // come back over a dead link, so a stalled tunnel would otherwise hang a query for ~90 s each.
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 15000, query_timeout: 75000, application_name: 'ds-readonly-check' })
  // pg EMITS 'error' when a connected socket dies (the tunnel dropping mid-check). With no listener
  // EventEmitter throws from the socket callback, past every catch here, and the rest of the check
  // vanishes behind a raw stack. Reproduced by the review with pg 8.22.0. So: record it, stop cleanly.
  let lost = null
  c.on('error', (e) => { lost = e })
  try {
    await c.connect()
  } catch (e) {
    out('')
    out('== THE DATABASE IS NOT REACHABLE from this Mac: ' + (e.code || '') + ' ' + (e.message || e))
    for (const line of whyUnreachable(e)) out('   ' + line)
    return
  }
  try {
    await c.query("SET default_transaction_read_only = on")
    await c.query("SET statement_timeout = '60s'")
    const ro = await c.query('SHOW default_transaction_read_only')
    if (ro.rows[0].default_transaction_read_only === 'on') {
      out('   connected to the server database through this Mac\'s tunnel (session is read-only)')
    } else {
      out('   the session did not become read-only — stopping before any query')
      return
    }
    for (const [title, sql, mode] of Q) {
      if (lost) break
      let rows
      try {
        rows = (await c.query(sql)).rows
      } catch (e) {
        if (/Query read timeout/i.test(String(e.message))) lost = e
        if (lost) break
        out('')
        out('== ' + title)
        out('   (query failed: ' + (e.code || '') + ' ' + e.message + ')')
        continue
      }
      if (mode === 'vertical') {
        out('')
        out('== ' + title)
        if (rows.length === 0) out('   (none of these rows exist)')
        for (const r of rows) {
          let note = ''
          if (r.key === 'activeDevice') note = r.value === deviceName ? '   <- THIS Mac' : '   <- NOT this Mac (' + deviceName + '), so this Mac sends nothing'
          if (r.key === 'autopilotEnabled' && r.value !== 'true') note = '   <- autopilot is OFF, nothing sends unattended'
          out('   ' + r.key.padEnd(20) + ' ' + cell(r.updated_ist) + ' (' + cell(r.mins_ago) + ' min ago)  ' + cell(r.value) + note)
        }
      } else if (mode === 'presence') {
        out('')
        out('== ' + title)
        let list = []
        try { list = rows.length ? JSON.parse(rows[0].value) : [] } catch (e) { out('   (unreadable presence row)') }
        if (Array.isArray(list) === false) list = []
        if (list.length === 0) out('   (no Mac has ever beaten)')
        for (const d of list) {
          if (d === null || typeof d !== 'object' || typeof d.device !== 'string' || typeof d.at !== 'string') continue
          out('   ' + d.device.padEnd(22) + ' last beat ' + ist(d.at) + '  build ' + (d.version || '?') +
              '  holds: ' + (Array.isArray(d.handles) && d.handles.length ? d.handles.map((h) => '@' + h).join(' ') : '(no signed-in accounts)'))
        }
      } else {
        table(title, rows)
      }
    }
    if (lost) {
      out('')
      out('== THE CONNECTION TO THE SERVER DATABASE WAS LOST MID-CHECK: ' + (lost.code || '') + ' ' + lost.message)
      out('   The agent uses the same tunnel, so it cannot send while this happens.')
      out('   Check:  launchctl list | grep digitalsukoon     then run this check again')
      out('   Fix:    cd ~/ds-sales-agent && bash scripts/install-tunnel.sh install')
    }
  } finally {
    await c.end().catch(() => undefined)
  }
}
main().catch((e) => out('   check failed: ' + (e.code || '') + ' ' + (e.message || e)))
NODE
  DS_CHECK_APP="$APP" "$NODE_BIN" "$JS"
elif [ -z "$NODE_BIN" ]; then
  echo "   no node on this Mac — skipping the database half"
fi

# ─── 2. THIS MAC: is the agent alive, and what did it last say? ────────────────────────────────
echo
echo "== M  this Mac's agent jobs (a PID means running; '-' with a non-zero status means it exited)"
if command -v launchctl >/dev/null 2>&1; then
  launchctl list 2>/dev/null | grep -i 'digitalsukoon' || echo "   no DS Sales Agent jobs are loaded — the agent is not installed as a service here"
else
  echo "   (not a Mac — launchctl not found)"
fi

echo
echo "== N  the agent's log (watch.log: what it did)"
if [ -f "$LOGFILE" ]; then
  echo "   $(wc -l < "$LOGFILE" | tr -d ' ') lines, last written $(ls -l "$LOGFILE" | awk '{print $6, $7, $8}'); the last line:"
  tail -n 1 "$LOGFILE" | cut -c1-180 | sed 's/^/   /'
  echo
  echo "   what the last 4000 lines say, most frequent first:"
  tail -n 4000 "$LOGFILE" \
    | grep -oE '(dm delivered|dispatcher held  reason=[a-z-]+|waiting message held back .* reason=.{0,90}|not the selected sending Mac|this Mac is the selected sending Mac|another Mac is sending)' \
    | sed -E 's/pair=[^ ]+ //' | sort | uniq -c | sort -rn | head -n 15 | sed 's/^/   /'
  echo
  echo "   deliveries and holds in the last 2000 lines, by the hour they were logged:"
  # The month is matched as [A-Za-z]+ because en-GB writes September as "Sept". Lines that did not
  # rewrite are dropped by the second grep rather than printed raw. Counted in LOG order (awk keeps
  # first appearance), never sorted: a text sort would put "01 Nov" before "31 Oct".
  tail -n 2000 "$LOGFILE" \
    | grep -E 'dm delivered|waiting message held back|dispatcher held' \
    | sed -E 's/^([0-9]{1,2} [A-Za-z]+ [0-9]{4}, [0-9]{2}):.*(dm delivered|waiting message held back|dispatcher held).*/\1h  \2/' \
    | grep -E '^[0-9]{1,2} [A-Za-z]+ [0-9]{4}, [0-9]{2}h  (dm delivered|waiting message held back|dispatcher held)$' \
    | awk '{ if (($0 in n) == 0) order[++k] = $0; n[$0]++ } END { for (i = 1; i <= k; i++) printf "%6d %s\n", n[order[i]], order[i] }' \
    | tail -n 15 | sed 's/^/   /'
else
  echo "   no log at $LOGFILE — the agent has never run on this Mac"
fi

echo
echo "== N2 the agent's ERROR log (watch.error.log: every warning, error and alarm goes here, never to watch.log)"
if [ -f "$ERRLOG" ]; then
  echo "   $(wc -l < "$ERRLOG" | tr -d ' ') lines, last written $(ls -l "$ERRLOG" | awk '{print $6, $7, $8}') — compare with the time at the top; an old file means no recent errors"
  echo "   the most frequent causes in its last 4000 lines:"
  tail -n 4000 "$ERRLOG" \
    | grep -oE '(device tick failed.{0,90}|Can.t reach database server|this account is logged out|checkpoint.{0,60}|running for a long time|failed to start.{0,60}|circuit breaker.{0,60}|reply sweep.{0,50}failed|ALARM .{0,80})' \
    | sort | uniq -c | sort -rn | head -n 12 | sed 's/^/   /'
  echo "   the last 12 lines:"
  tail -n 12 "$ERRLOG" | cut -c1-200 | sed 's/^/   /'
else
  echo "   no error log at $ERRLOG"
fi

echo
echo "== O  sleep and wake, newest last (the agent cannot send while the Mac sleeps; a closed lid on battery always sleeps)"
if command -v pmset >/dev/null 2>&1; then
  # The event messages, not the domain word: ' Wake ' alone also matches 'Wake Requests' (a wake
  # scheduled for the FUTURE) and the 'Kernel Client Acks … Sleep/Wake notifications' lines.
  pmset -g log 2>/dev/null | grep -E 'Entering Sleep state|Wake from ' | tail -n 10 | cut -c1-140 | sed 's/^/   /'
  pmset -g batt 2>/dev/null | head -n 1 | sed 's/^/   /'
else
  echo "   (not a Mac — pmset not found)"
fi
echo
echo "== done. Nothing was changed."
