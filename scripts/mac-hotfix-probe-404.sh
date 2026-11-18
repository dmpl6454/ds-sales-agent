#!/usr/bin/env bash
# THE MAC PARKS EVERY MESSAGE AS "PAGE GONE" WITHOUT OPENING A BROWSER — a one-line fix you run
# ON THE SENDING MAC (the Mac Studio), not on the server.
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<sha>/scripts/mac-hotfix-probe-404.sh -o /tmp/ds-hotfix.sh && bash /tmp/ds-hotfix.sh
#
#   bash /tmp/ds-hotfix.sh --check     only report: is the fix in, is the agent running, is Chrome busy
#   bash /tmp/ds-hotfix.sh --undo      put the original file back and restart the agent
#
# THE RESTART NEEDS AUTOPILOT OFF (since 18 Nov, after review): switch Autopilot OFF on the dashboard, wait a minute,
# run with DS_AUTOPILOT_OFF=1 in front (for example  DS_AUTOPILOT_OFF=1 bash /tmp/ds-hotfix.sh --undo), and switch it
# back ON after DONE. Without it the script changes the file and stops before the restart, saying so (exit 5). Never
# with sudo: the agent's job belongs to the logged-in user.
#
# Exit: 0 done · 1 refused, nothing changed · 2 bad option, or run with sudo · 3 Chrome stayed busy (file changed, not
# restarted — run again) · 4 no agent job, or the restart failed · 5 Autopilot not confirmed OFF (file changed, not
# restarted — run again as above).
#
# WHAT WENT WRONG (measured 18 Nov 2026). Before every send the agent's 10 Sept build asks Instagram,
# with no login, whether the recipient's page still exists (src/detection/exists.ts, added 9 Sept so
# a deleted page costs no browser drive). A 404 is read as "the page is gone": the draft is parked
# FAILED `profile-gone` with no browser opened, and the recipient is refused for a week. Instagram
# now answers that anonymous lookup with 404 for REAL pages — 40 of 40 introductions to verified
# companies (@ndtv, @chumbak, …) were parked within minutes of being written, nothing driven. A dead
# or walled endpoint is being read as a verdict about the recipient, so this Mac can deliver nothing.
#
# WHAT THIS CHANGES: ONE LINE in ~/ds-sales-agent/src/detection/exists.ts —
#     if (status === 404) return 'missing'     becomes     if (status === 404) return 'unknown'
# `unknown` is what the lookup already returns for a throttle or a network blip, and the send path
# treats it as "go on and look": the browser drive itself recognises a page that is really gone
# ("Sorry, this page isn't available" → parked `profile-gone` after ONE look, sendDm.ts in the same
# build). So a deleted page costs one profile visit instead of none, and a real page is no longer
# refused. Nothing else in the file, the build, .env, the Chrome profiles or the database is touched.
#
# THEN IT RESTARTS THE AGENT, because the agent loaded the old file when it started. It restarts
# ONLY while no agent Chrome window is open (it asks the OS for a Chrome process using a profile
# under ~/.ds-sales-agent/chrome-profiles — the same test the cache pruner uses), waiting up to ten
# minutes, so a send or a conversation read is never cut off half-way. If Chrome stays busy the file
# is still fixed and the script says so: run it again and it only does the restart. The Chrome check
# alone cannot see a send's first seconds (the draft is claimed and the lookup asked BEFORE Chrome
# opens), which is why the restart also needs Autopilot off.
#
# It is a FILE run by bash, never a block pasted into zsh (see scripts/check-sending.sh for why).
# It reads no secret and prints none: .env is never opened. The original file is kept at
# ~/.ds-sales-agent-data/hotfix-backups/ so --undo restores it byte for byte.
#
# AFTER IT SAYS "DONE": the 40 parked introductions are still parked. Return them to the queue from
# the SERVER's console with the command you were given (one first, as a test, then the rest).
set -u

APP="${DS_APP_DIR:-$HOME/ds-sales-agent}"
DATA="${DS_DATA_DIR:-$HOME/.ds-sales-agent-data}"
PROFILES="${DS_PROFILE_DIR:-$HOME/.ds-sales-agent/chrome-profiles}"
LABEL="${DS_WATCH_LABEL:-com.digitalsukoon.ds-sales-agent.watch}"
WAIT_SECONDS="${DS_WAIT_SECONDS:-600}"
SETTLE_SECONDS="${DS_SETTLE_SECONDS:-6}"
FILE="$APP/src/detection/exists.ts"
BACKUP_DIR="$DATA/hotfix-backups"
BACKUP="$BACKUP_DIR/exists.ts.before-hotfix-probe-404"
MARK="$DATA/hotfix-probe-404.applied"
# The 10 Sept build's file (commit fb1e843 in the repo; the box calls that build 57faf88).
KNOWN_SHA="54ba7085ddfa1ab51ab1d09a972b1e315a337ed2e93c002cfd83f7ab32885a29"
OLD_LINE="  if (status === 404) return 'missing'"
NEW_PREFIX="  if (status === 404) return 'unknown'"
NEW_LINE="$NEW_PREFIX // HOTFIX 18 Nov 2026: Instagram's anonymous lookup answers 404 for real pages; the browser drive recognises a page that is really gone"
MODE="${1:-apply}"
MODE_ARG="${1:-}"

say() { printf '%s\n' "$*"; }
stop() { say ""; say "STOPPED: $*"; exit "${2:-1}"; }

case "$MODE" in apply|--check|--undo) ;; *) stop "unknown option '$MODE' — use no option, --check or --undo" 2 ;; esac
case "$WAIT_SECONDS" in ''|*[!0-9]*) stop "DS_WAIT_SECONDS must be a whole number of seconds, got: $WAIT_SECONDS" 2 ;; esac
case "$SETTLE_SECONDS" in ''|*[!0-9]*) stop "DS_SETTLE_SECONDS must be a whole number of seconds, got: $SETTLE_SECONDS" 2 ;; esac

sha_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "no-sha-tool"; fi
}
count_exact() { grep -cxF -- "$1" "$FILE" 2>/dev/null || true; }
count_prefix() { awk -v p="$1" 'index($0, p) == 1 { n++ } END { print n + 0 }' "$FILE" 2>/dev/null; }

# Agent Chrome windows open right now: a process whose command line carries `--user-data-dir=`
# AND a path under the agent's own profile directory. `ps` is asked, never a lock file (a lock
# survives a crash). Two filters rather than one string, so a quoted path still counts and neither
# grep can match itself: each grep's own command line holds only one of the two strings.
chrome_busy() {
  ps axww -o command 2>/dev/null | grep -F -- "--user-data-dir=" | grep -F -- "$PROFILES/" | wc -l | tr -d ' '
}
agent_line() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^[[:space:]]*(state|pid) = / { sub(/^[[:space:]]*/, ""); printf "%s  ", $0 } END { print "" }'
}
job_exists() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

file_state() {
  # prints one of: original | fixed | other
  local n_old n_new
  n_old="$(count_exact "$OLD_LINE")"; n_new="$(count_prefix "$NEW_PREFIX")"
  if [ "$n_old" = "1" ] && [ "$n_new" = "0" ]; then echo original
  elif [ "$n_old" = "0" ] && [ "$n_new" = "1" ]; then echo fixed
  else echo other; fi
}

# Wait for no agent Chrome, then restart at once. Returns 0 restarted, 3 Chrome stayed busy, 4 no job.
restart_agent() {
  # AUTOPILOT OFF FIRST (review, 18 Nov). The Chrome check below cannot see a send in its first seconds: the 10 Sept
  # build claims the draft (READY->SENDING), takes its reservations and asks the page lookup (up to 12 s) BEFORE it
  # opens Chrome. A restart in that gap leaves the row SENDING, and the restarted agent parks it as "may have been
  # delivered" (not-in-thread) — a message never sent, blocking that route until a person settles it, and counted by
  # the fleet's circuit breaker. With Autopilot off that build claims nothing new (it re-reads the switch just before
  # the claim) and its reply sweep stops too, so after a minute nothing is in flight.
  if [ "${DS_AUTOPILOT_OFF:-}" != "1" ]; then
    say "   NOT restarted yet: Autopilot must be switched OFF first, so that no message is half-way through being sent."
    say "     1. On the dashboard, switch Autopilot OFF and wait one minute."
    say "     2. Then run:   DS_AUTOPILOT_OFF=1 bash $0${MODE_ARG:+ $MODE_ARG}"
    say "     3. When it says DONE, switch Autopilot back ON."
    return 5
  fi
  if ! job_exists; then
    say "   The agent's background job ($LABEL) is not registered for this user, so there is nothing to restart."
    say "   Start it from the app folder:  cd \"$APP\" && bash scripts/install-watch.sh install"
    return 4
  fi
  local waited=0 busy
  busy="$(chrome_busy)"
  if [ "$busy" != "0" ]; then say "   An agent Chrome window is open ($busy process(es)) — waiting for it to close before restarting (up to $WAIT_SECONDS s)…"; fi
  while [ "$busy" != "0" ]; do
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      say "   Chrome is still open after $waited s. The agent was NOT restarted, so nothing was interrupted."
      return 3
    fi
    sleep 5; waited=$((waited + 5)); busy="$(chrome_busy)"
  done
  # A second reading a few seconds later, in the same breath as the restart: Chrome closes and
  # reopens between two conversations of one reply sweep, and one idle reading can land in that gap.
  sleep "$SETTLE_SECONDS"
  if [ "$(chrome_busy)" != "0" ]; then say "   Chrome opened again while checking — not restarting, nothing was interrupted. Run this again."; return 3; fi
  if ! launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    say "   launchctl could not restart $LABEL. Restart it by hand:  launchctl kickstart -k gui/$(id -u)/$LABEL"
    return 4
  fi
  sleep 6
  say "   agent restarted: $(agent_line)"
  return 0
}

say "-- mac-hotfix-probe-404.sh ($MODE) — the anonymous 'does this page exist' lookup, 18 Nov 2026"
if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" = "0" ]; then
  stop "run this WITHOUT sudo, as the Mac user the agent runs as — its background job and its files belong to that user. Nothing was changed." 2
fi
[ -d "$APP" ] || stop "$APP not found. This runs on the Mac that sends (the one with the agent installed), not on the server."
[ -f "$FILE" ] || stop "$FILE not found — this install has no anonymous lookup to fix."
say "   install: $APP   build: $(cat "$APP/.version" 2>/dev/null || echo 'no .version file')"

STATE="$(file_state)"
SHA="$(sha_of "$FILE")"
case "$STATE" in
  original) if [ "$SHA" = "$KNOWN_SHA" ]; then say "   exists.ts: the 10 Sept build's file, unchanged (fix not applied yet)"
            else say "   exists.ts: has the line this fix changes, but is not byte-identical to the 10 Sept build's file — only that one line will be changed"; fi ;;
  fixed)    say "   exists.ts: the fix is already in the file" ;;
  other)    say "   exists.ts: NOT the file this fix was written for. Lines that mention 404:"
            grep -n '404' "$FILE" | sed 's/^/      /' ;;
esac
say "   agent job: $(job_exists && agent_line || echo 'not registered for this user')"
say "   agent Chrome windows open now: $(chrome_busy)"
[ -f "$MARK" ] && say "   fix recorded as applied and restarted: $(cat "$MARK" 2>/dev/null)"
# The fault in the agent's own words (src/outreach/deliver.ts logs it as a warning, and launchd sends
# warnings to watch.error.log). Reported, never required: disk care rotates these logs.
EVIDENCE=0
for f in "$DATA/logs/watch.error.log" "$DATA/logs/watch.log"; do
  if [ -f "$f" ]; then n="$(grep -c 'parked without a browser drive' "$f" 2>/dev/null || true)"; EVIDENCE=$((EVIDENCE + ${n:-0})); fi
done
if [ "$EVIDENCE" -gt 0 ]; then say "   the agent's log shows $EVIDENCE message(s) parked as 'page is gone' with no browser opened — the fault this fixes"
else say "   the agent's log here shows no message parked as 'page is gone' (the log may have been rotated). The fix is harmless either way; tell whoever sent you this script."; fi

if [ "$MODE" = "--check" ]; then say "-- check only; nothing was changed"; exit 0; fi

if [ "$MODE" = "--undo" ]; then
  if [ "$STATE" = "original" ] && [ -f "$BACKUP" ] && cmp -s "$BACKUP" "$FILE"; then
    # A previous --undo restored the file and its restart was refused (review, 18 Nov): only the restart is left.
    say "   the original file is already back; only the restart is left"
  else
    [ "$STATE" = "fixed" ] || stop "the fix is not in the file, so there is nothing to undo."
    [ -f "$BACKUP" ] || stop "no backup at $BACKUP — not guessing what the original was. Nothing was changed."
    [ "$(grep -cxF -- "$OLD_LINE" "$BACKUP" 2>/dev/null || true)" = "1" ] || stop "the backup does not look like the original file. Nothing was changed."
    # The backup must be THIS file with the one line put back. If the install was updated since the fix (a newer
    # build carries the same line), restoring an older backup would silently replace the newer file (review, 18 Nov).
    [ "$(diff "$BACKUP" "$FILE" | grep -c '^[<>]' || true)" = "2" ] || stop "the backup at $BACKUP is from an older install, not this file with one line changed. Not restoring it. Nothing was changed."
    cp "$BACKUP" "$FILE.hotfix.tmp" && mv -f "$FILE.hotfix.tmp" "$FILE" || stop "could not write $FILE. Nothing else was changed."
    rm -f "$MARK"
    say "   original file restored (sha256 $(sha_of "$FILE"))"
  fi
  restart_agent; rc=$?
  [ "$rc" = "0" ] && { say "-- DONE: the original lookup is back and the agent is running on it."; exit 0; }
  say "-- The file is restored but the agent still runs the FIXED copy until it restarts. Run:  bash $0 --undo   again."
  exit "$rc"
fi

# ---- apply ----
if [ "$STATE" = "other" ]; then stop "nothing was changed. Send the lines printed above to whoever gave you this script."; fi

if [ "$STATE" = "original" ]; then
  mkdir -p "$BACKUP_DIR" || stop "could not create $BACKUP_DIR. Nothing was changed."
  if [ ! -f "$BACKUP" ]; then cp -p "$FILE" "$BACKUP" || stop "could not back the file up. Nothing was changed."; fi
  awk -v old="$OLD_LINE" -v new="$NEW_LINE" '$0 == old { print new; next } { print }' "$FILE" > "$FILE.hotfix.tmp" || { rm -f "$FILE.hotfix.tmp"; stop "could not write the fixed copy. Nothing was changed."; }
  # The fixed copy must differ from the original in exactly that one line, or it is not installed.
  changed="$(diff "$FILE" "$FILE.hotfix.tmp" | grep -c '^[<>]' || true)"
  lines_before="$(wc -l < "$FILE" | tr -d ' ')"; lines_after="$(wc -l < "$FILE.hotfix.tmp" | tr -d ' ')"
  if [ "$changed" != "2" ] || [ "$lines_before" != "$lines_after" ] || [ "$(grep -cxF -- "$NEW_LINE" "$FILE.hotfix.tmp" || true)" != "1" ]; then
    rm -f "$FILE.hotfix.tmp"; stop "the fixed copy did not come out as exactly one changed line. Nothing was changed."
  fi
  mv -f "$FILE.hotfix.tmp" "$FILE" || { rm -f "$FILE.hotfix.tmp"; stop "could not install the fixed copy. Nothing was changed."; }
  say "   fixed: one line changed in exists.ts (original kept at $BACKUP)"
elif [ -f "$MARK" ]; then
  say "-- DONE already: the fix is in and the agent was restarted on it. Nothing to do."
  exit 0
fi

restart_agent; rc=$?
if [ "$rc" != "0" ]; then
  say "-- The file is fixed, but the agent still runs the OLD copy until it restarts. Run this script again to restart it."
  exit "$rc"
fi
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$MARK" 2>/dev/null || true
if [ -f "$DATA/logs/watch.log" ]; then
  say "   last lines of the agent's log:"
  tail -n 4 "$DATA/logs/watch.log" 2>/dev/null | cut -c1-200 | sed 's/^/      /'
fi
say "-- DONE: the fix is in and the agent is running on it. Now return the parked introductions to the queue from the SERVER's console (one first, as a test)."
exit 0
