#!/bin/bash
#
# Make the standing watch survive a closed terminal, a crash, and a logout.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
#
# MEASURED 2026-08-08: no process was running, `schedulerHeartbeat` was 20 hours stale,
# and 108 posts arrived in a single burst the moment something was started again —
# catch-up-on-boot, not steady state. Nine of them were CAMPAIGN. The dashboard said
# nothing was wrong.
#
# The cost of that gap is bounded and unforgiving: @viralbhayani posts 49-75 a day
# (measured over 8 days, mean ~64) and the anonymous feed is 48 posts deep. So the window
# fills in about EIGHTEEN HOURS, and a post that scrolls out of it can never be
# re-scraped. The 20-hour outage was inside the margin by roughly an hour. More downtime
# means permanent, unrecoverable loss — not a delay.
#
# ── WHAT THIS DOES AND DOES NOT FIX ─────────────────────────────────────────
#
# launchd restarts the worker if it crashes, and starts it at login. That covers the
# failure that actually happened here: a process that was killed and never restarted.
#
# It does NOT wake a sleeping Mac, and it must not be described as if it does. A closed
# lid suspends the process; `KeepAlive` does not resume it early. The scheduler's own
# `execution:missed` handler recovers a slot slept through inside CATCHUP_WINDOW_MINUTES,
# which is why a short sleep is survivable and an overnight one is not.
#
# The real answer to "survives a closed laptop" is the server — see
# docs/specs/2026-08-08-hosted-product-plan.md. This is the stop-gap that protects the
# corpus while that is built, and saying otherwise would be the same
# "toggle promises behaviour with nothing behind it" failure this project keeps finding.

set -euo pipefail

LABEL="com.digitalsukoon.ds-sales-agent.watch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.ds-sales-agent-data/logs"

# WHICH PROCESS THIS MACHINE RUNS, and it is not always the same one.
#
#   worker        the standing watch — detects, plans, and dispatches. Correct when this
#                 machine owns the schedule, i.e. an all-in-one laptop install.
#   agent:device  SENDS ONLY. Correct once a server owns the schedule: the server detects
#                 and writes drafts, and this machine — which is where the Chrome profiles
#                 and Instagram sessions actually live — delivers them.
#
# Defaults to `agent:device` because that is the hosted shape, and because running a second
# scheduler against a shared database is the thing the heartbeat guard exists to refuse.
# Override with DS_WATCH_MODE=worker for a laptop-only install.
MODE="${DS_WATCH_MODE:-agent:device}"

# launchd runs with a minimal PATH that contains neither Homebrew nor pnpm. Resolving the
# real binary now, and failing loudly if it is missing, beats a plist that silently never
# runs — which is the same class of failure this script exists to fix.
PNPM="$(command -v pnpm || true)"
if [[ -z "$PNPM" ]]; then
  echo "error: pnpm is not on PATH. Install it, then re-run this script." >&2
  exit 1
fi
NODE_BIN="$(dirname "$(command -v node)")"

case "${1:-install}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${PNPM}</string>
    <string>${MODE}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO}</string>

  <!-- launchd's PATH omits Homebrew, so pnpm's own child processes (node, tsx) would
       not resolve. This is the single most common reason a working command fails
       under launchd and succeeds in a terminal. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it exits for any reason. The failure this fixes is a process that
       died and stayed dead for 20 hours with nothing on screen saying so. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Do not restart faster than this. A worker that cannot start (bad .env, damaged
       node_modules) would otherwise spin, and a tight relaunch loop against the
       Instagram feed endpoint is exactly the IP-level risk decision 4 accepts but does
       not invite. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/watch.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/watch.error.log</string>
</dict>
</plist>
PLIST_EOF

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"

    echo "installed: ${LABEL}"
    echo "  mode:  ${MODE}   (worker = owns the schedule; agent:device = sends only)"
    echo "  repo:  ${REPO}"
    echo "  logs:  ${LOG_DIR}/watch.log"
    echo
    echo "Verify it is actually running (a loaded plist is not a running process):"
    echo "  bash scripts/install-watch.sh status"
    ;;

  uninstall)
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed: ${LABEL}"
    ;;

  status)
    # `launchctl list` proves it is REGISTERED. It does not prove the scheduler is
    # beating — the same "freshness is not liveness" distinction the heartbeat itself
    # is built around. Both are printed, and they are different questions.
    if launchctl list | grep -q "$LABEL"; then
      echo "launchd:   registered"
      launchctl list | grep "$LABEL" | awk '{print "  pid=" $1 "  last exit=" $2}'
    else
      echo "launchd:   NOT registered — run: bash scripts/install-watch.sh install"
    fi
    # A registered plist is not a beating scheduler — the same "freshness is not
    # liveness" distinction the heartbeat itself is built around, one level up. Both
    # questions are asked, and they are answered separately.
    echo -n "heartbeat: "
    ( cd "$REPO" && "$PNPM" -s worker:heartbeat 2>/dev/null ) \
      || echo "could not read (is the database reachable?)"
    ;;

  *)
    echo "usage: bash scripts/install-watch.sh [install|uninstall|status]" >&2
    exit 1
    ;;
esac
