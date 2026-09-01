#!/bin/bash
#
# DS Sales Agent — one-time setup for a new Mac. Ships inside the DMG that
# `bash scripts/build-dmg.sh` produces; edit it HERE, never in a mounted image.
#
# What this installs, and nothing more:
#   ~/ds-sales-agent                      the agent's code
#   ~/.ssh/ds_tunnel_key + a Host entry   a forward-only tunnel to the shared database
#   two LaunchAgents                      the tunnel and the device agent, kept alive 24/7
#
# The disk image carries NO credentials. The two secrets — the database URL and the
# tunnel key file — come from Tabish, person to person, together with the shared
# dashboard login. Detection, targets and paid posts all run centrally; this machine
# only sends from the Instagram accounts YOU connect on it, from your own home IP.
#
set -euo pipefail

RES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/ds-sales-agent"
DASHBOARD_URL="https://e035e4d46c.digitalsukoon.com"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold "== DS Sales Agent setup =="

# ── 0. Google Chrome — the sender drives a real Chrome profile, no substitute ──
if [ ! -d "/Applications/Google Chrome.app" ]; then
  echo "Google Chrome is required. Install it from https://www.google.com/chrome/ and run this again."
  exit 1
fi

# ── 1. Node 20+ (a private runtime is installed if the Mac has none) ──────────
if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)')" -ge 20 ]; then
  echo "node $(node -v) found"
else
  bold "Installing a private Node runtime (this machine's system stays untouched)…"
  ARCH="$(uname -m)"; case "$ARCH" in arm64) A=arm64 ;; *) A=x64 ;; esac
  NODE_V="v22.14.0"
  mkdir -p "$HOME/.ds-sales-agent-runtime"
  curl -fsSL "https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-darwin-${A}.tar.gz" \
    | tar -xz -C "$HOME/.ds-sales-agent-runtime" --strip-components=1
  export PATH="$HOME/.ds-sales-agent-runtime/bin:$PATH"
  # The launchd installers resolve node/pnpm from PATH at install time and bake the
  # absolute paths into the plists, so exporting here is enough for 24/7 operation.
fi
if ! command -v pnpm >/dev/null 2>&1; then
  bold "Installing pnpm…"
  npm install -g pnpm >/dev/null
fi
echo "pnpm $(pnpm -v) found"

# ── 2. The code ────────────────────────────────────────────────────────────────
mkdir -p "$DEST"
tar -xzf "$RES/ds-sales-agent.tar.gz" -C "$DEST"
echo "code unpacked to $DEST"

# ── 3. Credentials — from Tabish, never from this disk image ──────────────────
if [ ! -f "$DEST/.env" ]; then
  cp "$DEST/.env.example" "$DEST/.env"
  echo
  bold "Paste the DATABASE_URL Tabish gave you, then press Enter:"
  read -r DBURL
  case "$DBURL" in postgresql://*127.0.0.1:15432*) ;; *)
    echo "That does not look like the expected postgresql://…@127.0.0.1:15432/… URL. Stopping so nothing half-configured is left behind."; exit 1 ;;
  esac
  bold "A short name for this machine (it shows on the dashboard), e.g. your first name:"
  read -r DEV
  {
    echo ""
    echo "# ── written by the DS Sales Agent installer ──"
    echo "DATABASE_URL=\"$DBURL\""
    echo "SEND_ENABLED=true"
    echo "AUTOPILOT_ENABLED=true"
    echo "DRY_RUN=0"
    echo "MAX_TOTAL_SENDS=unlimited"
    echo "DS_DEVICE_NAME=$DEV"
    echo "OPERATOR_NAME=$DEV"
  } >> "$DEST/.env"
  echo ".env written (this file stays on this machine only)"
else
  echo ".env already present — keeping it"
fi

KEY="$HOME/.ssh/ds_tunnel_key"
if [ ! -f "$KEY" ]; then
  echo
  bold "Drag the tunnel key file Tabish sent you into this window, then press Enter:"
  read -r KEYSRC
  KEYSRC="$(printf '%s' "$KEYSRC" | sed "s/^[[:space:]']*//; s/[[:space:]']*$//")"
  [ -f "$KEYSRC" ] || { echo "No file at: $KEYSRC"; exit 1; }
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  cp "$KEYSRC" "$KEY"; chmod 600 "$KEY"
fi
if ! grep -q "^Host ds-linode$" "$HOME/.ssh/config" 2>/dev/null; then
  {
    echo ""
    echo "Host ds-linode"
    echo "  HostName 172.105.53.101"
    echo "  User root"
    echo "  IdentityFile $KEY"
    echo "  IdentitiesOnly yes"
    echo "  StrictHostKeyChecking accept-new"
  } >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
fi
echo "tunnel key installed (it can ONLY forward to the database port — no shell, no files)"

# ── 4. Dependencies + the Postgres client ──────────────────────────────────────
bold "Installing dependencies (a few minutes on first run)…"
cd "$DEST"
pnpm install
bash scripts/prisma-client-for-env.sh

# ── 5. The two LaunchAgents: tunnel first, then the device agent ──────────────
DS_TUNNEL_HOST=ds-linode bash scripts/install-tunnel.sh install
sleep 3
if ! nc -z 127.0.0.1 15432 2>/dev/null; then
  echo "The tunnel did not come up — check the key file and network, then re-run this installer."
  exit 1
fi
echo "tunnel is up (127.0.0.1:15432 → the shared database)"
bash scripts/install-watch.sh install

echo
bold "== Done. Three steps remain, all yours =="
echo "1. Sign in at ${DASHBOARD_URL} with the shared login Tabish gave you (no sign-up needed)."
echo "2. Ask Tabish to add your Instagram page as a sending account (it appears on the Senders page)."
echo "3. Connect it once, by hand, from THIS Mac:"
echo "     cd ~/ds-sales-agent && pnpm ig:login <yourhandle>"
echo
echo "After that the agent runs by itself, 24/7, as long as this Mac is awake with the lid open."
echo "Everything it does is visible on the dashboard."
