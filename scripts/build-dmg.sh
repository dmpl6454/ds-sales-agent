#!/bin/bash
#
# Build the distributable Mac app image — ~/Downloads/DS-Sales-Agent.dmg.
#
# ── RUN THIS AFTER ANY MAJOR CHANGE. THE DMG IS PART OF THE DELIVERABLE ──────
#
# The image snapshots the repo at build time (git archive HEAD), and installed
# machines do NOT auto-update — a stale DMG hands a new operator last week's rules.
# Same standing rule as the pipeline diagram: when the system changes, the copy
# people hold must change with it. One command, no arguments:
#
#     bash scripts/build-dmg.sh
#
# ── WHAT THE IMAGE CONTAINS, AND WHAT IT MUST NEVER CONTAIN ──────────────────
#
# READ ME FIRST.txt and DS Sales Agent.app (launcher + installer + a git-archive
# tarball of HEAD). git archive honours .gitignore, so .env and every credential
# stay out BY CONSTRUCTION — and this script verifies that anyway, because "by
# construction" has gone stale in this repo before. The three secrets a new
# operator needs (DATABASE_URL, the tunnel key at ~/Downloads/ds_tunnel_key, the
# shared dashboard login) are handed over person to person, never shipped.
#
# The app is UNSIGNED (no Apple Developer ID). On macOS 15+ Gatekeeper blocks a double-click
# outright (the right-click → Open bypass is gone), so the README leads with a Terminal
# one-liner that runs install.sh straight off the mounted image — an interpreter reading a
# file is not a Gatekeeper launch. Signing + notarising (Developer ID, notarytool) is the
# permanent fix and needs Tabish's Apple account.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DS_DMG_OUT:-$HOME/Downloads/DS-Sales-Agent.dmg}"
STAGE="$(mktemp -d /tmp/ds-dmg-stage.XXXXXX)"
APP="$STAGE/DS Sales Agent.app"
trap 'rm -rf "$STAGE"' EXIT

cd "$REPO"

# Refuse to snapshot a dirty tree: the archive is HEAD, and shipping while edits
# sit uncommitted means the DMG and the deploy silently differ.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: the working tree has uncommitted changes — commit (or stash) first, so the DMG matches HEAD." >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$REPO/scripts/dmg/Info.plist" "$APP/Contents/Info.plist"
cp "$REPO/scripts/dmg/launcher.sh" "$APP/Contents/MacOS/ds-sales-agent"
cp "$REPO/scripts/dmg/install.sh" "$APP/Contents/Resources/install.sh"
cp "$REPO/scripts/dmg/README.txt" "$STAGE/READ ME FIRST.txt"
chmod +x "$APP/Contents/MacOS/ds-sales-agent" "$APP/Contents/Resources/install.sh"

git archive --format=tar.gz -o "$APP/Contents/Resources/ds-sales-agent.tar.gz" HEAD

# The verification, not the construction: no secret may ride along.
if tar -tzf "$APP/Contents/Resources/ds-sales-agent.tar.gz" | grep -qE '(^|/)\.env$|ds_tunnel_key|\.pem$'; then
  echo "error: the archive contains a credential-shaped file — NOT building the image." >&2
  exit 1
fi

rm -f "$OUT"
hdiutil create -volname "DS Sales Agent" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null

echo "built:  $OUT  ($(du -h "$OUT" | cut -f1 | tr -d ' '))  from $(git rev-parse --short HEAD)"
echo "key:    ~/Downloads/ds_tunnel_key (send privately, per person)"
echo "login:  the shared viewer account + the DATABASE_URL from .env — hand over person to person"
