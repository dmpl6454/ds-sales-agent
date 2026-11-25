#!/usr/bin/env bash
# embed-badge-probe.sh — READ-ONLY. Do Instagram's public EMBED pages, or Threads' public profile pages, still answer
# a visitor with no login — and do they carry (a) the verified badge of a profile and (b) the @mentions in a post's
# caption?
#
# Run it on the Mac Studio (home IP) AND on the box, as a FILE (never pasted into a shell):
#
#   curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<commit>/scripts/embed-badge-probe.sh -o /tmp/ebp.sh && bash /tmp/ebp.sh
#
#   bash /tmp/ebp.sh netflix_in:v someone:u nothere:x   ask about these handles instead of the default list. The label
#                                                      says what WE hold: v = verified, u = NOT verified, x = it does
#                                                      not exist. No label = unknown (shown, never used for the answer).
#   bash /tmp/ebp.sh --posts Dcc4pQ8sX0N,DcyE65LPYMj     ask about these post shortcodes instead
#   bash /tmp/ebp.sh --no-threads                        leave Threads out        (--no-posts leaves the posts out)
#   bash /tmp/ebp.sh --keep                              keep the downloaded pages and this report, and say where
#   bash /tmp/ebp.sh --help
#
#   On a console that shows one screen:  bash /tmp/ebp.sh > /tmp/ebp.txt 2>&1; tail -n 9 /tmp/ebp.txt
#   then read the rest a screen at a time:  sed -n '1,40p' /tmp/ebp.txt     sed -n '41,90p' /tmp/ebp.txt
#
# WHY (25 Nov 2026). Since 15 Oct no new company can be added and almost no paid post credits a company we hold. The
# only thing that makes a company MESSAGEABLE is the verified badge (VERIFIED ONLY), and the only place we ever read
# it — the anonymous feed — refuses us. Meta's official read does not report the badge (measured 25 Nov with
# graph-badge-probe.sh) and hands over captions with no tags and, by its documentation, no "@". Two public doors have
# never been tried from here: the embed pages Instagram serves for other sites' iframes, and Threads' profile pages
# (a Threads handle is the Instagram handle). If one of them answers and carries the badge or the @mentions, company
# discovery can be rebuilt on it.
#
# WHAT THESE PAGES CONTAIN IS UNKNOWN UNTIL THIS IS RUN. Nothing below is a claim about them. The key names and words
# this script looks for (is_verified, VerifiedBadge, class="Caption", ...) are places to LOOK, taken from memory of
# older pages; that is why it prints what it actually saw — tallies, the words themselves, one snippet per page — so
# a parser can later be written from observed bytes.
#
# HOW IT ANSWERS WITHOUT FOOLING ITSELF.
#   1. CONTROLS FIRST. The default list holds two handles we hold as verified, two we hold as NOT verified, and one
#      that does not exist. A door is a YES only when a verified handle shows evidence that an unverified handle's
#      page does not show — and that unverified page must have come back with real profile data, or its silence means
#      nothing. So "refused" and "a shell with no data" can never be read as "not verified".
#   2. A word that is on every page alike (a class name inside a script or style bundle) is never evidence. Counts are
#      compared between the two groups; equal counts decide nothing.
#   3. A true/false is tied to the queried username where the page allows it (the nearest value to the username key),
#      because a page can also describe other accounts.
#   4. For a post, YES needs the caption itself to come back with @mentions linked to accounts.
#   A handle we hold as unverified that reads as verified (or the reverse) is printed, never hidden: the label may be
#   stale. An Instagram account need not have a Threads profile, so on Threads "no profile data" is common.
#
# WHAT IT ASKS. Plain GETs, no login, NO cookie kept or sent (not even between redirects), no proxy setting of its
# own, one desktop-Chrome identity (on a Mac, the version of the Chrome installed there) with the headers a browser
# sends: an iframe load for the embed pages, a top-level visit for Threads. It never calls itself a crawler.
#   profile embed    https://www.instagram.com/<handle>/embed/
#   Threads profile  https://www.threads.com/@<handle>
#   post embed       https://www.instagram.com/p/<shortcode>/embed/captioned/
# One visit per handle per door, one per post: 12 for the defaults, 2 s apart, 10 s to connect, 25 s in all, 3 MB of
# body at most. A redirect is followed up to 3 times, only to instagram.com / threads.com / threads.net over https,
# and never to a login page. A cookie a page tries to set is thrown away as soon as the answer's headers are read:
# its value is never sent, never printed and never kept (the report names the cookie, nothing more).
# STOP RULES: a door that answers 429 or 401, sends us to a login page, serves one, or says require_login is not
# asked again in that run; the other doors carry on. Nothing is retried.
#
# What it does NOT do: log in, send or store a cookie, use a session, retry, write anywhere but a temporary directory
# (removed on exit unless --keep), touch the database or a setting, or decide anything. A YES means "a parser can be
# built on this door"; building it — and what may then admit a company — is a separate change. A refusal here is a
# refusal to THIS client from THIS address; the Mac and the box can differ, which is why it runs on both.
# It holds no secret and prints none.
#
# Test-only overrides (the harness uses them; a real run sets none): DS_PROBE_IG_HOST, DS_PROBE_THREADS_HOST (the
# report then says TEST HOSTS), DS_PROBE_SPACING, DS_PROBE_MAX_TIME, DS_PROBE_CONNECT_TIMEOUT.
#
# Needs: bash 3.2 or newer, curl, awk, tr, head, wc, mktemp (plus cat, rm, date, uname, sleep). No node, python or jq.
#
# Exit: 0 it ran and printed its answers · 1 nothing answered at all · 2 bad arguments, or it cannot run here
set -u
export LC_ALL=C LANG=C

SELF="embed-badge-probe.sh"
IG_DEFAULT="https://www.instagram.com"
TH_DEFAULT="https://www.threads.com"
IG_HOST="${DS_PROBE_IG_HOST:-$IG_DEFAULT}"
TH_HOST="${DS_PROBE_THREADS_HOST:-$TH_DEFAULT}"
SPACING="${DS_PROBE_SPACING:-2}"
MAX_TIME="${DS_PROBE_MAX_TIME:-25}"
CONNECT_TIMEOUT="${DS_PROBE_CONNECT_TIMEOUT:-10}"
CAP_BYTES=3145728
CAP_PLUS=3145729
MAX_HOPS=3
MAX_HANDLES=12
MAX_POSTS=6
DEFAULT_HANDLES="netflix_in:v sonytvofficial:v marketingmentalist:u chumbak_official:u qqqq_nope_nope_12345:x"
DEFAULT_POSTS="Dcc4pQ8sX0N DcyE65LPYMj"
DEFAULT_CHROME_MAJOR=145

stop2() { printf '%s\n' "-- STOPPED: $*"; exit 2; }

usage() {
  cat <<'USAGE'
embed-badge-probe.sh — read-only. Asks Instagram's public embed pages and Threads' public profile pages, with no
login and no cookie, whether they still answer and whether they carry the verified badge and a caption's @mentions.

  bash embed-badge-probe.sh                         the default handles and posts (12 requests, 2 s apart)
  bash embed-badge-probe.sh name:v other:u gone:x   these handles instead; the label is what WE hold:
                                                    v verified, u NOT verified, x does not exist, none = unknown
  --posts a,b        these post shortcodes instead        --no-posts     ask about no post
  --no-threads       leave Threads out                    --keep         keep the pages and the report, say where
  --help             this text

Exit: 0 it ran and printed its answers, 1 nothing answered at all, 2 bad arguments or it cannot run here.
USAGE
}

HANDLES=""
NHANDLES=0
POSTS=""
NPOSTS=0
POSTS_SET=0
DO_THREADS=1
DO_POSTS=1
KEEP=0

add_handle() {
  local arg="$1" h lab
  h=${arg%%:*}
  lab="-"
  case "$arg" in *:*) lab=${arg#*:} ;; esac
  case "$lab" in -|v|u|x) ;; *) stop2 "'$arg': after the colon write v (we hold it as verified), u (not verified) or x (does not exist)." ;; esac
  case "$h" in ''|*[!A-Za-z0-9._]*) stop2 "'$h' is not an Instagram handle." ;; esac
  [ "${#h}" -le 30 ] || stop2 "'$h' is not an Instagram handle (longer than 30 characters)."
  h=$(printf '%s' "$h" | tr 'A-Z' 'a-z')
  case " $HANDLES " in *" $h:"*) return 0 ;; esac
  HANDLES="$HANDLES $h:$lab"
  NHANDLES=$((NHANDLES + 1))
}

add_posts() {
  local list="$1" p old="$IFS"
  POSTS_SET=1
  [ -n "$list" ] || stop2 "--posts needs a list of shortcodes, for example --posts Dcc4pQ8sX0N,DcyE65LPYMj"
  IFS=,
  set -f
  for p in $list; do
    case "$p" in ''|*[!A-Za-z0-9_-]*) IFS="$old"; set +f; stop2 "'$p' is not a post shortcode." ;; esac
    if [ "${#p}" -lt 5 ] || [ "${#p}" -gt 40 ]; then IFS="$old"; set +f; stop2 "'$p' is not a post shortcode (5 to 40 characters)."; fi
    case " $POSTS " in *" $p "*) continue ;; esac
    POSTS="$POSTS $p"
    NPOSTS=$((NPOSTS + 1))
  done
  set +f
  IFS="$old"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --keep) KEEP=1 ;;
    --no-threads) DO_THREADS=0 ;;
    --no-posts) DO_POSTS=0 ;;
    --posts) shift; [ $# -gt 0 ] || stop2 "--posts needs a list of shortcodes."; add_posts "$1" ;;
    --posts=*) add_posts "${1#--posts=}" ;;
    -*) stop2 "unknown option '$1' (see --help)." ;;
    *) add_handle "$1" ;;
  esac
  shift
done

if [ "$NHANDLES" -eq 0 ]; then
  for item in $DEFAULT_HANDLES; do add_handle "$item"; done
fi
if [ "$POSTS_SET" -eq 0 ]; then
  for item in $DEFAULT_POSTS; do POSTS="$POSTS $item"; NPOSTS=$((NPOSTS + 1)); done
fi
if [ "$DO_POSTS" -eq 0 ]; then POSTS=""; NPOSTS=0; fi
[ "$NHANDLES" -le "$MAX_HANDLES" ] || stop2 "$NHANDLES handles is more than this probe asks in one run ($MAX_HANDLES)."
[ "$NPOSTS" -le "$MAX_POSTS" ] || stop2 "$NPOSTS posts is more than this probe asks in one run ($MAX_POSTS)."

case "$SPACING" in ''|.|*[!0-9.]*|*.*.*) stop2 "DS_PROBE_SPACING must be a number of seconds, got: $SPACING" ;; esac
case "$MAX_TIME" in ''|0|*[!0-9]*) stop2 "DS_PROBE_MAX_TIME must be a whole number of seconds, got: $MAX_TIME" ;; esac
case "$CONNECT_TIMEOUT" in ''|0|*[!0-9]*) stop2 "DS_PROBE_CONNECT_TIMEOUT must be a whole number of seconds, got: $CONNECT_TIMEOUT" ;; esac
while [ "${IG_HOST%/}" != "$IG_HOST" ]; do IG_HOST=${IG_HOST%/}; done
while [ "${TH_HOST%/}" != "$TH_HOST" ]; do TH_HOST=${TH_HOST%/}; done
for item in "$IG_HOST" "$TH_HOST"; do
  case "$item" in http://?*|https://?*) ;; *) stop2 "a host override must start with http:// or https://" ;; esac
  case "$item" in *[!!-~]*) stop2 "a host override may not hold spaces or control characters." ;; esac
done
TEST_HOSTS=0
if [ "$IG_HOST" != "$IG_DEFAULT" ] || [ "$TH_HOST" != "$TH_DEFAULT" ]; then TEST_HOSTS=1; fi

for item in curl awk tr head wc cat mktemp rm date uname sleep; do
  command -v "$item" >/dev/null 2>&1 || stop2 "'$item' is not installed here."
done

# ---- who we say we are: desktop Chrome on this kind of machine. On a Mac, the Chrome that is installed there. ----
OS=$(uname -s 2>/dev/null) || OS="unknown"
[ -n "$OS" ] || OS="unknown"
CHROME_MAJOR=$DEFAULT_CHROME_MAJOR
CHROME_FROM="a built-in default"
if [ "$OS" = Darwin ]; then
  UA_PLATFORM="Macintosh; Intel Mac OS X 10_15_7"
  if command -v defaults >/dev/null 2>&1; then
    item=$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString 2>/dev/null) || item=""
    item=${item%%.*}
    case "$item" in
      ''|*[!0-9]*) ;;
      *) if [ "${#item}" -eq 3 ]; then CHROME_MAJOR=$item; CHROME_FROM="the Chrome installed on this Mac"; fi ;;
    esac
  fi
else
  UA_PLATFORM="X11; Linux x86_64"
fi
UA="Mozilla/5.0 ($UA_PLATFORM) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$CHROME_MAJOR.0.0.0 Safari/537.36"
COMMON_H=(-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8" -H "Accept-Language: en-US,en;q=0.9" -H "Accept-Encoding: gzip, deflate" -H "Upgrade-Insecure-Requests: 1")
IFRAME_H=(-H "Sec-Fetch-Dest: iframe" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: cross-site")
TOP_H=(-H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: none" -H "Sec-Fetch-User: ?1")

# ---- a private place to work, removed on exit unless --keep. Everything below uses names relative to it. ----
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ebp.XXXXXX" 2>/dev/null) || TMP=""
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then stop2 "could not create a temporary directory."; fi
cd "$TMP" || stop2 "could not enter the temporary directory."
TMP=$(pwd)
cleanup() {
  if [ "$KEEP" -eq 1 ]; then : > "$TMP/hdr.raw"; return 0; fi
  cd / 2>/dev/null
  case "$TMP" in /*/ebp.*) rm -rf "$TMP" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
: > report.txt
: > sum

# ---- the page readers. awk, POSIX only: no intervals, no gensub, every "/" in a pattern escaped. ----
cat > hdrkeep.awk <<'AWK'
# The headers as they are kept: a Set-Cookie line keeps the cookie's NAME and loses its value.
{
  low = tolower($0)
  if (index(low, "set-cookie") == 1) {
    v = $0
    sub(/^[^:]*: */, "", v)
    sub(/[=;].*$/, "", v)
    print "set-cookie: " v "=(value dropped by the probe)"
  } else print
}
AWK

cat > hdr.awk <<'AWK'
# The LAST response's status, content type, Location, cookie names and Retry-After out of the kept headers (a proxy
# can put an earlier response in front).
BEGIN { st = ""; ct = ""; loc = ""; ck = ""; nck = 0; ra = "" }
/^HTTP\/[0-9.]+ +[0-9][0-9][0-9]/ { st = $2; ct = ""; loc = ""; ck = ""; nck = 0; ra = ""; next }
{
  low = tolower($0)
  if (index(low, "content-type:") == 1) { v = $0; sub(/^[^:]*: */, "", v); ct = v }
  else if (index(low, "location:") == 1) { v = $0; sub(/^[^:]*: */, "", v); loc = v }
  else if (index(low, "retry-after:") == 1) { v = $0; sub(/^[^:]*: */, "", v); ra = v }
  else if (index(low, "set-cookie:") == 1) {
    v = $0; sub(/^[^:]*: */, "", v); sub(/=.*$/, "", v)
    nck++
    if (nck <= 6) ck = ck " " v
  }
}
END { if (nck > 6) ck = ck " +" (nck - 6); sub(/^ /, "", ck); print st; print ct; print loc; print ck; print ra }
AWK

cat > lib.awk <<'AWK'
function clip(s, n) { return (length(s) > n) ? substr(s, 1, n) "..." : s }
function trim(s) { sub(/^ +/, "", s); sub(/ +$/, "", s); return s }
function squeeze(s) { gsub(/  +/, " ", s); return s }
function count(hay, needle,   n, i, L) {
  n = 0; L = length(needle)
  while ((i = index(hay, needle)) > 0) {
    n++
    if (n >= 2000) break
    hay = substr(hay, i + L)
  }
  return n
}
# One reading of the page with every layer of escaping taken off, so "is_verified":true, \"is_verified\":true,
# \\\"is_verified\\\":true, &quot;is_verified&quot;:true and "is_verified":true all read the same.
# Only for LOOKING: the snippets are cut from the bytes as served.
function flatten(s) {
  if (index(s, "\\") > 0) {
    gsub(/\\+u0022/, "\"", s)
    gsub(/\\+u0026/, "\\&", s)
    gsub(/\\+u0027/, "\047", s)
    gsub(/\\+u002[Ff]/, "/", s)
    gsub(/\\+u003[Cc]/, "<", s)
    gsub(/\\+u003[Dd]/, "=", s)
    gsub(/\\+u003[Ee]/, ">", s)
    gsub(/\\+u0040/, "@", s)
    gsub(/\\+u2019/, "\047", s)
    gsub(/\\+u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]/, "~", s)
    gsub(/\\+[nrt]/, " ", s)
    gsub(/\\/, "", s)
  }
  if (index(s, "&") > 0) {
    gsub(/&amp;/, "\\&", s)
    gsub(/&quot;/, "\"", s)
    gsub(/&#0*34;/, "\"", s)
    gsub(/&#[xX]22;/, "\"", s)
    gsub(/&#0*64;/, "@", s)
    gsub(/&#[xX]40;/, "@", s)
    gsub(/&lt;/, "<", s)
    gsub(/&gt;/, ">", s)
    gsub(/&#0*39;/, "\047", s)
    gsub(/&#[xX]27;/, "\047", s)
    gsub(/&apos;/, "\047", s)
    gsub(/&#0*47;/, "/", s)
    gsub(/&#[xX]2[Ff];/, "/", s)
  }
  return s
}
# <title> of the flattened page F (LF is F in lower case).
function page_title(   i, t, j, k) {
  i = index(LF, "<title")
  if (i == 0) return ""
  t = substr(F, i, 600)
  j = index(t, ">")
  if (j == 0) return ""
  t = substr(t, j + 1)
  k = index(tolower(t), "</title")
  return trim(squeeze((k > 0) ? substr(t, 1, k - 1) : substr(t, 1, 150)))
}
# What a person would read on the page: the body with scripts, styles and tags taken out. Only for pages that are
# HTML; "" otherwise. It is how a page with no data says why ("this page isn't available", "enable JavaScript" ...).
function visible_text(   t, lt, i, k, j, g, endtag, rest, e) {
  if (index(LF, "<html") == 0 && index(LF, "<body") == 0 && index(LF, "<!doctype") == 0) return ""
  i = index(LF, "<body")
  t = (i > 0) ? substr(F, i, 300000) : substr(F, 1, 300000)
  g = 0
  while (g++ < 80) {
    lt = tolower(t)
    i = index(lt, "<script"); k = index(lt, "<style")
    endtag = "</script"
    if (k > 0 && (i == 0 || k < i)) { i = k; endtag = "</style" }
    if (i == 0) break
    j = index(substr(lt, i), endtag)
    if (j == 0) { t = substr(t, 1, i - 1); break }
    rest = substr(t, i + j - 1)
    e = index(rest, ">")
    t = substr(t, 1, i - 1) " " ((e > 0) ? substr(rest, e + 1) : "")
  }
  gsub(/<[^>]*>/, " ", t)
  gsub(/&nbsp;/, " ", t)
  return trim(squeeze(t))
}
function is_login_title(t,   lt) {
  lt = tolower(t)
  if (lt ~ /^log ?in([^a-z]|$)/) return 1
  if (lt ~ /[^a-z]log ?in$/) return 1
  if (lt ~ /^sign ?up([^a-z]|$)/) return 1
  return 0
}
function login_marks(   m) {
  m = ""
  if (index(LF, "/accounts/login") > 0) m = m ", /accounts/login"
  else if (index(LF, "/login") > 0) m = m ", /login"
  HASPW = 0
  if (index(LF, "type=\"password\"") > 0 || index(LF, "name=\"password\"") > 0) { HASPW = 1; m = m ", a password field" }
  REQLOGIN = 0
  if (index(LF, "require_login") > 0) { REQLOGIN = 1; m = m ", require_login" }
  if (index(LF, "login_required") > 0) { REQLOGIN = 1; m = m ", login_required" }
  if (TITLELOGIN) m = m ", the page title"
  sub(/^, /, "", m)
  return m
}
function notfound_marks(   m) {
  m = ""
  if (index(LF, "this page isn") > 0) m = m ", \"this page isn...\""
  if (index(LF, "page not found") > 0) m = m ", \"page not found\""
  if (index(LF, "profile isn") > 0) m = m ", \"profile isn...\""
  if (index(LF, "user not found") > 0) m = m ", \"user not found\""
  if (index(LF, "content isn") > 0) m = m ", \"content isn...\""
  sub(/^, /, "", m)
  return m
}
function containers(   cn, i, c) {
  split("contextJSON __additionalDataLoaded _sharedData data-sjs ScheduledServerJS RelayPrefetchedStreamCache gql_data shortcode_media xdt_api__v1 application/ld+json application/json __NEXT_DATA__ __bbox", cn, " ")
  c = ""
  for (i = 1; (i in cn); i++) if (index(F, cn[i]) > 0) c = c ", " cn[i]
  sub(/^, /, "", c)
  return c
}
AWK

cat > profile.awk <<'AWK'
# What ONE profile page holds. Reads the page with getline (f = the page on one line, control characters already
# removed), writes a flattened copy to ff and walks it in comma-separated pieces so no step is slow on a long line.
function meta(prop,   i, w, e, c, v, q, s0, p, b, rest, x) {
  i = index(LF, prop)
  if (i == 0) return ""
  w = substr(F, i, 500)
  e = index(w, ">")
  if (e > 0) w = substr(w, 1, e)
  c = index(w, "content=\"")
  if (c == 0) {
    s0 = i - 500
    if (s0 < 1) s0 = 1
    w = substr(F, s0, i - s0)
    p = 0; b = 0; rest = tolower(w)
    while ((x = index(rest, "<meta")) > 0) { p = b + x; b += x; rest = substr(rest, x + 1) }
    if (p == 0) return ""
    w = substr(w, p)
    c = index(w, "content=\"")
    if (c == 0) return ""
  }
  v = substr(w, c + 9)
  q = index(v, "\"")
  return (q > 0) ? substr(v, 1, q - 1) : v
}
function addkey(name, val) {
  if (!(name in KT)) {
    if (nkn >= 6) return
    KN[++nkn] = name; KT[name] = 0; KF[name] = 0
  }
  if (val) KT[name]++; else KF[name]++
}
function addword(w) {
  w = clip(w, 48)
  if (!(w in WC)) {
    if (nw >= 40) return
    WN[++nw] = w; WC[w] = 0
  }
  WC[w]++
}
function addattr(a) {
  a = clip(a, 60)
  if (!(a in AC)) {
    if (na >= 12) return
    AN[++na] = a; AC[a] = 0
  }
  AC[a]++
}
function count_handle(s,   c, i, L, b, a, g) {
  c = 0; L = length(handle); g = 0
  while ((i = index(s, handle)) > 0) {
    b = (i > 1) ? substr(s, i - 1, 1) : ""
    a = substr(s, i + L, 1)
    if (b !~ /[A-Za-z0-9._]/ && a !~ /[A-Za-z0-9_]/) c++
    if (++g >= 1000) break
    s = substr(s, i + L)
  }
  return c
}
function scan(fl,   r, p, g, m, name, val, w) {
  if (index(fl, "erified") > 0) {
    r = fl; g = 0
    while (g++ < 400 && match(r, /"[A-Za-z_]*[Vv]erified[A-Za-z_]*" *: *(true|false)/)) {
      m = substr(r, RSTART, RLENGTH)
      name = substr(m, 2)
      name = substr(name, 1, index(name, "\"") - 1)
      val = (m ~ /true$/) ? 1 : 0
      addkey(name, val)
      r = substr(r, RSTART + RLENGTH)
    }
    ivword += count(fl, "is_verified")
    r = fl; g = 0
    while (g++ < 400 && match(r, /[A-Za-z0-9_-]*[Vv]erified[A-Za-z0-9_-]*/)) {
      w = substr(r, RSTART, RLENGTH)
      if (w != "is_verified") addword(w)
      r = substr(r, RSTART + RLENGTH)
    }
    r = fl; g = 0
    while (g++ < 100 && match(r, /(aria-label|title|alt)="[^"]*[Vv]erified[^"]*"/)) {
      addattr(substr(r, RSTART, RLENGTH))
      r = substr(r, RSTART + RLENGTH)
    }
    r = fl; g = 0
    while (g++ < 100 && match(r, /> *Verified *</)) {
      addattr(">Verified<")
      r = substr(r, RSTART + RLENGTH - 1)
    }
  }
  if (index(fl, handle) > 0) {
    anyc += count_handle(fl)
    r = fl; p = 0; g = 0
    while (g++ < 200 && match(r, ukre)) {
      ukeyc++
      if (nu < 60) upos[++nu] = base + p + RSTART
      p += RSTART + RLENGTH - 1
      r = substr(r, RSTART + RLENGTH)
    }
    r = fl
    elc += gsub(elre, "&", r)
  }
}
# The true/false that belongs to the queried username: the one in the SAME object as its "username" key. Walks out
# from the key to the braces that enclose it and reads only that object's own level - not the objects nested in it,
# not its neighbours. (The nearest value would be wrong half the time: a neighbour's last key sits right before.)
function own(at,   s0, w, rel, i, c, depth, L, left, right, r, g, m, name, val, seenk) {
  s0 = at - WIN
  if (s0 < 1) s0 = 1
  w = substr(F, s0, (at - s0) + WIN)
  rel = at - s0 + 1
  left = ""; depth = 0
  for (i = rel - 1; i >= 1; i--) {
    c = substr(w, i, 1)
    if (c == "}") { depth++; continue }
    if (c == "{") { if (depth == 0) break; depth--; continue }
    if (depth == 0) left = c left
  }
  right = ""; depth = 0; L = length(w)
  for (i = rel; i <= L; i++) {
    c = substr(w, i, 1)
    if (c == "{") { depth++; continue }
    if (c == "}") { if (depth == 0) break; depth--; continue }
    if (depth == 0) right = right c
  }
  r = left right; g = 0
  while (g++ < 20 && match(r, /"[A-Za-z_]*[Vv]erified[A-Za-z_]*" *: *(true|false)/)) {
    m = substr(r, RSTART, RLENGTH)
    name = substr(m, 2)
    name = substr(name, 1, index(name, "\"") - 1)
    val = (m ~ /true$/) ? 1 : 0
    if (!(name in seenk)) { seenk[name] = 1; if (val) NEART[name]++; else NEARF[name]++ }
    r = substr(r, RSTART + RLENGTH)
  }
}
# What the page says about the PROFILE for key k: the value in the username's own object when there is one; the
# whole page otherwise (no username key, or the key's object carries no such value). Which of the two is recorded,
# because a page-wide reading can be about another account.
function basis_of(k) { return (nu > 0 && NEART[k] + NEARF[k] > 0) ? "own" : "page" }
function own_true(k) { return (basis_of(k) == "own") ? NEART[k] + 0 : KT[k] + 0 }
function own_false(k) { return (basis_of(k) == "own") ? NEARF[k] + 0 : KF[k] + 0 }
function says_of(k,   a, b) {
  a = own_true(k); b = own_false(k)
  if (a > 0 && b == 0) return "T"
  if (b > 0 && a == 0) return "F"
  if (a > 0 && b > 0) return "M"
  return "-"
}
function reads(s) {
  if (s == "T") return "VERIFIED"
  if (s == "F") return "NOT VERIFIED"
  if (s == "M") return "BOTH, so nothing"
  return "nothing"
}
BEGIN {
  WIN = 900
  RS = "\n"
  raw = ""
  if ((getline raw < f) <= 0) raw = ""
  close(f)
  hre = handle
  gsub(/[.]/, "[.]", hre)
  ukre = "\"username\" *: *\"" hre "\""
  elre = "> *@?" hre " *<"

  F = flatten(raw)
  LF = tolower(F)

  # the data key as it sits in the served bytes, unescaped ("plain"); the rest of its occurrences are escaped ones
  tmp = raw
  plain = gsub(/"is_verified" *: *(true|false)/, "&", tmp)
  tmp = ""

  title = page_title()
  ogtitle = meta("og:title")
  TITLELOGIN = is_login_title(title)
  titlenames = (index(tolower(title), "(@" handle ")") > 0 || index(tolower(ogtitle), "(@" handle ")") > 0) ? 1 : 0

  fullname = ""; fnseen = 0; fnwhere = ""
  if (match(F, ukre)) {
    s0 = RSTART - WIN
    if (s0 < 1) s0 = 1
    w = substr(F, s0, RLENGTH + 2 * WIN)
    if (match(w, /"full_name" *: *"/)) {
      fnseen = 1; fnwhere = "beside the username"
      t = substr(w, RSTART + RLENGTH, 90)
      j = index(t, "\"")
      fullname = (j > 0) ? substr(t, 1, j - 1) : t
    }
  }
  if (!fnseen && match(F, /"full_name" *: *"/)) {
    fnseen = 1; fnwhere = "first on the page"
    t = substr(F, RSTART + RLENGTH, 90)
    j = index(t, "\"")
    fullname = (j > 0) ? substr(t, 1, j - 1) : t
  }

  fol = ""
  if (match(F, /"followers?_count" *: *"?[0-9]+/)) fol = substr(F, RSTART, RLENGTH)
  else if (match(F, /"edge_followed_by" *: *[{] *"count" *: *[0-9]+/)) fol = substr(F, RSTART, RLENGTH)
  else if (match(F, /[0-9][0-9.,]*[KkMmBb]? +[Ff]ollowers/)) fol = substr(F, RSTART, RLENGTH)

  lmarks = login_marks()
  nfmarks = notfound_marks()
  cont = containers()

  # ONE snippet, cut from the bytes as served (escaping intact): the is_verified that sits by the username key when
  # the page has both, else the first is_verified, else the first Verified word, else the handle.
  snwhat = ""; si = 0
  if (status + 0 == 200) {
    rk = 0
    if (match(raw, "username[\\\\\"]* *: *[\\\\\"]*" hre "[\\\\\"]")) rk = RSTART
    if (rk > 0) {
      s0 = rk - WIN
      if (s0 < 1) s0 = 1
      w = substr(raw, s0, (rk - s0) + WIN)
      rel = rk - s0 + 1
      best = 0; bestd = -1; off = 0; g = 0
      while (g++ < 60 && (i = index(w, "is_verified")) > 0) {
        d = off + i - rel
        if (d < 0) d = -d
        if (bestd < 0 || d < bestd) { bestd = d; best = off + i }
        off += i + 10
        w = substr(w, i + 11)
      }
      if (best > 0) {
        a = s0 + best - 1
        snwhat = "the is_verified nearest the username key"
        if (bestd < 140) si = ((a < rk) ? a : rk) + 66; else si = a
      }
    }
    if (si == 0) {
      si = index(raw, "is_verified")
      if (si > 0) snwhat = "the first is_verified"
      else if (match(raw, /[A-Za-z0-9_-]*Verified[A-Za-z0-9_-]*/)) { si = RSTART; snwhat = "the first word " substr(raw, RSTART, RLENGTH) }
      else if (rk > 0) { si = rk + 66; snwhat = "the username key" }
      else {
        si = index(raw, "\"" handle)
        if (si > 0) snwhat = "the handle in quotes"
        else { si = index(raw, handle); if (si > 0) snwhat = "the first mention of the handle" }
      }
    }
  }
  if (si > 0) { s0 = si - 80; if (s0 < 1) s0 = 1; sn = substr(raw, s0, 172) }
  else {
    sn = visible_text()
    if (length(sn) >= 15) { sn = substr(sn, 1, 172); snwhat = "" }
    else { sn = substr(raw, 1, 172); snwhat = "the start of the body" }
  }
  sn = trim(squeeze(sn))
  raw = ""

  print F > ff
  close(ff)
  LF = ""
  RS = ","
  base = 0
  while ((getline rec < ff) > 0) { scan(rec); base += length(rec) + 1 }
  close(ff)

  # base + offset in a piece IS the position in F, so each username key can be looked at in place
  for (a = 1; a <= nu; a++) own(upos[a])
  F = ""

  ev = ""
  if (ukeyc > 0) ev = ev ", username key x" ukeyc
  if (fol != "") ev = ev ", a follower count"
  if (fnseen) ev = ev ", a full_name"
  if (titlenames) ev = ev ", the title names it"
  if (elc > 0) ev = ev ", the handle as visible text x" elc
  sub(/^, /, "", ev)
  hasdata = (ev != "") ? 1 : 0
  smallref = (REQLOGIN && bytes + 0 < 3000) ? 1 : 0
  wall = (!hasdata && (TITLELOGIN || HASPW || smallref)) ? 1 : 0
  served = (status + 0 == 200 && hasdata && !wall) ? 1 : 0
  flagv = ""
  if (outc != "throttle") {
    if (status + 0 == 403 && REQLOGIN) { outc = "refused"; flagv = "refused" }
    else if (wall) { outc = "wall-body"; flagv = "wall" }
  }

  if (status + 0 == 200) {
    if (hasdata) {
      line = "   profile data: YES (" ev ")"
      if (anyc > ukeyc) line = line " | handle seen x" anyc
      if (fnseen) line = line " | name, " fnwhere ": \"" clip(fullname, 50) "\""
      if (fol != "") line = line " | followers seen as: " clip(fol, 50)
    } else {
      line = "   profile data: NONE (" ((anyc > 0) ? "the handle itself appears x" anyc : "the handle appears nowhere") ")"
      if (title != "") line = line " | title \"" clip(title, 60) "\""
    }
    print line
    if (nkn == 0) {
      line = "   is_verified: no true/false value on this page"
      if (ivword > 0) line = line " (the bare word is_verified appears x" ivword " - see the snippet)"
    } else {
      line = ""
      for (i = 1; i <= nkn; i++) {
        k = KN[i]; s = says_of(k)
        part = k ": true x" KT[k] ", false x" KF[k]
        if (k == "is_verified") part = part " (plain x" plain ", escaped x" (KT[k] + KF[k] - plain) ")"
        if (basis_of(k) == "own") part = part "; in the username\047s own object: true x" (NEART[k] + 0) ", false x" (NEARF[k] + 0)
        else if (nu > 0) part = part "; none of it in the username\047s own object, so read page-wide"
        else part = part "; no username key to tie it to, so read page-wide"
        part = part " => reads " reads(s)
        line = line ((line == "") ? "   " : " | ") part
      }
    }
    print line
  }
  line = ""
  if (nw > 0) {
    # most frequent first
    for (i = 1; i <= nw; i++) ord[i] = WN[i]
    for (i = 1; i <= nw; i++) for (j = i + 1; j <= nw; j++) if (WC[ord[j]] > WC[ord[i]]) { t = ord[i]; ord[i] = ord[j]; ord[j] = t }
    part = ""
    for (i = 1; i <= nw && i <= 6; i++) part = part ", " ord[i] " x" WC[ord[i]]
    sub(/^, /, "", part)
    if (nw > 6) part = part ", +" (nw - 6) " more"
    line = line " | badge words: " part
  } else if (status + 0 == 200) line = line " | badge words: none"
  if (na > 0) {
    part = ""
    for (i = 1; i <= na && i <= 4; i++) part = part ", " AN[i] " x" AC[AN[i]]
    sub(/^, /, "", part)
    line = line " | badge markup: " part
  }
  if (cont != "") line = line " | containers: " cont
  if (lmarks != "") line = line " | login marks: " lmarks
  if (nfmarks != "") line = line " | not-found marks: " nfmarks
  if (status + 0 != 200 && hasdata) line = line " | profile data in the body all the same (" ev ")"
  if (status + 0 != 200 && title != "") line = line " | title \"" clip(title, 60) "\""
  sub(/^ \| /, "", line)
  if (line != "") print "   " line
  if (bytes + 0 == 0) print "   (the body is empty)"
  else if (snwhat == "") print "   what the page says to a reader: " sn
  else print "   snippet at " snwhat ": " sn

  printf "R\t%s\t%s\t%s\t%s\t%s\t%d\n", door, id, label, outc, status, served >> sum
  for (i = 1; i <= nkn; i++) {
    k = KN[i]
    printf "K\t%s\t%s\t%s\t%s\t%s\n", door, id, k, says_of(k), basis_of(k) >> sum
    printf "B\t%s\t%s\t%d\t%s\n", door, id, own_true(k), "\"" k "\":true for the profile" >> sum
  }
  for (i = 1; i <= na; i++) { t = AN[i]; gsub(/[^ -~]/, "~", t); printf "B\t%s\t%s\t%d\t%s\n", door, id, AC[AN[i]], t >> sum }
  for (i = 1; i <= nw; i++) { t = WN[i]; gsub(/[^ -~]/, "~", t); printf "B\t%s\t%s\t%d\t%s\n", door, id, WC[WN[i]], "the word " t >> sum }
  close(sum)
  if (flagv != "") { print flagv > flagf; close(flagf) }
}
AWK

cat > post.awk <<'AWK'
# What ONE post embed page holds: the caption, who it links, how many "@" it has, and the tag / collaborator markers.
function handle_from_url(u,   p, host, seg) {
  p = u
  if (p ~ /^https?:\/\//) {
    sub(/^https?:\/\//, "", p)
    host = p
    sub(/[\/?#].*$/, "", host)
    if (tolower(host) !~ /(^|[.])instagram[.]com$/) return ""
    if (index(p, "/") == 0) return ""
    p = substr(p, index(p, "/"))
  } else if (substr(p, 1, 2) == "//") {
    p = substr(p, 3)
    host = p
    sub(/[\/?#].*$/, "", host)
    if (tolower(host) !~ /(^|[.])instagram[.]com$/) return ""
    if (index(p, "/") == 0) return ""
    p = substr(p, index(p, "/"))
  } else if (substr(p, 1, 1) != "/") return ""
  sub(/^\/+/, "", p)
  seg = p
  sub(/[\/?#].*$/, "", seg)
  if (seg !~ /^[A-Za-z0-9._]+$/) return ""
  seg = tolower(seg)
  if (seg in RESERVED) return ""
  return seg
}
function region_after(i,   w, e, body, e1, e2, cut) {
  w = substr(F, i, 30000)
  e = index(w, ">")
  if (e == 0) return ""
  body = substr(w, e + 1)
  e1 = index(body, "</div")
  e2 = index(body, "<div")
  cut = e1
  if (e2 > 0 && (cut == 0 || e2 < cut)) cut = e2
  return (cut > 0) ? substr(body, 1, cut - 1) : body
}
function strip_tags(s) { gsub(/<[^>]*>/, " ", s); return trim(squeeze(s)) }
function json_end(v,   a, b, c, e) {
  a = index(v, "\",\""); b = index(v, "\"}"); c = index(v, "\"]")
  e = 0
  if (a > 0) e = a
  if (b > 0 && (e == 0 || b < e)) e = b
  if (c > 0 && (e == 0 || c < e)) e = c
  return e
}
function find_caption(   r, off, g, cls, reg, txt, i, w, t, v, e) {
  # 1. markup: the first element whose class holds "Caption" and that has text of its own
  r = F; off = 0; g = 0
  while (g++ < 8 && match(r, /class="[^"]*[Cc]aption[^"]*"/)) {
    cls = substr(r, RSTART, RLENGTH)
    reg = region_after(off + RSTART)
    txt = strip_tags(reg)
    if (txt != "") { CAPFORM = cls; CAP = reg; CAPISHTML = 1; return 1 }
    off += RSTART + RLENGTH - 1
    r = substr(r, RSTART + RLENGTH)
  }
  # 2. data: the caption text inside a JSON blob
  i = index(F, "\"edge_media_to_caption\"")
  if (i > 0) {
    w = substr(F, i, 8000)
    t = index(w, "\"text\":\"")
    if (t > 0) { v = substr(w, t + 8); e = json_end(v); CAP = (e > 0) ? substr(v, 1, e - 1) : substr(v, 1, 4000); CAPFORM = "edge_media_to_caption ... \"text\""; return 1 }
  }
  if (match(F, /"caption" *: *[{]/)) {
    w = substr(F, RSTART, 8000)
    t = index(w, "\"text\":\"")
    if (t > 0) { v = substr(w, t + 8); e = json_end(v); CAP = (e > 0) ? substr(v, 1, e - 1) : substr(v, 1, 4000); CAPFORM = "\"caption\":{... \"text\"}"; return 1 }
  }
  if (match(F, /"caption" *: *"/)) {
    v = substr(F, RSTART + RLENGTH, 6000)
    e = json_end(v)
    CAP = (e > 0) ? substr(v, 1, e - 1) : substr(v, 1, 4000)
    if (CAP != "") { CAPFORM = "\"caption\":\"...\""; return 1 }
  }
  return 0
}
function addmark(w) {
  w = clip(w, 44)
  if (!(w in MC)) {
    if (nm >= 40) return
    MN[++nm] = w; MC[w] = 0
  }
  MC[w]++
}
function scan(fl,   r, g, m, seg, lr) {
  if (index(fl, "is_verified") > 0) {
    r = fl; g = 0
    while (g++ < 400 && match(r, /"is_verified" *: *(true|false)/)) {
      m = substr(r, RSTART, RLENGTH)
      if (m ~ /true$/) ivT++; else ivF++
      r = substr(r, RSTART + RLENGTH)
    }
    ivword += count(fl, "is_verified")
  }
  if (index(fl, "instagram.com/") > 0) {
    r = fl; g = 0
    while (g++ < 200 && match(r, /instagram[.]com\/[A-Za-z0-9._]+/)) {
      seg = tolower(substr(r, RSTART + 14, RLENGTH - 14))
      if (!(seg in RESERVED) && !(seg in PH)) { PH[seg] = 1; nph++ }
      r = substr(r, RSTART + RLENGTH)
    }
  }
  if (fl ~ /[Cc]oauthor|[Uu]sertag|agged_user|[Cc]ollab|[Ss]ponsor|artnership|randed_content/) {
    lr = tolower(fl); g = 0
    while (g++ < 200 && match(lr, /[a-z0-9_]*(coauthor|usertag|tagged_user|collab|sponsor|paid_partnership|branded_content)[a-z0-9_]*/)) {
      addmark(substr(lr, RSTART, RLENGTH))
      lr = substr(lr, RSTART + RLENGTH)
    }
  }
}
BEGIN {
  RS = "\n"
  raw = ""
  if ((getline raw < f) <= 0) raw = ""
  close(f)
  split("p reel reels tv explore accounts stories about legal privacy directory developer developers web static api graphql challenge embed.js terms help press blog locations emails oauth share s", rw, " ")
  for (i in rw) RESERVED[rw[i]] = 1

  F = flatten(raw)
  LF = tolower(F)
  tmp = raw
  plain = gsub(/"is_verified" *: *(true|false)/, "&", tmp)
  tmp = ""

  title = page_title()
  TITLELOGIN = is_login_title(title)
  lmarks = login_marks()
  nfmarks = notfound_marks()
  cont = containers()

  CAP = ""; CAPFORM = ""; CAPISHTML = 0
  capfound = (status + 0 == 200) ? find_caption() : 0
  nlink = 0; nment = 0; atc = 0; natw = 0; links = ""; ments = ""; atwords = ""
  if (capfound) {
    txt = CAPISHTML ? strip_tags(CAP) : trim(squeeze(CAP))
    ltxt = tolower(txt)
    tmp = txt
    atc = gsub(/@/, "@", tmp)
    r = txt; g = 0
    while (g++ < 60 && match(r, /@[A-Za-z0-9._]+/)) {
      w = tolower(substr(r, RSTART, RLENGTH))
      sub(/[.]+$/, "", w)
      if (length(w) > 1 && !(w in AW)) { AW[w] = 1; natw++; if (natw <= 10) atwords = atwords " " w }
      r = substr(r, RSTART + RLENGTH)
    }
    if (CAPISHTML) {
      r = CAP; g = 0
      while (g++ < 80 && match(r, /href="[^"]*"/)) {
        h = handle_from_url(substr(r, RSTART + 6, RLENGTH - 7))
        if (h != "" && !(h in LK)) {
          LK[h] = 1; nlink++
          if (nlink <= 10) links = links " " h
          if (index(ltxt, "@" h) > 0) { nment++; if (nment <= 10) ments = ments " @" h }
        }
        r = substr(r, RSTART + RLENGTH)
      }
    }
  }

  # ONE snippet from the bytes as served: the caption if we can find it there, else the start of the body
  snwhat = ""; si = 0
  if (capfound && CAPISHTML) {
    si = index(raw, CAPFORM)
    if (si > 0) { w = substr(raw, si, 30000); j = index(w, "@"); if (j > 80) si = si + j - 80; snwhat = "the caption" }
  } else if (capfound) {
    si = index(raw, "edge_media_to_caption")
    if (si == 0 && match(raw, /"caption\\*" *: */)) si = RSTART
    if (si > 0) { w = substr(raw, si, 8000); j = index(w, "@"); if (j > 80) si = si + j - 80; snwhat = "the caption data" }
  }
  if (si > 0) sn = substr(raw, si, 172)
  else {
    sn = visible_text()
    if (length(sn) >= 15) { sn = substr(sn, 1, 172); snwhat = "" }
    else { sn = substr(raw, 1, 172); snwhat = "the start of the body" }
  }
  sn = trim(squeeze(sn))
  raw = ""

  print F > ff
  close(ff)
  F = ""; LF = ""
  RS = ","
  while ((getline rec < ff) > 0) scan(rec)
  close(ff)

  smallref = (REQLOGIN && bytes + 0 < 3000) ? 1 : 0
  wall = (!capfound && (TITLELOGIN || HASPW || smallref)) ? 1 : 0
  flagv = ""
  if (outc != "throttle") {
    if (status + 0 == 403 && REQLOGIN) { outc = "refused"; flagv = "refused" }
    else if (wall) { outc = "wall-body"; flagv = "wall" }
  }

  if (status + 0 == 200) {
    if (capfound) {
      line = "   caption: FOUND via " clip(CAPFORM, 60) " (" length(txt) " chars) | \"@\" in its text x" atc
      if (natw > 0) line = line " (" trim(atwords) ((natw > 10) ? " ..." : "") ")"
      if (CAPISHTML) {
        line = line " | accounts it links x" nlink
        if (nlink > 0) line = line " (" trim(links) ((nlink > 10) ? " ..." : "") ")"
        line = line " | linked @mentions x" nment
      } else line = line " | it is plain text here, so nothing is linked"
    } else {
      line = "   caption: NOT FOUND (no class holding \"Caption\" with text, no caption text in the data)"
      if (title != "") line = line " | title \"" clip(title, 60) "\""
    }
    print line
  }
  line = ""
  if (status + 0 == 200) {
    line = "page: is_verified true x" (ivT + 0) ", false x" (ivF + 0)
    if (ivT + ivF > 0) line = line " (plain x" plain ", escaped x" (ivT + ivF - plain) ")"
    else if (ivword > 0) line = line " (the bare word appears x" ivword ")"
    line = line " | accounts linked anywhere x" (nph + 0)
    if (nm > 0) {
      for (i = 1; i <= nm; i++) ord[i] = MN[i]
      for (i = 1; i <= nm; i++) for (j = i + 1; j <= nm; j++) if (MC[ord[j]] > MC[ord[i]]) { t = ord[i]; ord[i] = ord[j]; ord[j] = t }
      part = ""
      for (i = 1; i <= nm && i <= 8; i++) part = part ", " ord[i] " x" MC[ord[i]]
      sub(/^, /, "", part)
      if (nm > 8) part = part ", +" (nm - 8) " more"
      line = line " | tag and collaborator words: " part
    } else line = line " | tag and collaborator words: none"
  }
  if (cont != "") line = line ((line == "") ? "" : " | ") "containers: " cont
  if (lmarks != "") line = line ((line == "") ? "" : " | ") "login marks: " lmarks
  if (nfmarks != "") line = line ((line == "") ? "" : " | ") "not-found marks: " nfmarks
  if (status + 0 != 200 && title != "") line = line ((line == "") ? "" : " | ") "title \"" clip(title, 60) "\""
  if (line != "") print "   " line
  if (bytes + 0 == 0) print "   (the body is empty)"
  else if (snwhat == "") print "   what the page says to a reader: " sn
  else print "   snippet at " snwhat ": " sn

  m1 = trim(ments); gsub(/[^ -~]/, "~", m1)
  m2 = trim(atwords); gsub(/[^ -~]/, "~", m2)
  printf "S\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%s\t%s\n", door, id, outc, status, capfound, nment, atc, natw, m1, m2 >> sum
  close(sum)
  if (flagv != "") { print flagv > flagf; close(flagf) }
}
AWK

cat > answer.awk <<'AWK'
# One line per door, from the facts the page readers wrote. Prints: door TAB code TAB detail.
BEGIN { FS = "\t" }
$1 == "R" || $1 == "S" {
  d = $2; h = $3
  if (!((d, h) in seen)) { seen[d, h] = 1; n[d]++; H[d, n[d]] = h }
}
$1 == "R" { label[d, h] = $4; outc[d, h] = $5; stat[d, h] = $6; served[d, h] = $7 + 0; next }
$1 == "S" {
  outc[d, h] = $4; stat[d, h] = $5; pcap[d, h] = $6 + 0; pment[d, h] = $7 + 0; patc[d, h] = $8 + 0
  pml[d, h] = $10; paw[d, h] = $11; ispost[d] = 1
  next
}
$1 == "K" {
  d = $2; h = $3; k = $4
  says[d, h, k] = $5
  pagewide[d, h, k] = ($6 == "page") ? 1 : 0
  if (!((d, k) in kseen)) { kseen[d, k] = 1; nk[d]++; KN[d, nk[d]] = k }
  next
}
$1 == "B" {
  d = $2; h = $3; t = $5
  cnt[d, h, t] = $4 + 0
  if (!((d, t) in tseen)) { tseen[d, t] = 1; nt[d]++; TN[d, nt[d]] = t }
  next
}
function what(d, h,   o, s) {
  o = outc[d, h]; s = stat[d, h]
  if (o == "skipped") return "not asked"
  if (o == "neterr") return "no answer"
  if (o == "wall-redirect") return "sent to the login page (HTTP " s ")"
  if (o == "wall-body") return "a login page or a require_login refusal (HTTP " s ")"
  if (o == "throttle") return "HTTP " s ", told to stop"
  if (o == "refused") return "HTTP " s " with require_login"
  if (o == "redirect") return "HTTP " s " redirect, not followed"
  if (o == "failed") return "HTTP " s ", could not be analysed"
  if (s + 0 == 200) {
    if (d in ispost) return pcap[d, h] ? "HTTP 200 with a caption" : "HTTP 200 without a caption"
    return served[d, h] ? "HTTP 200 with profile data" : "HTTP 200 without profile data"
  }
  return "HTTP " s
}
function tally(d, only, pre,   i, h, w, nw, order, who, out) {
  nw = 0
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]
    if (only != "" && label[d, h] != only) continue
    w = what(d, h)
    if (!(w in who)) { who[w] = ""; order[++nw] = w }
    who[w] = who[w] " " pre h
  }
  out = ""
  for (i = 1; i <= nw; i++) out = out ((i > 1) ? "; " : "") order[i] ":" who[order[i]]
  return out
}
function counts(d, t,   i, h, c, a, b) {
  a = ""; b = ""
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]
    if (!served[d, h]) continue
    c = ((d, h, t) in cnt) ? cnt[d, h, t] : 0
    if (label[d, h] == "v") a = a " @" h " x" c
    else if (label[d, h] == "u") b = b " @" h " x" c
  }
  return "held as verified:" a " | held as NOT verified:" b
}
function xnote(d,   i, h) {
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]
    if (label[d, h] != "x") continue
    if (outc[d, h] == "skipped") print d "\tNOTE\tthe handle that does not exist (@" h ") was not asked"
    else print d "\tNOTE\tthe handle that does not exist (@" h ") came back as: " what(d, h)
  }
}
# What happened before and after the request that closed the door.
function after_stop(d, pre,   i, h, o, before, skipped) {
  before = ""; skipped = ""
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]; o = outc[d, h]
    if (o == "skipped") skipped = skipped " " pre h
    else if (!(o == "wall-redirect" || o == "wall-body" || o == "throttle" || o == "refused")) before = before "; " pre h ": " what(d, h)
  }
  return ((before != "") ? " Before that -" substr(before, 2) "." : "") ((skipped != "") ? " Not asked after it:" skipped "." : "")
}
function profile(d,   i, j, h, L, o, k, s, c, t, m, star, nV, nU, sV, sU, sAny, vs, us, stopnote, vpos, uneg, vneg, upos, mix, kvpos, kuneg, kvneg, kupos, kmix, det, best, partial, minV, maxV, minU, maxU) {
  if (n[d] + 0 == 0) return
  nV = 0; nU = 0; sV = 0; sU = 0; sAny = 0; vs = ""; us = ""; stopnote = ""
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]; L = label[d, h]; o = outc[d, h]
    if (stopnote == "" && (o == "wall-redirect" || o == "wall-body" || o == "throttle" || o == "refused")) stopnote = "@" h ": " what(d, h)
    if (served[d, h]) sAny++
    if (L == "v") { nV++; if (served[d, h]) { sV++; vs = vs " @" h } }
    if (L == "u") { nU++; if (served[d, h]) { sU++; us = us " @" h } }
  }
  # 1. a true/false in the page data that reads true on a verified handle and false on an unverified one
  for (j = 0; j <= nk[d] + 0; j++) {
    if (j == 0) { k = "is_verified"; if (!((d, k) in kseen)) continue }
    else { k = KN[d, j]; if (k == "is_verified") continue }
    vpos = ""; uneg = ""; vneg = ""; upos = ""; mix = ""; star = 0
    for (i = 1; i <= n[d]; i++) {
      h = H[d, i]
      if (!served[d, h]) continue
      L = label[d, h]
      s = ((d, h, k) in says) ? says[d, h, k] : "-"
      m = ""
      if (pagewide[d, h, k] && s != "-") { m = "*"; star = 1 }
      if (L == "v") { if (s == "T") vpos = vpos " @" h m; else if (s == "F") vneg = vneg " @" h m; else if (s == "M") mix = mix " @" h m }
      else if (L == "u") { if (s == "F") uneg = uneg " @" h m; else if (s == "T") upos = upos " @" h m; else if (s == "M") mix = mix " @" h m }
    }
    if (vpos != "" && uneg != "") {
      det = "\"" k "\" in the page data reads true for" vpos " and false for" uneg "."
      if (upos != "") det = det " BUT it reads true for" upos ", held here as NOT verified: that label is stale or the value is not the badge - read that block."
      if (vneg != "") det = det " BUT it reads false for" vneg ", held here as verified - read that block."
      if (mix != "") det = det " Both values appear for" mix "."
      if (star) det = det " (* read from the whole page, which can include other accounts: that page has no such value in the username's own object.)"
      if (stopnote != "") det = det " (The door then stopped answering - " stopnote ".)"
      print d "\tYES\t" det
      xnote(d)
      return
    }
    if (j == 0) { kvpos = vpos; kuneg = uneg; kvneg = vneg; kupos = upos; kmix = mix }
  }
  # 2. something countable that verified pages carry more of than every unverified page
  best = ""; partial = ""
  if (sV >= 1 && sU >= 1) {
    for (j = 1; j <= nt[d] + 0; j++) {
      t = TN[d, j]
      if (t == "the word verified" || t == "the word Verified") continue   # prose, not markup: a name can hold it
      minV = -1; maxV = -1; minU = -1; maxU = -1
      for (i = 1; i <= n[d]; i++) {
        h = H[d, i]
        if (!served[d, h]) continue
        L = label[d, h]
        c = ((d, h, t) in cnt) ? cnt[d, h, t] : 0
        if (L == "v") { if (minV < 0 || c < minV) minV = c; if (c > maxV) maxV = c }
        else if (L == "u") { if (minU < 0 || c < minU) minU = c; if (c > maxU) maxU = c }
      }
      if (minV > maxU && (maxU == 0 || (sU >= 2 && minU == maxU))) { best = t; break }
      if (maxV > minU && partial == "") partial = t
    }
  }
  if (best != "") {
    det = "every verified page carries " best " more often than any unverified page - " counts(d, best) ". This is a count, not a true/false read off the profile: look at the snippets before building on it."
    if (stopnote != "") det = det " (The door then stopped answering - " stopnote ".)"
    print d "\tYES\t" det
    xnote(d)
    return
  }
  if (kmix != "") {
    print d "\tUNSURE\tis_verified reads both true and false for" kmix " (in the username's own object, or page-wide where there is no username key), so this run cannot say which is the profile's - read the snippets, or keep the pages with --keep."
    xnote(d)
    return
  }
  if (partial != "") {
    print d "\tUNSURE\tthe pages differ in " partial ", but not cleanly along what we hold - " counts(d, partial) ". A label may be stale, or this is not the badge."
    xnote(d)
    return
  }
  if (sV >= 1 && sU >= 1) {
    det = "profile data came back for" vs " (held as verified) and" us " (held as NOT verified), and nothing in it tells the two groups apart:"
    if ((d, "is_verified") in kseen) {
      if (kvneg != "" && kuneg != "") det = det " is_verified reads false on all of them, the verified ones included;"
      else if (kvpos != "" && kupos != "") det = det " is_verified reads true on all of them, the unverified ones included;"
      else det = det " is_verified is there, but it does not read true on the verified ones and false on the unverified ones;"
    } else det = det " there is no is_verified true/false on any of these pages;"
    if (nt[d] + 0 > 0) det = det " and no Verified word or attribute is more frequent on the verified pages than on the unverified ones."
    else det = det " and there is no Verified word or attribute on them either."
    if (stopnote != "") det = det " (The door then stopped answering - " stopnote ".)"
    print d "\tNOBADGE\t" det
    xnote(d)
    return
  }
  if (sAny == 0 && stopnote != "") {
    print d "\tREFUSED\t" stopnote "." after_stop(d, "@")
    xnote(d)
    return
  }
  if (nV == 0 || nU == 0) det = "nothing to compare: the run needs at least one handle labelled :v and one labelled :u. " tally(d, "", "@") "."
  else if (sV >= 1) {
    det = "profile data came back only for handles held as verified (" substr(vs, 2) "); none held as NOT verified returned any, so there is nothing to compare"
    if (kvpos != "") det = det " (is_verified does read true for" kvpos ", but false was never seen)"
    det = det ". " tally(d, "u", "@") ". Run it again with other handles we hold as NOT verified, labelled :u."
  } else if (sU >= 1) {
    det = "profile data came back only for handles held as NOT verified (" substr(us, 2) "); none held as verified returned any, so there is nothing to compare"
    if (kuneg != "") det = det " (is_verified does read false for" kuneg ", but true was never seen)"
    det = det ". " tally(d, "v", "@") ". Run it again with other handles we hold as verified, labelled :v."
  } else det = "no page carried profile data. " tally(d, "", "@") "."
  if (stopnote != "" && sAny > 0) det = det " (The door stopped answering - " stopnote ".)"
  print d "\tUNSURE\t" det
  xnote(d)
}
function post(d,   i, h, o, yes, att, noat, ncap, a200, stopnote) {
  if (n[d] + 0 == 0) return
  yes = ""; att = ""; noat = ""; ncap = 0; a200 = 0; stopnote = ""
  for (i = 1; i <= n[d]; i++) {
    h = H[d, i]; o = outc[d, h]
    if (stopnote == "" && (o == "wall-redirect" || o == "wall-body" || o == "throttle" || o == "refused")) stopnote = "p/" h ": " what(d, h)
    if (stat[d, h] + 0 == 200 && o == "ok") a200++
    if (pcap[d, h]) {
      ncap++
      if (pment[d, h] > 0) yes = yes "; p/" h " links " pml[d, h]
      else if (patc[d, h] > 0) att = att "; p/" h " holds \"@\" x" patc[d, h] ((paw[d, h] != "") ? " (" paw[d, h] ")" : "")
      else noat = noat " p/" h
    }
  }
  if (yes != "") {
    print d "\tYES\tthe caption came back with its @mentions linked to accounts: " substr(yes, 3) "." ((att != "") ? " As text only: " substr(att, 3) "." : "") ((stopnote != "") ? " (The door then stopped answering - " stopnote ".)" : "")
    return
  }
  if (att != "") { print d "\tATTEXT\t" substr(att, 3) ". The handles are readable in the text; they are just not links."; return }
  if (ncap > 0) { print d "\tNOAT\tthe caption came back for" noat " and holds no \"@\" at all. If those posts do mention accounts, the embed drops them."; return }
  if (stopnote != "" && a200 == 0) { print d "\tREFUSED\t" stopnote "." after_stop(d, "p/"); return }
  if (a200 > 0) { print d "\tNOCAP\t" tally(d, "", "p/") ". The pages came back but no caption was recognised in them - read the snippets."; return }
  print d "\tUNSURE\t" tally(d, "", "p/") "."
}
END {
  profile("ig-profile-embed")
  profile("threads-profile")
  post("ig-post-embed")
}
AWK

# ---- can the awk on this machine run the readers? Asked on a built-in sample BEFORE any request is made, so a
# machine whose awk differs costs Instagram nothing and says so in one line. ----
selftest() {
  local got
  printf '%s\n' 'HTTP/2 200' 'content-type: text/html' 'location: /x' 'Set-Cookie: sid=SECRET; Path=/' > selftest.hdr
  got=$(awk -f hdrkeep.awk < selftest.hdr 2> awk.err | awk -f hdr.awk 2>> awk.err) || return 1
  case "$got" in 200*sid*) ;; *) return 1 ;; esac
  case "$got" in *SECRET*) return 1 ;; esac
  printf '%s\n' '<title>t</title><script>var u=[{"username":"other","is_verified":false},{"username":"self.test","full_name":"Self Test","pic":{"is_verified":false},"is_verified":true,"follower_count":12}];</script>' > raw1
  got=$(awk -v f=raw1 -v ff=flat -v sum=selftest.sum -v flagf=flag -v door=ig-profile-embed -v id=self.test -v handle=self.test \
        -v label=v -v status=200 -v bytes=100 -v outc=ok -f lib.awk -f profile.awk < /dev/null 2> awk.err) || return 1
  case "$got" in *"true x1, false x0 => reads VERIFIED"*) ;; *) return 1 ;; esac
  printf '%s\n' '<div class="Caption"><a href="https:\/\/www.instagram.com\/some.one\/">@some.one</a> hello</div>' > raw1
  got=$(awk -v f=raw1 -v ff=flat -v sum=selftest.sum -v flagf=flag -v door=ig-post-embed -v id=SELFTEST -v handle=SELFTEST \
        -v label=- -v status=200 -v bytes=100 -v outc=ok -f lib.awk -f post.awk < /dev/null 2> awk.err) || return 1
  case "$got" in *"linked @mentions x1"*) ;; *) return 1 ;; esac
  printf 'R\tig-profile-embed\tother.one\tu\tok\t200\t1\nK\tig-profile-embed\tother.one\tis_verified\tF\n' >> selftest.sum
  got=$(awk -f answer.awk < selftest.sum 2> awk.err) || return 1
  case "$got" in *"YES"*"reads true for @self.test and false for @other.one"*"YES"*"p/SELFTEST links @some.one"*) ;; *) return 1 ;; esac
  return 0
}
if ! selftest; then
  item=""
  IFS= read -r item < awk.err || true
  item=$(printf '%s' "$item" | tr -cd '\040-\176')
  stop2 "the awk on this machine cannot run this probe's page readers${item:+ ($item)}. Nothing was asked. Send this line back."
fi
: > flag

# ---- small helpers ----
REQS=0
ANSWERS=0
DOOR_STOP=""
F_RC=0; F_STATUS=""; F_CTYPE=""; F_LOCATION=""; F_COOKIES=""; F_RETRY=""; F_BYTES=0; F_CAPPED=0

out() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >> report.txt
}
clip() {   # text max
  local s="$1" n="$2"
  if [ "${#s}" -gt "$n" ]; then printf '%s...' "${s:0:$n}"; else printf '%s' "$s"; fi
}
pause() { if [ "$REQS" -gt 0 ]; then sleep "$SPACING"; fi; }
label_words() {
  case "$1" in
    v) printf '%s' "held as verified" ;;
    u) printf '%s' "held as NOT verified" ;;
    x) printf '%s' "does not exist" ;;
    *) printf '%s' "no label" ;;
  esac
}
curl_words() {
  local rc="$1" first=""
  IFS= read -r first < err || true
  first=$(printf '%s' "$first" | tr -cd '\040-\176')
  case "$rc" in
    6) printf '%s' "the host name did not resolve" ;;
    7) printf '%s' "could not connect" ;;
    28) printf '%s' "timed out" ;;
    35|51|58|59|60|77) printf '%s' "the TLS handshake failed" ;;
    *) printf '%s' "curl exit $rc" ;;
  esac
  if [ -n "$first" ]; then printf ' [%s]' "$(clip "$first" 110)"; fi
  return 0
}
rec() {   # kind door id label outcome status
  if [ "$1" = profile ]; then printf 'R\t%s\t%s\t%s\t%s\t%s\t0\n' "$2" "$3" "$4" "$5" "$6" >> sum
  else printf 'S\t%s\t%s\t%s\t%s\t0\t0\t0\t0\t\t\n' "$2" "$3" "$5" "$6" >> sum; fi
}
is_login_url() {
  local u path
  u=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
  case "$u" in
    http://*|https://*) path=${u#*://}; case "$path" in */*) path="/${path#*/}" ;; *) path="/" ;; esac ;;
    //*) path=${u#//}; case "$path" in */*) path="/${path#*/}" ;; *) path="/" ;; esac ;;
    *) path=$u ;;
  esac
  case "$path" in
    /accounts/login*|*/accounts/login*|/login|/login/*|/login\?*|/login\#*) return 0 ;;
  esac
  return 1
}
allowed_host() {
  local u="$1" rest hostport host
  if [ "$TEST_HOSTS" -eq 1 ]; then
    case "$u" in "$IG_HOST"|"$IG_HOST"/*|"$TH_HOST"|"$TH_HOST"/*) return 0 ;; esac
    return 1
  fi
  case "$u" in https://*) ;; *) return 1 ;; esac
  rest=${u#*://}
  hostport=${rest%%/*}
  hostport=${hostport%%\?*}
  hostport=${hostport%%\#*}
  host=${hostport%%:*}
  host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
  case "$host" in
    instagram.com|*.instagram.com|threads.com|*.threads.com|threads.net|*.threads.net) return 0 ;;
  esac
  return 1
}
resolve_url() {   # base location -> the next URL, or nothing when it is not one we follow
  local base="$1" loc="$2" scheme rest hostport next
  scheme=${base%%://*}
  rest=${base#*://}
  hostport=${rest%%/*}
  case "$loc" in
    http://*|https://*) next=$loc ;;
    //*) next="$scheme:$loc" ;;
    /*) next="$scheme://$hostport$loc" ;;
    *) return 0 ;;
  esac
  case "$next" in *[!!-~]*) return 0 ;; esac
  allowed_host "$next" || return 0
  printf '%s' "$next"
}
fetch() {   # url mode bodyfile headerfile -> F_RC F_STATUS F_CTYPE F_LOCATION F_BYTES F_CAPPED
  local url="$1" mode="$2" body="$3" hdr="$4" n
  : > "$hdr"
  : > hdr.raw
  : > err
  : > "$body"
  if [ "$mode" = iframe ]; then
    curl -q -sS --proto '=http,https' --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" --compressed \
      -D hdr.raw -o - -A "$UA" "${COMMON_H[@]}" "${IFRAME_H[@]}" "$url" 2> err | head -c "$CAP_PLUS" > "$body"
    F_RC=${PIPESTATUS[0]}
  else
    curl -q -sS --proto '=http,https' --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" --compressed \
      -D hdr.raw -o - -A "$UA" "${COMMON_H[@]}" "${TOP_H[@]}" "$url" 2> err | head -c "$CAP_PLUS" > "$body"
    F_RC=${PIPESTATUS[0]}
  fi
  # No cookie is kept: the values a page tries to set are dropped here, before anything else is asked, and no
  # request ever carries one. Only the names survive, because "this door hands out a cookie" is worth knowing.
  tr -d '\015' < hdr.raw | tr -cd '\012\040-\176' | awk -f hdrkeep.awk > "$hdr" 2>/dev/null
  : > hdr.raw
  n=$(wc -c < "$body" 2>/dev/null) || n=0
  n=$((n + 0))
  F_CAPPED=0
  if [ "$n" -gt "$CAP_BYTES" ]; then F_CAPPED=1; n=$CAP_BYTES; fi
  F_BYTES=$n
  awk -f hdr.awk < "$hdr" > hdr.parsed 2>/dev/null
  F_STATUS=""; F_CTYPE=""; F_LOCATION=""; F_COOKIES=""; F_RETRY=""
  { IFS= read -r F_STATUS; IFS= read -r F_CTYPE; IFS= read -r F_LOCATION; IFS= read -r F_COOKIES; IFS= read -r F_RETRY; } < hdr.parsed
  case "$F_STATUS" in [0-9][0-9][0-9]) ;; *) F_STATUS="" ;; esac
}

# ---- one question: one handle (or post) at one door ----
ask() {   # door kind id label url mode
  local door="$1" kind="$2" id="$3" label="$4" url="$5" mode="$6"
  local shown who hops chain outcome line next outc arc first flagv l
  if [ "$kind" = profile ]; then who="@$id"; shown="@$id ($(label_words "$label"))"; else who="p/$id"; shown="p/$id"; fi
  if [ -n "$DOOR_STOP" ]; then
    out "[$door] $shown -> not asked: $DOOR_STOP"
    rec "$kind" "$door" "$id" "$label" skipped ""
    return 0
  fi
  hops=0; chain=""; outcome=""
  while :; do
    pause
    fetch "$url" "$mode" "$door.$id.body" "$door.$id.hdr"
    REQS=$((REQS + 1))
    if [ -z "$F_STATUS" ]; then outcome=neterr; break; fi
    ANSWERS=$((ANSWERS + 1))
    case "$F_STATUS" in
      301|302|303|307|308)
        if [ -z "$F_LOCATION" ]; then outcome=answered; break; fi
        chain="$chain -> $(clip "$F_LOCATION" 140)"
        if is_login_url "$F_LOCATION"; then outcome=wall-redirect; break; fi
        next=$(resolve_url "$url" "$F_LOCATION")
        if [ -z "$next" ]; then outcome=redirect; break; fi
        if [ "$hops" -ge "$MAX_HOPS" ]; then outcome=redirect; break; fi
        hops=$((hops + 1))
        url=$next
        ;;
      *) outcome=answered; break ;;
    esac
  done
  case "$outcome" in
    neterr)
      line="[$door] $shown -> NO ANSWER: $(curl_words "$F_RC")"
      if [ -n "$chain" ]; then line="$line (after$chain)"; fi
      out "$line"
      rec "$kind" "$door" "$id" "$label" neterr ""
      return 0 ;;
    wall-redirect)
      out "[$door] $shown -> HTTP $F_STATUS$chain = SENT TO THE LOGIN PAGE; this door is not asked again in this run"
      DOOR_STOP="this door sent $who to the login page"
      rec "$kind" "$door" "$id" "$label" wall-redirect "$F_STATUS"
      return 0 ;;
    redirect)
      out "[$door] $shown -> HTTP $F_STATUS$chain = a redirect this probe does not follow (off-site, unreadable, or more than $MAX_HOPS in a row)"
      rec "$kind" "$door" "$id" "$label" redirect "$F_STATUS"
      return 0 ;;
  esac
  line="[$door] $shown -> HTTP $F_STATUS | ${F_CTYPE:-no content type} | $F_BYTES bytes"
  if [ "$F_CAPPED" -eq 1 ]; then line="$line (cut at the 3 MB cap; more was offered)"
  elif [ "$F_RC" -ne 0 ]; then line="$line | the transfer was cut short: $(curl_words "$F_RC")"; fi
  if [ -n "$chain" ]; then line="$line | reached after $hops redirect(s):$chain"; fi
  if [ -n "$F_RETRY" ]; then line="$line | retry-after: $(clip "$F_RETRY" 40)"; fi
  if [ -n "$F_COOKIES" ]; then line="$line | tried to set cookies: $(clip "$F_COOKIES" 90) (none kept)"; fi
  out "$line"
  outc=ok
  case "$F_STATUS" in
    429|401) outc=throttle; DOOR_STOP="this door answered HTTP $F_STATUS at $who" ;;
  esac
  head -c "$CAP_BYTES" "$door.$id.body" | tr -d '\000-\010\013\014\016-\037\177' | tr '\011\012\015' '   ' > raw1
  echo >> raw1
  : > flag
  : > lines
  awk -v f=raw1 -v ff=flat -v sum=sum -v flagf=flag -v door="$door" -v id="$id" -v handle="$id" -v label="$label" \
      -v status="$F_STATUS" -v bytes="$F_BYTES" -v outc="$outc" -f lib.awk -f "$kind.awk" < /dev/null 2> awk.err \
    | tr -cs '\012\040-\176' '~' > lines
  arc=${PIPESTATUS[0]}
  while IFS= read -r l; do out "$l"; done < lines
  if [ "$arc" -ne 0 ]; then
    first=""
    IFS= read -r first < awk.err || true
    first=$(printf '%s' "$first" | tr -cd '\040-\176')
    out "   (this page could not be analysed here: awk exit $arc $(clip "$first" 120))"
    rec "$kind" "$door" "$id" "$label" failed "$F_STATUS"
  fi
  flagv=""
  IFS= read -r flagv < flag || true
  case "$flagv" in
    wall) DOOR_STOP="this door served $who a login page or a require_login refusal" ;;
    refused) DOOR_STOP="this door answered HTTP $F_STATUS with require_login at $who" ;;
  esac
  if [ -n "$DOOR_STOP" ]; then out "   = STOP: $DOOR_STOP; it is not asked again in this run"; fi
  return 0
}

# ---- the run ----
out "-- $SELF — read-only — $OS — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
item=$((NHANDLES * (1 + DO_THREADS) + NPOSTS))
out "   asking as desktop Chrome $CHROME_MAJOR ($CHROME_FROM), no login, no cookie; up to $item requests, $SPACING s apart"
if [ "$TEST_HOSTS" -eq 1 ]; then
  out "   TEST HOSTS IN USE — this is NOT Instagram or Threads: $IG_HOST and $TH_HOST"
fi
for item in "${http_proxy:-}" "${https_proxy:-}" "${HTTPS_PROXY:-}" "${all_proxy:-}" "${ALL_PROXY:-}"; do
  if [ -n "$item" ]; then
    out "   NOTE: a proxy is set in this shell; if curl uses it the answers are about the proxy's address, not this machine's"
    break
  fi
done
out "   What these pages hold was unknown before this ran. In the lines below \"~\" stands for bytes outside printable ASCII."

out ""
DOOR_STOP=""
for item in $HANDLES; do
  ask ig-profile-embed profile "${item%%:*}" "${item#*:}" "$IG_HOST/${item%%:*}/embed/" iframe
done

if [ "$DO_THREADS" -eq 1 ]; then
  out ""
  DOOR_STOP=""
  for item in $HANDLES; do
    ask threads-profile profile "${item%%:*}" "${item#*:}" "$TH_HOST/@${item%%:*}" top
  done
fi

if [ "$NPOSTS" -gt 0 ]; then
  out ""
  DOOR_STOP=""
  for item in $POSTS; do
    ask ig-post-embed post "$item" "-" "$IG_HOST/p/$item/embed/captioned/" iframe
  done
fi

# ---- the answers ----
awk -f answer.awk < sum > answers 2> awk.err
arc=$?
out ""
out "== ANSWER — one line per door; the evidence is in the blocks above"
if [ "$arc" -ne 0 ]; then
  out "   the answers could not be worked out here (awk exit $arc); the blocks above still stand"
fi
SAID_IGP=0; SAID_THR=0; SAID_IGX=0
while IFS=$'\t' read -r door code detail; do
  case "$door" in
    ig-profile-embed) name="PROFILE EMBED, the badge:   "; kind=profile; if [ "$code" != NOTE ]; then SAID_IGP=1; fi ;;
    threads-profile)  name="THREADS PROFILE, the badge: "; kind=profile; if [ "$code" != NOTE ]; then SAID_THR=1; fi ;;
    ig-post-embed)    name="POST EMBED, the @mentions:  "; kind=post; if [ "$code" != NOTE ]; then SAID_IGX=1; fi ;;
    *) continue ;;
  esac
  case "$kind.$code" in
    profile.YES)     out "   $name YES — distinguishes. $detail" ;;
    profile.NOBADGE) out "   $name SERVED, BUT THE BADGE IS NOT IN IT — $detail" ;;
    post.YES)        out "   $name YES — $detail" ;;
    post.ATTEXT)     out "   $name SERVED, WITH THE @ IN THE CAPTION TEXT BUT NOT LINKED — $detail" ;;
    post.NOAT)       out "   $name SERVED, BUT WITHOUT ANY @ — $detail" ;;
    post.NOCAP)      out "   $name SERVED, BUT WITHOUT A CAPTION — $detail" ;;
    *.REFUSED)       out "   $name REFUSED — $detail" ;;
    *.NOTE)          out "      ($detail)" ;;
    *)               out "   $name COULD NOT TELL — $detail" ;;
  esac
done < answers
if [ "$SAID_IGP" -eq 0 ]; then out "   PROFILE EMBED, the badge:    COULD NOT TELL — no fact was recorded for this door."; fi
if [ "$DO_THREADS" -eq 0 ]; then out "   THREADS PROFILE, the badge:  not asked (--no-threads)."
elif [ "$SAID_THR" -eq 0 ]; then out "   THREADS PROFILE, the badge:  COULD NOT TELL — no fact was recorded for this door."; fi
if [ "$NPOSTS" -eq 0 ]; then out "   POST EMBED, the @mentions:   not asked (--no-posts)."
elif [ "$SAID_IGX" -eq 0 ]; then out "   POST EMBED, the @mentions:   COULD NOT TELL — no fact was recorded for this door."; fi
out "-- $REQS request(s) made, $ANSWERS answered. A YES means a parser can be built on that door; nothing was changed anywhere."

if [ "$KEEP" -eq 1 ]; then
  printf '%s\n' "-- kept: $TMP (one .body and one .hdr per page, and report.txt). It holds public pages only; delete it when done."
fi
if [ "$ANSWERS" -gt 0 ]; then exit 0; fi
exit 1
