#!/bin/bash
#
# Keep the SSH tunnel to the server's Postgres up, and bring it back when it drops.
#
# ── WHY A TUNNEL AND NOT AN OPEN PORT ───────────────────────────────────────
#
# Postgres 5432 on the Linode is bound to localhost and firewalled, and must stay that
# way. The database holds every prospect, every drafted message and every send record;
# exposing it to the internet to save a config step would be the same trade CLAUDE.md
# already refuses for the dashboard itself — *tunnel, never rebind*.
#
# ── WHY THIS NEEDS TO BE AUTOMATIC ──────────────────────────────────────────
#
# The device agent reads and writes through this tunnel. If it is down, the agent cannot
# claim work and cannot report presence — and the dashboard would then say a device is
# offline, which is TRUE but for the wrong reason, and the operator would go looking at
# the wrong thing.
#
# This is also the exact shape of the failure that started the 2026-08-08 session: a
# process nobody restarted, silently absent for 20 hours. A hand-started `ssh -f -N`
# survives until the next reboot, network change or laptop sleep, and then does not.
#
# `-o ExitOnForwardFailure=yes` matters: without it, ssh happily connects while the port
# forward silently fails (because something else holds the local port), leaving a tunnel
# that looks alive and forwards nothing. That is the "freshness is not liveness" trap in
# network clothing.

set -euo pipefail

LABEL="com.digitalsukoon.ds-sales-agent.tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.ds-sales-agent-data/logs"

LOCAL_PORT="${DS_TUNNEL_PORT:-15432}"
REMOTE_HOST="${DS_TUNNEL_HOST:-linode}"

SSH="$(command -v ssh)"

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
    <string>${SSH}</string>
    <string>-N</string>
    <!-- Fail loudly if the local port cannot be bound, rather than connecting and
         forwarding nothing. -->
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <!-- Notice a dead link in ~90s instead of hanging on a half-open socket. -->
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-L</string><string>${LOCAL_PORT}:localhost:5432</string>
    <string>${REMOTE_HOST}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Do not reconnect faster than this. A laptop that wakes without a network would
       otherwise spin, and repeated failed SSH attempts against one host look exactly
       like something worth blocking. -->
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/tunnel.error.log</string>
</dict>
</plist>
PLIST_EOF

    # Any hand-started tunnel would hold the port and make ExitOnForwardFailure abort.
    pkill -f "ssh -f -N -L ${LOCAL_PORT}:localhost:5432" 2>/dev/null || true

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"

    echo "installed: ${LABEL}"
    echo "  ${LOCAL_PORT} -> ${REMOTE_HOST}:5432"
    echo "  logs: ${LOG_DIR}/tunnel.log"
    ;;

  uninstall)
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed: ${LABEL}"
    ;;

  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "launchd:  registered"
    else
      echo "launchd:  NOT registered"
    fi
    # Registered is not connected — ask whether the port actually answers, which is a
    # different question and the one that matters.
    if nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null; then
      echo "port ${LOCAL_PORT}: open (the database is reachable)"
    else
      echo "port ${LOCAL_PORT}: CLOSED — the device cannot reach the database"
      tail -3 "${LOG_DIR}/tunnel.error.log" 2>/dev/null | sed 's/^/  /'
    fi
    ;;

  *)
    echo "usage: bash scripts/install-tunnel.sh [install|uninstall|status]" >&2
    exit 1
    ;;
esac
