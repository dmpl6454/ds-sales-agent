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
const REPAIR_STEPS_EARLY = [
  'Opening DS Sales Agent.app will NOT fix this on a finished install. Re-pair: move ~/ds-sales-agent/.env aside,',
  'delete ~/.ds-sales-agent-data/setup-complete, open DS Sales Agent.app and approve the Mac on /senders.',
]
try {
  const parsed = req('dotenv').parse(fs.readFileSync(path.join(app, '.env')))
  url = typeof parsed.DATABASE_URL === 'string' ? parsed.DATABASE_URL : null
  // The same rule as deviceId() in src/outreach/devicePresence.ts, so section C can say whether
  // activeDevice names THIS Mac. A device name is not a secret.
  if (typeof parsed.DS_DEVICE_NAME === 'string' && parsed.DS_DEVICE_NAME.trim()) deviceName = parsed.DS_DEVICE_NAME.trim()
  if (url === null) {
    out('   ' + path.join(app, '.env') + ' has NO DATABASE_URL line — the agent cannot start without it, so this Mac sends')
    out('   nothing, and the database half of this check is skipped.')
    for (const line of REPAIR_STEPS_EARLY) out('   ' + line)
  }
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
//
// NEVER ADVISE `install-tunnel.sh install`. On a Mac set up from the installer the tunnel was
// installed with DS_TUNNEL_HOST=ds-linode, and the script's default host `linode` is an ssh alias
// that exists only on the maintainer's old Mac — so a bare reinstall points the tunnel at nothing
// and stops all sending. Restarting the existing job keeps its own settings. (Review of 157afdc.)
const TUNNEL_RESTART = 'launchctl kickstart -k gui/$(id -u)/com.digitalsukoon.ds-sales-agent.tunnel'
const REPAIR_STEPS = [
  'Opening DS Sales Agent.app will NOT fix this on a finished install: it only opens the dashboard, and the',
  'installer keeps an existing .env. Ask whoever runs the server for the current database credentials, or',
  're-pair this Mac with them present: move ~/ds-sales-agent/.env aside, delete',
  '~/.ds-sales-agent-data/setup-complete, open DS Sales Agent.app and approve the Mac on /senders.',
]
function whyUnreachable(e) {
  const code = String(e.code || '')
  const msg = String(e.message || e)
  if (code === '53300' || /too many connections|reserved for roles/i.test(msg)) {
    return [
      'The tunnel is UP — the server answered — but its Postgres is out of connection slots.',
      'Something is holding connections (on 22 Aug it was a `pnpm local` dashboard on a Mac). The agent cannot',
      'connect either, so nothing sends until they are freed. Stop any local dashboard, then check the server.',
    ]
  }
  if (/SASL|client password must be a string/i.test(msg)) {
    // Raised by the driver HERE, before the server is asked: the URL in .env carries no password.
    return ['The DATABASE_URL in ~/ds-sales-agent/.env has no password in it, so the login cannot be completed.', ...REPAIR_STEPS]
  }
  if (['28P01', '28000', '3D000'].includes(code) || /password authentication|does not exist/i.test(msg)) {
    return [
      'The tunnel is fine: the server answered and REFUSED the login stored in ~/ds-sales-agent/.env, so either the',
      'server\'s credentials changed or that file is stale. The agent uses the same login, so it sends nothing.',
      ...REPAIR_STEPS,
    ]
  }
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) {
    return [
      'Nothing is listening at the tunnel\'s local port, so the tunnel on this Mac is down. The agent reads and',
      'writes through it, so it cannot send while this lasts.',
      'Check:    launchctl list | grep digitalsukoon     (the .tunnel line should show a PID in its first column)',
      'Restart:  ' + TUNNEL_RESTART,
      'Do not reinstall it with install-tunnel.sh — that would point it at the wrong server.',
    ]
  }
  return [
    'The tunnel\'s port answered but the server behind it did not (a timeout or a dropped connection). Either the',
    'server or the network to it is down, or the tunnel is restarting. Nothing on this Mac fixes that: run this',
    'check again in a few minutes, and if it persists, someone with access to the server should look at it.',
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
// only if they have never replied (isFollowUp: touchesSoFar > 0 || targetHasEverReplied).
//
// And only a page rotation can actually ELECT counts, which the first fix missed (re-review of
// 9e55189, reproduced): ensureFleetPairs gives every fleet page a pair to every recipient whether or
// not it can send, so a page held by no Mac (@bollywoodchronicle since 22 Sept) left an undelivered
// pair on every recipient and made all of them read "could be introduced" for a date that frees
// nothing. So the page must pass readSenderAvailability's tests — ACTIVE, a recorded session not
// since proved dead, listed by a Mac within 72 h ($1, computed in JS below; NULL = no witness, the
// rule's own fallback) — and share a fleet with the recipient (no membership = 'bollywood', the
// same intersection routes.ts and gate.ts ask). Still an approximation: it does not know which page
// rotation elects NEXT, or whether a park blocks that route.
// The fleet rule: a page may write to a recipient only if their categories meet, and no
// membership means 'bollywood' (routes.ts / senderCategories.ts — the same intersection).
const FLEET_MATCH = (sender, target) => `EXISTS (
  SELECT 1 FROM (
    SELECT lower(c.slug) AS slug FROM "CategorySender" cs JOIN "Category" c ON c.id = cs."categoryId"
      WHERE cs."senderId" = ${sender} AND cs.enabled = true
    UNION ALL SELECT 'bollywood'
      WHERE NOT EXISTS (SELECT 1 FROM "CategorySender" cs WHERE cs."senderId" = ${sender} AND cs.enabled = true)
  ) sc JOIN (
    SELECT lower(c.slug) AS slug FROM "CategoryTarget" ct JOIN "Category" c ON c.id = ct."categoryId"
      WHERE ct."targetId" = ${target} AND ct.enabled = true
    UNION ALL SELECT 'bollywood'
      WHERE NOT EXISTS (SELECT 1 FROM "CategoryTarget" ct WHERE ct."targetId" = ${target} AND ct.enabled = true)
  ) tc ON tc.slug = sc.slug)`
// A page rotation could elect today: readSenderAvailability's tests (ACTIVE, a recorded session not
// since proved dead, listed by a Mac within 72 h — $1, computed in JS below; NULL = no witness).
const ELECTABLE = (s) => `${s}."fleetMember" = true AND ${s}.status = 'ACTIVE' AND ${s}."sessionPath" IS NOT NULL
  AND ${s}."sessionInvalidAt" IS NULL AND ($1::text[] IS NULL OR lower(${s}.handle) = ANY ($1::text[]))`
// checkRecipientIsNotAPerson (brandGuards.ts) with isPersonRoleCategory (resolveBrand.ts): a BRAND
// row whose Instagram category is a profession is never written to, unless admitted as campaign
// talent. The two word lists are COPIED from src/detection/resolveBrand.ts — a diagnostic, so a
// drift costs a miscount, never a send.
const PERSON_CATEGORIES = ['artist','actor','musician/band','public figure','politician','personal blog','digital creator',
  'content creator','entrepreneur','author','athlete','blogger','video creator','gamer','comedian','fashion designer',
  'designer','photographer','model','writer','journalist','editor','chef','dancer','musician','singer','producer',
  'director','filmmaker','makeup artist','hair stylist','fashion model','actress','influencer','coach','doctor','lawyer',
  'teacher','personal trainer','fitness trainer','health/beauty','gaming video creator','gaming creator']
const PERSON_ROLE_WORDS = ['actor','actress','artist','astrologer','astrologist','athlete','author','blogger','celebrities',
  'celebrity','chef','coach','comedian','creator','creators','dancer','designer','director','doctor','entrepreneur',
  'filmmaker','gamer','influencer','investigator','journalist','lawyer','model','musician','photographer','politician',
  'producer','singer','teacher','writer']
const sqlArray = (xs) => `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')}]::text[]`
const IS_A_PERSON = (t) => `(${t}.kind = 'BRAND' AND ${t}."campaignTalent" = false AND (
  lower(trim(coalesce(${t}."brandCategory", ''))) = ANY (${sqlArray(PERSON_CATEGORIES)})
  OR regexp_split_to_array(lower(coalesce(${t}."brandCategory", '')), '[^a-z]+') && ${sqlArray(PERSON_ROLE_WORDS)}))`

// One row per resting recipient (heard from a page inside the window) and what can release it.
// A follow-up needs a NEW paid post naming them (governor NO_NEW_MATERIAL), so when their rest ends
// only a page that has NEVER delivered to them may write — an introduction — and only if they never
// replied (isFollowUp: touchesSoFar > 0 || targetHasEverReplied). Four outcomes, because they have
// four different cures (reviews of 9e55189 and 157afdc):
//   no_page_can_send      no same-fleet page rotation could elect at all — bring a Mac or a sign-in back
//   introducible          an electable page that never wrote exists — time frees them
//   blocked_on_a_page     a page that never wrote exists but cannot send now (no Mac holds it, logged out)
//   needs_new_paid_post   every same-fleet page has written, or they replied — only material frees them
// Still an approximation of rotation: it does not know which page is elected NEXT, or a park.
const NEVER_DELIVERED = (p) => `NOT EXISTS (SELECT 1 FROM "OutreachAttempt" d WHERE d."pairId" = ${p}.id AND d.status IN ('SENT','REPLIED'))`
const RESTING = `
  WITH x AS (
    SELECT a."targetId", max(a."sentAt") AS last_sent
    FROM "OutreachAttempt" a JOIN "TargetAccount" t ON t.id = a."targetId"
    WHERE a.status IN ('SENT','REPLIED') AND ${LIVE}
    GROUP BY a."targetId"
    HAVING max(a."sentAt") >= ${NOW} - ${WIN} * interval '1 day'
  ), y0 AS (
    SELECT x.*,
      EXISTS (SELECT 1 FROM "OutreachAttempt" r WHERE r."targetId" = x."targetId" AND r."replyPostedAt" IS NOT NULL) AS replied,
      EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
              WHERE p."targetId" = x."targetId" AND ${ELECTABLE('s')} AND ${FLEET_MATCH('s.id', 'x."targetId"')}) AS any_page_can_send,
      EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
              WHERE p."targetId" = x."targetId" AND ${ELECTABLE('s')} AND ${FLEET_MATCH('s.id', 'x."targetId"')}
                AND ${NEVER_DELIVERED('p')}) AS electable_never_wrote,
      EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
              WHERE p."targetId" = x."targetId" AND s."fleetMember" = true AND ${FLEET_MATCH('s.id', 'x."targetId"')}
                AND ${NEVER_DELIVERED('p')}) AS some_page_never_wrote
    FROM x
  ), y AS (
    SELECT y0.*,
      CASE WHEN any_page_can_send = false THEN 'no_page_can_send'
           WHEN replied = false AND electable_never_wrote THEN 'introducible'
           WHEN replied = false AND some_page_never_wrote THEN 'blocked_on_a_page'
           ELSE 'needs_new_paid_post' END AS outcome
    FROM y0)`

// What each count in a 'kv' section means, printed beside it.
const MEANS = {
  live_recipients: 'verified companies we may write to (not retired)',
  can_get_a_first_message_now: 'never messaged, not a person, and a page that can send reaches them',
  never_messaged_but_refused: 'never messaged, but a person (never written to) or no page that can send reaches them',
  never_delivered_but_parked: 'a message to them was parked — it may have arrived, a person settles it',
  resting: 'heard from one of our pages inside the window',
  resting_time_frees: 'when their rest ends, a page that can send and never wrote to them can introduce itself',
  resting_blocked_on_a_page: 'a page that never wrote to them exists but cannot send now — sign it in on the sending Mac',
  resting_needs_a_new_paid_post: 'every page has written (or they replied) — only a new paid post naming them frees them',
  resting_no_page_can_send: 'no page that can send reaches them at all — bring back a Mac or a sign-in',
  window_days: 'the rest window (Setting defaultCooldownDays)',
}

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
  ['B  the queue now, per sending page. READY waits to be sent; a failed send or an unreadable thread read moves a draft to the back, so oldest_in_line_since is when it was written OR last retried, and retrying/most_tries show drafts failing toward a park (3 tries). SENDING is a drive in progress — stuck only if C shows no sendLock, or one more than ~6 min old', `
    SELECT s.handle AS sender, a.status, count(*) AS drafts,
           CASE WHEN a.status = 'SENDING' THEN NULL ELSE ${IST('min(a."queuedAt")')} END AS oldest_in_line_since_ist,
           count(*) FILTER (WHERE a.attempts > 0) AS retrying, max(a.attempts) AS most_tries
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
  ['F  who can be written to', `
    ${RESTING}
    SELECT (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}) AS live_recipients,
           (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}
              AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status IN ('SENT','REPLIED','FAILED'))
              AND NOT ${IS_A_PERSON('t')}
              AND EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
                          WHERE p."targetId" = t.id AND ${ELECTABLE('s')} AND ${FLEET_MATCH('s.id', 't.id')})) AS can_get_a_first_message_now,
           (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}
              AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status IN ('SENT','REPLIED','FAILED'))
              AND (${IS_A_PERSON('t')}
                   OR NOT EXISTS (SELECT 1 FROM "OutreachPair" p JOIN "SenderAccount" s ON s.id = p."senderId"
                                  WHERE p."targetId" = t.id AND ${ELECTABLE('s')} AND ${FLEET_MATCH('s.id', 't.id')}))) AS never_messaged_but_refused,
           (SELECT count(*) FROM "TargetAccount" t WHERE ${LIVE}
              AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status IN ('SENT','REPLIED'))
              AND EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."targetId" = t.id AND a.status = 'FAILED')) AS never_delivered_but_parked,
           (SELECT count(*) FROM y) AS resting,
           (SELECT count(*) FROM y WHERE outcome = 'introducible') AS resting_time_frees,
           (SELECT count(*) FROM y WHERE outcome = 'blocked_on_a_page') AS resting_blocked_on_a_page,
           (SELECT count(*) FROM y WHERE outcome = 'needs_new_paid_post') AS resting_needs_a_new_paid_post,
           (SELECT count(*) FROM y WHERE outcome = 'no_page_can_send') AS resting_no_page_can_send,
           ${WIN} AS window_days`, 'kv'],
  ['G  resting recipients by the IST day their rest ends, and what releases them then (see F for what each column means)', `
    ${RESTING}
    SELECT to_char(d, 'DD Mon') AS rest_ends_ist, n AS recipients, intro AS time_frees, blocked AS blocked_on_a_page,
           needs AS needs_a_new_paid_post, nopage AS no_page_can_send
    FROM (SELECT (last_sent + ${WIN} * interval '1 day' + interval '5 hours 30 minutes')::date AS d, count(*) AS n,
                 count(*) FILTER (WHERE outcome = 'introducible') AS intro,
                 count(*) FILTER (WHERE outcome = 'blocked_on_a_page') AS blocked,
                 count(*) FILTER (WHERE outcome = 'needs_new_paid_post') AS needs,
                 count(*) FILTER (WHERE outcome = 'no_page_can_send') AS nopage
          FROM y GROUP BY 1) z
    ORDER BY d`],
  ['H  new material — detection still finding posts, paid posts, and new companies to write to', `
    SELECT (SELECT ${IST('max("detectedAt")')} FROM "DetectedCampaign") AS newest_post_seen_ist,
           (SELECT count(*) FROM "DetectedCampaign" WHERE "detectedAt" >= ${NOW} - interval '24 hours') AS posts_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '24 hours') AS paid_24h,
           (SELECT count(*) FROM "DetectedCampaign" WHERE verdict = 'CAMPAIGN' AND "detectedAt" >= ${NOW} - interval '7 days') AS paid_7d,
           (SELECT count(*) FROM "TargetAccount" WHERE role = 'PROSPECT' AND "createdAt" >= ${NOW} - interval '7 days') AS new_prospects_7d`],
  ['I  the server\'s last slot runs (4 a day) — a status other than OK, or an error, means the planner or detection is failing there; an unfinished run shows no counts', `
    SELECT r.slot, ${IST('r."startedAt"')} AS started_ist,
           CASE WHEN r."finishedAt" IS NOT NULL THEN r.status
                WHEN r."startedAt" = (SELECT max("startedAt") FROM "ScrapeRun")
                     AND (r."startedAt" > ${NOW} - interval '60 minutes'
                          OR EXISTS (SELECT 1 FROM "Setting" WHERE key = 'slotRunning' AND "updatedAt" > ${NOW} - interval '3 minutes'))
                  THEN 'STILL RUNNING'
                ELSE 'NEVER FINISHED (the worker stopped mid-slot?)' END AS status,
           CASE WHEN r."finishedAt" IS NULL THEN NULL ELSE r."newPosts" END AS new_posts,
           CASE WHEN r."finishedAt" IS NULL THEN NULL ELSE r.queued END AS queued,
           left(coalesce(r.error, ''), 160) AS error
    FROM "ScrapeRun" r ORDER BY r."startedAt" DESC LIMIT 4`],
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
  ['Q  the last delivery ever, and deliveries per IST day over the last 30 days (days with none are left out)', `
    SELECT ${IST('max("sentAt")')} AS last_delivery_ist,
           round((extract(epoch FROM ${NOW} - max("sentAt")) / 86400.0)::numeric, 1) AS days_ago,
           (SELECT string_agg(to_char(d, 'DD Mon') || '=' || n, '  ' ORDER BY d)
              FROM (SELECT ("sentAt" + interval '5 hours 30 minutes')::date AS d, count(*) AS n FROM "OutreachAttempt"
                    WHERE status IN ('SENT','REPLIED') AND "sentAt" >= ${NOW} - interval '30 days' GROUP BY 1) z) AS per_day_30d
    FROM "OutreachAttempt" WHERE status IN ('SENT','REPLIED')`],
  ['R  detection verdicts per IST day — paid posts are the only new material for a follow-up; many "unjudged" means the classifier is failing', `
    SELECT to_char(d, 'DD Mon') AS ist_day, n AS posts, campaign AS paid, organic, unjudged, judged_by_model
    FROM (SELECT ("detectedAt" + interval '5 hours 30 minutes')::date AS d, count(*) AS n,
                 count(*) FILTER (WHERE verdict = 'CAMPAIGN') AS campaign,
                 count(*) FILTER (WHERE verdict = 'ORGANIC') AS organic,
                 count(*) FILTER (WHERE verdict NOT IN ('CAMPAIGN','ORGANIC')) AS unjudged,
                 count(*) FILTER (WHERE "verdictSource" = 'semantic') AS judged_by_model
          FROM "DetectedCampaign" WHERE "detectedAt" >= ${SEVEN_IST_DAYS} GROUP BY 1) x
    ORDER BY d`],
  ['R2 classifier calls in the last 48 h — failures here mean posts are stored and never judged. avg_ms near 30000 is our own timeout; a short one means the far end cut the connection', `
    SELECT purpose, ok, count(*) AS calls, round(avg(ms)) AS avg_ms, max(ms) AS max_ms,
           ${IST('min(at)')} AS oldest_ist, ${IST('max(at)')} AS newest_ist,
           left(mode() WITHIN GROUP (ORDER BY error), 100) AS commonest_error
    FROM "ModelCall" WHERE at >= ${NOW} - interval '48 hours'
    GROUP BY 1, 2 ORDER BY 1, 2`],
  ['R3 classifier calls per IST day, last 14 days — when the failures started, and what a working day costs (spend_usd is every model call that day). HTTP 402 is DeepSeek saying the account is OUT OF CREDIT', `
    SELECT to_char(d, 'DD Mon') AS ist_day, ok_calls, failed_calls, spend_usd, top_error
    FROM (SELECT (at + interval '5 hours 30 minutes')::date AS d,
                 count(*) FILTER (WHERE ok AND purpose = 'classify') AS ok_calls,
                 count(*) FILTER (WHERE ok = false AND purpose = 'classify') AS failed_calls,
                 round(sum("costUsd")::numeric, 4) AS spend_usd,
                 left(mode() WITHIN GROUP (ORDER BY error) FILTER (WHERE purpose = 'classify'), 60) AS top_error
          FROM "ModelCall" WHERE at >= ${NOW} - interval '14 days' GROUP BY 1) x
    ORDER BY d`],
  ['S  per page: recipients it could still write a FIRST message to (needs no new paid post) — only pages that can_send_now actually will', `
    SELECT s.handle AS page,
           (s."fleetMember" AND s.status = 'ACTIVE' AND s."sessionPath" IS NOT NULL AND s."sessionInvalidAt" IS NULL
            AND ($1::text[] IS NULL OR lower(s.handle) = ANY ($1::text[]))) AS can_send_now,
           count(t.id) AS could_introduce_to
    FROM "SenderAccount" s
    LEFT JOIN "OutreachPair" p ON p."senderId" = s.id
    LEFT JOIN "TargetAccount" t ON t.id = p."targetId" AND ${LIVE}
      AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" a WHERE a."pairId" = p.id
                        AND (a.status IN ('SENT','REPLIED','SENDING','READY','QUEUED') OR a.status = 'FAILED'))
      AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" r WHERE r."targetId" = t.id AND r."replyPostedAt" IS NOT NULL)
      AND NOT ${IS_A_PERSON('t')}
      AND NOT EXISTS (SELECT 1 FROM "OutreachAttempt" w WHERE w."targetId" = t.id AND w.status IN ('SENT','REPLIED')
                        AND w."sentAt" >= ${NOW} - ${WIN} * interval '1 day')
      AND EXISTS (
        SELECT 1 FROM (
          SELECT lower(c.slug) AS slug FROM "CategorySender" cs JOIN "Category" c ON c.id = cs."categoryId"
            WHERE cs."senderId" = s.id AND cs.enabled = true
          UNION ALL SELECT 'bollywood'
            WHERE NOT EXISTS (SELECT 1 FROM "CategorySender" cs WHERE cs."senderId" = s.id AND cs.enabled = true)
        ) sc JOIN (
          SELECT lower(c.slug) AS slug FROM "CategoryTarget" ct JOIN "Category" c ON c.id = ct."categoryId"
            WHERE ct."targetId" = t.id AND ct.enabled = true
          UNION ALL SELECT 'bollywood'
            WHERE NOT EXISTS (SELECT 1 FROM "CategoryTarget" ct WHERE ct."targetId" = t.id AND ct.enabled = true)
        ) tc ON tc.slug = sc.slug)
    WHERE s."fleetMember" = true
    GROUP BY s.id, s.handle, s.status, s."fleetMember", s."sessionPath", s."sessionInvalidAt"
    ORDER BY s.handle`],
  ['P  the server\'s connection slots (on 22 Aug a full pool stopped everything)', `
    SELECT count(*) FILTER (WHERE backend_type = 'client backend') AS connections_in_use,
           current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
             - coalesce(current_setting('reserved_connections', true), '0')::int AS usable_by_the_app,
           current_setting('max_connections') AS max_connections
    FROM pg_stat_activity`],
]

// Which handles a Mac has listed within 72 h — the same rule as onlineSessionHolders() in
// src/outreach/availability.ts (the persisted per-handle history merged with the presence row),
// or null when no presence entry carries `handles` (no witness: rotation then excludes nobody).
const HOLD_MS = 72 * 3600000
function heldHandles(presenceRaw, historyRaw, now) {
  let entries = []
  try { const p = JSON.parse(presenceRaw); if (Array.isArray(p)) entries = p } catch (e) { entries = [] }
  const witness = entries.some((e) => e !== null && typeof e === 'object' && Array.isArray(e.handles))
  if (witness === false) return null
  const latest = new Map()
  const note = (h, t) => { const k = h.toLowerCase(); if (latest.has(k) === false || t > latest.get(k)) latest.set(k, t) }
  let hist = {}
  try { const h = JSON.parse(historyRaw); if (h !== null && typeof h === 'object' && Array.isArray(h) === false) hist = h } catch (e) { hist = {} }
  for (const [h, at] of Object.entries(hist)) {
    if (typeof at !== 'string') continue
    const t = new Date(at).getTime()
    if (Number.isFinite(t)) note(h, Math.min(t, now))
  }
  for (const e of entries) {
    if (e === null || typeof e !== 'object' || Array.isArray(e.handles) === false || typeof e.at !== 'string') continue
    const t = new Date(e.at).getTime()
    if (Number.isFinite(t) === false) continue
    for (const h of e.handles) if (typeof h === 'string') note(h, Math.min(t, now))
  }
  return [...latest].filter(([, t]) => now - t <= HOLD_MS).map(([k]) => k)
}

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
    let held = null
    try {
      const hr = (await c.query(`SELECT key, value FROM "Setting" WHERE key IN ('devicePresence','sessionHolderSeen')`)).rows
      const val = (k) => { const r = hr.find((x) => x.key === k); return r ? r.value : null }
      held = heldHandles(val('devicePresence'), val('sessionHolderSeen'), Date.now())
    } catch (e) {
      held = null
    }
    for (const [title, sql, mode] of Q) {
      if (lost) break
      let rows
      try {
        rows = (await c.query(sql, sql.includes('$1') ? [held] : [])).rows
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
      } else if (mode === 'kv') {
        out('')
        out('== ' + title)
        const r = rows[0] || {}
        const w = Math.max(...Object.keys(r).map((k) => k.length))
        for (const [k, v] of Object.entries(r)) out('   ' + k.padEnd(w) + '  ' + cell(v).padStart(6) + (MEANS[k] ? '   ' + MEANS[k] : ''))
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
        if (held === null) {
          out('   (no Mac reports which accounts it holds, so rotation excludes no page on that ground)')
        } else {
          try {
            const fleet = (await c.query(`SELECT handle FROM "SenderAccount" WHERE "fleetMember" = true AND status = 'ACTIVE' ORDER BY handle`)).rows
            const unheld = fleet.map((r) => r.handle).filter((h) => held.includes(h.toLowerCase()) === false)
            out('   pages in rotation that NO Mac has listed in 72 h (rotation skips them; sign them in on the sending Mac): ' +
                (unheld.length ? unheld.map((h) => '@' + h).join(' ') : 'none'))
          } catch (e) {
            if (/Query read timeout/i.test(String(e.message))) lost = e
          }
        }
      } else {
        table(title, rows)
      }
    }
    if (lost) {
      out('')
      out('== THE CONNECTION TO THE SERVER DATABASE WAS LOST MID-CHECK: ' + (lost.code || '') + ' ' + lost.message)
      out('   The tunnel restarted or the server went away while the check ran; the sections above it are real,')
      out('   the rest did not run. Run the check again in a minute — if the database is then unreachable, it says')
      out('   what to do. Do not reinstall the tunnel with install-tunnel.sh.')
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
echo "== T  per IST day, from the logs: deliveries, and the conversation reads that failed (oldest first; the last 20 days that had any)"
# A follow-up's thread is read before it is sent, and the reply sweep reads inboxes; when Instagram
# changes its page the reads fail closed and the follow-up is parked "unreadable". This shows WHEN.
# watch.log is rotated (disk care keeps its tail), so it covers fewer days than the error log;
# a day before its first line shows '-' for delivered rather than a false 0. Section Q is the record.
FIRSTDAY="$( [ -f "$LOGFILE" ] && head -n 1 "$LOGFILE" | sed -nE 's/^([0-9]{1,2} [A-Za-z]+ [0-9]{4}),.*/\1/p' )"
{ [ -f "$LOGFILE" ] && grep -E 'dm delivered' "$LOGFILE"; [ -f "$ERRLOG" ] && grep -E 'could not read thread|inbox scan unreadable|could not be read repeatedly'  "$ERRLOG"; } 2>/dev/null \
  | sed -E 's/^([0-9]{1,2} [A-Za-z]+ [0-9]{4}), .*(dm delivered|could not read thread|inbox scan unreadable|could not be read repeatedly).*/\1  \2/' \
  | grep -E '^[0-9]{1,2} [A-Za-z]+ [0-9]{4}  (dm delivered|could not read thread|inbox scan unreadable|could not be read repeatedly)$' \
  | awk -v first="$FIRSTDAY" 'BEGIN { split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " "); for (i = 1; i <= 12; i++) mon[m[i]] = i; mon["Sept"] = 9
                                     split(first, q, " "); firstkey = (first == "") ? 0 : q[3] * 10000 + mon[q[2]] * 100 + q[1] }
         { split($0, f, "  "); day = f[1]; what = f[2]; split(day, p, " ")
           key = p[3] * 10000 + mon[p[2]] * 100 + p[1]
           if ((day in seen) == 0) { seen[day] = key; days[++k] = day } c[day, what]++ }
         END { for (i = 2; i <= k; i++) { v = days[i]; j = i - 1; while (j > 0 && seen[days[j]] > seen[v]) { days[j + 1] = days[j]; j-- } days[j + 1] = v }
               printf "   %-14s %10s %18s %22s %17s\n", "day", "delivered", "thread unreadable", "inbox scan unreadable", "parked as unread"
               for (i = 1; i <= k; i++) { d = days[i]; dl = (seen[d] < firstkey) ? "-" : c[d, "dm delivered"] + 0
                 printf "   %-14s %10s %18d %22d %17d\n", d, dl, c[d, "could not read thread"], c[d, "inbox scan unreadable"], c[d, "could not be read repeatedly"] } }' \
  | { IFS= read -r header; echo "$header"; tail -n 20; }
echo
echo "== O  sleep and wake, newest last (the agent cannot send while the Mac sleeps; a closed lid on battery always sleeps)"
if command -v pmset >/dev/null 2>&1; then
  # The event messages, not the domain word: ' Wake ' alone also matches 'Wake Requests' (a wake
  # scheduled for the FUTURE) and the 'Kernel Client Acks … Sleep/Wake notifications' lines.
  # Real sleeps and wakes only: a DarkWake is a few seconds awake (the agent cannot send in it) and
  # its 'Maintenance Sleep' re-sleeps would push the sleep that started an outage out of view.
  pmset -g log 2>/dev/null | grep -E 'Entering Sleep state|[[:space:]]Wake from |FullWake from ' \
    | grep -vE 'Maintenance Sleep|Sleep Service Back to Sleep' | tail -n 10 | cut -c1-140 | sed 's/^/   /'
  pmset -g batt 2>/dev/null | head -n 1 | sed 's/^/   /'
  # Instagram draws a conversation only while Chrome is rendering frames, and a Mac whose display
  # has slept renders none — so a display that sleeps is the first suspect when unattended reads
  # fail and the same read run by hand works. 'displaysleep 0' means never.
  echo "   power settings that decide whether the display sleeps:"
  pmset -g 2>/dev/null | grep -E '^ *(displaysleep|sleep|powernap) ' | sed 's/^ */     /'
  if command -v system_profiler >/dev/null 2>&1; then
    echo "   displays connected:"
    system_profiler SPDisplaysDataType 2>/dev/null | grep -E '^ {8}[^ ].*:$|Online:|Main Display:|Display Asleep:' | sed 's/^ */     /' | head -n 12
  fi
else
  echo "   (not a Mac — pmset not found)"
fi
echo
echo "== done. Nothing was changed."
