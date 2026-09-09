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
# The build runs WHILE the old build serves and the workers reload without a gap — see the
# BUILD WHILE SERVING block. `.env` is never shipped. It is the most important exclusion here: the server's
# SEND_ENABLED=false and AUTOPILOT_ENABLED=false hard floors, its DATABASE_URL and its
# DS_DEVICE_NAME all differ from a laptop's, and overwriting them once put the developer's
# environment on the server.
set -euo pipefail

HOST="${DS_DEPLOY_HOST:-linode}"

# ── THE SHARED LINODE IS OFF LIMITS (9 Sept 2026) ────────────────────────────
# Our processes on 172.105.53.101 — the production box of dashmani-platform, 91 people's
# working day — contributed to its 5h44m outage on 8 Sept: a 655 MB `next build` of ours
# tipped the kernel into OOM-killing their API, our OCR children and two web workers ate
# 370-700 MB of a 2 GB box, and our worker's pm2 restarts force-killed a pnpm wrapper. Our
# processes there were stopped by the platform owner and MUST NOT be started again. This
# refusal is the rule enforced rather than written down; DS_ALLOW_SHARED_HOST=1 is the
# deliberate override for a one-off read, never for a deploy.
if [[ "$HOST" == *172.105.53.101* && "${DS_ALLOW_SHARED_HOST:-0}" != "1" ]]; then
  echo "refusing: $HOST is the shared dashmani-platform Linode. Our stack was taken off it on 9 Sept 2026" >&2
  echo "after the 8 Sept outage; deploy to the dedicated box instead (DS_HOST=...). See CLAUDE.md, 9 September." >&2
  exit 1
fi

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
  # The build the image carries (written by build-dmg.sh), so /senders can show it beside each
  # paired Mac's own agent build (2026-09-08).
  if [[ -f "$DMG.version" ]]; then
    scp -q "$DMG.version" "$HOST:~/.ds-sales-agent-data/DS-Sales-Agent.dmg.version"
    echo "    installer build $(cat "$DMG.version")"
  fi
else
  echo "==> No local installer at $DMG — the download button will report it unpublished"
fi

# ── BUILD ON THIS MAC, SHIP THE DIRECTORY (2026-09-08) ──────────────────────
# The Linode (1 vCPU, 2 GB, ~1.3 GB in swap) OOM-killed `next build` THREE times on 8 Sept at
# ~440 MB RSS and went unresponsive for minutes each time, while the dashboard served the
# previous day's build. The web tier is therefore built HERE, into the dist dir the server is
# NOT serving, and shipped as a tarball; the server only unpacks and reloads. `.next` output is
# JavaScript + JSON — native modules (sharp, better-sqlite3) load from the server's own
# node_modules at runtime, which `pnpm install` below keeps in step with the lockfile.
#
# The generated Prisma client is BUNDLED into the build, so the local client must be the
# Postgres one: this refuses if DATABASE_URL here is not Postgres rather than shipping a
# SQLite-baked dashboard to a Postgres server. DS_PREBUILT=0 restores the server-side build.
PREBUILT_TARGET=""
VERSION_SHA="$(git rev-parse --short HEAD)"
if [[ "${DS_PREBUILT:-1}" == "1" ]]; then
  case "$(grep -o '^DATABASE_URL="\?[a-z]*' .env 2>/dev/null | head -1)" in
    *postgres*) ;;
    *) echo "error: .env DATABASE_URL must be Postgres to prebuild the web tier (the generated client is bundled). DS_PREBUILT=0 builds on the server instead." >&2; exit 1 ;;
  esac
  bash scripts/prisma-client-for-env.sh >/dev/null
  REMOTE_ACTIVE="$(ssh "$HOST" "cat '$DIR/.active-dist' 2>/dev/null || echo .next")"
  if [[ "$REMOTE_ACTIVE" == ".next-a" ]]; then PREBUILT_TARGET=.next-b; else PREBUILT_TARGET=.next-a; fi
  echo "==> Building $PREBUILT_TARGET on this Mac (the server serves $REMOTE_ACTIVE and cannot build)"
  rm -rf "$PREBUILT_TARGET"
  if ! NEXT_DIST_DIR="$PREBUILT_TARGET" pnpm build > /tmp/ds-build-local.log 2>&1; then
    echo "BUILD FAILED on this Mac — nothing was shipped and the server is untouched. Tail:"
    tail -30 /tmp/ds-build-local.log
    exit 1
  fi
  echo "    built $(cat "$PREBUILT_TARGET/BUILD_ID") as $VERSION_SHA; shipping (webpack cache excluded)"
  tar czf /tmp/ds-dist.tgz --exclude="$PREBUILT_TARGET/cache" "$PREBUILT_TARGET"
  scp -q /tmp/ds-dist.tgz "$HOST:/tmp/ds-dist.tgz"
fi
echo "$VERSION_SHA" > /tmp/ds-version
scp -q /tmp/ds-version "$HOST:/tmp/ds-version"

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

# ── BUILD WHILE SERVING, THEN SWITCH WITHOUT A GAP (2026-09-03) ────────────
# The old shape was pm2 stop → build (~2 min on this one-vCPU box) → pm2 start, and every 5xx
# the hosted dashboard served today was one of those windows. Now: the build goes into the
# OTHER of .next-a / .next-b (\`NEXT_DIST_DIR\`, read by next.config.ts) while the current one
# keeps serving; only when it has SUCCEEDED do the cluster workers reload onto it, one at a time,
# so a request always has a worker to land on. A failed build leaves the running site untouched.
# The build is niced: on one vCPU it would otherwise starve the page renders it is meant to
# replace.
ACTIVE=\$(cat .active-dist 2>/dev/null || echo .next)
if [[ "\$ACTIVE" == ".next-a" ]]; then TARGET=.next-b; else TARGET=.next-a; fi
if [[ -n "$PREBUILT_TARGET" ]]; then
  # Built on the Mac (see above). The target was chosen from THIS server's .active-dist a
  # moment ago, so it is the directory not being served; unpack over it and never touch ACTIVE.
  TARGET="$PREBUILT_TARGET"
  echo "==> Unpacking the prebuilt \$TARGET while \$ACTIVE keeps serving"
  rm -rf "\$TARGET"
  tar xzf /tmp/ds-dist.tgz
  [[ -f "\$TARGET/BUILD_ID" ]] || { echo "the shipped \$TARGET has no BUILD_ID — refusing to switch to it"; exit 1; }
  # FOUND BY RUNNING IT (8 Sept): the first prebuilt deploy answered HTTP 500 with "Cannot find
  # module @prisma/client-<hash>/runtime/client". Turbopack externalises the native and heavy
  # packages (pg, better-sqlite3, patchright, node-cron, @prisma/*) as RELATIVE symlinks under
  # <dist>/node_modules into node_modules/.pnpm/<name>@<ver>_<peer-suffix>/ — and that suffix is
  # spelled differently by pnpm 9 (the Mac) and pnpm 10 (here), so every link dangled. Each is
  # re-pointed at THIS machine's copy of the same package; a package this machine lacks is
  # reported, never silently left dangling.
  find "\$TARGET/node_modules" -type l | while read -r link; do
    rel="\${link#\$TARGET/node_modules/}"; pkg="\${rel%-*}"
    if [[ -e "node_modules/\$pkg" ]]; then
      ln -sfn "\$(readlink -f "node_modules/\$pkg")" "\$link"
    else
      echo "    WARNING: no local copy of \$pkg for \$link — that module will fail to load"
    fi
  done
  # The build machine's absolute path is recorded in required-server-files; make it this one's.
  sed -i "s|$PWD|$DIR|g" "\$TARGET/required-server-files.json" "\$TARGET/required-server-files.js" 2>/dev/null || true
else
  echo "==> Building into \$TARGET while \$ACTIVE keeps serving"
  rm -rf "\$TARGET"
  if ! NEXT_DIST_DIR="\$TARGET" nice -n 15 ionice -c 3 pnpm build > /tmp/ds-build.log 2>&1; then
    echo
    echo "BUILD FAILED. The running build (\$ACTIVE) was never touched and is still serving."
    echo "The tail of the log:"
    echo
    tail -30 /tmp/ds-build.log
    echo
    echo "Fix it, then run this script again. Full log on the server: /tmp/ds-build.log"
    exit 1
  fi
fi
echo "\$TARGET" > .active-dist
# The build stamp for the tsx-run processes here (the worker) — src/lib/buildVersion.ts reads it.
cp /tmp/ds-version .version

# ── WHICH BOX AM I TALKING TO? (9 Sept 2026) ────────────────────────────────
# During the migration this Mac's tunnel was pointed at the NEW box by editing the
# `ds-linode` alias — and `install-tunnel.sh` defaults to `linode`, a DIFFERENT alias that
# was still on the old one. Everything looked right: the port answered, the database was
# named ds_sales_agent, and 933 prospects came back, because BOTH boxes held a copy. Only a
# row that exists on one box settled it. The deploy writes it now, so it can never be a
# stale claim: the box that last deployed says so itself, and one query answers
# "am I connected to the box I think I am".
sudo -u postgres psql -qtA -d ds_sales_agent -c "insert into \"Setting\"(key,value,\"updatedAt\") values('boxMarker','\$(curl -4 -s -m 5 ifconfig.me || hostname)',now()) on conflict (key) do update set value=excluded.value, \"updatedAt\"=now()" >/dev/null 2>&1 || true

# The web process runs as a pm2 CLUSTER of two workers so \`pm2 reload\` can replace them one
# at a time. A legacy fork-mode process (\`pnpm start\`) is converted here once — the only
# deploy that still costs a few seconds.
# 450M x 2 workers = 900M worst case on a 2GB box shared with six other pm2 apps.
# ── THE WEB TIER IS SIZED FROM THIS BOX'S OWN RAM (9 Sept 2026) ─────────────
# The cluster has two workers so `pm2 reload` can replace them one at a time and a request
# always has somewhere to land (3 Sept). That costs 2 x 300 MB of heap plus RSS, which a
# 961 MB box cannot pay beside Postgres, the detection worker and an OCR child — so below
# ~1.5 GB it runs ONE worker and a deploy costs a ~2 second gap instead of an OOM kill.
# DERIVED, never a remembered flag: resize the box and the next deploy restores the
# zero-gap design on its own.
RAM_MB=\$(free -m | awk '/^Mem:/{print \$2}')
if [[ "\${DS_WEB_WORKERS:-auto}" != auto ]]; then WEB_WORKERS="\$DS_WEB_WORKERS"
elif (( RAM_MB < 1500 )); then WEB_WORKERS=1
else WEB_WORKERS=2; fi
WEB_HEAP_DEFAULT=\$(( WEB_WORKERS == 1 ? 256 : 300 ))
# THE RSS CEILING MUST SIT ABOVE THE SERVER'S ORDINARY WORKING SET, OR IT IS A TRIGGER, NOT A
# BACKSTOP (measured 9 Sept 2026 on the 961 MB box): with a 256 MB heap, rendering the seven
# dashboard pages takes next-server to 415-546 MB RSS, and a 350M ceiling soft-reloaded the
# single worker 57 TIMES IN ONE DAY — pm2 samples every 30 s and reloads the moment RSS is over
# the line. A soft reload starts the NEW process before stopping the old, so each memory-
# triggered reload briefly ran TWO Next processes on a box that cannot afford one and a half.
# Zero 5xx resulted, which is exactly why nobody noticed. 560M clears every measured render;
# a genuine runaway is still caught well before the kernel acts.
WEB_MEM_DEFAULT=\$(( WEB_WORKERS == 1 ? 560 : 450 ))
echo "==> This box has \${RAM_MB} MB: \${WEB_WORKERS} web worker(s), \${WEB_HEAP_DEFAULT} MB heap each"
WEB_MAX_MEM="\${DS_WEB_MAX_MEM:-\${WEB_MEM_DEFAULT}M}"
# THREE LAYERS OF MEMORY DEFENCE, AND WHY THE pm2 CEILING ALONE WAS NOT ENOUGH (2026-09-04).
# The kernel OOM-killed next-server TWICE that day (773MB and 607MB anon-rss) WITH the 450M pm2
# ceiling live: pm2 samples memory every ~30s, and a render pile-up on a swapping 1-vCPU box
# outran it. So:
#   1. V8's own cap (--max-old-space-size) is the DETERMINISTIC layer — the heap physically
#      cannot pass it; a runaway worker throws inside the process and pm2 restarts just that
#      worker while its sibling keeps serving. A normal render peaks at +22..32MB heap
#      (measured), so 300MB is ten renders of headroom, not a squeeze.
#   2. the pm2 ceiling stays as the RSS backstop;
#   3. /etc/systemd/system/pm2-root.service.d/oom.conf sets OOMPolicy=continue, so if the
#      kernel ever does act, it kills ONE process instead of systemd stopping the WHOLE pm2
#      service — which is what took every app on this shared box down with ours, twice.
# HOW EACH CAP REACHES ITS PROCESS DIFFERS, and getting it wrong is silent: in CLUSTER mode
# pm2 injects env into process.env from JavaScript AFTER Node has started, so a NODE_OPTIONS
# env var is inert for a V8 startup flag — it must be node_args (pm2 --node-args), which
# \`pm2 reload --node-args\` applies with a rolling restart (verified live). The worker is a
# DIRECT node process since 9 Sept 2026 (below), so node_args reaches it too; NODE_OPTIONS was
# the right carrier only while a pnpm wrapper sat between pm2 and node.
WEB_HEAP_MB="\${DS_WEB_HEAP_MB:-\$WEB_HEAP_DEFAULT}"
WORKER_HEAP_MB="\${DS_WORKER_HEAP_MB:-\$(( RAM_MB < 1500 ? 384 : 512 ))}"
WEB_NODE_ARGS="--max-old-space-size=\$WEB_HEAP_MB"
MODE=\$(pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const p=l.find(p=>p.name==="ds-sales-agent");console.log(p?p.pm2_env.exec_mode:"absent")')
if [[ "\$MODE" == "cluster_mode" ]]; then
  echo "==> Reloading the web workers onto \$TARGET (no gap)"
  NEXT_DIST_DIR="\$TARGET" pm2 reload ds-sales-agent --node-args="\$WEB_NODE_ARGS" --update-env >/dev/null
else
  echo "==> Converting ds-sales-agent to a two-worker cluster (one-time; a few seconds)"
  pm2 delete ds-sales-agent >/dev/null 2>&1 || true
  NEXT_DIST_DIR="\$TARGET" pm2 start node_modules/next/dist/bin/next --name ds-sales-agent -i "\$WEB_WORKERS" --node-args="\$WEB_NODE_ARGS" --max-memory-restart "\$WEB_MAX_MEM" --cwd "$DIR" -- start -H 127.0.0.1 -p 3100 >/dev/null
fi
# The web workers MUST carry a memory ceiling, and this line is the only thing that keeps it
# after a cluster is rebuilt. Without it \`next-server\` grows unbounded, the KERNEL picks the
# victim, and systemd restarts the WHOLE pm2 service — every app on this shared box goes down
# together (measured 2026-09-04 05:00 UTC: next-server killed at 773MB, all 8 apps restarted,
# and 4 more the same way on 2 Sep). A pm2 ceiling turns that into ONE worker recycling while
# its sibling keeps serving, which is the entire reason the cluster has two.
# \`pm2 reload\` does NOT apply a changed ceiling to a running cluster, so set it on the live
# process too — otherwise this only takes effect on the next cluster rebuild.
# A CHANGED ceiling is applied the same way (9 Sept 2026): the first version rebuilt only when
# the ceiling was ABSENT, so correcting a wrong number needed a hand rebuild nobody would
# remember — the 350M trigger above stayed live through two deploys. Compare against the
# value THIS deploy wants, in the bytes pm2 stores. DS_WEB_MAX_MEM is written as NNNM.
WEB_MAX_MEM_BYTES=\$(( \${WEB_MAX_MEM%M} * 1048576 ))
CURRENT_MEM=\$(pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const p=l.find(p=>p.name==="ds-sales-agent");console.log(p&&p.pm2_env.max_memory_restart?p.pm2_env.max_memory_restart:0)')
if [[ "\$CURRENT_MEM" != "\$WEB_MAX_MEM_BYTES" ]]; then
  echo "==> Web memory ceiling is \$CURRENT_MEM bytes, this deploy wants \$WEB_MAX_MEM — rebuilding the cluster (a few seconds)"
  pm2 delete ds-sales-agent >/dev/null 2>&1 || true
  NEXT_DIST_DIR="\$TARGET" pm2 start node_modules/next/dist/bin/next --name ds-sales-agent -i "\$WEB_WORKERS" --node-args="\$WEB_NODE_ARGS" --max-memory-restart "\$WEB_MAX_MEM" --cwd "$DIR" -- start -H 127.0.0.1 -p 3100 >/dev/null
fi
# Detection runs in its OWN process (ds-sales-worker) so a heavy pass cannot OOM the web
# server and 502 the dashboard (2026-09-02). It reads source via tsx, so it must be
# restarted too or it keeps running the code from before this deploy.
#
# THE WORKER IS ONE NODE PROCESS, STARTED DIRECTLY — NEVER \`pm2 start pnpm -- worker\` (9 Sept
# 2026, rule 15). Under the wrapper pm2 measured pnpm's 0.6 MB and never the 100 MB worker, so
# --max-memory-restart was inert; and pm2's SIGINT reached sh, not node, so every restart
# logged "failed to kill – retrying" until pm2 SIGKILLed the tree and orphaned any OCR child.
# That is the same blind spot that hid the other team's API hang on the shared box.
# \`node --import tsx src/worker/index.ts\` is a SINGLE process: the cap measures the real
# worker, SIGINT lands on the handler in worker/index.ts, and the OCR child is killed with it.
# Verified under pm2 on this box: interpreter node, zero child processes, zero SIGKILLs.
# The definition is REBUILT when it differs from this one (wrapper, cap or node args), so a
# hand-started worker cannot keep the old shape unnoticed; otherwise it is a plain restart.
WORKER_MAX_MEM="\${DS_WORKER_MAX_MEM:-\$(( RAM_MB < 1500 ? 500 : 700 ))M}"
WORKER_MAX_MEM_BYTES=\$(( \${WORKER_MAX_MEM%M} * 1048576 ))
WORKER_NODE_ARGS="--import tsx --max-old-space-size=\$WORKER_HEAP_MB"
WANT_WORKER="$DIR/src/worker/index.ts|\$WORKER_NODE_ARGS|\$WORKER_MAX_MEM_BYTES"
HAVE_WORKER=\$(pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const p=l.find(p=>p.name==="ds-sales-worker");if(!p){console.log("absent");process.exit()}const e=p.pm2_env;console.log([e.pm_exec_path,(e.node_args||[]).join(" "),e.max_memory_restart||0].join("|"))')
if [[ "\$HAVE_WORKER" == "\$WANT_WORKER" ]]; then
  echo "==> Restarting the detection worker onto this build"
  pm2 restart ds-sales-worker --update-env >/dev/null
else
  echo "==> Detection worker is [\$HAVE_WORKER] — rebuilding it as a direct node process with a \$WORKER_MAX_MEM ceiling"
  pm2 delete ds-sales-worker >/dev/null 2>&1 || true
  pm2 start src/worker/index.ts --name ds-sales-worker --interpreter node --node-args="\$WORKER_NODE_ARGS" --max-memory-restart "\$WORKER_MAX_MEM" --kill-timeout 20000 --cwd "$DIR" >/dev/null
fi
sleep 8
# The Linode has ONE vCPU. Detection/OCR in the worker competed with page renders for it and
# the dashboard took 3-12s per page (load average hit 49, measured 2026-09-02). The web is what
# a person is waiting on; detection is background — so the worker yields CPU and disk to it.
for p in \$(pgrep -f 'src/worker/index'); do renice -n 15 -p \$p >/dev/null 2>&1; ionice -c 3 -p \$p 2>/dev/null; done

CODE=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/sign-in || echo 000)
echo "    dashboard answered HTTP \$CODE from \$TARGET"
[[ "\$CODE" == "200" ]] || { echo "    the dashboard is NOT serving — check pm2 logs"; exit 1; }

# The previous build is removed only once the new one answers, so a rollback is one
# \`NEXT_DIST_DIR=<old> pm2 reload ds-sales-agent --update-env\` away until this line.
if [[ "\$ACTIVE" != "\$TARGET" && -d "\$ACTIVE" ]]; then rm -rf "\$ACTIVE"; fi
pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0));for(const p of l.filter(p=>p.name.startsWith("ds-sales")))console.log("    "+p.name+" "+p.pm2_env.status+" mode="+p.pm2_env.exec_mode+" pid="+p.pid)'
REMOTE

echo
echo "==> Deployed."
