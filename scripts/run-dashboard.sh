#!/bin/bash
#
# The dashboard process launchd actually runs — see install-dashboard.sh for the design.
#
# Kept as its own file rather than a `bash -c` one-liner in the plist, because a plist
# edit needs a reinstall to take effect while this file is read fresh on every restart —
# and because the port-wait below is real logic that deserves to be readable.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

PORT=3100

# A failed `pnpm test` leaves the generated Prisma client on SQLite; starting the
# dashboard onto it produces the adapter-mismatch crash-loop the device agent already
# paid for once. This regenerates only when the client and DATABASE_URL disagree.
bash scripts/prisma-client-for-env.sh

if [[ ! -f .next/BUILD_ID ]]; then
  echo "no production build at .next/ — run: pnpm build && bash scripts/install-dashboard.sh restart" >&2
  # Exit rather than spin: launchd's ThrottleInterval paces the retries, and the status
  # subcommand points here.
  sleep 60
  exit 1
fi

# WAIT for the port rather than fighting for it: a hand-run `pnpm local` (dev) owns :3100
# legitimately, and a KeepAlive job that exits on a busy port would steal it back the
# moment the person stopped their dev server to look at something.
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  echo "port ${PORT} is busy (probably a hand-run dashboard) — waiting"
  sleep 30
done

# EMBEDDED_SCHEDULER=false and DS_QUERY_COUNT=1 arrive from the plist environment; the
# viewer must never become a second detector, and a server you cannot measure with
# `pnpm ig:layout` is a server nobody measures.
exec pnpm exec next start -H 127.0.0.1 -p "$PORT"
