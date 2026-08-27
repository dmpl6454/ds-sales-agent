#!/bin/bash
#
# Keep the LOCAL dashboard on http://127.0.0.1:3100 up, and bring it back when it dies.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# "The localhost has stopped working" (Tabish, 2026-08-27) was nothing more than this:
# `pnpm local` runs in whichever terminal somebody started it in, and dies with that
# terminal, with a reboot, or with a crash — while the tunnel and the device agent both
# have launchd jobs that survive all three. The dashboard was the one leg of the local
# stack with no supervisor, so "localhost is down" was a state the machine could reach
# silently and stay in forever. Same class as the 2026-08-08 finding: a process nobody
# restarted, absent for hours, with nothing on screen saying so.
#
# ── WHAT IT RUNS, AND WHY PRODUCTION AND NOT DEV ─────────────────────────────
#
# `next start` on the committed build, NOT `next dev`. A dev server recompiles on demand,
# leaks memory over days, and is the thing that once starved the server's Postgres slots.
# `pnpm local` stays the "I want to poke at code changes" path; this job is the always-on
# viewer. After a deploy/rebuild, refresh it with:
#
#     pnpm build && bash scripts/install-dashboard.sh restart
#
# Three environment choices are load-bearing:
#
#   EMBEDDED_SCHEDULER=false   a viewer must never become a second detector — the Linode
#                              owns the schedule (the lesson recorded in scripts/local.sh:
#                              the "frozen" snapshot grew because a viewer detected into it)
#   DS_QUERY_COUNT=1           so `pnpm ig:layout` can always be pointed at this server;
#                              the layout harness FAILS rather than skips when counting is
#                              off, and a server you cannot measure is a server nobody
#                              measures
#   client-mismatch REFUSES    a failed `pnpm test` leaves the generated client on SQLite,
#                              and a dashboard restarting onto it is the device agent's
#                              documented crash-loop one process over. The runner CHECKS
#                              and waits rather than regenerating: `prisma generate` spawns
#                              engine binaries that are their own TCC clients under launchd
#
# ── THE PORT IS WAITED FOR, NEVER FOUGHT OVER ────────────────────────────────
#
# If something already holds :3100 (a hand-run `pnpm local`, an old `pnpm start`), the
# wrapper WAITS and re-checks instead of crashing: a KeepAlive job that exits on a busy
# port would relaunch every ThrottleInterval and steal the port back the moment a person
# stopped their own dashboard to run a dev one — a supervisor that fights the operator
# for a port is worse than no supervisor. When the port frees up, this serves it.

set -euo pipefail

LABEL="com.digitalsukoon.ds-sales-agent.dashboard"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.ds-sales-agent-data/logs"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=3100

PNPM="$(command -v pnpm || true)"
if [[ -z "$PNPM" ]]; then
  echo "error: pnpm is not on PATH. Install it, then re-run this script." >&2
  exit 1
fi
NODE_BIN="$(dirname "$(command -v node)")"

case "${1:-install}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

    if [[ ! -f "$REPO/.next/BUILD_ID" ]]; then
      echo "error: there is no production build at .next/ — run 'pnpm build' first." >&2
      echo "       (a supervisor pointed at a missing build would crash-loop, visibly" >&2
      echo "        in launchctl and invisibly to the person waiting for the page)" >&2
      exit 1
    fi

    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <!-- The exact binary chain the WATCH job has exercised for weeks — caffeinate, pnpm,
       node — because macOS TCC treats every binary a launchd job spawns as its own
       privacy client, and on this Mac only that chain holds a Desktop-folder grant.
       A job that reached the repo through /bin/bash was refused outright ("Operation
       not permitted", exit 126), MEASURED on install day in both the bash-first and
       caffeinate-first arrangements — which is why the runner is scripts/runDashboard.ts
       (node) and not a shell script. The caffeinate assertion itself is redundant
       beside the watch job's; the chain, not the assertion, is what is being copied. -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>${PNPM}</string>
    <string>dashboard:serve</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO}</string>

  <!-- launchd's PATH omits Homebrew, so pnpm's child processes (node, next) would not
       resolve. The single most common reason a working command fails under launchd. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN}:$(dirname "$PNPM"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>EMBEDDED_SCHEDULER</key>
    <string>false</string>
    <key>DS_QUERY_COUNT</key>
    <string>1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/dashboard.error.log</string>
</dict>
</plist>
PLIST_EOF

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"

    echo "installed: ${LABEL}"
    echo "  serves: http://127.0.0.1:${PORT}   (production build, live server data)"
    echo "  logs:   ${LOG_DIR}/dashboard.log"
    echo "  after a rebuild:  pnpm build && bash scripts/install-dashboard.sh restart"
    ;;

  restart)
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
    echo "restarted: ${LABEL}"
    ;;

  status)
    if launchctl list "${LABEL}" >/dev/null 2>&1; then
      echo "launchd job: loaded"
    else
      echo "launchd job: NOT loaded — run: bash scripts/install-dashboard.sh install"
    fi
    # The question that matters is whether the PORT answers, not whether launchd has the
    # label — same distinction install-tunnel.sh draws.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/sign-in" || true)"
    if [[ "$code" == "200" ]]; then
      echo "dashboard:   answering on :${PORT}"
    else
      echo "dashboard:   NOT answering on :${PORT} (got '${code}') — check ${LOG_DIR}/dashboard.error.log:"
      tail -3 "${LOG_DIR}/dashboard.error.log" 2>/dev/null | sed 's/^/  /'
    fi
    ;;

  uninstall)
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed: ${LABEL}"
    ;;

  *)
    echo "usage: bash scripts/install-dashboard.sh [install|restart|status|uninstall]" >&2
    exit 1
    ;;
esac
