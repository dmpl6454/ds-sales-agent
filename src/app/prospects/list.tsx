'use client'

import { useState } from 'react'
import { setTargetWatch } from '../actions'
import type { ProspectRow } from '../view-model/prospects-page'
import type { ChannelCard } from '../view-model'

/** Handle → the two counts the mockup states for a watched page. Built once per render,
 *  not once per row — `channels` is at most a handful of rows. */
function statsByHandle(channels: ChannelCard[]): Map<string, ChannelCard> {
  return new Map(channels.map((c) => [c.handle, c]))
}

/**
 * Everyone we might write to, and the ONE decision a person still makes about each: do we
 * read their posts.
 *
 * NOT a chip per route, and since 2026-08-08 not a route count either. At 65 senders and 60
 * targets a chip per route is 3,900 controls, which was never a layout problem — it is the
 * wrong control, because nobody decides 3,900 routes one at a time.
 *
 * ── AND THEN THE COUNT WENT TOO (one switch) ───────────────────────────────
 *
 * "0 of 63 routes on" was the honest answer to *will anything happen here* while a route was
 * switchable. It is not any more: every allowed route now exists by rule and nothing on a page
 * turns one off, so the figure measured something nobody could act on — and a number that
 * cannot be changed is furniture on a page a CEO reads.
 *
 * What answers the question instead is ABILITY: how many accounts can actually send, plus
 * whether this recipient is retired. Both are facts about the world rather than settings, which
 * is the whole point of the one-switch change.
 */
export function ProspectList({
  prospects,
  sendersAble,
  messagedTotal,
  channels = [],
}: {
  prospects: ProspectRow[]
  sendersAble: number
  /** The messaged group's FULL count — the rows in hand are one page of it (2026-09-04). */
  messagedTotal: number
  /**
   * WHAT A WATCHED PAGE'S OWN ROW SAYS (2026-09-21). The mockup's "Pages we watch" row is
   * `@handle followers … N posts read this week · M paid this week`, and this list had no
   * such figure to show — `ProspectRow` carries `nextSenderSentence`, a fact about SENDING,
   * which is a category error on a row that is never sent to. `ChannelsPanel` computes
   * exactly these two counts already (`buildChannelsView`, run beside `buildProspectsPage`
   * in `targets/page.tsx`); passed down here rather than queried twice.
   */
  channels?: ChannelCard[]
}) {
  const stats = statsByHandle(channels)
  if (prospects.length === 0) {
    return (
      <section className="group">
        <h2>No prospects yet</h2>
        <p className="group-blurb">
          Paste a list above to add some. Nothing is sent to anyone while Autopilot is off.
        </p>
      </section>
    )
  }

  /**
   * ── GROUPED BY `role`, NOT BY `kind` (2026-08-17) ──────────────────────────
   *
   * This split on `kind` — CHANNEL against BRAND — and CLAUDE.md says in as many words why
   * that is a trap: **`kind === 'CHANNEL'` is NOT "a page we watch"**. `importProspects`
   * creates messageable prospects as CHANNEL, so the first list anyone imported would have
   * appeared under the heading for pages we never write to.
   *
   * The two columns agree on all 99 rows today, which is exactly why reading the page could
   * not catch it. `role` is the column the 17 August restructure made authoritative, and it
   * is the one that decides whether a message may be sent.
   */
  /**
   * ── THE HEADINGS COUNT WHAT THEY CLAIM, AND RETIRED IS NOT IT ─────────────
   *
   * FOUND BY AUDITING THE RENDERED PAGE AGAINST THE DATABASE, 2026-08-17: the heading read
   * "Companies we message (95)" while **13 of those 95 are retired and can never be
   * messaged by any sender**, and "Pages we watch (4)" while 2 of the 4 are retired. A
   * heading that states a capability must count the rows that have it.
   *
   * Retired rows are still LISTED — they are not deleted, and hiding them would make a
   * retirement invisible — but they are counted separately and named, so the number beside
   * the claim is the number the claim is true of.
   */
  const watched = prospects.filter((p) => p.role === 'WATCH')
  const messaged = prospects.filter((p) => p.role !== 'WATCH')

  return (
    <>
      <Group
        title="Pages we watch"
        note="We read their feed to find paid posts. They are never messaged — several are competitors."
        rows={watched}
        sendersAble={sendersAble}
        stats={stats}
      />
      <Group
        title="Companies we message"
        note="Found inside those paid posts, or added by hand. Their posts are not read; we only write to them."
        rows={messaged}
        total={messagedTotal}
        sendersAble={sendersAble}
        stats={stats}
      />
    </>
  )
}

function Group({
  title,
  note,
  rows,
  total,
  sendersAble,
  stats,
}: {
  title: string
  note: string
  rows: ProspectRow[]
  /** When the rows are ONE PAGE of a larger group, the heading names the group's total. */
  total?: number
  sendersAble: number
  stats: Map<string, ChannelCard>
}) {
  if (rows.length === 0 && !total) return null
  /* Every row here is live: retired targets are excluded at the query (2026-08-25, Tabish),
     so the heading count and the rows below it cannot disagree. */
  return (
    <section className="group">
      <h2>
        {title} ({total ?? rows.length})
      </h2>
      {/* Which of the two kinds this is, said once per group rather than once per row. */}
      <p className="group-blurb">{note}</p>
      <div className="group-rows">
        {rows.map((p) => (
          <Row key={p.handle} p={p} sendersAble={sendersAble} channel={stats.get(p.handle) ?? null} />
        ))}
      </div>
    </section>
  )
}

/**
 * ── THE ROW'S OWN COLOUR — WIRED, NOT JUST DECLARED ─────────────────────────
 *
 * `--row-accent` has existed on `.message`'s CSS since the redesign (`border-left: 4px
 * solid var(--row-accent, var(--text-dim))`) and nothing here ever SET it — every row,
 * watch page and message company alike, fell through to the one dim fallback. The
 * mockup colours each company row by what is about to happen to it (green once a
 * sender will actually write, gold while a reply holds it, dim otherwise); ours drew
 * all of them identically, which is the CSS half of a feature shipping with no caller.
 *
 * A watch page is deliberately excluded from all of this: it is never messaged, so
 * nothing here is a fact about it, and the mockup draws every one of its rows in the
 * same neutral `--text-dim` regardless of how much it has posted.
 */
function rowAccent(p: ProspectRow): string {
  if (p.role === 'WATCH') return 'var(--text-dim)'
  if (p.retired) return 'var(--text-dim)'
  if (p.replied) return 'var(--pending)'
  if (p.nextSenderWillWrite) return 'var(--good)'
  return 'var(--text-dim)'
}

function Row({
  p,
  sendersAble,
  channel,
}: {
  p: ProspectRow
  sendersAble: number
  /** Only ever set for a `role === 'WATCH'` row — see `ProspectList`'s `channels` prop. */
  channel: ChannelCard | null
}) {
  const [busy, setBusy] = useState<'watch' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const flipWatch = async () => {
    setBusy('watch')
    setMsg(null)
    try {
      const r = await setTargetWatch(p.handle, !p.watchEnabled)
      setMsg(r.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="message" style={{ ['--row-accent' as string]: rowAccent(p) }}>
      <div className="message-head">
        <div>
          <strong>@{p.handle}</strong>{' '}
          <span className="muted">
            {p.displayName !== p.handle ? p.displayName : ''}
            {p.delivered > 0
              ? `${p.displayName !== p.handle ? ' · ' : ''}${p.delivered} message${p.delivered === 1 ? '' : 's'} delivered`
              : ''}
          </span>
        </div>
        {p.replied && <span className="chip chip-live">they replied</span>}
        {/*
          WHICH FLEET (2026-08-25). Shown only when the row carries an explicit membership —
          the default category is the ABSENCE of one, and a chip on all 500 bollywood rows
          saying "bollywood" would be furniture. A marketing chip, on the other hand, is the
          answer to "why is nothing writing to this company?".
        */}
        {p.categories.map((c) => (
          <span className="chip" key={c}>
            {c}
          </span>
        ))}
        {/*
          THE MOCKUP'S OWN FIGURE FOR A WATCHED PAGE — posts read, and how many were paid —
          in place of a sending fact that does not apply to it. `channel` is only ever set
          for a `role === 'WATCH'` row (see `ProspectList`).
        */}
        {channel ? (
          <span className="muted watch-stats">
            {channel.postsThisWeek} post{channel.postsThisWeek === 1 ? '' : 's'} read this week
            {channel.unclassified ? ' · not classified' : ` · ${channel.campaignsThisWeek} paid this week`}
          </span>
        ) : null}
      </div>

      {/*
        The reply halt, said in full rather than as a chip alone. It stops every account
        from writing to this person, which is a bigger fact than a badge implies.
      */}
      {p.replied && (
        <p className="account-message">They replied — messaging pauses for seven days, then resumes on its own.</p>
      )}

      {/*
        NOTHING IS JUDGING THEIR POSTS. Bad, not muted: a watched channel on a detector that
        classifies nothing stores posts forever and finds zero paid campaigns, which reads on
        every other screen as "they do no paid work". The sentence comes from the detector's
        own `readiness()`, so a channel whose classifier has no API key and one with no
        classifier at all are two different problems with two different fixes.
      */}
      {p.unjudgedNote !== null && <p className="account-message bad">{p.unjudgedNote}</p>}

      {/*
        OUR OWN PAGE. Stated on the row rather than in a rationale page, because the decision
        it belongs to — leaving reading off — is made here.
      */}
      {p.groundTruthNote !== null && <p className="account-message">{p.groundTruthNote}</p>}

      {/*
        ── WILL ANYTHING HAPPEN HERE — A FACT, NOT A CHIP WALL ────────────────

        This was a collapsible chip per sender×recipient route: twenty today, 3,900 at 65×60.
        The chips went with the per-route action (one switch, 2026-08-08) — routes are decided
        by one rule and created automatically now, so there was nothing left to click.

        The SENTENCE stays, because answering "will anything be sent to this person" is what
        the chips were really for, and removing a control must never remove an explanation.

        WHAT IT SAYS CHANGED ON 2026-08-13, AND THE OLD WORDING WAS THE PROBLEM. It read
        "Messaged automatically by rotation while Autopilot is on (N accounts able to send)".
        Every word was true except the load-bearing one: rotation was NOT happening —
        `whoseTurn` returned null for every recipient, so all N accounts wrote to them, not one
        in turn. MEASURED: 7 recipients holding a draft from all three fleet accounts. The row
        described the design while the system did the opposite, and a count of accounts *able*
        to send reads as capacity rather than as what will actually be written.

        It now names the ONE account, from the same function the planner asks. `sendersAble`
        stays beside it as the fleet-wide fact it always was — ability, so it reads zero when
        the fleet is signed out even while Autopilot is on.

        Retired is stated first and absolutely, and it is the only branch here: `optedOut` is
        the one promise this UI makes that has to survive every other feature.
      */}
      {/*
        `nextSenderWillWrite` decides whether the fleet-capacity figure belongs here at all.

        MEASURED 2026-08-13: 8 of the 70 BRAND rows are people — film directors, an actor —
        and the planner refuses every one of them (`checkRecipientIsNotAPerson`). This row
        told a reader "Next message comes from @bollywoodchronicle" about all eight. Those
        rows were deliberately left for a person to JUDGE, and this page was the one place
        someone would see they are people; it was saying the opposite. The sentence is now
        the planner's own refusal, and "N accounts can send" is dropped with it — a capacity
        figure beside a refusal re-reads as a promise.
      */}
      {/*
        A WATCH ROW IS NEVER SENT TO, SO A SENTENCE ABOUT WHO SENDS NEXT IS A CATEGORY
        ERROR ON IT (2026-09-21) — `routes.ts` refuses to create a route to one at all,
        which is why `nextSenderSentence` always resolved to "No account is in the
        rotation for them, so nothing will be written": true, and about the wrong
        question. The mockup never asks it of a watched page; the stats line above
        answers the question this row actually raises, which is whether reading it is
        working.
      */}
      {p.role === 'WATCH' ? null : (
        <p className="muted">
          {p.nextSenderWillWrite
            ? `${p.nextSenderSentence} ${sendersAble} account${sendersAble === 1 ? '' : 's'} in the fleet can send right now.`
            : p.nextSenderSentence}
        </p>
      )}

      <div className="account-actions">
        {/*
          The "rotation group" text input that sat here was removed 2026-08-07 — a
          free-text field configuring a mechanism that has never been set up (the
          Category table is empty) read as something the operator ought to understand.
          `setTargetCategory` and the rotation code are untouched.
        */}
        {/*
          ── ONLY A WATCHED PAGE HAS POSTS WE READ (2026-08-17, Tabish) ───────────
          *"there is no need for 'read their posts every check' for the other type of targets
          that only need messages to be sent, no post tracking."*

          He is right, and it was worse than clutter: the control was OFFERED on 95 company
          rows, where turning it on would spend four feed requests per pass on an account
          whose posts nothing classifies — `pipeline.ts` reads `kind: 'CHANNEL'`, so a BRAND
          row with watching on is pure cost for no verdict. A control that does nothing is
          worse than an absent one, because someone will press it and believe it worked.
        */}
        {p.role === 'WATCH' ? (
          <button className="link-quiet" type="button" onClick={flipWatch} disabled={busy !== null}>
            {busy === 'watch'
              ? 'Saving…'
              : p.watchEnabled
                ? 'stop reading their posts'
                : 'read their posts every check'}
          </button>
        ) : null}
      </div>

      {msg && <p className="account-message">{msg}</p>}
      {p.legitimacy && <p className={p.legitimacy.includes('— review:') ? 'account-message' : 'muted'}>{p.legitimacy}</p>}
      {p.importNote && <p className="muted">{p.importNote}</p>}
    </div>
  )
}
