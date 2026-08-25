'use client'

/**
 * WHICH WATCHED CHANNEL'S PAID POSTS AM I LOOKING AT?
 *
 * Tabish, 2026-08-25: *"There must be a filter to show in a list (with back button to go
 * further back and see data page wise) via dropdown where we can select a target channel
 * name via dropdown (the monitoring target) and see paid posts with respect to them only."*
 *
 * ── IT IS A GET FORM, AND THAT IS THE LOAD-BEARING PART ────────────────────
 *
 * The whole state of this page lives in the URL — `?channel=` and `?page=` — for the same
 * reason the history pager on `/analytics` is plain links rather than a client control: a
 * position survives a refresh, can be bookmarked, and can be pasted to somebody else. A
 * `useState` dropdown would lose all three and would also need the table to become a client
 * component, which is the `waiting.tsx -> gate.ts -> better-sqlite3` trap that returned HTTP
 * 500 on every route.
 *
 * So this component holds NO state and imports NOTHING from the server. `onChange` submits
 * the form it is already inside; the button submits it without JavaScript. Both paths do the
 * identical thing — a plain GET navigation — so there is one behaviour to reason about, not
 * a fast path and a fallback that can drift.
 *
 * ── CHANGING THE CHANNEL RESETS TO PAGE 1, BY OMISSION ─────────────────────
 *
 * There is deliberately no hidden `page` input. Carrying the page across a channel change is
 * how you land on "page 7 of 2" — which `buildPaidPostsView` would clamp, so the reader would
 * silently get the LAST page of the new channel and no indication why. A filter change is a
 * new question; it starts at the newest post.
 */
export function ChannelFilter({
  options,
  current,
  query,
}: {
  options: { handle: string; name: string }[]
  /** The handle in force, already validated by the view model. Null = every channel. */
  current: string | null
  /** The search term in force, so the box keeps what was typed across a page turn. */
  query: string | null
}) {
  if (options.length === 0) return null

  return (
    <form method="get" action="/paid-posts" className="channel-filter">
      <label htmlFor="channel-pick" className="muted">
        Channel
      </label>{' '}
      <select
        id="channel-pick"
        name="channel"
        defaultValue={current ?? ''}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {/*
          An explicit "every channel" option rather than a blank: a select whose first row is
          empty reads as "nothing chosen yet" on a control that is always in one state or the
          other, and the empty VALUE is what clears the filter.
        */}
        <option value="">Every channel</option>
        {options.map((o) => (
          <option key={o.handle} value={o.handle}>
            {o.name} (@{o.handle})
          </option>
        ))}
      </select>{' '}
      {/*
        SEARCH LIVES IN THE SAME FORM AS THE FILTER, so the two compose instead of clobbering
        each other: submitting sends both `channel` and `q`, and a blank box clears the search
        rather than preserving a stale one. Still no hidden `page` — any change to what is
        being asked starts at the newest post.
      */}
      <label htmlFor="post-search" className="muted">
        Search
      </label>{' '}
      <input
        id="post-search"
        name="q"
        type="search"
        defaultValue={query ?? ''}
        placeholder="caption, brand or shortcode"
      />{' '}
      {/*
        The one control both paths need: it submits the typed search, and it is also what
        submits the channel when JavaScript has not loaded and the `onChange` above never ran.
      */}
      <button type="submit" className="muted">
        Show
      </button>
    </form>
  )
}
