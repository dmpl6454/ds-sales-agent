# Runbook — running the agent on macOS or Windows

For the person operating this day to day. `CLAUDE.md` explains *why* things are the way
they are; this is *what to do*.

Everything here assumes one machine, at your own internet connection, with a real
desktop. That is not incidental — it is the safety design. See "Where this must run".

---

## Before the first run

| | macOS | Windows |
|---|---|---|
| Node | 22 or newer | 22 or newer |
| pnpm | `npm i -g pnpm` | `npm i -g pnpm` |
| **Google Chrome** | required — the real Chrome, not Chromium | required |
| Build tools | Xcode CLT (`xcode-select --install`) | "Desktop development with C++" if `pnpm install` fails to build `better-sqlite3` |

Chrome specifically, not Chromium: the sender launches `channel: 'chrome'` because
Chromium has a distinguishable build and a different user agent. Do not substitute it.

```
pnpm install
pnpm db:push
pnpm db:seed
pnpm start
```

Then open **http://127.0.0.1:3000**.

---

## The dashboard is deliberately not on your network

`pnpm start` binds `127.0.0.1` only. That is a safety decision, not an oversight: the
page carries live "Send from @&lt;revenue account&gt;" buttons, the Autopilot toggle, Auto-send
switches and Remove, with no login. Before this was fixed it answered on the LAN, so
anyone on the same café or office Wi-Fi could have sent a DM from a revenue account.

If you genuinely need to reach it from another machine, tunnel — do not rebind:

```
ssh -L 3000:127.0.0.1:3000 you@the-machine
```

Then use `http://127.0.0.1:3000` on your own laptop. Never expose port 3000 directly.

---

## Connecting an account

1. Press **Connect** on the account's row.
2. A real Chrome window opens on that account's own profile directory.
3. **Log in in that window.** Type the password yourself. Nothing in this repo reads,
   stores or transmits a password — there is no field for one.
4. Complete 2FA in the same window if asked.
5. Accept "Save your login info" if offered.
6. The page notices by itself and the row turns green.

A login prompt always means the browser has no session — never that the agent lost one.

**If it says an account needs a 2FA code:** that is routine and the account is **not**
flagged. Press Connect and enter the code. This used to mark the account `CHALLENGED`
and halt it, which was wrong.

---

## When an account is halted

A red row saying *"locked by Instagram"* means `CHALLENGED`: Instagram showed a
checkpoint, a suspension notice, or an in-page block such as "Action Blocked". Nothing
was retried, and nothing will be — retrying into a checkpoint is how a recoverable flag
becomes a ban.

**What to do:**

1. Open the account yourself, in the normal way you use Instagram — phone or a normal
   browser window. **Not** by launching its profile directory (see the warning below).
2. Deal with whatever Instagram is asking.
3. Only then press **Clear the halt** on the dashboard and confirm.

Clearing is a separate, explicit act on purpose. It used to happen as a side effect of
pressing Connect, which meant a flagged account went back to ACTIVE in one click with
nobody having looked at it. A working session is not evidence the cause was addressed.

Clearing does **not** switch auto-send back on. Coming back from a halt and returning to
unattended sending are two decisions.

---

## The four switches for unattended sending

All four must be true or the message is **prepared and waits for a click** — never
dropped:

1. `AUTOPILOT_ENABLED=true` in `.env` — may this machine ever send unattended. The
   dashboard cannot cross this; a web page should not be able to start unattended sending.
2. The **Autopilot** toggle on the dashboard. Defaults off.
3. That account's own **Auto-send** switch. Accounts graduate one at a time.
4. A Chrome profile actually logged in by hand.

The dashboard also shows the scheduler heartbeat, in red when stale. A toggle that
promises behaviour has to show whether anything is behind it.

---

## Never open a sending profile with ordinary Chrome

Profiles live at:

- macOS: `~/.ds-sales-agent/chrome-profiles/<handle>`
- Windows: `%USERPROFILE%\.ds-sales-agent\chrome-profiles\<handle>`

**On macOS this is measured and unrecoverable.** Patchright launches Chrome with
`--use-mock-keychain --password-store=basic`, so the cookie-encryption key is a public
constant rather than a Keychain entry. Ordinary Chrome derives its key from the Keychain,
cannot decrypt these cookies, and **deletes the rows it cannot read** — taking `mid`,
`datr` and `ig_did` with them. That destroys the device identity the whole design exists
to preserve, so the next login looks like new hardware to Instagram. Returning to
Patchright does not recover it.

**On Windows this is UNVERIFIED.** Windows Chrome encrypts cookies with DPAPI, not a
constant, so both browsers may share the same key and the deletion behaviour may not
occur at all. Nobody has measured it. Until somebody does, on a throwaway account, treat
the macOS rule as applying to Windows too — the downside of an unnecessary prohibition is
mild, and the downside of being wrong is unrecoverable.

If a manual launch is genuinely unavoidable, carry the same flags:

```
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=<profile> --password-store=basic --use-mock-keychain

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --user-data-dir=<profile> --password-store=basic --use-mock-keychain
```

The normal way to open a profile is `pnpm ig:login <handle>` or the Connect button.

---

## Back up `~/.ds-sales-agent`, and treat it as a password file

It holds device identity that **cannot be rebuilt**. A profile that has been logged into
once, even if the session later expires, is worth more than a fresh one: Instagram sees a
device it already knows.

On macOS the encryption key is a constant and not machine-bound, so **anyone with a copy
of the directory can decrypt the session cookies offline**. Backups, cloud-synced folders
and screen shares all count. Keep the backup somewhere you would keep a password.

A profile can hold `mid` / `datr` / `ig_did` with no `sessionid` — device identity
without a session. That is a good state, not a broken one. Do not delete it.

---

## Day to day

| | |
|---|---|
| `pnpm start` | the dashboard, and the scheduler with it |
| `pnpm queued` | every prepared message, and what the safety gate held back |
| `pnpm ig:audit` | cross-check every dashboard number against the database |
| `pnpm ig:thread <sender> <target>` | open the real conversation and read it back |
| `pnpm ig:reply <sender> <target>` | record that someone replied — halts outreach to them |
| `pnpm burner status` | which routes are live; `on`/`off` toggles rehearsal mode |
| `pnpm run:slot` | run one slot now, instead of waiting |

**Rebuild before starting, never during.** `next start` reads the build manifest at boot,
so rebuilding underneath it serves HTML referencing chunks that no longer exist.

---

## Sleep, and what actually keeps running

| | |
|---|---|
| Close the browser tab | **no effect** — the scheduler is in the server process, not the page |
| Close the terminal | **no effect** — the process detaches |
| **Close the laptop lid** | **stops while asleep.** Slots due during sleep are replayed on wake if younger than `CATCHUP_WINDOW_MINUTES` (240) |
| Quit / reboot | catch-up-on-boot covers the most recent missed slot, same window |

So the machine must be awake at 11:00 / 15:00 / 17:00 / 20:00 IST, or the slot runs late
rather than on time. A machine asleep across a whole four-hour window still misses it.

---

## Where this must run

The same home/office internet connection the accounts normally use. **No VPS, no VPN, no
proxy.**

This is the single load-bearing safety choice in the design. What gets accounts banned is
a session appearing on a device or network that has never seen it. Running from a
datacenter IP contradicts that directly, and the obvious mitigation — a residential proxy
— was researched and rejected, because it converts a normal pattern into an evasion
pattern.

A desktop at your own connection satisfies the requirement. That is why the deployment
target is macOS and Windows rather than a Linux server.

---

## If something looks wrong

Start with `pnpm queued`. Every held pair states its reason. The reasons that matter:

| Reason | Means |
|---|---|
| `target-replied` | they answered — outreach to that channel is halted, permanently and on purpose |
| `lifetime-send-cap-reached` | `MAX_TOTAL_SENDS` in `.env` is full; nothing can send until it is raised deliberately |
| `cooldown-active` | spacing between touches, 7 days by default |
| `no-new-material-to-reference` | nothing new to say since the last message; waiting on a fresh campaign |
| `pair-disabled` | route off, or rehearsal mode is on |
| `auto-send-off` | that account has not been graduated to unattended sending |

Then `pnpm ig:audit` to confirm the dashboard's numbers match the database.

**`0 posts parsed` is an alarm. `60 parsed / 0 paid` is a quiet day.** Detection can never
block outreach, so a broken feed shows up as messages without a specific hook, not as
silence.
