#!/bin/bash
#
# DS Sales Agent — one-time setup for a new Mac. Ships inside the DMG; the app icon runs it.
#
# ── NO SECRETS TO TYPE, NO TERMINAL TO SEE (2026-09-03) ───────────────────────
#
# Tabish: "We want a seamless experience just download on their machine and run, no terminal
# hassle." So this Mac PAIRS ITSELF: it generates its own tunnel keypair (the private key
# never leaves this machine), sends the public key to the dashboard, opens a browser tab where
# a signed-in operator clicks "Approve this Mac", and is then handed the database connection
# string once. Nothing is typed except — optionally — a name for the Mac, and even that is
# pre-filled. Every Mac has its own key, so one can be revoked without touching the others.
#
# MODES
#   --gui      dialogs and notifications, output to ~/Library/Logs/ds-sales-agent-install.log.
#              What the app icon runs. Also chosen automatically when no terminal is attached.
#   (tty)      the same flow with plain prompts, for `bash …/install.sh` from Terminal.
#   --manual   the pre-pairing flow: paste the DATABASE_URL and drag the key file. Terminal only.
#
# Idempotent: re-running keeps an existing .env and key, so an interrupted first run resumes.
set -euo pipefail

RES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/ds-sales-agent"
DASHBOARD_URL="https://e035e4d46c.digitalsukoon.com"
LOG="$HOME/Library/Logs/ds-sales-agent-install.log"
KEY="$HOME/.ssh/ds_tunnel_key"
MODE=tty
MANUAL=0
for a in "$@"; do case "$a" in --gui) MODE=gui ;; --manual) MANUAL=1 ;; esac; done
[ -t 0 ] || MODE=gui
if [ "$MODE" = gui ]; then
  mkdir -p "$(dirname "$LOG")"
  exec >>"$LOG" 2>&1
  echo "== $(date) — setup started (gui)"
fi

# ── dialogs or prints, one vocabulary ─────────────────────────────────────────
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
say() {
  echo "$*"
  [ "$MODE" = gui ] && osascript -e "display notification \"$(esc "$*")\" with title \"DS Sales Agent\"" >/dev/null 2>&1 || true
}
fail() {
  echo "ERROR: $*"
  if [ "$MODE" = gui ]; then
    osascript -e "display dialog \"$(esc "$*")

Details are in $LOG\" with title \"DS Sales Agent — setup did not finish\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1 || true
  fi
  exit 1
}
ask() { # ask "prompt" "default" → the answer on stdout; a cancelled dialog ends the run
  if [ "$MODE" = gui ]; then
    osascript -e "text returned of (display dialog \"$(esc "$1")\" default answer \"$(esc "$2")\" with title \"DS Sales Agent\" buttons {\"Cancel\",\"Continue\"} default button 2)" 2>/dev/null || exit 1
  else
    printf '\033[1m%s\033[0m [%s]: ' "$1" "$2" >&2
    read -r v
    printf '%s' "${v:-$2}"
  fi
}
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold "== DS Sales Agent setup =="

# ── 0. Google Chrome — the sender drives a real Chrome profile, no substitute ─
if [ ! -d "/Applications/Google Chrome.app" ]; then
  if [ "$MODE" = gui ]; then
    B=$(osascript -e 'button returned of (display dialog "Google Chrome is required first — the agent sends from a real Chrome profile.

Install Chrome, then open DS Sales Agent again." with title "DS Sales Agent" buttons {"Quit","Get Chrome"} default button 2 with icon caution)' 2>/dev/null || echo Quit)
    [ "$B" = "Get Chrome" ] && open "https://www.google.com/chrome/"
  fi
  fail "Google Chrome is required. Install it from https://www.google.com/chrome/ and run this again."
fi

# ── 1. Node, privately, if the Mac has none ───────────────────────────────────
if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)')" -ge 20 ]; then
  echo "node $(node -v) found"
else
  say "Installing a private Node runtime (the system stays untouched)…"
  ARCH="$(uname -m)"; case "$ARCH" in arm64) A=arm64 ;; *) A=x64 ;; esac
  NODE_V="v22.14.0"
  mkdir -p "$HOME/.ds-sales-agent-runtime"
  curl -fsSL "https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-darwin-${A}.tar.gz" \
    | tar -xz -C "$HOME/.ds-sales-agent-runtime" --strip-components=1 \
    || fail "Could not download Node from nodejs.org — check the internet connection and try again."
  export PATH="$HOME/.ds-sales-agent-runtime/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  say "Installing pnpm…"
  npm install -g pnpm >/dev/null
fi
echo "pnpm $(pnpm -v) found"

# ── 2. The code ───────────────────────────────────────────────────────────────
mkdir -p "$DEST"
tar -xzf "$RES/ds-sales-agent.tar.gz" -C "$DEST"
echo "code unpacked to $DEST"

set_env() { # REPLACE a key, never append beside it — dotenv keeps the FIRST occurrence (measured 1 Sept)
  grep -v "^${1}=" "$DEST/.env" > "$DEST/.env.tmp" && mv "$DEST/.env.tmp" "$DEST/.env"
  printf '%s=%s\n' "$1" "$2" >> "$DEST/.env"
}
write_env() { # write_env DBURL NAME
  cp "$DEST/.env.example" "$DEST/.env"
  echo "" >> "$DEST/.env"
  echo "# ── written by the DS Sales Agent installer ──" >> "$DEST/.env"
  set_env DATABASE_URL "\"$1\""
  set_env SEND_ENABLED true
  set_env AUTOPILOT_ENABLED true
  set_env DRY_RUN 0
  set_env MAX_TOTAL_SENDS unlimited
  set_env DS_DEVICE_NAME "\"$2\""
  set_env OPERATOR_NAME "\"$2\""
  echo ".env written (this file stays on this machine only)"
}
write_ssh_config() { # write_ssh_config HOST USER
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  if ! grep -q "^Host ds-linode$" "$HOME/.ssh/config" 2>/dev/null; then
    {
      echo ""
      echo "Host ds-linode"
      echo "  HostName $1"
      echo "  User $2"
      echo "  IdentityFile $KEY"
      echo "  IdentitiesOnly yes"
      echo "  StrictHostKeyChecking accept-new"
    } >> "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"
  fi
}

ENV_DONE_MARK="written by the DS Sales Agent installer"
if [ -f "$DEST/.env" ] && grep -qF "$ENV_DONE_MARK" "$DEST/.env" && [ -f "$KEY" ]; then
  echo ".env and tunnel key already present — keeping them"

elif [ "$MANUAL" = 1 ]; then
  # ── 3a. The old way: secrets handed over by a person. Terminal only. ─────────
  [ "$MODE" = gui ] && fail "--manual needs Terminal."
  bold "Paste the DATABASE_URL Tabish gave you, then press Enter:"
  read -r DBURL
  case "$DBURL" in postgresql://*127.0.0.1:15432*) ;; *) fail "That does not look like postgresql://…@127.0.0.1:15432/… — stopping so nothing half-configured is left behind." ;; esac
  NAME=$(ask "A short name for this machine (it shows on the dashboard)" "$(scutil --get ComputerName 2>/dev/null || hostname -s)")
  write_env "$DBURL" "$NAME"
  if [ ! -f "$KEY" ]; then
    bold "Drag the tunnel key file Tabish sent you into this window, then press Enter:"
    read -r KEYSRC
    KEYSRC="$(printf '%s' "$KEYSRC" | sed "s/^[[:space:]']*//; s/[[:space:]']*$//")"
    [ -f "$KEYSRC" ] || fail "No file at: $KEYSRC"
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; cp "$KEYSRC" "$KEY"; chmod 600 "$KEY"
  fi
  write_ssh_config 172.105.53.101 root

else
  # ── 3b. PAIR THIS MAC: its own key, approved in the browser, handed the URL once ─
  DEFAULT_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
  DEFAULT_NAME="$(printf '%s' "$DEFAULT_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
  NAME=$(ask "Name this Mac (it shows on the dashboard):" "${DEFAULT_NAME:-mac}")
  NAME="$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
  [ -n "$NAME" ] || NAME=mac

  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  if [ -f "$KEY" ] && [ ! -f "$KEY.pub" ]; then
    # The pre-pairing SHARED key from an older hand-over. Keep it aside; this Mac gets its own.
    mv "$KEY" "$KEY.shared.bak"
  fi
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "ds-device:$NAME"
    chmod 600 "$KEY"
  fi
  PUB="$(cat "$KEY.pub")"
  FPR="$(ssh-keygen -lf "$KEY.pub" | awk '{print $2}')"

  say "Asking the dashboard to pair this Mac…"
  RESP=$(node -e 'const [n,k]=process.argv.slice(1);process.stdout.write(JSON.stringify({deviceName:n,publicKey:k}))' "$NAME" "$PUB" \
    | curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- "$DASHBOARD_URL/api/device/enrol/start") \
    || fail "Could not reach $DASHBOARD_URL — check the internet connection and try again."
  PARSED=$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.userCode){console.error(j.error||s);process.exit(1)}console.log(j.userCode,j.deviceCode,j.approvePath)})') \
    || fail "The dashboard refused the pairing request: $RESP"
  read -r USER_CODE DEVICE_CODE APPROVE_PATH <<< "$PARSED"

  open "$DASHBOARD_URL$APPROVE_PATH"
  MSG="A browser tab has opened. Sign in if asked, check that it shows this code and key, then click “Approve this Mac”.

Code:  $USER_CODE
Key:   $FPR

This window closes by itself once approved."
  echo "$MSG"
  DLG=""
  if [ "$MODE" = gui ]; then
    osascript -e "display dialog \"$(esc "$MSG")\" with title \"DS Sales Agent — approve in the browser\" buttons {\"Waiting…\"} default button 1 giving up after 900" >/dev/null 2>&1 &
    DLG=$!
  fi

  DBURL=""; SSH_HOST=""; SSH_USER=""
  for _ in $(seq 1 300); do
    # The device code is the secret that releases the connection string: it goes in the BODY, never
    # the URL, so it is not written to any access log on the way.
    P=$(curl -fsS -X POST -H 'Content-Type: application/json' --data "{\"deviceCode\":\"$DEVICE_CODE\"}" "$DASHBOARD_URL/api/device/enrol/poll" 2>/dev/null || echo '{"status":"pending"}')
    STATUS=$(printf '%s' "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.status, j.databaseUrl||"", j.sshHost||"", j.sshUser||"")}catch{console.log("pending")}})')
    read -r ST DBURL SSH_HOST SSH_USER <<< "$STATUS"
    case "$ST" in
      approved) break ;;
      expired|unknown) [ -n "$DLG" ] && kill "$DLG" 2>/dev/null || true; fail "The pairing request expired or was not found. Open DS Sales Agent again and approve within 15 minutes." ;;
    esac
    sleep 3
  done
  [ -n "$DLG" ] && kill "$DLG" 2>/dev/null || true
  [ "${ST:-}" = approved ] && [ -n "$DBURL" ] || fail "Nobody approved this Mac within 15 minutes. Open DS Sales Agent again to retry."
  say "Approved — finishing the setup…"

  write_env "$DBURL" "$NAME"
  write_ssh_config "${SSH_HOST:-172.105.53.101}" "${SSH_USER:-root}"
fi
echo "tunnel key: this Mac's own, forward-only (no shell, no files, one port)"

# ── 4. Dependencies, the tunnel, the agent ────────────────────────────────────
say "Installing (2–4 minutes on the first run)…"
cd "$DEST"
pnpm install >/dev/null 2>&1 || pnpm install || fail "pnpm install failed — see the log."
bash scripts/prisma-client-for-env.sh
DS_TUNNEL_HOST=ds-linode bash scripts/install-tunnel.sh install
sleep 4
if ! nc -z 127.0.0.1 15432 2>/dev/null; then
  sleep 6
  nc -z 127.0.0.1 15432 2>/dev/null || fail "The database tunnel did not come up. If this Mac was just approved, wait a minute and open DS Sales Agent again; otherwise check the network."
fi
echo "tunnel is up (127.0.0.1:15432 → the shared database)"
bash scripts/install-watch.sh install

# ── 5. Done ───────────────────────────────────────────────────────────────────
DONE="This Mac is set up and the agent is running — it keeps running after restarts.

Next, on the dashboard's Senders page: add your Instagram page, then press Connect beside it. A Chrome window opens on THIS Mac for the one-time Instagram sign-in.

Keep the lid open; a sleeping Mac sends nothing. Never connect the same Instagram account from two Macs."
echo "$DONE"
if [ "$MODE" = gui ]; then
  B=$(osascript -e "button returned of (display dialog \"$(esc "$DONE")\" with title \"DS Sales Agent — ready\" buttons {\"Done\",\"Open dashboard\"} default button 2)" 2>/dev/null || echo Done)
  [ "$B" = "Open dashboard" ] && open "$DASHBOARD_URL/senders"
fi
echo "== $(date) — setup finished"
