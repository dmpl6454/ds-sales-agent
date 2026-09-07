DS SALES AGENT — SETUP
======================

You need: a Mac with Google Chrome installed. Nothing else — no keys, no database
details, and no dashboard login of your own: the Mac appears on whoever runs the
dashboard's Senders page and they approve it from there. Ask them for a login only
if you want to watch the dashboard yourself.

Steps
-----
1. Double-click "DS Sales Agent.app". It is signed and notarised by Apple, so it opens
   with no security warnings. A small dialog asks you to confirm a name for this Mac
   (it is pre-filled). Click Continue.

2. A browser tab opens on the dashboard. Either approve it yourself if you have a
   login, or read the code and key from the installer window to whoever runs the
   dashboard — the Mac is already listed on their Senders page. Check that it shows
   the same code and key as the dialog on your Mac, and click "Approve this Mac".
   That is the whole hand-over: this Mac now has its own, forward-only access to the
   shared database — no shell, no files, one port — and it can be revoked on the
   Senders page at any time.

3. Wait for the "ready" dialog (2-4 minutes on the first run; the setup installs a
   private Node runtime and the code, and starts the agent so it runs 24/7 and
   survives restarts). Click "Open dashboard".

4. On the Senders page, add your Instagram page as a sending account and press
   Connect beside it: a Chrome window opens ON THIS MAC — sign in to Instagram there
   once, then close it. That login is the one act nobody can do for you; it writes
   this Mac's device identity, which is what keeps the account safe.

Each Instagram account should live on exactly ONE Mac: never connect the same
account from two machines.

What runs where
---------------
Paid-post detection, targets and message planning run centrally — you inherit them.
This Mac only SENDS, from the account(s) you connected, from your own home internet,
at the fleet's usual pace. Keep the lid open; a sleeping Mac sends nothing.

If something goes wrong
-----------------------
The setup writes a log at ~/Library/Logs/ds-sales-agent-install.log and shows any
failure in a dialog. If the app itself will not open (an old copy of this image, or
a Mac under a managed security policy), the identical setup runs from Terminal:

  bash "/Volumes/DS Sales Agent/DS Sales Agent.app/Contents/Resources/install.sh"

Nothing on this disk image contains credentials.
