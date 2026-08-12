#!/bin/bash
#
# Generate prisma/schema.postgres.prisma FROM prisma/schema.prisma.
#
# ── WHY A GENERATED FILE AND NOT A SECOND HAND-EDITED SCHEMA ────────────────
#
# Prisma's `provider` must be a literal — it is needed at schema-parse time to validate
# types — so a project running SQLite on a laptop and Postgres on a server genuinely needs
# two schema files. The question is only whether the second one is WRITTEN or DERIVED.
#
# Written is how this codebase's most repeated bug happens. `gate.ts`, `readThread.ts`, the
# two Connect buttons and the frame check all diverged because one rule had two copies and
# a fix landed in one of them. Two hand-maintained schemas is that failure with the DATA
# MODEL as its subject: a column added to one and not the other is a migration that works
# on a laptop and fails in production, or worse, succeeds and silently drops a field.
#
# So the Postgres schema is generated, never edited, and `tests/schema-parity.test.ts`
# asserts the generated file matches what this script would produce right now. Editing
# prisma/schema.prisma is the only supported way to change the data model.
#
# ── WHAT ACTUALLY DIFFERS ───────────────────────────────────────────────────
#
# Only the datasource provider and the migrations directory. Every model, field, index and
# relation is byte-identical, which is possible because the schema was written for SQLite
# and therefore already avoids everything Postgres would do differently: no arrays (JSON
# strings), no enums (String with the allowed set in a comment), no native types.
#
# That is also the reason NOT to "improve" those columns during this move. On Postgres they
# would idiomatically be `text[]` and enums — and changing column semantics in the same
# change as changing the host means a failure could be either. `readStringArray` and
# `readRecord` already isolate the difference. Do it later, deliberately, or not at all.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/prisma/schema.prisma"
OUT="$REPO/prisma/schema.postgres.prisma"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

{
  echo "// GENERATED FILE — DO NOT EDIT."
  echo "//"
  echo "// Produced by scripts/make-postgres-schema.sh from prisma/schema.prisma."
  echo "// Edit THAT file and re-run the script; tests/schema-parity.test.ts fails if this"
  echo "// file and the source ever disagree, because two hand-maintained schemas is the"
  echo "// same one-rule-two-copies drift that has bitten this codebase four times."
  echo "//"
  echo "// The ONLY differences from the source are the datasource provider and the"
  echo "// migrations directory. Postgres migrations are different SQL from SQLite ones, so"
  echo "// they cannot share a lineage."
  echo ""
  # Only the datasource provider changes. The generator OUTPUT deliberately stays the same
  # path, because of something only running it revealed:
  #
  #   PrismaClientInitializationError: The Driver Adapter `@prisma/adapter-pg` ... is not
  #   compatible with the provider `sqlite` specified in the Prisma schema.
  #
  # The generated client is BAKED with its schema's provider — choosing an adapter at
  # runtime is not enough. So each host generates its own client from its own schema into
  # the one import path (`@/generated/prisma/client`), and the switch is a BUILD step
  # rather than a runtime branch. A laptop runs `prisma generate`; the server runs
  # `prisma generate --config prisma.postgres.config.ts`. One client per host, always
  # matching that host's database.
  sed \
    -e 's|^  provider = "sqlite"$|  provider = "postgresql"|' \
    "$SRC"
} > "$OUT"

echo "wrote $OUT"

# Prove the swap actually happened rather than trusting sed silently matching nothing —
# a generated file that is byte-identical to its source would be a SQLite schema wearing a
# Postgres filename, and `prisma migrate` would then produce SQLite DDL against Postgres.
if ! grep -q 'provider = "postgresql"' "$OUT"; then
  echo "error: the provider was not swapped — is the datasource block still 'sqlite'?" >&2
  exit 1
fi
if grep -q 'provider = "sqlite"' "$OUT"; then
  echo "error: a sqlite provider survived into the generated file" >&2
  exit 1
fi

echo "verified: provider is postgresql, no sqlite provider remains"
