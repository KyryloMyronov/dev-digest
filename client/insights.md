# client — insights

Append-only log of things that cost real time. Newest first. One entry per
gotcha; if it becomes a rule everyone must follow, promote it to `CLAUDE.md` and
leave the entry here as the explanation.

Format: `## YYYY-MM-DD — one-line title` then symptom → cause → fix.

Entries also carry `**Rubric:**` — one of: What Works · What Doesn't Work ·
Codebase Patterns · Tool & Library Notes · Recurring Errors & Fixes ·
Session Notes · Open Questions. Find one with
`grep -n '^\*\*Rubric:\*\* Open Questions' insights.md`. Written by the
`engineering-insights` skill; see `../.claude/skills/engineering-insights/`.

---

## 2026-08-03 — `pnpm build` while `pnpm dev` is running bricks the dev server

**Rubric:** What Doesn't Work
**Symptom:** after a routine `pnpm build` for verification, the app on :3000 goes
unstyled (serif text, blue links), sits on "Loading…" forever, and shows
"No repo selected". SSR still returns correct HTML and the API is healthy, so it
reads as a data/CSS bug in whatever you just changed. It isn't.
`curl localhost:3000/_next/static/chunks/main-app.js` → **404**.
**Cause:** both commands own `.next/`. `next build` overwrites it with
production output, while the running `next dev` keeps serving HTML that
references its own dev chunk names — which no longer exist on disk. It does not
recover: touching a file recompiles and still 404s, because the dev server's
manifests and the on-disk build have diverged.
**Fix:** don't run `pnpm build` against a live dev server. If you already have,
`rm -rf .next` and restart `next dev` — nothing less will do it. To verify a
change in a real browser without disturbing a dev stack, use the hermetic
runner (`./scripts/e2e.sh`, ports 3100/3101/5433), which builds and serves its
own isolated copy. Distinct from the "blank studio = dead API" entry below: here
`/health` is fine and the 404 is on a `_next/static` chunk.

## 2026-08-03 — a `Modal` opened from a clickable row must not be owned by the row

**Rubric:** What Doesn't Work
**Symptom:** the obvious placement — put the `useState` and the `<Modal>` inside
the row component that opens it — makes the modal flash and the app navigate to
the row's destination instead. Clicking the backdrop to close is the worst case:
it closes *and* navigates.
**Cause:** `vendor/ui/kit/Modal.tsx` is `position: fixed` with no portal, so it
is painted over the viewport but stays a **DOM child of wherever it mounts**.
React events follow the DOM tree, not the visual one, so every click inside the
modal — backdrop, close button, a link — bubbles into the ancestor row's
`onClick`, which on the PR list is `router.push(...)`. `stopPropagation` on the
counter that *opens* it does not help: that guards the open click only.
**Fix:** own the open state in the page, render the modal as a sibling of the
list, and pass the row a callback (`pulls/page.tsx` +
`_components/PRRow/PRRow.tsx` `onOpenFindings`). Applies to any row-level
overlay in the studio — rows in this table navigate on click, so the same trap
is waiting for the next drawer/popover. `PRRow.test.tsx` pins it: a counter
click must call the callback and leave `router.push` untouched, while a click
elsewhere in the row must still navigate.

## 2026-07-30 — `ERR_PNPM_IGNORED_BUILDS` on install (esbuild, sharp)

**Rubric:** Recurring Errors & Fixes
**Symptom:** `pnpm install` fails with
`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@…, sharp@…`.
**Cause:** pnpm 10+ won't run dependency build scripts unless each package is
explicitly approved. `client/pnpm-workspace.yaml` existed but held the
placeholder `set this to true or false`, which is not a boolean and therefore
counts as *unapproved*.
**Fix:** real booleans in `allowBuilds:` (both are required — esbuild's
postinstall places the platform binary Vite needs; sharp fetches its libvips
binding), or `pnpm approve-builds --all`. Commit the file: it's needed by CI and
every other machine.

## 2026-07-30 — body-less POST rejected by the API

**Rubric:** Recurring Errors & Fixes
**Symptom:** `Body cannot be empty when content-type is application/json` from
endpoints like refresh / reindex / generate.
**Cause:** sending a JSON content-type header with no body.
**Fix:** `apiFetch` only declares the header when a body exists
(`lib/api.ts:26`). Don't add `content-type` manually at a call site.

## 2026-07-30 — a blank studio is usually a dead API, not a UI bug

**Rubric:** Recurring Errors & Fixes
**Symptom:** empty lists, full-screen error, or endless loading with nothing in
the browser console.
**Cause:** `:3001` isn't running, so every request fails at the network layer.
**Fix:** `api.ts` reports this as `ApiError` with `status: 0` and code
`network_error` — check `curl localhost:3001/health` before debugging React.

## 2026-07-30 — `NEXT_PUBLIC_API_BASE` is build-time

**Rubric:** Tool & Library Notes
**Symptom:** the app still calls the old API host after changing `.env`.
**Cause:** `NEXT_PUBLIC_*` values are inlined at build time.
**Fix:** rebuild, don't just restart. In dev, restart `next dev`.