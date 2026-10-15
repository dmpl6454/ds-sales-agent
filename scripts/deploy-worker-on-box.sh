#!/usr/bin/env bash
#
# Deploy ONE pinned commit's source to the detection WORKER, run ON the box itself.
#
#   bash deploy-worker-on-box.sh <full 40-character commit id>
#
# ── WHY THIS EXISTS (15 Oct 2026) ──────────────────────────────────────────────
#
# `scripts/deploy.sh` is the real deploy and it runs from a Mac: it needs the management SSH
# key and builds the web tier there, because this 961 MB box cannot build it (three OOM kills,
# 8 Sept). On 15 Oct the only Mac holding that key no longer existed, on the day detection had
# been blind for 22 hours. The cause was REPORTED as Instagram refusing the anonymous app identity
# from every network (`401 {"message":"Please wait a few minutes…","require_login":true}` on the
# box and on the Mac Studio, first request) — reported by a person, NOT measured from this
# repository; the `detectFeedAnswer` row and `pnpm ig:probe` are how to confirm it. The fix
# being deployed — the official Business Discovery fallback — lives
# entirely in the worker, which runs from SOURCE (`node --import tsx src/worker/index.ts`) and so
# needs no build. A person with a root console on the box can therefore restore detection
# without any Mac at all, and this script is that path.
#
# WHAT IT DOES, AND DELIBERATELY DOES NOT
#   - downloads the PINNED commit from GitHub (the repo is public), never a branch tip, so what
#     runs is exactly what the suite passed;
#   - REFUSES unless this is the server (`.env` says SEND_ENABLED=false) — it never touches a Mac;
#   - REFUSES if the dependency lockfile or the Prisma schema differs from what is installed here:
#     either needs `pnpm install` / `prisma generate` under the RUNNING dashboard, whose prebuilt
#     bundle links into node_modules by exact version path — changing those breaks the web tier
#     on its next module load. That is a full deploy, from a Mac;
#   - backs up the current source first and prints the one-line rollback;
#   - copies tracked files over the tree and removes stale ones in the same scoped directories as
#     deploy.sh (never `src/generated`, never `.env`, never `node_modules`, never `.next-*`);
#   - restarts `ds-sales-worker` BY NAME — never a global pm2 command (rule 14);
#   - leaves the dashboard (`ds-sales-agent`) serving its current build. Its screens catch up at
#     the next full deploy; until then the worker is newer than the web tier, which every stage of
#     this code is written to tolerate (server-side changes are mixed-window safe by design).
#
# Test hooks (tests/deploy-worker-on-box.test.ts): DS_BOX_DIR, DS_BACKUP_DIR, DS_TARBALL (a local
# tarball instead of the download), DS_SKIP_WAIT=1.
set -euo pipefail

SHA="${1:-}"
DIR="${DS_BOX_DIR:-/opt/ds-sales-agent}"
BACKUPS="${DS_BACKUP_DIR:-/opt/ds-backups}"
REPO="dmpl6454/ds-sales-agent"

# Until the copy starts, a refusal truthfully changed nothing. After it, the tree IS changed, so a
# failure names the rollback instead (review, 15 Oct 2026 — the old message said "nothing changed"
# about a pm2 restart that failed after the new files were in place).
COPIED=0
BACKUP=""
die() {
  echo "REFUSING: $*" >&2
  if [[ "$COPIED" == "1" ]]; then
    echo "The new source IS in place in $DIR, but the worker may still be running the old one." >&2
    echo "Roll back with:  tar xzf $BACKUP -C $DIR && pm2 restart ds-sales-worker --update-env" >&2
  else
    echo "Nothing on the box was changed." >&2
  fi
  exit 1
}
# `set -e` would otherwise exit silently after the copy; say what state the box is in.
trap '[[ "$COPIED" == "1" ]] && echo "A step after the copy failed. Roll back with:  tar xzf $BACKUP -C $DIR && pm2 restart ds-sales-worker --update-env" >&2' ERR
pause() { [[ "${DS_SKIP_WAIT:-0}" == "1" ]] || sleep "$1"; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit id (the one the suite passed on), e.g. bash $0 0123…"
[[ -d "$DIR" && -f "$DIR/.env" ]] || die "$DIR/.env not found — this is not the box"
grep -qE "^SEND_ENABLED=[\"']?(false|0)[\"']?[[:space:]]*$" "$DIR/.env" \
  || die "$DIR/.env does not say SEND_ENABLED=false. This script deploys the SERVER's worker only; a Mac updates through the installer"
command -v pm2 >/dev/null || die "pm2 not found on PATH"

WORK="$(mktemp -d /tmp/ds-worker-deploy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Fetching $REPO at ${SHA:0:7}"
if [[ -n "${DS_TARBALL:-}" ]]; then
  cp "$DS_TARBALL" "$WORK/src.tgz"
else
  curl -fsSL --retry 3 -o "$WORK/src.tgz" "https://codeload.github.com/$REPO/tar.gz/$SHA" \
    || die "could not download that commit from GitHub — check the id and the box's network"
fi
tar xzf "$WORK/src.tgz" -C "$WORK"
NEW="$WORK/ds-sales-agent-$SHA"
[[ -f "$NEW/package.json" && -f "$NEW/src/worker/index.ts" && -f "$NEW/pnpm-lock.yaml" ]] \
  || die "the download is not ds-sales-agent at $SHA (expected a top-level ds-sales-agent-$SHA directory)"

echo "==> Checking nothing here needs installing or regenerating"
cmp -s "$NEW/pnpm-lock.yaml" "$DIR/pnpm-lock.yaml" \
  || die "the dependency lockfile differs from what is installed here. Installing packages under the running dashboard breaks its prebuilt bundle; this needs a full deploy (scripts/deploy.sh from a Mac)"
for f in prisma/schema.prisma prisma/schema.postgres.prisma; do
  if [[ -f "$NEW/$f" ]]; then
    cmp -s "$NEW/$f" "$DIR/$f" || die "$f differs from what is installed here — the database client would need regenerating (and maybe a hand-written ALTER); this needs a full deploy"
  fi
done

echo "==> Backing up the current source"
mkdir -p "$BACKUPS"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUPS/source-$TS.tgz"
( cd "$DIR" && tar czf "$BACKUP" --exclude='./node_modules' --exclude='./.next*' --exclude='./src/generated' --exclude='./.env*' . )
chmod 600 "$BACKUP"
echo "    $BACKUP"

echo "==> Copying the commit's files over the tree"
COPIED=1
( cd "$NEW" && tar cf - . ) | ( cd "$DIR" && tar xf - --no-same-owner )

# The same scoped sweep as deploy.sh, and for the same reason: tar never deletes, and a file
# removed from the repo but left here can still be imported. `src/generated` is the Prisma client
# generated ON this box for ITS provider and is never swept.
# Every stage tolerates an empty or missing directory: the files are already copied at this point,
# so a `set -e` abort here would leave the new tree in place with the worker never restarted.
( cd "$NEW" && { find src prisma tests docs scripts -type f 2>/dev/null || true; } | LC_ALL=C sort ) > "$WORK/repo.txt"
( cd "$DIR" && { find src prisma tests docs scripts -type f 2>/dev/null || true; } | { grep -v '^src/generated/' || true; } | LC_ALL=C sort ) > "$WORK/box.txt"
STALE="$(LC_ALL=C comm -13 "$WORK/repo.txt" "$WORK/box.txt" || true)"
if [[ -n "$STALE" ]]; then
  echo "    removing $(printf '%s\n' "$STALE" | wc -l | tr -d ' ') stale file(s):"
  printf '%s\n' "$STALE" | sed 's/^/      /'
  printf '%s\n' "$STALE" | ( cd "$DIR" && xargs -r -d '\n' rm -f )
else
  echo "    no stale files"
fi
echo "${SHA:0:7}" > "$DIR/.version"

echo "==> Restarting the detection worker (by name)"
pm2 restart ds-sales-worker --update-env >/dev/null || die "pm2 could not restart ds-sales-worker"
pause 8
for p in $(pgrep -f 'src/worker/index' || true); do renice -n 15 -p "$p" >/dev/null 2>&1 || true; ionice -c 3 -p "$p" 2>/dev/null || true; done
pm2 save >/dev/null 2>&1 || true

pause 20
STATUS="$(pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const p=l.find(p=>p.name==="ds-sales-worker");console.log(p?p.pm2_env.status+" restarts="+p.pm2_env.restart_time:"absent")' 2>/dev/null || echo unknown)"
echo "    ds-sales-worker: $STATUS"
echo
echo "==> Deployed ${SHA:0:7} to the worker. The dashboard still serves its previous build."
echo "    Check it:  pm2 logs ds-sales-worker --lines 40 --nostream"
echo "    Rollback:  tar xzf $BACKUP -C $DIR && pm2 restart ds-sales-worker --update-env"
