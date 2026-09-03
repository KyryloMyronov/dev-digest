# Implementation Plan: Reviewer-ordered diff (SPEC-03)

Spec: SPEC-03-reviewer-ordered-diff.md
Status: delivered
Execution: single-agent
Approved: 2026-08-28

---

## Decisions taken

Every row was settled in the planning thread, **not** in SPEC-03. Where the spec still reads otherwise, `implementer` treats this plan as authoritative and the coordinator amends the spec before the build is verified against it.

| # | Decision | Closes | SPEC-03 section to amend |
|---|---|---|---|
| D-1 | **Apportion the derivation's tokens and cost across its rows**, in proportion to each file's prompt tokens, with the semantics written on the column and in `PrFileSummary`. `null` total → all `null`; `0` total → all `0`; remainder to the largest weight so the sum is **exact**. | R-1 | AC-33 → "its **share** of the token counts and the cost"; NFR-1's "summed across the rows" becomes literally true |
| D-2 | **Read-time projection.** The repository returns **one row per path** — `DISTINCT ON (path)`, ordered `(head_sha = pull.head_sha) DESC, created_at DESC`, so a current-head row always wins. `selected` / `total` / `omitted_files` are computed by the **service** over the derivation-eligible set (non-boilerplate, patch non-`null`). **No schema change** — the approved *Schema impact* block stands verbatim. | R-2, R-3 | AC-21 and AC-60: `omitted_files` re-reads as "eligible but not summarised"; NFR-5's "structurally unreachable" becomes true (one row per path, not one per head SHA) |
| D-3 | **Nested disclosure button.** The file-card header stays a non-interactive `<div>`; chevron + path + stat become one real `<button aria-expanded>`; tag, severity badge, derive control and comment count are siblings **outside** it. Accepted cost: clicking the badge strip no longer folds the card. | R-5 | D-21's "copying the group header one file away" — the group header has no interactive descendants; this one has two |
| D-4 | **The reveal keeps focusing the card root.** SPEC-02's two signed-off regression assertions hold **unchanged**. | R-4, Q4 | *Sequencing* row for `FileCard.tsx` — the two edits compose, they do not conflict |
| D-5 | **`pricing.ts`'s `deepseek/deepseek-v4-flash` row is corrected as a named step** to the live `{ in: 0.088606, out: 0.177212 }`. Blast radius accepted: `review_intent` and `onboarding` resolve the same default model, so their persisted `cost_usd` becomes **more** accurate. NFR-1's test stays on a stubbed price. | R-7, OQ-3 | OQ-3 → resolved; NFR-1's citation `pricing.ts:33-34` is imprecise — the entry is line **34 alone**, the stale comment block is **31-33** |
| D-6 | **`classifyPath` → `server/src/modules/_shared/classify-path.ts`**, re-exported from `pulls/smart-diff.ts`. | spec's delegated decision | *Module interactions → Callers and callees*, final paragraph → resolved |
| D-7 | **Two cuts, hard barrier after the server gate** (step 14). | REC-7 | — |
| D-8 | **The derive callback rides a `DiffSummaryApi` prop, not the annotation.** `DiffCommentApi` is the shipped precedent for callbacks reaching `FileCard`; `annotations.ts` carries data only. | REC-8 | *Contract impact → `DiffAnnotation`* — the summary **data** and resolved labels go on the annotation as the spec says; the **callback** does not |
| D-9 | **The severity label at the line stays in the DOM but renders in the gutter margin**, never `SeverityBadge compact`. | REC-9 | — |
| D-10 | **Execution: `single-agent`.** | Q7 | — |

Six implementation decisions I took inside my own half, called out because a reviewer will want them visible:

- **`pr_file_summaries` is declared in `server/src/db/schema/reviews.ts`**, beside `pr_intent` and `pr_brief`. That file is the family of *derived, per-PR artifacts*; `schema/pulls.ts` is the family of *GitHub-mirrored raw* rows (`pull_requests`, `pr_files`, `pr_commits`). Following the sibling SPEC-02 chose, and it keeps the barrel (`db/schema.ts`) untouched.
- **`PrFileRow` is a local type alias inside the module** — `type PrFileRow = typeof schema.prFiles.$inferSelect` — exactly as `modules/brief/{pipeline,sources}.ts` alias `RepoRow`. `PrFileRow`'s only declaration today is `modules/pulls/repository.ts:16`, which `no-cross-module-internals` forbids importing. Adding it to `db/rows.ts` is the documented alternative and was **declined**: it would edit two shipped files for a type alias, and the module beside this one already established the local-alias idiom with the reason in a comment.
- **The extraction schema's root is an object, `{ summaries: [{path, summary}] }`**, not the bare array the spec's *Model & prompt* names. Strict `json_schema` requires an object root; `reviews/intent-schemas.ts` and `modules/brief/schemas.ts` are the two precedents.
- **The PR-level wait's stop condition is `selected === total`**, and the per-file wait's is "that path has a row at the current head". This is what makes **AC-64** true rather than accidental: a per-file summary landing bumps `selected` by one, which does not satisfy `selected === total`, so the PR-level wait continues. On a token-capped PR `selected < total` forever and the wait ends at **AC-57**'s 90 s — that is the *normal* exit for a capped PR, not a failure, and step 15 comments it as such.
- **There is no acceptance criterion for a PR-level derivation *control* in the studio**, yet AC-63 and AC-64 presuppose one ("WHILE a PR-level derivation is in flight…"). Step 18 renders one in the section header as an implementation necessity, and says so in the file. It is the only surface in this plan that no AC names.
- **AC-40's catalogue string is literally `REVIEWER-ORDERED DIFF`.** `SectionLabel` uppercases in CSS (`SectionLabel.tsx:22`), so the DOM carries whatever the catalogue holds; storing it uppercase is what makes AC-40's client assertion the criterion instead of a lookalike, and it is also the only casing e2e's `wait --text` would match (spec OQ-6, closed).

---

## Requirements traced

| Plan step | Satisfies | Verified by |
|---|---|---|
| 1 | AC-2, AC-21, AC-31, AC-33, AC-34, AC-59, AC-60 (payload shape) | `cd server && pnpm typecheck` |
| 2 | AC-31 (client half); NFR-9 (mirror) | `./scripts/check-contracts.sh`; the `feature-models` diff command; `cd client && pnpm typecheck` |
| 3 | AC-18 (mechanism) | `cd server && pnpm lint:arch && pnpm exec vitest run smart-diff` |
| 4 | NFR-1 (the real-world half of it) | `cd server && pnpm typecheck && pnpm exec vitest run model-catalog` |
| 5 | AC-33 (persistence substrate), AC-58 (staleness key) | `cd server && pnpm typecheck` |
| 6 | — (mechanism for step 5) | one new `.sql`, `CREATE TABLE` only |
| 7 | — (mechanism for step 5) | `pnpm db:migrate` exits 0; `.it.test` still boots |
| 8 | AC-1, AC-4, AC-16, AC-33, AC-34, AC-37, AC-49, AC-58 (substrate); NFR-5 | `cd server && pnpm lint:arch && pnpm typecheck` |
| 9 | AC-18, AC-19, AC-20, AC-21, AC-22, AC-25, AC-60; NFR-3 | `server/test/file-summary-selection.test.ts` (new) |
| 10 | AC-26 | `server/test/file-summary-pipeline.test.ts` (new) |
| 11 | AC-12, AC-13, AC-15, AC-16, AC-17, AC-23, AC-24, AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34, AC-35, AC-37, AC-38, AC-39, AC-74; NFR-1, NFR-2, NFR-4, NFR-11 | `server/test/file-summary-pipeline.test.ts` (new) |
| 12 | AC-10 (service half), AC-36; NFR-10 | `cd server && pnpm lint:arch && pnpm typecheck` |
| 13 | AC-1, AC-2, AC-3, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-14; NFR-7 | `server/test/file-summary-routes.test.ts` (new) |
| 14 | verification for AC-1–39, AC-74; NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, NFR-7, NFR-10, NFR-11 | `cd server && pnpm test` + `file-summary.it.test.ts` (new) |
| **— BARRIER — Cut 1 ships and is reviewed —** | | |
| 15 | AC-54, AC-55, AC-56, AC-57; NFR-6 | `cd client && pnpm typecheck` |
| 16 | AC-58, AC-65, AC-66, AC-67, AC-68 (data model) | `.../DiffTab/helpers.test.ts` (extended) |
| 17 | AC-49, AC-50, AC-51, AC-52, AC-53, AC-58, AC-61, AC-62, AC-65, AC-66, AC-67, AC-69, AC-70, AC-72, AC-73 | `FileCard.test.tsx` (new) |
| 18 | AC-40, AC-41, AC-42, AC-43, AC-44, AC-45, AC-46, AC-47, AC-48, AC-59, AC-60, AC-63, AC-64, AC-71, AC-72 | `DiffTab.test.tsx` (extended) |
| 19 | AC-41, AC-58 (the head SHA reaches the tab) | `cd client && pnpm typecheck && pnpm test` |
| 20 | verification for AC-40–74; NFR-6, NFR-8's automatable rows | `cd client && pnpm test` |
| 21 | the full gate | *Verification*, every command |

**Requirements with no delivering step: none.** All 74 ACs and all 11 NFRs are assigned above.

**Already met by shipped code — the steps ASSERT them, they do not rebuild them (R-14).** AC-43 (`DiffTab.tsx:174` already hides the toggle at `groups.length === 0`), AC-45 (`DiffTab/constants.ts:45` + `helpers.ts:106-107` + `SmartDiffGroups.tsx:41`), AC-46 (`CodeLine.tsx:33-38`), AC-47 (`FileCard.tsx:156-168`, deliberately not `compact`). AC-44 is the one exception in that group and **is** real work: the labels and hints exist but the copy differs from the accepted category copy, so it is a `prReview.json` edit.

**Not covered by a command, stated rather than implied:** NFR-8's manual-once row (the focus ring's visibility against the sticky diff header) and NFR-9's manual-once row are both manual by the spec's own *Verification* table. Everything else has a command.

---

## Goal & scope

After this build, a reviewer on the Files changed tab sees a section headed `REVIEWER-ORDERED DIFF` with the PR's file count and aggregate `+`/`−` beneath it, an order toggle labelled `Smart order` / `Original order`, and one sentence saying how this ordering differs from the PR brief's review focus. Every file card's header is a real keyboard-operable disclosure control that exposes its expanded state. A file with a stored summary renders one line above its hunks saying what the change in it does, badged when the summary describes an older commit; a file without one offers a control whose accessible name says it spends a model call, disabled when the file has no patch. One PR-level derivation makes exactly one structured model call over the non-boilerplate, patch-bearing files in `core`-then-`wiring` order up to a 48 000-token cap, persists one row per summarised file keyed `(pr_id, path, head_sha)` with its apportioned share of the tokens and cost, and the tab renders the running total through the shared cost formatter with an explicit placeholder for `null`. Every line a finding points at now carries that finding's worst severity as an icon **and** a text label, derived from the same review set as the file's header badge.

**Not included:** anything under SPEC-03's Non-goals, unchanged — no rewrite of the L03 Smart Diff, no change to which group a file lands in, no model-driven ordering, no repo-intel or `file_rank` read, no absorption of SPEC-02's review focus, no `Severity` vocabulary change, no bare coloured dot, no change to `SmartDiff` / `SmartDiffFile` / `finding_lines` / `contracts/brief.ts`, no use or removal of `SmartDiffFile.pseudocode_summary`, **no `aria-pressed` on the order toggle (P-4, rejected)**, no MCP tool, no `reviewer-core` change, no `e2e/` flow, no URL-addressable summaries, and no fix for the 100-file GitHub ceiling (OQ-4). Scope is SPEC-03's Goals and Non-goals verbatim. This plan widens it in exactly **one** place: the PR-level derivation control in step 18, which no AC names but which AC-63 and AC-64 presuppose.

---

## Impact map

| Package / layer | Files | Kind of change | Risk |
|---|---|---|---|
| shared contracts (canonical) | `server/src/vendor/shared/contracts/file-summary.ts` (**new**), `contracts/platform.ts`, `index.ts` | 3 new schemas; `FeatureModelId` gains a value; `FEATURE_MODELS` gains an entry; 1 barrel line | **Touches `vendor/shared` → mirror sync + `check-contracts.sh` mandatory.** Mirror verified clean at `ff04b24`, so the `--fix` diff must carry **only** `contracts/file-summary.ts`, `contracts/platform.ts` and `index.ts` |
| client contract mirror | `client/src/vendor/shared/{index.ts,contracts/file-summary.ts,contracts/platform.ts}` | written by the script | low |
| **client feature-model registry** | `client/src/lib/feature-models.ts` | +1 entry, **by hand** | **NO GUARD.** Outside the only tree `check-contracts.sh` rsyncs. `check-contracts: OK` is true and irrelevant here — verified by the diff command at root `insights.md:217-227` |
| server module-shared | `server/src/modules/_shared/classify-path.ts` (**new**), `server/src/modules/pulls/smart-diff.ts` (re-export) | move + re-export | low; `server/test/smart-diff.test.ts:15-20` keeps compiling **because** of the re-export |
| server pricing | `server/src/adapters/llm/pricing.ts` | one row, one comment | **Changes persisted `cost_usd` for `review_intent` and `onboarding` too** — same default model. In the more-accurate direction (the table was 15.1% low), author-accepted (D-5) |
| server schema | `server/src/db/schema/reviews.ts` | +1 table | **Needs a migration.** `CREATE TABLE` only, so `db:generate` must not prompt |
| server migrations | `server/src/db/migrations/**` | drizzle-kit output | never hand-edited; next file lands as `0016_*.sql` |
| server module | `server/src/modules/file-summary/**` (**new**: `constants.ts`, `types.ts`, `schemas.ts`, `selection.ts`, `pipeline.ts`, `repository.ts`, `service.ts`, `routes.ts`); `src/modules/index.ts` (+1 import, +1 entry) | new module | low; the registry entry is what makes the routes exist |
| server prompts | `server/src/prompts/file-summary.system.md` (**new**) | new template | loaded by `renderPrompt`; the production `build` already copies `src/prompts` → `dist/prompts` |
| client hooks | `client/src/lib/hooks/file-summary.ts` (**new**), `hooks/keys.ts`, `hooks/index.ts` | new domain hook file + 1 key factory | low |
| **client shared components** | `client/src/components/diff-viewer/{annotations.ts,styles.ts,index.ts}`, `FileCard/FileCard.tsx`, `CodeLine/CodeLine.tsx`, `DiffViewer/DiffViewer.tsx` | header becomes a disclosure control; summary line; per-line severity; 1 pass-through prop | **medium-high.** `FileCard.tsx` is a SPEC-02 collision file (D-4 keeps its focus behaviour and both its assertions intact). `CodeLine` is on the render path of every diff line in the product |
| client studio | `.../DiffTab/{DiffTab.tsx,helpers.ts,constants.ts,styles.ts}`, `.../DiffTab/_components/SmartDiffGroups/SmartDiffGroups.tsx`, `.../pulls/[number]/page.tsx`, `client/messages/en/prReview.json` | chrome deltas, summary wiring, status region, copy | **medium.** `DiffTab.test.tsx` and `page.tsx` are SPEC-02 collision files; **seven shipped assertions change** (step 20) |
| `mcp`, `reviewer-core`, `e2e` | — | **none** | spec Non-goals; `mcp/`, `reviewer-core/` and `e2e/` hold zero references to any smart-diff or file-summary name |

**Does the wire format change?** Only additively. Two **new** endpoints (`GET`/`POST /pulls/:id/file-summaries`), one **new** contract file, one **new** `FeatureModelId` enum value (a widening — nothing rejects a value it did not previously accept), one **new** table. No endpoint removed, renamed or re-verbed; no request field made required; no served response field removed, retyped or weakened. `contracts/brief.ts` is not touched, which is what removes the `check-contracts.sh` collision with SPEC-02 entirely.

**The consumer inventory, including the one A-1 named.** `server/test/contracts.test.ts:1-18` is a **second, undocumented consumer of every `vendor/shared` shape** that no "who reads this contract" audit finds — not `api-breaking-changes` (it scans `client/src` call sites), not `response-schema`. It imports 16 shapes and constructs fixtures for them. It is in this inventory by name, checked, and **nothing in it breaks**: SPEC-03 adds a file and widens an enum. Step 1 adds a fixture row there anyway, so the new response shape gains the same net. Also checked and clean: `server/test/prompt-callers.test.ts` and `server/test/routes-smoke.test.ts` assert **no** prompt or route inventory, so a new prompt template and a new module break neither; and **no test asserts `FEATURE_MODELS`' length**, so the registry addition is safe.

**Does it need a migration?** Yes — step 6, generated, never hand-written.

---

## Execution — single-agent

One `implementer` executes steps 1 → 21 in order, in one context, and runs the verification itself. Steps 14 and 21 are gates, not code.

**The barrier after step 14 is real, not decorative.** `PrFileSummariesResponse` — settled in step 1, and reshaped by D-1's apportionment and D-2's read-time projection — is read again by the client hook (15), the annotation model (16), the file card (17), the tab (18) and every client assertion (20). Discovering the payload is wrong after step 18 costs the whole client cut. Do not begin step 15 until step 14's gate is green and the served payload has been reviewed.

**Why multi-agent was assessed and declined** (recorded so nobody redoes the analysis): the work does split — **G1** steps 1–2 (canonical contracts + both mirrors, necessarily one serialized writer, because canonical + rsync'd mirror + the hand-maintained `feature-models.ts` copy is one atomic edit), **G2** steps 3–14 (server), **G3** steps 15–20 (studio). It was declined for three reasons. First, there is strictly **less** parallelism available than SPEC-02 had: this spec's Non-goals rule out `mcp/`, `reviewer-core/` and `e2e/` entirely, and those were exactly the two groups (SPEC-02's G3 and G5) that were genuinely parallel with the server. Second, G3 is not parallel with G2 — its assertions are written against G2's **live payload**, not merely G1's types, and D-1/D-2 change that payload. Third, the **disjoint-files caveat bites hard inside G3**: the summary line, the derivation control, the per-line severity and the header disclosure control all land in `FileCard.tsx`, and the chrome deltas, the summary wiring, the status region and the annotations all land in `DiffTab.tsx` — two parallel client writers would collide in both files, which is worktree isolation or a barrier, not free parallelism. The split above stays recoverable if the build is ever resumed by more than one agent.

---

## Steps

### CUT 1 — contracts, the classifier promotion, pricing, schema, the server module

### Step 1 — Contracts: the new file-summary file, and `file_summary` in the registry · package: shared (canonical)

- **Files:** create `server/src/vendor/shared/contracts/file-summary.ts`; modify `server/src/vendor/shared/index.ts`, `server/src/vendor/shared/contracts/platform.ts`; modify `server/test/contracts.test.ts`
- **Satisfies:** AC-2, AC-21, AC-31, AC-33, AC-34, AC-59, AC-60 (payload shape)
- **Skills:** `zod`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck && pnpm exec vitest run contracts`
- **Done when:** `PrFileSummary`, `PrFileSummariesResponse`, `FileSummaryDeriveInput` are reachable as `@devdigest/shared` exports, `FeatureModelId.parse('file_summary')` succeeds, and `contracts.test.ts` is green with a new row for the response shape
- **Notes:**
  - **A NEW FILE, not an addition to `brief.ts`.** Three reasons, in the order they bite: it keeps SPEC-02's landed `brief.ts` edit collision-free; it keeps this feature's paid, staleness-bearing payload out of `GET /pulls/:id/smart-diff`, whose own route comment calls it *"safe to fetch on every render of the diff tab"* (`modules/pulls/routes.ts:37-42`); and `SmartDiff` has no field that could carry a head SHA, a provider, a model, token counts or a cost.
  - The shapes:
    ```ts
    export const PrFileSummary = z.object({
      path: z.string(),
      summary: z.string(),
      head_sha: z.string(),
      provider: z.string().nullish(),
      model: z.string().nullish(),
      tokens_in: z.number().int().nullish(),
      tokens_out: z.number().int().nullish(),
      cost_usd: z.number().nullable(),
      created_at: z.string(),
    });
    export const PrFileSummariesResponse = z.object({
      summaries: z.array(PrFileSummary),
      omitted_files: z.array(z.string()),
      selected: z.number().int(),
      total: z.number().int(),
    });
    export const FileSummaryDeriveInput = z.object({
      path: z.string().min(1).optional(),
      force: z.boolean().optional(),
    });
    ```
  - **`cost_usd` is `.nullable()`, NOT `.optional()`, and the comment must say why.** `null` is a *fact the studio must receive and render as a placeholder* — an `.optional()` field simply vanishes from the payload when absent and would be read as "not computed yet". Fields the API may never have computed (`provider`, `model`, `tokens_in`, `tokens_out`) are `.nullish()`, following the trap root `insights.md` records for `PrMeta`. `path`, `summary`, `head_sha` and `created_at` are **required**: a row cannot exist without them.
  - **D-1's semantics belong ON the fields**, at the point of temptation:
    > `// tokens_in / tokens_out / cost_usd are this file's SHARE of ONE structured`
    > `// call over N files, apportioned by prompt tokens (SPEC-03 plan D-1), so`
    > `// SUM(cost_usd) over one derivation's rows is exact — which is what makes`
    > `// NFR-1's ceiling and AC-59's running total the same arithmetic. Never read`
    > `// a single row's cost as the price of a call.`
  - **D-2's semantics belong on `omitted_files`:**
    > `// Computed AT READ TIME over the derivation-eligible set (non-boilerplate,`
    > `// patch non-null): eligible paths with no summary at the PR's current head.`
    > `// NOT a record of what one derivation's token cap dropped — the table has no`
    > `// column for that (SPEC-03 plan D-2). AC-51's per-file control is what tells`
    > `// "never derived" from "cap-omitted" on screen.`
  - **`platform.ts`, two edits, both additive:** `FeatureModelId` gains `'file_summary'`; `FEATURE_MODELS` gains `{ id: 'file_summary', label: 'PR Diff · File summaries', description: 'Writes a one-line summary of each changed file in a PR.', defaultProvider: 'openrouter', defaultModel: 'deepseek/deepseek-v4-flash' }`. The provider choice is load-bearing, not incidental — **AC-29 is only enforceable on OpenRouter**, because the structured-output preflight is gated on `choice.provider === 'openrouter'` (`platform/model-catalog.ts:53-55`: OpenAI and Anthropic publish no equivalent list). Say that in the entry's comment.
  - Names checked against the barrel for collision: `PrFileSummary`, `PrFileSummariesResponse`, `FileSummaryDeriveInput` are all free.
  - **`contracts.test.ts` gains one `it`** parsing a `PrFileSummariesResponse` fixture with a `null` `cost_usd` and a present one. This is the A-1 net: that file is a second consumer of every shared shape and no audit finds it. **Do not** touch its existing rows.
  - One Zod schema serves request validation **and** response serialization — declared on the route in step 13, never hand-validated in the service.

### Step 2 — Mirror the contracts, and the second feature-model copy · package: shared (mirror) + client

- **Files:** `client/src/vendor/shared/**` (written by the script); modify `client/src/lib/feature-models.ts` (**by hand**)
- **Satisfies:** AC-31 (client half); NFR-9 (mirror integrity)
- **Skills:** `zod`, `typescript-expert`
- **Depends on:** Step 1
- **Verify (all three, in order):**
  ```sh
  ./scripts/check-contracts.sh
  diff <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
           server/src/vendor/shared/contracts/platform.ts | tr -d "'\"") \
       <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
           client/src/lib/feature-models.ts | tr -d "'\"")
  cd client && pnpm typecheck
  ```
- **Done when:** the script prints `check-contracts: OK`, the diff exits **0**, and `cd client && pnpm typecheck` passes
- **Notes:**
  - Run `./scripts/check-contracts.sh --fix` (it always copies server → client), then read `git diff -- client/src/vendor/shared`.
  - Root `insights.md` warns `--fix` also lands **earlier unmirrored drift**, so the diff can be wider than the change. **It does not bite here:** `diff -rq server/src/vendor/shared client/src/vendor/shared` was **empty** at `ff04b24`, so the diff **must** contain exactly three files — `index.ts`, `contracts/file-summary.ts`, `contracts/platform.ts`. **If it contains anything else, stop** — that is drift which arrived after this plan was written and needs its own decision rather than being swept in.
  - **THE SECOND COPY IS THE PART WITH NO GUARD, and it is the whole of R-12.** `client/src/lib/feature-models.ts` is a hand-maintained mirror of `FEATURE_MODELS` living **outside** the only tree `check-contracts.sh` rsyncs, because the client cannot import a runtime **value** from `@devdigest/shared` — that breaks the webpack build only, while `typecheck` and `vitest` both pass. `check-contracts: OK` is therefore *true and irrelevant*. The diff command above is the only verification; it is in the Verify block for that reason, and root `insights.md:217-227` explains why a `grep -A<n>` comparison of the two blocks is noise (the server copy carries comments the client copy does not, so the window slides).
  - **Do not import a runtime value from `@devdigest/shared` anywhere in `client/`.** Types only.

### Step 3 — Promote `classifyPath` to module-shared · package: server

- **Files:** create `server/src/modules/_shared/classify-path.ts`; modify `server/src/modules/pulls/smart-diff.ts`
- **Satisfies:** AC-18 (mechanism)
- **Skills:** `onion-architecture` (**read first — it decides placement**)
- **Depends on:** —
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck && pnpm exec vitest run smart-diff`
- **Done when:** `classifyPath`, `LOCK_FILES`, `GENERATED_DIRS`, `GENERATED_FILE_RE`, `WIRING_FILES` and `WIRING_RULES` live in `_shared/classify-path.ts`; `smart-diff.ts` imports and **re-exports** `classifyPath`; `pnpm lint:arch` is clean; and `server/test/smart-diff.test.ts` passes **unchanged**
- **Notes:**
  - **The arch-lint consequence, stated because it is the reason for the choice.** `no-cross-module-internals` (`.dependency-cruiser.cjs:115-133`) forbids `modules/X` → `modules/Y` with a `pathNot` allow-list of `^src/modules/_shared/`, `^src/modules/$1/` and `(constants|types).ts`. So `modules/file-summary/selection.ts` importing `../_shared/classify-path.js` **passes** `pnpm lint:arch`, and importing `../pulls/smart-diff.js` **fails** it. That is the whole decision.
  - **The re-export is not cosmetic.** `server/test/smart-diff.test.ts:15-20` imports `classifyPath` from `../src/modules/pulls/smart-diff.js` and asserts 30+ paths against it. Re-exporting keeps that suite compiling and passing with **zero churn**, and it is the proof that this was a move, not a rewrite:
    ```ts
    // SPEC-03 — classifyPath moved to modules/_shared so the file-summary
    // derivation can honour AC-18 with the SAME rules the tab groups by.
    // `no-cross-module-internals` forbids modules/file-summary importing this
    // file; `_shared` is on its allow-list. Re-exported here so this module's
    // public identity is unchanged and there is exactly ONE implementation —
    // a second copy is precisely the disagreement AC-18 exists to prevent.
    export { classifyPath } from '../_shared/classify-path.js';
    ```
  - **Move the file's own comments with it**, including "Order matters: a `dist/index.js` is generated output first and an index file second" and the judgement-call note on docs. They are the reason the four mockup/classifier disagreements in D-13 are resolved the way they are, and a reader of `_shared` will have no other context.
  - **Change no rule.** The classifier is a Non-goal of this spec (`smart-diff.ts:114-128` is named as untouched). A behaviour change here would silently move which group four of nine files in the mockup land in.
  - Rejected alternatives, recorded so they are not revisited: `vendor/shared` (mirrors a server-only classifier into the client for nothing, and puts logic in the contracts ring), `platform/` (permitted by the lint, but that ring is "cross-cutting infrastructure" and this is module-shared pure logic), `reviewer-core` (npm churn, and path classification is not review domain).

### Step 4 — Correct the `deepseek/deepseek-v4-flash` price · package: server

- **Files:** modify `server/src/adapters/llm/pricing.ts`
- **Satisfies:** NFR-1 (its real-world half)
- **Skills:** —
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck && pnpm exec vitest run model-catalog`
- **Done when:** line 34's entry reads `{ in: 0.088606, out: 0.177212 }`, its comment names the confirmation date, and no test regresses
- **Notes:**
  - Live figures, confirmed against `openrouter.ai/api/v1/models`: `prompt 0.000000088606`, `completion 0.000000177212` per token → **$0.088606 in / $0.177212 out per 1M**. The shipped row is `{ in: 0.077, out: 0.154 }` — **15.1% low**.
  - **The stale comment block is lines 31-33 and the entry is line 34 ALONE.** SPEC-03's NFR-1 cites `pricing.ts:33-34`; that is imprecise and is listed as a spec text correction. Replace the "Confirmed … on 2026-08-17" sentence, keep the surrounding "APPROXIMATE and must be confirmed against openrouter.ai/models" warning — it is still true of every other OpenRouter row in the table.
  - **State the blast radius in the comment**, because it is author-accepted and not obvious: `review_intent` and `onboarding` both default to this same slug (`contracts/platform.ts:48-59`), so their persisted `cost_usd` moves too — in the **more accurate** direction. **Do not** substitute a neighbouring slug: `~-latest` is $0.03/$0.10, `-0731` is $0.07/$0.14, `-vision-exp` is $0.22/$0.66. The repo keys on the bare slug and that is correct.
  - **NFR-1's test stays on a stubbed price** (step 11), so the assertion is honest independently of this table. This step is about what the product persists, not about what the suite proves.

### Step 5 — Schema: the `pr_file_summaries` table · package: server

- **Files:** modify `server/src/db/schema/reviews.ts`
- **Satisfies:** AC-33 (persistence substrate), AC-58 (staleness key)
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck`
- **Done when:** `prFileSummaries` is declared with the composite PK and `pnpm typecheck` is clean
- **Notes:**
  - The spec's *Schema impact* SQL is the contract; declare it in Drizzle exactly:
    ```ts
    export const prFileSummaries = pgTable('pr_file_summaries', {
      prId: uuid('pr_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
      path: text('path').notNull(),
      headSha: text('head_sha').notNull(),
      summary: text('summary').notNull(),
      provider: text('provider'),
      model: text('model'),
      tokensIn: integer('tokens_in'),
      tokensOut: integer('tokens_out'),
      costUsd: doublePrecision('cost_usd'),
      createdAt: now(),
    }, (t) => ({ pk: primaryKey({ columns: [t.prId, t.path, t.headSha] }) }));
    ```
  - **Placed in `schema/reviews.ts`, beside `pr_intent` and `pr_brief`** — the family of derived per-PR artifacts. `schema/pulls.ts` is the family of GitHub-mirrored raw rows. This keeps the barrel (`db/schema.ts`) untouched.
  - **Why a table and not a column on `pr_files`** — put this in the table's docstring, because the next reader will ask: `replaceFiles` is a wholesale `DELETE`+`INSERT` (`modules/pulls/repository.ts:114-123`) fired by `getDetail` on **every** `GET /pulls/:id` when GitHub is reachable (`modules/pulls/service.ts:160-190`). A summary column would be destroyed by the next page load. This is the whole justification for P-5.
  - **`head_sha` is part of the PK and therefore `NOT NULL`** — unlike `pr_intent.head_sha`, which is nullable and treated as stale (`schema/reviews.ts:77`). A summary cannot exist without naming the commit it describes, which is what makes AC-58 a comparison rather than a guess, and what makes a force-push produce a **new** row instead of silently overwriting the description of the old patch. **And note D-2 in the same docstring:** because rows accumulate per head SHA, the read projects to **one row per path**; without that projection AC-49 and AC-58 would both fire for one file and NFR-5's 32 KB ceiling would be unbounded across force-pushes.
  - **No separate index on the FK.** Postgres does not auto-index FK columns, but `pr_id` is the **leading** column of the composite PK, so its B-tree already serves both the cascade and every read this feature performs (`WHERE pr_id = $1`, optionally `AND head_sha = $2`). A second index would be dead weight.
  - **No `workspace_id`.** Scopes through `pr_id → pull_requests.workspace_id`, exactly as `pr_intent` and `pr_brief` do. Following the siblings rather than re-tenanting a new table beside two that do not; **AC-4 asserts the scoping holds**, at the repository, which is where the criterion lives.
  - **`createdAt` uses the shared `now()` helper** (`db/schema/_shared.ts:9`), and the upsert **must set it from SQL on conflict** — see step 8.
  - **Deliberate deviation from `postgresql-table-design`:** the skill prefers a `BIGINT GENERATED ALWAYS AS IDENTITY` surrogate key. This table's PK is a natural composite whose third column *is* the staleness key the feature reads on, and every one of this repo's ~35 tables uses `uuid().defaultRandom()` or a composite/borrowed PK. Consistency and the AC-58 semantics both win.
  - **No GIN index and no JSONB.** Nothing queries inside a summary.

### Step 6 — Generate the migration · package: server

- **Files:** `server/src/db/migrations/**` (drizzle-kit output — **never** hand-edited)
- **Satisfies:** — (mechanism for step 5)
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 5
- **Verify:** `cd server && pnpm db:generate`
- **Done when:** exactly one new `.sql` plus its journal entry and snapshot exist, and its contents are **only** a `CREATE TABLE "pr_file_summaries"` with its PK constraint and FK
- **Notes:**
  - `db:generate` diffs against the highest-numbered **snapshot**, ignoring the journal, and **prompts interactively** when a table both gains and loses a column (server `insights.md` 2026-08-11, ×2 entries). **This migration only creates, so it must not prompt.** If it does, step 5 touched an existing table — stop and fix step 5.
  - **Read the generated SQL before moving on.** A `DROP`, or an `ALTER` against any table other than the new one, means step 5 edited `reviews.ts` wrongly — stop rather than migrate.
  - The next file lands as `0016_*.sql`; the last applied is `0015_tense_menace.sql` (journal `idx: 15`).

### Step 7 — Apply the migration · package: server

- **Files:** none (DB state)
- **Satisfies:** — (mechanism for step 5)
- **Skills:** `drizzle-orm-patterns`
- **Verify:**
  ```sh
  export DOCKER_HOST="unix:///Users/kyrylo.myronov/.colima/default/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  cd server && pnpm db:migrate            # must exit 0
  cd server && pnpm exec vitest run .it.test   # must still boot its testcontainer
  ```
- **Depends on:** Step 6
- **Done when:** both commands succeed
- **Notes:** **Migrations do not run on boot** — this is the step that makes the table exist, and a later `relation "pr_file_summaries" does not exist` is always a missing `db:migrate`. **Environment-dependent, and the two exports are not optional here:** without them `docker info` succeeds, the active context is colima, `DOCKER_HOST` is unset, and `testcontainers@10.28.0` fails with `Could not find a working container runtime strategy` at `test/helpers/pg.ts:36` — fifteen `.it.test.ts` files then report as **failed suites with zero failed tests**, which reads exactly like an environment skip. With the exports, the server lane is 50 files / 521 tests, all passing.

### Step 8 — Module: constants, types, repository · package: server

- **Files:** create `server/src/modules/file-summary/{constants.ts,types.ts,repository.ts}`
- **Satisfies:** AC-1, AC-4, AC-16, AC-33, AC-34, AC-37, AC-49, AC-58 (substrate); NFR-5
- **Skills:** `onion-architecture` (**read first**), `drizzle-orm-patterns`
- **Depends on:** Steps 1, 5
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** `lint:arch` passes with the new folder in place, and `listSummaries` / `upsertSummaries` round-trip
- **Notes:**
  - **`constants.ts` is PUBLIC surface** (`no-cross-module-internals` whitelists `constants.ts` and `types.ts`), so **every number an AC or NFR names lives here** and each is a one-line edit:
    ```ts
    export const FILE_SUMMARY_DERIVE_JOB_KIND = 'file-summary.derive';
    export const FILE_SUMMARY_SCHEMA_NAME = 'PrFileSummaries';
    export const FILE_SUMMARY_PROMPT_TOKEN_CAP = 48_000;   // NFR-3
    export const FILE_SUMMARY_MAX_OUTPUT_TOKENS = 2_000;   // AC-23
    export const FILE_SUMMARY_LLM_MAX_RETRIES = 0;         // AC-39, NFR-2
    export const MAX_FILE_SUMMARY_CHARS = 240;             // NFR-4, AC-28, AC-74
    ```
  - **`FILE_SUMMARY_SCHEMA_NAME` must not collide** with `INTENT_SCHEMA_NAME` (`'PrIntent'`) or `BRIEF_SCHEMA_NAME` (`'PrRiskBrief'`) — a collision poisons a provider's schema cache and, worse, a test harness's `MockLLMProvider.structuredBySchema` map.
  - **`FILE_SUMMARY_PROMPT_TOKEN_CAP` is a COST control, not a safety margin — comment it that way.** Research closed the question: `deepseek/deepseek-v4-flash`'s context window is **1 048 576** tokens with max completion **384 000** (not the 131 072 the rendered model page shows). 48 000 in + 2 000 out is **~4.8% of the window**, so our cap fires roughly 20× below the provider limit and "does OpenRouter reject or silently truncate an oversized request" **cannot be reached by this feature**. Do not write the comment as if it guards against provider rejection.
  - **`FILE_SUMMARY_MAX_OUTPUT_TOKENS` is set explicitly and must never be omitted.** Root `insights.md` 2026-08-22: omitting `max_tokens` makes OpenRouter reserve the model's **full** output window against the account balance and **402 a low-credit account before the call runs**. Cite that entry in preference to a vendor page — OpenRouter documents `max_tokens` as merely optional and documents the credit-reservation mechanic nowhere. 2 000 is generous: at ~25 tokens per one-line summary, 28 files is ~700.
  - Carry the job-kind docstring the sibling modules write: the derivation goes through `JobRunner` because it makes a model call; **JobRunner retries a REJECTED handler twice** (`platform/jobs.ts:41`, default `2`), which for a deterministic failure would mean three billed derivations — which is why AC-15's never-throws contract is load-bearing.
  - **`types.ts` is the other public surface:** `FileSummaryJobPayload { workspaceId; prId; path?; force? }`; `FileSummarySkipReason = 'no_files' | 'llm_unavailable' | 'model_unsupported' | 'llm_failed' | 'parse_failed'`; `DeriveFileSummariesOutcome { correlationId; summaries?: PrFileSummary[]; omitted?: string[]; reason?: FileSummarySkipReason; cached?: boolean }`. Mirror `BriefSkipReason`'s vocabulary so the three derivation surfaces read alike.
  - **`repository.ts` is the ONLY file in this module allowed to import `drizzle-orm`** — `no-drizzle-outside-persistence` whitelists `^src/modules/[^/]+/repository\.ts$`.
  - **`listSummaries(workspaceId, prId)` is D-2, and its ORDER BY is the whole decision:**
    ```
    SELECT DISTINCT ON (fs.path) fs.*
      FROM pr_file_summaries fs
      JOIN pull_requests p ON p.id = fs.pr_id
     WHERE fs.pr_id = $1 AND p.workspace_id = $2
     ORDER BY fs.path, (fs.head_sha = p.head_sha) DESC, fs.created_at DESC
    ```
    **The `(fs.head_sha = p.head_sha) DESC` term is not decoration.** It makes a current-head row always win, so **AC-49** renders the fresh summary and **AC-58** fires only when *no* current-head row exists — which is the only reading under which the two criteria do not both apply to the same file. It also removes the same-millisecond `created_at` tie entirely. Prefer Drizzle's `selectDistinctOn([t.prFileSummaries.path])`; if that helper is unavailable in 0.38, a raw `sql` fragment or a fetch-all-plus-reduce **in this file** is acceptable — it is still one query and the dedupe is deterministic — but say which you used in a comment.
  - **AC-4 LIVES HERE.** Every read joins `pull_requests` and filters on `workspace_id`; do not rely on the service having checked. The criterion is about the query, and the it-test reads the same PR id under a second workspace.
  - **`upsertSummaries(rows)`** — one statement, `onConflictDoUpdate` on `(prId, path, headSha)`, and **`createdAt` MUST be set from SQL `now()` in the `set` clause**, never `new Date()`. Server `insights.md` 2026-08-17: the column's default fires only on insert, so an omitted `createdAt` keeps the original timestamp and the row reads as never re-derived; and stamping a Node clock over a Postgres clock can go **backwards** under a VM-hosted Postgres. D-2's `created_at DESC` tie-break depends on this being right.
  - **AC-37 is enforced by the caller, asserted here by shape:** `upsertSummaries` takes rows and writes them; the pipeline is what guarantees every row's path was in that derivation's own selection. Say so in the file header so nobody adds a "write whatever the model said" convenience later.
  - **A failed derivation writes NOTHING.** Unlike `pr_brief`, a failure row here would not overwrite a good one (the PK includes `head_sha`), but it would still be served by `listSummaries` as a summary. State it in the header: do **not** add an error-recording write.

### Step 9 — Selection, the token cap, the prompt, and the apportionment · package: server

- **Files:** create `server/src/modules/file-summary/selection.ts`; create `server/test/file-summary-selection.test.ts`
- **Satisfies:** AC-18, AC-19, AC-20, AC-21, AC-22, AC-25, AC-60; NFR-3
- **Skills:** `onion-architecture`, `typescript-expert`
- **Depends on:** Steps 3, 8
- **Verify:** `cd server && pnpm exec vitest run file-summary-selection && pnpm lint:arch`
- **Done when:** a generated **300-file / 30 000-line** fixture yields an assembled message at or under **48 000** tokens measured by `container.tokenizer`; every admitted path appears in `core`-then-`wiring`, descending-changed-lines order; every excluded path appears in the returned `omitted`; and `apportion`'s outputs sum **exactly** to their input for `null`, `0` and a real amount
- **Notes:**
  - `type PrFileRow = typeof schema.prFiles.$inferSelect` **declared locally**, with the comment `modules/brief/{pipeline,sources}.ts` uses for `RepoRow`: `no-cross-module-internals` forbids importing it from `modules/pulls/repository.ts:16`, and `db/rows.ts` does not carry it. Without the comment the next reader will "fix" it into a cross-module import and break `lint:arch`.
  - **`selectFiles(files, args)` — the algorithm, each clause with its criterion:**
    1. **AC-22** — drop every file whose `patch` is `null` (binary, rename-only, mode-only, GitHub-truncated). Unqualified in the spec, so it applies to the per-file path too: a per-file request naming a null-patch file yields an **empty selection**, which the pipeline exits as `no_files`.
    2. **AC-12** — when `args.path` is set, the selection is that one file (after clause 1). **AC-18's boilerplate exclusion does NOT apply**: AC-18 says "from a **PR-level** derivation's selection", and a reviewer who explicitly asks for a lock file's summary should get one.
    3. **AC-18** — for a PR-level derivation, drop every file `classifyPath` assigns `'boilerplate'`, imported from `../_shared/classify-path.js` (step 3).
    4. **AC-19** — sort `core` before `wiring`, then by `additions + deletions` **descending**, then `path.localeCompare` as a stable tie-break so the order is testable.
  - **AC-13/AC-19 vs the shipped render order — do NOT "align" them (R-13).** `buildSmartDiff` sorts *within a group* by finding-lines first, then size (`smart-diff.ts:313-318`). That is the order to **open** files in. AC-19 is the order to **spend tokens** in. Two different concerns; a comment in both files.
  - **`assembleFileSummaryPrompt(container, args)` — AC-20/AC-21/AC-25:** budget = `FILE_SUMMARY_PROMPT_TOKEN_CAP` − tokenised system prompt − tokenised task line; accumulate one `wrapUntrusted('file:<path>', patch)` block per file **in the AC-19 order** while the running count stays inside the budget; return `{ message, admitted: {path, tokens}[], omitted: string[] }` where `omitted` is **the tail in the same order**, so it is stable. A single file too large for the whole budget is omitted rather than half-sent.
  - **AC-25:** every patch goes through `wrapUntrusted` imported from `server/src/platform/prompt.js` — a thin re-export over `reviewer-core/src/prompt.ts:41-45`, which also **neutralises an attempt to close the fence from inside** by rewriting `</untrusted>`. **No patch text reaches the message unfenced**, and the test asserts it by counting fences against admitted files.
  - Resolve the tokenizer from `container.tokenizer` — **never construct one.** The BPE ranks load once per process (`container.ts:172-176` memoises with `??=`), and `TiktokenTokenizer.count` already catches internally and falls back to a character estimate (`adapters/tokenizer/index.ts:30-40`).
  - **`apportion(total, weights)` is D-1, and it lives here** because `admitted[].tokens` is the weight vector:
    - `total === null` → every share `null`. This is AC-34's unpriced case, and it must **never** become `0`.
    - `total === 0` → every share `0`. AC-34's genuinely-free case. **Never coalesce the two** (root `insights.md`, the `null` ≠ `0` entry).
    - otherwise → proportional, with the **remainder assigned to the largest weight** so `sum(shares) === total` exactly. Integer apportionment for `tokens_in`/`tokens_out`, float for `cost_usd`.
    - a single-file selection receives the whole aggregate, which falls out of the formula.
    Write the exactness property as a test, not just a comment: **NFR-1 measures the sum across a derivation's rows and AC-59 renders the same sum**, so a rounding leak is a wrong dollar figure on screen.
  - **`eligibleFor(files)`** — the read-path half of D-2, exported here so the service and the pipeline cannot disagree about what "eligible" means: `patch !== null && classifyPath(path) !== 'boilerplate'`. `total` in the response is `eligibleFor(files).length`; a boilerplate file is never in the denominator, because AC-18 means it is never a candidate.
  - **NFR-11:** this file produces prompt text and **must not log any of it**. Names, provenance and sizes only.
  - Tests: the 300-file/30 000-line generated fixture (**D-30 — `server/src/db/seed.ts:141-145` seeds PR #482 with four files and NO patch text at all, and seeds neither `package.json` nor `src/server.ts`, so every budget and ordering row needs a generated fixture, not the seed**); a fixture containing `pnpm-lock.yaml` asserting it is absent from a PR-level selection but **present** for an explicit per-file request; a mixed core/wiring fixture asserting the exact order; a fixture past the cap asserting **which paths reached the prompt** and **which were recorded as omitted**; a `null`-patch fixture; a patch containing `</untrusted>` and an instruction, asserting the fence count and the neutralisation; and the three `apportion` cases.

### Step 10 — The system prompt template · package: server

- **Files:** create `server/src/prompts/file-summary.system.md`
- **Satisfies:** AC-26
- **Skills:** — (prose; follow [`docs/agent-prompts/README.md`](../../docs/agent-prompts/README.md) for slot order and authoring rules — cited, not restated)
- **Depends on:** —
- **Verify:** `cd server && pnpm exec vitest run file-summary-pipeline` (step 11 carries the AC-26 assertion)
- **Done when:** `renderPrompt('file-summary.system.md', {})` returns text containing an explicit data-not-instructions rule
- **Notes:**
  - Loaded by `renderPrompt` (`server/src/platform/prompts.ts:40`), exactly as `review-intent.system.md` and `risk-brief.system.md` are. Templates are read relative to the module — `src/prompts` under `tsx`, `dist/prompts` in a compiled build — and the production `build` already copies them.
  - **AC-26 is load-bearing precisely because this is a standalone structured call.** It does **not** pass through `assemblePrompt`, so the `INJECTION_GUARD` / `OUTPUT_LANGUAGE_RULE` pair appended at `reviewer-core/src/prompt.ts:175` never reaches it. The template must carry the data-not-instructions rule **in its own words** — the same position the intent classifier and the risk brief are in.
  - Include the output-language rule as **one isolatable paragraph**, modelled on `OUTPUT_LANGUAGE_RULE` (`reviewer-core/src/prompt.ts:35-39`): every summary in English regardless of the diff's language; code, identifiers and string literals quoted verbatim. This mirrors SPEC-02's D-11 and, like it, is covered by **no AC** — keep it deletable in one edit and record it in *Open questions*.
  - The template must instruct the model to: return **one summary per given file path, verbatim as given**; describe **what the change does**, not what the file is; keep each summary to **one sentence under 240 characters**; and name concrete identifiers from the patch rather than generalities. The length is **asked** here and **clamped in code** in step 11 (AC-28/AC-74), because a strict `json_schema` ignores `.max()`.
  - **Determinism, and what is deliberately not asserted:** `temperature: 0` is the OpenRouter adapter's default (`reviewer-core/src/llm/openrouter.ts:85`), and two runs over the same diff are **not** required to agree. No AC pins the prose, because a structured summariser over a large diff does not reliably reproduce wording and a test that pinned it would be a flake generator. What is asserted is that whatever it produces is path-gated, clamped and persisted with provenance. **Do not add a snapshot test of the model's text.**

### Step 11 — The derivation pipeline · package: server

- **Files:** create `server/src/modules/file-summary/{schemas.ts,pipeline.ts}`; create `server/test/file-summary-pipeline.test.ts` and `server/test/helpers/file-summary.ts`
- **Satisfies:** AC-12, AC-13, AC-15, AC-16, AC-17, AC-23, AC-24, AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34, AC-35, AC-37, AC-38, AC-39, AC-74; NFR-1, NFR-2, NFR-4, NFR-11
- **Skills:** `onion-architecture`, `zod`
- **Depends on:** Steps 8, 9, 10
- **Verify:** `cd server && pnpm exec vitest run file-summary-pipeline && pnpm lint:arch`
- **Done when:** every criterion above has a **named** assertion in `file-summary-pipeline.test.ts`, running with **no database and no real model**
- **Notes:**
  - **Shape:** `export async function deriveFileSummaries(container: Container, repository: FileSummaryRepository, args: DeriveFileSummariesArgs): Promise<DeriveFileSummariesOutcome>` — a standalone function over `(container, repository, args)`, **not** a service method, mirroring `modules/brief/pipeline.ts:62-66` and `reviews/intent-pipeline.ts:23-38`, so the whole flow is drivable in a hermetic unit test with stubs: no Docker, no model, no clone.
  - **AC-15 is the contract of this file: it NEVER throws.** Every exit path returns an outcome. Wrap the body in the same catch-all `modules/brief/pipeline.ts:263-268` uses, with the same explanation in the header: JobRunner retries a rejected handler twice, so a deterministic throw is three billed derivations.
  - **Order of operations, each with the criterion it carries:**
    1. **Files** — `container.pullsRepo.listFiles(pull.id)`. This is the sanctioned cross-module seam; `no-cross-module-internals` forbids importing `modules/pulls` directly. An empty list exits `reason: 'no_files'`.
    2. **Select** — `selectFiles` from step 9 (**AC-12**, **AC-13**, **AC-18**, **AC-19**, **AC-22**). An empty selection exits `no_files` with **no model request**.
    3. **Cache** — unless `args.force`, read the stored rows for `(pr, head)` and drop from the selection every path already stored at that head (**AC-16**); if the selection empties, return `{ cached: true }` with **no model request**. With `force`, skip this entirely (**AC-17**). Keyed on `(pr_id, path, head_sha)`, not `pr_id` alone: a force-push means the stored summary describes code that no longer exists.
    4. **Model resolution** — `await container.featureModel(workspaceId, 'file_summary')` (**AC-31**). Assert the **id string** passed, per the spec's AC-31 verification row.
    5. **Provider** — `await container.llm(choice.provider)` in a try/catch; on throw, exit `reason: 'llm_unavailable'` (**AC-32**). A missing key throws `ConfigError` from `buildLlm` — **and this is Goal 6's exit**: the diff, its order and its groups are untouched.
    6. **Preflight** — **only when `choice.provider === 'openrouter'`**: `await container.modelCatalog.supportsStructuredOutputs(choice.model).catch(() => null)`. **Only an explicit `false` blocks** (`reason: 'model_unsupported'`, **AC-29**); `null` means the catalogue could not tell us, and our ignorance is not the model's limitation, so the derivation proceeds (**AC-30**). Copy `modules/brief/pipeline.ts:112-122` exactly, `.catch(() => null)` included. Research note for the comment: the bare slug's `supported_parameters` **does** contain `structured_outputs` **and** `response_format`, so in the default configuration this resolves `true` and proceeds; OQ-2's per-provider variance is unchanged by that and stays deferred, with **AC-27** as its catch.
    7. **Assemble + log** — `logPromptAssembly(runLog.stdout, { correlationId, stage: 'file-summary', provider, model, prId }, sections, { verbose })`. `PromptLogContext.stage` is an untyped `string` (`platform/prompt-log.ts:48`), so **this needs no contract change**.
    8. **ONE call** (**AC-24**, **NFR-2**) — `llm.completeStructured({ model, schema: FileSummaryExtractionSchema, schemaName: FILE_SUMMARY_SCHEMA_NAME, maxRetries: FILE_SUMMARY_LLM_MAX_RETRIES /* 0 */, maxTokens: FILE_SUMMARY_MAX_OUTPUT_TOKENS, sessionId: `${repo.owner}/${repo.name}#${pull.number}:file-summary`, messages: [system, user] })`. **`maxRetries: 0` makes AC-24 literally true**: the provider loops `maxRetries + 1` times (`adapters/llm/openai.ts:88`), so any other value would make "exactly one" false and turn NFR-1's ceiling into a per-attempt figure. **AC-23** is the explicit `maxTokens`; assert the field on the captured request. On throw, exit `reason: 'llm_failed'` — **AC-39**: abandoned, never re-issued.
    9. **Parse** (**AC-27**) — a failure to validate against `FileSummaryExtractionSchema` exits `reason: 'parse_failed'` and **persists nothing**.
    10. **Path-gate** (**AC-38**, **AC-37**) — discard every returned path that is **not in this derivation's own selection**, with a recorded reason. This is the stronger of the two checks the spec names: AC-38 says "not a changed file of the PR" and AC-37 says "only for a path that was in that derivation's own selection" — gating on the **selection** satisfies both, and it is what stops the model attaching a summary to a boilerplate file it was told to skip.
    11. **Clamp in code** (**AC-28**, **AC-74**) — `slice(0, MAX_FILE_SUMMARY_CHARS)`. Strict `json_schema` ignores `.max()`, which is why this is a code step, exactly as the intent and brief modules do. **AC-74 is the direction of the rule: truncate and KEEP, never reject the derivation.** Assert the persisted value's **tail** for a 900-character summary *and* that the outcome still reports success.
    12. **Apportion** (**AC-33**, **AC-34**, D-1) — `apportion(extraction.costUsd, weights)`, `apportion(extraction.tokensIn, weights)`, `apportion(extraction.tokensOut, weights)`, weights from `admitted[].tokens`. `cost_usd` comes from `StructuredResult.costUsd`, which is `estimateCost(model, tokensIn, tokensOut)` (`adapters/llm/pricing.ts:40-44`) → `null` for a model absent from the table, a real `0` for one priced at zero. **Never coalesce.**
    13. **Persist** (**AC-33**) — one `upsertSummaries` writing N rows, each with its path, summary, `head_sha`, provider, model and its **share**. **A rejection is caught and logged, and the derived summaries are STILL returned to the caller** (**AC-35**): a write failure must not lose the derivation already paid for.
  - **`schemas.ts` holds `FileSummaryExtractionSchema` — a LOCAL Zod schema, NOT a shared contract.** It is the LLM's output shape, not a wire shape; `reviews/intent-schemas.ts` and `modules/brief/schemas.ts` are the precedents. **Root is an object, not a bare array** — `z.object({ summaries: z.array(z.object({ path: z.string(), summary: z.string() })) })` — because strict `json_schema` requires an object root. Say so in a comment; the spec's *Model & prompt* says "an array of `{path, summary}`" and that is the only place this plan reads it differently.
  - **NFR-11:** one `correlationId` per derivation, echoed in the outcome so the caller's later log lines share it; **exactly one log line per exit path**, and **every failure exit at `error`** — the level that reaches the user as a toast. **No summary text, patch text or PR body in any log line**; names, provenance and sizes only, as `logPromptAssembly` already does. Assert both on a captured logger, including a negative assertion that no log line contains the fixture's patch **or** summary text.
  - **NFR-1's measurement:** drive the stubbed provider to report usage, run it through the shipped `estimateCost` **against a stubbed price**, and assert the **summed** `cost_usd` across the derivation's rows is ≤ $0.02. Keeping the price stubbed is what makes the assertion honest independently of step 4's table. The real-world arithmetic, for the comment: 48 000 × $0.088606/1M ≈ $0.00425 in, plus ~700 output tokens × $0.177212/1M ≈ $0.00012 out → **≈ $0.0044**, about 4.5× headroom. **The figure does not survive an OpenRouter override to another slug** — `pricing.ts:31-33` marks those rows approximate in its own words.
  - **`test/helpers/file-summary.ts`:** export `fileSummaryLlm(fixture)` returning `new MockLLMProvider('openrouter', { structuredBySchema: { [FILE_SUMMARY_SCHEMA_NAME]: fixture } })`, mirroring `test/helpers/{intent,brief}.ts` **including their warning comment**. **This is not optional bookkeeping.** `file_summary` defaults to `openrouter`, which `reviews.it.test.ts` and `intent.it.test.ts` already stub — a file-summary derivation reaching one of those harnesses would receive an *intent* or *review* fixture. `structuredBySchema` is exactly what prevents it, and the general rule from server `insights.md` 2026-08-17 applies: **override every provider the code will resolve, not just the one you are testing.** The tell that you hit a live, billable model is an assertion failing against a value that exists in a **prompt file** rather than in your fixture.
  - **NFR-2:** assert the mocked provider's call count is exactly 1 for a ten-file selection, and exactly 1 after an injected request failure (i.e. no retry).

### Step 12 — Service and job registration · package: server

- **Files:** create `server/src/modules/file-summary/service.ts`
- **Satisfies:** AC-10 (service half), AC-36; NFR-10
- **Skills:** `onion-architecture`
- **Depends on:** Steps 8, 11
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** `getSummaries`, `enqueueDerivation`, `registerJobHandler` and `runDerivation` exist and `lint:arch` passes
- **Notes:**
  - Copy `BriefService` shape for shape (`modules/brief/service.ts`), which itself copies `ReviewService`'s intent quartet:
    - **`getSummaries(workspaceId, prId)`** validates the PR first (404 on unknown) and **never derives** — a `GET` must not spend a model call (**AC-7**); the intent route refuses this explicitly and both siblings follow it. **This method is where D-2's projection is completed:** it reads the deduped rows from `listSummaries`, reads `container.pullsRepo.listFiles(prId)`, computes `total = eligibleFor(files).length`, `selected =` eligible paths with a row at `pull.headSha`, and `omitted_files =` eligible paths **without** one, in `selectFiles`' own AC-19 order so the list is stable and testable. **`classifyPath` is business logic and belongs here, not in the repository** — the repository stays SQL.
    - **`enqueueDerivation(workspaceId, prId, input)`** validates the PR **in the enqueue, not in the handler**, so an unknown id 404s instead of being accepted and silently discarded. **AC-14 lives here too:** when `input.path` is set, it must be a changed file of that PR (`listFiles`), else throw a 422 `AppError` **before** enqueuing — and the test asserts the job count is zero, because "without enqueuing a job" is half the criterion. Returns the job id, or **`null` when the enqueue itself failed** — `JobRunner.enqueue` throws when no handler is registered for the kind (`platform/jobs.ts:49`), which is the path **AC-10** describes.
    - **`registerJobHandler()`** registers with `container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, …)` and **deliberately swallows** (`.catch(() => undefined)`), because a rejected handler is retried twice and the pipeline has already persisted (or deliberately not persisted) its own outcome and logged the reason. Called once, from the routes plugin — same as `registerBriefJobHandler`.
    - **`runDerivation(workspaceId, prId, opts)`** runs a derivation inline, used by the job handler and by tests, **not reachable from a route**. Builds a `RunLogger` with no run ids (`new RunLogger(container.runBus, [], opts.logger, { prId })`) so events mirror to pino only.
  - **AC-36 / NFR-10 are JobRunner's own behaviour, not code here.** The runner is constructed with no options (`platform/container.ts:97`), so its defaults apply: concurrency 3, timeout **120 000 ms**, two retries. Assert it in the it-test (step 14) with a handler that outlives the timeout, checking the `jobs` row status **and** that `pr_file_summaries` is unchanged.
  - `service.ts` may **not** import `src/db/schema` (`no-db-schema-above-repository`) — go through `repository.ts` and `container.pullsRepo`, the sanctioned cross-module seam. It may import `../_shared/classify-path.js` (step 3's whole point).

### Step 13 — Routes and module registration · package: server

- **Files:** create `server/src/modules/file-summary/routes.ts`; modify `server/src/modules/index.ts` (one import + one registry entry); create `server/test/file-summary-routes.test.ts`
- **Satisfies:** AC-1, AC-2, AC-3, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-14; NFR-7
- **Skills:** `fastify-best-practices`, `zod`, `onion-architecture`
- **Depends on:** Step 12
- **Verify:** `cd server && pnpm exec vitest run file-summary-routes && pnpm lint:arch && pnpm typecheck`
- **Done when:** both routes answer under `app.inject()`, `fileSummary` appears in the registry, and the AC-11 test observes a 429 on the eleventh request
- **Notes:**
  - Model on `modules/brief/routes.ts` — the closest sibling. **Transport only:** every handler starts with `await getContext(container, req)` for tenancy, then delegates. No business logic, no HTTP types below this file.
  - **AC-2 / AC-3 → declare the response schema:** `{ schema: { params: IdParams, response: { 200: PrFileSummariesResponse } } }`. Server `insights.md` 2026-08-18 confirms a Zod `response:` schema works — both compilers are installed at `app.ts:64-65` and the convention simply had zero adoption — and that a drifted payload **fails at serialization instead of reaching the studio**, which is exactly **AC-3**. Note from the same entry: the schema **strips unknown keys**, so a service returning extra fields would silently stop sending them. The service composes exactly `PrFileSummariesResponse`; keep it that way. **AC-1's empty case needs no envelope and no `null`**: the response is an object with `summaries: []`, so SPEC-02's R-9 question does not recur here (and it is settled anyway — server `insights.md` 2026-08-28).
  - **AC-6 is free:** `IdParams = z.object({ id: z.string().uuid() })` (`modules/_shared/schemas.ts:11`) rejects a non-uuid at validation, **before** the handler runs. The test asserts **422 and that the repository stub recorded zero calls** — "without reaching the database" is half the criterion.
  - **R-10 IS A GATE IN THIS STEP, NOT A NOTE.** SPEC-03 declares `FileSummaryDeriveInput` as a contract and the repo convention is "one Zod schema serves request validation and response serialization", but the sibling `POST /pulls/:id/brief` deliberately declares **no** `body:` schema and hand-parses (`modules/brief/routes.ts:56-69`), because a body-less POST is a real client shape (`client/src/lib/api.ts:26`; client `insights.md` 2026-07-30 records the API rejecting one). **So: declare `body: FileSummaryDeriveInput` and prove, in this step's route test with a real `app.inject()`, that a POST with NO body at all still returns 202 — BEFORE anything downstream is built on it.** If it does not, the fallback is the sibling's tolerant manual parse with the contract used for client typing only — **and that comes back to the author as a plan amendment appended to this file, not chosen silently.** This is deliberately the same shape as SPEC-02's step-12 R-9 gate, which is the reason that risk cost nothing.
  - **`POST /pulls/:id/file-summaries`** → `reply.code(202)`, body `{ status: 'accepted', jobId }` or `{ status: 'accepted', degraded: true, reason: 'no_handler' }` (**AC-8**, **AC-10**), with `config: { rateLimit: { max: 10, timeWindow: '1 minute' } }` (**AC-11**, **NFR-7**). 202 whether or not the enqueue took, so the studio has one path: poll until fresh. An unknown PR still 404s (**AC-5**).
  - **NFR-7's 10, not the intent/brief 5, and the reason belongs in the comment:** one route serves two shapes and the cheap per-file shape is clicked while reading; a limit of 5 would stop a reviewer mid-file on a nine-file PR.
  - **AC-11's test is the non-standard one (R-11).** `@fastify/rate-limit` registers only when `config.nodeEnv !== 'test'` (`app.ts:102-106`), and a per-route `config.rateLimit` is **inert** without the plugin — so under the standard test app **no test can observe it** and the criterion would ship green and unproven. Build the app once, in its own `describe`, with the env flipped:
    ```ts
    // NON-STANDARD APP BUILD, on purpose. app.ts:104 skips @fastify/rate-limit
    // under NODE_ENV=test so integration suites can hammer inject(). AC-11 is a
    // statement ABOUT the rate limit, so this test — and ONLY this test — must
    // register it. Everything else in this file uses the normal test config.
    const rlConfig = loadConfig({ ...process.env, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    ```
    Assert the **eleventh** request inside one minute returns 429. Own `describe`, own `buildApp`, closed separately — a leaked rate-limit store across tests is a flake generator. `test/brief-routes.test.ts` is the worked example.
  - **AC-7** falls out of the enqueue-and-return shape: assert the `GET` resolves with the mocked provider's call count at **zero**, and that the `POST` resolves **while the stubbed provider's promise is still pending** (**AC-9**).
  - **AC-5:** throw `NotFoundError` from `platform/errors.ts`; the single handler in `app.ts:125` builds the `{error:{code,message,details}}` envelope. **Never hand-build the envelope.**
  - `modules/index.ts` gains one import and one entry in the `modules` record — registration is **static**, deliberately, so the same code path works under `tsx`, the bundler and vitest. Neither `routes-smoke.test.ts` nor any other suite asserts a route inventory, so nothing breaks here.

### Step 14 — Server integration tests and the Cut 1 gate · package: server · **BARRIER**

- **Files:** create `server/test/file-summary.it.test.ts`
- **Satisfies:** verification for AC-1–39, AC-74; NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, NFR-7, NFR-10, NFR-11
- **Skills:** `onion-architecture`, `drizzle-orm-patterns`
- **Depends on:** Steps 1–13
- **Verify (in order):**
  ```sh
  ./scripts/check-contracts.sh
  cd server && pnpm typecheck && pnpm lint:arch
  cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'
  export DOCKER_HOST="unix:///Users/kyrylo.myronov/.colima/default/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  cd server && pnpm exec vitest run .it.test
  cd server && pnpm test
  ```
- **Done when:** all commands are green, the server lane is **≥ 521 tests / ≥ 50 files** (the `ff04b24` baseline, plus this build's additions), every `server-unit` / `server-integration` row of SPEC-03's *Verification* table has a named assertion, **and the author has reviewed the served payload**
- **Notes:**
  - **Suite membership is by filename.** `*.it.test.ts` = DB-backed, needs Docker; everything else must be hermetic. Follow the spec's own assignment — it is right. `server-integration`: **AC-1, AC-2, AC-4, AC-5, AC-8, AC-10, AC-33, AC-34, AC-36; NFR-5, NFR-10.** `server-unit`: everything else.
  - **The two `export`s are not optional.** Without them the integration lane silently does not run in this environment: `docker info` succeeds, the active context is colima, `DOCKER_HOST` is unset, and `testcontainers@10.28.0` fails at `test/helpers/pg.ts:36` with `Could not find a working container runtime strategy` — fifteen `.it.test.ts` files then report as **failed suites with zero failed tests**, which reads exactly like an environment skip. Treat a Docker failure *after* the exports as an environment problem, not a plan problem (server `insights.md` 2026-08-27 and 2026-08-02).
  - **Inject every mock via `ContainerOverrides`** (`llm`, `git`, `github`, `tokenizer`) — **never construct an adapter inline**; that is the whole reason the container exists.
  - **Override every provider the code will resolve** — `file_summary` → `openrouter`; if a test also triggers a review or an intent, override those too. Use `test/helpers/file-summary.ts` alongside `test/helpers/{intent,brief}.ts`.
  - **AC-4's assertion is the one people skip:** read the *same* PR id under a *second* `workspace_id` and assert a 404, not merely that the first workspace succeeds.
  - **AC-33's assertion is per column**, after a real derivation: `summary`, `head_sha`, `created_at`, `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd` — and **the sum of `cost_usd` across the derivation's rows equals the aggregate** (D-1's exactness, proven against the database rather than only in the unit test).
  - **AC-34 needs three cases:** an unpriced model (`null`), a zero-priced model (`0`), and a file skipped by the cache. The third is **vacuous by construction** — a cached file is not re-persisted at all, so no row is written with a `null` cost for that reason. Record it in *Open questions* as a spec text correction rather than inventing a write to satisfy it.
  - **NFR-5's 32 KB** is read off the serialised response body for a PR at the NFR-3 cap **after two force-pushes** — that combination is what proves D-2's projection actually bounds the payload. Without the projection this row would grow without limit across head SHAs, which is the half of NFR-5's "structurally unreachable" claim that was not true before D-2.
  - **THIS IS THE BARRIER.** Cut 2's hooks, annotation model, file card, tab and every client assertion are built on the payload settled in step 1 and proven here. **Do not begin step 15 until this gate is green and the payload has been reviewed.**

---

### CUT 2 — the studio: hooks, the summary line, severity at the line, the chrome

### Step 15 — Client hooks and cache keys · package: client

- **Files:** create `client/src/lib/hooks/file-summary.ts`; modify `client/src/lib/hooks/keys.ts`, `client/src/lib/hooks/index.ts`
- **Satisfies:** AC-54, AC-55, AC-56, AC-57; NFR-6
- **Skills:** `react-best-practices`, `frontend-ui-architecture` (**with the SPA caveat in *Constraints & invariants***)
- **Depends on:** Steps 2, 14
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** `usePrFileSummaries`, `useDeriveFileSummaries`, `summaryFor` and `isSummaryFreshFor` exist, are re-exported from `hooks/index.ts`, and no component imports `api` directly
- **Notes:**
  - **Copy `client/src/lib/hooks/intent.ts` wholesale** — it is the shipped, proven idiom, and SPEC-02's brief hooks copied it too. `usePrFileSummaries(prId, { pollWhile })` sets `refetchInterval` from the **server's own state**, not a client flag, so a derivation started in another tab also ends the polling. `useDeriveFileSummaries(prId)` posts `{path?, force?}` and invalidates on success.
  - **NFR-6 / AC-56 / AC-57:** `FILE_SUMMARY_POLL_MS = 2_000` and `DERIVE_TIMEOUT_MS = 90_000`, matching the shipped derivation idiom exactly (`hooks/intent.ts:17`; `IntentCard.tsx:25,52-55`).
  - **Export the two freshness predicates, for the same reason `isFreshFor` is exported** (`hooks/intent.ts:30-33`): the polling stop-condition and AC-58's staleness badge **must** agree, and two copies of that comparison eventually disagree and leave the tab polling forever behind a badge that says it is done.
    - `summaryFor(data, path)` → the one `PrFileSummary` for a path (the response already carries at most one, by D-2).
    - `isSummaryFreshFor(summary, headSha)` → `summary?.head_sha === headSha`.
  - **The two stop conditions, and why they differ (D-4 of *Decisions taken*, and AC-64):**
    - **Per-file wait** stops when `summaryFor(data, path)` is fresh for the current head. Precise and fast.
    - **PR-level wait** stops when `data.selected === data.total`. **This is what makes AC-64 true rather than accidental:** a per-file summary landing bumps `selected` by one, which does not satisfy `selected === total`, so the PR-level wait **continues** and the landed summary renders. Comment the corollary honestly: on a token-capped PR `selected < total` forever, so the PR-level wait ends at **AC-57**'s 90 s — that is the *normal* exit for a capped PR, not a failure, and the control returns to idle with the summaries that did land already rendered.
  - **Add to `keys.ts`:**
    ```ts
    /** SPEC-03 — the PR's derived per-file summaries. Shares no prefix with
        pullKeys/reviewKeys/intentKeys/briefKeys, so it must be invalidated by
        this exact key, never by a prefix sweep. */
    export const fileSummaryKeys = { byPr: (prId: Id) => ["pr-file-summaries", prId] as const };
    ```
    **Never inline a `queryKey` literal.** Client `insights.md` 2026-08-17 is explicit that the prefixes do **not** nest and that the file's own header comment teaches a convention the tuples do not implement — **read the tuples, never the header**. A mistyped literal produces a mutation that looks successful while `staleTime: 30_000` and `refetchOnWindowFocus: false` (`lib/providers.tsx:28-29`) keep the stale render on screen: no type error, no runtime error.
  - The 202 receipt type stays **local to this file** (as `IntentDeriveAccepted` does at `hooks/intent.ts:19-24`) — it never leaves the client, so it is not a shared contract and must not be added to `vendor/shared`.
  - `lib/api.ts` stays the only place that talks HTTP; it normalises the error envelope into `ApiError`, which **AC-55**'s error state branches on.
  - **Do not import a runtime VALUE from `@devdigest/shared`** — it breaks only the webpack build, while `typecheck` and `vitest` both pass (client `insights.md` 2026-08-11). Types only.

### Step 16 — The annotation data model and the per-line severity join · package: client

- **Files:** modify `client/src/components/diff-viewer/annotations.ts`, `client/src/components/diff-viewer/index.ts`; modify `client/src/app/repos/[repoId]/pulls/[number]/_components/DiffTab/{helpers.ts,constants.ts}`; extend `.../DiffTab/helpers.test.ts`
- **Satisfies:** AC-58, AC-65, AC-66, AC-67, AC-68 (data model)
- **Skills:** `typescript-expert`, `react-best-practices`
- **Depends on:** Step 15
- **Verify:** `cd client && pnpm typecheck && pnpm exec vitest run helpers`
- **Done when:** `DiffAnnotation` carries the summary and a per-line severity map, `DiffSummaryApi` is exported from the barrel, and `severitiesByLine` has assertions for the worst-severity, the no-severity and the path-normalisation cases
- **Notes:**
  - **`DiffAnnotation` gains DATA only (D-8):**
    ```ts
    /** SPEC-03 — the file's derived one-line summary, already resolved for
     *  rendering. Labels arrive as STRINGS, not message keys: a shared
     *  component that resolves its own i18n namespace crashes any screen whose
     *  catalogue lacks it (client insights.md 2026-08-27), and this file already
     *  carries a resolved `tag: {label,color,bg}` for exactly that reason. */
    summary?: {
      text: string;
      headSha: string;
      stale: boolean;          // AC-58 — head_sha !== the PR's current head
      staleLabel: string;      // resolved
    };
    /** SPEC-03 AC-65 — worst severity per NEW-side line number. A line marked
     *  by `findingLines` with no entry here renders the shipped
     *  severity-neutral highlight (AC-67). */
    severitiesByLine?: ReadonlyMap<number, Severity>;
    ```
  - **The callback does NOT go here (D-8).** A new `DiffSummaryApi` is exported from `comments.ts`'s neighbour (or `annotations.ts`, either is fine — say which) and threaded like `commenting`:
    ```ts
    export interface DiffSummaryApi {
      /** Request a derivation for one file (AC-51). */
      onDerive: (path: string) => void;
      /** AC-63 — a PR-level derivation is in flight; every per-file control disabled. */
      prLevelPending: boolean;
      /** Paths whose per-file derivation is in flight. */
      pending: ReadonlySet<string>;
      /** Resolved labels: the control's accessible name (AC-53), its disabled
       *  hint (AC-52), the pending label. Strings, never keys. */
      labels: { derive: string; deriving: string; noPatch: string };
    }
    ```
    `DiffCommentApi` is the shipped precedent for callbacks reaching `FileCard` and `CodeLine`; `annotations.ts:1-5` calls itself "pure data + helpers" and stays true.
  - **`severitiesByLine(smart, findings)` in `DiffTab/helpers.ts` — AC-68, and R-9 is the invariant it must not break.** Build it from **the same `currentFindings(reviews)` set** that already produces `severitiesByPath` in `buildAnnotations` (`helpers.ts:90-97`), in the same function, so the header badge and the line marks cannot be computed from different review sets. Two shipped asymmetries are inherited and **must not be silently narrowed**:
    1. **`SMART_DIFF_MAX_LINES_PER_FINDING` is server-only** (`server/src/modules/pulls/constants.ts:35`). The server truncates each finding's range before emitting `finding_lines` (`smart-diff.ts:212-223`). The client map must therefore expand each finding's **full** `start_line…end_line` range with **no cap of its own** — a client map narrower than the server's marked set routes real severities into AC-67's neutral highlight, which is a wrong render, not a graceful one. Extra entries beyond the server's marked lines are harmless: nothing reads a severity for an unmarked line.
    2. **`findingLinesByPath` normalises a leading `./` or `/`** (`smart-diff.ts:195-197`) while `buildAnnotations` keys severities on the **raw** `f.file` (`helpers.ts:94`). The shipped path-level join already carries that asymmetry; deepening it to line granularity inherits it. **Do not "fix" it here** — a normalisation on one side only would change which files get a header badge today. Write the asymmetry down in the function's docstring as a known constraint with AC-67 as its catch, and record it in *Out of scope*.
    Worst-severity per line uses the same `SEVERITY_RANK` order `worstSeverity` already declares (`annotations.ts:40-45`) — **import it, do not redeclare** — so a line carrying a `CRITICAL` and a `SUGGESTION` renders `CRITICAL` (**AC-65**). Dismissed findings are excluded on both sides, as they already are.
  - **A file with 300 findings on one line** renders the worst severity only; the highlighted-line set is already capped per finding server-side and **this plan adds no second cap**.
  - `DiffTab/constants.ts` gains `FILE_SUMMARY_POLL_MS` / `DERIVE_TIMEOUT_MS` re-exports if the tab needs them locally, plus nothing else — the role metadata is untouched except for its message keys in step 18.

### Step 17 — `FileCard`: the disclosure control, the summary line, severity at the line · package: client

- **Files:** modify `client/src/components/diff-viewer/FileCard/FileCard.tsx`, `client/src/components/diff-viewer/CodeLine/CodeLine.tsx`, `client/src/components/diff-viewer/styles.ts`, `client/src/components/diff-viewer/DiffViewer/DiffViewer.tsx`, `.../DiffTab/_components/SmartDiffGroups/SmartDiffGroups.tsx`; create `client/src/components/diff-viewer/FileCard/FileCard.test.tsx`
- **Satisfies:** AC-49, AC-50, AC-51, AC-52, AC-53, AC-58, AC-61, AC-62, AC-65, AC-66, AC-67, AC-69, AC-70, AC-72, AC-73
- **Skills:** `react-best-practices`, `react-testing-library`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Step 16
- **Verify:** `cd client && pnpm typecheck && pnpm exec vitest run FileCard`
- **Done when:** the header's disclosure control exposes `aria-expanded` in both states and folds on **Enter and Space**; the summary line renders above the hunks with its staleness badge; the derive control's accessible name states it spends a model call and is disabled with a `null` patch; a flagged row renders an icon **and** a text label; **and SPEC-02's two reveal-focus assertions in `DiffTab.test.tsx` still pass untouched**
- **Notes:**
  - **D-3 — THE HEADER SHAPE, and the reason `<button>` around the whole header is not available.** The header already contains a nested `<button>` (the finding-jump badge, `FileCard.tsx:158-165`) and AC-51 adds a second (the derive control). A `<button>` may not contain interactive descendants, and `role="button"` on the header has the same ARIA problem plus a hand-rolled Space handler. So:
    - the header row stays a **non-interactive `<div style={s.fileHeader}>`** with **no `onClick`**;
    - chevron + path + `+n −m` stat become **one real `<button type="button" aria-expanded={open} style={s.fileDisclosure}>`** whose `onClick` is the existing `toggle`. Enter **and** Space come free — do **not** add `onKeyDown` (**AC-70**), which is exactly how the Space case gets missed;
    - the role tag, the severity badge, the derive control and the comment count are **siblings of that button**, inside the header div.
    - **`flex: 1` on the button** (moving `s.filePath`'s `flex:1, minWidth:0` onto the button and keeping the ellipsis on the path span inside it) recovers most of the old click target for free — it costs nothing, so take it and say so in the file. It does **not** recover clicking the badge strip; that affordance is gone, author-accepted.
    - **The accessible name of the disclosure button is the path.** Do not add an `aria-label` that replaces it: client `insights.md` 2026-08-28 records that `aria-label` **beats** `title` and beats the element's own text, which is how SPEC-02's AC-45 defect shipped. If a label is wanted, it must *contain* the path.
  - **D-4 — the reveal focus target does NOT move, and this is a decision, not an oversight.** `rootRef` keeps `tabIndex={-1}` and `jumpToLine` keeps `rootRef.current?.focus({ preventScroll: true })` **exactly as SPEC-02 landed it** (`FileCard.tsx:74-82,135-137`). Consequence, stated so a reviewer sees it was considered: SPEC-02's two regression assertions in `DiffTab.test.tsx` — `focused.getAttribute("tabindex") === "-1"` and `focused.textContent` contains the path, plus `focus` called with `{preventScroll:true}` and the scroll target still being `[data-new-line="2"]` — **continue to hold unchanged**, because the card root still carries `tabIndex={-1}` and still contains the path in its `textContent`. **Do not "improve" this by focusing the new header button**; that would rewrite an author-signed-off behaviour and both of the assertions written to make it visible in a diff. Extend the existing SPEC-02 comment block with one line saying so.
  - **AC-49 / AC-50 — the summary line renders between the header and the body**, from `annotation.summary`, so it is present in **both** views: a summary is a property of the file, not of the view, and `DiffViewer` is the single component both `SmartDiffGroups` and the flat list render. Nothing view-specific is needed for AC-50 — assert it, do not build it.
  - **AC-58** — the staleness badge sits **beside** the summary and the summary's **text stays rendered**. A stale summary is still information.
  - **AC-61 — render every model-derived summary as TEXT.** Never through `vendor/ui/primitives/Markdown.tsx`, never `dangerouslySetInnerHTML`, and never as an `href`. A persisted summary is a stored-XSS shape: attacker-influenced text, stored, then rendered to every later reader. React's JSX escaping is the safety net and this step keeps it. A summary containing `<b>`, `<script>` or `javascript:` must appear as **literal characters** and produce **no anchor**. RTL text and emoji pass through as-is — no reordering or escaping logic of our own.
  - **AC-62 — truncate VISUALLY (CSS ellipsis) and set the accessible name from the RAW value.** These pull in opposite directions and are the classic miss, and this repo has already paid for it once: client `insights.md` 2026-08-28 records SPEC-02's `LocationButton` shipping with the raw value in `title` and a fixed string in `aria-label`, so the untruncated value never became the accessible name — **and the test passed**, because it asserted `toHaveAttribute("title", …)` and located the element by the generic name. Put the raw value in `aria-label` (it may carry the value **plus** an action), use `title` for hover only, and assert `toHaveAccessibleName`. Applies to the summary text **and** to a 180-character monorepo path.
  - **AC-51 / AC-52 / AC-53 — the derive control** is a real `<button>` in the header, outside the disclosure button. Its accessible name must **state that activating it spends a model call** (AC-53) — a resolved string from `DiffSummaryApi.labels`, not a `useTranslations` call inside this shared component (client `insights.md` 2026-08-27: a shared component resolving its own namespace crashes any screen whose catalogue lacks it). `disabled` when `file.patch == null` (**AC-52**) with the reason in the accessible name, and `disabled` when `summary.prLevelPending` (**AC-63**). Three distinct renderings must stay distinguishable: never derived (control offered), no patch (control disabled), and summary present (no control, or a re-derive) — a failed derivation persists no row, so the file returns to the offered state.
  - **AC-65 / AC-66 / AC-67 / AC-72 / D-9 — severity at the line.** `CodeLine` gains `severity?: Severity | null`; `FileCard` passes `annotation?.severitiesByLine?.get(ln.newNo)` alongside the existing `finding` boolean.
    - `severity` present → render an **icon and a text label** in the gutter margin (D-9), plus a severity-coloured left rule via a new `findingRowFor(kind, severity)` overload in `diff-viewer/styles.ts`.
    - `finding && !severity` → the **shipped** severity-neutral highlight, byte-identical to today's `inset 3px 0 0 0 var(--warn)` (**AC-67**). Keep the current `findingRowFor(kind)` behaviour reachable and unchanged.
    - **The label must be in the DOM.** Never `SeverityBadge compact`: `compact` maps to `{compact ? null : s.label}` (`vendor/ui/primitives/Badge.tsx:80`) and **drops the label entirely**, leaving colour + icon carrying the whole meaning — the exact WCAG 2.2 · 1.4.1 failure NFR-8 forbids and the thing the kit's own comment at `Badge.tsx:51` says not to do.
    - **The rendered label is MIXED CASE** — `"Critical"` / `"Warning"` / `"Suggestion"` from `vendor/ui/primitives/tokens.ts:10-13`; the all-caps look is `textTransform: uppercase`, a CSS effect that never reaches the DOM. **Assert `getByText("Critical")`, not `"CRITICAL"`** (**AC-66**), reading the label off `tokens.ts` rather than off a screenshot.
    - Keep `data-finding-line` and `data-new-line` on the row exactly as they are — `DiffTab.test.tsx` and `page.tsx`'s jump path both depend on them.
  - **AC-73 — the contrast tokens, with the measured numbers so the step names one that passes.** Paint the summary line's text and (step 18) the status region's text with **`var(--text-secondary)`**: `#999999` on `--bg-elevated` `#1c1c1c` measures **5.98:1** (dark) and `#595964` on `#ffffff` measures **6.92:1** (light); on the page background `#0a0a0a` it is **6.95:1**. **Do NOT reuse `--text-muted`**, which the shipped group hint uses (`DiffTab/styles.ts:28-36`) and which measures **3.15:1** on `--bg-elevated` in dark — that is precisely D-24's point, and copying the shipped hint would ship the failure the criterion exists to prevent.
  - **`DiffViewer.tsx` and `SmartDiffGroups.tsx` each gain ONE pass-through prop** (`summary?: DiffSummaryApi`), forwarded unchanged, exactly as `commenting` already is. No other change to either.
  - **`FileCard.test.tsx` is new** (there is no colocated FileCard test today) and covers the rows above in isolation, with an explicit `NextIntlClientProvider` — **do not** mount the page shell: wrapping a test in `RepoProvider` makes the shell fetch more, and one non-array stub blanks the whole render (client `insights.md` 2026-08-11). jsdom has **no `window.localStorage`** (client `insights.md` 2026-08-18), so do not assert on `foldStore` persistence here. Query by **role and accessible name**, never by test id or class. For AC-73 use the `css: false` bridge: compute the ratio from a copy of the token table (real relative-luminance maths) **and** bind it to the component by asserting `el.style.color === "var(--text-secondary)"`, which jsdom preserves verbatim — and pin the tightest pair with an **upper** bound so one step of drift breaks it, per client `insights.md` 2026-08-27.

### Step 18 — `DiffTab`: the chrome deltas, the summary wiring, the status region · package: client

- **Files:** modify `.../DiffTab/DiffTab.tsx`, `.../DiffTab/styles.ts`, `.../DiffTab/constants.ts`, `.../DiffTab/helpers.ts`; modify `client/messages/en/prReview.json`
- **Satisfies:** AC-40, AC-41, AC-42, AC-43, AC-44, AC-45, AC-46, AC-47, AC-48, AC-59, AC-60, AC-63, AC-64, AC-71, AC-72
- **Skills:** `react-best-practices`, `next-best-practices`, `frontend-ui-architecture` (**SPA caveat**)
- **Depends on:** Steps 15, 16, 17
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** the section reads `REVIEWER-ORDERED DIFF` with the count and aggregate beneath it, the toggle reads `Smart order` / `Original order` in that DOM order, the division-of-labour sentence renders, the running total and the n-of-m line render, and a derivation state change is announced through a `role="status"` region
- **Notes:**
  - **`SectionLabel` cannot carry AC-41 (R-8).** It has no slot beneath the label (`vendor/ui/primitives/SectionLabel.tsx:14-31`) and `client/src/vendor/**` is **do-not-touch**. Render the count + aggregate as a **sibling element immediately below** `<SectionLabel>`, from `files.reduce(...)` over `additions`/`deletions` (or the `additions`/`deletions` props from step 19). Do **not** edit the primitive.
  - **AC-40's message string is literally `REVIEWER-ORDERED DIFF`** in `prReview.json`. `SectionLabel` uppercases in **CSS** (`:22`), so the DOM carries whatever the catalogue holds — storing it uppercase is what makes AC-40's client assertion the criterion rather than a lookalike, and it is the only casing e2e's `wait --text` would match (spec OQ-6, closed: `wait --text` compares the **rendered** text and Chrome's `innerText` applies `text-transform`). This is the mirror image of the `"Critical"` lesson: read the catalogue, not the screenshot.
  - **AC-42, and THE P-4 FIREWALL.** Rename the two toggle buttons to `Smart order` and `Original order` and **reorder them so `Smart order` is first** in the DOM. **These are `DiffTab.tsx:176-193` — the exact lines P-4 concerns. P-4 was REJECTED by the author: the missing `aria-pressed` stays as recorded pre-existing debt. Do NOT add `aria-pressed`, `role="radio"`, `aria-current` or any other state attribute to either button while you are in these lines.** `Button` spreads `...rest` (`Button.tsx:70`), so the fix is one attribute away and that is exactly why this prohibition is written here and not only in *Constraints*. The debt has a named follow-up; sweeping it in silently is the failure mode.
  - **AC-43 — KEEP the `groups.length > 0` conditional** (`DiffTab.tsx:174`). A toggle with nothing to toggle into is a dead control. Already shipped; assert it, do not touch it.
  - **AC-44 — the accepted category copy, a `prReview.json` edit only.** `coreLabel` `"Core"` → `"Core logic"`; `coreHint` → `"The substance of the change — review closely"`; `wiringLabel` stays `"Wiring"`; `wiringHint` → `"Hooks the core into the app"`; `boilerplateLabel` stays `"Boilerplate"`; `boilerplateHint` → `"Generated / mechanical — skim"`. `ROLE_META`'s keys, colours and `openByDefault` are **untouched** — the mockup's **words** ship, its **membership** does not (D-13), and `openByDefault: false` on boilerplate is AC-45, already shipped.
  - **AC-48** — one sentence above the reviewer-ordered diff naming the difference from the PR brief's review focus (`prReview.smartDiff.vsBrief`). This is P-7 and the booked mitigation for two surfaces answering "where do I start?"; without it the reviewer reconciles them alone.
  - **AC-59** — `formatCost(total, t("costUnknown"))` from `client/src/lib/format-cost.ts:14-20`, where `total` sums `summaries[].cost_usd`. **Never `cost_usd ?? 0`**: `null` (unpriced) and `0` (genuinely free) are different facts and the placeholder is the call site's decision, which is why `formatCost` takes it as an argument. Three renderings must be distinguishable: all-`null` → the placeholder; `0` → `"$0.00"`; sub-cent → 4 dp. **This total is exactly D-1's apportioned sum**, which is why step 9's exactness test matters here.
  - **AC-60** — when `omitted_files.length > 0`, render `t("smartDiff.summarised", { selected, total })`. State plainly in the code comment that under D-2 this reads **"eligible but not summarised"**, not "dropped by the token cap"; the per-file control (AC-51) is what distinguishes them on screen.
  - **AC-63 / AC-64 — the two waits, owned here.** `DiffTab` holds `prLevelPending: boolean` and `pending: Set<string>`, each with its own `DERIVE_TIMEOUT_MS` timer, and passes them down through `DiffSummaryApi`. `usePrFileSummaries` polls while **either** is active. A per-file summary landing clears its own entry and renders (**AC-64**) while `prLevelPending` stays true because `selected !== total` — that is D-4's stop-condition asymmetry paying off, and it deserves the comment.
  - **The PR-level derivation control is the one surface no AC names.** Render it in the section header (`Summarise files`, `POST` with no `path`) and say so in a comment: AC-13 defines the PR-level derivation and AC-63/AC-64 presuppose a way to start it, but no criterion requires the control itself. Flagged rather than absorbed.
  - **AC-71 — a `role="status"` region** announcing each derivation state change (idle → deriving → ready / timed out), text painted `var(--text-secondary)` (step 17's contrast note). **NFR-8 note the implementer must NOT "improve":** WCAG 4.1.3 does **not** govern a tab switch — its Understanding document lists selecting a different tab in a tablist among the changes that are *not* status messages. Do not wrap the view-mode toggle or the tab switch in a live region.
  - **AC-54 / AC-55** — skeletons per summary line while the query is pending, and an explicit error state with a **retry** control on failure, branching on `ApiError`. **Mandatory, not optional:** the SPA has no server-rendered fallback and `client/AGENTS.md` lists "every screen must have a real loading and `ApiError` state" as an accepted consequence of the architecture. This also closes D-1/D-2 in the spec's design review: `useSmartDiff` has no `isPending` or `isError` branch today, so a 500 currently renders as "no groups", indistinguishable from a one-file PR.
  - **Every string through next-intl**, namespace `prReview.smartDiff`, no inline literals. A component calling a **missing** message key fails its own test (client `insights.md` 2026-08-11), so add every key in **this** step, not in step 20.
  - `DiffTab` stays `"use client"`. **No `'use server'`, no Server Actions, no RSC data fetching** — see *Constraints & invariants*.

### Step 19 — Page plumbing · package: client

- **Files:** modify `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`
- **Satisfies:** AC-41, AC-58 (the head SHA and the aggregate reach the tab)
- **Skills:** `react-best-practices`
- **Depends on:** Step 18
- **Verify:** `cd client && pnpm typecheck && pnpm test`
- **Done when:** `DiffTab` receives `headSha`, `additions` and `deletions`, and nothing else about the page changes
- **Notes:**
  - **This is a SPEC-02 collision file and the edit is deliberately tiny.** SPEC-02 landed `jumpToLocation`, `citationInDiff` and the `BriefCard` reveal plumbing here (`page.tsx:112-142,216-224`); **none of it changes.** SPEC-03 adds three props to the existing `<DiffTab>` call at `:256-267`: `headSha={pr.head_sha}` (AC-58's comparison), `additions={pr.additions}` and `deletions={pr.deletions}` (AC-41's aggregate, already on `PrMeta` and already rendered by `PrDetailHeader.tsx:78-79`).
  - **Do not build a second line index and do not touch `diffIndex`.** `page.tsx:130` builds it once via `diffLineIndex(pr?.files ?? [])` and hands the same one to the findings tab and to SPEC-02's `citationInDiff`. One index, one truth.
  - Keep `page.tsx` thin: this is three props, not a new state machine. The diff tab's reveal state deliberately **never reaches the URL** (`page.tsx:84-88`) — that is a Non-goal, not an oversight; do not "improve" it into a query param.

### Step 20 — Client tests, including the seven shipped assertions this build changes · package: client

- **Files:** extend `.../DiffTab/DiffTab.test.tsx`
- **Satisfies:** verification for AC-40–74; NFR-6, NFR-8's automatable rows (1.4.1, 1.4.3, 2.1.1, 4.1.2, 4.1.3)
- **Skills:** `react-testing-library`
- **Depends on:** Steps 17, 18, 19
- **Verify:** `cd client && pnpm test`
- **Done when:** green, with one named assertion per `client` row of SPEC-03's *Verification* table, the client lane at **≥ 274 tests / ≥ 34 files**, and **every one of the seven updated assertions below re-pointed rather than deleted**
- **Notes:**
  - **THE SEVEN SHIPPED ASSERTIONS THIS BUILD BREAKS. The spec's *Verification* table never mentions them; closing that gap is this step's first job.** Update each in place — do not delete one to make a suite green:

    | Line | Current assertion | Broken by | How it is updated |
    |---|---|---|---|
    | `:119` + `:126` | `getAllByRole("button",{expanded:true})` → `toHaveLength(2)` | **AC-69** — file-card headers now expose `aria-expanded`, so open cards match too | scope to the group headers (`within(...)` on the group `<section>`, or assert the group labels' expanded state by accessible name). Then **add** a new assertion for the file-card count, which is the AC-69 behaviour |
    | `:122` | `getAllByText("Core")` → `toHaveLength(2)` | **AC-44** — `coreLabel` becomes `"Core logic"` | assert `"Core logic"`. `"Wiring"` and `"Boilerplate"` are unchanged and stay as they are |
    | `:127` | `getByRole("button",{expanded:false})` → `toHaveTextContent("Boilerplate")` | **AC-69** — every collapsed file card now matches, so `getByRole` throws on multiple matches | query the group header by accessible name and assert `aria-expanded="false"` on it |
    | `:128` | `getByText("Smart Diff · grouped by role")` | **AC-40/AC-41** — that chrome is replaced | assert `REVIEWER-ORDERED DIFF` plus the count/aggregate line. `groupedByRole` leaves `prReview.json` |
    | `:136` | `click(getByRole("button",{expanded:false}))` | **AC-69** — same ambiguity | click the group header, located by name |
    | `:235`, `:246` | `click(getByRole("button",{name:/Standard/}))` | **AC-42** — renamed to `Original order` | `name: /Original order/` |

  - **SPEC-02's two reveal-focus assertions (`DiffTab.test.tsx`, the `moves keyboard focus…` and `focuses with preventScroll…` tests) must pass UNCHANGED.** That is D-4, and it is the visible proof the two builds' `FileCard` edits compose. If either needs touching, stop — the header work moved focus and that is a plan deviation, not a test fix.
  - **AC-70 needs Enter and Space dispatched SEPARATELY** on the disclosure control, each asserting the same fold. That is the assertion the real-`<button>` decision (D-3) exists to make trivial; a `role="button"` + `onKeyDown` implementation is where the Space case gets missed.
  - **AC-69** asserts the header element's `role` **and** its `aria-expanded` value in **both** states.
  - **AC-56 / NFR-6:** assert successive fetches while `selected < total`, and **none** once `selected === total`. **AC-57:** advance fake timers past 90 000 ms and assert the control returns to its idle accessible name. **AC-64:** land a single-file payload during a PR-level wait and assert the summary renders **and** the wait is still active.
  - **AC-61:** a summary containing `<b>bold</b>` and `javascript:alert(1)` renders as **literal text** and produces **no anchor** — assert `queryByRole("link")` is null.
  - **AC-68's assertion is the one people skip:** build a fixture with a **superseded** pass (two reviews for one agent) and assert the line severities and the header badge are computed from the **same** — current — review set. `currentFindings` is already the single source; the test is what stops a future refactor giving the line marks a different one.
  - **AC-72:** walk **every** severity rendering in the tab (header badge, line mark, and any group badge) and assert a non-colour cue on each.
  - **Mock at the `fetch` boundary.** Note for the record: RTL suites stub `fetch` and therefore cannot see a server-side join go wrong — which is why step 14's it-tests are not redundant, and why SPEC-03's Non-goal of an e2e flow leaves a **stated** gap rather than an unnoticed one.
  - jsdom has no `localStorage`, so do not assert `viewMode` or `foldStore` persistence; assert the in-session behaviour only.

### Step 21 — Final gate

- **Files:** none
- **Satisfies:** — (gate)
- **Skills:** —
- **Depends on:** Steps 1–20
- **Done when:** every command in *Verification* has been run and passed, `node .claude/skills/api-breaking-changes/check.mjs --base ff04b24` reports an **empty `critical` list**, and the author has reviewed the shipped tab

---

## Verification

Run in this order. Each command, and what it proves:

```sh
# 1. Contracts — the client mirror has not drifted from canonical
./scripts/check-contracts.sh

# 2. AC-31's ONLY guard. check-contracts.sh cannot see this file (it lives
#    outside client/src/vendor). rc=0 ⇒ the two FEATURE_MODELS copies agree.
diff <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
         server/src/vendor/shared/contracts/platform.ts | tr -d "'\"") \
     <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
         client/src/lib/feature-models.ts | tr -d "'\"")

# 3. Server types + the Onion dependency rule.
#    A crossed ring FAILS HERE, not in review. Baseline: 203 modules, 726 deps.
cd server && pnpm typecheck && pnpm lint:arch

# 4. server-unit — hermetic, no Docker.
#    AC-3,6,7,9,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
#    32,35,37,38,39,74; NFR-1,2,3,4,11
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'

# 5. server-integration — needs Docker. THE TWO EXPORTS ARE NOT OPTIONAL:
#    without them testcontainers fails at test/helpers/pg.ts:36 and fifteen
#    .it.test.ts files report as FAILED SUITES WITH ZERO FAILED TESTS, which
#    reads exactly like an environment skip.
#    AC-1,2,4,5,8,10,33,34,36; NFR-5,10
export DOCKER_HOST="unix:///Users/kyrylo.myronov/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd server && pnpm exec vitest run .it.test

# 6. Both server suites together. Baseline at ff04b24: 521 tests / 50 files.
cd server && pnpm test

# 7. The studio — AC-40–74; NFR-6, NFR-8's automatable rows, PLUS the seven
#    re-pointed shipped assertions and SPEC-02's two UNCHANGED reveal-focus
#    assertions. Baseline at ff04b24: 274 tests / 34 files.
cd client && pnpm typecheck && pnpm test

# 8. NFR-9 — compatibility, against the real pre-build ref. Q6 is executed:
#    SPEC-02 is committed as ff04b24 and the worktree was clean, so this diff
#    contains ONLY SPEC-03 and SPEC-02's Risk retyping cannot resurface as this
#    build's finding. The `critical` list must be EMPTY.
node .claude/skills/api-breaking-changes/check.mjs --base ff04b24
```

Migration commands, run once between plan steps 6 and 7 — **not** part of the repeatable gate:

```sh
cd server && pnpm db:generate   # drizzle-kit writes the SQL; never hand-write it
cd server && pnpm db:migrate    # migrations do NOT run on boot
```

**Deliberately NOT run, and why:**

- **`cd reviewer-core && npm test` / `cd mcp && npm test`** — **neither package is touched.** SPEC-03's Non-goals rule out an MCP tool and any `reviewer-core` change, and `mcp/`, `reviewer-core/` and `e2e/` hold zero references to any smart-diff or file-summary name. Run them once at the gate as a no-regression check if cheap, but they prove nothing about this build. Baselines: reviewer-core 52/4, mcp 21/2.
- **`./scripts/e2e.sh`** — SPEC-03 makes a browser flow a Non-goal. D-29 establishes the rename is safe: `find role button --name "Files changed"` matches only the tab-strip `<button>` (`vendor/ui/kit/Tabs.tsx:24-51` via `PrDetailHeader.tsx:118-127`), `SectionLabel` renders a `<div>`/`<span>` with no role and cannot be matched by a role locator, and flow 05's other anchor is `src/config.ts`, which the unchanged classifier still puts under Core logic. **Verified against the flow file itself:** `e2e/specs/05-pr-diff.flow.json:10,12` are exactly those two anchors. No flow changes.
- **Step 5 of the gate, in a Docker-less environment** — environment-dependent by construction, *after* the two exports. A failure there is an environment problem, not a plan failure.
- **`api-breaking-changes` beyond NFR-9's one command, plus `api-response-changes`, `response-schema`, `security`, `pr-self-review`** — **these are not `implementer`'s skills.** They belong to the separate review agents and the pre-PR gate. See *Out of scope*. **Nobody should assume they ran.** NFR-9's single command is in the gate because the spec's own *Verification* table puts it there as a manual-once row.
- **An eval harness for the summaries' prose** — the `eval` tables stay empty. A summary that is wrong but well-formed passes every criterion here, and the only signal is a reviewer reading the diff underneath it. That is a **stated gap**, and it is why the summary renders *above* the hunks rather than instead of them.

**Every acceptance criterion maps to a command above**, with two stated exceptions, both manual-once by the spec's own *Verification* table: NFR-8's focus-ring-against-the-sticky-header row (jsdom cannot observe a focus ring, and this is sharper here than usual because SPEC-02's AC-50 already moves focus on **every** reveal), and NFR-9's judgement on the `critical` list.

---

## Constraints & invariants

**Repo-wide**

- **Five standalone packages, NOT a pnpm workspace.** Cross-package code is shared as TypeScript **source** through tsconfig path aliases. **Never** `pnpm add` one local package into another; there is no build or publish step for shared code.
- **Two package managers on purpose:** **pnpm** in `server`/`client`, **npm** in `reviewer-core`/`mcp`/`e2e`. **This plan touches only pnpm packages.**
- **`@devdigest/shared` is canonical at `server/src/vendor/shared/`;** `client/src/vendor/shared/` is a hand-synced copy. A contract change is **always two files**: edit canonical → `./scripts/check-contracts.sh --fix` → typecheck **both** packages. Nothing else catches the drift.
- **`--fix` also lands earlier unmirrored drift** — verified not to bite: `diff -rq` was empty at `ff04b24`, so the diff must carry exactly three files (step 2). The diff must still be read.
- **`FEATURE_MODELS` has a SECOND copy with NO guard**, `client/src/lib/feature-models.ts`, outside the rsync'd tree. `check-contracts: OK` says nothing about it. The diff command is the verification.
- **Migrations do not run on boot and are never hand-edited.** Schema change = `pnpm db:generate` then `pnpm db:migrate`, two separate steps (6 and 7).
- **Every domain table carries `workspace_id`** — except `pr_intent`, `pr_brief` and now `pr_file_summaries`, which scope through `pr_id → pull_requests`. Followed, not re-litigated; AC-4 asserts it at the query.
- **Schema and contracts exist ahead of the features that use them.** `SmartDiffFile.pseudocode_summary`, `PrBrief`, `RiskSeverity`, `PrHistory` and ~35 tables stay. **Unused ≠ dead. Do not clean up the schema or the contract barrel.**
- **`server/clones/**` is never read, edited or searched** — it holds a stale full copy of this repository and the files there look real and are not.
- **A bare `git diff` is a NO-OP on a new file** (root `insights.md` 2026-08-27): it exits 0 with no output, which is indistinguishable from "unchanged". This build creates ~12 new files. Any in-build "did the fix touch this file" check must use `git status --porcelain <path>` or `git diff HEAD`, never a bare `git diff`. This no longer threatens the base ref — Q6 committed SPEC-02 as `ff04b24` — only per-file checks.
- **A new native dependency would need an `allowBuilds:` entry** in that package's `pnpm-workspace.yaml`. **This plan adds no dependency to any package.**

**Server (`server/AGENTS.md`) — the Onion rule is lint-enforced, so a violation fails `pnpm lint:arch`, not review**

- Layering is one-directional: `routes.ts` → `service.ts` → `repository.ts`. Routes are transport only; no business logic in a route, no HTTP types below it.
- **`repository.ts` is the only file in a module allowed to import `drizzle-orm`**; `routes.ts` and `service.ts` may not import `src/db/schema`. (A `pipeline.ts` or `selection.ts` **may** import `type * as schema` for a row alias — the rule names only routes and services, and `modules/brief` already does exactly this.)
- **A module's public surface is its `constants.ts` and `types.ts`.** Cross-module work goes through the container or a job kind — **never** another module's service, repository or internals. `container.pullsRepo` is the sanctioned seam for `pull_requests` / `pr_files` / `repos`. **This is why step 3 promotes `classifyPath` to `_shared` rather than importing `modules/pulls/smart-diff.js`, and why `PrFileRow` is a local type alias.**
- Resolve every dependency from `container`; never construct an adapter inline. Tests inject via `ContainerOverrides`.
- Modules register **statically** in `src/modules/index.ts`: one folder + one import + one registry entry.
- One Zod schema serves request validation **and** response serialization, declared on the route — subject to step 13's body-less-POST gate.
- Errors: throw `AppError` subclasses; the single handler in `app.ts` builds the `{error:{code,message,details}}` envelope. **Never hand-build it.**
- Anything slow goes through `JobRunner`, and **a rejected handler is retried twice** — which is why AC-15's never-throws contract is load-bearing.
- **Test-suite membership is by filename:** `*.it.test.ts` = DB-backed (needs Docker); everything else must be hermetic.

**Client (`client/AGENTS.md`)**

- **The studio is a client-rendered SPA on an App Router shell — deliberately.** No server-side data fetching, no Server Actions, no DAL. **Do not add `'use server'` or move fetching into RSC.** Every screen needs a real loading state and an `ApiError` state (AC-54, AC-55).
- **`frontend-ui-architecture` assumes an RSC-first app; this studio is not one.** Take its guidance on folder structure, feature boundaries and component decomposition; **ignore its RSC-boundary, Server-Actions and Data-Access-Layer sections.** `client/AGENTS.md` wins.
- **Never `fetch` in a component.** `lib/api.ts` is the only place that talks HTTP; components consume typed React Query hooks from `lib/hooks/`.
- Cache keys come from `lib/hooks/keys.ts` — never an inline `queryKey` literal.
- Types come from `@devdigest/shared`, never hand-written locally; **never import a runtime value from it** (webpack-only breakage).
- UI primitives come from `src/vendor/ui`; **`SeverityBadge` is never `compact`**; user-facing strings go through next-intl.
- **A genuinely shared component takes LABEL PROPS, never its own `useTranslations`** — `FileCard` and `CodeLine` are shared, so every string they render arrives resolved on the annotation or on `DiffSummaryApi`.
- **`client/src/vendor/**` is do-not-touch.** This plan **reads** `vendor/ui` and **regenerates** `vendor/shared` via the sync script; it edits neither by hand. `client/src/components/diff-viewer/**` is authored here and is a legitimate edit target.

**Firewalls specific to this build**

- **P-4: no `aria-pressed`, `role="radio"` or `aria-current` on the order toggle.** Author-rejected, recorded as pre-existing debt with a named follow-up. Step 18 edits `DiffTab.tsx:176-193` — the exact lines — so the prohibition is written into that step, checkable in the diff, not only here.
- **R-14: AC-43, AC-45, AC-46 and AC-47 are already met by shipped code.** The steps **assert** them; no step reimplements them. AC-44 is the one real edit in that group and it is copy only.
- **D-4: SPEC-02's two reveal-focus assertions must pass untouched.** If either needs editing, that is a deviation to report, not a test to fix.
- **R-9: the client per-line severity map must never be NARROWER than the server's marked set**, and the `./`/`/` normalisation asymmetry between `findingLinesByPath` and `buildAnnotations` is a documented constraint, not a bug to fix here.

**Do-not-touch, restated for this build:** `server/clones/**`, `server/src/db/migrations/**` (generate, don't edit), `client/src/vendor/**`, locked skills under `.claude/skills/**`, and anything generated (`dist/`, `.next/`, `coverage/`, `*.tsbuildinfo`).

---

## Open questions

Everything the author decided is in *Decisions taken*. What remains:

- **AC-34's cache clause has no code path.** "Persist `cost_usd` as `null` when … the file was served from a stored row" describes a write that does not occur: AC-16 returns the stored row with no model call and writes nothing. The plan proceeds on the reading that the clause is **vacuous** and only the unpriced-model case is live. Spec text correction, listed below. **This is the same defect shape SPEC-02's plan recorded as its R-10** — worth noting, because it means the pattern recurs when a derivation spec is written from `pr_intent`'s columns.
- **D-1 changes what a single row's `cost_usd` means, and nothing on the wire says so.** The apportioned share is documented on the contract field and on the column, but a future reader of one row in `psql` will read a share as a price. Accepted; the alternative (Q1-B) made NFR-1 and AC-59 read N× the real spend.
- **D-2 removes the cap-omitted / never-derived distinction from the wire.** `omitted_files` now means "eligible but not summarised". On screen the distinction survives via AC-51's per-file control, but an API consumer other than the studio cannot recover it. Accepted; reversing it means Q2-B's three denormalised columns or Q2-C's second table.
- **The PR-level derivation control (step 18) is covered by no acceptance criterion.** AC-13 defines the derivation and AC-63/AC-64 presuppose a way to start it. A deliberate, minimal widening, flagged rather than absorbed — and the author retains a veto until implementation starts.
- **Step 10's output-language paragraph is covered by no acceptance criterion**, exactly as SPEC-02's D-11 was. Kept as a single isolatable paragraph so it can be deleted in one edit.
- **Step 13's body-less-POST question is a live gate.** If a declared `body: FileSummaryDeriveInput` rejects a POST with no body, the fallback is the sibling's tolerant hand-parse — **and that comes back as a plan amendment appended to this file**, not chosen silently. SPEC-02's identical R-9 gate resolved in the plan's favour and is now recorded in server `insights.md`; this one is unproven.
- **OQ-1 (is 48 000 the right cap?) is now answered on the provider side and still open on the content side.** Research closed the window question — 1 048 576 tokens, so our cap fires ~20× below the provider limit and cannot trigger a rejection or a silent truncation. What remains unestablished is the spec's own admission that the 1 698-tokens-per-file average was extrapolated from four commits rather than measured on a 300-file diff. Step 9's generated fixture measures it for the first time; if the number is wrong, AC-20's mechanism is independent of it and the fix is a one-constant edit. **Decides:** the author, on the first real derivation of a large PR.
- **OQ-2 remains deferred and is unchanged by the research.** The bare slug advertises `structured_outputs`, so the model-id-level preflight resolves `true`; the per-provider variance behind the alias (17+ backing providers, several without structured outputs, `response_format` documented as a *soft preference*) is not visible to `ModelCatalog`, which reads the aggregate. **Consequence if it bites:** a routed request returns unstructured text, which **AC-27** catches as a parse failure — degraded, not incorrect. **Decides:** the author, if parse failures cluster.
- **OQ-4, OQ-5, OQ-7 deferred unchanged**, all out of this plan's scope with the spec's stated evidence.
- **For `researcher`, not for this plan:** nothing. Both commissions are closed with the figures in *Decisions taken* and step 4. Do not re-commission them.
- **Cost figures do not survive a workspace override.** If a workspace overrides `file_summary` to a different OpenRouter slug, **no figure in NFR-1 applies**: `pricing.ts:31-33` marks those rows approximate in its own words, and the neighbouring `deepseek` slugs range from $0.03/$0.10 to $0.22/$0.66 per 1M.

---

## Out of scope / follow-ups

- **Architecture review (`architecture-reviewer`)** — recommended **at the step 14 barrier**, before the client cut. Point it at exactly three things: the `classifyPath` promotion to `_shared` and its re-export (step 3), the read-time projection's split between repository SQL and service business logic (steps 8 and 12), and the apportionment helper's placement in `selection.ts` (step 9).
- **`plan-verifier`** — runs against this file once the build is done, on the diff `ff04b24`..HEAD. `Partial success` is **not** `delivered`; the plan stays `approved` until the gaps close. Hand it the builder's **self-reported deviation list as its named highest-value target** — root `insights.md` 2026-08-27 records that across SPEC-02's build the builder's own list beat three rounds of independent review, and that a long list is not a bad sign.
- **`api-breaking-changes`, `api-response-changes`, `response-schema`** — the review agents', **not** `implementer`'s, beyond NFR-9's single command. The right targets are step 1's new contract file and widened `FeatureModelId`, and step 13's declared `response:` schema. **Nobody should assume these ran.**
- **`security`** — the review agents'. Relevant surfaces: AC-61 (a persisted summary is a stored-XSS carrier rendered to every later reader), AC-25/AC-26 (prompt-injection fencing of author-controlled patch text), AC-38/AC-37 (the model naming a path it was not given), and the fact that a path string is author-controlled and must never reach an `href` without protocol validation.
- **`pr-self-review`** — the pre-PR gate, before `gh pr create`.
- **SPEC-03 text corrections, all for `spec-creator`, none for this plan:**
  1. **AC-33** — "the token counts and the cost" → "**its share of** the token counts and the cost" (D-1). NFR-1's "summed across the rows" then becomes literally true.
  2. **AC-21 and AC-60** — `omitted_files` is computed at read time over the derivation-eligible set and means "eligible but not summarised", not "dropped by the token cap" (D-2). AC-21's "record the omitted paths in the derivation's result" remains true of the pipeline's own outcome and its log line, which is a different artifact from the wire field.
  3. **NFR-5** — "structurally unreachable" is true **only under D-2's one-row-per-path projection**; without it the payload grows without bound across force-pushes. Add the projection as the reason.
  4. **AC-34** — the "or the file was served from a stored row" clause describes a write that cannot happen under AC-16.
  5. **NFR-1** — the citation `pricing.ts:33-34` is imprecise: the entry is line **34** alone; **31-33** is the surrounding comment block. Also record that the price is now confirmed exactly ($0.088606 / $0.177212) and that `pricing.ts` was corrected.
  6. **OQ-1 and OQ-2** — record the closed halves: the context window is 1 048 576 with max completion 384 000, so the cap is a cost control and not a guard against provider rejection; and the bare slug advertises `structured_outputs`, so AC-29's preflight resolves `true` in the default configuration.
  7. **D-21 / *Module interactions*** — "copying the group header one file away" is not executable: that header has no interactive descendants and this one has two (D-3).
  8. **The *Verification* table** carries no row for the seven shipped `DiffTab.test.tsx` assertions AC-69, AC-42 and AC-40/41 change. Step 20 closes the gap; the table should say so.
- **Moving SPEC-03 from `approved` to `implemented`** — the author's call, after the corrections above. The index row in `specs/README.md` must move with it.
- **`/engineering-insights`** — warranted after this build. Likely candidates, judged against the rubrics: **apportioning one call's cost across N persisted rows** and why `SUM` versus `MAX` decides two NFR verifications (D-1); **`DISTINCT ON` with a `head_sha = current_head` ordering term** as the way a composite-PK-with-staleness table serves "the current one, else the stale one" in a single query (D-2); **a header row that cannot be a `<button>` because it already owns two**, and why that makes a nested disclosure button the a11y-correct answer rather than a compromise (D-3); and the fact that **`aria-expanded` on a repeated component silently poisons every `getByRole("button", {expanded: …})` query in the suite** (R-4) — a test-fragility class nobody anticipates.
- **Named follow-ups the author has already deferred:** **P-4**, the order toggle's missing `aria-pressed` (WCAG 2.2 · 4.1.2, one attribute per button given `Button` spreads `...rest`) — raise as its own task against `DiffTab.tsx` after this build. **OQ-4**, `pulls.listFiles({ per_page: 100 })` has no pagination loop (`adapters/github/octokit.ts:79-84`), so a >100-file PR silently loses file data with no omission accounting — its own task, because fixing it changes the review path. **R-9**, the `./`/`/` normalisation asymmetry between `findingLinesByPath` and `buildAnnotations` — a real latent mismatch, out of scope here because normalising one side only would change which files get a header badge today. **`SmartDiffFile.pseudocode_summary`** (OQ-7) — confirmed dead, retained, safe to remove or keep. **`pr_file_summaries` retention** — nothing prunes rows for superseded head SHAs except the `pull_requests` cascade; D-2 makes the *payload* bounded but the *table* still grows, which is fine at this scale and worth a line if it ever is not. **`e2e/`'s missing coverage of this tab's new surfaces** — a stated gap, not an unnoticed one.

---

## Amendments

Append-only. Each entry records what the plan got wrong or what changed after
approval, with the evidence. **Never rewrite a step above this log — the log is
the diff.**

### 2026-08-29 — A-1 · Step 13's body-less-POST gate FAILED; the route takes `.nullish()`

**Voids:** nothing. **Corrects:** step 13's `body:` declaration and its Verify block.

**What the plan asked.** Step 13 made this a gate rather than a note: *"declare
`body: FileSummaryDeriveInput` and prove, in this step's route test with a real
`app.inject()`, that a POST with NO body at all still returns 202 — BEFORE
anything downstream is built on it."* It named exactly two outcomes: the
declaration works, or the fallback is the sibling's tolerant hand-parse.

**What is actually true.** Fastify sets `req.body = null` for a body-less POST,
and a `z.object` rejects `null`. Measured through real `app.inject()`:

```
POST /pulls/:id/file-summaries, no body, no content-type
  → 422 {"error":{"code":"validation_error", … "message":"Expected object, received null"}}
```

The error message is itself the proof of the mechanism. Five tests went red from
this one cause — the gate test, AC-9, AC-10, AC-5-on-POST, and AC-11/NFR-7.
**AC-11 was left UNPROVEN rather than disproven**: its eleven requests are
body-less, so they 422 before reaching the rate limiter. That is exactly the
downstream damage the gate existed to prevent.

**A third option, which the plan did not name.** `implementer` measured it and
the coordinator re-verified it independently with its own probe:

| declaration | no body (`null`) | `{}` | `{path: 42}` | `{force: 'yes'}` |
|---|---|---|---|---|
| `FileSummaryDeriveInput` (plan as written) | **422** | 202 | 422 | 422 |
| `FileSummaryDeriveInput.nullish()` | **202** | 202 | **422** | **422** |
| no `body:` + hand-parse (plan's stated fallback) | 202 | 202 | *silently ignored* | *silently ignored* |

**Author's ruling: `.nullish()`.** It is the only option that accepts the
body-less POST **and** keeps rejecting a malformed one. It preserves the repo
convention that one declared Zod schema serves request validation *and* client
typing, and the handler's existing `req.body ?? {}` already copes with `null`.
The stated fallback was declined because it would have silently swallowed
`{path: 42}` — losing validation the route can have for free.

**Not swept in:** the shipped sibling `POST /pulls/:id/brief` has the same
tolerant hand-parse and the same lost validation. It is out of this build's
scope and is recorded as a follow-up, not fixed here.

**Why it matters beyond this build.** SPEC-02's identical R-9 gate resolved *in
the plan's favour* and was recorded in `server/insights.md` as "a `.nullable()`
response schema serialises fine". This one resolved the other way. **The pair is
the lesson** — a declared Zod schema is safe on a *response* and unsafe on an
*optional request body*, and the two questions look identical when written down.
`/engineering-insights` candidate.

**Approved by the author** (S5 triage, 2026-08-29).

### 2026-08-29 — A-2 · Verification verdict of record: `Verified success`

**Verdict: `Verified success`.** Delivered by a **fresh** `plan-verifier` — one never
shown the build's Implementation Report or either architecture review — on the
whole build's diff `ff04b24`..worktree. Per
[`specs/plans/README.md`](README.md), `Verified success` permits `Status:
delivered`, so this plan is **`delivered`** and its index row moves with it.

**What is verified.** All 21 steps have an artifact, every matrix row citing a
`path:line` or quoted command output. The verifier re-ran all ten verification
commands itself and reconciled every count, including both untouched packages:

| Lane | Baseline `ff04b24` | After |
|---|---|---|
| server | 521 / 50 files | **612 / 54 files** |
| client | 274 / 34 files | **339 / 35 files** |
| reviewer-core | 52 / 4 files | **52 / 4** (untouched, as the Non-goals require) |
| mcp | 21 / 2 files | **21 / 2** (untouched) |

Four clean typechecks · `pnpm lint:arch` clean (214 modules, 772 dependencies) ·
`check-contracts: OK` · `diff -rq` on the two `vendor/shared` trees empty ·
`api-breaking-changes --base ff04b24` → **no breaking changes, `critical` empty**
(69→71 endpoints, 162→165 contracts) · `pr-self-review` → **pass, 0 critical, 0
major**. **Zero skips in every lane.** **Contradicted: none. Requirements the plan
never served: none.**

Two independent `architecture-reviewer` passes — Cut 1 server-side and Cut 2
client-side, separate fresh instances — returned **0 blocking** each.

**The three firewalls held, verified mechanically by three parties** (the builder,
the coordinator and the fresh verifier, independently): **P-4** — no
`aria-pressed`, `role="radio"` or `aria-current` was added to the order toggle,
though step 18 edits the exact lines and `Button` spreads `...rest`; **D-4** —
SPEC-02's two reveal-focus assertions are **byte-identical** to `ff04b24`, so the
disclosure-button work did not move focus; **R-14** — `DiffTab/constants.ts` has a
**zero diff**, so AC-43/45/46/47 were asserted, never rebuilt.

**What is NOT closed, recorded rather than rounded up.** Three items, none a code
defect, all structurally unclosable by a test:

1. **Step 14's "the author has reviewed the served payload"** — a human sign-off.
   The verifier's words: *"I cannot verify a state of mind."*
2. **Step 21's "the author has reviewed the shipped tab"** — the same.
3. **NFR-8's focus-ring-against-the-sticky-header row** — manual-once by the
   spec's own *Verification* table; jsdom cannot render or observe a focus ring.
   Sharper here than usual, because SPEC-02's AC-50 already moves focus on **every**
   reveal and this build adds a second focusable control to the same header.

`--tests gaps` therefore ran and wrote **nothing**, which is the honest outcome:
every remaining `Unknown` is a human judgement or physically impossible in the
available suites, and a test written to close one would assert around the gap
rather than through it.

**Approved by the author** (close-out, 2026-08-29).
