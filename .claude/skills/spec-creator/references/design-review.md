# Reviewing a design before it becomes a spec

Input: screenshots, mockups, or a described screen. Output: rows in the spec's
*Design review* table, plus criteria, open questions and UX proposals.

A mockup shows one state of one screen with plausible data. Almost everything
that goes wrong in the built product lives in what it does not show. Your job is
to find those, name them, and turn each into something decidable.

Read every image with `Read` before reasoning about it. Describe what is actually
drawn — resist filling gaps from what you assume the feature does.

## Pass 1 — states the mockup does not draw

For every region that displays data or accepts input:

- **Empty** — no rows yet, never had any. What is drawn, and what is the next
  action? "Nothing yet" and "you have completed everything" are different empties.
- **Loading** — first load, and refresh-while-showing-old-data. Skeleton, spinner,
  or nothing? Is the previous content still visible and still clickable?
- **Partial** — half the sources answered. Is a half-filled screen shown, or held?
- **Error** — per region and whole page. Inline, toast, or full-screen? Is there a
  retry, and does retry re-run everything or just the failed part?
- **Permission denied / not found** — a resource the viewer may not see.
- **Stale** — cached or last-indexed data. Is its age visible?
- **Success / after-action** — what changes on screen after the action, and does
  anything undo it?
- **Disabled and in-flight** — a button during its own request; double submission.

## Pass 2 — the content the mockup flatters

Designs carry ideal data. Real data is worse.

- Longest realistic string in every label, chip, title, path and name — where does
  it truncate, and is the full value still reachable?
- Zero, one, and 10 000 rows. Pagination, virtualisation, or a hard cap? What is
  drawn at the cap?
- Numbers at their extremes: 0, negative, very large, and their formatting.
- Dates: relative or absolute, whose timezone, and "just now" versus two years ago.
- Unicode, emoji, RTL text, and text that is code.
- Untrusted text rendered as markup — see *Untrusted inputs*.
- Images and avatars that fail to load.
- Nested or recursive data deeper than the mockup shows.

## Pass 3 — flow and cross-screen behaviour

- What is the entry point? Where does the user come from, and where do they land
  when done?
- Is the state URL-addressable? Does back, refresh, and a shared link work?
- Is there unsaved work, and what happens on navigate-away?
- Is any action destructive, and is it confirmed or undoable?
- Which parts survive a reload — filters, sort, tab, scroll position?
- Keyboard: tab order, focus after a modal closes, Escape, Enter to submit.
- Screen-reader: is a state change announced, or does it happen silently?
- Small viewport: what wraps, what scrolls, what disappears.

## Pass 4 — module interactions behind the pixels

Every region on screen is fed by something. For each:

- Which module or endpoint supplies it? Does it exist today (`path:line`) or is it
  **NEW**? If answering that means reading a subsystem too large for this pass,
  write it up as an `R-n` commission — you hold no `Agent` tool, so the main
  session runs the `researcher` for you (§4.1 of the agent file). Never guess it,
  and when the report comes back, open its citations yourself before they enter
  the spec.
- One request or several? Sequential or parallel, and does one block another?
- What does the region do when its source is slow, unavailable, or returns
  something that fails schema validation? **Each answer is an `IF … THEN` AC.**
- Is anything written back? When — on change, on blur, on explicit save?
- Does an action here invalidate data another screen is showing?
- Does anything need to be polled, streamed, or refreshed to stay true?

In this repo specifically: does the payload the screen needs already exist in
`@devdigest/shared`? A response the studio wants but the server does not send is
a contract change in **two** files — canonical
`server/src/vendor/shared/`, mirror `client/src/vendor/shared/`.

## Pass 5 — UX improvements

Only propose what is cheap and concrete. For each: the friction removed, and the
cost in one clause. Tag every one `proposed`; the user promotes it.

Look for:

- a step that could be removed, defaulted, or remembered between visits;
- information the user needs at the moment of deciding but which sits one click
  away;
- a wait that could be optimistic, streamed, or backgrounded;
- an error that could have been prevented instead of reported;
- a destructive action without an undo, or a confirm dialog that could be one;
- two screens that do the same job with different words or different layouts;
- a number shown without the comparison that makes it mean something.

Do **not** propose a redesign, a new design system, or a feature the user did not
ask for. This section is for changes measured in hours.

## Writing the findings

Each finding becomes one row:

```markdown
| # | Screen / image | Gap | Proposed resolution | Becomes |
|---|---|---|---|---|
| D-1 | `img_2.png` findings list | No empty state drawn | Illustration + "Run a review" CTA | AC-12 |
```

Then close every row: an **AC**, an **OQ**, or a **Non-goal**. A finding that
resolves into none of the three has not been reviewed, only noticed.

Ambiguity that changes the build — two readings of the same pixels, both
plausible — is a question for the user, not a decision for you.
