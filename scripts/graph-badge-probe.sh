#!/usr/bin/env bash
# graph-badge-probe.sh — READ-ONLY. Does Meta's OFFICIAL Instagram read report the blue tick?
#
# Run it on the box (the server), as root, as a FILE:
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<commit>/scripts/graph-badge-probe.sh -o /tmp/gbp.sh && bash /tmp/gbp.sh
#   bash /tmp/gbp.sh netflix_in someotherhandle      ask about these handles instead of the default list
#
# WHY (23 Nov 2026). Since 15 Oct no new company can be added: the only thing that turns a name into a MESSAGEABLE
# company is the verified badge (VERIFIED ONLY), and the only place we ever read it — the anonymous feed — has refused
# us since 15 Oct. The box already reads posts through Meta's official API (Business Discovery, with the business's
# own token, META_GRAPH_TOKEN). Whether that API also reports `is_verified` has never been checked: Meta's docs do not
# list it, and Meta is unreachable from the sandbox where this was written. One question, a handful of requests.
#
# HOW IT ANSWERS WITHOUT FOOLING ITSELF. For each handle it asks twice:
#   1. a CONTROL read (username, name, followers_count) — fields Business Discovery is documented to serve. If this
#      fails, the token, the app or the handle is the problem, and the second answer means nothing.
#   2. the same read plus `is_verified`. A true/false back means Meta reports the badge. An error naming the field
#      after a control that WORKED means Meta does not.
# The default list holds companies we hold as verified and our own pages, so a true and a false are both likely.
#
# What it does NOT do: write anything (no database, no file), change a setting, or print the token. It reads
# META_GRAPH_TOKEN, META_IG_USER_ID and META_GRAPH_VERSION from the app's .env through dotenv, the same way the worker
# does, and every printed error has the token masked. Requests are spaced 2 s apart; at most 2 per handle.
#
# Exit: 0 answered (yes or no) · 1 could not tell · 2 not configured / bad arguments
set -euo pipefail

APP="${DS_APP_DIR:-/opt/ds-sales-agent}"
[[ -d "$APP/node_modules/dotenv" ]] || { echo "-- STOPPED: no app at $APP (set DS_APP_DIR) — run this on the box."; exit 2; }
for h in "$@"; do
  [[ "$h" =~ ^[A-Za-z0-9._]{1,30}$ ]] || { echo "-- STOPPED: '$h' is not an Instagram handle."; exit 2; }
done
command -v node >/dev/null 2>&1 || { echo "-- STOPPED: node is not installed here."; exit 2; }

cd "$APP"
node - "$@" <<'NODE'
'use strict'
const path = require('path')
require(path.join(process.cwd(), 'node_modules', 'dotenv')).config({ quiet: true })

const token = (process.env.META_GRAPH_TOKEN || '').trim()
const igUserId = (process.env.META_IG_USER_ID || '').trim()
const vRaw = (process.env.META_GRAPH_VERSION || '').trim()
const version = /^v\d+\.\d+$/.test(vRaw) ? vRaw : 'v25.0'
// For testing against a fake server only. The real host is the default.
const host = (process.env.DS_GRAPH_HOST || 'https://graph.facebook.com').replace(/\/+$/, '')

const handles = process.argv.slice(2).length
  ? process.argv.slice(2).map((h) => h.toLowerCase())
  : ['netflix_in', 'primevideoin', 'sonytvofficial', 'madaboutmarketingg', 'bollywoodsocietyy']

const say = (s) => console.log(s)
const mask = (s) => (token ? String(s).split(token).join('[token]') : String(s))

say(`-- graph-badge-probe.sh — read-only; Graph ${version}; token ${token ? 'set' : 'MISSING'}; IG user id ${igUserId ? 'set' : 'MISSING'}`)
if (!token || !igUserId) {
  say('-- STOPPED: META_GRAPH_TOKEN and META_IG_USER_ID must both be in the app\'s .env. Nothing was asked.')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(handle, fields) {
  const url =
    `${host}/${version}/${encodeURIComponent(igUserId)}` +
    `?fields=${encodeURIComponent(`business_discovery.username(${handle}){${fields}}`)}` +
    `&access_token=${encodeURIComponent(token)}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    return { ok: false, status: 0, why: `no answer: ${mask(e && e.message ? e.message : e)}` }
  }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (json && json.error) {
    const er = json.error
    return { ok: false, status: res.status, why: mask(`code ${er.code ?? '?'}${er.error_subcode ? '/' + er.error_subcode : ''}: ${er.message ?? 'no message'}`) }
  }
  const bd = json && json.business_discovery
  if (!res.ok || !bd || typeof bd !== 'object') {
    return { ok: false, status: res.status, why: mask(`HTTP ${res.status}, no business_discovery in the answer: ${text.slice(0, 200)}`) }
  }
  return { ok: true, status: res.status, bd }
}

;(async () => {
  let controlsOk = 0
  let reported = 0
  let fieldRefused = 0
  const seen = { true: 0, false: 0 }
  for (const h of handles) {
    say('')
    say(`@${h}`)
    const control = await ask(h, 'username,name,followers_count')
    if (control.ok) {
      controlsOk++
      say(`   control read: ok — name "${control.bd.name ?? ''}", ${control.bd.followers_count ?? '?'} followers`)
    } else {
      say(`   control read: FAILED — ${control.why}`)
      say('   (so the badge question cannot be asked about this handle)')
      await sleep(2000)
      continue
    }
    await sleep(2000)
    const withBadge = await ask(h, 'username,is_verified')
    if (withBadge.ok && typeof withBadge.bd.is_verified === 'boolean') {
      reported++
      seen[String(withBadge.bd.is_verified)]++
      say(`   is_verified:  ${withBadge.bd.is_verified}   <- Meta reports the blue tick`)
    } else if (withBadge.ok) {
      say(`   is_verified:  not in the answer (the read worked but carried no such field)`)
      fieldRefused++
    } else {
      say(`   is_verified:  REFUSED — ${withBadge.why}`)
      if (/is_verified/i.test(withBadge.why) || /nonexist/i.test(withBadge.why)) fieldRefused++
    }
    await sleep(2000)
  }

  say('')
  if (reported > 0) {
    say(`== ANSWER: YES — Meta's official read reports the blue tick (${reported} of ${handles.length} handles answered: ${seen.true} verified, ${seen.false} not).`)
    say('   New companies could be checked for the badge this way again. Building that is a separate change.')
    process.exit(0)
  }
  if (controlsOk > 0 && fieldRefused === controlsOk) {
    say('== ANSWER: NO — the control reads worked and every request for is_verified was refused or came back without it.')
    say('   The official read cannot replace the badge check.')
    process.exit(0)
  }
  say(`== COULD NOT TELL — ${controlsOk} of ${handles.length} control reads worked. Read the lines above: a failed control means the token or app, not the badge.`)
  process.exit(1)
})().catch((e) => {
  say(`-- STOPPED: ${mask(e && e.stack ? e.stack : e)}`)
  process.exit(1)
})
NODE
