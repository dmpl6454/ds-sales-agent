DS SALES AGENT — SETUP
======================

What you need before starting (all three come from Tabish):
  1. The DATABASE_URL           (one line, starts with postgresql://)
  2. The tunnel key file        (a small file called ds_tunnel_key)
  3. The shared dashboard login (an email and password — no sign-up needed)

Also install Google Chrome if this Mac does not have it.

Steps
-----
1. Drag "DS Sales Agent.app" into your Applications folder (or run it from here).
2. RIGHT-CLICK the app and choose Open (the first time only — the app is not
   signed with an Apple certificate, so a normal double-click is refused).
3. A Terminal window opens and walks you through it: paste the DATABASE_URL,
   point it at the key file, give this machine a name. It installs everything
   and keeps the agent running 24/7, surviving restarts.
4. Sign in on the dashboard with the shared login, ask Tabish to add your
   Instagram page as a sending account, then connect it once from this Mac:

     cd ~/ds-sales-agent && pnpm ig:login <yourhandle>

That is the only manual act — the login writes this Mac's device identity,
which is what keeps the account safe, and it cannot be done for you.

What runs where
---------------
Paid-post detection, targets and message planning all run centrally — you
inherit them as they are. This Mac only SENDS, from the account(s) you
connected, from your own home IP, at the fleet's usual pace. Keep the lid
open; a sleeping Mac sends nothing.

Nothing on this disk image contains credentials.
