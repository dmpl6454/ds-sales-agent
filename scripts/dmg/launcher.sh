#!/bin/bash
# The .app's behaviour — run by the compiled stub in Contents/MacOS (see launcher.c).
#
# FIRST LAUNCH: run the installer in GUI mode, detached, and get out of the way. The person
# sees dialogs and notifications, never a Terminal window; the log is in ~/Library/Logs.
# EVERY LATER LAUNCH: an install exists, so the icon is a dashboard shortcut.
RES="$(cd "$(dirname "$0")" && pwd)"

if [ -d "$HOME/ds-sales-agent" ] || [ -d "$HOME/Desktop/AI Sales Agent" ]; then
  if nc -z 127.0.0.1 3100 2>/dev/null; then
    open "http://localhost:3100"
  else
    open "https://e035e4d46c.digitalsukoon.com"
  fi
  exit 0
fi

osascript -e 'display notification "Setting up this Mac — a dialog will appear in a moment." with title "DS Sales Agent"' >/dev/null 2>&1 || true
nohup bash "$RES/install.sh" --gui >/dev/null 2>&1 &
exit 0
