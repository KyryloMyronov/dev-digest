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

## 2026-08-29 — a stub that ignores the parameter it is handed makes that parameter's value unfalsifiable, and `toBe(THE_CONSTANT)` hides it

**Rubric:** What Doesn't Work
**Symptom:** `BRIEF_MAX_OUTPUT_TOKENS = 2_000` shipped through a full
`plan-verifier` pass — 521 server tests, four clean typechecks, `lint:arch`
clean, two `architecture-reviewer` passes at 0 blocking — and was wrong by 3×.
The largest answer SPEC-02's schema and clamps permit measures **~7_750
tokens**, so the cap could not hold a full-size answer from any model. Every
live derivation came back truncated; the studio showed a dead button.

**Cause:** two independent blind spots that only bite together.
1. `StubLlm.completeStructured` (`test/brief-pipeline.test.ts`) recorded the
   request and returned its fixture **without reading `req.maxTokens`**. A real
   provider stops generating at the cap and hands back a truncated body. So no
   test in the repo could go red for a cap that was too small — the failure mode
   did not exist in the test world.
2. The one assertion that touched the number was
   `expect(llm.calls[0]!.maxTokens).toBe(2_000)` — a literal restating the
   constant. It proves the value is passed, never that it suffices. A test whose
   expected value is copied from the implementation cannot fail for the reason
   you care about.

Underneath both: the 2_000 was derived **backwards from a cost target** (SPEC-02
NFR-4 — "a 2 000-token cap on output at $8.00/1M = $0.016"), and then "measured"
by `estimateCost` over the stub's own declared token counts. A cost ceiling is
not a correctness bound, and nobody ever measured how long an answer is.

**Fix:** When a stub stands in for something that ENFORCES a limit, make the
stub enforce it — `StubLlm` now truncates and throws when the serialised fixture
exceeds `req.maxTokens`, with an explicit `ignoresMaxTokens` opt-out for AC-16,
whose clamp exists precisely for a provider that overruns. Then assert the
budget against a **generated worst case**, not a literal: `output token budget >
BRIEF_MAX_OUTPUT_TOKENS can hold the largest answer the schema and clamps
permit` builds the maximal answer from `MAX_BRIEF_RISKS` / `MAX_*_CHARS` and
counts it with the real `TiktokenTokenizer`. Verify a new guard by reverting the
constant to the broken value and watching it go red — this one reports `expected
7753 to be less than or equal to 2000`. General rule: if a constant's value can
change without any test changing colour, the constant is untested no matter how
many tests name it.

## 2026-08-29 — a REASONING model spends `max_tokens` on reasoning before emitting JSON, so a tight cap fails structured output with EMPTY content

**Rubric:** Tool & Library Notes
**Symptom:** `Derive brief` in the studio did nothing at all. `POST /pulls/:id/brief`
returned `202`, the `brief.derive` job finished `status='done'`, and `pr_brief`
stayed empty. Direct pipeline run:
`Brief derivation unavailable (llm_failed): OpenRouter structured output failed
schema validation for PrRiskBrief`. Replaying the pipeline's exact call shape
4× against `deepseek/deepseek-v4-flash` gave `finish_reason=length` and
`completion_tokens=2000` (exactly the cap) every time — 3 of 4 with **`content`
of length 0** while still billing 2000 tokens, 1 truncated mid-JSON.

**Cause:** `BRIEF_MAX_OUTPUT_TOKENS = 2_000`. Reasoning tokens are drawn from
the same `max_tokens` budget as the answer, so a reasoning model can exhaust the
cap before writing a single character of JSON. `deepseek/deepseek-v4-flash`
lists `reasoning`, `reasoning_effort` and `include_reasoning` in its OpenRouter
`supported_parameters` — it is one. `BRIEF_LLM_MAX_RETRIES = 0` (AC-14, one
billed call) then means there is no repair attempt, so it is `llm_failed` on
every derivation. The same prompt needs only ~1_700 tokens of actual answer,
which is why raising the cap to `8_000` fixes it outright rather than merely
making it likelier to fit.

Two things made this look like a client bug for a long time: a failed derivation
deliberately writes NO row (AC-11) and the job handler deliberately swallows the
error (AC-10), so nothing server-side records the failure; and `BriefCard`'s only
feedback is a `role="status"` region in an **`sr-only`** div, so the studio shows
a 90 s spinner and then silently reverts to its empty state.

**Fix:** Before picking a model for any structured-output feature, check
`reasoning` / `reasoning_effort` in its OpenRouter `supported_parameters`
(`curl -H "Authorization: Bearer $OPENROUTER_API_KEY"
https://openrouter.ai/api/v1/models`). If present, size `max_tokens` at roughly
4–5× the answer you expect, never at the answer's own size. Diagnose this class
of failure by `finish_reason` and `completion_tokens`, not by the schema error —
`finish_reason='length'` with `completion_tokens` equal to the cap is the tell,
and empty `content` alongside a non-zero token bill means reasoning ate all of
it. Note this is the mirror image of the root `insights.md` 2026-08-22 entry
(omitting `max_tokens` 402s a low-credit account): both directions are traps, so
set it explicitly AND size it for reasoning.

## 2026-08-29 — a declared Zod `body:` schema REJECTS a body-less POST; the sibling `.nullable()` response lesson does not transfer

**Rubric:** Recurring Errors & Fixes
**Symptom:** `POST /pulls/:id/file-summaries` with an optional body, declared as
`schema: { body: FileSummaryDeriveInput }` where both fields are `.optional()`.
A request with **no body and no content-type** returns 422:

```
{"error":{"code":"validation_error","message":"Request validation failed",
 "details":[{"keyword":"invalid_type", … "message":"Expected object, received null"}]}}
```

Five tests went red from this one cause, and the expensive one was **not** the
obvious one: the rate-limit test sent eleven body-less POSTs, so all eleven died
at validation and never reached `@fastify/rate-limit`. That criterion would have
shipped **unproven rather than failing** — green in a suite that never exercised
the limiter.
**Cause:** Fastify sets `req.body = null` for a POST with no body, and a bare
`z.object` rejects `null`. The error message states the mechanism exactly.
**Fix:** `body: MySchema.nullish()`. It accepts the body-less POST *and* keeps
rejecting a malformed one — measured on all three options:

| declaration | no body | `{}` | `{path: 42}` |
|---|---|---|---|
| `MySchema` | **422** | 202 | 422 |
| `MySchema.nullish()` | **202** | 202 | **422** |
| no `body:` + hand-parse | 202 | 202 | *silently ignored* |

The handler's `req.body ?? {}` then copes with `null` unchanged. Prefer this over
the hand-parse idiom `modules/brief/routes.ts` uses, which accepts a malformed
body silently (that route still does — an unfixed follow-up, not a pattern to
copy).

**Read this together with the 2026-08-28 `.nullable()` entry below, because the
pair is the lesson.** A declared Zod schema is safe on a **response** (`null`
serialises fine) and unsafe on an **optional request body** (`null` fails
validation). Written down, the two questions look identical; they resolve in
opposite directions. Settle a body-less POST with a real `app.inject()` **before**
building anything on the route.

## 2026-08-29 — a multi-row `onConflictDoUpdate` must set from `excluded.*`; spreading the JS row writes ONE row's values over every conflicting row

**Rubric:** What Doesn't Work
**Symptom:** none observed — caught in review before it shipped. The trap is that
it cannot be caught by a single-row test, and every existing example in this repo
is single-row.
**Cause:** the shipped idiom for a one-row upsert is
`set: { ...row, createdAt: sql\`now()\` }` (`modules/brief/repository.ts:87-90`).
That is correct *only* because `pr_brief` has exactly one row per PR. `set:`
values are evaluated **once for the whole statement**, so applying the same
spread to a multi-row insert writes the *last* JS row's `summary`, `tokens_in`
and `cost_usd` onto **every** conflicting row — silent cross-contamination, no
error, and a single-row fixture passes.
**Fix:** in a multi-row upsert, set each column from the row Postgres is actually
inserting:

```ts
.onConflictDoUpdate({
  target: [t.prFileSummaries.prId, t.prFileSummaries.path, t.prFileSummaries.headSha],
  set: {
    summary:  sql`excluded.summary`,
    tokensIn: sql`excluded.tokens_in`,
    costUsd:  sql`excluded.cost_usd`,
    createdAt: sql`now()`,        // still SQL, per the 2026-08-17 two-clocks entry
  },
})
```

Working example: `modules/file-summary/repository.ts`. Pin it with a test that
upserts **two or more** rows and asserts each keeps *its own* value — a one-row
test cannot distinguish the two idioms.

## 2026-08-29 — Colima's socket DID work for testcontainers here, contradicting the 2026-08-27 Rancher entry

**Rubric:** Open Questions
**Symptom:** none yet — latent, and it is a contradiction rather than a failure.
The 2026-08-27 entry below says the Colima socket does **not** fix
`Could not find a working container runtime strategy` and that
`DOCKER_HOST=unix://$HOME/.rd/docker.sock` is what works on this machine. In this
session the **Colima** socket worked for **16/16** `.it.test.ts` files and 147
tests, across four separate runs on 2026-08-28 and 2026-08-29:

```sh
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

**Cause (hypothesis, not established):** the two commands need different things.
`db:migrate` and `db:seed` reach **host port 5432**, forwarded by Rancher, so
they hit Rancher's Postgres — which is the half the 2026-08-27 entry is about,
and it stays true. testcontainers does **not** use host 5432: it creates its own
container over whichever socket it can reach, so Colima suffices for it. If that
is right, neither entry is wrong — they answer different questions, and the
2026-08-27 wording ("point *both* variables at the Rancher socket") reads as
covering both when it may only cover the migrate/seed path.
**Fix:** unverified. Before trusting either entry, run
`docker context ls` and try the suite; if Colima works, the entry below is
narrower than it reads. **Do not delete or edit the 2026-08-27 entry on the
strength of this** — it was written from a real failure and this session did not
reproduce that failure. Whoever next hits a Docker problem here should settle
which socket serves which command and supersede both.

## 2026-08-28 — a top-level `.nullable()` response schema DOES serialise `null` — you do not need an envelope for "not computed yet"

**Rubric:** What Works
**Symptom:** none — this closes a risk that was carried as an open question
through a whole spec and plan. SPEC-02 needed `GET /pulls/:id/brief` to answer
"no brief has been derived" and nobody knew whether
`response: { 200: PrBriefRecord.nullable() }` would survive
`fastify-type-provider-zod`'s serializer, or whether the payload had to be
wrapped as `{ brief: … | null }` to be safe.
**Cause:** unfalsified caution. The 2026-08-2x entry below established that
declared `response:` schemas work at all (the serializer half of
`app.ts:64-65` was wired from the start and simply unused), but only for
object-typed contracts. A **top-level** nullable was untested here.
**Fix:** it works. `modules/brief/routes.ts` declares
`response: { 200: PrBriefRecord.nullable() }` and `app.inject()` on a PR with no
brief returns **HTTP 200 with the body literally `null`**
(`test/brief-routes.test.ts`). No envelope, no `204`, no sentinel object.
Prefer this over inventing a wrapper the client then has to unwrap — a nullable
record is the honest shape for "this may not exist yet", and the client's
`.nullish()` handling already copes.

## 2026-08-28 — `@fastify/rate-limit` is inert under `NODE_ENV=test`, so a per-route `config.rateLimit` needs a non-standard app build to test at all

**Rubric:** Recurring Errors & Fixes
**Symptom:** a route declares `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }`
and a test firing six requests at it asserts a `429` — which never arrives. Every
request returns `202`. The route looks broken; it is not. Reading the route,
the plugin registration and the config all show correct code, which is what makes
this expensive.
**Cause:** `server/AGENTS.md` documents the *fact* — "rate limiting is disabled
under `NODE_ENV=test` so integration suites can hammer `inject()`" — but not its
consequence: under the standard test app build the plugin is never registered, so
a per-route `config.rateLimit` is dead configuration and **no test can observe
it**. An acceptance criterion asserting a 429 is unverifiable by default.
**Fix:** build the app once, in its own isolated `describe`, with the env flipped:

```ts
const app = await buildApp(loadConfig({ ...process.env, NODE_ENV: 'development' }));
// now 5×202, then the 6th → 429
```

Keep it in a separate `describe` with its own `buildApp`/close so the rest of the
suite keeps the fast, unthrottled app. `test/brief-routes.test.ts` is the worked
example (SPEC-02 AC-9). If you write a rate-limit AC, write this build with it —
otherwise the criterion ships green and unproven.

## 2026-08-27 — two Docker runtimes installed: `docker context` says Colima, but the socket that reaches host :5432 is Rancher Desktop's

**Rubric:** Recurring Errors & Fixes
**Supersedes:** 2026-08-02 — `*.it.test.ts` can't find Docker under Colima
**Symptom:** `pnpm exec vitest run .it.test` fails every file at `startPg()` with
`Could not find a working container runtime strategy`. Following the 2026-08-02
entry and exporting `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` does
**not** fix it. Worse and more confusing: `pnpm db:migrate` reports
`✓ migrations applied`, and then `docker exec devdigest-postgres psql` shows the
new tables absent — because those two commands reach *different* Postgres
instances.
**Cause:** both Colima and Rancher Desktop are installed. `docker context ls`
shows `colima` active, so plain `docker ps` / `docker exec` talk to a **stale
Colima container** (its last applied migration was ~2026-08-17). But host port
5432 is forwarded by **Rancher Desktop**, so the app, `db:migrate` and `db:seed`
all hit Rancher's container. testcontainers finds neither socket by default.
**Fix:** point both variables at the Rancher socket — this is what works on this
machine, and it is the one whose ports reach the host:

```sh
DOCKER_HOST=unix://$HOME/.rd/docker.sock \
TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
  pnpm exec vitest run .it.test --reporter=dot
```

Note the asymmetry: `DOCKER_HOST` takes the **real** `~/.rd/docker.sock` path,
while the override must stay the literal `/var/run/docker.sock` — that is the
path Ryuk is told to bind *inside* the container. Setting the override to
`$HOME/.rd/docker.sock` fails with `mkdir ...: operation not supported`.
Repeated container churn also yields intermittent `Failed to connect to Reaper`
(11 tests skipped, no test body run) — an environment result, not a test
failure. Rerun. If `docker exec` and the app ever disagree about schema again,
suspect this before suspecting the migration. Deleting the stale Colima
container would remove the trap.

## 2026-08-27 — `lstat` + `isSymbolicLink()` is NOT a containment check: it follows every intermediate path component

**Rubric:** What Doesn't Work
**Symptom:** a guard that resolves a repo-relative path, `lstat`s it and skips
`isSymbolicLink()` was believed to stop a symlink escaping the clone. It stops
only the case where the **final component** is the link. Measured:

```
BEFORE swap: lstat.isSymbolicLink = false | content = "legit"
AFTER  swap: lstat.isSymbolicLink = false | content = "HOST SECRET"
realpath      = /private/tmp/lstat-probe/outside/foo.md
still lexically inside clone?  true
```

**Cause:** `lstat` declines to follow only the last component. Every directory
above it is resolved normally, so replacing `specs/sub` with a symlink out of the
tree leaves `specs/sub/foo.md` reporting `isSymbolicLink() === false`, lexically
inside the clone, and reading the host file. A `resolve()` + `startsWith(root)`
test is lexical and cannot see it either.
**Fix:** `realpath` the candidate and compare it against a **`realpath`'d root**
(`resolver.ts:230,269-273`). Both sides need resolving: on macOS the clone can
sit under a symlinked prefix (`/var` → `/private/var`), so comparing a resolved
path against an unresolved root rejects *everything*. Containment means equal to
the root or starting with root + `sep` — bare `startsWith(root)` accepts a
sibling like `/clones/acme/payments-api-evil`. Keep the `isSymbolicLink()` skip
alongside it if a symlink pointing *back inside* the tree should also be refused;
`realpath` alone would accept that one.

## 2026-08-27 — a `realpath`/`stat` gate on the review path must treat "unresolvable" as unknown, not as outside

**Rubric:** Codebase Patterns
**Symptom:** adding a containment gate to the resolver that skipped a document
whenever `realpath` returned null turned three green tests in
`test/reviews.it.test.ts` red — every document reported `unread` and
`specs_read` came back empty.
**Cause:** `MockGitClient`, the virtual `GitClient` the review suites inject,
serves document bodies with **no clone on disk at all**, so every `realpath`
throws ENOENT. "Unresolvable" is a normal state in this lane, not an attack.
**Fix:** let a null resolution **fall through** and let the read decide — a real
read of an unresolvable path fails and is already reported as `unread`
(`resolver.ts:262-268`). This loses nothing: a malicious symlink pointing at a
file that actually exists resolves *successfully* and is caught by the
containment comparison; it never reaches the null branch. Note this is the
opposite posture from `assertDiscovered` in the same module, which deliberately
fails closed — the difference is that an unknown *membership* answer has no
corroborating signal downstream, whereas an unresolvable *path* is re-checked by
the read itself.

## 2026-08-27 — `sql<A | B>` does not parse: the pipe inside the generic makes tsc read it as a comparison

**Rubric:** Recurring Errors & Fixes
**Symptom:** writing a Drizzle raw aggregate as
``sql<Date | null>`max(${t.contextDocTokens.computedAt})` `` fails the whole file
with `TS1160: Unterminated template literal` reported at **EOF**, nowhere near
the actual line.
**Cause:** `tsc` resolves `sql<Date` as a `<` comparison rather than a type
argument, so the backtick that follows opens a template literal that never
closes. The error location is useless because the parser is lost from that point
on.
**Fix:** avoid the union in the type argument. Either alias it
(`type MaybeDate = Date | null` and use `sql<MaybeDate>`), or sidestep the
aggregate — `repository.ts:108-121` uses `ORDER BY … DESC LIMIT 1` instead of
`max(...)`, same result, no ambiguity. A `TS1160` at EOF in a file containing
`sql<` is almost always this.

## 2026-08-24 — blast answers `full` from the last-indexed SHA; caller lines can drift from the PR head the client links to

**Rubric:** Open Questions
**Symptom:** none yet — latent. During L04 verification, `GET /pulls/:id/blast` returned `status: 'full'` for a PR whose branch was 4 days newer than `repo_index_state.lastIndexedSha` (visible via `GET /repos/:id/index-state`). PR sync (`GET /pulls/:id`) refreshes `pr_files` but never the index.
**Cause:** `getBlastRadius`/`getDependents` serve whatever SHA the indexer last stamped; `status` reflects index *completeness at that SHA*, not freshness relative to the PR. Meanwhile the client builds caller links with `githubBlobUrl(..., pr.head_sha, file, line)`, so a caller-file `line` from the stale index can point at the wrong line of the head blob when that caller file changed since indexing.
**Fix:** none applied — constraint to know. When accuracy matters, compare `getIndexState().lastIndexedSha` with `pr.head_sha` (or its merge-base) and trigger `POST /repos/:id/resync`; a possible follow-up is surfacing `lastIndexedSha` in `BlastResponse.reason` when it trails the PR.

## 2026-08-18 — a Zod `response:` schema on a route works; the convention had zero adoption, not a blocker

**Rubric:** What Works
**Symptom:** none — this is the answer to a question the 2026-08-12 entry below
leaves open. That entry records that **0 of 53 endpoints** declare
`schema: { response: … }` "despite `server/CLAUDE.md` asking for it" and
concludes "treat it as aspirational", which reads as a warning that the
convention does not actually function here. It does; nobody had tried it.
**Cause:** `app.ts:64-65` already installs both compilers from
`fastify-type-provider-zod` (`setValidatorCompiler` **and**
`setSerializerCompiler`), so the serializer half was wired from the start and
simply unused. Zero adoption was inertia — every module copied the neighbouring
route, and no route had one to copy.
**Fix:** declare it. `GET /pulls/:id/smart-diff`
(`modules/pulls/routes.ts:43-50`) is the first one to, and it behaves exactly as
documented: the handler's return type is inferred from the schema, and a payload
that drifts from the contract fails at serialization instead of reaching the
studio. `test/pulls-smart-diff.it.test.ts` exercises it through `app.inject()`,
so the contract is covered by the same assertions that cover the behaviour —
which is why that suite needs no separate shape test. Two things worth knowing
before adding one to an existing route: a `.nullish()` field simply serialises
away when absent (no need to emit `null`), and the schema *strips* unknown keys,
so a route whose service returns extra fields the contract omits would silently
stop sending them. Prefer it on new endpoints; on an existing one, check the
service's return shape against the contract first.

## 2026-08-17 — a feature-model default the tests don't override reaches a REAL provider, and the suite bills you for it

**Rubric:** What Doesn't Work
**Symptom:** a brand-new `*.it.test.ts` for the L03 intent layer failed on three
assertions that all looked like ordinary fixture drift — `change_type` was not
`'bugfix'`, and a confidence the fixture set to `0.95` came back as **`0.4`**.
`0.4` appears nowhere in the test. It appears in
`src/prompts/review-intent.system.md`, which instructs the model to cap an
undocumented reading "at 0.4" — i.e. a **live OpenRouter call** had read the new
prompt file and followed it. The suite was silently spending money.
**Cause:** `container.llm(id)` resolves `overrides.llm?.[id]` **by provider id**
(`platform/container.ts:189`), and every existing integration test overrides only
the provider its *agent* uses (`openai`). L03 added a second model call in front
of every review — the `review_intent` feature model — whose registry default is a
different provider (`openrouter`, `contracts/platform.ts:51`). With no key that
path throws `ConfigError` and degrades harmlessly, which is why this is invisible
in CI; on a developer machine with `OPENROUTER_API_KEY` configured it is a real,
billable request whose answer the assertions then depend on.
**Fix:** override **every provider the code will resolve**, not just the agent's.
`test/helpers/intent.ts` exports `intentLlm()` for exactly this and is wired into
`reviews.it.test.ts`, `skills-prompt.it.test.ts` and `intent.it.test.ts`:

```ts
llm: {
  openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
  openrouter: intentLlm(),   // ← the feature-model half; without it, a real call
}
```

The general rule, which now applies to every future feature model: **changing a
`FEATURE_MODELS` default provider is a test-harness change**, because it moves
which key of the override map is consulted. Before changing one, grep the
integration tests for `llm: {` and confirm each still covers what the new default
resolves. The tell that you are hitting a live model is an assertion failing
against a value that exists in a **prompt file** rather than in the fixture.

## 2026-08-17 — a timestamp defaulted by Postgres and updated by Node mixes two clocks, and can go backwards

**Rubric:** Recurring Errors & Fixes
**Symptom:** `pr_intent.created_at` (meaning "last derived at") went *backwards*
on a re-derivation — an integration assertion that the second write is newer
failed with `expected 1786994453943 to be greater than 1786994453993`, i.e. the
**fresh** row was 50ms older than the one it replaced. Reads as a wildly flaky
test, or as an upsert writing the wrong row.
**Cause:** the two write paths used two different clocks. The insert path takes
the column default — `now()` from `db/schema/_shared.ts:9`, evaluated **inside
Postgres**. The conflict path stamped `createdAt: new Date()`, evaluated in
**Node**. Under Colima (and any VM- or container-hosted Postgres) those clocks
drift apart, so the comparison is unsound in both directions and no amount of
`setTimeout` between the writes fixes it.
**Fix:** stamp both paths from the same clock — in an `onConflictDoUpdate` on a
table whose timestamp column is `defaultNow()`, use SQL, not JS:

```ts
import { sql } from 'drizzle-orm';
.onConflictDoUpdate({ target: t.prIntent.prId, set: { ...values, createdAt: sql`now()` } })
```

Two separate requests are two transactions, so `now()` still differs between
them. The column cannot simply be left out of the `set`: the default fires only
on insert, so an omitted `createdAt` keeps the original timestamp and the row
reads as never re-derived. Applies to every "last updated at" column reached by
an upsert — check `conventions` and `repo_index_state` before adding one there.

## 2026-08-17 — `HEAD` does not typecheck: `modules/index.ts` carries a duplicated `skills` import, and the fix is uncommitted

**Rubric:** Recurring Errors & Fixes
**Symptom:** `pnpm typecheck` fails on a fresh clone of `main`/`HEAD` (`956295b`)
but passes in this working tree. Meanwhile `git status` shows a lone
` M server/src/modules/index.ts` that reads like unrelated leftover noise from
someone else's session — easy to ignore, and easy to `git checkout --` away.
**Cause:** `956295b` ("Add missing files") committed
`server/src/modules/index.ts` with `import skills from './skills/routes.js';`
present **twice** (lines 8 and 11) and the `skills` key present twice in the
`modules` literal (lines 34 and 37). `tsc` reports
`error TS2300: Duplicate identifier 'skills'` — confirmed by compiling
`git show HEAD:server/src/modules/index.ts`. Runtime was never affected, which is
why this survived: `app.ts` iterates `Object.values(modules)` and a duplicated
object-literal key collapses to one, so boot worked and every suite stayed green.
`pnpm lint:arch` also passes on **both** versions (`✔ no dependency violations
found`) because the dependency graph is identical either way. Only the
typechecker sees it.
**Fix:** commit that deletion — the uncommitted working-tree edit *is* the fix,
and until it lands a fresh clone cannot typecheck and `server-unit.yml` fails for
a reason unrelated to whatever PR triggered it. Do not restore either duplicate.
The general lesson: the module registry is a hand-maintained static literal
(deliberately not `@fastify/autoload`, `server/src/modules/index.ts:17-24`), so a
duplicated or missing key is a class of defect that **only** `tsc` catches — a
green `lint:arch` and a green suite say nothing about it. When you touch the
registry, run `pnpm typecheck` specifically.

## 2026-08-12 — a response type is declared in one of four places, and 9 endpoints declare none

**Rubric:** Codebase Patterns
**Symptom:** looking for "the" response shape of an endpoint finds nothing at the
route, and following only the service return type still leaves a third of the
API unaccounted for. Worse, `GET /pulls/:id` *looks* like it returns an object
literal — the handler builds the payload inline with spreads — so a scan that
trusts the literal reports a partial shape that is confidently wrong.
**Cause:** refines point 2 of *2026-08-11 — the API surface is not readable from
`modules/*/routes.ts` alone*, which says the response wire format "lives in the
contracts, and nowhere else". It lives in four places, in descending strength:
1. **`schema: { response: … }` on the route** — **0 of 53 endpoints** use this,
   despite `server/CLAUDE.md` asking for it ("One Zod schema serves request
   validation AND response serialization. Declare it on the route"). The
   convention has zero adoption for responses; treat it as aspirational.
2. **The handler's own annotation** — `async (req): Promise<PrDetail> =>`
   (7 endpoints, all in `modules/pulls/routes.ts`). This is the only thing that
   correctly types the handlers that query the DB inline; without it they read as
   object literals.
3. **The service method's `Promise<…>`** (28 endpoints) — the common case, e.g.
   `AgentsService.list(): Promise<Agent[]>`.
4. **An inline object type or literal** (9 endpoints) — `Promise<{ status:
   'refreshing' }>` (`ReposService.refresh`) or a bare `{ ok: true }`. These are
   in no contract at all, so a contract-level scan cannot see them.

The remaining **9 endpoints have no declared response type anywhere** —
`GET /settings`, `PUT /settings`, `GET /health`, `GET /pulls/:id/runs`,
`DELETE /runs/:id` among them — because the handler queries `container.db`
directly and nothing annotates the result.
**Fix:** to read a response shape, use the resolver that already walks all four:
`node .claude/skills/api-response-changes/response-surface.mjs [ref] --summary`
prints one line per endpoint with its `via`, and `check.mjs` diffs two refs for
breaks a *reader* feels (field removed, flipped optional/nullable, `.partial()`
on a served contract). When adding or changing an endpoint, annotate the handler
return type — one line, no runtime cost, and it is what makes the response
checkable. A change to a service method's return type is a wire-format change
even when `routes.ts` has an empty diff.

## 2026-08-11 — the API surface is not readable from `modules/*/routes.ts` alone

**Rubric:** Codebase Patterns
**Symptom:** an endpoint inventory built by grepping `app.<verb>(` across
`src/modules/*/routes.ts` is wrong in three directions at once: it lists routes
nothing serves, it contains no response shapes at all, and a change that takes
11 endpoints offline shows up as an **empty diff on every route file**.
**Cause:** the surface is spread across three places.
1. **The registry is part of it.** `src/modules/index.ts` registers modules
   statically (deliberately not `@fastify/autoload`). Delete one key from the
   `modules` object and every route in that folder stops being served while the
   route file, its tests, and its `git diff` all stay clean.
2. **No route declares a `response:` schema.** All 45 `schema: {` blocks under
   `src/modules/*/routes.ts` carry only `body` / `params` / `querystring`;
   responses are typed by the service return type (`Promise<SecretsStatus>`) and
   shaped by the exported Zod schemas in `src/vendor/shared/`. So the response
   wire format lives in the contracts, and nowhere else.
3. **One route path is built in a loop.** `` app.post(`/findings/:id/${action}`) ``
   (`modules/reviews/routes.ts:144`) is one registration per iteration; any
   text-level scan sees a single templated path, not `accept` and `dismiss`.
**Fix:** read all three, or use the extractor that already does —
`node .claude/skills/api-breaking-changes/surface.mjs [ref]` dumps endpoints
(with a `registered` flag), the registry, the resolved contract shapes and the
studio's call sites as JSON, for any git ref without a checkout.
`check.mjs` diffs two refs and classifies what breaks a caller. When adding a
module, the registry entry is not boilerplate — it is the thing that makes the
endpoints exist.

## 2026-08-11 — `waitForPrRuns` is not enough before reading `/runs/:id/trace`

**Rubric:** Recurring Errors & Fixes
**Symptom:** an integration test that asserts on a persisted trace passes when
run alone and fails **only under the full suite**, with an assertion that reads
as a product bug rather than a race — `prompt_assembly.skills` comes back
`null`/`undefined`, so you get
`TypeError: Cannot read properties of null (reading 'indexOf')` or
`the given combination of arguments (null and string) is invalid for this
assertion`. Re-running the file alone is green, which makes it look like
cross-test pollution.
**Cause:** `waitForPrRuns` (`test/helpers/runs.ts`) polls `agent_runs.status`
until it is terminal, but the executor marks the run terminal *first* and only
then persists the review, the findings and — last — the trace
(`completeAgentRun` at `run-executor.ts:256`, `saveRunTrace` at `:301`). A test
that polls on run status can therefore read the trace inside that ~45-line
window and get a 404. Under 31 parallel Testcontainers suites the window widens
enough to lose the race. Note also that `waitForPrRuns` **returns** on timeout
rather than throwing, so a genuinely unfinished run degrades into the same
confusing assertion instead of a clear timeout.
**Fix:** `await waitForTrace(db, runId)` from the same helper module after
`waitForPrRuns` and before any `GET /runs/:id/trace`. Do not "fix" this by
reordering the writes in `run-executor` — the run's terminal status is what SSE
and the timeline depend on, and the trace is observability that legitimately
lands after it. `test/reviews.it.test.ts:201` reads a trace the same way and has
the same latent race; it has not been seen failing, and the one-line fix is the
same call.

## 2026-08-11 — a `server/specs/*.md` marked "Status: shipped" can still be ahead of the code

**Rubric:** Codebase Patterns
**Symptom:** `server/specs/skills.md` documents the skills feature as
**shipped**, in past tense, with line-precise pointers — `buildSkillBlocks` in
`run-executor.ts:344`, the `skills` spread at `:210` — and an acceptance list
almost entirely ticked. None of it was true: `grep -n skills
src/modules/reviews/run-executor.ts` returned a single hit, `prompt_assembly:
{ skills: null }`. The client, its 131 tests and both typechecks were all green,
because the client suites stub `fetch` and nothing type-links a hook's URL string
to a route that exists.
**Cause:** this repo is a course starter, so a spec is written as the design of a
lesson and is not re-verified against the tree afterwards; and the halves of a
feature land in different packages at different times. The tests were the only
artefact that told the truth — `skills.it.test.ts` and `skills-prompt.it.test.ts`
were present and failing 10 assertions, but they are `*.it.test.ts`, so they are
silently skipped without Docker (`dockerAvailable()` gates the whole `describe`).
A green `pnpm test` therefore proves much less than it appears to.
**Fix:** before implementing anything a spec claims is done, verify the claim
against the code, not the prose — `grep` for the named symbol, and run the
integration suites with Docker actually reachable (under Colima that needs the
two `DOCKER_HOST` variables; see the 2026-08-02 entry below). Existing failing
`*.it.test.ts` files are the most reliable specification of what is missing, and
they are the acceptance criteria — read them before designing. The root
`CLAUDE.md` rule "if an entry contradicts the code as it stands now, the code
wins" applies to `specs/` exactly as it does to `insights.md`.

## 2026-08-11 — a failed conventions scan reports nothing useful anywhere except its own DB row

**Rubric:** Recurring Errors & Fixes
**Symptom:** the Conventions screen says only *"The last scan failed. Re-scan to
try again."* The `jobs` row for the scan is **`done`**, not failed, and the API
log shows no error — so both places you would normally look say everything is
fine, and the advice the UI gives ("re-scan") is exactly wrong for a
deterministic failure.
**Cause:** by design. `runConventionScan`
(`src/modules/conventions/pipeline.ts`) **never throws** — `JobRunner` retries a
rejected handler twice, which for a missing key or a broken model config would
mean three full scans and three bills for one broken setting. So every failure is
swallowed and persisted instead, and the job legitimately succeeded at running
it. The only record of *why* is `convention_scan_state.error` (truncated to 500
chars, because a provider can return a page of HTML as its message).
**Fix:** read the row — this is the first move for any conventions-scan
complaint, before reading code:

```sh
docker exec devdigest-postgres psql -U devdigest -d devdigest -x -c \
  "select s.status, s.reason, s.provider, s.model, s.sample_files, s.selected_files, s.error \
   from convention_scan_state s join repos r on r.id = s.repo_id where r.full_name like '%NAME%';"
```

Read `reason` and `error` together: `reason` is set only on the classified exits
(`not_indexed`, `no_clone`, `llm_unavailable`, `model_unsupported`,
`no_candidates`), so **`reason` NULL with `error` populated means the generic
catch at the bottom of the pipeline** — and that path passes neither `provider`
nor `model` nor `sampleFiles` to `finish()`, so those columns read as empty/0 even
when sampling actually succeeded. Do not conclude from `sample_files = 0` that
sampling failed; check `started_at`→`finished_at` instead (a sub-2s failure is a
rejected API call, ~60s is a real scan). Widening that catch to carry the
provider/model is still unclaimed work.

## 2026-08-11 — `db:generate` diffs against the highest-numbered SNAPSHOT, ignoring the journal

**Rubric:** Tool & Library Notes
**Symptom:** an unrelated `ALTER TABLE "agent_skills" DROP COLUMN "enabled";`
appeared inside a freshly generated migration that was supposed to contain only
new `conventions` DDL. The dropped column was one nothing in `src/db/schema/`
declared — and one no database had ever had.
**Cause:** two independent facts. (1) drizzle-kit picks the *previous* state with
`readdirSync(meta).filter(f => !f.startsWith('_')).sort()` and takes the **last**
entry — `meta/_journal.json` is not consulted for that. (2) It takes the new
migration's index from `journal.entries[last].idx + 1`. So an orphaned
`meta/00NN_snapshot.json` whose tag is absent from the journal still defines the
baseline: the diff is computed against a schema state that was never applied, and
the new snapshot then *overwrites* the orphan, hiding the problem further. Here
`0011_cultured_the_fallen.sql` + `meta/0011_snapshot.json` existed on disk,
untracked and unjournaled, from an earlier unfinished session.
**Fix:** before `pnpm db:generate`, check the two lists agree —
`ls src/db/migrations/meta/*_snapshot.json` against
`grep -o '"tag": "[^"]*"' src/db/migrations/meta/_journal.json`. A snapshot with
no journal entry has never been applied anywhere (`db/migrate.ts` is
journal-driven), so delete that SQL/snapshot **pair** and re-declare whatever it
intended in `src/db/schema/` so it regenerates honestly. Also verify the target
DB matches the journal — someone may have applied the orphan SQL by hand, in
which case `db:migrate` fails with `column "x" already exists` and the column has
to be dropped before the real migration can run.

## 2026-08-11 — `db:generate` prompts interactively when a table both gains and loses a column

**Rubric:** Tool & Library Notes
**Symptom:** `pnpm db:generate` hangs forever at
`Is source_rule column in conventions table created or renamed from another
column?` with a `❯ + create column / ~ accepted › source_rule rename column`
picker. Piping newlines does nothing; `script -q /dev/null` to fake a PTY also
hung and had to be killed.
**Cause:** drizzle-kit cannot tell an add+drop from a rename, so it asks. The
prompt is a raw-keypress TUI — it reads the terminal directly, not stdin, so it
is unanswerable from a non-interactive shell.
**Fix:** remove the ambiguity instead of trying to answer it. Split into two
generates: keep the doomed column in the schema, generate (pure additions → no
prompt), then delete the column and generate again (pure drop → no prompt). Two
migrations, fully deterministic; this is how `0011_red_dagger` +
`0012_misty_tattoo` were produced. Always read the generated SQL before
migrating — a silent `RENAME` where you wanted a drop is data loss.

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