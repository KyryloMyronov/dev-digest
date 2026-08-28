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

## 2026-08-28 — `aria-label` beats `title`, so an RTL test asserting `toHaveAttribute("title", …)` cannot fail on a broken accessible name

**Rubric:** What Doesn't Work
**Symptom:** `BriefCard`'s location control shipped with the raw `file:line` in
`title` and a fixed instruction string in `aria-label`, so its accessible name
was "Open this location in the Files changed tab" — the untruncated path never
reached it. SPEC-02's AC-45 requires the opposite. The comment directly above the
code asserted it was correct. **The test passed**, and was named
`"…keeps the full value as the accessible name"`.
**Cause:** two compounding mistakes. (1) In the accessible-name computation
`aria-labelledby` > `aria-label` > native label > `title`, so setting both means
`title` is *dead* for naming — it survives only as a mouse-hover tooltip.
(2) The test asserted `expect(control).toHaveAttribute("title", full)` and
located the element with `getByRole("button", { name: /Open this location/ })` —
querying **by** the generic name it should have been rejecting. It therefore
could not fail on this defect in any code state.
**Fix:** put the value in `aria-label`; assert through the accessibility tree,
never through `title`. Two adjacent sites in the same file were already right
(`BriefCard.tsx` risk title and focus reason both use
`aria-label={<raw value>}`), which is exactly why the odd one out survived review.

```tsx
aria-label={jumpLabel(location)}   // "<path>:<line> — Open this location…"
title={location}                   // hover only; NOT the accessible name
```

```ts
// asserts the real thing, and provably fails against the broken version
screen.getByRole("button", { name: new RegExp(escapeRegex(`${LONG_PATH}:12`)) });
expect(control).toHaveAccessibleName(`${LONG_PATH}:12 — Open this location…`);
```

**Generalise this.** Before trusting any test named for an accessibility
criterion, ask what it would take for it to fail. If it queries by the same
attribute it asserts, or asserts a DOM attribute where the criterion says
"accessible name", it is decorative. A name may carry the value **plus** an
action — that still satisfies "expose the untruncated value" and reads better to
a screen-reader user than a bare path.

## 2026-08-27 — a shared component that resolves its own i18n namespace crashes a screen whose catalogue lacks it; and `?? []` cannot defend a list

**Rubric:** What Doesn't Work
**Symptom:** adding a context-attachment field to `SkillEditorModal` broke a
**pre-existing** test, `SkillsListView.test.tsx > edits an existing skill`, with
`Unable to find role="dialog"` — an assertion about nothing the change touched.
Two errors preceded it in stderr:

```
IntlError: MISSING_MESSAGE: Could not resolve `context` in messages for locale `en`.
TypeError: attached.map is not a function
```

**Cause:** two independent mistakes in one component.
(1) It called `useTranslations("context")`, but its strings belong to the owning
screen's catalogue (`skills.json`), and this repo's tests mount
`NextIntlClientProvider` with only the namespaces that screen needs
(`messages={{ skills, shell }}`). A namespace the screen does not carry throws.
(2) It did `attachments.data ?? []` and then `.map()`. The test's `fetch` mock did
not serve the new endpoint, so `data` was a **truthy non-array** — and `??` only
catches nullish, never a wrong *shape*. The throw unmounted the whole modal,
which is why the failure surfaced as a missing dialog rather than anything about
context.
**Fix:** keep attach vocabulary in the **owning screen's** catalogue
(`agents.json` → `agents.context.*`, `skills.json` → `skills.context.*`, read as
`useTranslations("skills")` + `t("context.…")`), and give a genuinely shared
component **label props** instead of a `useTranslations` call of its own —
otherwise promoting a component drags one screen's catalogue into another. Guard
list shape with `Array.isArray(value) ? value : []`, not `??`. And when new
production code adds queries to an existing screen, that screen's **pre-existing
test fixture is yours to update** — the crash lands in a test that looks
unrelated. A sibling trap: `AgentEditor.test.tsx` passed only because it renders
`tab="config"`, so the new tab never mounted; it needed a test that mounts it.

## 2026-08-27 — with `css: false`, bind a computed-contrast test to the implementation by reading the inline `style.color`

**Rubric:** What Works
**Symptom:** WCAG contrast is a real requirement here (NFR-9 in SPEC-01 asks for
a computed ratio ≥ 4.5:1 in both themes), but `getComputedStyle(el).outline` and
every CSS-variable lookup come back empty in this suite, so a test that asks the
DOM for a resolved colour proves nothing regardless of correctness.
**Cause:** `client/vitest.config.ts` sets `css: false`, so no stylesheet loads
and no `var(--x)` ever resolves. jsdom has no CSS engine and no `:focus-visible`.
**Fix:** compute the ratio from the token table in the test (copy the hex values
from `src/vendor/ui/styles.css`, real relative-luminance maths) **and** bind it to
the component by asserting the token it actually paints — `expect(el.style.color)
.toBe("var(--crit)")`, read off the rendered inline style, which jsdom does
preserve verbatim. Without that bridge the arithmetic drifts from the component
silently. `DocRow.test.tsx:42-129` and `context-tokens/TokenTotal.test.tsx` are
the two worked examples; the helpers are byte-identical between them on purpose.
Two costs to accept and state: the token table is a **copy**, so changing
`styles.css` leaves the test measuring the old value, and the *surfaces* a
component renders against are a static read of its call sites, asserted nowhere.
Also worth pinning the tightest pair with an upper bound — `--crit` on
`--bg-elevated` (dark) measures **4.5287:1**, so one step of drift breaks it, and
a bare `toBeGreaterThanOrEqual(4.5)` would not say so.

## 2026-08-18 — vitest's jsdom has NO `window.localStorage`; code guarded by try/catch silently no-ops in tests

**Rubric:** Tool & Library Notes
**Symptom:** a per-PR persistence helper (`DiffTab/viewMode.ts`) worked in the
browser but its test failed with `Cannot read properties of undefined (reading
'clear')` on `window.localStorage.clear()` — and the write helper itself threw
nothing, because its defensive try/catch swallowed the TypeError, so the
round-trip just returned `null` as if nothing had been stored.
**Cause:** the jsdom version in this repo (25.x) under vitest exposes no
`localStorage` at all — `typeof window.localStorage === "undefined"` even
though `window.location.href` is a proper `http://localhost:3000/`. It is not
an origin problem; the API is simply absent in this environment.
**Fix:** `src/test/setup.ts` now installs a minimal in-memory `Storage` stub
(guarded, same pattern as the `ResizeObserver` stub above it) — state lives per
test file, tests `window.localStorage.clear()` in `afterEach`. Two lessons:
(1) don't debug localStorage tests as key-mismatch bugs, check
`typeof window.localStorage` first; (2) a try/catch around storage access hides
this completely — the code "passes" while persisting nothing.

## 2026-08-18 — `SeverityBadge compact` renders colour and an icon with NO label, and the label it does render is mixed case

**Rubric:** Tool & Library Notes
**Symptom:** two failures in a row from one badge. First,
`screen.getByText("CRITICAL")` found nothing after adding
`<SeverityBadge severity={severity} count={n} compact />` to the diff's file
header — the badge was on screen and visibly red. Removing `compact` still
failed, on the same assertion. The component renders; the text does not exist.
**Cause:** two separate facts about `src/vendor/ui/primitives/Badge.tsx`.
`compact` maps to `{compact ? null : s.label}` (`Badge.tsx:80`), so the compact
variant drops the label entirely and leaves colour + icon carrying the whole
meaning — which the file's own comment ("always icon + label (WCAG AA: never
color alone)", `:51`) says not to do. And the label itself is
`SEV[severity].label` = **`"Critical"` / `"Warning"` / `"Suggestion"`**
(`primitives/tokens.ts:10-13`); the all-caps look is `textTransform: uppercase`,
a CSS effect that never reaches the DOM. Same trap in `CAT` (lowercase labels).
**Fix:** don't pass `compact` when the badge is the only thing naming the
severity — it is for a dense row where a neighbouring element already says it.
In RTL, assert on the mixed-case label (`getByText("Critical")`), and read
`tokens.ts` rather than the rendered screenshot for any kit label. The general
rule: a `textTransform`/`letterSpacing` style means the visible string and the
DOM string differ, so every kit component styled that way needs its label
checked at the source before it goes into an assertion.

## 2026-08-17 — the `keys.ts` header comment teaches a `reviewKeys.all` that does not exist

**Rubric:** What Doesn't Work
**Symptom:** the doc comment at `client/src/lib/hooks/keys.ts:9-12` explains the
cache-key convention with a worked example —
`invalidateQueries({ queryKey: reviewKeys.all })` "still matches every per-PR
entry by prefix". Following it, you would expect one invalidation per domain to be
enough, and write a mutation that refreshes nothing.
**Cause:** `reviewKeys` exposes only `byPr` (`keys.ts:92-94`) — there is no `all`
field on it at all. Prefix nesting genuinely holds for exactly two groups,
`conventionKeys` (`:83-85`) and `providerModelKeys` (`:38-39`). Everywhere else the
broad and specific keys deliberately do **not** share a prefix: `agentKeys.all` is
`["agents"]` while `agentKeys.detail` is `["agent", id]` (`:64-65`) — plural
against singular. `skillKeys` (`:72-74`) and `pullKeys` (`:48-51`) have the same
shape. The comment describes an intended convention; the tuples are the contract.
**Fix:** read the tuples, never the header. Because the prefixes do not nest, a
mutation has to touch both keys explicitly — which is exactly why `useUpdateAgent`
invalidates the list **and** seeds the detail
(`client/src/lib/hooks/agents.ts:66-69`) and `useDeleteAgent` invalidates the list
**and** removes the detail (`:77-79`). Copy those, not the comment. Note the
failure mode is the silent one already described in `client/AGENTS.md` for inline
literals: no type error, no runtime error, a mutation that looks successful while
`staleTime: 30_000` and `refetchOnWindowFocus: false`
(`client/src/lib/providers.tsx:28-29`) keep the stale render on screen. The
comment itself still needs correcting — it is production code, so it did not get
fixed here.

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