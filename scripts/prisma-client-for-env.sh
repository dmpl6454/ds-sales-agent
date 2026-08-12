#!/bin/bash
#
# Generate the Prisma client that MATCHES THIS MACHINE'S DATABASE_URL.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
#
# The generated client is BAKED with its schema's provider — choosing a driver adapter at
# runtime is not enough, which was found by running it:
#
#     The Driver Adapter `@prisma/adapter-pg` ... is not compatible with the provider
#     `sqlite` specified in the Prisma schema.
#
# So the client is a BUILD artefact that must agree with the URL. Two things regenerate it
# behind your back and can leave the two disagreeing:
#
#   - `pnpm install`   — its postinstall runs plain `prisma generate` (SQLite).
#   - `pnpm test`      — the suite is SQLite-shaped (it builds temporary .db files and
#                        points the REAL client at them), so it regenerates SQLite too.
#
# MEASURED consequence, on this machine: running the test suite left the device agent
# unable to reach the server's Postgres — every command died on the mismatch above. Running
# the tests must not break the machine.
#
# So this script reads DATABASE_URL and generates the matching client. `pnpm test` calls it
# on the way OUT, restoring whatever this machine actually needs.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Read DATABASE_URL from the environment, falling back to .env — the same order the app
# resolves it in, so this can never disagree with what the app will use.
URL="${DATABASE_URL:-}"
if [[ -z "$URL" && -f .env ]]; then
  URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi

if [[ "$URL" == postgres://* || "$URL" == postgresql://* ]]; then
  pnpm exec prisma generate --config prisma.postgres.config.ts >/dev/null
  echo "prisma client: postgresql (matches DATABASE_URL)"
else
  pnpm exec prisma generate >/dev/null
  echo "prisma client: sqlite (matches DATABASE_URL)"
fi
