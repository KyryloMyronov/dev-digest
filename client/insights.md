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