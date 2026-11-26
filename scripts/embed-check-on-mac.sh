#!/usr/bin/env bash
# embed-check-on-mac.sh — READ-ONLY. Run the embed READER (the real code a new Mac build would ship) against
# Instagram's embed pages from THIS Mac, before any new build is installed.
#
# Run it on the Mac Studio, as a FILE (never pasted into a shell). One line, with the commit it should test:
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<commit>/scripts/embed-check-on-mac.sh -o /tmp/ecm.sh && bash /tmp/ecm.sh <commit>
#
#   bash /tmp/ecm.sh <commit> --evidence          also print cuts of the pages for a person to read
#   bash /tmp/ecm.sh <commit> name:v other:u      ask about these accounts instead (v = we hold it verified, u = not)
#
# WHAT IT DOES. Downloads three files of that commit from the public repository into a temporary folder —
# src/detection/embedParse.ts, src/detection/embedFetch.ts, src/scripts/embed-check.ts — and runs the third with
# the tsx that is already in the installed agent (~/ds-sales-agent/node_modules). Those three import nothing but
# each other and Node, so nothing in the installed agent is read, replaced or restarted, and the agent keeps
# running. See src/scripts/embed-check.ts for what is asked (at most 9 plain requests, 2 s apart, no login, no
# cookie) and its stop rules.
#
# What it does NOT do: touch ~/ds-sales-agent (it only RUNS the tsx found there), open .env, reach the database,
# change a setting, install anything, or keep running. The temporary folder is removed on exit.
#
# Needs: bash 3.2 or newer, curl, mktemp, and the installed agent's node_modules.
# Exit: the check's own (0 every control read as held, 1 something did not), or 2 when it could not run.
set -u

stop2() { printf '%s\n' "-- STOPPED: $*"; exit 2; }

COMMIT="${1:-}"
case "$COMMIT" in
  ''|*[!0-9a-f]*) stop2 "give the commit to test, for example: bash /tmp/ecm.sh 1a47e2b (letters a-f and digits only)" ;;
esac
[ "${#COMMIT}" -ge 7 ] && [ "${#COMMIT}" -le 40 ] || stop2 "'$COMMIT' is not a commit (7 to 40 characters)."
shift

# (DS_EMBED_CHECK_AS_ROOT=1 is for the test harness, which runs as root in a sandbox. A real run sets nothing.)
[ "$(id -u)" -ne 0 ] || [ "${DS_EMBED_CHECK_AS_ROOT:-}" = 1 ] || stop2 "do not run this with sudo."
TREE="${DS_TREE:-$HOME/ds-sales-agent}"
TSX="$TREE/node_modules/.bin/tsx"
[ -d "$TREE" ] || stop2 "the installed agent is not at $TREE."
[ -x "$TSX" ] || stop2 "no tsx at $TSX — the installed agent's node_modules are missing or incomplete."
command -v curl >/dev/null 2>&1 || stop2 "curl is not on this machine."
command -v node >/dev/null 2>&1 || stop2 "node is not on this shell's PATH. Open the Terminal you run pnpm from and try again."

BASE="${DS_EMBED_CHECK_BASE:-https://raw.githubusercontent.com/dmpl6454/ds-sales-agent}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ds-embed-check-src.XXXXXX") || stop2 "could not make a temporary folder."
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/src/detection" "$WORK/src/scripts" || stop2 "could not make the temporary folders."

for f in src/detection/embedParse.ts src/detection/embedFetch.ts src/scripts/embed-check.ts; do
  if ! curl -fsSL --connect-timeout 10 --max-time 60 "$BASE/$COMMIT/$f" -o "$WORK/$f"; then
    stop2 "could not download $f of commit $COMMIT. Check the commit and this Mac's connection, then run it again."
  fi
  [ -s "$WORK/$f" ] || stop2 "$f of commit $COMMIT came down empty."
done

printf '%s\n' "-- embed-check-on-mac.sh — commit $COMMIT — the installed agent at $TREE is only used for its tsx; nothing in it is changed"
cd "$TREE" || stop2 "could not enter $TREE."
"$TSX" "$WORK/src/scripts/embed-check.ts" "$@"
