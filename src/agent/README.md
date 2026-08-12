# The device agent

The one process that runs on a **user's own Mac or Windows machine**, holding their
Instagram sessions and doing the sending. Everything else — the dashboard, detection, the
classifier, the database — runs on the server.

## Why the split exists at all

The server cannot send, and this is not a configuration choice.

A send drives a real Chrome profile that was logged into **by hand, from a home IP**. That
login writes durable device identifiers (`mid`, `ig_did`, `ig-u-rur`) and records a login
event binding the browser to the account from that network. Automation then drives the
same profile forever after, and Instagram sees a device it already knows.

Copying that profile to a datacenter is a **session transplant in all but name**.
`sessionid` is a bearer token with no channel binding, so a transplant *works* — right up
until enforcement lands silently. Research (2026-07-30, 18 agents, 10 of 12 load-bearing
claims refuted on adversarial verification) established device + network continuity as a
**pass/fail gate, not a score**. On a multi-user product it would be worse still: every
customer's account appearing from one datacenter IP is a correlation surface far beyond
the 65-sender problem the fleet design already worries about.

So: **the server proposes, the device disposes.**

```
SERVER (Linode)                          USER'S OWN MACHINE
──────────────                           ──────────────────
detects paid posts                       this agent
writes drafts                            their Chrome profiles
shows the queue                          their Instagram sessions
marks a draft REQUESTED     ─────────►   claims it atomically
                                         RE-RUNS gate.ts locally
                                         drives Chrome from THEIR IP
SENT / held / failed        ◄─────────   writes the outcome back
SEND_ENABLED=false
```

## What "the device is off" means, honestly

Closing the browser tab is fine — the tab was never the sender.

**A powered-off machine cannot send**, and no amount of engineering changes that without
the transplant above. Tabish was told this plainly on 2026-08-08 and chose
queue-and-send-on-return:

- drafts wait as `READY` while the agent is offline,
- the dashboard says *"waiting for your device — last seen 2 h ago"*,
- the agent sends them on reconnect, under the **ordinary pacing rules**.

Nothing is lost, nothing is dropped, and nothing is rushed on return — a device coming
back after a day must not empty its queue into one inbox, which is the recipient-side
pattern the whole dispatcher design exists to avoid.

## The rules this agent must keep

1. **Re-run the gate locally.** The server's verdict was computed when the draft was
   written and may be minutes or days old. `gate.ts` is asked again *here*, where the send
   happens. A compromised or buggy server must not be able to make a device send something
   its own gate refuses.
2. **Claim atomically.** `updateMany` with the status in the `where` clause, and check the
   count. A check-then-write is not a guard — that exact bug let a double click send twice,
   and again let two concurrent slots run.
3. **One clipboard, one send.** `withSendLock` still wraps every browser drive. The lock is
   per machine, which is correct: the clipboard being contended is a property of the
   device, not of the fleet.
4. **Never accept a body from the server.** The stored `renderedBody` is the single source
   of truth and the composer read-back compares against exactly it. The agent reads that
   field; it does not let anything else supply text to paste.
5. **Report the truth.** `CHALLENGED`, `sessionInvalidAt`, `not-in-thread` — all written
   back through their existing single writers (`markChallenged`, `markSessionInvalid`), so
   the circuit breaker and the dashboard see what the device saw.
