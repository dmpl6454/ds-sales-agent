#!/bin/bash
#
# Build the distributable Mac app image — ~/Downloads/DS-Sales-Agent.dmg.
#
# ── RUN THIS AFTER ANY MAJOR CHANGE. THE DMG IS PART OF THE DELIVERABLE ──────
#
# The image snapshots the repo at build time (git archive HEAD), and installed
# machines do NOT auto-update — a stale DMG hands a new operator last week's rules.
# Same standing rule as the pipeline diagram: when the system changes, the copy
# people hold must change with it. One command, no arguments:
#
#     bash scripts/build-dmg.sh
#
# ── WHAT THE IMAGE CONTAINS, AND WHAT IT MUST NEVER CONTAIN ──────────────────
#
# READ ME FIRST.txt and DS Sales Agent.app (launcher + installer + a git-archive
# tarball of HEAD). git archive honours .gitignore, so .env and every credential
# stay out BY CONSTRUCTION — and this script verifies that anyway, because "by
# construction" has gone stale in this repo before. The three secrets a new
# operator needs (DATABASE_URL, the tunnel key at ~/Downloads/ds_tunnel_key, the
# shared dashboard login) are handed over person to person, never shipped.
#
# ── SIGNED AND NOTARISED WHEN THE CERTIFICATE IS PRESENT (2026-09-03) ────────
#
# macOS 15 removed the right-click → Open bypass, so an unsigned build dead-ends at "Apple
# could not verify …" with a single Done button — measured on another operator's Mac. With a
# Developer ID Application certificate in the keychain this script signs the app with the
# hardened runtime, notarises it, staples the ticket to BOTH the app and the image, and
# verifies the result the way Gatekeeper will. A double-click then just works.
#
# WITHOUT the certificate it still builds, unsigned, and says so loudly: a laptop that cannot
# sign must not lose the ability to produce an image, and a silent unsigned build is how a
# blocked DMG reaches somebody's Mac again.
#
#   DS_SIGN_ID         override the identity (default: the first Developer ID Application)
#   DS_NOTARY_PROFILE  notarytool keychain profile  (default: ds-notary)
#   DS_SKIP_NOTARY=1   sign but do not notarise — for a quick local build
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DS_DMG_OUT:-$HOME/Downloads/DS-Sales-Agent.dmg}"
STAGE="$(mktemp -d /tmp/ds-dmg-stage.XXXXXX)"
APP="$STAGE/DS Sales Agent.app"
trap 'rm -rf "$STAGE"' EXIT   # widened to include $WORK once the signing section defines it

cd "$REPO"

# Refuse to snapshot a dirty tree: the archive is HEAD, and shipping while edits
# sit uncommitted means the DMG and the deploy silently differ.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: the working tree has uncommitted changes — commit (or stash) first, so the DMG matches HEAD." >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$REPO/scripts/dmg/Info.plist" "$APP/Contents/Info.plist"
cp "$REPO/scripts/dmg/install.sh" "$APP/Contents/Resources/install.sh"
cp "$REPO/scripts/dmg/launcher.sh" "$APP/Contents/Resources/launcher.sh"
cp "$REPO/scripts/dmg/README.txt" "$STAGE/READ ME FIRST.txt"

# THE EXECUTABLE IS A COMPILED UNIVERSAL BINARY, and the shell logic is a RESOURCE beside it.
# Hardened runtime — which notarisation requires — is a Mach-O load command, so a bundle whose
# CFBundleExecutable is a script cannot carry it. The stub is 20 lines and execs the script,
# which stays sealed by the same signature. Both architectures, so an Intel Mac runs it too.
clang -arch arm64 -arch x86_64 -O2 -Wall -Wextra -mmacosx-version-min=12.0 \
  -o "$APP/Contents/MacOS/ds-sales-agent" "$REPO/scripts/dmg/launcher.c"
chmod +x "$APP/Contents/MacOS/ds-sales-agent" "$APP/Contents/Resources/install.sh" "$APP/Contents/Resources/launcher.sh"

git archive --format=tar.gz -o "$APP/Contents/Resources/ds-sales-agent.tar.gz" HEAD
# THE IMAGE KNOWS ITS OWN COMMIT (2026-09-08). The launcher compares this against the build an
# installed Mac is running and re-runs the installer when the image is newer — until now a
# completed install turned the .app into a dashboard shortcut for life, so handing someone a
# newer DMG changed nothing on their Mac. Written INSIDE Resources, before signing, so it is
# sealed with everything else.
git rev-parse --short HEAD > "$APP/Contents/Resources/VERSION"

# The verification, not the construction: no secret may ride along.
if tar -tzf "$APP/Contents/Resources/ds-sales-agent.tar.gz" | grep -qE '(^|/)\.env$|ds_tunnel_key|\.pem$'; then
  echo "error: the archive contains a credential-shaped file — NOT building the image." >&2
  exit 1
fi

# ── SIGN ──────────────────────────────────────────────────────────────────
SIGN_ID="${DS_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')}"
NOTARY_PROFILE="${DS_NOTARY_PROFILE:-ds-notary}"
WORK="$(mktemp -d /tmp/ds-dmg-work.XXXXXX)"
trap 'rm -rf "$STAGE" "$WORK"' EXIT

if [ -n "$SIGN_ID" ]; then
  echo "signing as: $SIGN_ID"
  # One codesign of the bundle seals the resources and signs the main executable. There is no
  # nested code to sign first — the scripts are resources, not Mach-O.  --timestamp is required
  # for notarisation, and a signature without it silently expires with the certificate.
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'
else
  echo
  echo "WARNING: no Developer ID Application certificate found — building an UNSIGNED image."
  echo "         On macOS 15 a double-click on it is refused outright; the README's Terminal"
  echo "         line is the only way in. Install the certificate to fix this properly."
  echo
fi

# ── NOTARISE THE APP, so the ticket travels with it out of the image ──────
NOTARISED=no
if [ -n "$SIGN_ID" ] && [ "${DS_SKIP_NOTARY:-0}" != "1" ]; then
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "notarising the app (this takes a few minutes)…"
    ditto -c -k --keepParent "$APP" "$WORK/app.zip"
    xcrun notarytool submit "$WORK/app.zip" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 | sed 's/^/  /'
    # Stapling the APP as well as the image is deliberate: a stapled image proves nothing
    # about the app once it has been dragged to /Applications, and Gatekeeper would then have
    # to ask Apple online — which fails on a Mac that is offline at first launch.
    xcrun stapler staple "$APP" 2>&1 | sed 's/^/  /'
    NOTARISED=yes
  else
    echo
    echo "WARNING: no notarytool profile '$NOTARY_PROFILE' — signed but NOT notarised."
    echo "         Create it once:  xcrun notarytool store-credentials $NOTARY_PROFILE \\"
    echo "                            --apple-id <appleid> --team-id <TEAMID> --password <app-specific-password>"
    echo
  fi
fi

# ── AN UNNOTARISED IMAGE NEVER TAKES THE DOWNLOAD IMAGE'S PLACE (2026-09-10) ─────────────
# MEASURED: the notary keychain profile vanished between two builds; this script warned,
# built anyway, overwrote ~/Downloads/DS-Sales-Agent.dmg, and deploy.sh uploaded it — so the
# hosted download button served an image Gatekeeper rejects ("Apple could not verify…") for
# an afternoon. A signed-but-unnotarised build is fine for a quick local look and useless on
# another person's Mac; it is written BESIDE the real image under a name that says so.
if [ -n "$SIGN_ID" ] && [ "${DS_SKIP_NOTARY:-0}" != "1" ] && [ "$NOTARISED" != yes ]; then
  OUT="${OUT%.dmg}.UNNOTARISED.dmg"
  echo "WARNING: writing the UNNOTARISED image to $OUT — the download image is untouched."
fi
rm -f "$OUT"
hdiutil create -volname "DS Sales Agent" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null

# ── SIGN AND NOTARISE THE IMAGE ITSELF ────────────────────────────────────
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp --sign "$SIGN_ID" "$OUT"
  if [ "$NOTARISED" = yes ]; then
    echo "notarising the image…"
    xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 | sed 's/^/  /'
    xcrun stapler staple "$OUT" 2>&1 | sed 's/^/  /'
  fi
fi

# ── VERIFY THE WAY GATEKEEPER WILL, on the FINAL image ────────────────────
# Not on the staging copy: what a person receives is this file, and every earlier step is a
# claim about it. Mount it and ask spctl, which is the assessment a double-click performs.
if [ -n "$SIGN_ID" ]; then
  MNT="$(hdiutil attach -readonly -nobrowse "$OUT" | grep -o '/Volumes/.*$' | tail -1)"
  if [ -n "$MNT" ]; then
    echo "gatekeeper assessment of the shipped app:"
    spctl -a -vvv "$MNT/DS Sales Agent.app" 2>&1 | sed 's/^/  /' || true
    xcrun stapler validate "$MNT/DS Sales Agent.app" 2>&1 | sed 's/^/  /' || true
    hdiutil detach "$MNT" -quiet || true
  fi
fi

# A sidecar beside the image, uploaded by deploy.sh next to the DMG the dashboard serves, so
# /senders can name the installer's build beside each paired Mac's own.
git rev-parse --short HEAD > "$OUT.version"
echo "built:  $OUT  ($(du -h "$OUT" | cut -f1 | tr -d ' '))  from $(git rev-parse --short HEAD)"
echo "signed: ${SIGN_ID:-NO — unsigned, macOS 15 will refuse a double-click}"
echo "ticket: $NOTARISED"
echo "key:    ~/Downloads/ds_tunnel_key (send privately, per person)"
echo "login:  the shared viewer account + the DATABASE_URL from .env — hand over person to person"
