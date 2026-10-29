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
# module, and reads the agent's own log beside it. One paste answers both halves.
#
# It is a FILE run by bash, never a block pasted into zsh. The Mac's shell is zsh, and a pasted
# block meets zsh's `!` history expansion, its NOMATCH error on unmatched globs, and comments it
# does not allow at the prompt. All three are gone when bash reads a file.
#
# READ-ONLY by construction. The session is `default_transaction_read_only = on` with a 60 s
# statement timeout before the first query, so a write would be refused by Postgres itself.
# The shell half only lists and reads files. It prints NO secret: DATABASE_URL is read and passed
# to the driver, never echoed. A connection error is printed by its code and message, and pg's
# messages name the host and user, never the password.
#
# What each section separates is written in its heading. The common answer since the Instagram
# wall (15 Oct) is the seven-day material allowance on an exhausted list: section F shows most
# live recipients "resting", G shows when they come back, and the log shows
# "no paid post of theirs has been detected…" on every held draft. Every other answer is a fault
# with a named fix: the Mac asleep or its agent stopped, the tunnel down, autopilot off, another
# Mac selected, a sign-in gone, or a stuck lock.
set -u

APP="${DS_APP_DIR:-$HOME/ds-sales-agent}"
DATA="${DS_DATA_DIR:-$HOME/.ds-sales-agent-data}"
LOGFILE="$DATA/logs/watch.log"

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
  mv "$JS" "$JS.cjs" && JS="$JS.cjs"
  cat > "$JS" <<'NODE'
'use strict'
const path = require('path')
const fs = require('fs')
const app = process.env.DS_CHECK_APP
const req = require('module').createRequire(path.join(app, 'package.json'))

function out(s) { process.stdout.write(s + '\n') }

let url = null
try {
  const parsed = req('dotenv').parse(fs.readFileSync(path.join(app, '.env')))
  url = typeof parsed.DATABASE_URL === 'string' ? parsed.DATABASE_URL : null
} catch (e) {
  out('   could not read ' + path.join(app, '.env') + ' (' + (e.code || e.message) + ') — the agent cannot start without it')
}
const isPg = url !== null && /^postgres(ql)?:\/\//.test(url)
if (url !== null && isPg === false) out('   DATABASE_URL in .env is not a Postgres URL — this Mac is not pointed at the server, so it sends nothing')

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

// Every timestamp column is `timestamp WITHOUT time zone` holding UTC. So "now" is
// `now() AT TIME ZONE 'UTC'`, and every date or time is rendered as TEXT in SQL. Returned as a
// value, pg would read it as Mac-local time and shift it 5h30.
const NOW = `(now() AT TIME ZONE 'UTC')`
const IST = (col) => `to_char(${col} + interval '5 hours 30 minutes', 'DD Mon HH24:MI')`
const LIVE = `t.role = 'PROSPECT' AND t."optedOut" = false AND t."isVerified" IS TRUE`

const Q = [
  ['A  deliveries per IST day, last 8 days — today low after a big day is the seven-day rule; zero for days with drafts waiting is a fault', `
    SELECT to_char(d, 'DD Mon') AS ist_day, n AS delivered, ap AS by_autopilot, f AS first_ist, l AS last_ist
    FROM (SELECT ("sentAt" + interval '5 hours 30 minutes')::date AS d, count(*) AS n,
                 count(*) FILTER (WHERE "sentBy" LIKE 'autopilot:%') AS ap,
                 to_char(min("sentAt") + interval '5 hours 30 minutes', 'HH24:MI') AS f,
                 to_char(max("sentAt") + interval '5 hours 30 minutes', 'HH24:MI') AS l
          FROM "OutreachAttempt"
          WHERE status IN ('SENT','REPLIED') AND "sentAt" >= ${NOW} - interval '8 days'
          GROUP BY 1) x
    ORDER BY d`],
  ['B  the queue now, per sending page — READY is waiting to be sent; a SENDING row older than a few minutes is a stuck drive', `
    SELECT s.handle AS sender, a.status, count(*) AS drafts, ${IST('min(a."queuedAt")')} AS oldest_queued_ist
    FROM "OutreachAttempt" a JOIN "SenderAccount" s ON s.id = a."senderId"
    WHERE a.status IN ('READY','QUEUED','SENDING')
    GROUP BY 1, 2 ORDER BY 1, 2`],
  ['C  the switches and the stamps — autopilot must read true, activeDevice must be this Mac, the stamps should be minutes old', `
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
  ['F  who can be written to — "resting" heard from a page in the last 7 days and waits (unless a NEW paid post names them); never_messaged can get a first message now', `
    WITH x AS (
      SELECT t.id, max(a."sentAt") FILTER (WHERE a.status IN ('SENT','REPLIED')) AS last_sent
      FROM "TargetAccount" t LEFT JOIN "OutreachAttempt" a ON a."targetId" = t.id
      WHERE ${LIVE} GROUP BY t.id)
    SELECT count(*) AS live_recipients,
           count(*) FILTER (WHERE last_sent IS NULL) AS never_messaged,
           count(*) FILTER (WHERE last_sent >= ${NOW} - interval '7 days') AS resting,
           count(*) FILTER (WHERE last_sent < ${NOW} - interval '7 days') AS rested_over_7_days
    FROM x`],
  ['G  resting recipients by the IST day their 7-day rest ends (then the next page in their rotation may introduce itself; a new paid post naming one frees it sooner)', `
    WITH x AS (
      SELECT a."targetId", max(a."sentAt") AS last_sent
      FROM "OutreachAttempt" a JOIN "TargetAccount" t ON t.id = a."targetId"
      WHERE a.status IN ('SENT','REPLIED') AND ${LIVE}
      GROUP BY a."targetId")
    SELECT to_char(d, 'DD Mon') AS free_again_ist, n AS recipients
    FROM (SELECT (last_sent + interval '7 days 5 hours 30 minutes')::date AS d, count(*) AS n
          FROM x WHERE last_sent >= ${NOW} - interval '7 days' GROUP BY 1) y
    ORDER BY d`],
  ['H  new material — detection still finding posts, paid posts, and new companies to write to', `
    SELECT (SELECT ${IST('max("detectedAt")')} FROM "DetectedCampaign") AS newest_post_seen_ist,
           (SELECT count(*) FROM "DetectedCampaign" WHERE "detectedAt" >= ${NOW} - interval '24 hours') AS posts_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '24 hours') AS paid_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '7 days') AS paid_7d,
           (SELECT count(*) FROM "TargetAccount" WHERE role = 'PROSPECT' AND "createdAt" >= ${NOW} - interval '7 days') AS new_prospects_7d`],
  ['I  the last slot\'s planner verdicts (4 slots a day) — one row per reason a route got no new draft', `
    WITH r AS (SELECT "startedAt", detail FROM "ScrapeRun" WHERE detail LIKE '%"outreach"%' ORDER BY "startedAt" DESC LIMIT 1),
    o AS (SELECT r."startedAt", e FROM r, LATERAL jsonb_array_elements(
            CASE WHEN pg_input_is_valid(r.detail, 'jsonb') AND jsonb_typeof(r.detail::jsonb -> 'outreach') = 'array'
                 THEN r.detail::jsonb -> 'outreach' ELSE '[]'::jsonb END) e)
    SELECT ${IST('max("startedAt")')} AS slot_ist,
           coalesce(e ->> 'skipReason', CASE WHEN e ->> 'eligible' = 'true' THEN '(a draft was written)' ELSE '(other)' END) AS outcome,
           count(*) AS routes
    FROM o GROUP BY 2 ORDER BY 3 DESC LIMIT 15`],
  ['J  failures — parked drafts queued in the last 3 days, by cause (a rising not-in-thread count trips the fleet breaker)', `
    SELECT coalesce("failureCode", '(none)') AS failure, count(*) AS parked
    FROM "OutreachAttempt" WHERE status = 'FAILED' AND "queuedAt" >= ${NOW} - interval '3 days'
    GROUP BY 1 ORDER BY 2 DESC`],
  ['K  replies in the last 7 days (by when they wrote) — each one pauses the page it answered for 7 days', `
    SELECT count(*) AS replies, count(DISTINCT "targetId") AS recipients
    FROM "OutreachAttempt" WHERE "replyPostedAt" >= ${NOW} - interval '7 days'`],
  ['L  which fixes are live on the server — audit rows only their planners write', `
    SELECT 'f4dc4b1: drafts to retired recipients discarded' AS fix, count(*) AS audit_rows, ${IST('max(at)')} AS newest_ist
      FROM "AuditLog" WHERE action = 'attempt.skipped' AND actor = 'planner' AND detail LIKE 'this recipient is retired%'
    UNION ALL
    SELECT 'd196eb1: drafts of a page no Mac holds released', count(*), ${IST('max(at)')}
      FROM "AuditLog" WHERE action = 'attempt.skipped' AND detail LIKE '%so no Mac can send this%'
    UNION ALL
    SELECT 'drafts to RETIRED recipients still waiting now', count(*), NULL
      FROM "OutreachAttempt" a JOIN "OutreachPair" p ON p.id = a."pairId" JOIN "TargetAccount" t ON t.id = p."targetId"
      WHERE a.status IN ('READY','QUEUED') AND t."optedOut" = true`],
]

async function main() {
  if (url === null || isPg === false) return
  const { Client } = req('pg')
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 15000, application_name: 'ds-readonly-check' })
  try {
    await c.connect()
  } catch (e) {
    out('')
    out('== THE DATABASE IS NOT REACHABLE from this Mac: ' + (e.code || '') + ' ' + (e.message || e))
    out('   The agent reads and writes through the same tunnel, so it cannot send while this fails.')
    out('   Check:  launchctl list | grep digitalsukoon     (the .tunnel job should show a PID)')
    out('   Fix:    cd ~/ds-sales-agent && bash scripts/install-tunnel.sh install')
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
      let rows
      try {
        rows = (await c.query(sql)).rows
      } catch (e) {
        out('')
        out('== ' + title)
        out('   (query failed: ' + (e.code || '') + ' ' + e.message + ')')
        continue
      }
      if (mode === 'vertical') {
        out('')
        out('== ' + title)
        if (rows.length === 0) out('   (none of these rows exist)')
        for (const r of rows) out('   ' + r.key.padEnd(20) + ' ' + cell(r.updated_ist) + ' (' + cell(r.mins_ago) + ' min ago)  ' + cell(r.value))
      } else if (mode === 'presence') {
        out('')
        out('== ' + title)
        let list = []
        try { list = rows.length ? JSON.parse(rows[0].value) : [] } catch (e) { out('   (unreadable presence row)') }
        if (Array.isArray(list) === false) list = []
        if (list.length === 0) out('   (no Mac has ever beaten)')
        for (const d of list) {
          if (d === null || typeof d !== 'object' || typeof d.device !== 'string' || typeof d.at !== 'string') continue
          out('   ' + String(d.device).padEnd(22) + ' last beat ' + ist(d.at) + '  build ' + (d.version || '?') +
              '  holds: ' + (Array.isArray(d.handles) && d.handles.length ? d.handles.map((h) => '@' + h).join(' ') : '(no signed-in accounts)'))
        }
      } else {
        table(title, rows)
      }
    }
  } finally {
    await c.end().catch(() => undefined)
  }
}
main().catch((e) => out('   check failed: ' + (e.code || '') + ' ' + (e.message || e)))
NODE
  DS_CHECK_APP="$APP" "$NODE_BIN" "$JS"
  rm -f "$JS"
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
echo "== N  the agent's log"
if [ -f "$LOGFILE" ]; then
  echo "   $(wc -l < "$LOGFILE" | tr -d ' ') lines; the last one:"
  tail -n 1 "$LOGFILE" | cut -c1-180 | sed 's/^/   /'
  echo
  echo "   what the last 4000 lines say, most frequent first:"
  tail -n 4000 "$LOGFILE" \
    | grep -oE '(dm delivered|dispatcher held  reason=[a-z-]+|waiting message held back .* reason=.{0,90}|not the selected sending Mac|this Mac is the selected sending Mac|device tick failed.{0,100}|another Mac is sending|Can.t reach database server|logged out|checkpoint.{0,60})' \
    | sed -E 's/pair=[^ ]+ //' | sort | uniq -c | sort -rn | head -n 15 | sed 's/^/   /'
  echo
  echo "   deliveries and holds in the last 2000 lines, by the hour they were logged:"
  # Counted in LOG order (awk keeps first appearance), never sorted: a text sort would put
  # "01 Nov" before "31 Oct" and `tail` would then show the wrong hours.
  tail -n 2000 "$LOGFILE" \
    | grep -E 'dm delivered|waiting message held back|dispatcher held' \
    | sed -E 's/^([0-9]{1,2} [A-Za-z]{3} [0-9]{4}, [0-9]{2}):.*(dm delivered|waiting message held back|dispatcher held).*/\1h  \2/' \
    | grep -E '^[0-9]' \
    | awk '{ if (($0 in n) == 0) order[++k] = $0; n[$0]++ } END { for (i = 1; i <= k; i++) printf "%6d %s\n", n[order[i]], order[i] }' \
    | tail -n 15 | sed 's/^/   /'
else
  echo "   no log at $LOGFILE — the agent has never run on this Mac"
fi

echo
echo "== O  sleep and wake (the agent cannot send while the Mac sleeps; a closed lid on battery always sleeps)"
if command -v pmset >/dev/null 2>&1; then
  pmset -g log 2>/dev/null | grep -E ' (Sleep|Wake|DarkWake) ' | tail -n 5 | cut -c1-140 | sed 's/^/   /'
  pmset -g batt 2>/dev/null | head -n 1 | sed 's/^/   /'
else
  echo "   (not a Mac — pmset not found)"
fi
echo
echo "== done. Nothing was changed."
