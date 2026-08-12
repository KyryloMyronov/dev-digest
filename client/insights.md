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

## 2026-08-11 — two shipped hooks call endpoints the API has never served

**Rubric:** Open Questions
**Symptom:** none yet — latent. `useContextFiles` and `useReindexContext`
(`src/lib/hooks/core.ts:123-138`) call `GET /repos/:id/context` and
`POST /repos/:id/context/reindex`. No route serves either, on this branch or on
`main` — `repo-intel` registers only `/repos/:id/index-state` and
`/repos/:id/resync`. The comment above them says so ("safe to call once API
exposes it"), which is easy to miss when copying the neighbouring hook.
**Cause:** `api.get<T>(path)` takes a **plain string**, so nothing type-checks a
path against the routes that exist. A hook aimed at a nonexistent endpoint
compiles, passes `pnpm typecheck`, passes its own test against a mocked fetch,
renders, and only fails as a 404 `ApiError` toast in front of a user. This is
the same shape as the starter's deliberate schema-ahead-of-features policy
(root `CLAUDE.md`), just on the client side.
**Fix:** before wiring a hook into a screen, confirm a route actually serves it —
`node .claude/skills/api-breaking-changes/check.mjs` lists every studio call
site with nothing behind it under `consumer-without-endpoint` (pre-existing ones
as `info`, ones your change orphaned as `critical`). Leave the "safe to call
once…" comment on any hook written ahead of its endpoint; it is the only marker
that distinguishes intent from a typo in the path.

## 2026-08-11 — importing a VALUE from `@devdigest/shared` breaks the browser only; `typecheck` and `vitest` both pass

**Rubric:** What Doesn't Work
**Symptom:** a new route died in the dev server with
`Module not found: Can't resolve './contracts/findings.js'`, while
`pnpm typecheck` was clean and all 129 tests passed. The named file exists, in
both `vendor/shared` trees — so the first instinct (that
`check-contracts.sh --fix`'s `rsync --delete` had removed it) was wrong and cost
the time.
**Cause:** the offending line was `import { SkillType } from "@devdigest/shared"`
— `SkillType` is a Zod schema, so this is a **runtime** import. Every other
import from that package in the whole client is `import type`, which `tsc`
erases, so the bundler had never once been asked to resolve the contract barrel.
When it finally was, `vendor/shared/index.ts` re-exports with ESM specifiers
(`export * from './contracts/findings.js'`); `tsc` maps `.js` → `.ts` under its
moduleResolution and webpack does not. Vitest passes too — it resolves through
the same alias config as `tsc`. So both gates are structurally blind to this.
**Fix:** in `client/`, treat `@devdigest/shared` as **types only**. Need an
enum's members at runtime? Declare a local literal array annotated with the
contract type (`export const SKILL_TYPE_OPTIONS: SkillType[] = [...]`) — the
pattern `app/skills/.../SkillsListView/constants.ts#TYPE_OPTIONS` already uses.
Audit with
`grep -rn 'from "@devdigest/shared"' src | grep -v 'import type'` — it should
return only the closing braces of multiline `import type {` blocks. And note the
process lesson: for a *new route*, a green typecheck and a green suite do not
mean it loads. Fetch it once (`curl -s -o /dev/null -w '%{http_code}'
localhost:3000/<route>` and grep the body for `Can't resolve`) before calling it
done.

## 2026-08-11 — wrapping a test in `RepoProvider` makes the shell fetch more, and one non-array stub blanks the whole render

**Rubric:** Recurring Errors & Fixes
**Symptom:** a component test that passed against 13 assertions started failing
*every* assertion after `RepoProvider` was added to its render wrapper. The DOM
printed by Testing Library was `<body><div /></body>` — nothing rendered at all —
and the real cause was buried far below the diff as
`Unhandled Errors › TypeError: pulls?.filter is not a function`.
**Cause:** with no `RepoProvider`, `useActiveRepo()` returns the context default
(`activeRepo: null`), so the shell fetches nothing extra. Once the provider
resolves a repo from the path, `useShellContext` fetches that repo's PRs for the
sidebar badge and calls `pulls?.filter(...)` (`useShellContext.ts:75`). A `fetch`
stub whose catch-all returns an object (`{ ok: true }`) satisfies `?.` and then
throws on `.filter` — inside a `useMemo` during render, which unmounts the tree.
**Fix:** any stub that a shell hook will read must return the right *shape*, not
just a 200. Route `/pulls` (and `/repos`) explicitly to `[]`/`[REPO]` **before**
the catch-all. More generally: when a whole suite goes red with an empty `<body>`,
scroll past the assertion diff to the `Unhandled Errors` section — the render
threw, and the failing assertion is a symptom, not the bug.

## 2026-08-11 — a component that calls a missing message key fails its own test

**Rubric:** Codebase Patterns
**Symptom:** installing `@testing-library/user-event` (to fix a typecheck error)
made `SkillsListView.test.tsx` and `SkillsTab.test.tsx` run for the first time —
and 9 of their tests failed with `Unable to find an element with the text:
Create from scratch` / `Move corner-cases up`. The components were correct; the
DOM contained raw key names like `aria-label="agents.skills.detach"`.
**Cause:** the RTL suites here import the **real** catalogues from disk
(`import skillMessages from "../../../messages/en/skills.json"`) and assert on
rendered English, so catalogue completeness is load-bearing test data, not
cosmetics. `messages/en/skills.json` and the `skills.*` block of `agents.json`
were prototype-era — they carried `drawer.*`/`community.*`/`url.*` keys for a UI
that no longer exists and were missing ~60 keys the shipped components call
(`editor.*`, `import.*`, `card.*`, `delete.*`, `preview.panelLabel`, …). next-intl
renders the key itself rather than throwing, so nothing failed until a test looked.
**Fix:** after adding a component, diff the keys it calls against the catalogue —
`grep -rhoE 't\("([a-zA-Z0-9_.]+)"' <dir>` plus a pass for template literals
(`t(\`listItem.type.${x}\`)`), then compare against the flattened JSON. Do not
assume a catalogue that exists is a catalogue that matches; several under
`messages/en/` describe screens from the original snapshot, not today's code.

## 2026-08-11 — the icon registry exposes `Pencil` only as `Edit`

**Rubric:** Tool & Library Notes
**Symptom:** `icon="Pencil"` fails typecheck with
`Type '"Pencil"' is not assignable to type '"GitPullRequest" | … | 63 more …'`,
even though `grep Pencil src/vendor/ui/icons.tsx` finds it twice.
**Cause:** `IconName` is `keyof typeof Icon`, and the registry deliberately
re-keys that import — `Edit: Pencil` (`icons.tsx:147`, commented "prototype used
'Edit'"). So the lucide export is imported under one name and published under
another; the grep hit is the import, not the key.
**Fix:** resolve icon names against the `Icon` object's **keys**, not the import
list: `grep -n "^export const Icon" -A 80 src/vendor/ui/icons.tsx`. Use `"Edit"`
for a pencil. `Eye` is a real key, so `icon={editing ? "Eye" : "Edit"}` is the
working preview/edit toggle pair.

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