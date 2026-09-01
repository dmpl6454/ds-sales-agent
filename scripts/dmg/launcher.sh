#!/bin/bash
# The .app's executable — what a click on the Dock icon does.
#
# ALREADY INSTALLED → open the dashboard. That is what a person clicking an app called
# "DS Sales Agent" is asking for (Tabish, 2026-09-01: "I need the application file visible
# on my dock — why is it not running with dashboard?"). The agent itself is a headless
# LaunchAgent with no window; the dashboard is where the data is. The dev Mac serves its
# own copy on :3100 and is preferred when it answers; every other Mac gets the hosted one.
#
# NOT YET INSTALLED → open Terminal running the interactive installer, exactly as before.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"

if [ -d "$HOME/ds-sales-agent" ] || [ -d "$HOME/Desktop/AI Sales Agent" ]; then
  if nc -z 127.0.0.1 3100 2>/dev/null; then
    open "http://localhost:3100"
  else
    open "https://e035e4d46c.digitalsukoon.com"
  fi
  exit 0
fi

osascript \
  -e 'tell application "Terminal" to activate' \
  -e "tell application \"Terminal\" to do script \"bash '$RES/install.sh'\""
