# Implementation Plan: PR Brief (SPEC-02)

Spec: SPEC-02-pr-brief.md
Status: approved
Execution: single-agent
Approved: 2026-08-28

---

## Decisions taken

Every item below was settled in the planning thread, **not** in SPEC-02. Where the spec still says otherwise, `implementer` treats this plan as authoritative and the coordinator amends the spec before the build is verified against it.

| # | Decision | Closes | SPEC-02 section to amend |
|---|---|---|---|
| D-1 | **`BRIEF_PROMPT_TOKEN_CAP = 24000`.** NFR-3 and NFR-4 stand exactly as written. | OQ-1 | OQ-1 → resolved |
| D-2 | **No linked GitHub issue, no plan/spec file reads.** Signals are title, body, branch, commit subjects and the diff (with hunk text). The asymmetry against the intent card is an **accepted consequence**, not an assumption — recorded in *Open questions*. | OQ-2 | OQ-2 → resolved; *Model & prompt → Signals* |
| D-3 | **One structured call** carries why + risks + focus. AC-14 stands; P-7 is accepted. | OQ-3 | OQ-3 → resolved; P-7 → `accepted` |
| D-4 | **`MAX_BRIEF_RISKS = 20` (persisted clamp, AC-16), `BRIEF_RISK_DISPLAY_CAP = 10` (card, AC-65)**, both in `modules/brief/constants.ts`. AC-39's "showing X of Y" is now reachable. | R-4 | AC-16, AC-39, AC-65 (state the two numbers); P-8 → `accepted` |
| D-5 | **`BRIEF_LLM_MAX_RETRIES = 0`.** One HTTP call per derivation, full stop; a malformed answer is AC-15 immediately. AC-14 is literally true and NFR-4's $0.07 is a real ceiling, not a per-attempt figure. | R-3 | AC-14 (say "one HTTP request"); NFR-4 (note the ceiling is now genuine) |
| D-6 | **AC-9 is proven** by a dedicated `server-unit` test that builds the app with `loadConfig({...process.env, NODE_ENV: 'development'})` so `@fastify/rate-limit` actually registers. | R-5 | *Verification* AC-9 row (name the non-standard app build) |
| D-7 | **AC-50 is unconditional.** `tabIndex={-1}` on `FileCard`'s root + `focus({preventScroll: true})` on reveal, for **every** caller. The behaviour change to the shipped finding-jump and blast-jump is **signed off** and must carry explicit regression assertions. | R-6 | *Module interactions* (add the client hop); AC-50 (note it applies to all reveals) |
| D-8 | **REC-1 taken and non-negotiable:** the model's free-string `kind` **never** reaches the grounding gate. | R-1 | *Contract impact → Full-file exemption* (state the mechanism, not just the intent) |
| D-9 | **REC-2 taken:** `reviewer-core` exports a citation-shaped `groundCitations`; `groundFindings` becomes a thin wrapper over it. | — | *Contract impact → Reviewer-engine export* (name `groundCitations`, drop the `title` claim) |
| D-10 | **REC-5 taken:** `server/test/helpers/brief.ts`, mirroring `test/helpers/intent.ts`. | — | — |
| D-11 | **REC-7 accepted:** the output-language rule joins AC-63's injection rule in `risk-brief.system.md`. **Deliberate deviation, covered by no AC** — needs a SPEC-02 amendment, and must be a **single isolatable paragraph** so the author can still veto it before implementation starts. | R-12 | *Model & prompt → Prompt slots*; add an AC, or record as a stated deviation |
| D-12 | **REC-8 taken:** two cuts with a hard barrier at step 13. | — | — |
| D-13 | **Execution: `single-agent`.** | Q8 | — |

Four implementation decisions I took inside my own half, called out because a reviewer will want them visible:

- **What goes in `pr_brief.json` vs. what becomes a column.** Columns take the provenance (`head_sha`, `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `created_at`), mirroring `pr_intent`. The JSONB blob takes the **model-derived body only**: `{ why, risks, focus, grounding: {kept, dropped}, omitted_files }`. `PrBriefRecord` on the wire is `{pr_id} ∪ blob ∪ columns`, composed in the repository. This is what makes NFR-1's 64 KB a statement about the blob, and what lets AC-19 assert per-column.
- **The brief module builds its own `UnifiedDiff`** in a ~25-line `modules/brief/diff.ts`. It is a deliberate near-duplicate of `reviews/diff-loader.ts`, because `no-cross-module-internals` forbids importing it and promoting it to `platform/` would refactor the review critical path for a feature that does not need that risk.
- **AC-42's client-side re-check reuses the page's existing index**, not a second one. `page.tsx` already builds `diffIndex` via `diffLineIndex(pr.files)`; the brief card gets the same predicate under a citation-shaped signature. One index, one truth.
- **The card lives at `.../pulls/[number]/_components/BriefCard/`**, above the existing two-card grid as D-0 requires, and takes its reveal callbacks as props from `page.tsx`. It does not reach into `OverviewTab`'s siblings.

---

## Requirements traced

| Plan step | Satisfies | Verified by |
|---|---|---|
| 1 | AC-2, AC-19 (shape), AC-30, AC-44, AC-47, AC-58, AC-59; NFR-11 | `./scripts/check-contracts.sh`; `cd server && pnpm typecheck` |
| 2 | NFR-11 | `./scripts/check-contracts.sh`; `cd client && pnpm typecheck` |
| 3 | AC-19, AC-20, AC-36 (substrate) | `cd server && pnpm typecheck` |
| 4 | — (mechanism for step 3) | one new `.sql` under `src/db/migrations/`, `ADD COLUMN` only |
| 5 | — (mechanism for step 3) | `pnpm db:migrate` exits 0; `pnpm exec vitest run .it.test` still boots |
| 6 | AC-24, AC-25, AC-26, AC-27 | `cd reviewer-core && npm test` |
| 7 | AC-3, AC-11, AC-19, AC-20, AC-28, AC-29 (substrate) | `cd server && pnpm lint:arch && pnpm typecheck` |
| 8 | AC-22, AC-62, AC-67; NFR-3, NFR-10 | `server/test/brief-sources.test.ts` (new) |
| 9 | AC-63 (+ D-11's language rule) | `server/test/brief-pipeline.test.ts` (new) |
| 10 | AC-10, AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21, AC-24–AC-29, AC-61, AC-64; NFR-2, NFR-4, NFR-6, NFR-9 | `server/test/brief-pipeline.test.ts` (new) |
| 11 | AC-8, AC-23; AC-6 (service half) | `server/test/brief.it.test.ts` (new) |
| 12 | AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-9, AC-60 | `server/test/brief-routes.test.ts` (new) + `brief.it.test.ts` |
| 13 | verification for AC-1–29, AC-60–67; NFR-1, NFR-2, NFR-3, NFR-4, NFR-6, NFR-9, NFR-10 | `cd server && pnpm test` |
| **— BARRIER — Cut 1 ships and is reviewed —** | | |
| 14 | — (feeds steps 15–17) | `cd client && pnpm typecheck` |
| 15 | AC-30–AC-40, AC-44–AC-49, AC-58, AC-59, AC-65 | `BriefCard.test.tsx` (new) |
| 16 | AC-41, AC-42, AC-43, AC-50, AC-66 | `BriefCard.test.tsx` + `FindingCard.test.tsx` / `DiffTab.test.tsx` (extended) |
| 17 | verification for AC-30–50, AC-58, AC-59, AC-65, AC-66; NFR-5 (automatable rows) | `cd client && pnpm test` |
| 18 | AC-51–AC-57; NFR-7, NFR-8 | `cd mcp && npm test` |
| 19 | the full gate | *Verification*, every command |

**Requirements with no delivering step: none.** All 67 ACs and all 11 NFRs are assigned above.

What is **not** covered, stated rather than implied: NFR-5's **2.4.3 / 2.4.7 / 2.4.11** rows are manual-once by the spec's own Verification table (`server`/`client` suites cannot observe a focus ring's visibility or whether a sticky header obscures it). Everything else has a command.

---

## Goal & scope

After this build, a reviewer opening a PR's Overview tab sees a Brief card above the Intent/Blast grid. If nothing has been derived it offers a control; pressing it queues one job, the card polls the server's own freshness with a bounded wait, and when the row lands it renders three sections in order — why, risks, review focus. Every risk carries a `CRITICAL`/`WARNING`/`SUGGESTION` badge with an icon **and** a text label, and activating its location control (by pointer, Enter or Space) switches to the Files tab, opens that file's card, scrolls to the line and puts keyboard focus there. Every citation was gated against the diff before it was persisted, and re-checked against the studio's own line index before a jump is offered. The same brief is readable through MCP's `get_pr_brief`.

**Not included:** anything under SPEC-02's Non-goals, unchanged — no PR history, no blast absorption, no `file_rank` or repo-intel index reads, no URL-addressable jumps, no PR-list cost-badge change, no review prompt slot, no derive-on-read, no eval harness, no e2e flow. Scope is SPEC-02's Goals and Non-goals verbatim. This plan widens it in exactly **one** place, author-approved: D-11's output-language paragraph in the system template, which no AC covers.

---

## Impact map

| Package / layer | Files | Kind of change | Risk |
|---|---|---|---|
| shared contracts (canonical) | `server/src/vendor/shared/contracts/brief.ts` | `Risk` retyped + widened; 4 new schemas | **Touches `vendor/shared` → mirror sync + `check-contracts.sh` mandatory.** Mirror verified clean on this branch, so the `--fix` diff must carry only this file |
| client contract mirror | `client/src/vendor/shared/contracts/brief.ts` | written by `--fix` | low |
| server schema | `server/src/db/schema/reviews.ts` | 7 additive columns on `prBrief` | **Needs a migration.** Table holds zero rows, so the `NOT NULL DEFAULT now()` rewrite is free — stated because it would not be on a large table |
| server migrations | `server/src/db/migrations/**` | drizzle-kit output | never hand-edited |
| server module | `server/src/modules/brief/**` (new: `constants.ts`, `types.ts`, `schemas.ts`, `diff.ts`, `sources.ts`, `pipeline.ts`, `repository.ts`, `service.ts`, `routes.ts`); `src/modules/index.ts` (+1 import, +1 registry entry) | new module | low; the registry entry is what makes the routes exist |
| server prompts | `server/src/prompts/risk-brief.system.md` (new) | new template | loaded by `renderPrompt`; a production `build` already copies `src/prompts` → `dist/prompts` |
| `reviewer-core` | `src/grounding.ts`, `src/index.ts`, `test/grounding.test.ts` | generalise the gate + 1 barrel export | **Touches the shipped review gate.** Behaviour must be byte-identical; the existing suite is the net |
| client hooks | `client/src/lib/hooks/brief.ts` (new), `hooks/keys.ts`, `hooks/index.ts` | new domain hook file + 1 key factory | low |
| client studio | `.../pulls/[number]/_components/BriefCard/**` (new), `page.tsx`, `_components/OverviewTab/OverviewTab.tsx`, `client/messages/en/prReview.json` | new card + reveal plumbing | medium — three shipped files gain props |
| **client shared component** | `client/src/components/diff-viewer/FileCard/FileCard.tsx` | `tabIndex={-1}` + `focus()` on reveal | **INTENTIONAL CHANGE TO SHIPPED BEHAVIOUR, author-signed-off (D-7).** The finding-jump (`page.tsx` `jumpToFinding`) and the blast-jump (`jumpToFile`) drive the same code path and **will now also move keyboard focus**. Step 16 carries regression assertions for both |
| `mcp` | `src/api.ts` (+1 local projection), `src/tools/get-pr-brief.ts` (new), `src/server.ts`, `test/server.test.ts` | new tool | the five-tool assertion fails until updated — **the intended signal** (NFR-11) |

**Does the wire format change?** Yes, in two ways. (1) Two **new** endpoints, `GET`/`POST /pulls/:id/brief`. (2) `Risk` is **retyped** (`severity`: `RiskSeverity` → `Severity`) and **widened** (`file`, `start_line`, `end_line` added; `file_refs` weakened to `.nullish()`), and `PrBrief` composes it. Both are **exported and never sent**: a grep across `server/src`, `client/src`, `mcp/src`, `reviewer-core/src` and `e2e/` finds one type re-export (`client/src/lib/types.ts:47-54`), no route serving either shape, and no `pr_brief` reader or seed row anywhere. **No existing payload changes.**

**Does it need a migration?** Yes — step 4, generated, never hand-written.

---

## Execution — single-agent

One `implementer` executes steps 1 → 19 in order, in one context, and runs the verification itself. Steps 13 and 19 are gates, not code.

**The barrier after step 13 is real, not decorative.** The `PrBriefRecord` shape settled in step 1 is read again by the client hooks (14), the card (15), the page plumbing (16) and the MCP projection (18). Discovering that shape is wrong after step 16 costs the whole client cut. Do not begin step 14 until step 13's gate is green and the payload has been reviewed.

**Why multi-agent was assessed and declined** (recorded so nobody redoes the analysis): the work does split — **G1** steps 1–2 (contracts + mirror, necessarily one serialized writer, because canonical + mirror is one atomic edit), **G2** steps 3–5 + 7–13 (server), **G3** step 6 (`reviewer-core`), **G4** steps 14–17 (studio), **G5** step 18 (MCP). G3 and G5 are genuinely parallel with G2; G4 is not, because its assertions are written against G2's live payload, not merely against G1's types. It was declined because the chain contract → migration → pipeline → route → hook → card → MCP projection is one decision propagating through six files in three packages, and handoff fidelity across a 67-AC contract is exactly where a fresh context per group loses more than parallelism buys. Same call SPEC-01's plan made, for the same reason. The split above stays recoverable if the build is ever resumed by more than one agent.

---

## Steps

### CUT 1 — contracts, schema, the engine gate, the server module

### Step 1 — Contracts: retype `Risk`, add the record · package: shared (canonical)

- **Files:** modify `server/src/vendor/shared/contracts/brief.ts`
- **Satisfies:** AC-2, AC-19 (payload shape), AC-30, AC-44, AC-47, AC-58, AC-59; NFR-11
- **Skills:** `zod`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck`
- **Done when:** `pnpm typecheck` passes in `server` and `PrBriefRecord`, `PrBriefWhy`, `FocusEntry`, `ReviewFocus` are reachable as `@devdigest/shared` exports
- **Notes:**
  - `Risk` gains `file: z.string()`, `start_line: z.number().int()`, `end_line: z.number().int()`. `severity` moves from `RiskSeverity` (`brief.ts:47`) to the product's `Severity` (`contracts/findings.ts:11`) — **import it, do not redeclare**; it is what the UI kit's `SeverityBadge` already renders with an icon and a label. `file_refs` becomes `.nullish()` with a `// legacy` comment: a `.nullish()` field simply serialises away when absent, so nothing has to emit it (server `insights.md:124-149`).
  - **`kind` stays `z.string()`, and the warning goes HERE, on the field:**
    > `// NEVER pass this to groundCitations. It is model-authored free text, and`
    > `// FULL_FILE_KINDS (reviewer-core/src/grounding.ts:16) would exempt a risk`
    > `// claiming kind:"phantom" from line anchoring — bypassing AC-24/AC-26.`

    This is D-8 and it is non-negotiable. The matching guard is at step 10's call site.
  - `PrBriefWhy = z.object({ summary: z.string(), sources: z.array(z.string()).default([]) })`.
  - `FocusEntry = z.object({ file: z.string(), start_line: z.number().int().nullish(), end_line: z.number().int().nullish(), reason: z.string() })`; `ReviewFocus = z.object({ entries: z.array(FocusEntry) })`.
  - `PrBriefRecord = z.object({ pr_id: z.string(), why: PrBriefWhy.nullish(), risks: z.array(Risk).default([]), focus: ReviewFocus.nullish(), grounding: z.object({ kept: z.number().int(), dropped: z.number().int() }).nullish(), omitted_files: z.array(z.string()).default([]), provider: z.string().nullish(), model: z.string().nullish(), tokens_in: z.number().int().nullish(), tokens_out: z.number().int().nullish(), cost_usd: z.number().nullish(), head_sha: z.string().nullish(), created_at: z.string().nullish() })`. Mirrors `PrIntentRecord` (`contracts/review-api.ts:97-124`) field for field where the facts are the same.
  - **Every field the API may not have computed is `.nullish()`, not required** — root `insights.md:431-454`. AC-47 depends on a section being genuinely *absent* rather than empty, which only `.nullish()` gives.
  - **Leave `PrBrief` (`brief.ts:116-121`) and `RiskSeverity` (`:47`) in place, untouched, served by nothing.** The starter's schema-and-contracts-ahead-of-features rule holds and no consumer exists to break. Add P-5's one-line comment: `blast.ts`'s `BlastResponse` is canonical for the blast endpoint; `PrBriefRecord` is canonical for `GET /pulls/:id/brief`.
  - Names checked against the barrel for collision: `PrBriefRecord`, `PrBriefWhy`, `FocusEntry`, `ReviewFocus` are all free.
  - One Zod schema serves request validation **and** response serialization — declare it on the route in step 12, never hand-validate in the service.

### Step 2 — Mirror the contracts into the client · package: shared (mirror)

- **Files:** `client/src/vendor/shared/contracts/brief.ts` (written by the script)
- **Satisfies:** NFR-11
- **Skills:** `zod`
- **Depends on:** Step 1
- **Verify:** `./scripts/check-contracts.sh` then `cd client && pnpm typecheck`
- **Done when:** the script prints `check-contracts: OK` **and** `cd client && pnpm typecheck` passes
- **Notes:**
  - Run `./scripts/check-contracts.sh --fix` (it always copies server → client), then read `git diff -- client/src/vendor/shared`.
  - Root `insights.md:384-405` warns that `--fix` also lands earlier unmirrored drift, so the diff can be wider than the change. **It does not bite here:** I ran both `./scripts/check-contracts.sh` (→ `OK`) and `diff -rq server/src/vendor/shared client/src/vendor/shared` (→ clean) on this branch, so the diff **must** contain exactly one file. **If it contains anything else, stop** — that is drift which arrived after this plan was written, and it needs its own decision rather than being swept in.
  - Re-check `client/src/lib/types.ts:47-54`: it re-exports `PrBrief`, whose `risks` now carry the retyped `Risk`. Nothing reads it, so it should compile untouched — but the client typecheck is what proves that, which is why it is in this step's Done-when.

### Step 3 — Schema: seven columns on `pr_brief` · package: server

- **Files:** modify `server/src/db/schema/reviews.ts` (the `prBrief` table at `:84-87`)
- **Satisfies:** AC-19, AC-20, AC-36 (persistence substrate)
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck`
- **Done when:** `prBrief` declares `headSha`, `provider`, `model`, `tokensIn`, `tokensOut`, `costUsd`, `createdAt` and `pnpm typecheck` is clean
- **Notes:**
  - Copy `prIntent`'s declarations verbatim (`schema/reviews.ts:70-83`), **including their comments**: `costUsd: doublePrecision('cost_usd')` carrying "NULL = unpriced model OR served from cache; 0 = a genuinely free model — never coalesce the two" (root `insights.md:455-477`); `headSha: text('head_sha')` carrying "NULL ⇒ treated as stale"; `createdAt: now()` from `db/schema/_shared.ts:9`, carrying "the upsert must set this explicitly on conflict, or a re-derivation silently keeps the original timestamp".
  - **No `workspace_id`.** `pr_brief` and `pr_intent` both scope through `pr_id → pull_requests.workspace_id`. This follows the sibling rather than re-tenanting a pre-existing table (D-22 in the spec); **AC-3 asserts the scoping holds** at the repository, which is where the criterion actually lives.
  - **No new index.** Every read is by primary key and nothing queries inside the JSONB, so neither a GIN index nor a generated column earns its cost.
  - `json` stays `jsonb NOT NULL`. **Do not `$type<PrBriefRecord>()` it** — the blob is a strict subset of the wire shape (see *Decisions taken*). Type it against a local `BriefBlob` interface declared in `modules/brief/types.ts` (step 7) so the column and the wire shape cannot be confused by the next reader.
  - **Deliberate deviation from `postgresql-table-design`:** the skill prefers `BIGINT GENERATED ALWAYS AS IDENTITY` surrogate keys. This table's PK is an existing `uuid` FK to `pull_requests` and every one of this repo's ~35 tables uses `uuid().defaultRandom()` or a composite/borrowed PK. Consistency wins; this step adds columns to a shipped table and changes no key.

### Step 4 — Generate the migration · package: server

- **Files:** `server/src/db/migrations/**` (drizzle-kit output — **never** hand-edited)
- **Satisfies:** — (mechanism for step 3)
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 3
- **Verify:** `cd server && pnpm db:generate`
- **Done when:** exactly one new `.sql` file plus its journal entry exists, and its contents are **only** `ALTER TABLE "pr_brief" ADD COLUMN` statements
- **Notes:**
  - `db:generate` diffs against the highest-numbered **snapshot**, ignoring the journal, and prompts interactively when a table both gains and loses a column (server `insights.md:396-439`). **This migration only adds, so it must not prompt.** If it does, step 3 renamed rather than added — stop and fix step 3.
  - **Read the generated SQL before moving on.** A `DROP`, or an `ALTER` against any table other than `pr_brief`, means step 3 touched a shared file wrongly — stop rather than migrate.
  - The next file will land as `0015_*.sql`; the last applied is `0014_spicy_captain_stacy.sql`.

### Step 5 — Apply the migration · package: server

- **Files:** none (DB state)
- **Satisfies:** — (mechanism for step 3)
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 4
- **Verify:** `cd server && pnpm db:migrate` (must exit 0), then `cd server && pnpm exec vitest run .it.test` (must still boot its testcontainer)
- **Done when:** both commands succeed
- **Notes:** **Migrations do not run on boot** — this is the step that makes the columns exist, and a later `column ... does not exist` is always a missing `db:migrate`. **Environment-dependent:** needs Docker. Server `insights.md:17-51` (two Docker runtimes installed; the socket that reaches host `:5432` is Rancher Desktop's) and `:458-480` (`*.it.test.ts` can't find Docker under Colima) both bite here — treat a Docker failure as an environment problem, not a plan problem.

### Step 6 — `reviewer-core`: the citation gate · package: reviewer-core

- **Files:** modify `reviewer-core/src/grounding.ts` and `reviewer-core/src/index.ts`; extend `reviewer-core/test/grounding.test.ts`
- **Satisfies:** AC-24, AC-25, AC-26, AC-27
- **Skills:** `typescript-expert`
- **Depends on:** —
- **Verify:** `cd reviewer-core && npm run typecheck && npm test`
- **Done when:** `groundCitations` is exported from the barrel, `groundFindings` delegates to it, and **every pre-existing grounding test passes unchanged**
- **Notes:**
  - **This package is npm, not pnpm** (`reviewer-core/insights.md:17-27`), and `reviewer-core/node_modules` must exist or the **server** will not boot — the API imports its raw source at runtime, so a missing dep surfaces as `ERR_MODULE_NOT_FOUND` from `server`.
  - **The new export (D-9):**
    ```ts
    export function groundCitations<T extends { file: string; start_line: number; end_line: number }>(
      items: T[],
      diff: UnifiedDiff,
      opts?: { fullFile?: (item: T) => boolean },
    ): { kept: T[]; dropped: { item: T; reason: string }[] }
    ```
    `groundFindings` becomes a thin wrapper passing `fullFile: (f) => (f.kind ? FULL_FILE_KINDS.has(f.kind) : false)`, so `FULL_FILE_KINDS` stays **private to the module** and cannot be reached by a caller that supplies a `kind`.
  - **The drop-reason strings must not change.** They are persisted into `run_traces` and asserted by the existing suite. Keep both templates verbatim: `` `file '${file}' not present in diff` `` and `` `lines ${start}-${end} do not intersect any diff hunk in '${file}'` `` (`grounding.ts:61,74-77`).
  - **Preserve the order of the two checks.** The file-presence check runs **before** the full-file exemption (`grounding.ts:61-70`), so even an exempt kind is dropped when its file is absent. That order is exactly why AC-25 is a separate criterion from AC-26 — collapsing them would silently merge two ACs.
  - `buildLineIndex` is already exported from the module but **not** from the barrel (`index.ts:29` exports only `groundFindings`, `groundingSummary`, `GroundingResult`); `rangeIntersects` is not exported at all. Do **not** add either to the barrel — `groundCitations` is the whole seam, which is what keeps the gate shared rather than reimplemented per path, as `reviewer-core/AGENTS.md` requires.
  - **The brief calls `groundCitations` with no `fullFile` option** (D-8), so `isFullFile` is always `false` and **every** risk is line-anchored. This spec adds **no** new exempt kind, so `FULL_FILE_KINDS` is not touched and `reviewer-core/insights.md:50-59`'s "state it in the spec" obligation does not fire.
  - **A focus entry with `start_line == null`** grounds on file presence alone (AC-27). Implement that by passing `fullFile: () => true` for the focus pass, so the intent is explicit at the call site rather than encoded in magic zeros. Document this branch in the function's docstring.
  - New tests, one per AC: a risk whose range intersects a hunk is **kept** (AC-24); one naming a file absent from the diff is dropped with the file reason (AC-25); one whose range hits **no** hunk — **including an old-side (deleted) line** — is dropped with the lines reason (AC-26); a focus entry naming an absent file is dropped (AC-27). Old-side lines are structurally unlinkable end to end: the parser accumulates new-side numbers only and skips deletions (`server/src/adapters/git/diff-parser.ts:67-69`), and the studio indexes only `newNo`. That is a constraint, not a preference — do not "fix" it.

### Step 7 — `brief` module: constants, types, repository · package: server

- **Files:** create `server/src/modules/brief/constants.ts`, `server/src/modules/brief/types.ts`, `server/src/modules/brief/repository.ts`
- **Satisfies:** AC-3, AC-11, AC-19, AC-20, AC-28, AC-29 (substrate)
- **Skills:** `onion-architecture` (**read first — it decides placement**), `drizzle-orm-patterns`
- **Depends on:** Steps 1, 3
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** `lint:arch` passes with the new folder in place and `getBrief`/`upsertBrief` round-trip a `BriefBlob`
- **Notes:**
  - **`constants.ts` is PUBLIC surface** (the `no-cross-module-internals` exemption whitelists `constants.ts` and `types.ts`) and holds **every number an AC or NFR names**, so each is a one-line edit:
    ```ts
    export const BRIEF_DERIVE_JOB_KIND = 'brief.derive';
    export const BRIEF_SCHEMA_NAME = 'PrRiskBrief';
    export const BRIEF_PROMPT_TOKEN_CAP = 24_000;      // D-1, NFR-3
    export const BRIEF_MAX_OUTPUT_TOKENS = 2_000;      // NFR-4's output half
    export const BRIEF_LLM_MAX_RETRIES = 0;            // D-5, AC-14
    export const MAX_BRIEF_RISKS = 20;                 // D-4, AC-16 clamp
    export const MAX_FOCUS_ENTRIES = 5;                // AC-16 clamp, AC-40
    export const MAX_RISK_TITLE_CHARS = 200;
    export const MAX_RISK_EXPLANATION_CHARS = 600;
    export const MAX_FOCUS_REASON_CHARS = 200;
    export const MAX_WHY_SUMMARY_CHARS = 800;
    ```
    `BRIEF_RISK_DISPLAY_CAP = 10` is the **card's** cap and belongs in the client (step 15) — it is a rendering decision, not a server one. **The two numbers differ on purpose (D-4): 20 persisted, 10 shown, which is what makes AC-39's "showing X of Y" reachable at all.** Say so in a comment in both files.
  - **`BRIEF_SCHEMA_NAME` is `'PrRiskBrief'`, not `'PrBrief'`** — `INTENT_SCHEMA_NAME` is `'PrIntent'` and the two must not collide in a provider's schema cache or in `MockLLMProvider.structuredBySchema`.
  - **`BRIEF_MAX_OUTPUT_TOKENS` is set explicitly and must never be omitted.** Root `insights.md:89-108`: omitting `max_tokens` makes OpenRouter reserve the model's full output window against the account balance and 402 low-credit accounts **before the call runs**. Cite that entry in the comment, in preference to a vendor page — OpenRouter documents `max_tokens` as merely optional and documents the credit-reservation mechanic nowhere.
  - Carry the job-kind docstring `reviews/constants.ts:18-30` writes, adapted: the derivation goes through `JobRunner` because it makes a model call; **JobRunner retries a REJECTED handler twice** (`platform/jobs.ts:41`, default `2`), which for a deterministic failure would mean three billed derivations — which is why AC-10 exists and why the pipeline never throws.
  - **`types.ts` is the other public surface:** `BriefJobPayload { workspaceId: string; prId: string; force?: boolean }`, `BriefBlob { why?; risks; focus?; grounding; omitted_files }`, `BriefSkipReason = 'no_diff' | 'llm_unavailable' | 'model_unsupported' | 'llm_failed' | 'parse_failed'`, `DeriveBriefOutcome { correlationId: string; record?: PrBriefRecord; reason?: BriefSkipReason; cached?: boolean }`. Mirror `IntentSkipReason`'s vocabulary (`intent-pipeline.ts:42-47`) so the two failure surfaces read alike.
  - **`repository.ts` is the ONLY file in this module allowed to import `drizzle-orm`** — `no-drizzle-outside-persistence` whitelists `^src/modules/[^/]+/repository\.ts$`. Give it `getBrief(workspaceId, prId): Promise<PrBriefRecord | undefined>` (composing blob + columns into the wire shape) and `upsertBrief(prId, values)`.
  - **The upsert MUST set `createdAt` to SQL `now()` inside `onConflictDoUpdate`.** Server `insights.md:186-213`: the column's default fires only on insert, so an omitted `createdAt` keeps the original timestamp and the row reads as never re-derived; and stamping `new Date()` mixes a Node clock with a Postgres clock and can go **backwards** under a VM-hosted Postgres. Use SQL, not JS:
    ```ts
    .onConflictDoUpdate({ target: t.prBrief.prId, set: { ...values, createdAt: sql`now()` } })
    ```
  - **AC-3 lives here.** Every read joins `pull_requests` and filters on `workspace_id`; do not rely on the service having checked. The criterion is about the query, and the it-test reads the same PR id under a second workspace.
  - **AC-11 is a *non*-write.** A failed derivation must leave the row untouched — achieved by the pipeline never calling `upsertBrief` on a failure path, the same reason `pr_intent` writes no failure row (`intent-pipeline.ts:37-38`: a failure row would overwrite a good earlier derivation and poison the cache). Say so in the file header so nobody adds a "record the error" write later.

### Step 8 — Signals, diff loading, file selection and the token cap · package: server

- **Files:** create `server/src/modules/brief/diff.ts`, `server/src/modules/brief/sources.ts`; create `server/test/brief-sources.test.ts`
- **Satisfies:** AC-22, AC-62, AC-67; NFR-3, NFR-10
- **Skills:** `onion-architecture`, `typescript-expert`
- **Depends on:** Step 7
- **Verify:** `cd server && pnpm exec vitest run brief-sources && pnpm lint:arch`
- **Done when:** a generated **200-file / 20 000-line** fixture yields an assembled message at or under **24 000** tokens measured by `container.tokenizer`, every included path appears in descending changed-line order, and every excluded path appears in the returned `omitted` list
- **Notes:**
  - **`diff.ts` implements *Decisions taken* 2.** `loadBriefDiff(container, pull, repo): Promise<UnifiedDiff>` — try `container.git.diff({owner, name}, pull.base, pull.headSha)` and return it when `files.length > 0`; otherwise reconstruct from `container.pullsRepo.listFiles(pull.id)` by emitting `diff --git` / `--- a/` / `+++ b/` headers around each non-null `patch` and calling `parseUnifiedDiff` from `../../adapters/git/diff-parser.js`. **File header must say why this is not an import of `reviews/diff-loader.ts`:** `no-cross-module-internals` forbids it, and promoting that function to `platform/` would refactor the review critical path for a feature that does not need that risk. Without the comment the next reader will "dedupe" it and break `lint:arch`.
  - **The signal set is fixed by D-2:** PR title (`NOT NULL`, always present), PR body (skip when blank — one fewer signal, log it at `info`), branch, commit subjects via `container.pullsRepo.listCommits(prId)` (best-effort; on throw, omit and log), and **the diff including hunk text**. **No linked GitHub issue. No plan/spec file reads.** That is the material difference from the intent classifier, which sends paths and counts only "so the cheap model does not cost like the review it precedes" (`intent-pipeline.ts:304-306`) — a risk cannot cite a line it has never seen, so the brief pays for hunks, and that is what makes NFR-3 and NFR-4 the load-bearing numbers.
  - **AC-62:** every signal goes through `wrapUntrusted(label, text)` imported from `server/src/platform/prompt.js` — a thin re-export shim over `reviewer-core/src/prompt.ts:41-45`, which also neutralises an attempt to close the fence from inside by rewriting `</untrusted>`. **No signal reaches the user message unfenced**, and the test asserts that by counting fences against signals.
  - **AC-22 + AC-67, the algorithm:** sort `diff.files` by `additions + deletions` **descending**; compute the budget as `BRIEF_PROMPT_TOKEN_CAP` minus the tokenised system prompt minus the tokenised non-diff signals; accumulate fenced per-file hunk text while the running count stays inside the budget; return `{ message: string, omitted: string[] }` where `omitted` is **the tail in the same descending order**, so it is stable and testable. A single file too large for the whole budget is omitted rather than half-sent.
  - Resolve the tokenizer from `container.tokenizer` — **never construct one.** The BPE ranks load once per process (`container.ts` memoises with `??=`, one `Container` per app), and `TiktokenTokenizer.count` already catches internally and falls back to a character estimate.
  - **NFR-9:** this file produces prompt text and must not log any of it. Names, provenance and sizes only.
  - Tests: the 200-file/20 000-line fixture (NFR-10); a diff over the cap asserting **which paths reached the prompt** and **which were recorded as omitted** (AC-22, AC-67); a fence count equal to the signal count (AC-62); an empty-`pr_files` case yielding an empty diff (feeds the pipeline's `no_diff` exit).

### Step 9 — The system prompt template · package: server

- **Files:** create `server/src/prompts/risk-brief.system.md`
- **Satisfies:** AC-63; plus D-11's output-language paragraph
- **Skills:** — (prose; follow [`docs/agent-prompts/README.md`](../../docs/agent-prompts/README.md) for slot order and authoring rules — cited, not restated)
- **Depends on:** —
- **Verify:** `cd server && pnpm exec vitest run brief-pipeline` (step 10 carries the AC-63 assertion)
- **Done when:** `renderPrompt('risk-brief.system.md', {})` returns text containing an explicit data-not-instructions rule **and** the output-language paragraph
- **Notes:**
  - Loaded by `renderPrompt` (`server/src/platform/prompts.ts:40`), exactly as `review-intent.system.md` is. Templates are read relative to the module — `src/prompts` under `tsx`, `dist/prompts` in a compiled build — and the production `build` already copies them.
  - **AC-63 is load-bearing precisely because this is a standalone classifier call.** It does **not** pass through `assemblePrompt`, so the `INJECTION_GUARD`/`OUTPUT_LANGUAGE_RULE` pair appended at `reviewer-core/src/prompt.ts:175` never reaches it. The template must carry the injection rule in its own text — the same position the intent classifier is in (`intent-pipeline.ts:150`).
  - **D-11 — the output-language paragraph. Keep it as ONE isolatable paragraph, clearly delimited, so it can be deleted in a single edit.** No AC covers it; it is a deliberate, author-accepted deviation that needs a SPEC-02 text amendment, and the author retains a veto until implementation starts. Model it on `OUTPUT_LANGUAGE_RULE` (`reviewer-core/src/prompt.ts:35-39`): every user-facing string in English regardless of the diff's or PR body's language; code, identifiers and string literals quoted verbatim. Without it, a brief derived from a non-English PR renders in that language while every other model-authored string in the product is English.
  - The template must instruct the model to: cite a **file present in the diff** and a **new-side line range**; use `CRITICAL` / `WARNING` / `SUGGESTION`; produce at most 20 risks and at most 5 focus entries; and give each focus entry a one-line reason. It is **asked** here and **clamped** in step 10 (AC-16), because strict `json_schema` ignores `.max()`.
  - **Determinism, and what is deliberately not asserted:** low temperature, and two runs over the same diff are **not** required to agree. No AC pins the prose, because a structured classifier over a large diff does not reliably reproduce wording and a test that pinned it would be a flake generator. What is asserted is that whatever it produces is grounded and clamped. Do not add a snapshot test of the model's text.

### Step 10 — The derivation pipeline · package: server

- **Files:** create `server/src/modules/brief/schemas.ts`, `server/src/modules/brief/pipeline.ts`; create `server/test/brief-pipeline.test.ts` and `server/test/helpers/brief.ts`
- **Satisfies:** AC-10, AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21, AC-24–AC-29, AC-61, AC-64; NFR-2, NFR-4, NFR-6, NFR-9
- **Skills:** `onion-architecture`, `zod`
- **Depends on:** Steps 6, 7, 8, 9
- **Verify:** `cd server && pnpm exec vitest run brief-pipeline && pnpm lint:arch`
- **Done when:** every criterion above has a named assertion in `brief-pipeline.test.ts`, running with **no database and no real model**
- **Notes:**
  - **Shape:** `export async function deriveBrief(container: Container, repository: BriefRepository, args: DeriveBriefArgs): Promise<DeriveBriefOutcome>` — a standalone function over `(container, repository, args)`, **not** a service method, mirroring `intent-pipeline.ts:23-38`, so the whole flow is drivable in a hermetic unit test with stubs: no Docker, no model, no clone.
  - **AC-10 is the contract of this file: it NEVER throws.** Every exit path returns an outcome. Wrap the body in the same catch-all `intent-pipeline.ts:250-255` uses, with the same explanation in the header: JobRunner retries a rejected handler twice, so a deterministic throw is three billed derivations.
  - **Order of operations, each with the criterion it carries:**
    1. **Cache** — unless `args.force`, read the stored row; if `stored.head_sha === pull.headSha`, return `{ record, cached: true }` with **no model call** (**AC-12**). With `force`, skip this entirely and re-derive (**AC-13**). Keyed on `(pr_id, head_sha)`, not `pr_id` alone: a force-push means the brief describes code that no longer exists.
    2. **Diff** — `loadBriefDiff` from step 8. An empty diff exits `reason: 'no_diff'` and persists nothing.
    3. **Model resolution** — `await container.featureModel(workspaceId, 'risk_brief')` (**AC-64**). The id is already registered in both mirrors (`contracts/platform.ts:16,61-68`; `client/src/lib/feature-models.ts`), so **no feature-model registry edit is needed** — which matters, because that registry is the one client mirror `check-contracts.sh` cannot see (root `insights.md:132-167`).
    4. **Provider** — `await container.llm(choice.provider)` in a try/catch; on throw, exit `reason: 'llm_unavailable'` (**AC-18**). A missing key throws `ConfigError` from `buildLlm`.
    5. **Preflight** — **only when `choice.provider === 'openrouter'`**: `await container.modelCatalog.supportsStructuredOutputs(choice.model).catch(() => null)`. **Only an explicit `false` blocks** (`reason: 'model_unsupported'`, **AC-17**); `null` means the catalogue could not tell us, and our ignorance is not the model's limitation, so the derivation proceeds (**AC-61**). Copy `intent-pipeline.ts:136-146` exactly, `.catch(() => null)` included.
    6. **Log the assembly** — `logPromptAssembly(runLog.stdout, { correlationId, stage: 'brief', provider, model, prId }, sections, { verbose })`. `PromptLogContext.stage` is an untyped `string` (`platform/prompt-log.ts:48`), so **this needs no contract change**.
    7. **One call** — `llm.completeStructured({ model, schema: BriefExtractionSchema, schemaName: BRIEF_SCHEMA_NAME, maxRetries: BRIEF_LLM_MAX_RETRIES /* 0 */, maxTokens: BRIEF_MAX_OUTPUT_TOKENS, sessionId: `${repo.owner}/${repo.name}#${pull.number}:brief`, messages: [system, user] })`. **`maxRetries: 0` makes AC-14 literally true: one HTTP request, full stop** (D-5). The provider loops `maxRetries + 1` times (`adapters/llm/openai.ts:88`), so any other value would make "exactly one" false and turn NFR-4's $0.07 into a per-attempt figure. On throw, exit `reason: 'llm_failed'`.
    8. **Parse** — a failure to validate against `BriefExtractionSchema` exits `reason: 'parse_failed'` and **persists nothing** (**AC-15**).
    9. **Clamp in code** (**AC-16**) — strict `json_schema` ignores `.max()`, which is why this is a code step, exactly as the intent module does (`constants.ts:56-59`, applied at `intent-pipeline.ts:205`). Clamp risks to `MAX_BRIEF_RISKS` (20), focus to `MAX_FOCUS_ENTRIES` (5), and every string to its constant. **Clamp BEFORE grounding**, so the gate never runs on items that were going to be discarded.
    10. **Ground** (**AC-24–AC-29**) — see the guarded call below.
    11. **Persist** (**AC-19**) — one `upsertBrief` writing the blob plus `head_sha`, `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`. **A rejection is caught and logged, and the derived record is still returned to the caller** (**AC-21**): a write failure must not lose the derivation already paid for.
  - **THE GUARDED GROUNDING CALL — D-8, the loudest note in this plan.** Build the citation objects as **fresh literals carrying only the three geometry fields**. Never spread the risk:
    ```ts
    // D-8 / REC-1 — `kind` is model-authored FREE TEXT. reviewer-core's
    // FULL_FILE_KINDS (grounding.ts:16) exempts {secret_leak, lethal_trifecta,
    // phantom, hook} from line anchoring, so a risk claiming kind:"phantom"
    // would BYPASS AC-24/AC-26 entirely. Never spread a risk into this literal.
    const gated = groundCitations(
      risks.map((r, i) => ({ file: r.file, start_line: r.start_line, end_line: r.end_line, i })),
      diff,
    );
    ```
    Re-associate the kept items by index. **Write a test that asserts a risk with `kind: 'phantom'` and an off-diff line range is still dropped** — that is the regression net for this decision, and without it the guard is one careless refactor from vanishing.
  - **Focus entries are gated in a second pass** with `fullFile: () => true`, so an entry naming a file present in the diff is kept regardless of whether it carries lines (**AC-27**).
  - **`schemas.ts` holds `BriefExtractionSchema` — a LOCAL Zod schema, NOT a shared contract.** It is the LLM's output shape, not a wire shape; `reviews/intent-schemas.ts` is the precedent. Keep it flat and strict-`json_schema`-friendly. One structured call carries **why + risks + focus together** (D-3, **AC-14**): three sections from three calls could contradict each other and would cost three times as much.
  - **AC-28 / AC-29:** persist `grounding: { kept, dropped }` from the gate's own counts. An all-dropped derivation persists an **empty risk list with a non-zero dropped count** — that is exactly what distinguishes "everything was hallucinated" from "genuinely no risks found", and D-2 in the spec exists for it.
  - **AC-20:** `cost_usd` comes from `StructuredResult.costUsd`, which is `estimateCost(model, tokensIn, tokensOut)` (`adapters/llm/pricing.ts:40-44`) → `null` for a model absent from the table, and a real `0` for one priced at zero. **Never coalesce** (root `insights.md:455-477`). The cache branch (AC-12) writes nothing at all — see *Open questions* on AC-20's third clause.
  - **NFR-6:** one `correlationId` per derivation, echoed in the outcome so the caller's later log lines share it; **exactly one log line per exit path**, and **every failure exit at `error`** — the level that reaches the user as a toast, which is the lesson `intent-pipeline.ts:29-36` and server `insights.md:362-395` encode. **NFR-9:** the prompt-assembly log records slot names, provenance and sizes only — never the PR body or diff text (`intent-pipeline.ts:148-149,156-185`). Assert both on a captured logger.
  - **NFR-4's measurement:** drive the stubbed provider to report usage, run it through the shipped `estimateCost`, and assert ≤ $0.07. The arithmetic that number comes from: 24 000 input tokens at $2.00/1M = $0.048, plus a 2 000-token output cap at $8.00/1M = $0.016, total $0.064. Both prices are confirmed twice over — the vendor page, and this repo's own `pricing.ts:18` (`'gpt-4.1': { in: 2.0, out: 8.0 }`). **The figure does not apply to an OpenRouter override**: `pricing.ts:25-28` marks those rows approximate in its own words.
  - **`test/helpers/brief.ts` (D-10):** export `briefLlm(fixture = BRIEF_FIXTURE)` returning `new MockLLMProvider('openai', { structuredBySchema: { [BRIEF_SCHEMA_NAME]: fixture } })`, mirroring `test/helpers/intent.ts` including its warning comment. **This is not optional bookkeeping.** `risk_brief` defaults to provider `openai`, and `reviews.it.test.ts` already stubs `openai` with `{ structured: REVIEW_FIXTURE }` — a brief derivation reaching that harness would receive a *review* fixture. `structuredBySchema` is exactly what prevents it. And the general rule from server `insights.md:150-185` applies: **override every provider the code will resolve, not just the agent's** — the tell that you hit a live, billable model is an assertion failing against a value that exists in a **prompt file** rather than in your fixture.
  - **NFR-2:** assert the handler resolves inside the configured 120 000 ms timeout with a stubbed provider.

### Step 11 — Service and job registration · package: server

- **Files:** create `server/src/modules/brief/service.ts`
- **Satisfies:** AC-8, AC-23; AC-6 (service half)
- **Skills:** `onion-architecture`
- **Depends on:** Steps 7, 10
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** `getBrief`, `enqueueBriefDerivation`, `registerBriefJobHandler` and `runBriefDerivation` exist and `lint:arch` passes
- **Notes:**
  - Copy `ReviewService`'s intent quartet (`reviews/service.ts:199-284`) shape for shape:
    - **`getBrief(workspaceId, prId)`** validates the PR first (404 on unknown) and **never derives**. A `GET` must not spend a model call — the intent route refuses this explicitly (`reviews/routes.ts:140-142`) and this module follows it.
    - **`enqueueBriefDerivation(workspaceId, prId, force?)`** validates the PR **in the enqueue, not in the handler**, so an unknown id 404s instead of being accepted and silently discarded; returns the job id, or **`null` when the enqueue itself failed** — which is what produces AC-8's degraded receipt. `JobRunner.enqueue` throws when no handler is registered for the kind (`platform/jobs.ts:49`), so that is the path AC-8 describes.
    - **`registerBriefJobHandler()`** registers with `container.jobs.register(BRIEF_DERIVE_JOB_KIND, …)` and **deliberately swallows** (`.catch(() => undefined)`), because a rejected handler is retried twice and the pipeline has already persisted (or deliberately not persisted) its own outcome and logged the reason. Called once, from the routes plugin — same as `registerIntentJobHandler`.
    - **`runBriefDerivation(workspaceId, prId, logger?)`** runs a derivation inline, used by the job handler and by tests, **not reachable from a route**. It builds a `RunLogger` with no run ids (`new RunLogger(container.runBus, [], logger, { prId })`) so events mirror to pino only, exactly as `runIntentDerivation` does at `reviews/service.ts:268`.
  - **AC-23 is JobRunner's own behaviour, not code here.** The runner is constructed with no options (`platform/container.ts:97`), so its defaults apply: concurrency 3, timeout **120 000 ms**, two retries. Assert it in the it-test with a handler that outlives the timeout, checking the `jobs` row status **and** that `pr_brief` is unchanged.
  - `service.ts` may **not** import `src/db/schema` (`no-db-schema-above-repository`) — go through `repository.ts` and `container.pullsRepo`. It may not import another module's internals either; `container.pullsRepo` is the sanctioned cross-module seam.

### Step 12 — Routes and module registration · package: server

- **Files:** create `server/src/modules/brief/routes.ts`; modify `server/src/modules/index.ts` (one import + one registry entry); create `server/test/brief-routes.test.ts`
- **Satisfies:** AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-9, AC-60
- **Skills:** `fastify-best-practices`, `zod`, `onion-architecture`
- **Depends on:** Step 11
- **Verify:** `cd server && pnpm exec vitest run brief-routes && pnpm lint:arch && pnpm typecheck`
- **Done when:** both routes answer under `app.inject()`, `brief` appears in the registry, and the AC-9 test observes a 429
- **Notes:**
  - Model on `modules/blast/routes.ts` — the closest sibling (a new module owning a `/pulls/:id/*` route with no schema imports). **Transport only:** every handler starts with `await getContext(container, req)` for tenancy, then delegates. No business logic, no HTTP types below this file.
  - **AC-5 is free:** `IdParams = z.object({ id: z.string().uuid() })` (`modules/_shared/schemas.ts:11`) rejects a non-uuid at validation, **before** the handler runs. The test asserts **422 and that the repository stub recorded zero calls** — "without reaching the database" is half the criterion.
  - **AC-2 / AC-60 → declare the response schema:**
    ```ts
    { schema: { params: IdParams, response: { 200: PrBriefRecord.nullable() } } }
    ```
    Server `insights.md:124-149` confirms a Zod `response:` schema works — both compilers are installed at `app.ts:64-65` and the convention simply had zero adoption — and that a drifted payload **fails at serialization instead of reaching the studio**, which is exactly AC-60. Note from the same entry: the schema **strips unknown keys**, so a service returning extra fields would silently stop sending them. The repository composes exactly `PrBriefRecord`; keep it that way.
  - **R-9, and this is a gate, not a note.** AC-1 requires `null` for a PR with no brief, and a bare `PrBriefRecord` as `response: { 200: … }` would reject it. **Verify `.nullable()` actually serialises through `fastify-type-provider-zod` in this step's route test, with a real `app.inject()` returning `null`, BEFORE anything downstream is built on it.** If it does not, the fallback is an envelope — `z.object({ brief: PrBriefRecord.nullish() })` — **which changes AC-52's MCP projection and step 18's payload, so it comes back to the author as a plan amendment rather than being chosen silently.**
  - **`POST /pulls/:id/brief`** → `reply.code(202)`, body `{ status: 'accepted', jobId }` or `{ status: 'accepted', degraded: true, reason: 'no_handler' }` (**AC-6**, **AC-8**), with `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }` (**AC-9**) — byte-identical to the intent POST (`reviews/routes.ts:159-172`). 202 whether or not the enqueue took, so the studio has one path: poll until fresh. An unknown PR still 404s.
  - **AC-7** falls out of the enqueue-and-return shape: the test asserts the response resolves **while the stubbed provider is still pending**.
  - **AC-9's test is the non-standard one (D-6).** `@fastify/rate-limit` registers only when `config.nodeEnv !== 'test'` (`app.ts:102-106`), and a per-route `config.rateLimit` is **inert** without the plugin. So this one test builds the app with:
    ```ts
    // NON-STANDARD APP BUILD, on purpose. app.ts:104 skips @fastify/rate-limit
    // under NODE_ENV=test so integration suites can hammer inject(). AC-9 is a
    // statement about the rate limit, so this test — and ONLY this test — must
    // register it. Everything else in this file uses the normal test config.
    const rlConfig = loadConfig({ ...process.env, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    ```
    Assert the **sixth** request inside one minute returns 429. Keep it in its own `describe` with its own `buildApp`, and close that app separately — a leaked rate-limit store across tests is a flake generator.
  - **AC-4:** throw `NotFoundError` from `platform/errors.ts`; the single handler in `app.ts:125` builds the `{error:{code,message,details}}` envelope. **Never hand-build the envelope.**
  - `modules/index.ts` gains one import and one entry in the `modules` record — registration is **static**, deliberately, so the same code path works under `tsx`, the bundler and vitest.

### Step 13 — Server tests, the parser fixture, and the Cut 1 gate · package: server · **BARRIER**

- **Files:** create `server/test/brief.it.test.ts`; create `server/test/diff-parser.test.ts`
- **Satisfies:** verification for AC-1–29, AC-60–67; NFR-1, NFR-2, NFR-3, NFR-4, NFR-6, NFR-9, NFR-10
- **Skills:** `onion-architecture`, `drizzle-orm-patterns`
- **Depends on:** Steps 6–12
- **Verify (in order):**
  ```sh
  ./scripts/check-contracts.sh
  cd server && pnpm typecheck && pnpm lint:arch
  cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'
  cd server && pnpm exec vitest run .it.test
  cd server && pnpm test
  cd reviewer-core && npm run typecheck && npm test
  ```
- **Done when:** all six commands are green, every `server-unit` / `server-integration` / `reviewer-core` row of SPEC-02's Verification table has a named assertion, **and the author has reviewed the served payload**
- **Notes:**
  - **Suite membership is by filename.** `*.it.test.ts` = DB-backed, needs Docker; everything else must be hermetic. Follow the spec's own assignment — it is right. `server-integration`: AC-1, AC-2, AC-3, AC-11, AC-12, AC-13, AC-19, AC-23, AC-28, AC-29, NFR-1. `server-unit`: everything else.
  - **Inject every mock via `ContainerOverrides`** (`llm`, `git`, `github`) — **never construct an adapter inline**; that is the whole reason the container exists.
  - **The it-test must override every provider the code will resolve.** `risk_brief` → `openai`; if a test also triggers a review, `review_intent` → `openrouter`. Use `test/helpers/brief.ts` and `test/helpers/intent.ts` together (server `insights.md:150-185`).
  - **AC-3's assertion is the one people skip:** read the *same* PR id under a *second* `workspace_id` and assert a 404, not merely that the first workspace succeeds.
  - **AC-11's assertion is byte-identity:** capture the row before a deliberately-failed derivation and assert it is unchanged afterwards, `created_at` included.
  - **NFR-1** is timed over 20 sequential reads against a seeded row, plus the serialised length of the response body against 64 KB. **Mark it environment-dependent, not a hard gate** — a timing assertion in a testcontainer suite is a flake source, and the spec's own posture is that the caps are what keep the payload small.
  - **`diff-parser.test.ts` closes OQ-4** — there is **no colocated test for `diff-parser.ts` today**, and the spec's binary/rename-only/mode-only claim rests on a control-flow reading. Assert `parseUnifiedDiff` returns **no file** for a raw diff containing (a) a binary stanza (`Binary files a/x and b/x differ`, no `+++`), (b) a rename-only stanza (`similarity index` / `rename from` / `rename to`, no `+++`), and (c) a mode-only stanza (`old mode` / `new mode`, no `+++`). The mechanism is that `current.path` is set only from a `+++` line and the parser ends with `files.filter((f) => f.path)` (`adapters/git/diff-parser.ts:39-43,78`). Also assert the `pr_files` reconstruction path skips a row whose `patch` is `null` before it emits a `+++` header.
  - **THIS IS THE BARRIER.** Cut 2's hooks, card, page plumbing and MCP projection are all built on the `PrBriefRecord` shape settled in step 1 and proven here. Do not begin step 14 until this gate is green and reviewed.

---

### CUT 2 — the studio card, the reveal, the MCP tool

### Step 14 — Client hooks and cache keys · package: client

- **Files:** create `client/src/lib/hooks/brief.ts`; modify `client/src/lib/hooks/keys.ts`, `client/src/lib/hooks/index.ts`
- **Satisfies:** — (feeds steps 15–17)
- **Skills:** `react-best-practices`, `frontend-ui-architecture` (**with the SPA caveat in *Constraints & invariants***)
- **Depends on:** Steps 2, 13
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** `usePrBrief`, `useDeriveBrief` and `isBriefFreshFor` exist, are re-exported from `hooks/index.ts`, and no component imports `api` directly
- **Notes:**
  - **Copy `client/src/lib/hooks/intent.ts` wholesale** — it is the exact idiom D-3 in the spec points at, already shipped and already proven. `usePrBrief(prId, { pollUntilHead })` sets `refetchInterval` from the **server's own freshness**, not a client flag, so a derivation started in another tab or by another actor also ends the polling (**AC-34**). `useDeriveBrief(prId)` posts and invalidates on success.
  - **Export `isBriefFreshFor(record, headSha)`** for the same reason `isFreshFor` is exported (`hooks/intent.ts:32-41`): the polling stop-condition and AC-36's staleness badge **must** agree, and two copies of that comparison eventually disagree and leave the card polling forever behind a badge that says it is done.
  - **Add to `keys.ts`:**
    ```ts
    /** SPEC-02 — the derived PR brief. Shares no prefix with reviewKeys/runKeys/
        intentKeys, so it must be invalidated by this exact key, never by a sweep. */
    export const briefKeys = { byPr: (prId: Id) => ["pr-brief", prId] as const };
    ```
    **Never inline a `queryKey` literal.** Client `insights.md:117-143` is explicit that the prefixes do **not** nest and that the file's own header comment teaches a convention the tuples do not implement — **read the tuples, never the header**. A mistyped literal produces a mutation that looks successful while `staleTime: 30_000` and `refetchOnWindowFocus: false` (`lib/providers.tsx:28-29`) keep the stale render on screen: no type error, no runtime error.
  - The 202 receipt type stays **local to this file** (as `IntentDeriveAccepted` does at `hooks/intent.ts:19-24`) — it never leaves the client, so it is not a shared contract and must not be added to `vendor/shared`.
  - `lib/api.ts` stays the only place that talks HTTP; it normalises the error envelope into `ApiError`, which AC-33's error state branches on by `status`.
  - **Do not import a runtime VALUE from `@devdigest/shared`** — it breaks only the webpack build, while `typecheck` and `vitest` both pass (client `insights.md:166-194`). Types only.

### Step 15 — The Brief card · package: client

- **Files:** create `client/src/app/repos/[repoId]/pulls/[number]/_components/BriefCard/{BriefCard.tsx,styles.ts,constants.ts,index.ts}`; modify `client/messages/en/prReview.json`
- **Satisfies:** AC-30–AC-40, AC-44–AC-49, AC-58, AC-59, AC-65
- **Skills:** `react-best-practices`, `next-best-practices`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 14
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** the card renders all six states — loading skeletons, error + retry, empty + derive control, populated, stale, per-section-empty — and every user-facing string comes from next-intl
- **Notes:**
  - `constants.ts` holds `BRIEF_RISK_DISPLAY_CAP = 10` (D-4), `MAX_FOCUS_ENTRIES_SHOWN = 5` and `DERIVE_TIMEOUT_MS = 90_000`. **Comment that the server clamps at 20 (`MAX_BRIEF_RISKS`) and the card shows 10 — the gap is what makes AC-39's "showing X of Y" reachable at all.**
  - **AC-37 + client `insights.md:93-116` — the single most likely thing to get wrong in this step.** Use `<SeverityBadge severity={…} />` **WITHOUT `compact`**. `compact` maps to `{compact ? null : s.label}` (`vendor/ui/primitives/Badge.tsx:80`) and **drops the label entirely**, leaving colour + icon carrying the whole meaning — the exact WCAG 1.4.1 failure NFR-5 forbids, and the file's own comment at `:51` says not to do it. And the rendered label is **mixed case** — `"Critical"` / `"Warning"` / `"Suggestion"` from `primitives/tokens.ts:10-13`; the all-caps look is `textTransform: uppercase`, a CSS effect that never reaches the DOM. **In step 17's RTL test, assert `getByText("Critical")`, not `"CRITICAL"`.**
  - **AC-46:** render **every** model-derived string as text, never markup. Do **not** route a risk title, explanation, focus reason or why-summary through `vendor/ui/primitives/Markdown.tsx`. Model-authored content is a stored-XSS carrier, and a `javascript:` URL in a risk title must be inert text rather than a link. RTL text and emoji pass through as-is — no reordering or escaping logic of our own.
  - **AC-45:** truncate **visually** (CSS ellipsis) and set `title`/`aria-label` from the **raw, untransformed** value. These two pull in opposite directions and are the classic miss — write both assertions in step 17.
  - **AC-44:** `formatCost(data.cost_usd, t("costUnknown"))` from `client/src/lib/format-cost.ts:14-20`. `null` → the placeholder, `0` → `"$0.00"`, sub-cent → 4 dp, under $0.0001 → `"<$0.0001"`. **Never `cost_usd ?? 0`** — root `insights.md:455-477`: `null` (unpriced or cached) and `0` (genuinely free) are different facts and the placeholder is the call site's decision, which is why `formatCost` takes it as an argument.
  - **AC-38:** sort risks `CRITICAL` → `WARNING` → `SUGGESTION` at render, from an order constant in `constants.ts`. **AC-58:** focus entries render **in the order the brief lists them** — do **not** sort them. Two adjacent lists with opposite rules; comment both.
  - **AC-39 / AC-65:** render at most 10 risks; when the payload carries more, render a line stating how many of how many are shown. **AC-40 / AC-59:** at most 5 focus entries, each rendering its own reason.
  - **AC-30:** three sections, in the order why → risks → review focus. **AC-47:** each section has its own empty state and its siblings keep rendering — which works only because step 1 made each `.nullish()`.
  - **AC-31, and the three facts that must not be flattened:** "no brief derived", "derived but every risk was dropped" and "genuinely no risks" are **different**. The empty state (no record at all) offers the derivation control; a record with `risks: []` and `grounding.dropped > 0` says everything was ungrounded; a record with `risks: []` and `grounding.dropped === 0` says no risks were found.
  - **AC-32 / AC-33:** skeletons while pending, and an `ErrorState` with a retry control on failure. **Mandatory, not optional** — the SPA has no server-rendered fallback, and `client/AGENTS.md` lists "every screen must have a real loading and `ApiError` state" as an accepted consequence of the architecture.
  - **AC-34 / AC-35 — the bounded wait.** Copy `IntentCard.tsx:24,36-60` in shape, **including its comment**, which explains why the timeout must live client-side: **a stuck or failed derivation writes NO row** (AC-11, by design), so nothing server-side will ever end the wait. Bound it at `DERIVE_TIMEOUT_MS` and hand the user back a button rather than a permanent spinner.
  - **AC-36:** staleness badge **above** the rendered content, with the content still visible — a stale brief is still information.
  - **AC-48:** a `role="status"` region announcing each derivation state change. **NFR-5 note the implementer must NOT "improve":** 4.1.3 does **not** govern the cross-tab reveal — its Understanding document lists selecting a different tab in a tablist among the changes that are *not* status messages. Do not wrap the tab switch in a live region.
  - **UI comes from `src/vendor/ui`** (`Skeleton`, `EmptyState`, `ErrorState`, `SectionLabel`, `Badge`, `SeverityBadge`, `Button`, `Icon`). Do not hand-roll a primitive the kit has and do not add a component library. Note `client/insights.md:237-251`: the icon registry exposes `Pencil` only as `Edit`.
  - **Every string through next-intl** (`messages/en/prReview.json`, namespace `prReview.brief`), no inline literals. A component that calls a **missing** message key fails its own test (client `insights.md:215-236`), so add the keys in this step, not in step 17.
  - `page.tsx` and the card stay `"use client"`. **No `'use server'`, no Server Actions, no RSC data fetching** — see *Constraints & invariants*.

### Step 16 — Reveal plumbing and the `FileCard` focus change · package: client

- **Files:** modify `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`; modify `.../_components/OverviewTab/OverviewTab.tsx`; modify `client/src/components/diff-viewer/FileCard/FileCard.tsx`; extend `.../_components/FindingCard/FindingCard.test.tsx` and `.../_components/DiffTab/DiffTab.test.tsx`
- **Satisfies:** AC-41, AC-42, AC-43, AC-50, AC-66
- **Skills:** `react-best-practices`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 15
- **Verify:** `cd client && pnpm typecheck && pnpm test`
- **Done when:** activating a risk's location control switches to the Files tab, opens the file card, scrolls to the line and leaves keyboard focus on that card; an unresolvable citation is marked and reveals the file with a `null` line; **and the two extended tests prove the finding-jump and blast-jump now also move focus**
- **Notes:**
  - **`page.tsx` already owns everything needed.** It has `jumpToFinding(f)` (line-bearing, `:103-106`), `jumpToFile(path)` (`:110-114`) and `diffIndex` built from `diffLineIndex(pr?.files ?? [])` (`:127`), plus `findingInDiff` already handed to the findings tab. Add:
    - `onRevealLocation(path: string, line: number | null)` — one `setDiffReveal` + `setTab("diff")`, the same two lines `jumpToFinding` runs;
    - `citationInDiff({ file, start_line })` — a thin wrapper over the existing `findingInDiff(…, diffIndex)`.

    **Pass the same `diffIndex`. Do not build a second index** — one index, one truth, and a second one would silently disagree with the findings tab.
  - `OverviewTab` gains those two props and forwards them to `BriefCard`. **Keep its existing `onRevealFile` for the blast card — do not merge the two**; the blast card genuinely has no line, and collapsing them would force a `null` through a signature that means something else.
  - **AC-42 / AC-66:** a citation the studio's own index cannot resolve gets the not-in-diff mark and, on activation, reveals with `line: null` — the behaviour findings already have (`FindingCard.tsx:77-84`). This is the "the brief was grounded against an older `pr_files`" case, and it is exactly why the studio re-checks rather than trusting the persisted grounding.
  - **AC-49:** the location control must be a real `<button>`, which gives Enter **and** Space for free. Do **not** put `onClick` on a `<div>` and hand-roll `onKeyDown` — that is how the Space case gets missed.
  - **AC-50 — D-7, an INTENTIONAL change to shipped behaviour, author-signed-off.** In `FileCard.tsx`: add `tabIndex={-1}` to the element `rootRef` is attached to, and inside the existing `jumpToLine` `setTimeout` (`:73-79`), after the `scrollIntoView`, call `(row ?? rootRef.current)?.focus({ preventScroll: true })` — or focus the card root, per the criterion's wording ("the revealed file card"). **This is unconditional and applies to every caller**, which means the **shipped finding-jump and blast-jump now also move keyboard focus.** Comment it in the file:
    > `// SPEC-02 AC-50 — reveal now moves keyboard focus, for EVERY caller: the`
    > `// brief's risk/focus jumps, the findings tab's jumpToFinding, and the blast`
    > `// card's jumpToFile. Author-signed-off behaviour change, not a side effect.`
  - **REQUIRED regression assertions (D-7).** Extend the **existing** suites, do not write them only in `BriefCard.test.tsx`:
    - `FindingCard.test.tsx` / the findings path: activating a finding's jump leaves focus on the revealed file card.
    - `DiffTab.test.tsx`: a `reveal` prop change moves focus, and `preventScroll: true` means the explicit `scrollIntoView` still owns the scroll position.

    These two are what make the signed-off change visible in a diff rather than discovered by a user.
  - `preventScroll: true` is not cosmetic — without it the browser's own focus scroll fights the `scrollIntoView({ behavior: "smooth", block: "center" })` immediately above it.
  - **NFR-5's 2.4.7 (Focus Visible) and 2.4.11 (Focus Not Obscured) apply to the element this step focuses.** Both are **manual-once** checks; the specific risk is the diff's sticky file header obscuring a focused card. Check it and record the result — jsdom cannot.
  - Keep `page.tsx` thin: this is two callbacks and one predicate, not a new state machine. The reveal state deliberately **never reaches the URL** (`page.tsx:85-88`) — that is a Non-goal (P-3), not an oversight; do not "improve" it into a query param.

### Step 17 — Client tests · package: client

- **Files:** create `.../_components/BriefCard/BriefCard.test.tsx`
- **Satisfies:** verification for AC-30–50, AC-58, AC-59, AC-65, AC-66; NFR-5's automatable rows (1.4.1, 1.4.3, 1.4.11, 2.1.1, 4.1.3)
- **Skills:** `react-testing-library`
- **Depends on:** Steps 15, 16
- **Verify:** `cd client && pnpm test`
- **Done when:** green, with one named assertion per client row of SPEC-02's Verification table
- **Notes:**
  - **Assert through the accessibility tree** — the spec's Verification column says so by name on AC-31, AC-33 and AC-37. Query by **role and accessible name**, never by test id or class.
  - **AC-37's assertion is `getByText("Critical")`, mixed case** — see step 15's note and client `insights.md:93-116`. The all-caps rendering is CSS and never reaches the DOM. Read `vendor/ui/primitives/tokens.ts` for any kit label rather than the rendered screenshot.
  - **AC-45 needs two assertions on the same element:** the accessible name **equals** the full untruncated value, and the rendered text is the truncated one. Write both.
  - **AC-46:** a risk title containing `<b>bold</b>` and `javascript:alert(1)` renders as **literal text** and produces **no anchor** — assert `queryByRole("link")` is null.
  - **AC-34:** assert successive fetch calls while the stored head lags, and **none** once it matches. **AC-35:** advance timers past `DERIVE_TIMEOUT_MS` and assert the control returns to its idle accessible name.
  - **AC-44:** three cases — `null`, `0`, and a sub-cent value — proving the placeholder, `"$0.00"` and the 4-dp form are distinguishable.
  - **AC-49:** dispatch Enter **and** Space separately on the location control and assert the same reveal both times.
  - **NFR-5's contrast rows:** with `css: false`, bind the computed-contrast assertion to the implementation by reading the **inline `style.color`** (client `insights.md:51-73`). If an indicator comes from a stylesheet rather than an inline style or CSS variable, assert the class or the variable and **say so in the test's comment** — jsdom cannot resolve it, and a test that pretends otherwise is worse than an honest one.
  - **Mock at the `fetch` boundary.** Note for the record: RTL suites stub `fetch` and therefore cannot see a server-side join go wrong — which is why step 13's it-tests are not redundant, and why SPEC-02's Non-goal of an e2e flow leaves a stated gap rather than an unnoticed one.
  - jsdom has **no `window.localStorage`** (client `insights.md:74-92`), so any code guarded by try/catch around it silently no-ops here. If the card touches `foldStore`, do not assert on persistence.
  - Wrapping a test in `RepoProvider` makes the shell fetch more, and one non-array stub blanks the whole render (client `insights.md:195-214`) — render the card in isolation with an explicit next-intl provider rather than mounting the page shell.

### Step 18 — The MCP `get_pr_brief` tool · package: mcp

- **Files:** modify `mcp/src/api.ts` (add one local projection); create `mcp/src/tools/get-pr-brief.ts`; modify `mcp/src/server.ts`; modify `mcp/test/server.test.ts`
- **Satisfies:** AC-51, AC-52, AC-53, AC-54, AC-55, AC-56, AC-57; NFR-7, NFR-8
- **Skills:** `typescript-expert`, `zod`
- **Depends on:** Step 12
- **Verify:** `cd mcp && npm run typecheck && npm test`
- **Done when:** `get_pr_brief` is registered, the tool-list assertion (now six tools) passes, and `tools/list` stays under 4 000 characters
- **Notes:**
  - **This package uses npm**, per root `AGENTS.md`. It currently carries **both** a `package-lock.json` and a `pnpm-lock.yaml`/`pnpm-workspace.yaml`; follow the documented one (`npm ci` / `npm test`) and **do not "tidy" the other in this change** — that is a separate decision with its own blast radius.
  - **AC-57 is a hard rule:** add `PrBriefView` to `mcp/src/api.ts` as a **local projection**; **never** import `@devdigest/shared`. Root `insights.md:109-131` and the file's own header (`mcp/src/api.ts:1-7`) both say why: `shared` is aliased backwards into the server tree, so importing it would chain this package to the server's source. The verification is a package typecheck **plus a grep for `@devdigest/shared` in `mcp/src`** returning nothing.
  - **Copy `mcp/src/tools/get-blast-radius.ts` structurally:** `server.registerTool(name, { title, description, inputSchema: { repo: z.string().describe('Repo name, e.g. "owner/name"'), pr_number: z.number().int() }, annotations: { readOnlyHint: true, openWorldHint: false } }, guarded(async ({repo, pr_number}) => …))`, resolving via `resolvePull(repo, pr_number)` and returning `jsonResult(payload, NARROW_HINT)`.
  - **AC-53 is free:** `resolvePull` → `get` → `request` already throws an `ApiError` whose message contains "not reachable" when `fetch` fails (`mcp/src/api.ts:110-115`), and `guarded` turns any `ApiError` into an `isError` result. The existing suite already tests this shape for `get_blast_radius`; mirror it. The same path covers "a repository the API does not know" — `resolveRepo` produces an actionable message naming the known repos.
  - **AC-54 needs an explicit branch — `guarded` will not do it for you.** A `null` payload must produce a **non-error** result whose text states that no brief has been computed for that PR. Check for `null` **before** `jsonResult`.
  - **AC-55 / NFR-7:** the description must be **under 200 characters** — the shipped assertion is `toBeLessThan(200)`, so exactly 200 fails. Keep it one sentence: the tool surface is what every chat pays for at session start.
  - **AC-56 / NFR-8:** `jsonResult` already truncates at `CHARACTER_LIMIT = 25_000` and appends a narrowing hint (`mcp/src/format.ts:20-27`). **Assert it; do not reimplement it.** Supply a `NARROW_HINT` in the spirit of the blast tool's.
  - **NFR-11's one real break, and it is the intended signal:** `mcp/test/server.test.ts:20-30` asserts **exactly five tools by name**. Update it to six, sorted, adding `get_pr_brief`. **Do not update that assertion before the tool exists** — watching it fail once is the proof that the tool surface actually changed.
  - The `mcp` suite is **not in `TESTING.md`'s suite map and is gated by no workflow.** That gap is real and pre-existing; this step does not close it, and *Out of scope* records it.

### Step 19 — Final gate

- **Files:** none
- **Satisfies:** — (gate)
- **Skills:** —
- **Depends on:** Steps 1–18
- **Done when:** every command in *Verification* has been run and passed, and the author has reviewed the shipped card

---

## Verification

Run in this order. Each command, and what it proves:

```sh
# 1. Contracts — the client mirror has not drifted from canonical (NFR-11)
./scripts/check-contracts.sh

# 2. Server types + the Onion dependency rule.
#    A crossed ring FAILS HERE, not in review.
cd server && pnpm typecheck && pnpm lint:arch

# 3. server-unit — hermetic, no Docker.
#    AC-4,5,6,7,8,9,10,14,15,16,17,18,20,21,22,60,61,62,63,64,67; NFR-2,3,4,6,9,10
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'

# 4. server-integration — needs Docker. ENVIRONMENT-DEPENDENT, not a hard gate.
#    AC-1,2,3,11,12,13,19,23,28,29; NFR-1
cd server && pnpm exec vitest run .it.test

# 5. Both server suites together
cd server && pnpm test

# 6. The engine — the citation gate (AC-24,25,26,27) and proof that
#    groundFindings' behaviour did not change
cd reviewer-core && npm run typecheck && npm test

# 7. The studio — AC-30–50,58,59,65,66; NFR-5's automatable rows,
#    plus step 16's two regression assertions on the shipped jumps
cd client && pnpm typecheck && pnpm test

# 8. The MCP surface — AC-51–57; NFR-7,8
cd mcp && npm run typecheck && npm test
```

Migration commands, run once between plan steps 4 and 5 — **not** part of the repeatable gate:

```sh
cd server && pnpm db:generate   # drizzle-kit writes the SQL; never hand-write it
cd server && pnpm db:migrate    # migrations do NOT run on boot
```

**Deliberately NOT run, and why:**

- **`./scripts/e2e.sh`** — SPEC-02 makes a browser flow a Non-goal, with the reason at D-21: e2e runs with no LLM and no brief is seeded, and changing the seed breaks flows silently (`e2e/insights.md:130-136`). `client` covers the states; `server-integration` covers the row. This matches how the intent card and the blast card shipped — neither has an `e2e/` flow either.
- **Step 4 of the gate, in a Docker-less environment** — environment-dependent by construction. Server `insights.md:17-51` and `:458-480` record both Docker traps on this machine; a failure there is an environment problem, not a plan failure.
- **`api-breaking-changes`, `api-response-changes`, `response-schema`, `security`, `pr-self-review`** — **these are not `implementer`'s skills.** They belong to the separate review agents and the pre-PR gate. See *Out of scope*. **Nobody should assume they ran.**
- **A quality/eval harness for the brief's prose** — no eval harness is added and the `eval` tables stay empty. A quality regression in the brief would be noticed only by a reviewer reading it. That is a **stated gap**, recorded here rather than left implied; what the suites do catch is a regression in the gate, the clamps, the states and the persistence.

**Every acceptance criterion maps to a command above**, with two stated exceptions: NFR-5's **2.4.3 / 2.4.7 / 2.4.11** are manual-once by the spec's own Verification table (step 16 names the specific thing to look at), and NFR-1's timing half is environment-dependent.

---

## Constraints & invariants

The specific rules this plan is bound by. A reviewer should check it against these.

**Repo-wide**

- **Five standalone packages, NOT a pnpm workspace.** Cross-package code is shared as TypeScript **source** through tsconfig path aliases. **Never** `pnpm add` one local package into another, and there is no build or publish step for shared code.
- **Two package managers on purpose:** **pnpm** in `server`/`client`, **npm** in `reviewer-core`/`mcp`/`e2e`. Steps 6 and 18 use npm.
- **`@devdigest/shared` is canonical at `server/src/vendor/shared/`;** `client/src/vendor/shared/` is a hand-synced copy. A contract change is **always two files**: edit canonical → `./scripts/check-contracts.sh --fix` → typecheck **both** packages. Nothing else catches the drift, because both packages typecheck against their own copy.
- **`--fix` also lands earlier unmirrored drift** (root `insights.md:384-405`) — verified not to bite on this branch (step 2), but the diff must still be read.
- **Migrations do not run on boot and are never hand-edited.** Schema change = `pnpm db:generate` then `pnpm db:migrate`, two separate steps.
- **Every domain table carries `workspace_id`** — except `pr_brief` and `pr_intent`, which scope through `pr_id → pull_requests`. Followed, not re-litigated; AC-3 asserts it.
- **Schema and contracts exist ahead of the features that use them.** `PrBrief`, `RiskSeverity`, `PrHistory`, `SmartDiff` and ~35 tables stay. **Unused ≠ dead. Do not clean up the schema or the contract barrel.**
- **`server/clones/**` is never read, edited or searched** — it holds a stale full copy of this repository and the files there look real and are not.

**Server (`server/AGENTS.md`) — the Onion rule is lint-enforced, so a violation fails `pnpm lint:arch`, not review**

- Layering is one-directional: `routes.ts` → `service.ts` → `repository.ts`. Routes are transport only; no business logic in a route, no HTTP types below it.
- **`repository.ts` is the only file in a module allowed to import `drizzle-orm`**; `routes.ts` and `service.ts` may not import `src/db/schema`.
- **A module's public surface is its `constants.ts` and `types.ts`.** Cross-module work goes through the container or a job kind — **never** another module's service, repository or internals. This is why step 8 duplicates the diff loader rather than importing it.
- Resolve every dependency from `container`; never construct an adapter inline. Tests inject via `ContainerOverrides` — that is the whole reason the container exists.
- Modules register **statically** in `src/modules/index.ts`: one folder + one import + one registry entry.
- One Zod schema serves request validation **and** response serialization, declared on the route.
- Errors: throw `AppError` subclasses; the single handler in `app.ts` builds the `{error:{code,message,details}}` envelope.
- Anything slow goes through `JobRunner`, not the request — and **a rejected handler is retried twice**, which is why AC-10's never-throws contract is load-bearing.
- **Test-suite membership is by filename:** `*.it.test.ts` = DB-backed integration (needs Docker); everything else must be hermetic.
- A new native dependency would need an `allowBuilds:` entry in `pnpm-workspace.yaml` — **this plan adds no dependency to any package.**

**`reviewer-core`**

- Pure domain engine: no database, no GitHub, no filesystem. It may depend on `vendor/shared` and nothing else in `server/src` (`no-core-imports-from-server`). `groundCitations` is pure computation and stays that way.
- The grounding gate is **shared, not reimplemented per path** — the reason step 6 exports it rather than letting the server compose `buildLineIndex` itself.

**Client (`client/AGENTS.md`)**

- **The studio is a client-rendered SPA on an App Router shell — deliberately.** No server-side data fetching, no Server Actions, no DAL. **Do not add `'use server'` or move fetching into RSC.** Every screen needs a real loading state and an `ApiError` state.
- **`frontend-ui-architecture` assumes an RSC-first app; this studio is not one.** Take its guidance on folder structure, feature boundaries and component decomposition; **ignore its RSC-boundary, Server-Actions and Data-Access-Layer sections.** `client/AGENTS.md` wins.
- **Never `fetch` in a component.** `lib/api.ts` is the only place that talks HTTP; components consume typed React Query hooks from `lib/hooks/`.
- Cache keys come from `lib/hooks/keys.ts` — never an inline `queryKey` literal.
- Types come from `@devdigest/shared`, never hand-written locally; **never import a runtime value from it** (webpack-only breakage).
- Feature components colocate under the owning route in `_components/<ComponentName>/`; promote to `src/components/` only on the second consumer. `BriefCard` has one consumer and stays colocated.
- UI primitives come from `src/vendor/ui`; user-facing strings go through next-intl.
- **`client/src/vendor/**` is do-not-touch.** This plan **reads** `vendor/ui` and **regenerates** `vendor/shared` via the sync script; it edits neither by hand. `client/src/components/diff-viewer/**` is authored here and is a legitimate edit target (step 16).

**Do-not-touch, restated for this build:** `server/clones/**`, `server/src/db/migrations/**` (generate, don't edit), `client/src/vendor/**`, locked skills under `.claude/skills/**`, and anything generated (`dist/`, `.next/`, `coverage/`, `*.tsbuildinfo`).

---

## Open questions

Everything the author decided is in *Decisions taken*. What remains:

- **Accepted consequence of D-2 (not an assumption).** The brief gathers no linked GitHub issue and reads no plan/spec files, while the intent derivation beside it gathers both (`intent-pipeline.ts:311-360`). Therefore, on a PR with a linked ticket or a linked spec, **the brief's "why" is derived from strictly less evidence than the intent card sitting next to it**, and the card-versus-card disagreement Q-1c accepts is **not symmetric — the brief is the less-informed one**. The author accepted this knowingly; it is recorded here so a future reader does not read the asymmetry as a bug. Reversing it means adding step 8 signals and re-costing NFR-3/NFR-4 against the larger prompt.
- **D-11 (the output-language paragraph) is covered by no acceptance criterion.** It is a deliberate, author-accepted deviation requiring a SPEC-02 text amendment, and **the author retains a veto until implementation starts** — which is why step 9 requires it to be a single, isolatable paragraph removable in one edit.
- **R-9 — top-level `null` through `fastify-type-provider-zod`.** Step 12 verifies `PrBriefRecord.nullable()` serialises before anything is built on it. **If it does not, the envelope fallback changes AC-52 and step 18's payload, and comes back as a plan amendment** appended to this file — not chosen silently.
- **AC-20's cache clause has no code path (R-10).** AC-12 returns the stored record with no model call and writes nothing, so "persist `cost_usd` as `null` … when the record came from cache" describes a write that does not occur. The plan proceeds on the reading that the clause is vacuous and only the unpriced-model case is live. **Spec-text correction, listed below.**
- **For `researcher`, not for this plan:** whether `gpt-4.1`'s context window comfortably holds 24 000 input tokens plus a 2 000-token output. The planning agent held no web tools; the spec's research established the price (confirmed twice — the vendor page and `pricing.ts:18`) but not the window. The cap is enforced on our side by AC-22 either way, so a wrong assumption degrades to a provider error caught by AC-15/`llm_failed`, not to a wrong brief.
- **Cost figures do not survive an OpenRouter override.** If a workspace overrides `risk_brief` to an OpenRouter slug, **no cost figure in NFR-4 applies**: those rows of `pricing.ts` are marked approximate by the file itself (`:25-28`) and must be confirmed against the live catalogue before being relied on.

---

## Out of scope / follow-ups

- **Architecture review (`architecture-reviewer`)** — recommended at the step 13 barrier, before the client cut. Point it at exactly two things: the module-local `diff.ts` duplication (*Decisions taken* 2) and the `groundCitations` generalisation of a shipped gate (step 6).
- **`plan-verifier`** — runs against this file once the build is done; `Partial success` is **not** `delivered`, and the plan stays `approved` until the gaps close.
- **`api-breaking-changes`, `api-response-changes`, `response-schema`** — the review agents', **not** `implementer`'s. The right targets are step 1's `Risk` retyping (`severity` changed, `file_refs` weakened, three fields added) and step 12's response schema. **Nobody should assume these ran.**
- **`security`** — the review agents'. Relevant surfaces: AC-46 (model output as a stored-XSS carrier), AC-62/AC-63 (prompt-injection fencing), and D-8's `FULL_FILE_KINDS` bypass.
- **`pr-self-review`** — the pre-PR gate, before `gh pr create`.
- **SPEC-02 text corrections, all for `spec-creator`, none for this plan:**
  1. **R-2** — *Contract impact → Reviewer-engine export* says the gate reads `title` for the drop-reason string. It does not; the reasons use `file` and the line numbers only (`grounding.ts:59-80`). The conclusion (a risk need not be dressed as a `Finding`) is right; the stated reason is wrong.
  2. **R-10** — AC-20's "or the record came from cache" clause describes a write that cannot happen under AC-12.
  3. The *Decisions taken* table's right-hand column names every other section to amend, including the two cap numbers (AC-16/AC-39/AC-65), AC-14's wording under `maxRetries: 0`, AC-9's verification row, AC-50's now-universal scope, and the D-11 deviation.
- **Moving SPEC-02 from `draft` to `implemented`** — the author's call, after the corrections above. The index row in `specs/README.md` must move with it.
- **`/engineering-insights`** — warranted after this build. Likely candidates, judged against the rubrics: the `FULL_FILE_KINDS` free-string bypass (D-8), the rate-limit-disabled-under-test gap (D-6), and whether a top-level `.nullable()` response schema serialises (R-9).
- **The `mcp` suite is gated by no workflow and is absent from `TESTING.md`'s suite map.** Pre-existing; this build does not close it, but step 18's assertions now depend on it, which makes the gap slightly more expensive than it was.
- **Deferred deliberately, all SPEC-02 Non-goals with stated evidence:** URL-addressable reveals (P-3), rank-ordered focus (P-4, moot under this design), PR history (no faithful source: `pull_requests` carries no merge timestamp), absorbing the Blast Radius card, changing the PR-list cost badge, an eval harness, and a browser e2e flow.

---

## Amendments

Append-only. Each entry records what the plan got wrong or what changed after
approval, with the evidence. **Never rewrite a step above this log — the log is
the diff.**

### 2026-08-28 — A-1 · The compatibility inventory was incomplete: `Risk`'s retyping broke a second consumer

**Voids:** nothing. **Corrects:** the *Impact map*'s "Does the wire format change?"
paragraph, and the step-18 note at `:520` ("**NFR-11's one real break**").

**What the plan claimed.** The *Impact map* stated that `Risk` and `PrBrief` are
"**exported and never sent**", supported by "a grep across `server/src`,
`client/src`, `mcp/src`, `reviewer-core/src` and `e2e/`" finding one type
re-export and no reader. Step 18's note then named `mcp/test/server.test.ts:20-30`
as "**NFR-11's one real break, and it is the intended signal**".

**What is actually true.** That grep did not cover `server/test/`.
`server/test/contracts.test.ts:87-90` constructs a `Risk`-shaped fixture and broke
on the retyping, with:

```
FAIL test/contracts.test.ts > Intent / BlastRadius / Risks / PrHistory
  "path": ["risks", 0, "end_line"], "message": "Required"
```

So there were **two** real breaks, not one. `implementer` fixed it correctly and
in the right direction — the fixture was updated to the new contract **and** an
assertion was added that the citation fields are now required, which strengthens
the test rather than loosening it (`git diff -- server/test/contracts.test.ts`).

**Evidence.** Reported by `implementer` as deviation D-c; independently confirmed
by `plan-verifier`, which re-read the diff and recorded the strengthening. The
coordinator then re-ran the consumer grep over `server/src client/src mcp/src
reviewer-core/src server/test e2e`: the only `Risk` consumers are
`modules/brief/{pipeline,types}.ts`, `BriefCard.tsx`, both contract mirrors, and
`server/test/contracts.test.ts`. **No seed row** — `pr_brief` does not appear in
`server/src/db/seed.ts`. No adapter, no e2e flow.

**Why it matters beyond this build.** `server/test/contracts.test.ts` is a
**second, undocumented consumer of every `vendor/shared` shape**, and no
"who reads this contract" audit finds it — not the one in this plan, not
`api-breaking-changes` (which scans `client/src` call sites), not
`response-schema`. The next contract change will repeat this exact miss unless it
is written down. Recorded as a follow-up and an `/engineering-insights` candidate.

**Approved by the author** (triage round, 2026-08-28).

### 2026-08-28 — A-2 · NFR-1's 150 ms p95 is accepted as unproven

**Voids:** nothing. **Qualifies:** NFR-1 in *Verification*.

NFR-1 has two halves. The **64 KB payload cap is asserted hard** and passes
(`server/test/brief.it.test.ts:396`). The **150 ms p95 is not asserted** — the
test bounds it at `< 2_000 ms` instead (`:401`), roughly 13× looser.

`implementer` reported this as deviation D-i rather than letting the row read as
green, and `plan-verifier` graded NFR-1 **Partial** on the same evidence.

**Author's ruling: accept as known debt.** The reasoning stands — a wall-clock
assertion inside a testcontainer suite measures Docker's scheduling, not the
query, and a flaky gate is worse than an honest gap because it gets disabled. The
`< 2_000 ms` bound stays as a coarse regression guard.

**NFR-1's timing half is therefore UNPROVEN by this build** and must not be
reported as verified. Follow-up: measure repository read latency against a warm
connection outside the testcontainer lifecycle, and assert 150 ms there.

**Approved by the author** (triage round, 2026-08-28).

### 2026-08-28 — A-3 · AC-45 was not met for the location control; fixed under review

**Voids:** nothing. **Corrects:** step 15's AC-45 note and step 17's AC-45
verification instruction.

Step 15 said to "set `title`/`aria-label` from the **raw, untransformed** value"
and step 17 required "two assertions on the same element". The delivered
`LocationButton` set `aria-label` to the fixed translated string
`prReview.brief.jump` and put the raw value only in `title`
(`BriefCard.tsx:112-113`). Because `aria-label` **overrides** `title` in
accessible-name computation, the untruncated path never became the accessible
name — and the comment at `:110-111` asserted the opposite of what the code did.

The step-17 test could not catch it: it asserted `toHaveAttribute("title", …)`
rather than the computed accessible name, and *located* the control by
`name: /Open this location/`, which was itself proof the accessible name was the
generic string (`BriefCard.test.tsx:442-454`).

**Found independently by `architecture-reviewer` (reported outside its charter as
an open question) and by `plan-verifier` (graded AC-45 unproven).** The two
sibling AC-45 sites — `:160` `aria-label={risk.title}` and `:203`
`aria-label={entry.reason}` — were already correct, and that asymmetry is why the
defect survived.

**Author's ruling:** the accessible name carries **the untruncated value *and* the
action** — `"<path>:<line> — Open this location in the Files changed tab"` — which
satisfies AC-45 literally while keeping the control's purpose legible to a
screen-reader user. `prReview.brief.jump` becomes a parameterised message. The
step-17 test is rewritten to query by accessible name, and must fail against the
pre-fix code.

**Approved by the author** (triage round, 2026-08-28).

**A-3 addendum (same date).** Step 17's note requires "the accessible name
**equals** the full untruncated value". Under the author-approved fix the location
control's accessible name **contains** the untruncated value and then the action
(`"<path>:<line> — Open this location in the Files changed tab"`), so step 17's
"equals" wording is now **stale for that one element**. It remains exactly right
for the two sibling sites (`BriefCard.tsx:164` risk title, `:207` focus reason),
whose accessible names still equal their raw values.

SPEC-02 AC-45 itself needs no change — it says "expose the untruncated value as
that element's accessible name" (`specs/SPEC-02-pr-brief.md:247`), and a name that
carries the value plus the action does expose it. Flagged by `implementer` rather
than silently absorbed; recorded here rather than edited into step 17, because the
log is the diff.

### 2026-08-28 — A-4 · Verification verdict of record

**Verdict: `Partial success`.** Delivered by a **fresh** `plan-verifier` (not the one
that ran the first review round), on the whole build's diff `8de93ea`..worktree,
after the S5 fix iteration closed. Per [`specs/plans/README.md`](README.md),
`Status: delivered` is permitted only on `Verified success`, so **this plan stays
`approved`** and its index row is unchanged. Not rounded up.

**What is verified.** All 19 steps have an artifact. All ten verification commands
re-run by the verifier itself, matching every claimed count with zero skips:

| Lane | Baseline `8de93ea` | After |
|---|---|---|
| server | 450 / 45 files | **521 / 50 files** |
| client | 244 / 33 files | **274 / 34 files** |
| reviewer-core | 41 / 3 files | **52 / 4 files** |
| mcp | 16 / 2 files | **21 / 2 files** |

Four clean typechecks, `pnpm lint:arch` clean (203 modules, 726 dependencies),
`check-contracts: OK`, `server/.dependency-cruiser.cjs` diff **empty**.
**Contradicted: none. Requirements the plan never served: none.**
Two independent `architecture-reviewer` passes, both `0 blocking / 0 nits / 0 pre-existing`.

**What keeps it off `Verified success`** — four items, all recorded above, none a code defect:
1. **NFR-1's 150 ms p95** — unproven; see A-2.
2. **NFR-5's 2.4.3 / 2.4.7 / 2.4.11** — manual-once, not performed. jsdom cannot observe a focus
   ring or a sticky header. Sharper than usual here because AC-50 now moves focus for **every**
   reveal, including the two already-shipped jumps.
3. **Step 13's "the author has reviewed the served payload."**
4. **Step 19's "the author has reviewed the shipped card."**

Items 2–4 close only with a human at a browser. Until then this plan is honestly
`approved`, not `delivered`.
