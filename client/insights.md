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

## 2026-08-03 — `pnpm build` while `dev.sh` is running guts the live dev server

**Rubric:** What Doesn't Work
**Symptom:** the studio suddenly renders completely unstyled and dead — no
theme, no layout, no interactivity — with the API healthy and the page still
returning 200. Reads exactly like a catastrophic CSS/component regression. It
is not: `/_next/static/css/app/layout.css` and `/_next/static/chunks/main-app.js`
both 404 while `/_next/static/chunks/webpack.js` still returns 200.
**Cause:** `next dev` and `next build` share one `.next/`. Running
`cd client && pnpm build` while `./scripts/dev.sh` holds :3000 makes the
production build delete the dev server's emitted chunks and replace them with
hashed production ones. The dev server keeps serving HTML that references the
dev filenames it believes it compiled, so every asset it points at is gone.
Nothing in the normal workflow warns you — `dev.sh` and `e2e.sh` both use
`next dev` (e2e on :3100) and never build, so the collision only appears when
you run the build by hand as a check.
**Fix:** don't build against a live dev server. `typecheck` + `pnpm test` cover
what a local `next build` would have told you. If you do need the build, stop
`dev.sh` first. Recovery is `rm -rf client/.next` and restart `./scripts/dev.sh`
— nothing less works, because the running server will not re-emit: touching a
source file, or even deleting `.next` underneath it, still leaves both paths
404ing. Postgres is unaffected (`dev.sh`'s cleanup only stops the API).

## 2026-08-03 — a wrong next-intl key renders the key and keeps the suite green

**Rubric:** Recurring Errors & Fixes
**Symptom:** a new PR-list cell rendered the literal string `list.findings.none`
instead of `—`, and every client test still passed — including one asserting
that the row shows `—`. The only trace was `IntlError: MISSING_MESSAGE` on
stderr, buried under the usual jsdom chart warnings.
**Cause:** two things compound. (1) next-intl resolves a missing key to the key
*path* and reports it through `onError`; nothing throws, so no assertion can
see it. (2) `messages/en/prReview.json` nests by SCREEN, not by feature: every
PR-list string lives under `list.` (`list.columns.*`, `list.findings.*`) while
the finding-card strings sit at the top level (`finding.accepted`,
`finding.suggestedFix`). A component doing `useTranslations("prReview")` +
`t("findings.none")` therefore asks for `prReview.findings.none`, which does
not exist — one namespace level short.
**Fix:** check the nesting before writing the call —
`node -e 'console.log(Object.keys(require("./messages/en/prReview.json").list))'`
— and after adding any `t()`, run `pnpm test` and grep the output for
`MISSING_MESSAGE`. That warning is the only signal you will get; a green suite
proves nothing about your keys.

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