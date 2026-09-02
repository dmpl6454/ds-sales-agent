#!/usr/bin/env bash
#
# Deploy this working tree to the Linode.
#
#   bash scripts/deploy.sh
#
# ── WHY THIS IS A SCRIPT AND NOT A COMMAND SOMEONE TYPES ────────────────────
#
# The hand-typed version has two traps and BOTH were sprung on 2026-08-18, in one
# command, minutes apart:
#
#   1. STALE FILES. `tar xzf` extracts OVER the tree; it never deletes. Three files
#      removed from the repo hours earlier were still on the server, still importing
#      settings that no longer exist, and `next build` typechecks everything it finds —
#      so a deploy of correct code failed on code that was not in the repo at all.
#
#   2. A MASKED EXIT CODE. `pnpm build 2>&1 | tail -1 && pm2 start` takes its status from
#      `tail`, which always succeeds. So pm2 started with no production build and the
#      dashboard served 500s — the failure CLAUDE.md already documented, verbatim, from
#      the last time it happened. A rule written down is not a rule enforced.
#
# So: the file list comes from `git ls-files`, stale files are removed explicitly, the
# build's own exit code is checked, and pm2 is restarted ONLY on success.
#
# `.env` is never shipped. It is the most important exclusion here: the server's
# SEND_ENABLED=false and AUTOPILOT_ENABLED=false hard floors, its DATABASE_URL and its
# DS_DEVICE_NAME all differ from a laptop's, and overwriting them once put the developer's
# environment on the server.
set -euo pipefail

HOST="${DS_DEPLOY_HOST:-linode}"
DIR="${DS_DEPLOY_DIR:-/opt/ds-sales-agent}"
ARCHIVE=/tmp/ds-agent-deploy.tgz

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARNING: the working tree is dirty. Deploying it anyway — but the server will not"
  echo "         match any commit, which is how 'what is actually running?' becomes unanswerable."
  echo
fi

echo "==> Building the file list from git (never from the filesystem)"
git ls-files -z > /tmp/ds-deploy-files.z
COUNT=$(tr -d '\0' < /tmp/ds-deploy-files.z | wc -l | tr -d ' ')
echo "    $COUNT tracked files"

# --null -T: exactly the tracked files, so an untracked scratch file cannot ride along.
tar czf "$ARCHIVE" --null -T /tmp/ds-deploy-files.z
scp -q "$ARCHIVE" "$HOST:/tmp/"

# ── SHIP THE macOS INSTALLER SO THE HOSTED DASHBOARD CAN SERVE IT ────────────
# The Linode is Linux and cannot build a .dmg, so the image built on this Mac is uploaded to
# the server's data dir — exactly where /api/download/agent looks by default (DATA_ROOT). It
# is NOT in the git archive (a 2.4 MB binary does not belong in the code tree), so it rides
# separately. Optional: if there is no built image, the download route simply says so.
DMG="${DS_DMG:-$HOME/Downloads/DS-Sales-Agent.dmg}"
if [[ -f "$DMG" ]]; then
  echo "==> Uploading the installer ($(du -h "$DMG" | cut -f1))"
  ssh "$HOST" 'mkdir -p ~/.ds-sales-agent-data'
  scp -q "$DMG" "$HOST:~/.ds-sales-agent-data/DS-Sales-Agent.dmg"
else
  echo "==> No local installer at $DMG — the download button will report it unpublished"
fi

echo "==> Extracting, and REMOVING what is no longer in the repo"
#
# The stale-file sweep is scoped to the directories we ship code in. `src/generated` is
# excluded because the Prisma client is generated ON the server for ITS provider and is
# deliberately not the one in this tree — deleting it would break the app until the next
# generate, which is precisely the kind of "helpful" cleanup that causes an outage.
#
# LC_ALL=C on BOTH sides of the comparison: macOS and GNU sort order punctuation
# differently, and a mismatched sort makes `comm` report files as present in both "only
# here" and "only there" — acting on that output deletes live files.
git ls-files | grep -E '^(src|prisma|tests|docs|scripts)/' | LC_ALL=C sort > /tmp/ds-repo-scoped.txt
scp -q /tmp/ds-repo-scoped.txt "$HOST:/tmp/ds-repo-scoped.txt"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd "$DIR"

tar xzf "$ARCHIVE"

# AppleDouble turds from a macOS tar; noise, but they accumulate forever.
find . -name '._*' -not -path './node_modules/*' -delete 2>/dev/null || true

find src prisma tests docs scripts -type f 2>/dev/null \
  | grep -v '^src/generated/' \
  | LC_ALL=C sort > /tmp/ds-server-files.txt

# LC_ALL=C on `comm` ITSELF, not only on the two sorts feeding it (2026-08-24). Both inputs
# were already sorted with LC_ALL=C, but `comm` was left to the server's own locale, so it
# collated differently from the files it was reading and printed
# "comm: input is not in sorted order" on a real deploy. It happened to be right that time
# (1 stale file, correctly identified, verified afterwards by a 399-vs-399 file-list match) —
# but the docblock above says a mismatched sort makes `comm` report files as present in both
# "only here" and "only there", and this script ACTS on that output with `rm -f`. A warning
# from the step that deletes live files is not something to leave running.
STALE=\$(LC_ALL=C comm -13 /tmp/ds-repo-scoped.txt /tmp/ds-server-files.txt || true)
if [[ -n "\$STALE" ]]; then
  echo "    removing \$(echo "\$STALE" | wc -l | tr -d ' ') stale file(s):"
  echo "\$STALE" | sed 's/^/      /'
  echo "\$STALE" | xargs -r rm -f
else
  echo "    no stale files"
fi

echo "==> Installing and generating the Postgres client"
pnpm install --silent
pnpm exec prisma generate --config prisma.postgres.config.ts >/dev/null

# ── STOP, BUILD, CHECK, THEN START ────────────────────────────────────────
# Never build while pm2 is serving: \`next start\` reads the manifest at boot and a rebuild
# underneath it serves HTML referencing replaced chunks. And the build's status is read
# DIRECTLY — no pipe, no tail — so a failure cannot start a server with no build.
echo "==> Stopping, building, then starting"
pm2 stop ds-sales-agent >/dev/null

if ! pnpm build > /tmp/ds-build.log 2>&1; then
  echo
  echo "BUILD FAILED. The server is stopped and NOT restarted — a running old build is"
  echo "safer than a started new one with nothing behind it. The tail of the log:"
  echo
  tail -30 /tmp/ds-build.log
  echo
  echo "Fix it, then run this script again. Full log on the server: /tmp/ds-build.log"
  exit 1
fi

pm2 start ds-sales-agent >/dev/null
sleep 8

CODE=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/sign-in || echo 000)
echo "    dashboard answered HTTP \$CODE"
[[ "\$CODE" == "200" ]] || { echo "    the dashboard is NOT serving — check pm2 logs"; exit 1; }

# The scheduler is embedded in this process, so "did it come back" includes "is the watch
# running": a silent detection outage is the one failure here that loses data permanently.
tail -3 /root/.pm2/logs/ds-sales-agent-out.log
REMOTE

echo
echo "==> Deployed."
