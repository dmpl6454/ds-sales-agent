#!/usr/bin/env bash
# Print the Next dist directory the dashboard is SERVING, on the server. Used by deploy.sh
# twice — once over ssh to choose which directory to build into, once on the box to choose
# which to unpack over and which to delete — so the two can never disagree.
#
# WHY NOT JUST `cat .active-dist` (audit H7, 2026-10-09). The marker was written BEFORE the
# reload and the health check, and the documented rollback (`NEXT_DIST_DIR=<old> pm2 reload
# ds-sales-agent --update-env`) never rewrites it. So after a rollback, or after a deploy whose
# health check failed, the marker named the directory NOT being served — and the next deploy
# built into, unpacked over and finally `rm -rf`'d the one the workers were running. The pm2
# process carries the real answer in its own environment; the marker is only the fallback for
# a box where the process is absent or names a directory that no longer exists.
#
# Usage: bash scripts/active-dist.sh [app-dir]. Always prints exactly one line, never fails.
set -u
DIR="${1:-.}"
cd "$DIR" 2>/dev/null || { echo .next; exit 0; }

SERVING=""
if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  SERVING="$(pm2 jlist 2>/dev/null | node -e '
    let l = []
    try { l = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch {}
    const p = Array.isArray(l) ? l.find((p) => p.name === "ds-sales-agent") : undefined
    const e = (p && p.pm2_env) || {}
    process.stdout.write(String(e.NEXT_DIST_DIR || (e.env && e.env.NEXT_DIST_DIR) || ""))
  ' 2>/dev/null || true)"
fi
case "$SERVING" in
  .next|.next-a|.next-b) [[ -d "$SERVING" ]] && { echo "$SERVING"; exit 0; } ;;
esac

MARK="$(cat .active-dist 2>/dev/null || true)"
case "$MARK" in
  .next|.next-a|.next-b) echo "$MARK" ;;
  *) echo .next ;;
esac
