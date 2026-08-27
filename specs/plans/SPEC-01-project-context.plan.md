# Implementation Plan: Project Context (SPEC-01)

Spec: SPEC-01-project-context.md
Status: delivered
Execution: single-agent
Approved: 2026-08-27

---

## Decisions taken

Every item below was settled in the planning thread, **not** in SPEC-01. The spec still says otherwise in the sections named in the last column, so `implementer` must treat this plan as authoritative where the two disagree, and the coordinator must amend the spec before the build is verified against it.

| # | Decision | Closes | SPEC-01 section to amend |
|---|---|---|---|
| D-Q1 | **New DTO pair + envelope.** Item: `path`, `source`, `tokens` (nullable), `attached_agents`, `size`. Envelope: `files`, `total`, `omitted`, `scanned_at`. `SpecFile` is left untouched. OQ-1 resolved **against** the spec's stated assumption. | R-1, R-2 | *Contract impact* (the `SpecFile` bullet and OQ-1's assumption); NFR-12 (the response type is retyped, not extended) |
| D-Q2 | **A second read route:** `GET /repos/:id/context/doc?path=…`, one document's text, 400 KB cap, `doc_not_found`. | R-3 | *Module interactions → Callers and callees* (add the row) |
| D-Q3 | **Containment guard inside `SimpleGitClient.readFile`**, throwing `ValidationError` on escape. Author reversed the OQ-6 decline. Proposed criterion text in *Open questions* below. | R-4 | *Untrusted inputs → Path traversal*; OQ-6; add the new AC to *Acceptance criteria* and *Verification* |
| D-Q4 | **`POST /repos/:id/context/reindex` is the token-job trigger**, plus enqueue-on-clone-complete. | R-5 | *Module interactions*; NFR-12; add an AC for the reindex endpoint |
| D-Q5 | **`RunTrace.specs_skipped`** added: `z.array(z.object({ path: z.string(), reason: z.enum(['unread','oversize','budget']) })).nullish()`. `specs_read` keeps its meaning. | R-6 | *Contract impact* (the "`RunTrace.specs_read` needs no shape change" claim); AC-43, AC-49 |
| D-Q6a | **Roots resolve at any depth**, not clone-root only. Tie-break: the **leftmost** matching path segment wins, so `docs/specs/x.md` is tagged `docs`. | R-7 | AC-1, AC-2 (add the anchoring and tie-break rules) |
| D-Q6b | **Dedicated walk** in the new module, `pipeline/walk.ts` as template. Ratified reasoning, recorded so it is not reopened: adding `.md` to `SUPPORTED_EXT` feeds Markdown into ast-grep, `dependency-cruiser`, PageRank and the repo-map renderer — all of which consume the same set from `walk.ts:100-101` — and forces `INDEXER_VERSION` 2 → 3, a full reindex of every repository. | OQ-2 | OQ-2 → resolved |
| D-Q6c | **`EXCLUDED_DIRS` only**, no `.gitignore`. REC-4 declined. | OQ-3 | OQ-3 → resolved |
| D-Q6d | **The fence label carries the path:** `source="specs/public-api.md"`. `reviewer-core` gets exactly one production edit. | OQ-4 | OQ-4 → resolved; AC-60 |
| D-Q6e | `MAX_CONTEXT_DOCUMENTS = 500`, kept as a named constant. | OQ-8 | OQ-8 → resolved |
| D-Q6f | The agent Context tab takes its repo from `useActiveRepo()`. Consequence recorded: `agent_context_docs` stores a bare repo-agnostic `path`, so an attachment made against repo A resolves against whatever repo the PR belongs to at run time. | R-8 | *Schema impact* (note 2) |
| D-Q6g | **No seeded clone.** AC-1, AC-8 and AC-11 have no seeded or e2e route; the demo shows AC-5's cloning state. Accepted gap, not a fix. | R-11 | — (record as a known limitation) |
| D-Q7 | **REC-3 accepted** — two cuts with an explicit barrier. **REC-6 accepted** — fix the `SkillsTab.tsx` comment. **REC-4 and REC-5 declined.** | — | — |
| D-Q8 | **`single-agent`.** | — | — |
| D-OQ5 | Seam = a `project-context` module exposing `container.projectContext`, never throwing, owning the timeout and the token budget. Skill inheritance via `container.agentsRepo.linkedSkills`. | OQ-5 | OQ-5 → resolved |
| D-OQ7 | AC-54 stays `e2e web` with the fullscreen-button route **plus** a `client` test on the literal expand control, and a named fallback. | OQ-7 | OQ-7 → resolved |
| D-NFR4 | NFR-4 is **observation-only, not a gate.** | — | NFR-4 (restate as an observation) |

Three implementation decisions I took inside my own half, called out because a reviewer will want them visible:

- **`scanned_at` = `MAX(context_doc_tokens.computed_at)` for the repo, or `null`.** The document *list* is a live walk (AC-1 says "found … in that repository's clone"), while AC-16's "time the scan ran" is the persisted token scan, which is what D-Q4 promised. No extra table.
- **AC-34 is implemented as "no cached row for this path", not as a per-request hash comparison.** Hashing up to 500 files of up to 400 KB on every list request would break NFR-3's 800 ms budget outright. `content_hash` is what the *job* uses to skip recomputation — exactly the role the spec's *Schema impact* note 1 gives it. A count can therefore be stale between reindexes; that is the same freshness posture the spec already accepts for the clone. Wording nit for the amendment, listed in *Open questions*.
- **The walk does not filter by size**, unlike its template. `pipeline/walk.ts:112-115` drops files over `MAX_FILE_SIZE`; NFR-5 requires a 400 KB document to be **listed and previewable**, so the size cap moves to read time only (the content route and AC-49).

## Requirements traced

| Plan step | Satisfies | Verified by |
|---|---|---|
| 1 | AC-2, AC-6, AC-16, AC-30, AC-34 (payload shape); NFR-12 | `./scripts/check-contracts.sh`; `cd server && pnpm typecheck` |
| 2 | NFR-12 | `./scripts/check-contracts.sh`; `cd client && pnpm typecheck` |
| 3 | AC-18, AC-20, AC-36 (persistence substrate) | `cd server && pnpm typecheck` |
| 4 | — (mechanism for step 3) | generated SQL exists under `src/db/migrations/` |
| 5 | — (mechanism for step 3) | `pnpm db:migrate` exits 0; `pnpm exec vitest run .it.test` boots |
| 6 | **proposed AC-61/AC-62** (D-Q3) | `server/test/adapters/git-containment.test.ts` (new) |
| 7 | AC-3, AC-15, AC-30, AC-34 | `cd server && pnpm lint:arch`; step 12's it-tests |
| 8 | AC-1, AC-2, AC-6; NFR-5 | `server/src/modules/project-context/walk.test.ts` (new) |
| 9 | AC-1, AC-2, AC-3, AC-4, AC-6, AC-11†, AC-15, AC-16, AC-30, AC-34; NFR-3 | `project-context.test.ts` (new) + `project-context.it.test.ts` (new) |
| 10 | AC-3, AC-4, AC-12†; D-Q4's reindex route | `project-context.it.test.ts` |
| 11 | AC-36, AC-37, AC-38; NFR-4 | `token-count.test.ts` (new) + `project-context.it.test.ts` |
| 12 | verification for AC-1–4, 6, 15, 30, 34, 36–38; NFR-3, NFR-4, NFR-5, NFR-10†, NFR-12 | `cd server && pnpm test` |
| 13 | — (feeds every client AC below) | `cd client && pnpm typecheck` |
| 14 | AC-5, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-16 | `ProjectContextView.test.tsx` (new) |
| 15 | AC-57, AC-58† | `useGlobalShortcuts.test.ts` (new); `cd client && pnpm test` |
| 16 | verification for AC-5, 7–14, 16, 57, 58†; NFR-6, NFR-7, NFR-9 | `cd client && pnpm test` |
| **— BARRIER — Cut 1 ships and is reviewed —** | | |
| 18 | AC-53; NFR-12 | `./scripts/check-contracts.sh`; both typechecks |
| 19 | AC-18, AC-19, AC-20, AC-21, AC-22 | `project-context.it.test.ts` |
| 20 | AC-21, AC-22, AC-39, AC-40, AC-43, AC-45, AC-47, AC-48, AC-49, AC-50; NFR-1, NFR-2 | `resolver.test.ts` (new) |
| 21 | AC-39 | `pnpm lint:arch`; step 25 |
| 22 | AC-18, AC-19, AC-20 | `project-context.it.test.ts` |
| 23 | AC-42, AC-50, AC-59, AC-60 | `cd reviewer-core && npm test` |
| 24 | AC-41, AC-43, AC-44, AC-46, AC-47, AC-50, AC-51; NFR-10 | `run-executor` unit specs + `reviews.it.test.ts` |
| 25 | verification for AC-18–22, 39–51; NFR-1, NFR-10 | `cd server && pnpm test` |
| 26 | — (feeds steps 27, 28) | `cd client && pnpm typecheck` |
| 27 | AC-17, AC-23, AC-24, AC-25, AC-26, AC-27, AC-28, AC-29, AC-31, AC-32, AC-33, AC-35; NFR-6‡, NFR-7, NFR-8, NFR-9 | `ContextTab.test.tsx` (new) |
| 28 | AC-20 (UI), AC-31, AC-32 | `SkillEditorModal.test.tsx` |
| 29 | AC-52, AC-53, AC-55 | `TraceBody.test.tsx` (new or extended) |
| 30 | AC-56 | `project-context.it.test.ts` / `seed.it.test.ts` |
| 31 | verification for AC-17, 23–29, 31–33, 35, 52, 53, 55; NFR-6‡–9 | `cd client && pnpm test` |
| 32 | AC-54, AC-58 | `./scripts/e2e.sh` |

† server or client half only — the other half is in the paired step.
‡ NFR-6 is satisfied for every control **except** the reorder handles — see *Constraints & invariants*.

**Requirements with no delivering step:** none. All 60 ACs and all 12 NFRs are assigned above. What is *not* covered is narrower and stated in *Verification → What is deliberately not run*: NFR-11 has no harness by the spec's own admission, NFR-4 is observation-only by D-NFR4, NFR-6 is partially unsatisfiable by D-Q7, and AC-1/AC-8/AC-11 are proven only by fixtures and mocks — never in a seeded stack — by D-Q6g.

## Goal & scope

After this build, a reviewer opens `/repos/:repoId/context`, sees every Markdown document their repository already contains grouped by the root it came from with a token cost against each, and can read any one of them as rendered Markdown. They can attach specific documents to a specific agent and to a specific skill, in an order they control, and a review run is genuinely grounded in them: the resolved bodies reach `reviewer-core` as its `specs` input, get fenced as `<untrusted source="<path>">`, and land in the run trace where the injected text can be read after the fact.

**Not included:** creating, editing, uploading or deleting documents; chunking, embedding or semantic retrieval; the COVERAGE ring; the agent editor's Evals/Stats/CI tabs; converting the skill editor into a routed page; retrofitting attachments onto historical runs; any eval harness. Scope is SPEC-01's Goals and Non-goals verbatim — this plan widens it in exactly two places, both author-approved: the `SimpleGitClient.readFile` containment guard (D-Q3) and the `/context/doc` read route (D-Q2).

## Impact map

| Package / layer | Files | Kind of change | Risk |
|---|---|---|---|
| shared contracts (canonical) | `server/src/vendor/shared/contracts/project-context.ts` (new), `contracts/trace.ts`, `vendor/shared/index.ts` | new file + 1 additive field + 1 barrel line | **Touches `vendor/shared` → mirror sync + `check-contracts.sh` mandatory.** Mirror is clean today (verified), so the diff will carry only this change |
| client contract mirror | `client/src/vendor/shared/**`, `client/src/lib/types.ts` | generated by `--fix`, plus re-exports | low |
| server schema | `server/src/db/schema/project-context.ts` (new), `db/schema.ts` | 3 new tables, 1 `export *`, 3 entries in the `schema` object | **Needs a migration.** No existing row migrated; three tables start empty |
| server migrations | `server/src/db/migrations/**` | drizzle-kit output | never hand-edited |
| server adapter | `server/src/adapters/git/simple-git.ts` | containment guard in `readFile` | **Behaviour change on a shared adapter** — every existing caller now goes through the assertion. Only in-clone paths are produced today, so no caller should notice |
| server module | `server/src/modules/project-context/**` (new), `modules/index.ts` | new module + 1 import + 1 registry entry | low; the registry entry is what makes the routes exist |
| server platform | `server/src/platform/container.ts` | 1 getter + 1 override field | low |
| server modules (edits) | `modules/repos/service.ts`, `modules/reviews/run-executor.ts` | 1 enqueue; the specs wiring + trace fields | `run-executor` is the review critical path — NFR-1 and AC-47/48 exist for this |
| server seed | `server/src/db/seed-context.ts` (new), `db/seed.ts` | 1 `agent_runs` + 1 `run_traces` row | see step 30's regression note |
| `reviewer-core` | `src/prompt.ts`, `test/prompt.test.ts` | **one line** (the fence label) + tests | **Wire-format-visible:** every prompt's `source=` attribute changes shape |
| client studio | new `/repos/[repoId]/context` route + view, agent `ContextTab`, skill modal surface, `lib/hooks/project-context.ts`, `lib/hooks/keys.ts`, `vendor/ui/nav.ts`, `messages/en/{context,runs,agents,skills,shell?}.json` | new route + 2 surfaces | `vendor/ui/nav.ts` is normally do-not-touch — author-signed-off, see *Constraints* |
| e2e | `e2e/specs/11-project-context.flow.json` (new) | 1 flow | two unretired unknowns, both with fallbacks |

**Does the wire format change?** Yes, in three places: a new response envelope on two new routes, one additive `.nullish()` field on `RunTrace`, and the `source=` attribute inside assembled prompts. All three are additive or new; nothing is removed, retyped or made required on an existing served payload.

## Execution — single-agent

One `implementer` executes steps 1 → 33 in order, in one context, and runs the verification itself. Steps 17 and 33 are gates, not code.

**The barrier after step 17 is real, not decorative.** Cut 1 must typecheck, pass `lint:arch`, pass both server suites and the client suite, and be reviewed before step 18 begins. Cut 2's three tables, the resolver, the run path and both attach surfaces are all built on Cut 1's envelope shape; discovering that shape is wrong after step 24 costs the whole second cut.

**Why multi-agent was assessed and declined** (recorded so nobody redoes the analysis): the work does split cleanly into four groups — contracts (necessarily one serialized writer, because canonical + mirror is one atomic edit), server, studio, and a `reviewer-core`+`e2e` group that is almost entirely test-shaped. Files are genuinely disjoint across them once `lib/hooks/project-context.ts` and `keys.ts` land before the two client surfaces. It was declined because the envelope shape decided in step 1 flows into the server routes, the client hooks *and* the row rendering, and handoff fidelity across a 60-AC contract is precisely where a fresh context per group loses more than it buys. The split is recoverable later: groups would be **G1** steps 1–2 + 18, **G2** steps 3–12 + 19–25 + 30, **G3** steps 13–16 + 26–29 + 31, **G4** steps 23 + 32.

---

## Steps

### CUT 1 — discovery, the read-only page, the content route, the guard

### Step 1 — Contracts: the project-context read DTOs · package: shared (canonical)

- **Files:** create `server/src/vendor/shared/contracts/project-context.ts`; modify `server/src/vendor/shared/index.ts` (one `export *` line, placed with the others)
- **Satisfies:** AC-2, AC-6, AC-16, AC-30, AC-34 (the payload that carries them); NFR-12
- **Skills:** `zod`
- **Depends on:** —
- **Done when:** `cd server && pnpm typecheck` passes and the new schemas are reachable as `@devdigest/shared` exports
- **Notes:**
  - Declare `ContextDocSource = z.enum(['specs','docs','insights'])`; `ContextDoc = { path, source: ContextDocSource, tokens: z.number().int().nullable(), attached_agents: z.number().int(), size: z.number().int().nullable() }`; `ContextDocList = { files: z.array(ContextDoc), total: z.number().int(), omitted: z.number().int(), scanned_at: z.string().nullable() }`; `ContextDocContent = { path, content: z.string(), size: z.number().int() }`.
  - `tokens` is `.nullable()` and **required-but-nullable**, not `.nullish()` — AC-34 makes null a meaningful value the client branches on (AC-35), and an *absent* key would let a serialization bug masquerade as "pending". The root-`insights.md:363` `.nullish()` rule is about `PrMeta`'s triple duty and does not apply to a new single-purpose DTO; say so in a comment so the next reader does not "fix" it.
  - Do **not** touch `SpecFile` (`contracts/platform.ts:260-266`) — D-Q1 leaves it for a future file browser.
  - Names checked against the barrel for collision: nothing called `ContextDoc*` exists. Deliberately avoided: any `ContextStatus`-shaped name, per the spec's warning that `IndexStatus` already exists twice (`platform.ts:268-273` and `modules/repo-intel/types.ts:25`).
  - One Zod schema serves validation **and** serialization — declare these on the routes in step 10 rather than hand-validating in the service.

### Step 2 — Mirror the contracts into the client · package: shared (mirror)

- **Files:** `client/src/vendor/shared/**` (written by the script); modify `client/src/lib/types.ts` (re-export the four new types alongside `SpecFile`)
- **Satisfies:** NFR-12
- **Skills:** `zod`
- **Depends on:** Step 1
- **Done when:** `./scripts/check-contracts.sh` prints OK **and** `cd client && pnpm typecheck` passes
- **Notes:** run `./scripts/check-contracts.sh --fix` (always copies server → client), then `git diff -- client/src/vendor/shared` and read it. The root `insights.md` warning that `--fix` can sweep up earlier unmirrored drift does **not** bite here: I ran the checker on this branch and it returned `OK`, so the diff should contain only step 1's file plus the barrel line. If it contains anything else, stop — that is pre-existing drift and it needs its own decision.

### Step 3 — Schema: the three new tables · package: server

- **Files:** create `server/src/db/schema/project-context.ts`; modify `server/src/db/schema.ts` (one `export *` line **and** three entries in the `schema` object at `:50-93`)
- **Satisfies:** AC-18, AC-20, AC-36 (substrate); AC-15's count source
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** —
- **Done when:** `cd server && pnpm typecheck` passes and all three tables appear in the `schema` object
- **Notes:**
  - `agentContextDocs` — `workspaceId` (FK → `workspaces`, cascade), `agentId` (FK → `agents`, cascade), `path` (text), `order` (integer, default 0), PK `(agentId, path)`. `skillContextDocs` — same shape against `skills`. `contextDocTokens` — `workspaceId`, `repoId` (FK → `repos`, cascade), `path`, `contentHash` (text), `tokens` (integer), `computedAt` (timestamptz), PK `(repoId, path)`.
  - **All three tables are created in this one migration, including the two link tables Cut 2 writes.** This is deliberate and matches the repo's stated schema-ahead-of-features policy; it also lets AC-15's `attached_agents` count be genuinely real in Cut 1 (a `COUNT(*)` over an empty table returns 0 honestly) instead of a hardcoded zero that has to be revisited.
  - **Indexes are not optional here.** Postgres does not index FK columns automatically, and the spec commits to following that part of the `postgresql-table-design` advice: add `index()` on `agentContextDocs(workspaceId, path)` (AC-15 groups by `path` and the PK's leading column is `agentId`, so the PK cannot serve it), on `skillContextDocs(skillId)` and `agentContextDocs(agentId)` where the PK does not already lead with them, and rely on `contextDocTokens`'s PK for the `repoId` range scan.
  - **Deliberate deviation from the skill:** `postgresql-table-design` prefers `BIGINT GENERATED ALWAYS AS IDENTITY` surrogate keys. Every one of this repo's ~35 tables uses `uuid().defaultRandom()` or a composite PK, and `agent_skills` (`schema/agents.ts:51-67`) — the table these copy — uses a composite PK with no surrogate. Consistency wins; note it in the file header.
  - **`agent_skills` itself has no `workspace_id`**, so "modelled directly on `agent_skills`" is true of everything except tenancy. These three carry `workspace_id` because the root `AGENTS.md` rule requires it and AC-3/AC-18/AC-20 test it. Note the divergence in the header so it is not read as a mistake.
  - `path` is a join key, not an FK — documents live in a clone and have no row. That is what makes AC-29 and AC-43 necessary.

### Step 4 — Generate the migration · package: server

- **Files:** `server/src/db/migrations/**` (drizzle-kit output — **never** hand-edited)
- **Satisfies:** — (mechanism for step 3)
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 3
- **Done when:** `cd server && pnpm db:generate` has written exactly one new `.sql` file plus its journal entry, and the SQL creates three tables and their indexes and nothing else
- **Notes:** read the generated SQL before moving on. If it contains a `DROP` or an `ALTER` against any pre-existing table, something in step 3 touched a shared file wrongly — stop rather than migrate.

### Step 5 — Apply the migration · package: server

- **Files:** none (DB state)
- **Satisfies:** — (mechanism for step 3)
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 4
- **Done when:** `cd server && pnpm db:migrate` exits 0, and `pnpm exec vitest run .it.test` still boots its testcontainer
- **Notes:** migrations do not run on boot — this is the step that makes the tables exist. A first-run `relation ... does not exist` later is always a missing `db:migrate`.

### Step 6 — Path-traversal containment guard in the git adapter · package: server

- **Files:** modify `server/src/adapters/git/simple-git.ts` (`readFile`, ~lines 129-131); create `server/test/adapters/git-containment.test.ts`
- **Satisfies:** **proposed AC-61 / AC-62** (D-Q3) — no criterion exists in SPEC-01 yet; the text is drafted in *Open questions* for the coordinator to amend in
- **Skills:** `onion-architecture` (this is adapter-ring work, behind an existing port), `typescript-expert`
- **Depends on:** —
- **Done when:** `readFile(repo, '../../../etc/passwd')` throws `ValidationError` and performs no read, `readFile(repo, 'specs/a.md')` still resolves, and the new unit test covers both plus a symlink-shaped case
- **Notes:**
  - Resolve both sides and assert containment before touching the disk: compute the clone root with the existing `clonePathFor(repo)` (already public on the port at `adapters.ts:234`), `resolve()` the joined path, and require that it equals the root or starts with root + `path.sep`. A bare `startsWith(root)` is not enough — `/clones/acme/payments-api-evil` starts with `/clones/acme/payments-api`.
  - Throw `ValidationError` from `platform/errors.ts:25-29`, which maps to **422** with code `validation_error` via the single handler in `app.ts`. Do not build the error envelope by hand.
  - This is the choke point every caller already goes through, which is why it goes here rather than in the new module: it closes both the run-start path (AC-40) and step 10's request-parameter path at once.
  - The guard sits in the adapter, so `container.git` must remain the only way modules reach it — no module may construct `SimpleGitClient` inline.
  - Keep the change inside `readFile`. Do not "harden" `blame`/`log` in the same edit; they take code-produced paths and widening this step widens its blast radius.

### Step 7 — The `project-context` module: constants, types, repository · package: server

- **Files:** create `server/src/modules/project-context/constants.ts`, `types.ts`, `repository.ts`
- **Satisfies:** AC-3, AC-15, AC-30, AC-34
- **Skills:** `onion-architecture` (read first — it decides placement), `drizzle-orm-patterns`
- **Depends on:** Steps 1, 3
- **Done when:** `cd server && pnpm lint:arch` passes with the new folder in place and `pnpm typecheck` is clean
- **Notes:**
  - Named `project-context`, **not** `context`: `modules/_shared/context.ts` (`getContext`) and `db/schema/context.ts` both already exist, and the spec explicitly warns against adding a third same-shaped name.
  - `constants.ts` is **public surface** (importable across modules, per the `no-cross-module-internals` exemption) and holds: `TOKEN_COUNT_JOB_KIND`, `CONTEXT_ROOTS = ['specs','docs','insights'] as const`, `MAX_CONTEXT_DOCUMENTS = 500`, `PROJECT_CONTEXT_TOKEN_BUDGET = 8000`, `MAX_CONTEXT_DOCUMENT_BYTES = 400 * 1024`, `PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS = 5000`, `TOKEN_JOB_BUDGET_MS`. Every one of these is a number an AC or NFR names — keep them here so each is a one-line edit (D-Q6e).
  - `types.ts` is the other public surface and declares the `ProjectContext` facade interface plus `ResolvedContext = { texts: string[]; injected: string[]; skipped: { path: string; reason: 'unread'|'oversize'|'budget' }[] }`. `run-executor.ts` will import from here in step 24; that import is legal precisely because it is `types.ts`.
  - `repository.ts` is **the only file in this module allowed to import `drizzle-orm`** (`no-drizzle-outside-persistence` whitelists `^src/modules/[^/]+/repository\.ts$`). Give it: `tokensForRepo(repoId)` → `Map<path, tokens>` (one query), `agentCountsByPath(workspaceId)` → `Map<path, number>` (one `GROUP BY`, no N+1 — this is AC-15), `lastScanAt(repoId)`, `upsertTokenCount(...)`, and `clonePathFor(repoId)` reading `repos.clone_path`.
  - Every query scopes by `workspace_id` (AC-3, AC-18, AC-20).

### Step 8 — The Markdown walk · package: server

- **Files:** create `server/src/modules/project-context/walk.ts` and `walk.test.ts`
- **Satisfies:** AC-1, AC-2, AC-6; NFR-5
- **Skills:** `onion-architecture`, `typescript-expert`
- **Depends on:** Step 7
- **Done when:** `walk.test.ts` passes over a temp-dir fixture covering: any-depth roots, the leftmost-segment tie-break, a 600-file overflow, a 400 KB file, an unreadable directory, and a symlink
- **Notes:**
  - Templated on `server/src/modules/repo-intel/pipeline/walk.ts` (D-Q6b), which establishes that a module-local walk over `node:fs/promises` is fine — `node:fs` is a core module and is not in `no-vendor-sdks-outside-adapters`'s SDK list.
  - **Three deliberate divergences from the template, each of which will look like a bug to a reviewer who knows it:**
    1. **No size filter.** The template drops files over `MAX_FILE_SIZE` at `:112-115`; NFR-5 requires a 400 KB document to be listed and previewable. Return `size` from `stat()` and let read time enforce the cap.
    2. **Any-depth root matching (D-Q6a).** This is a **full-clone walk** with `EXCLUDED_DIRS` pruning; a file is a candidate iff its extension is `.md` **and** some directory segment of its clone-relative path is in `CONTEXT_ROOTS`. The **leftmost** matching segment supplies AC-2's tag, so `docs/specs/x.md` is tagged `docs`.
    3. **Cap at 500 with the overflow reported, not swallowed.** Sort relpaths alphabetically first so "first N" is reproducible (as the template does at `:61-68`), take the first `MAX_CONTEXT_DOCUMENTS`, and return `{ files, total, omitted }` — AC-6 needs the omitted number, so `total` must be captured before truncation.
  - Reuse `EXCLUDED_DIRS` by importing `repo-intel/constants.ts` — that is legal (`constants.ts` is public surface) and it keeps the two walks agreeing on what is skipped. Note that it prunes `vendor`, so `server/src/vendor/**` and `client/src/vendor/**` documents are out of scope by inheritance.
  - Never follow symlinks (loops, perf) and swallow unreadable directories, as the template does at `:83-89`.
  - **Measured, so nobody discovers it later:** on this repository, any-depth roots with `EXCLUDED_DIRS` applied yield **25** documents — the 500 cap does **not** bite here. Without `EXCLUDED_DIRS` pruning it would be 111. So D-Q6c's declined `.gitignore` support is not currently costly on this repo, but the pruning list is the only thing holding it, and a repository with a committed vendored tree outside those eight directory names will hit the cap. The `pipeline/walk.ts:14-18` `.gitignore` TODO stays unpaid.

### Step 9 — The service: discovery, listing, content · package: server

- **Files:** create `server/src/modules/project-context/service.ts`
- **Satisfies:** AC-1, AC-2, AC-3, AC-4, AC-6, AC-11 (server half), AC-15, AC-16, AC-30, AC-34; NFR-3
- **Skills:** `onion-architecture`, `zod`
- **Depends on:** Steps 7, 8
- **Done when:** `list(workspaceId, repoId)` returns a `ContextDocList` assembled from one walk plus exactly **two** queries, and `readDoc(workspaceId, repoId, path)` returns `ContextDocContent` or throws
- **Notes:**
  - `list()`: resolve the clone root from `repos.clone_path`; if it is null or absent on disk, throw `new AppError('repo_not_cloned', '…', 409)` (AC-4 — the code and status are both specified, and 409 is not one of the existing subclasses' defaults, so construct `AppError` directly). Otherwise walk, then join `tokensForRepo` and `agentCountsByPath` in memory. `scanned_at` = `lastScanAt(repoId)`, nullable.
  - `tokens` is `null` when no cached row exists (AC-34, and see *Decisions taken* on why no per-request hashing).
  - `readDoc()`: enforce `MAX_CONTEXT_DOCUMENT_BYTES` via `stat` before reading, and read through `container.git.readFile` so step 6's guard applies. `NotFoundError` with a `doc_not_found` code for a path that is not in the discovered set — check membership against the walk rather than trusting the parameter, which makes the guard a second line of defence rather than the only one.
  - NFR-3's 800 ms budget is why counts are served from `context_doc_tokens` and never computed here, and why the two lookups are set-based.
  - Business logic lives here, not in the route; no HTTP types below `routes.ts`.

### Step 10 — Routes and module registration · package: server

- **Files:** create `server/src/modules/project-context/routes.ts`; modify `server/src/modules/index.ts` (one import + one registry entry)
- **Satisfies:** AC-3, AC-4, AC-12 (server half); D-Q4's reindex endpoint
- **Skills:** `fastify-best-practices`, `zod`, `onion-architecture`
- **Depends on:** Steps 9, 11
- **Done when:** all three routes respond under `app.inject()` and the module appears in the registry
- **Notes:**
  - `GET /repos/:id/context` → `ContextDocList`; `GET /repos/:id/context/doc` with a `path` querystring → `ContextDocContent`; `POST /repos/:id/context/reindex` → `IndexStatus`, 202, enqueueing `TOKEN_COUNT_JOB_KIND` (D-Q4).
  - Declare `schema: { params, querystring, response }` on each route. `server/insights.md`'s 2026-08-18 entry records that a Zod `response:` schema works and simply had zero adoption — both compilers are installed at `app.ts:64-65`. Use it; it is what makes the envelope's shape enforced at serialization rather than hoped for.
  - `useReindexContext` is typed against the existing `IndexStatus` (`core.ts:162`), so return that shape rather than minting a fourth type — this is the one place reusing an existing contract is right, and it is what makes D-Q4's "the second shipped hook resolves" true.
  - The 202-on-enqueue-failure pattern comes from `repo-intel/routes.ts:45-60` — swallow the enqueue error so the UI can still poll rather than showing an inline failure.
  - Route prefixes are **not** module-owned here: `repo-intel` already serves `/repos/:id/index-state`. That is the precedent that lets this module own all three `/repos/:id/context*` routes and, in step 22, the two attach families.
  - Routes are transport only — parse, map status, delegate. Every handler starts with `await getContext(app.container, req)` for tenancy.

### Step 11 — The token-count job · package: server

- **Files:** modify `server/src/modules/project-context/service.ts` (handler + registration); create `server/src/modules/project-context/token-count.test.ts`; modify `server/src/modules/repos/service.ts` (`runCloneJob`, one enqueue)
- **Satisfies:** AC-36, AC-37, AC-38; NFR-4
- **Skills:** `onion-architecture`, `drizzle-orm-patterns`
- **Depends on:** Steps 7, 8
- **Done when:** the job persists one row per `(repoId, path)` keyed by content hash, a throwing mock tokenizer yields a char-based estimate, and a clipped time budget leaves the remainder uncounted
- **Notes:**
  - Register with `container.jobs.register(TOKEN_COUNT_JOB_KIND, …)` following `repos/service.ts:45-49`. Enqueue-on-clone-complete goes in `runCloneJob` right after `updateClonePath`, in a `try/catch` that swallows, exactly as the existing `INDEX_JOB_KIND` enqueue at `:65-77` does — a clone must not fail because a follow-up job could not be queued. Importing `TOKEN_COUNT_JOB_KIND` from `project-context/constants.ts` is legal cross-module (public surface).
  - Skip a document whose stored `contentHash` matches the freshly-hashed body — that is what `content_hash` is for, and the reason a re-scan is cheap.
  - **AC-37 needs its own try/catch even though it is already true in production.** `TiktokenTokenizer.count` (`adapters/tokenizer/index.ts:30-40`) already catches, sets `broken`, and returns `approxTokens`. So the criterion is a requirement on *this job*: wrap `container.tokenizer.count(text)` and fall back to a character estimate. Reuse the exported `approxTokens` rather than re-deriving `ceil(chars/4)`. Its Verification row says "throwing mock tokenizer", which is the only way to observe it.
  - AC-38: check elapsed time against `TOKEN_JOB_BUDGET_MS` between documents and return early, persisting as you go, so counts computed so far survive. Follow `INDEX_SOFT_BUDGET_MS`'s posture (`repo-intel/constants.ts:46`) of finishing soft, under `JobRunner`'s hard timeout.
  - The BPE rank load is paid **once per process** — `container.ts:152-156` memoises with `??=` and `app.ts:67` builds one `Container` per app — so do not construct a tokenizer here.
  - NFR-4 is **observation-only** (D-NFR4): record MB/min in the timed test and print it, but do not assert a threshold. State in the test's comment that the 10 MB/min figure rests on a single Node 26 measurement over synthetic input, above this repo's Node ≥ 22 floor, with no upstream benchmark behind it.

### Step 12 — Server tests for Cut 1 · package: server

- **Files:** create `server/src/modules/project-context/project-context.test.ts` and `server/test/project-context.it.test.ts`
- **Satisfies:** verification for AC-1–4, 6, 15, 30, 34, 36–38; NFR-3, NFR-4, NFR-5, NFR-10 (partial), NFR-12
- **Skills:** `onion-architecture`, `drizzle-orm-patterns`
- **Depends on:** Steps 6–11
- **Done when:** `cd server && pnpm test` is green and every Cut-1 AC above has a named assertion
- **Notes:**
  - **Suite membership is by filename.** `*.it.test.ts` = DB-backed, needs Docker; anything else must be hermetic. The spec's Verification table already assigns each row, and it is right: AC-1/AC-2/AC-4/AC-6 are `server-unit` over a temp-dir fixture with a mock `GitClient`; AC-3/AC-15/AC-30/AC-34/AC-36 are `server-integration` because they need real persisted rows and a second `workspace_id`.
  - Inject mocks via `ContainerOverrides` (`git`, `tokenizer`) — never construct an adapter inline; that is the whole reason the container exists.
  - NFR-3's timed row needs a seeded 500-document fixture; keep it in the it-test and mark it environment-dependent rather than a hard gate.

### Step 13 — Client hooks and query keys · package: client

- **Files:** create `client/src/lib/hooks/project-context.ts`; modify `client/src/lib/hooks/keys.ts`, `client/src/lib/hooks/index.ts`, `client/src/lib/hooks/core.ts`
- **Satisfies:** — (feeds steps 14–16 and 26–29)
- **Skills:** `react-best-practices`, `frontend-ui-architecture` (**with the SPA caveat in *Constraints***)
- **Depends on:** Step 2
- **Done when:** `cd client && pnpm typecheck` passes and no component anywhere imports `api` directly
- **Notes:**
  - **Move** `useContextFiles` and `useReindexContext` out of `core.ts` into the new file and retype the first from `SpecFile[]` to `ContextDocList` (D-Q1). `client/AGENTS.md` asks for one hook file per domain, and project context is now a domain with ~8 hooks. Update `core.ts`'s header docstring, which currently claims project context as its own, and re-export from `hooks/index.ts` so no consumer's import path breaks.
  - Add `useContextDoc(repoId, path)` for the content route, `enabled` only when a path is selected — that is what makes AC-12 a *separate* request that can fail on its own while the list stays interactive.
  - **Extend `contextKeys` in `keys.ts` (`:58-60`); never inline a `queryKey` literal.** `client/insights.md`'s entry on the key factories is explicit that the prefixes do not nest, so a mutation must invalidate each key it affects by name. A mistyped literal produces a mutation that looks successful while `staleTime: 30_000` and `refetchOnWindowFocus: false` (`providers.tsx:28-29`) keep the stale render on screen — no type error, no runtime error.
  - `lib/api.ts` stays the only place that talks HTTP, and it normalises the envelope into `ApiError`, which the error states in step 14 branch on by `status`.

### Step 14 — The Project Context page · package: client

- **Files:** create `client/src/app/repos/[repoId]/context/page.tsx` and `_components/ProjectContextView/{ProjectContextView.tsx,styles.ts,constants.ts,index.ts}` plus `_components/{DocList,DocRow,DocPreview,ContextFooter}/`; modify `client/messages/en/context.json`
- **Satisfies:** AC-5, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-16
- **Skills:** `react-best-practices`, `next-best-practices`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 13
- **Done when:** the route renders all six states — loading skeleton, error+retry, empty, cloning, populated, preview-error — and no editing affordance exists anywhere on it
- **Notes:**
  - `page.tsx` stays thin and `"use client"`; the view, its styles, constants and i18n colocate under `_components/ProjectContextView/`. Route path `/repos/[repoId]/context` matches `nav.ts`'s `:repoId` template and the existing `conventions` sibling.
  - **AC-5 is a distinct state from AC-8, not a variant of it** (D-5 in the spec). Branch on `ApiError.status === 409` / code `repo_not_cloned` and name the repository in the copy.
  - **`context.json`'s empty-state copy must be reworded** (D-2): it currently tells the user to drop files under `.devdigest/specs/`, which is wrong on every count. AC-8 requires it to name `specs/`, `docs/` and `insights/`. Every string goes through next-intl; no inline literals.
  - AC-13: the row's **accessible name is the full repository-relative path**, unmodified — no transformation, so unicode, emoji and RTL paths pass through as-is. AC-14's head truncation is presentational only (CSS/`direction`-based or a rendered ellipsis) and must not change the accessible name. These two pull in opposite directions and are the most likely thing to get wrong: set `aria-label`/`title` from the raw path and truncate the visible text.
  - AC-16's footer shows the discovered count and `scanned_at`, and **not** a chunk count — `code_chunks` is unwritten and `container.embedder()` throws when embeddings are off (D-6). Handle `scanned_at === null` with a "not scanned yet" string rather than rendering an empty slot.
  - Preview renders through the existing `client/src/vendor/ui/primitives/Markdown.tsx`. **Do not add `rehype-raw`.** The spec verified in the installed package that `react-markdown@9.1.0` strips non-allow-listed protocols at `lib/index.js:113,420-439` *before* the custom `a` override sees the href, and that raw HTML is escaped because `rehype-raw` is absent from the lockfile. That is the control AC-11 relies on; adding `rehype-raw` would silently remove it and would require `rehype-sanitize` alongside.
  - UI comes from `src/vendor/ui` (`Skeleton`, `EmptyState`, `Badge`, `Icon`) — do not hand-roll a primitive the kit has, and do not add a component library.
  - Source-kind chips must meet 4.5:1 in **both** themes (NFR-9) — use existing CSS variables rather than new colour literals.

### Step 15 — Navigation, the `g x` chord, and the `vendor/ui` comment fix · package: client

- **Files:** modify `client/src/vendor/ui/nav.ts`; modify `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx` (comment only); create `client/src/components/app-shell/hooks/useGlobalShortcuts.test.ts`
- **Satisfies:** AC-57, AC-58 (client half)
- **Skills:** `react-best-practices`
- **Depends on:** Step 14 (the route must exist before the sidebar links to it)
- **Done when:** the sidebar renders a `Project Context` row in WORKSPACE, `g` then `x` navigates to `/repos/<activeRepo>/context`, the command palette lists it, and the new unit test proves the chord
- **Notes:**
  - **This edits a file under `client/src/vendor/**`, which `client/AGENTS.md:87` lists as do-not-touch. It is author-signed-off** and the reasoning is load-bearing: `vendor/shared/` is a *mirror* pinned by `check-contracts.sh`, whereas `vendor/ui/` has no upstream anywhere in this repository — nothing syncs it, `client/AGENTS.md:29` calls it "the in-repo design system", and its own README tells you to update the showcase when you change a component. It is authored here.
  - Add to `NAV`'s WORKSPACE group, after `pulls`: `{ key: "context", label: "Project Context", icon: "FileText", href: "/repos/:repoId/context", gKey: "x" }`, and add `{ keys: "g x", label: "Go to Project Context", group: "Navigation" }` to `SHORTCUTS`.
  - **`label` must be byte-identical to `shell.nav.context`**, which `nav.ts:27-29` requires because the sidebar renders the literal while the palette renders the translation. I checked: `client/messages/en/shell.json:20` already holds `"context": "Project Context"`. **So AC-57 needs no new message key** — use exactly that string.
  - `nav.ts:21-25`'s comment says Project Context is withheld "until their routes land". The route lands in step 14; update that comment to stop naming Project Context, and leave the rest of the withheld list intact.
  - One edit yields three surfaces: the sidebar row (`Sidebar.tsx:45`), the `g`-chord (`useGlobalShortcuts.ts:45-47`) and the palette entry (`useShellCommands.ts:21-27`). `resolveHref` fills `:repoId` from `useActiveRepo()`, which is why AC-58's "of the active repository" works with no extra wiring.
  - **REC-6:** `SkillsTab.tsx:31-35` says `IconBtn` "lives in `src/vendor/ui`, which is **mirrored rather than authored here**" — the opposite of what this step relies on. Correct that clause in the same change so the repo stops asserting both.
  - The new `useGlobalShortcuts` test is AC-58's **primary and guaranteed** proof: it is a `keydown` listener, so jsdom can dispatch `g` then `x` and assert `router.push`. Step 32's e2e row is additional and carries an unretired unknown.

### Step 16 — Client tests for Cut 1 · package: client

- **Files:** create `ProjectContextView.test.tsx` and per-component tests under the new `_components/` folders
- **Satisfies:** verification for AC-5, 7–14, 16, 57, 58; NFR-6, NFR-7, NFR-9
- **Skills:** `react-testing-library`
- **Depends on:** Steps 14, 15
- **Done when:** `cd client && pnpm test` is green with one named assertion per AC above
- **Notes:**
  - Assert through the accessibility tree, as the spec's Verification column asks: AC-5, AC-10, AC-27 and AC-35 all say "in the accessibility tree". Query by role and accessible name, not by test id or class.
  - AC-13 asserts the row's accessible name **equals** the full path; AC-14 asserts the basename is present in the *rendered text*. Two different assertions against the same row — write both.
  - NFR-7's focus-indicator row is a computed-style assertion, which jsdom supports only for inline/variable styles; if the indicator comes from a stylesheet, assert the class or the CSS variable rather than a resolved colour, and say so in the test.
  - Mock at the `fetch` boundary. Note for later: the reason the `e2e` suite exists at all is that RTL suites stub `fetch` and therefore cannot see a server-side join go wrong (`09-skills.flow.json`'s rationale) — which is why step 32 is not redundant.

### Step 17 — Cut 1 gate

- **Files:** none
- **Satisfies:** — (gate)
- **Skills:** —
- **Depends on:** Steps 1–16
- **Done when:** every command in *Verification → Cut 1* has been run and passed, and the author has reviewed the shipped read-only surface
- **Notes:** **This is the barrier.** Cut 2's three tables, the resolver, the run path and both attach surfaces are all built on the envelope shape decided in step 1. Do not begin step 18 until this gate is green and reviewed.

---

### CUT 2 — attachment, injection, run-trace visibility

### Step 18 — Contracts: link DTOs, `specs_skipped`, and the AC-53 label · package: shared

- **Files:** modify `server/src/vendor/shared/contracts/project-context.ts` and `contracts/trace.ts`; then `client/src/vendor/shared/**` via `--fix`; modify `client/src/lib/types.ts`, `client/messages/en/runs.json`
- **Satisfies:** AC-53; NFR-12
- **Skills:** `zod`
- **Depends on:** Step 17
- **Done when:** `./scripts/check-contracts.sh` prints OK and **both** packages typecheck
- **Notes:**
  - Add `AgentContextDoc = { agent_id, path, order, doc: ContextDoc.nullish(), inherited_from: z.string().nullish() }` and `SkillContextDoc = { skill_id, path, order, doc: ContextDoc.nullish() }`. Modelled on `AgentSkillDetail` (`knowledge.ts:291-298`), which inlines the linked entity to save an N+1. `doc` is nullish precisely so AC-29's unresolved row has a shape — an attachment can outlive the file it names.
  - Add `specs_skipped: z.array(z.object({ path: z.string(), reason: z.enum(['unread','oversize','budget']) })).nullish()` to `RunTrace` (D-Q5). **`.nullish()` is what keeps every historical trace parsing** — `run_traces.trace` is unvalidated `jsonb` and `getRunTrace` type-asserts rather than parses (`repository.ts:183-185`), so an older document simply lacks the key.
  - Do **not** change `PromptAssembly`: `specs: z.string().nullish()` at `trace.ts:43` already carries the block, and Q-5(a) keeps everything in that one block.
  - AC-53 is a one-key edit: `runs.json:51` `"specs": "Project context (dynamic)"` → `"Project context — attached specs (untrusted)"`.
  - Mirror sync is mandatory and one-directional. This is why contracts are one serialized step and not split.

### Step 19 — Attachment persistence · package: server

- **Files:** modify `server/src/modules/project-context/repository.ts`
- **Satisfies:** AC-18, AC-19, AC-20, AC-21, AC-22
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** Step 18
- **Done when:** attach, detach, reorder and read-back all work under a real Postgres, and a second `workspace_id` sees nothing
- **Notes:**
  - Follow `AgentsRepository.linkSkill` (`modules/agents/repository.ts:230-238`): `onConflictDoUpdate` on the composite PK setting `order` only. Its comment explains why the conflict path deliberately does **not** reset other columns — re-attaching must not silently undo a user's state.
  - Order reads use `orderBy(asc(order))`, as `linkedSkills` does at `:215`. `order` **is** the prompt order; there is no second sort key.
  - Reorder is a bulk set (the client sends the full ordered list), mirroring `useSetAgentSkills` — one transaction, not N round trips.
  - Every query scopes by `workspace_id` (AC-18, AC-20).

### Step 20 — The resolver and the `ProjectContext` facade · package: server

- **Files:** create `server/src/modules/project-context/resolver.ts` and `resolver.test.ts`; modify `service.ts` to implement `ProjectContext`
- **Satisfies:** AC-21, AC-22, AC-39, AC-40, AC-43, AC-45, AC-47, AC-48, AC-49, AC-50; NFR-1, NFR-2
- **Skills:** `onion-architecture`, `typescript-expert`
- **Depends on:** Step 19
- **Done when:** `resolveForAgent(agentId, repoId)` returns `{ texts, injected, skipped }`, **never throws** for any injected failure, and honours both the token budget and the timeout
- **Notes:**
  - **The governing principle, inherited from `buildSkillBlocks` (`run-executor.ts:406-445`): the context layer must never fail a review.** Every failure degrades to a shorter list plus a log line. AC-47 (resolution throws → run with no context) and AC-48 (resolution slow → same) are both satisfied *inside* the facade, so `run-executor` needs no try/catch of its own.
  - AC-21's order: the agent's own attachments first in persisted order, then skill-inherited documents in skill order. Read inheritance via **`container.agentsRepo.linkedSkills(agentId)`** — already public on the container, already ordered by `order`, and already returns both `enabled` flags, so the two switches (`agent_skills.enabled` **and** `skills.enabled`) gate inheritance exactly as `buildSkillBlocks` gates skill bodies. **No new cross-module surface is needed**, which is what keeps `no-cross-module-internals` satisfied.
  - AC-22: dedupe by path, **first occurrence wins**, applied after concatenation so an agent-attached document outranks the same document inherited from a skill.
  - AC-45: stop adding when the next document would exceed `PROJECT_CONTEXT_TOKEN_BUDGET`; every remaining path is recorded with reason `budget`. AC-49: `> MAX_CONTEXT_DOCUMENT_BYTES` → reason `oversize`, checked by `stat` **before** the read. AC-43: read failure → reason `unread`. Note that a single document over budget on its own is excluded and the run still happens.
  - AC-50: return `texts: []` and let step 24 **omit** the `specs` key entirely. An empty array would be behaviourally equivalent today but states the wrong intent, and the byte-identical-prompt equality is what makes a with/without comparison meaningful — `run-executor.ts:271-274` says exactly this about skills.
  - AC-48's timeout wraps the whole resolve-and-read pass (`PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS`), not each read. Race a timer against the pass and discard partial work on expiry.
  - Reads go through `container.git.readFile`, so step 6's containment guard is in force on the run path too (AC-40).
  - **NFR-2 is verified here, not in `reviewer-core`** (my R-10 finding): the budget is enforced in this file, and a `reviewer-core` test can only assemble what it is handed. Time NFR-1 around this function with a temp-dir fixture and a mock `GitClient`, p95 over 20 runs on 20 documents.

### Step 21 — Container wiring · package: server

- **Files:** modify `server/src/platform/container.ts`
- **Satisfies:** AC-39
- **Skills:** `onion-architecture`
- **Depends on:** Step 20
- **Done when:** `container.projectContext` resolves lazily, `ContainerOverrides.projectContext` injects a mock, and `pnpm lint:arch` passes
- **Notes:** copy the `repoIntel` getter verbatim in shape (`:138-142`): check the override first, then `??=` a service constructed from `this`. Add `projectContext?: ProjectContext` to `ContainerOverrides` next to `repoIntel` with the same comment style. The composition root is the only place allowed to know the concrete class; `run-executor` will code against the `types.ts` interface.

### Step 22 — Attachment routes · package: server

- **Files:** modify `server/src/modules/project-context/routes.ts`
- **Satisfies:** AC-18, AC-19, AC-20
- **Skills:** `fastify-best-practices`, `zod`
- **Depends on:** Steps 19, 21
- **Done when:** all six endpoints respond and their `response:` schemas serialize
- **Notes:**
  - `GET/POST/PUT/DELETE /agents/:id/context-docs` and `GET/POST/DELETE /skills/:id/context-docs`. `PUT` carries the full ordered list for AC-19's reorder.
  - These live in **this** module, not in `agents`/`skills`, even though `/agents/:id/skills` sets the opposite precedent (`agents/routes.ts:173-231`). Putting them in `agents` would force either a second repository over these tables or a container reach-around, and `repo-intel` already proves prefixes are not module-owned. This is the OQ-5 seam decision made concrete.
  - `LinkParams`-style params from `modules/_shared/schemas.ts` where they fit; a path is a string, not an id, so `DELETE` takes it in the body or a querystring rather than a path segment — a `/` inside a document path cannot ride in a single path parameter.
  - Throw `AppError` subclasses; never hand-build the error envelope.

### Step 23 — `reviewer-core`: the path in the fence label · package: reviewer-core

- **Files:** modify `reviewer-core/src/prompt.ts` (one line, ~`:160-163`); modify `reviewer-core/test/prompt.test.ts`
- **Satisfies:** AC-42, AC-50, AC-59, AC-60
- **Skills:** `typescript-expert`
- **Depends on:** Step 18
- **Done when:** `cd reviewer-core && npm run typecheck && npm test` is green and the assembled section shows `<untrusted source="specs/…">`
- **Notes:**
  - **This package's `specs` slot is otherwise complete.** `prompt.ts:220` emits `## Project context`, `:159-163` omits the section for an empty array, `:43` already replaces the literal `</untrusted>` with `<\/untrusted>` before wrapping, and `test/prompt.test.ts:129` already passes `specs: ['SECRET-SPEC']`. So AC-42, AC-50 and AC-59 need **tests only**.
  - The **one** production change is D-Q6d: change `parts.specs.map((s, i) => wrapUntrusted(`spec-${i}`, s))` so the label is the document's path. Since the engine's inputs are "resolved strings, not identifiers" by contract, the caller must supply the labels — widen the slot to accept `string[] | {path,text}[]`, or add a parallel `specPaths?: string[]`. **Prefer the tagged-object form**: a parallel array can silently desynchronise, and the whole point of AC-60 is that the prompt text and `specs_read` agree.
  - `npm ci` here, **not pnpm** — this package has a `package-lock.json`, and an empty `reviewer-core/node_modules` surfaces as `ERR_MODULE_NOT_FOUND` from *server*, because the API imports this package's raw source at runtime.
  - **Purity is the contract:** no fs, no env, no lookups. The path is a label handed in from outside; do not derive it from anything.
  - Keep the slot's position between `## Repo skeleton` and `## Callers of changed symbols`. `prompt.ts:60-64` records why ("so the model sees structure first"), and the mock's differing row order is an accepted inaccuracy (D-19).
  - AC-60's Verification is "the `source` attribute on each wrapped block" — assert the attribute's value is the path, and add a case where the body contains `</untrusted>` (AC-59) and one asserting byte-identity with the no-specs baseline (AC-50).

### Step 24 — `run-executor` wiring · package: server

- **Files:** modify `server/src/modules/reviews/run-executor.ts`
- **Satisfies:** AC-41, AC-43, AC-44, AC-46, AC-47, AC-50, AC-51; NFR-10
- **Skills:** `onion-architecture`, `fastify-best-practices` (for the log/SSE conventions)
- **Depends on:** Steps 21, 23
- **Done when:** a run with attachments passes `specs` to `reviewPullRequest`, `specs_read` lists the injected paths, `specs_skipped` lists the rest with reasons, and a resolver failure still produces a completed run with no `specs` key
- **Notes:**
  - **This is the wiring the whole spec is built on, and it is small.** Add one resolve call in `runOneAgent` beside `buildSkillBlocks` (`:257`), spread `...(resolved.texts.length > 0 ? { specs: resolved.texts } : {})` into the `reviewPullRequest` call following the exact idiom already used for `skills`, `repoMap`, `callers` and `intent` at `:263-284`, and replace the two hardcoded `specs_read: []` at **`:370`** and **`:566`** (the spec cites `:369`/`:564`; the current lines are 370 and 566).
  - Import the facade's interface from `modules/project-context/types.ts` — legal because `types.ts` is public surface — and resolve the instance from `container.projectContext`, never by constructing it.
  - AC-44 and AC-46: one Live Log line per skipped or excluded document, via `runLog.info`, under the run's existing `correlationId` (`:74-78`). Model the wording on `buildSkillBlocks`'s "Skills disabled, not in prompt: …" (`:439-442`) — the log line is the **only** thing that distinguishes a block missing because the user detached it from one missing because the wiring broke.
  - **NFR-10 is guaranteed by construction, not by redaction.** `PromptSectionMetric` (`reviewer-core/src/prompt.ts:98-121`) has no field that can hold text, and its comment says "Do not add a `text`/`preview`/`sample` field here." Do not put a document body into any log call, and do not extend that type.
  - `traceFromBuffer` (`:540-570`) is the failure/cancel path and also hardcodes `specs_read: []`. Set `specs_skipped: null` there rather than inventing values — a failed run legitimately read nothing.
  - Do not reorder the writes: the run is marked terminal before the trace is persisted, deliberately, because SSE and the timeline depend on terminal status.
  - `container.repoIntel`'s degrade-to-empty posture is the model here: empty means "no enrichment", never an error.

### Step 25 — Server tests for Cut 2 · package: server

- **Files:** extend `server/test/project-context.it.test.ts`; create unit specs for the resolver and the executor wiring; extend `server/test/reviews.it.test.ts`
- **Satisfies:** verification for AC-18–22, 39–51; NFR-1, NFR-10
- **Skills:** `drizzle-orm-patterns`, `onion-architecture`
- **Depends on:** Steps 19–24
- **Done when:** `cd server && pnpm test` is green
- **Notes:**
  - **AC-51 must `await waitForTrace(db, runId)` after `waitForPrRuns`.** `server/insights.md:207-233` documents this precisely: the executor marks a run terminal *before* persisting the trace, so polling on run status alone races a ~45-line window and reads a 404 — a failure that passes alone and fails only under the full suite. `waitForPrRuns` also *returns* on timeout rather than throwing, so an unfinished run degrades into the same confusing assertion. Do not "fix" this by reordering the executor's writes.
  - AC-47 uses a throwing mock facade; AC-48 uses a hanging one. Both assert the run **completes** with `specs` absent — the assertion is on survival, not on an error.
  - AC-39's Verification is the resolver call's arguments against a mock repository; AC-40's is `GitClient.readFile`'s call arguments. Both are `server-unit` with `ContainerOverrides`.
  - Anything needing a real row or a second `workspace_id` belongs in `*.it.test.ts`; everything else must be hermetic.

### Step 26 — Client attachment hooks · package: client

- **Files:** modify `client/src/lib/hooks/project-context.ts`, `client/src/lib/hooks/keys.ts`
- **Satisfies:** — (feeds steps 27, 28)
- **Skills:** `react-best-practices`
- **Depends on:** Step 18
- **Done when:** `cd client && pnpm typecheck` passes and each mutation invalidates every key it affects
- **Notes:**
  - Add `useAgentContextDocs`, `useSetAgentContextDocs`, `useAttachContextDoc`, `useDetachContextDoc`, and the skill equivalents. Add key factories for both; **no inline `queryKey` literals**.
  - AC-26's rollback is an optimistic `onMutate` + `onError` restore. Copy `useUpdateAgent`/`useDeleteAgent` (`lib/hooks/agents.ts:66-79`), which invalidate the list **and** seed/remove the detail — `client/insights.md` is explicit that the key prefixes do not nest, so both must be touched by name.
  - AC-25 needs per-row in-flight state, so the mutation must be keyed by row (a per-row `useMutation` or a tracked pending path set) rather than one shared `isPending` that would disable every row at once.
  - Body-less POSTs must not send a JSON content-type — `apiFetch` already handles it (`lib/api.ts:26`); don't add the header.

### Step 27 — The agent Context tab · package: client

- **Files:** create `client/src/app/agents/[id]/_components/AgentEditor/_components/ContextTab/{ContextTab.tsx,helpers.ts,styles.ts,index.ts}`; modify `AgentEditor/constants.ts`, `AgentEditor/AgentEditor.tsx`, `client/messages/en/agents.json`
- **Satisfies:** AC-17, AC-23, AC-24, AC-25, AC-26, AC-27, AC-28, AC-29, AC-31, AC-32, AC-33, AC-35; NFR-6 (partial — see below), NFR-7, NFR-8, NFR-9
- **Skills:** `react-best-practices`, `react-testing-library`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 26
- **Done when:** the tab lists every discovered document with its attachment state, labels inherited rows with their skill, filters, reorders, and shows per-row and footer token counts
- **Notes:**
  - **Add exactly one tab** (D-15): one entry in `TABS` (`constants.ts:11-14`) and one key `editor.tabs.context` in `agents.json`. `TAB_KEYS` is derived from `TABS`, so the `?tab=` whitelist follows automatically — that is why the array is the only edit. Note that `agents.json:46-51` **already** carries `evals`/`stats`/`ci` keys with no tabs behind them; do not add tabs for them (Non-goal).
  - **The repo comes from `useActiveRepo()`** (D-Q6f). Record in a comment the consequence the spec leaves unstated: `agent_context_docs` stores a bare repo-agnostic `path`, so an attachment made while viewing repo A is resolved at run time against whatever repo the PR belongs to. That is also exactly why AC-29 exists.
  - AC-23: label each inherited row with the originating skill's name from `inherited_from`. AC-29: an attached path that is no longer discovered renders **as an unresolved row**, not omitted — the user must be able to see and remove it.
  - AC-33: the footer total turns the error colour past `PROJECT_CONTEXT_TOKEN_BUDGET`. Keep the threshold as one named constant on the client too, and meet 4.5:1 in both themes for the over-budget colour (NFR-9).
  - AC-35: a `null` token count renders a pending indicator **in the accessibility tree**, not a dash in a `<span>` with no accessible text.
  - AC-27's empty state links to the Project Context page — use `resolveHref` so the `:repoId` template is filled the same way the sidebar fills it.
  - **NFR-6 cannot be fully satisfied here and that is the author's accepted call.** UX-2 (arrow reorder) was offered twice and declined twice, so the drag handles stand as drawn — and the spec's own UX-2 text says a drag-only reorder fails WCAG 2.2 SC 2.1.1, which NFR-6 requires. Implement the attach, filter and detach controls as fully keyboard-operable, implement the reorder as designed, and **leave a comment at the reorder control naming the conflict and pointing at UX-2**. Do not quietly add arrow buttons to "fix" it; do not quietly drop the keyboard requirement elsewhere. See *Constraints & invariants*.
  - `SkillsTab.tsx` is the closest working template for a three-action attach list (attach / state / reorder) and its `ReorderButton` shows how a genuinely-disabled row-local button is built without forking the kit.
  - Feature components colocate under the route that owns them; promote to `src/components/` only on a second consumer — the shared token-count cell used by steps 27 and 28 is the one candidate, and two consumers is exactly the bar, so promoting it is correct.

### Step 28 — The skill editor's Context surface · package: client

- **Files:** modify `client/src/app/skills/_components/SkillsListView/_components/SkillEditorModal/SkillEditorModal.tsx`; modify `client/messages/en/skills.json`
- **Satisfies:** AC-20 (UI), AC-31, AC-32
- **Skills:** `react-best-practices`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 26
- **Done when:** a skill's documents can be attached and detached from the modal, with per-row and footer token counts
- **Notes:** the surface is added to the **modal as it exists today**. The full-page tabbed skill editor with `Preview`/`Evals`/`Stats`/`Versions` drawn in `03-skill-context-tab.png` is an explicit Non-goal (D-18) — do not route the modal. The mock's `SERIALIZES AS` panel is also **wrong as drawn** (D-17): it shows `## Project specifications` and a bare path list, whereas the engine emits `## Project context` with full bodies. If a preview of the serialized form is built at all, it shows the real heading and a body excerpt.

### Step 29 — Trace drawer: the label and the block · package: client

- **Files:** modify/extend tests for `client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/_components/TraceBody/`
- **Satisfies:** AC-52, AC-53, AC-55
- **Skills:** `react-testing-library`, `react-best-practices`
- **Depends on:** Step 18
- **Done when:** the project-context block renders for a non-null trace, is absent for a null one, carries the new label, and *Specs read* lists the injected paths
- **Notes:**
  - **Almost nothing to build.** `TraceBody.tsx:90-92` already renders the block conditionally (AC-52 — keep the conditional, per D-21; a run with no attachments legitimately has none), and `:39-51` already renders *Specs read* with a `none` fallback (AC-55). AC-53 is the `runs.json` edit made in step 18. This step is therefore mostly the tests that pin all three.
  - **Row order will not match the mock and that is intended** (D-19): the engine emits `## Repo skeleton` before `## Project context` for the reason at `prompt.ts:60-64`, and `TraceBody` renders in engine order.
  - `specs_skipped` is persisted by step 24 and **not rendered** — no AC requires it. Listed as a follow-up rather than built, so nobody assumes the UI shows it.

### Step 30 — Seed fixture: one run, one trace · package: server

- **Files:** create `server/src/db/seed-context.ts`; modify `server/src/db/seed.ts` (one call, beside `seedConventions`)
- **Satisfies:** AC-56
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Steps 18, 24
- **Done when:** `pnpm db:seed` is idempotent and the seeded trace's `prompt_assembly.specs` is non-null and `specs_read` is non-empty
- **Notes:**
  - **This fixture is what makes the run drawer reachable at all.** `seed.ts` never inserts into `agent_runs` or `run_traces`; the sample review is written straight to `t.reviews` with `runId` unset (`:155-168`), `RunSummary` comes only from `agent_runs`, so the trace button never renders and the `?trace=` param that mounts the drawer (`page.tsx:94,258-264`) is never set.
  - The fixture is cheap: `run_traces.trace` is unvalidated `jsonb` (`schema/runs.ts:48-54`) and `getRunTrace` type-asserts rather than parses, so a known `prompt_assembly.specs` needs no LLM call. **Insert the `agent_runs` row first** — `run_traces.run_id` is an FK to it.
  - **Set the existing seeded review's `run_id` to the new run.** `page.tsx:262-263` resolves the drawer's findings and agent name via `runs.find(r => r.run_id === traceRunId)` over *reviews*, so without the link the drawer opens with zero findings and a null agent name.
  - **Regression check, and it is narrower than it looks — I verified it.** The "Review runs" accordions come from `reviews`, not `agent_runs` (`FindingsTab.tsx:114,163-168`), so a new run row lands in the *Timeline* only and **cannot** steal `defaultOpen={i === 0}` from flow `04`'s seeded FindingCard. Still re-run flows `04` and `08` after this step, since both assert on that screen.
  - Follow the sibling-seed pattern (`seed-skills.ts`, `seed-conventions.ts`) — a separate file plus one call, not inline growth of `seed.ts`.
  - Give the trace a distinctive phrase inside the project-context block; step 32 asserts on it.

### Step 31 — Client tests for Cut 2 · package: client

- **Files:** create `ContextTab.test.tsx`; extend `SkillEditorModal.test.tsx` and the trace-drawer tests
- **Satisfies:** verification for AC-17, 23–29, 31–33, 35, 52, 53, 55; NFR-6–9
- **Skills:** `react-testing-library`
- **Depends on:** Steps 27–29
- **Done when:** `cd client && pnpm test` is green
- **Notes:**
  - **AC-54's `client` half lives here** (D-OQ7): a test that activates `PromptBlock`'s literal expand control (`PromptBlock.tsx:35`) and asserts the full injected text renders. This is the strict reading of "the block's expand control", and it is the coverage that does not depend on step 32's unknowns.
  - AC-25 asserts the control's `disabled` state *during* the mutation — hold the promise open rather than awaiting it.
  - AC-26 asserts the row's state after a rejected mutation, which is the rollback, not the error toast.
  - NFR-8 (SC 4.1.3) asserts the status message appears **without a focus move** — assert `document.activeElement` is unchanged.

### Step 32 — e2e flow · package: e2e

- **Files:** create `e2e/specs/11-project-context.flow.json`; modify `e2e/README.md`'s coverage table
- **Satisfies:** AC-54, AC-58
- **Skills:** —
- **Depends on:** Steps 30, 31
- **Done when:** `./scripts/e2e.sh` passes with the new flow, **or** the documented fallback has been taken and recorded
- **Notes:**
  - **AC-54, per D-OQ7.** Drive: `find text "Prompt assembly" click` (`TraceSection`'s head is role-less at `TraceSection.tsx:25` but carries that text, and `find text … click` is a committed locator in flows `04` and `09`) → `find role button click --name <fullscreen label>` (`PromptBlock.tsx:51-62` ships `<button type="button" aria-label={t("trace.prompt.fullscreen")}>`, which opens a `Modal` rendering `PromptModalBody text={text}` at `:73-86` — the block's **full injected text**) → `wait --text "<the distinctive phrase from step 30>"`.
  - **Honest caveat to keep in the flow's `description`:** AC-54 says "the block's **expand** control", and fullscreen is a *different* control reaching the same observation. Its Verification row — "the injected text is on the page after expanding" — is satisfied either way, and step 31 covers the literal expand control. The reason for routing around it: `PromptBlock`'s own expand target is role-less, and the only committed in-place-reveal precedent (`09-skills.flow.json:10`) targets `SkillCard`, which **does** carry `role="button"` (`SkillCard.tsx:25-35`) — I verified this, so the spec's claim is right and there is still no precedent for driving a genuinely role-less in-place reveal.
  - **Fallback, named now so it is not a mid-build surprise:** if `find text "Prompt assembly" click` proves undrivable on first contact, AC-54 drops to `client` exactly as OQ-7 permits, step 31's test becomes its sole coverage, and AC-56's fixture still earns its place by making the drawer reachable at all.
  - **AC-58 carries an unretired unknown of the same shape.** The `g x` chord needs a key-press primitive, and **no committed flow presses a key** — the ten existing flows use only `open`, `wait --url/--text/--load` and `find role|text|label … click`. I could not establish `agent-browser`'s key-press CLI surface without web access; it is tagged for `researcher` in *Open questions*. Step 15's `useGlobalShortcuts` unit test is AC-58's **primary** proof. If no key primitive exists, assert the sidebar row instead (`find text "Project Context" click` → `wait --url "/context"`), which still covers AC-57's route landing, and record the substitution in the flow's `description`.
  - **`wait --text` compares RENDERED text.** `09`'s description records losing time to an `uppercase` heading matching only in caps — check the computed text-transform of anything you assert on.
  - **Q6g bites here:** the seeded demo repo has `clonePath: null` (`seed.ts:98-102`), so `/repos/:repoId/context` renders AC-5's cloning state in the hermetic stack. Do not write a flow that expects a document list; that is the accepted gap, not a bug.
  - `npm install` here, not pnpm, and the CLI is a prerequisite (`npx agent-browser install`). Flows share one browser session in order — leave the app on a neutral route.

### Step 33 — Cut 2 gate

- **Files:** none
- **Satisfies:** — (gate)
- **Skills:** —
- **Depends on:** Steps 18–32
- **Done when:** every command in *Verification → Cut 2 and full-repo* has passed
- **Notes:** the follow-ups in *Out of scope* are not part of this gate but should be scheduled before the PR.

---

## Verification

### Cut 1 (after step 16, gating step 17)

```sh
./scripts/check-contracts.sh                                   # steps 1-2: the mirror matches
cd server && pnpm typecheck                                    # contracts + schema + module compile
cd server && pnpm lint:arch                                    # the Onion rule: no crossed boundary
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'  # hermetic: walk, service, token job, guard
cd server && pnpm exec vitest run .it.test                     # DB-backed: tenancy, counts, cache rows
cd client && pnpm typecheck                                    # the retyped hook + the new route
cd client && pnpm test                                         # the page's six states, nav, the g-chord
```

What each proves: `check-contracts.sh` proves the canonical copy and the mirror agree — the only thing that catches a client typed against a wire format the server does not serve. `lint:arch` proves the new module did not import another module's internals, that drizzle stayed in `repository.ts`, and that no SDK escaped `adapters/`; it **fails the build**, so it is not a review opinion. The unit run proves the walk, the budget and the guard without Docker. The it-run proves `workspace_id` scoping and AC-15's count against real rows.

### Cut 2 and full-repo (after step 32, gating step 33)

```sh
./scripts/check-contracts.sh                                   # step 18's link DTOs + specs_skipped
cd server && pnpm typecheck && pnpm lint:arch && pnpm test     # both suites
cd reviewer-core && npm ci && npm run typecheck && npm test    # the fence label + the four engine ACs
cd client && pnpm typecheck && pnpm test
cd server && pnpm db:migrate && pnpm db:seed                   # the seed fixture is idempotent
./scripts/e2e.sh                                               # hermetic: AC-54, AC-58 (see step 32)
```

`reviewer-core` uses **npm**, not pnpm, and it must have `node_modules` or the *server* fails to boot with `ERR_MODULE_NOT_FOUND` — the API imports its raw source at runtime.

### What is deliberately not run, and why

- **NFR-11** — "manual, once". No harness exists to confirm provider-side receipt of document bodies, and the spec says so. Nobody should read a green suite as covering it.
- **NFR-4** — timed and **printed, not asserted** (D-NFR4). The 10 MB/min figure rests on one Node 26 measurement over synthetic input, above this repo's Node ≥ 22 floor, with no upstream benchmark behind it. A threshold here would be a gate on a number nobody has verified on the supported runtime.
- **NFR-6, partially** — satisfied for every control except the reorder handles. See *Constraints & invariants*; this is an accepted conflict, not an untested requirement.
- **AC-1, AC-8, AC-11 in a seeded stack** — proven only by `server-unit` temp-dir fixtures and `client` RTL mocks. **No dev or hermetic-e2e route exercises a populated document list**, because the demo repo has `clonePath: null` and D-Q6g accepted that gap rather than fixing it. This is the single largest hole in the verification story and it is deliberate.
- **`pnpm exec vitest run .it.test` and `./scripts/e2e.sh`** both need Docker and are environment-dependent, not unconditional gates.

---

## Constraints & invariants

A reviewer should check this plan and its output against these specifically.

1. **`server/src/vendor/shared/` is canonical; `client/src/vendor/shared/` is a hand-synced mirror.** Every contract change is two files, synced one-directionally with `--fix`, and `check-contracts.sh` (CI: `contracts.yml`) fails on drift. Both packages typecheck against their own copy, so nothing else catches it.
2. **The Onion dependency rule is lint-enforced.** `routes.ts` → `service.ts` → `repository.ts`, one direction. `drizzle-orm` only in `repository.ts`. Third-party I/O SDKs only in `adapters/`. `no-cross-module-internals` means a module's public surface is its `constants.ts` and `types.ts` and nothing else — which is why the seam is `container.projectContext` and why inheritance goes through `container.agentsRepo`.
3. **Migrations are generated, never hand-edited, and never run on boot.** `db:generate` then `db:migrate`, as two steps.
4. **Every domain table carries `workspace_id` and every query scopes by it** — even though `agent_skills`, the table these three copy, does not.
5. **Schema and contracts exist ahead of features here.** ~35 tables have no module behind them. Do not "clean up" the schema or the contract barrel, and do not touch `code_chunks` — chunking is a Non-goal and it stays unwritten.
6. **The studio is a client-rendered SPA on an App Router shell, deliberately.** No `'use server'`, no Server Actions, no DAL, no server-side fetching. Every screen needs a real loading and `ApiError` state. **`frontend-ui-architecture` assumes an RSC-first app and this studio is not one** — take its folder-structure, feature-boundary and decomposition guidance and **ignore its RSC-boundary, Server-Actions and Data-Access-Layer sections**. `client/AGENTS.md:50-61` wins.
7. **Never `fetch` in a component**; `lib/api.ts` is the only HTTP surface. **Cache keys come from `lib/hooks/keys.ts`** — an inline literal produces a mutation that looks successful while the UI shows stale data, with no type or runtime error.
8. **The context layer must never fail a review.** AC-47 and AC-48 are absolute; failing a run over the grounding layer is worse than reviewing without it.
9. **A document body must never inherit a skill's trusted treatment.** Skill bodies enter the prompt un-fenced as instructions, on purpose (`modules/_shared/skills.ts:38-57`). A document *inherited from* a skill is still repository content and is still fenced, in the same single `## Project context` block, so there is one trust story and no second path. **This is not negotiable by the attachment surface.**
10. **No document body reaches a log line.** `PromptSectionMetric` has no field that can hold text and this build adds none.
11. **`client/src/vendor/ui/nav.ts` is edited under an explicit author sign-off**, against `client/AGENTS.md:87`'s do-not-touch line. The distinction that licenses it: `vendor/shared/` is a pinned mirror, `vendor/ui/` has no upstream in this repository and is authored here. Step 15 also corrects `SkillsTab.tsx`'s contradicting comment so the exception does not get reverted by the next reader.
12. **ACCEPTED CONFLICT — NFR-6 versus the reorder control.** REC-5/UX-2 (arrow reorder) was offered twice and declined twice; the drag handles stand as drawn. The spec's own UX-2 text states that a drag-only reorder fails WCAG 2.2 SC 2.1.1, which NFR-6 requires of "every reorder control". **NFR-6 therefore cannot be satisfied for AC-19's reorder as designed.** This is the author's call, recorded here so it is visible in review, and step 27 leaves a comment at the control. It is not a defect for `implementer` to fix quietly, and it is not a requirement to silently drop.
13. **ACCEPTED GAP — the demo has no clone** (D-Q6g). AC-1, AC-8 and AC-11 have no seeded or e2e route; the Project Context page shows AC-5's cloning state in every seeded stack.
14. **Do-not-touch:** `server/clones/**` (gitignored scratch that currently holds a stale full copy of this repository — never read, edit or search it), `server/src/db/migrations/**` (generate, don't edit), `client/src/vendor/shared/**` (mirror — change the source), locked skills under `.claude/skills/**`, and anything generated.
15. **Two package managers on purpose:** pnpm in `server`/`client`, npm in `reviewer-core`/`mcp`/`e2e`. Never `pnpm add` one local package into another — cross-package code is shared as TypeScript source through tsconfig path aliases, with no build or publish step.
16. **No new native dependency is planned.** If one becomes necessary it needs an `allowBuilds:` entry in that package's `pnpm-workspace.yaml`; a placeholder counts as unapproved and install fails.

---

## Open questions

Decisions deferred, plus the assumptions I proceeded on.

- **OQ-A · The `insights` source tag, given that `insights/` is not a directory in this repository.** *My decision, taken and stated as the coordinator asked:* keep `insights` as a configured **directory** root matched at any depth (`CONTEXT_ROOTS`). I measured it — there are **zero** directories named `insights` in this repository, so on this repo the tag matches nothing. That is a root matching nothing *here*, **not** a tag that can never match anywhere: a user repository with an `insights/` directory is the case the spec was written for, and AC-8 still requires the empty state to name all three roots. I deliberately did **not** extend the walk to bare `insights.md` files at package roots, because AC-1 says "under `insights/`" and a filename rule would be me authoring a requirement. *Assumption:* the above. *If the author wants package-root `insights.md` files discovered*, that is a spec amendment adding a filename rule to AC-1, and it changes step 8's predicate — not something to slip in during the build.
- **OQ-B · AC-34's wording versus its implementation.** AC-34 says "WHEN a document's content **hash** has no persisted token count". Implemented as "no cached **row** for this path", because hashing up to 500 files of up to 400 KB per request would break NFR-3 outright, and `content_hash` is the *job's* mechanism for skipping recomputation, which is the role the spec's own *Schema impact* note 1 gives it. *Consequence:* a token count can be stale between reindexes. *Assumption:* the reading above; worth one word in the amendment.
- **OQ-C · `agent-browser`'s key-press CLI surface — tagged for `researcher`.** AC-58's e2e row needs a key primitive and no committed flow presses a key. I have no web access and upstream CLI questions are `researcher`'s job, so I did not guess a command name. *Assumption:* step 15's `useGlobalShortcuts` unit test is AC-58's primary proof and the e2e row is best-effort with the documented substitution. A one-question `researcher` commission ("does `agent-browser` expose a key/press command, and at what version?") retires this cheaply, and it is also worth knowing that `agent-browser` is installed **unversioned** in CI (`.github/workflows/e2e-web.yml:113`).
- **OQ-D · `specs_skipped` is persisted and never rendered.** No AC asks the studio to show it, so step 29 does not. *Assumption:* that is intended — AC-44/AC-46's Live Log lines are the user-facing surface and `specs_skipped` is the durable record. A follow-up row in the trace drawer would be cheap if the author wants it.
- **OQ-E · Proposed criterion text for D-Q3, for the coordinator to amend into SPEC-01.** I am supplying wording because it was asked for; it is not a criterion this plan authors:
  - **AC-61** — WHEN the server reads a document from a repository's clone, it shall resolve the joined path and assert that it is contained within that repository's clone directory before reading.
  - **AC-62** — IF a requested document path resolves outside the repository's clone directory, THEN the server shall reject the read with a `validation_error` and shall not read the file.
  - Suggested *Verification* rows: AC-61 → `server-unit`, the resolved path asserted on a mock; AC-62 → `server-unit`, the thrown error's code and the absence of any fs read.
- **OQ-F · The spec's line-number citations drift in three places** I hit while verifying: `specs_read: []` is at `run-executor.ts:370` and `:566` (spec says `:369`, `:564`); the trace-drawer components live under `client/src/app/repos/[repoId]/pulls/[number]/...` (the spec omits the `repos/[repoId]/` prefix); and `client/insights.md:87` locates the two unserved hooks at `core.ts:123-138` where they are now at `:150-165`. All three are cosmetic — the substance checked out in every case — but a plan-verifier reading the spec's paths literally will not find two of them.

---

## Out of scope / follow-ups

- **Amend SPEC-01** to match *Decisions taken*, before anyone verifies the build against it. The sections needing edits, so nobody re-derives them: *Contract impact* (the `SpecFile` bullet, the `specs_read` claim), *Schema impact* (note 2's repo-agnostic-path consequence, the `agent_skills`-tenancy divergence), *Module interactions → Callers and callees* (the `/context/doc` and `/context/reindex` rows), *Acceptance criteria* (AC-1, AC-2, AC-43, AC-49, plus the two new traversal criteria and one for the reindex endpoint), *Untrusted inputs → Path traversal*, *Non-functional requirements* (NFR-4 as observation, NFR-12's additive claim, NFR-2's suite), *Verification* (the new rows and NFR-2's move to `server-unit`), and *Open questions* (OQ-1 through OQ-8 all resolved).
- **`architecture-reviewer`** over the new module, the container seam and the `run-executor` edit — the seam is the highest-value thing to have a second opinion on.
- **`api-breaking-changes`, `api-response-changes` / `response-schema`, `security`** — **these are not `implementer`'s skills** and did not run as part of this build. All three are directly relevant: two new endpoints plus six attach endpoints, one new `RunTrace` field, one retyped hook generic, and a new file-read primitive. Route them to the review agents so nobody assumes a green test suite covered them.
- **`pr-self-review`** before `gh pr create`.
- **Whether SPEC-01 moves to `implemented`** — the author's call, after step 33 and the amendments.
- **`plan-verifier`** against this file once the build lands. `Partial success` is not `delivered`; the plan stays `approved` until the gaps close.
- **`/engineering-insights`** afterwards — warranted here. Candidate entries: the `specs`-slot-complete-but-never-fed pattern and how long it took to establish; the `SpecFile[]`-cannot-carry-an-envelope trap and the more general lesson that a shipped-but-404ing hook constrains a contract nobody has designed yet; the `find text` versus role-less-div question in `agent-browser`; and the any-depth-roots measurement (25 documents with `EXCLUDED_DIRS`, 111 without).
- **Deferred by decision, listed so they are not lost:** `.gitignore` support in both walks (`pipeline/walk.ts:14-18`'s TODO, declined as REC-4); UX-2's arrow reorder and the NFR-6 conflict it would close; UX-3's safety comment in `Markdown.tsx`; reading documents at the PR head rather than the default branch, which would need a new `GitClient` port method taking a ref; rendering `specs_skipped` in the drawer; and a seeded clone for the demo repo.

---

## Amendments

### 2026-08-27 — step 24 and OQ-F: the `specs_read: []` line numbers were wrong in this plan, not in the spec

`OQ-F` claimed SPEC-01's citation had drifted and that the hardcoded
`specs_read: []` assignments were at `run-executor.ts:370` and `:566`. Step 24
repeated that claim in bold and told `implementer` the spec was wrong.

Verified against a clean working tree:

```
$ grep -n 'specs_read' server/src/modules/reviews/run-executor.ts
369:        specs_read: [],
568:      specs_read: [],
```

**The lines are `:369` and `:568`, and SPEC-01's own citation of `:369` was
correct all along.** `OQ-F` also misquoted the spec as citing `:564`; it never
did. `spec-creator` refused to introduce the drift when asked to "fix" it and
grepped the file instead — the right call, and the reason this amendment exists.

- **Step 24:** ignore the parenthetical about the spec being wrong. The two
  assignments to replace are at **`:369`** and **`:568`**. Everything else in that
  step — the resolve call beside `buildSkillBlocks`, the spread idiom, the
  `traceFromBuffer` path — is unaffected.
- **`OQ-F`:** its first of three bullets is withdrawn. The other two stand and
  were both applied to SPEC-01 in the sync pass: the trace-drawer folder prefix,
  and `client/insights.md`'s own stale line numbers for the two unserved hooks
  (`core.ts:123-138` → `:150-165`).

Approved by the author.

### 2026-08-27 — SPEC-01 synced to `## Decisions taken`; three criteria added

The spec was amended before the build, at the author's direction, so that the
nine sections this plan superseded no longer disagree with it. SPEC-01 is now
1161 lines with **63** acceptance criteria and a 63-row Verification table.

Consequences for this plan:

- **Step 6** no longer delivers "proposed AC-61/AC-62". Those criteria now exist
  in SPEC-01 verbatim as drafted in `OQ-E`, under *Trust boundaries*.
  Verification: AC-61 → `server-unit` (the resolved path asserted on a mock),
  AC-62 → `server-unit` (the thrown error's code and the absence of any fs read).
- **New AC-63** — *WHEN the studio requests a reindex of a repository's project
  context, the API shall respond `202` having enqueued the token-count job,
  without waiting for that job to finish.* It is delivered by **step 10**, which
  already builds that route, and verified in `server-integration` rather than
  `server-unit`: the falsifiable part is that a job row exists and the response
  returned before it ran, which a mocked `container.jobs` cannot show. That is
  the suite step 10 already names.
- **`OQ-E` is discharged** — the wording it drafted is now a requirement, not a
  proposal.
- The two enqueue-failure hops still have no criterion, deliberately: the
  behaviour is *swallow and respond anyway*, so nothing observable differs
  between success and failure and there is nothing a criterion could falsify.
  Recorded in the spec's *Failure modes* table instead.

No step is voided and no step's file list changes.

Approved by the author.

### 2026-08-27 — S4/S5 review round on Cut 1: three step corrections and one new requirement

`plan-verifier` returned `Verified success` and `architecture-reviewer` returned
0 blocking / 1 nit for steps 1–17. Four skill checks ran
(`api-breaking-changes`, `api-response-changes`, `response-schema`, `security`);
`pr-self-review` is still owed at close-out. The triage round settled five
findings. Three of them change this plan.

**1 · Step 9's `Done when` overstated the query count.** It says "one walk plus
exactly **two** queries". The implementation issues three repository lookups —
`tokensForRepo`, `agentCountsByPath` and `lastScanAt` — which is what the step's
own *Notes* prose and `repository.ts:9-12`'s docstring both describe. NFR-3 is met
either way (p95 44–47 ms against an 800 ms budget, measured twice).

The `Done when` line should read: *"…assembled from one walk plus the two joins
and `lastScanAt`"*. The author declined folding `lastScanAt` into a `MAX()`
alongside `tokensForRepo` — that is the exact construction that already cost the
implementer a `TS1160` parse failure (see the step-7 deviation), so buying a
literal "two queries" with it would be trading a true sentence for a known trap.

**2 · Step 12 claimed verification it cannot have.** Its `Satisfies` line lists
`NFR-10† (partial)`. No Cut-1 test references NFR-10, and none can: NFR-10 is
"no document body reaches a log line", whose mechanism is `run-executor`'s Live
Log lines — step 24, Cut 2. Nothing in Cut 1 emits a log line carrying document
content.

**The `NFR-10†` reference is struck from step 12.** NFR-10 is delivered and
verified by step 24 alone. The author declined inventing a Cut-1 proxy test
(asserting the token-count job's own logs carry no document bytes) on the grounds
that it would be a test of a different property filed under the same number.

**3 · NEW REQUIREMENT — steps 19 and 22 must validate path membership.**

This is the one review finding that adds work rather than correcting prose, and
it comes from the security lane.

`SimpleGitClient.readFile`'s containment guard is **lexical**: `resolve()` plus
`startsWith(root + sep)`. A symlink living inside the clone but pointing outside
it is therefore contained, and the read follows it. In Cut 1 that is
**unreachable**, by two independent layers:

- `server/src/modules/project-context/walk.ts:118` — `if (entry.isSymbolicLink()) continue;`
  The walk never emits a symlink, for any entry type.
- `service.ts` `readDoc` looks the request's `path` up in `walked.files`, 404s on
  a miss, and then reads **`doc.path`** — the walk's own value, not the request
  parameter.

Cut 2 removes that second layer. Step 20's resolver reads **persisted
`agent_context_docs.path`**, and step 22's attach routes accept a path in a body
or querystring. If either reaches `readFile` with an unvalidated string, lexical
containment becomes the only defence and the symlink gap becomes reachable.

**Required, at step 22:** before persisting an attachment, the attach route shall
validate the submitted path against the repository's discovered document set —
the same walk `list()` uses — and reject a path that is not in it. Catching this
at the door costs one lookup once per attach, rather than once per document per
run.

**Required test:** a case asserting that attaching a path outside the discovered
set is rejected and persists no row. Suite: `server-integration` (it needs a real
row's absence).

The author considered and declined two alternatives: re-validating membership
inside the resolver at step 20 (it would pay a full walk on the critical path of
every LLM call, against NFR-1), and switching the adapter guard to `realpath`
(it widens step 6 past what the spec and plan decided, and adds a syscall to
every read). Step 20's resolver therefore keeps reading persisted paths directly,
and its safety rests on step 22 having filtered them.

**4 · Folded into step 20 — correct a misleading comment.** The comment at
`server/src/modules/project-context/service.ts:50-56` justifies the optional
repository constructor parameter by citing `conventions` as local precedent. That
precedent is a **different shape**: `ConventionsService`'s constructor takes only
`container` (`conventions/service.ts:44`), and `runConventionScan` is a free
function in `conventions/pipeline.ts:60` taking the repository at the call site.
`project-context` is the only one of twelve services in `server/src/modules/*/`
with a constructor-level repository override — verified by grepping all twelve.

The parameter itself stays: it is optional, production never passes it, and
`lint:arch` is clean. **Only the comment changes** — it must say plainly that
this is a new seam, not one modelled on `conventions`. Step 20 already edits this
file to implement the facade, so the correction rides along rather than paying for
its own build round.

Approved by the author.

### 2026-08-27 — S4'/S5 review round on Cut 2: two security fixes, one spec-table correction

`plan-verifier` returned `Verified success` for steps 18–33 and
`architecture-reviewer` returned 0 blocking / 1 nit. The three commands the
verifier could not run (its role forbids them) were run by the coordinator and
all passed: `db:migrate` applied, `db:seed` is idempotent (identical ids across
two runs; exactly one of 60 `run_traces` carries a non-null
`prompt_assembly.specs` with `specs_read` length 1), and `./scripts/e2e.sh`
reports **11/11 flows passed**.

Two findings change this plan. Both are security fixes that no existing step
asks for, which is why they are amended in rather than handed straight to
`implementer`.

**1 · NEW — `resolveContextForRun` shall not follow a symlink.**

The step-22 membership check added by the previous amendment is a
**time-of-check**; the resolver's read is **time-of-use**, and nothing binds
them. The vector, using only what a repository owner already has:

1. attach `specs/foo.md` — a real file, passes `assertDiscovered`, row persists;
2. replace it in the repository with a **symlink** to a host path;
3. `POST /repos/:id/resync` — the clone hard-resets to `origin`, so the symlink
   lands on disk. The persisted path is unchanged, and `setAgentDocs`'s
   "already attached" exemption (`service.ts:307-321`) means no attach-time check
   ever runs again;
4. run a review. `resolver.ts:233` calls `sizeOf` → `stat`, which **follows
   symlinks**; `:244` calls `git.readFile`, whose containment guard is lexical and
   passes because the *path* is inside the clone.

The host file's bytes enter `## Project context`, reach the model, and come back
to the user through AC-54's expand control. This is the vector AC-61/AC-62 exist
for, reached by a route the guard does not cover.

**The fix, and why it is neither of the two alternatives already declined:**
`resolver.ts:278-285` **already makes one `stat` call per document** for AC-49's
size cap. Change that call to **`lstat`** and skip a document whose
`isSymbolicLink()` is true, recording `{ path, reason: 'unread' }`.

- Zero added syscalls — the call is already there.
- Identical behaviour for regular files.
- The degradation is already specified: AC-43 ("record as unread") and AC-44
  ("name it in the Live Log") cover it, so **no new acceptance criterion is
  needed**.
- It makes attach-time and run-time agree on what a document is:
  `walk.ts:118` already skips symlinks, and the resolver was the only place that
  did not.

The author considered and re-declined putting `lstat` in
`SimpleGitClient.readFile` (it widens step 6 and adds a syscall to every file
read in the system, not just context documents) and, earlier, re-validating with
a walk (NFR-1) or switching the guard to `realpath`.

**Required test:** a resolver case asserting a symlinked attached path is skipped
with `reason: 'unread'` and its content never read. Suite: `server-unit` —
`resolver.test.ts` is hermetic and already builds temp-dir fixtures.

**2 · NEW — the attach and reorder routes shall verify the parent id belongs to
the caller's workspace.**

All five mutating methods (`service.ts:286-375`) accept an `agentId`/`skillId`
without confirming it is the caller's. Every sibling module does confirm it —
`agents/service.ts:170,183,205,218` and `skills/repository.ts:53` call
`getById(workspaceId, id)` before mutating a link table and 404 on a miss.

There is **no data exposure**: reads filter on `workspace_id` **and** the parent
id together (`repository.ts:210-221,301-313`), so neither tenant can see the
other's row. The concrete consequence the architecture review established is
narrower and still real: `agent_context_docs.agent_id` and
`skill_context_docs.skill_id` both cascade on delete
(`schema/project-context.ts:56-58,81-83`), so when the *owning* workspace deletes
that agent or skill, the other workspace's row is **silently destroyed by an
action it never took and cannot see coming**.

Resolve the parent through `container.agentsRepo` / the skills equivalent before
each write and 404 on a miss — one lookup per write, the cost the siblings
already pay. This is not out of scope: step 22 already cites
`agents/routes.ts:173-231` as the precedent it departs from for *route
placement*, without noting that the same file establishes this convention.

**Required test:** attaching against an id from another workspace is rejected and
persists no row. Suite: `server-integration`.

**3 · SPEC-01's Verification row for AC-41 moves to `server-integration`.**

The spec's table names `server-unit`, but no unit test captures
`reviewPullRequest`'s input arguments; the coverage is
`reviews.it.test.ts`'s assertion on the persisted trace's
`prompt_assembly.specs`. The property is tested — at a different granularity than
the table claims. The integration test is the better artifact: it observes the
value that actually reached the trace rather than a mock's arguments. The spec
edit is `spec-creator`'s, not this plan's.

No step is voided. Steps 20 and 22 gain the two requirements above.

Approved by the author.

### 2026-08-27 — iteration 2: the symlink fix was insufficient, and the skills half is unblocked

Two corrections to the previous amendment, both after evidence.

**1 · `lstat` alone does not close the vector. Use `realpath` + containment.**

The previous amendment specified `lstat` + `isSymbolicLink()`. That closes only the
case where the **file itself** is the symlink. Swapping a **directory component**
defeats it, by the same TOCTOU sequence. Measured directly:

```
BEFORE swap: lstat.isSymbolicLink = false | content = "legit"
AFTER  swap: lstat.isSymbolicLink = false | content = "HOST SECRET"
realpath      = /private/tmp/lstat-probe/outside/foo.md
still lexically inside clone?  true
```

`lstat` does not follow the **final** component but does follow every intermediate
one. So attaching `specs/sub/foo.md` and then replacing `specs/sub` with a symlink
out of the clone yields `isSymbolicLink() === false`, a path still lexically inside
the clone, and a read that returns the host file.

**The resolver shall instead `realpath` the resolved path and assert containment**
(equal to the clone root, or root + separator) before reading, skipping a document
that escapes as `{ path, reason: 'unread' }`. `realpath` resolves every component,
so it closes the class rather than one instance. Keep the size check.

This stays **inside the resolver**. It is not the adapter-level `realpath` the
author declined twice: step 6 is not widened, `SimpleGitClient.readFile` is
untouched, and no other caller pays a syscall. NFR-1 has room — the resolver's
measured p95 is 6.9 ms against a 250 ms budget.

Still no new acceptance criterion: AC-43 and AC-44 already specify skip-and-log.

**Required test:** extend the iteration-1 case so it also covers a **symlinked
directory component**, asserting the content is never read. A test that only swaps
the file would pass against the insufficient fix — that is exactly how the gap
survived iteration 1.

**2 · The skills half of the ownership check is unblocked:
`ProjectContextRepository.skillForContext(workspaceId, skillId)`.**

Iteration 1 correctly stopped: `container` has no skills getter, and importing
`SkillsRepository` violates `no-cross-module-internals`. Of the two options it
reported, the author chose the repository read, **not** a new container getter.

It mirrors `repoForContext` (`repository.ts:160-174`) in the same file, which
already reads another module's table (`t.repos`) through the shared schema. That is
`lint:arch`-legal, adds no composition-root surface, and keeps the decision inside
this module. The cost, stated: `project-context` becomes a second reader of the
`skills` table.

With it, `attachSkillDoc` and `detachSkillDoc` take the same parent check the three
agent methods already have, and the `server-integration` test extends to the skill
path — asserting **no row persisted**, not just a 404.

Approved by the author.
