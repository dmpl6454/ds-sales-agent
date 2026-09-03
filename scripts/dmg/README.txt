DS SALES AGENT — SETUP
======================

What you need before starting (all three come from Tabish):
  1. The DATABASE_URL           (one line, starts with postgresql://)
  2. The tunnel key file        (a small file called ds_tunnel_key)
  3. The shared dashboard login (an email and password — no sign-up needed)

Also install Google Chrome if this Mac does not have it.

Steps
-----
1. Open Terminal (press Cmd+Space, type "Terminal", press Enter) and paste this ONE
   line, then press Enter:

     bash "/Volumes/DS Sales Agent/DS Sales Agent.app/Contents/Resources/install.sh"

   It walks you through everything: paste the DATABASE_URL, point it at the key file,
   give this machine a name. It installs everything and keeps the agent running 24/7,
   surviving restarts. Running it from Terminal is deliberate — see the note below.

2. The dashboard is the website: https://e035e4d46c.digitalsukoon.com — bookmark it.
   The app icon is optional (once an install exists it only opens that URL), and macOS 15
   will still ask you to allow it once — see step 3.

3. Why not double-click the app? It is not signed with an Apple certificate, and since
   macOS 15 (Sequoia) a double-click on such an app shows only "Apple could not verify
   'DS Sales Agent' is free of malware" with a Done button — the old right-click → Open
   trick no longer exists. If you would rather open the app than use Terminal: click
   Done, open System Settings → Privacy & Security, scroll to the Security section,
   click "Open Anyway" next to the DS Sales Agent message, then open the app again.
   Either path runs the same installer.

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
