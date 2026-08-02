# server — insights

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

## 2026-08-02 — run cost is persisted but the write path has no test

**Rubric:** Open Questions
**Symptom:** none yet — latent. `agent_runs.cost_usd` fills in correctly today.
**Cause:** `test/pulls-cost.it.test.ts` covers only the READ side — it inserts
`agent_runs` rows by hand and asserts what `GET /repos/:id/pulls` picks. Nothing
exercises `run-executor.ts` actually threading `outcome.costUsd` into
`completeAgentRun`. That link is held up by the typechecker alone: swap the
argument for `null` and the whole suite still passes. Two acceptance criteria in
`specs/run-cost.md` ("a completed run stores non-null cost when the model is
priced" / "stores null when it isn't") are therefore unmet.
**Fix:** drive `ReviewRunExecutor` with a stubbed engine returning a known
`costUsd` (container overrides already support this — see how
`reviews.it.test.ts` injects), run it against a seeded PR, and assert the
`agent_runs` row. Do the same with `costUsd: null` for the unpriced-model case.
Until that exists, treat any refactor of the executor's completion block as
unguarded on this field.

## 2026-08-02 — `*.it.test.ts` can't find Docker under Colima

**Rubric:** Recurring Errors & Fixes
**Symptom:** every integration test fails at `startPg()` with
`Error: Could not find a working container runtime strategy`, while `docker ps`
works fine in the same shell. Reads as a broken test — it is not. The suite is
gated on `dockerAvailable()`, which passes, so the tests are *collected* and
then the container start blows up.
**Cause:** testcontainers looks for `/var/run/docker.sock`. Colima doesn't
create it — its socket is at `~/.colima/default/docker.sock`, reachable only
through the `colima` docker context, which testcontainers does not read.
**Fix:** point both variables at it (the second one is what the Ryuk reaper
mounts *inside* the container, so it must stay the conventional path):

```sh
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
pnpm exec vitest run .it.test
```

Before assuming a new integration test is at fault, run an existing one
(`pnpm exec vitest run pulls-comments`) — if it fails identically, it's this.

## 2026-07-30 — `reviewer-core` deps missing breaks *server* boot

**Rubric:** Recurring Errors & Fixes
**Symptom:** API exits at startup with `ERR_MODULE_NOT_FOUND` naming a path
under `reviewer-core/`, after a fresh clone or a `node_modules` wipe.
**Cause:** the server imports reviewer-core's raw TypeScript through a tsconfig
alias, so its dependencies are the server's runtime dependencies — but it's a
separate package with its own (npm) lockfile, and `pnpm install` in `server/`
does not touch it.
**Fix:** `cd reviewer-core && npm ci`. `scripts/dev.sh` does this automatically;
manual setups must not skip it.

## 2026-07-30 — `instanceof z.ZodError` is unreliable across package boundaries

**Rubric:** Codebase Patterns
**Symptom:** a validation error from a service-level `.parse()` returned 500
instead of 422.
**Cause:** `server` and `reviewer-core` can resolve different zod instances, so
the prototype chain doesn't match and `instanceof` returns false.
**Fix:** the error handler also matches by shape (`name === 'ZodError'` plus an
`issues`/`errors` array) — `app.ts:138`. Don't "simplify" that check. The
structural cause is contained by reviewer-core's `"zod": ["./node_modules/zod"]`
tsconfig path; keep it.

## 2026-07-30 — migrations are not applied on boot, by design

**Rubric:** Recurring Errors & Fixes
**Symptom:** `relation "..." does not exist` on every endpoint after a fresh
clone or `docker compose down -v`.
**Cause:** the server deliberately does not migrate at startup.
**Fix:** `pnpm db:migrate`. If it still fails, the migrations ran against a
*different* Postgres — the container name is fixed (`devdigest-postgres`) and
`dev.sh` reuses an existing one even from another compose project.

## 2026-07-30 — stale-run reaping is single-instance only

**Rubric:** Open Questions
**Symptom:** none yet — latent.
**Cause:** `app.ts:81` reaps every `agent_runs` row still marked `running` at
boot, on the assumption that a fresh process owns no in-flight runs. Correct for
one API instance per DB; with replicas it would kill live runs on a peer.
**Fix:** if this ever runs replicated, add per-instance scoping or heartbeats
first. The reap is awaited before listening on purpose — don't make it async.