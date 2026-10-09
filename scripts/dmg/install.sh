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
  # PINNED to the major this repo is verified against (7 Sept 2026). An unpinned install
  # fetched pnpm 12 on the first operator Mac while every install here had run under pnpm 9,
  # and pnpm 12 refuses dependency build scripts as a hard error unless pnpm-workspace.yaml
  # allows them — it does now, and the pin keeps the next major from changing the rules again.
  npm install -g pnpm@12 >/dev/null
fi
echo "pnpm $(pnpm -v) found"

# ── 2. The code ───────────────────────────────────────────────────────────────
mkdir -p "$DEST"
# A RE-RUN IS AN UPDATE (2026-09-08). `tar x` never deletes, so a file removed from the repo
# would survive on an updated Mac forever — the same trap deploy.sh documents for the server.
# The code directories are removed before the new tree lands; .env, the tunnel key and
# node_modules are outside them and are kept. `src/generated` is regenerated by pnpm install.
if [ -f "$DEST/.version" ] || [ -d "$DEST/src" ]; then
  PREV="$(cat "$DEST/.version" 2>/dev/null || echo unknown)"
  echo "updating an existing install (was build $PREV)"
  rm -rf "$DEST/src" "$DEST/scripts" "$DEST/tests" "$DEST/docs"
fi
tar -xzf "$RES/ds-sales-agent.tar.gz" -C "$DEST"
# The build STAMP (.version) is written near the END now, just before the agent is restarted —
# see the comment there. Until then an update that stops partway leaves the old stamp behind.
echo "code unpacked to $DEST (build $(cat "$RES/VERSION" 2>/dev/null || echo unknown))"

# The line write_env leaves in a .env it finished writing. Read by the KEPT decision below and by
# pair_this_mac (which offers the kept name), so it is defined before either.
ENV_DONE_MARK="written by the DS Sales Agent installer"
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
  # The classifier key travels with the pairing (7 Sept 2026): when this Mac reads the feeds
  # in the server's place it must be able to JUDGE what it stores. Absent → the agent says so.
  [ -n "${3:-}" ] && set_env DEEPSEEK_API_KEY "\"$3\""
  echo ".env written (this file stays on this machine only)"
}
write_ssh_config() { # write_ssh_config HOST USER — REWRITES the stanza, because the server can move
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/config"
  # THE SERVER MOVED ON 9 Sept 2026, and this used to append only when no `Host ds-linode` stanza
  # existed — so every Mac installed before the move kept tunnelling to the old address forever,
  # however many times the installer was re-run. The stanza is replaced in full now; the
  # maintainer's own `Host linode` alias (a different word) is left alone.
  awk 'BEGIN{skip=0} /^Host /{skip=($2=="ds-linode")} !skip' "$HOME/.ssh/config" > "$HOME/.ssh/config.tmp" && mv "$HOME/.ssh/config.tmp" "$HOME/.ssh/config"
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
}

manual_secrets() {
  # ── 3a. The old way: secrets handed over by a person. Terminal only. ─────────
  [ "$MODE" = gui ] && fail "--manual needs Terminal."
  bold "Paste the DATABASE_URL Tabish gave you, then press Enter:"
  read -r DBURL
  case "$DBURL" in postgresql://*127.0.0.1:15432*) ;; *) fail "That does not look like postgresql://…@127.0.0.1:15432/… — stopping so nothing half-configured is left behind." ;; esac
  NAME=$(ask "A short name for this machine (it shows on the dashboard)" "$(scutil --get ComputerName 2>/dev/null || hostname -s)")
  write_env "$DBURL" "$NAME" "${MODEL_KEY:-}"
  if [ ! -f "$KEY" ]; then
    bold "Drag the tunnel key file Tabish sent you into this window, then press Enter:"
    read -r KEYSRC
    KEYSRC="$(printf '%s' "$KEYSRC" | sed "s/^[[:space:]']*//; s/[[:space:]']*$//")"
    [ -f "$KEYSRC" ] || fail "No file at: $KEYSRC"
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; cp "$KEYSRC" "$KEY"; chmod 600 "$KEY"
  fi
  # The pairing hand-off is the source of truth for the server's address; this path has no
  # hand-off, so a person confirms it. The default is today's box, never a silent constant —
  # a hardcoded address here is how a Mac would have been pointed at another team's server.
  SRV=$(ask "The server address Tabish gave you" "173.230.131.144")
  write_ssh_config "$SRV" root
}

# The dashboard's answer to a pairing request, read into a TAG line and then one field per line —
# names have spaces, so the space-split read the poll uses cannot carry them:
#   ok / userCode / deviceCode / approvePath / deviceName
#   taken / deviceName / suggestion     another Mac uses that name; ask for another
#   refused / the dashboard's sentence  anything else it said no to (shown as it said it)
#   unreachable                         not JSON at all — a proxy's error page, a timeout body
# A top-level variable rather than inline so tests can run this exact program against bodies.
START_PARSER='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("unreachable");return}if(!j||typeof j!=="object"){console.log("unreachable");return}const f=v=>String(v==null?"":v).replace(/[\r\n]+/g," ");if(j.userCode&&j.deviceCode){console.log(["ok",j.userCode,j.deviceCode,j.approvePath,j.deviceName].map(f).join("\n"));return}if(j.status==="name-taken"){console.log(["taken",j.deviceName,j.suggestion].map(f).join("\n"));return}console.log(["refused",j.error||"the dashboard refused the pairing request"].map(f).join("\n"))})'

pair_this_mac() {
  # ── 3b. PAIR THIS MAC: its own key, approved in the browser, handed the URL once ─
  # A FUNCTION, because it runs twice: on a fresh Mac, and on a re-run whose kept tunnel
  # settings no longer reach a server (the server moved, 9 Sept 2026). The hand-off is the only
  # channel that carries the current address; an existing key is offered again, and a key already
  # authorised keeps the name it is paired under. It is STILL approved by a person: a public key
  # is not a secret, and approving hands over the database URL.
  #
  # THE NAME IS THIS MAC'S IDENTITY ON THE DASHBOARD (2026-10-09): the sending Mac is chosen by
  # name, so two Macs with one name would both send. A Mac re-pairing offers the name it already
  # runs as (its kept .env), so a re-pair does not quietly rename the selected sending Mac — but
  # only from a .env THIS installer finished writing, and never the example file's placeholder.
  DEFAULT_NAME=""
  if [ -f "$DEST/.env" ] && grep -qF "$ENV_DONE_MARK" "$DEST/.env"; then
    DEFAULT_NAME="$(sed -n 's/^DS_DEVICE_NAME=//p' "$DEST/.env" | head -n 1)"
    DEFAULT_NAME="${DEFAULT_NAME#\"}"; DEFAULT_NAME="${DEFAULT_NAME%\"}"
    DEFAULT_NAME="$(printf '%s' "$DEFAULT_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
    if [ -z "$(printf '%s' "$DEFAULT_NAME" | tr -d ' ')" ] || [ "$DEFAULT_NAME" = "my-mac" ]; then DEFAULT_NAME=""; fi
  fi
  if [ -z "$DEFAULT_NAME" ]; then
    DEFAULT_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
    DEFAULT_NAME="$(printf '%s' "$DEFAULT_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
  fi
  NAME=$(ask "Name this Mac (it shows on the dashboard):" "${DEFAULT_NAME:-mac}")
  NAME="$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
  # A name of only spaces (a ComputerName in a non-Latin script survives `tr` as spaces) is no name.
  [ -n "$(printf '%s' "$NAME" | tr -d ' ')" ] || NAME=mac

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
  # ── ONE NAME PER MAC, ASKED OF THE DASHBOARD (2026-10-09) ────────────────────
  #
  # The dashboard refuses a name another Mac already uses — two Macs with one name would both act
  # as that Mac, both send, and revoking one would revoke both. A refused name is asked for again
  # here, with the dashboard's suggestion as the default, at most five times. `curl` runs WITHOUT
  # -f: with -f every refusal's body was discarded and the person was told to check their internet
  # connection, whatever the dashboard had actually said.
  USER_CODE=""; DEVICE_CODE=""; APPROVE_PATH=""; SERVER_NAME=""
  TRIES=0
  while :; do
    TRIES=$((TRIES + 1))
    RESP=$(node -e 'const [n,k]=process.argv.slice(1);process.stdout.write(JSON.stringify({deviceName:n,publicKey:k}))' "$NAME" "$PUB" \
      | curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- "$DASHBOARD_URL/api/device/enrol/start") \
      || fail "Could not reach $DASHBOARD_URL — check the internet connection and try again."
    PARSED=$(printf '%s' "$RESP" | node -e "$START_PARSER") || PARSED=unreachable
    TAG=""; F1=""; F2=""; F3=""; F4=""
    { IFS= read -r TAG; IFS= read -r F1; IFS= read -r F2; IFS= read -r F3; IFS= read -r F4; } <<< "$PARSED" || true
    case "$TAG" in
      ok) USER_CODE="$F1"; DEVICE_CODE="$F2"; APPROVE_PATH="$F3"; SERVER_NAME="$F4"; break ;;
      taken)
        [ "$TRIES" -lt 5 ] || fail "Could not find a free name — ask whoever runs the dashboard which names are in use."
        if ! NAME=$(ask "Another Mac on the dashboard already uses the name “$F1”. Two Macs with one name would both act as that Mac, so each needs its own. Choose a name for THIS Mac:" "$F2"); then
          fail "Setup was cancelled — open DS Sales Agent again to finish."
        fi
        NAME="$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
        [ -n "$(printf '%s' "$NAME" | tr -d ' ')" ] || NAME=mac
        ;;
      refused) fail "The dashboard refused the pairing request: $F1" ;;
      *) fail "Could not reach $DASHBOARD_URL — check the internet connection and try again." ;;
    esac
  done
  # THE DASHBOARD'S NAME IS THE NAME. A key already paired keeps the name it is paired under, and
  # the server cleans names its own way; writing the name typed here instead is how a Mac came to
  # run under a name nothing on the server reserved. Cleaned again because set_env writes it raw.
  TYPED_NAME="$NAME"
  if [ -n "$SERVER_NAME" ]; then
    NAME="$(printf '%s' "$SERVER_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
    [ -n "$(printf '%s' "$NAME" | tr -d ' ')" ] || NAME="$TYPED_NAME"
  fi
  [ "$NAME" = "$TYPED_NAME" ] || say "The dashboard knows this Mac as “$NAME” — it keeps that name."

  open "$DASHBOARD_URL$APPROVE_PATH"
  # ── YOU DO NOT NEED A DASHBOARD LOGIN TO PAIR THIS MAC (2026-09-07) ──────────
  #
  # This used to say only "Sign in if asked", which made a dashboard account a hard requirement
  # for the person at the keyboard — and a new operator does not have one. MEASURED after a
  # second operator installed twice: no new dashboard session since 1 September, so they never
  # got past that page, and the pairing died with it.
  #
  # Since the waiting Mac is listed on /senders, ANYONE already signed in can approve it. So the
  # code and fingerprint are what matter, and they are read out here to be passed on. Approving
  # it yourself is the alternative, not the requirement.
  MSG="This Mac is waiting to be approved. Read the code and key below to whoever runs the dashboard — it is already showing on their Senders page under “Macs waiting to be approved”, and they can approve it from there.

Name:  $NAME
Code:  $USER_CODE
Key:   $FPR

If you have a dashboard login yourself, the browser tab that just opened does the same thing.

This window closes by itself once approved. The request expires in 15 minutes — if it does, just open DS Sales Agent again."
  echo "$MSG"
  DLG=""
  if [ "$MODE" = gui ]; then
    osascript -e "display dialog \"$(esc "$MSG")\" with title \"DS Sales Agent — approve in the browser\" buttons {\"Waiting…\"} default button 1 giving up after 900" >/dev/null 2>&1 &
    DLG=$!
  fi

  DBURL=""; SSH_HOST=""; SSH_USER=""; MODEL_KEY=""
  for _ in $(seq 1 300); do
    # The device code is the secret that releases the connection string: it goes in the BODY, never
    # the URL, so it is not written to any access log on the way.
    P=$(curl -fsS -X POST -H 'Content-Type: application/json' --data "{\"deviceCode\":\"$DEVICE_CODE\"}" "$DASHBOARD_URL/api/device/enrol/poll" 2>/dev/null || echo '{"status":"pending"}')
    STATUS=$(printf '%s' "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.status, j.databaseUrl||"", j.sshHost||"", j.sshUser||"", j.modelKey||"")}catch{console.log("pending")}})')
    read -r ST DBURL SSH_HOST SSH_USER MODEL_KEY <<< "$STATUS"
    case "$ST" in
      approved) break ;;
      expired|unknown)
        [ -n "$DLG" ] && kill "$DLG" 2>/dev/null || true
        # A request WITHDRAWN at approval says why (2026-10-09) — usually that another Mac took this
        # name meanwhile — and that, not "approve faster", is what the person needs to read. Read
        # apart from the space-split line above: a sentence would spill into the fields after it.
        REASON=$(printf '%s' "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.reason||"").replace(/[\r\n]+/g," "))}catch(e){}})' || true)
        [ -n "$REASON" ] && fail "$REASON"
        fail "The pairing request expired or was not found. Open DS Sales Agent again and approve within 15 minutes." ;;
      # The server has no endpoint to hand over (9 Sept 2026). Its .env is missing a key; this
      # Mac did nothing wrong and its request is still waiting, so it retries rather than dying.
      misconfigured) [ -n "$DLG" ] && kill "$DLG" 2>/dev/null || true; fail "This Mac was approved, but the dashboard server is not yet configured to hand over its address. Tell Tabish: the server's .env needs DEVICE_SSH_HOST and DEVICE_DATABASE_URL. Your request is still waiting — open DS Sales Agent again once that is set." ;;
    esac
    sleep 3
  done
  [ -n "$DLG" ] && kill "$DLG" 2>/dev/null || true
  [ "${ST:-}" = approved ] && [ -n "$DBURL" ] || fail "Nobody approved this Mac within 15 minutes. Open DS Sales Agent again to retry."
  # An EMPTY endpoint writes a tunnel to nowhere and the failure surfaces minutes later as
  # "the database tunnel did not come up" (9 Sept 2026). Checked here, where it can be named.
  [ -n "$SSH_HOST" ] && [ -n "$SSH_USER" ] || fail "The dashboard did not hand over a server address. Tell Tabish the server's .env needs DEVICE_SSH_HOST; nothing was changed on this Mac."
  say "Approved — finishing the setup…"

  write_env "$DBURL" "$NAME" "${MODEL_KEY:-}"
  write_ssh_config "$SSH_HOST" "$SSH_USER"
}

KEPT=0
if [ -f "$DEST/.env" ] && grep -qF "$ENV_DONE_MARK" "$DEST/.env" && [ -f "$KEY" ]; then
  echo ".env and tunnel key already present — keeping them (re-checked once the tunnel is tried)"
  KEPT=1
elif [ "$MANUAL" = 1 ]; then
  manual_secrets
else
  pair_this_mac
fi
echo "tunnel key: this Mac's own, forward-only (no shell, no files, one port)"

# ── 4. Dependencies, the tunnel, the agent ────────────────────────────────────
say "Installing (2–4 minutes on the first run)…"
cd "$DEST"
# ── pnpm install, and WHY it failed when it fails (7 Sept 2026) ──────────────────────────
# Another operator's Mac Studio died here with a dialog reading only "pnpm install failed —
# see the log", and the log was on their machine. The cause was ours: better-sqlite3 had
# drifted to a version with no prebuilt binary for Node 22 on Apple Silicon, so pnpm fell
# back to compiling it, which needs Xcode's command line tools that a fresh Mac lacks. The
# dependency is pinned now (package.json), and this step keeps the output, retries once
# (a dropped connection is the other common cause), and puts the diagnosis IN the dialog.
PNPM_OUT="$DEST/.pnpm-install.out"
pnpm_try() { pnpm install > "$PNPM_OUT" 2>&1; }
if ! pnpm_try; then
  echo "pnpm install failed once — retrying in 10 s"; sleep 10
  if ! pnpm_try; then
    HINT="Could not install the app's packages."
    if grep -q -i -E "IGNORED_BUILDS|Ignored build scripts|approve-builds" "$PNPM_OUT"; then
      HINT="This pnpm refused to run the packages' install scripts. The app's pnpm-workspace.yaml allows them — this image predates it; download the installer again from the dashboard and open it. (Please report which version of the installer this was.)"
    elif grep -q -i -E "gyp|xcode|xcrun|clang|python" "$PNPM_OUT"; then
      HINT="A package tried to compile itself and this Mac lacks Apple's command line tools. Open Terminal, run: xcode-select --install, then open DS Sales Agent again. (This should not happen with the shipped versions — please report it.)"
    elif grep -q -i -E "ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|registry.npmjs.org|github.com|binaries.prisma.sh|network" "$PNPM_OUT"; then
      HINT="The download of the app's packages failed — this Mac could not reach npmjs.org, github.com or binaries.prisma.sh. Check the internet connection (a VPN or office firewall can block these), then open DS Sales Agent again."
    elif grep -q -i -E "ENOSPC|no space left" "$PNPM_OUT"; then
      HINT="This Mac is out of disk space. Free some space, then open DS Sales Agent again."
    fi
    TAIL="$(tail -n 6 "$PNPM_OUT" | cut -c1-160)"
    fail "$HINT

Last lines from pnpm:
$TAIL"
  fi
fi
echo "packages installed"
bash scripts/prisma-client-for-env.sh
tunnel_up() { sleep 4; nc -z 127.0.0.1 15432 2>/dev/null && return 0; sleep 6; nc -z 127.0.0.1 15432 2>/dev/null; }
DS_TUNNEL_HOST=ds-linode bash scripts/install-tunnel.sh install
if ! tunnel_up; then
  if [ "$KEPT" = 1 ]; then
    # THE KEPT SETTINGS REACH NOTHING — THE SERVER MAY HAVE MOVED (9 Sept 2026). Sudhanshu's
    # half-finished install held an ssh stanza naming the old box; "keep the existing .env and
    # key" would have tunnelled there forever and failed here every time. Pairing again is the
    # only path that carries the current address, and it also rewrites a .env that predates the
    # classifier-key hand-off.
    echo "the tunnel did not come up on the kept settings — the server may have moved; pairing this Mac again"
    say "The server's address seems to have changed. Pairing this Mac again — a dialog will appear."
    pair_this_mac
    DS_TUNNEL_HOST=ds-linode bash scripts/install-tunnel.sh install
    tunnel_up || fail "The database tunnel did not come up even after pairing again. Check the network, then open DS Sales Agent again."
  else
    fail "The database tunnel did not come up. If this Mac was just approved, wait a minute and open DS Sales Agent again; otherwise check the network."
  fi
fi
echo "tunnel is up (127.0.0.1:15432 → the shared database)"
# ── THE BUILD STAMP, WRITTEN ONLY ONCE EVERYTHING ABOVE HAS WORKED (2026-10-09) ──
#
# The stamp the launcher compares against the image's VERSION, and what the agent reports as its
# build on /senders (src/lib/buildVersion.ts reads it at start, so it lands BEFORE the agent is
# restarted below). It used to be written right after the unpack, so an UPDATE that failed later —
# a refused name, a cancelled dialog, a pairing nobody approved — left a matching stamp, and the
# launcher, seeing the sentinel and equal versions, opened the dashboard on every later click and
# never ran this installer again: a Mac with a dead tunnel and no way back short of a newer image.
[ -f "$RES/VERSION" ] && cp "$RES/VERSION" "$DEST/.version"
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
# ── THE COMPLETION SENTINEL ───────────────────────────────────────────────────
#
# WRITTEN LAST, AND ONLY HERE. The app's launcher used to ask whether `~/ds-sales-agent`
# EXISTS, and this script creates that directory at step 2 — before the runtime, the tunnel,
# the pairing and the agent. So ANY failure after the unpack (no Chrome, a dropped network, a
# dismissed dialog, an enrolment nobody approved inside fifteen minutes) left the directory
# behind and turned the .app into a permanent browser shortcut: every later double-click opened
# a web page and NEVER re-ran the installer.
#
# MEASURED 2026-09-07, after a second operator installed twice: 1 enrolment request ever
# reaching the server (a probe of ours), and no new dashboard session since 1 September. Their
# Mac had stopped being able to try.
#
# This file is the same shape as `ENV_DONE_MARK` above and the same lesson as 1 September's
# aborted first run: **a completion sentinel, never file existence.** It lives in the DATA
# directory, not the credential one, so a support bundle or a backup can copy it freely.
mkdir -p "$HOME/.ds-sales-agent-data"
printf 'setup completed %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/.ds-sales-agent-data/setup-complete"

echo "== $(date) — setup finished"
