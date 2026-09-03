DS SALES AGENT — SETUP
======================

What you need before starting (all three come from Tabish):
  1. The DATABASE_URL           (one line, starts with postgresql://)
  2. The tunnel key file        (a small file called ds_tunnel_key)
  3. The shared dashboard login (an email and password — no sign-up needed)

Also install Google Chrome if this Mac does not have it.

Steps
-----
1. Double-click "DS Sales Agent.app". It is signed with an Apple Developer ID and
   notarised by Apple, so it opens normally — no security warnings, nothing to
   allow in System Settings.

   A Terminal window opens and walks you through the setup: paste the
   DATABASE_URL, point it at the key file, give this machine a name. It installs
   everything and keeps the agent running 24/7, surviving restarts.

2. The dashboard is the website: https://e035e4d46c.digitalsukoon.com — bookmark
   it. Drag the app into Applications if you like; once an install exists, opening
   it just opens that URL.

3. Only if something still blocks the app — an old unsigned copy of this image, or
   a Mac under a managed security policy — the identical installer runs from
   Terminal instead:

     bash "/Volumes/DS Sales Agent/DS Sales Agent.app/Contents/Resources/install.sh"

4. Sign in on the dashboard with the shared login. On the Senders page, add
   your Instagram page as a sending account and press Connect: a Chrome window
   opens ON THIS MAC (the dashboard relays the request to your machine) — sign
   in to Instagram there once, then close it. The Senders page shows the
   account as signed in within a minute.

   If the window does not open, the fallback is the same act from a terminal:
     cd ~/ds-sales-agent && pnpm ig:login <yourhandle>

That is the only manual act — the login writes this Mac's device identity,
which is what keeps the account safe, and it cannot be done for you. Each
Instagram account should live on exactly ONE Mac: never connect the same
account from two machines.

What runs where
---------------
Paid-post detection, targets and message planning all run centrally — you
inherit them as they are. This Mac only SENDS, from the account(s) you
connected, from your own home IP, at the fleet's usual pace. Keep the lid
open; a sleeping Mac sends nothing.

Nothing on this disk image contains credentials.
