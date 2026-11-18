#!/bin/bash
# mac-build-dmg.sh — build the signed, notarised installer image ON A MAC, from a pinned commit.
#
# Run it as a FILE, in Terminal, as yourself (never with sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<commit>/scripts/mac-build-dmg.sh -o /tmp/mdmg.sh && bash /tmp/mdmg.sh <commit>
#
# WHY THIS EXISTS (18 Nov 2026). The image is built by scripts/build-dmg.sh, which needs macOS (clang, hdiutil,
# codesign, notarytool) and a git checkout. The Mac that used to build it — and held the Developer ID certificate's
# private key — is gone, and the sending Mac Studio was installed FROM an image, so it has no checkout. This makes a
# fresh, clean checkout of exactly one commit (the repository is public, so no key is needed), checks what signing
# needs before spending any time, and runs build-dmg.sh unchanged. It touches nothing of the installed agent: the
# checkout lives in ~/ds-dmg-build, and the image is written to ~/Downloads under a name carrying its commit, so the
# image you have now is not overwritten.
#
# WHAT IT NEEDS, and what it says when something is missing:
#   - Xcode command line tools (clang, git, notarytool)         → it prints the one install command
#   - a "Developer ID Application" certificate in the keychain   → it prints how to get one, and STOPS
#   - the notarytool keychain profile "ds-notary"                → it prints how to create it, and STOPS
#
#   DS_UNSIGNED_FOR_THIS_MAC=1   build without a certificate. The image then opens ONLY on the Mac that built it
#                                (it was never downloaded, so Gatekeeper never sees it); on anyone else's Mac,
#                                macOS refuses it. Fine for updating the Mac Studio itself; useless to hand out.
#
# Exit codes: 0 built · 2 refused (wrong machine, sudo, bad commit) · 3 something it needs is missing · 4 the build failed
set -uo pipefail

REPO_URL="${DS_REPO_URL:-https://github.com/dmpl6454/ds-sales-agent.git}"   # override only for testing
COMMIT="${1:-}"

say()  { printf '%s\n' "$*"; }
stop() { local code="$1"; shift; say ""; say "-- STOPPED: $*"; exit "$code"; }

[[ "$(uname -s)" == "Darwin" ]] || stop 2 "this builds a Mac image and only runs on a Mac."
if [[ "$(id -u)" == "0" ]]; then stop 2 "do not run this with sudo — run it as yourself (the signing certificate lives in YOUR keychain)."; fi
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || stop 2 "give the commit to build, e.g.  bash $0 c2bb9a7"

say "-- mac-build-dmg.sh — building the installer image from commit $COMMIT"
say ""

# ── 1. TOOLS ────────────────────────────────────────────────────────────────────────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1 || ! command -v clang >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  say "Xcode command line tools are not installed. Install them (a window opens; takes a few minutes):"
  say "    xcode-select --install"
  stop 3 "then run this again."
fi
for t in hdiutil codesign security ditto; do command -v "$t" >/dev/null 2>&1 || stop 3 "'$t' is missing — this is not a standard macOS."; done
say "tools: ok ($(clang --version 2>/dev/null | head -n 1))"

# ── 2. SIGNING ──────────────────────────────────────────────────────────────────────────────────────────────────
# Without -v: an identity that exists but is not trusted (missing intermediate, expired) is listed with its reason,
# which is the line a person needs to see. With -v it would simply be absent.
IDS="$(security find-identity -p codesigning 2>/dev/null || true)"
VALID="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
if [[ -n "$VALID" ]]; then
  say "signing identity: $VALID"
elif [[ "${DS_UNSIGNED_FOR_THIS_MAC:-0}" == "1" ]]; then
  say "signing identity: NONE — building UNSIGNED, because DS_UNSIGNED_FOR_THIS_MAC=1."
  say "                  The image will open on THIS Mac only. Do not hand it to anyone."
else
  if grep -q "Developer ID Application" <<<"$IDS"; then
    say "A Developer ID Application certificate is in the keychain but macOS does not trust it:"
    grep "Developer ID Application" <<<"$IDS" | sed 's/^/    /'
    say ""
    say "The usual cause is the missing Apple intermediate. Download \"Developer ID - G2\" from"
    say "    https://www.apple.com/certificateauthority/  and double-click it, then run this again."
  else
    say "No Developer ID Application certificate is in this Mac's keychain. To make one (once per Mac, by the"
    say "holder of the Apple Developer account):"
    say "  1. Keychain Access → menu Keychain Access → Certificate Assistant → Request a Certificate From a"
    say "     Certificate Authority… → your email, \"Saved to disk\". This writes a .certSigningRequest file and"
    say "     creates the private key in THIS Mac's keychain."
    say "  2. developer.apple.com → Certificates → + → Developer ID Application (G2 Sub-CA) → upload that file →"
    say "     download the certificate → double-click it."
    say "  3. If macOS then says it is not trusted: download \"Developer ID - G2\" from"
    say "     https://www.apple.com/certificateauthority/ and double-click it too."
    say ""
    say "Or, to update ONLY this Mac without a certificate:"
    say "    DS_UNSIGNED_FOR_THIS_MAC=1 bash $0 $COMMIT"
  fi
  stop 3 "no usable signing identity."
fi

NOTARY_PROFILE="${DS_NOTARY_PROFILE:-ds-notary}"
if [[ -n "$VALID" ]]; then
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    say "notarisation profile: $NOTARY_PROFILE (ok)"
  else
    say "The notarisation profile \"$NOTARY_PROFILE\" is not in this Mac's keychain. Create it once — it asks for"
    say "an app-specific password, made at appleid.apple.com → Sign-In and Security → App-Specific Passwords:"
    say "    xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <the developer account's Apple ID> --team-id <its team ID>"
    say "(The team ID is on developer.apple.com → Membership.) Type the password at the prompt; never paste it into a chat."
    stop 3 "no notarisation profile — a signed but un-notarised image is refused on anyone else's Mac."
  fi
fi
say ""

# ── 3. A CLEAN CHECKOUT OF EXACTLY ONE COMMIT ───────────────────────────────────────────────────────────────────
BASE="$HOME/ds-dmg-build"
DIR="$BASE/$COMMIT"
mkdir -p "$BASE" || stop 4 "cannot create $BASE"
if [[ -d "$DIR/.git" ]]; then
  say "checkout: reusing $DIR"
else
  rm -rf "$DIR"
  say "checkout: cloning $REPO_URL into $DIR …"
  git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$DIR" || stop 4 "git clone failed — is this Mac online?"
fi
git -C "$DIR" fetch --quiet origin "$COMMIT" 2>/dev/null || true
git -C "$DIR" checkout --quiet --force "$COMMIT" 2>/dev/null || stop 2 "commit $COMMIT is not in the repository — check the commit you were given."
git -C "$DIR" clean -fdq
FULL="$(git -C "$DIR" rev-parse HEAD)"
SHORT="$(git -C "$DIR" rev-parse --short HEAD)"
[[ "$FULL" == "$COMMIT"* ]] || stop 2 "the checkout is at $FULL, not $COMMIT."
[[ -z "$(git -C "$DIR" status --porcelain)" ]] || stop 4 "the checkout is not clean."
say "checkout: $FULL"
say ""

# ── 4. BUILD ────────────────────────────────────────────────────────────────────────────────────────────────────
OUT="$HOME/Downloads/DS-Sales-Agent-$SHORT.dmg"
say "building → $OUT  (notarising takes a few minutes; Apple's servers decide how many)"
say ""
DS_DMG_OUT="$OUT" bash "$DIR/scripts/build-dmg.sh" || stop 4 "build-dmg.sh failed — its error is just above."

# build-dmg.sh writes an un-notarised image under a different name rather than over the real one.
FINAL="$OUT"
[[ -f "$FINAL" ]] || FINAL="${OUT%.dmg}.UNNOTARISED.dmg"
[[ -f "$FINAL" ]] || stop 4 "no image was written."
say ""
say "== DONE =="
say "image:   $FINAL"
say "commit:  $SHORT"
say "sha256:  $(shasum -a 256 "$FINAL" | awk '{print $1}')"
say "size:    $(du -h "$FINAL" | cut -f1 | tr -d ' ')"
if [[ "$FINAL" == *UNNOTARISED* ]]; then
  say "WARNING: NOT notarised — it will be refused on anyone else's Mac."
elif [[ -z "$VALID" ]]; then
  say "WARNING: UNSIGNED — opens on this Mac only."
fi
exit 0
