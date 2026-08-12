#!/bin/bash
#
#   pnpm local            open the dashboard on this Mac, against the SERVER's data
#   pnpm local offline     ... against the OLD local SQLite file instead
#
# ── WHY THIS SCRIPT EXISTS AT ALL ───────────────────────────────────────────
#
# "Run it on localhost" meant one thing before 2026-08-08 and means two things after, and
# the difference is not cosmetic — it decides WHICH DATABASE you are looking at:
#
#   live     the dashboard runs here, reading the SERVER's Postgres through the SSH
#            tunnel. Same data the hosted dashboard shows. Changes you make are REAL.
#            This is almost always what you want.
#
#   offline  the dashboard runs here against `prisma/dev.db`, the SQLite file this
#            project used until the migration. It is a FROZEN SNAPSHOT from the morning
#            of 2026-08-08 and does not update. Useful for poking at things without
#            touching anything real; misleading if you forget which one you are in.
#
# Getting that wrong is the kind of quiet mistake this project keeps designing against —
# reading yesterday's numbers and believing they are today's. So the script prints, in
# every run, which database it opened and how fresh it is.
#
# ── THE PART THAT IS EASY TO GET WRONG ──────────────────────────────────────
#
# The generated Prisma client is BAKED with its schema's provider, so switching database
# also means regenerating the client. Doing that by hand is exactly the step someone
# forgets, and the failure is an unhelpful adapter-mismatch error rather than anything
# that names the real problem. `scripts/prisma-client-for-env.sh` does it from the URL.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

MODE="${1:-live}"
PORT=3100

# Set when `live` was asked for and the server could not be reached — the dashboard still
# starts, on local data, and says so prominently rather than refusing.
FELL_BACK=""

case "$MODE" in
  live)
    # The tunnel is what makes the server's database reachable from here. It is normally
    # kept up by launchd (scripts/install-tunnel.sh); this is the check, not a substitute.
    #
    # ── THIS USED TO `exit 1`, AND THAT WAS WRONG ────────────────────────────
    #
    # Refusing to start protects against showing the wrong database, which is a real
    # concern in a project with two of them. But it solved that by making a LOCAL tool
    # depend on a REMOTE host: with the Linode down, or the laptop on a train, `pnpm local`
    # printed an instruction and quit — on a machine holding a perfectly good local
    # snapshot and every line of the code you wanted to look at.
    #
    # The dashboard now always starts. What the refusal was actually protecting — "do not
    # let someone read yesterday's numbers believing they are today's" — is handled by
    # saying loudly which database is open, which is done on every run anyway.
    if ! nc -z 127.0.0.1 15432 2>/dev/null; then
      if [[ -f prisma/dev.db ]]; then
        FELL_BACK="yes"
        MODE="offline"
        export DATABASE_URL="file:./prisma/dev.db"
      else
        echo "The server is unreachable and there is no local snapshot at prisma/dev.db,"
        echo "so there is no database to open at all."
        echo
        echo "  bash scripts/install-tunnel.sh status    is the tunnel up?"
        exit 1
      fi
    fi
    ;;

  offline)
    if [[ ! -f prisma/dev.db ]]; then
      echo "There is no local snapshot at prisma/dev.db."
      echo "Use:  pnpm local     (reads the server, through the tunnel)"
      exit 1
    fi
    # Only for this process and its children — the file on disk is not edited, so a stray
    # `pnpm dev` in another terminal cannot silently inherit the offline database.
    export DATABASE_URL="file:./prisma/dev.db"
    ;;

  *)
    echo "usage: pnpm local [live|offline]" >&2
    exit 1
    ;;
esac

# IS THE PORT FREE? Asked BEFORE anything is printed about opening a page.
#
# Found by running this: an older `pnpm start` still held 3100, and the script cheerfully
# announced "http://127.0.0.1:3100 — Ctrl+C to stop" before Next failed to bind. A URL
# printed by a process that did not start is worse than an error, because the page it
# names is SOMEBODY ELSE'S SERVER and it answers 200 — so the operator sees a working
# dashboard showing whatever database that other process is on. That is the exact
# "looking at one and thinking it is the other" failure this script exists to prevent.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already serving on port ${PORT}:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR>1 {print "  pid " $2 "  " $1}'
  echo
  echo "That is probably an earlier dashboard. Stop it, then run this again:"
  echo "  kill \$(lsof -t -nP -iTCP:${PORT} -sTCP:LISTEN)"
  exit 1
fi

bash scripts/prisma-client-for-env.sh

# WHICH DATABASE, AND HOW OLD — printed every time, because the whole risk of having two
# is looking at one and thinking it is the other.
echo
if [[ -n "$FELL_BACK" ]]; then
  # The one case someone could be misled: they asked for live data and are getting local.
  # It must not read like a footnote.
  echo "  ⚠ THE SERVER IS UNREACHABLE — showing the local snapshot instead."
  echo "    You asked for live data and this is NOT it. Detection may still be running on"
  echo "    the server; you just cannot see it from here."
  echo
  echo "  data:  the OLD local snapshot at prisma/dev.db"
  echo "         frozen — it does not update, and nothing you change here reaches the server"
  echo
  echo "  to get live data back:  bash scripts/install-tunnel.sh status"
elif [[ "$MODE" == "live" ]]; then
  echo "  data:  THE SERVER (live, through the tunnel on :15432)"
  echo "         anything you change here is real"
else
  echo "  data:  the OLD local snapshot at prisma/dev.db"
  echo "         frozen — it does not update, and the server does not see your changes"
fi

# Written to a temp file rather than passed to `tsx -e`, because the inline form does not
# resolve this project's `@/` path alias and silently fell through to the error branch —
# printing "could not read the database" about a database that was perfectly reachable.
PROBE="$(mktemp -t dsprobe).ts"
cat > "$PROBE" <<'PROBE_EOF'
import { prisma } from '@/lib/db'
const n = await prisma.detectedCampaign.count()
const newest = await prisma.detectedCampaign.findFirst({ orderBy: { detectedAt: 'desc' }, select: { detectedAt: true } })
const mins = newest ? Math.round((Date.now() - newest.detectedAt.getTime()) / 60000) : null
const age = mins === null ? 'never' : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
console.log(`  posts: ${n}, newest seen ${age}`)
process.exit(0)
PROBE_EOF
cp "$PROBE" src/scripts/_local_probe.ts
pnpm -s exec tsx src/scripts/_local_probe.ts 2>/dev/null || echo "  (could not read the database)"
rm -f src/scripts/_local_probe.ts "$PROBE"

echo
echo "  http://127.0.0.1:${PORT}   — Ctrl+C to stop"
echo

# `next dev` rather than a production build: this is the "I want to look at it" path, and
# waiting for a build to poke at a page is the friction that stops people looking.
#
# ── A LOCAL VIEWER MUST NOT BECOME A SECOND DETECTOR ────────────────────────
#
# `instrumentation.ts` starts the scheduler inside the dashboard's own process, which is
# right for the ONE machine that owns the schedule — that is what made hands-free true.
# It is wrong here, and FOUND BY RUNNING IT: the "frozen" SQLite snapshot had grown from
# 1,851 posts to 1,887, because earlier `pnpm local offline` runs had started a scheduler
# that detected into it. A file documented as frozen was quietly diverging from the server.
#
# Worse in the live case: a second scheduler against the SERVER's database. The heartbeat
# guard would usually catch it (whichever starts second declines), but relying on a race to
# stay correct is not a design, and a laptop opening a dashboard is not an event that
# should be able to affect what the fleet does at all.
#
# The switch already existed for exactly this — `EMBEDDED_SCHEDULER=false` — and was
# documented as being for "a server, say". A viewer is the same case.
export EMBEDDED_SCHEDULER=false
exec pnpm exec next dev -H 127.0.0.1 -p "$PORT"
