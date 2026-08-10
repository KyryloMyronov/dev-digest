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

## 2026-08-08 — a row→DTO mapper needed by two modules belongs in `modules/_shared/`

**Rubric:** Codebase Patterns
**Symptom:** writing the skills module, the natural move is `toSkillDto` in
`modules/skills/helpers.ts` — every other module does exactly that. Then
`modules/agents/service.ts` needs it (to inline a skill into a link) and
`modules/reviews/run-executor.ts` needs it (to render a prompt block), and both
imports are `no-cross-module-internals` violations. `pnpm lint:arch` catches it,
but only after the code is written the wrong way round.
**Cause:** the rule's allow-list is exactly
`^src/modules/[^/]+/(constants|types)\.ts$` plus `^src/modules/_shared/`
(`.dependency-cruiser.cjs:116-133`), so `helpers.ts` is private no matter how
pure it is. Note the asymmetry that makes this easy to miss: shared **row types**
already have a home (`src/db/rows.ts`, which exists for precisely this reason and
says so), but shared **mappers over those rows** had none, so the pattern only
half-existed.
**Fix:** when a second module needs to read another module's table, put the pure
mapper in `src/modules/_shared/<area>.ts` and have the owning module re-export it
from its `helpers.ts` so its own call sites are unchanged —
`modules/_shared/skills.ts` (`toSkillDto`, `skillPromptBlock`) is the worked
example, re-exported by `modules/skills/helpers.ts`. Do **not** reach for
`container.<x>Repo` for this: that seam is for shared *queries*
(`agentsRepo`, `pullsRepo`, `reviewRepo`), and a mapper needs no `db`. The signal
to watch for while designing: if the data is read by two modules, the mapper is
shared infrastructure from the start, not something to relocate after lint fails.

## 2026-08-08 — "every domain table carries `workspace_id`" has child-table exceptions

**Rubric:** Codebase Patterns
**Symptom:** a static check written straight from the root `AGENTS.md` rule
("Every domain table carries `workspace_id`; all queries scope by it") flags
`pr_files` in `db/schema/pulls.ts` as an unscoped table. The table is fine.
**Cause:** the rule describes tenant *reachability*, not a literal column on
every table. `pr_files` scopes through its parent —
`pr_id → pull_requests.workspace_id`, with `onDelete: 'cascade'` — so adding a
`workspace_id` column would duplicate a fact the FK already guarantees, and
create a way for the two to disagree. `pull_requests` itself carries the
column plus an index (`pr_ws_idx`), which is what makes the parent hop cheap.
**Fix:** when adding a table, the question is not "does it have
`workspace_id`" but "can a row reach exactly one workspace". Carry the column
when the table is a tenant root or is queried directly by workspace; scope
through a `.references(...)` FK when it is a child of something that already
does — and then make sure the query actually joins through that parent, since
nothing enforces it. For automated checks, grade `workspace_id` missing **and**
no FK as an error, and `workspace_id` missing **with** an FK as "verify the
parent", not as a violation.

## 2026-08-07 — `no-circular` flags the DI seam unless you use `viaOnly`

**Rubric:** Tool & Library Notes
**Symptom:** the new `pnpm lint:arch` (`server/.dependency-cruiser.cjs`) reported
five `no-circular` errors that are not cycles at runtime, e.g.
`platform/container.ts → modules/repo-intel/service.ts → platform/container.ts`
and `modules/agents/repository.ts → helpers.ts → repository.ts`.
**Cause:** this is our DI shape, not a defect — the container constructs the
service (a value import) and the service imports `type { Container }` back (a
type-only import that erases at compile time). With
`tsPreCompilationDeps: true`, dependency-cruiser counts the type edge. Putting
`dependencyTypesNot: ['type-only']` on the rule's `to` does **not** help: that
filters only the final hop, while the cycle mixes one value edge and one type
edge.
**Fix:** filter the edges the cycle may pass *through*, not the last one —
`to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } }`. Real
value-import cycles still fail. Two related rule-shape traps in the same config:
`reviewer-core/**` importing `src/vendor/shared/**` is the correct inward
direction and must be excluded from `no-core-imports-from-server`, and the
"SDKs behind adapters" rule must list only I/O libraries — adding `graphology`
or `postgres` to it flags `repo-intel/pipeline/rank.ts` and `db/client.ts`,
which are not adapter violations.

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