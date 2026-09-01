#!/bin/bash
# The .app's executable: opens Terminal running the installer — setup is interactive
# (two credentials are pasted). Ships as Contents/MacOS/ds-sales-agent.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
osascript \
  -e 'tell application "Terminal" to activate' \
  -e "tell application \"Terminal\" to do script \"bash '$RES/install.sh'\""
