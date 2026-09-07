#!/bin/bash
# The .app's behaviour — run by the compiled stub in Contents/MacOS (see launcher.c).
#
# FIRST LAUNCH, OR AN INSTALL THAT NEVER FINISHED: run the installer in GUI mode, detached, and
# get out of the way. The person sees dialogs and notifications, never a Terminal window; the
# log is in ~/Library/Logs/ds-sales-agent-install.log.
#
# EVERY LATER LAUNCH, ONCE SETUP ACTUALLY COMPLETED: the icon is a dashboard shortcut.
#
# ── WHY THIS ASKS FOR A SENTINEL AND NOT FOR A DIRECTORY (2026-09-07) ─────────
#
# This used to be `[ -d "$HOME/ds-sales-agent" ]`, and `install.sh` creates that directory at
# its step 2 — before the private runtime, the tunnel, the pairing and the agent. So any
# failure after the unpack left the directory behind, and from then on **every double-click
# opened a web page and the installer never ran again.** Handing the person a newer DMG changed
# nothing, because the check is about their disk rather than about the image.
#
# MEASURED after a second operator installed twice: exactly ONE enrolment request had ever
# reached the server (our own probe), and no new dashboard session since 1 September. Their Mac
# had quietly stopped being able to try.
#
# `setup-complete` is written by the LAST line of the installer, so it means setup finished
# rather than setup started. Same correction as 1 September's aborted first run, one layer up:
# a completion sentinel, never file existence.
RES="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_URL="https://e035e4d46c.digitalsukoon.com"
SENTINEL="$HOME/.ds-sales-agent-data/setup-complete"

# ── A PORT PROBE PROVES A LISTENER, NOT THE RIGHT APP (2026-09-07) ───────────
#
# This used to open http://localhost:3100 whenever ANYTHING answered on that port. Port 3100 is
# not exotic — this project itself moved off 3000 precisely because another app on this machine
# had taken it — so on a Mac where something else is listening, the icon opened a stranger's app
# and the person reported that they "could not sign in on the dashboard". A local dashboard is a
# convenience for the maintainer; the hosted URL is the one that is always right.
#
# So the probe asks for OUR page and checks it is ours, and anything else falls through to the
# hosted dashboard. Same lesson as the tunnel's `nc -z` check, which passed while every real
# query died: a port that answers is not the service you wanted.
open_dashboard() {
  if curl -fsS -m 2 "http://127.0.0.1:3100/sign-in" 2>/dev/null | grep -q "<title>Instagram Outreach</title>"; then
    open "http://localhost:3100"
  else
    open "$DASHBOARD_URL"
  fi
}

# A DEVELOPMENT CHECKOUT IS NOT AN INSTALL, and must never be installed over. This is the repo
# on the maintainer's own Mac, where the .app has always been a shortcut and nothing else.
if [ -d "$HOME/Desktop/AI Sales Agent" ]; then
  open_dashboard
  exit 0
fi

if [ -f "$SENTINEL" ]; then
  open_dashboard
  exit 0
fi

# No sentinel. Either this Mac has never been set up, or a previous attempt stopped partway —
# and the difference matters to the person watching, so say which. The installer is idempotent:
# it re-unpacks the code, keeps an existing .env and tunnel key, and pairs again if needed.
if [ -d "$HOME/ds-sales-agent" ]; then
  MSG="The last setup did not finish. Picking up where it stopped — a dialog will appear in a moment."
else
  MSG="Setting up this Mac — a dialog will appear in a moment."
fi
osascript -e "display notification \"$MSG\" with title \"DS Sales Agent\"" >/dev/null 2>&1 || true
nohup bash "$RES/install.sh" --gui >/dev/null 2>&1 &
exit 0
