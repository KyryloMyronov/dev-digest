# Implementation Plan: Agent Evals (SPEC-04)

Spec: SPEC-04-agent-evals.md
Status: approved
Execution: single-agent
Approved: 2026-09-02

---

## Decisions taken

The author settled six questions and accepted all ten recommendations. Where SPEC-04 still reads otherwise, **this plan is authoritative for `implementer`**, and the coordinator amends the spec (list in *Spec amendments required* below) before `plan-verifier` runs against it.

| # | Decision | Closes | SPEC-04 section to amend |
|---|---|---|---|
| **D-1** | **202 + `JobRunner` + poll.** `POST /agents/:id/eval-runs` validates synchronously (agent exists, ≥1 case, no running batch, provider key resolves), enqueues an `eval-batch` job and returns `202 EvalBatchAccepted { status:'accepted', batch_id, cases }`. Per-case `eval_runs` rows land as the batch progresses. `GET /agents/:id/eval-runs` serves `EvalBatchRecord[]`; the studio polls it. **`EvalBatchRecord.status` gains `running`.** OQ-3: option (iii) — the 120 s `JobRunner` timeout is accepted for **both** manual and auto-eval batches; the `jobs` row goes `failed`, the batch runs on and persists, and AC-92's log line is what reconciles them. | R-1, R-2, Q1, OQ-3, OQ-7 | sequence diagram (spec:575-609) → 202 + poll; AC-27 → "…shall **enqueue** a batch that executes every one of that agent's eval cases under a single `batch_id`"; `EvalBatchRecord.status` enum; OQ-3 → resolved (iii); OQ-7 → resolved (no SSE) |
| **D-2** | **A batch is materialised up front; its status is derived, not stored.** At batch start the runner inserts **one `eval_runs` row per case** (all metrics null, `batch_id`, `agent_id`, `agent_version`, `trigger` set) and updates each in place as it completes. Read-time derivation: `cases_total` = rows in batch; `cases_ran` = rows with `pass IS NOT NULL` (**AC-37 verbatim**); `status` = `running` when the batch id is in the eval service's in-memory active set, else `failed` when every row carries `error`, else `complete` when every row is scored-or-errored, else `partial`. **No batch table, no status column** — the spec's *Schema impact* stands unchanged. After an API restart an interrupted batch reads `partial`, which is true. | R-2 | *Schema impact* gains this note; AC-41/AC-110's "record its status as `partial`" becomes a derivation, not a write |
| **D-3** | **Pass rule split by expectation.** A `must_find` case passes when every expected finding was matched **and** it produced no unmatched extra. A `must_not_flag` case passes when it produced **no actual finding at all**. | R-3, Q3 | AC-54 → two sentences |
| **D-4** | **Every actual finding on a `must_not_flag` case is noise** (REC-7). AC-49 becomes the special case, not a third clause. | R-9, REC-7 | AC-47 + AC-49 → one rule |
| **D-5** | **UX-1 / REC-5 is superseded — see the box below.** AC-44's actual↔expected matcher is a pure local function in `modules/eval/scoring.ts`; `groundCitations` is used only where it genuinely applies. | REC-5 | UX-1 → `rejected`, with the reason |
| **D-6** | **Batch `citation_accuracy` is the micro-average** — Σ kept ÷ Σ (kept + dropped) over the cases that produced a candidate; `null` when none did. | R-4, Q4 | AC-52 gains a batch-level sentence |
| **D-7** | **The metric trend is a new inline-SVG `_components/MetricTrend/`**, modelled on `Sparkline` (`client/src/vendor/ui/charts/Sparkline.tsx`), with ordinal labels in the accessibility tree. `LineChart` is **not** used and **not** edited. | R-5, Q5, D-28 | AC-75 → "…ordinal position, exposed as text in the accessibility tree"; D-28's resolution names the new component |
| **D-8** | **Both phases in one plan**, ordered phase-1 server → phase-2 server → **hard barrier** → phase-1 studio → phase-2 studio → e2e/docs. Every phase-2 step is marked `[P2]`. | Q2, REC-9 | — |
| **D-9** | **`POST /eval-cases/:id/runs` is built** — a one-case batch over the same runner, so `eval.json`'s shipped `evalsTab.run` and `caseEditor.runCase` have something behind them. No AC requires it; it exists because the catalogue already draws it. | R-11, Q2 | add an AC, or record it in *Non-goals* as deliberately unspecified |
| **D-10** | **`auto_eval: z.boolean().default(false)`** on `Agent`, matching `repo_intel` two lines above it. | R-8, REC-3 | *Contract impact* → `Agent` row |
| **D-11** | **Two new config entries:** `EVAL_BATCH_MAX_USD` (default `0.50`) and `EVAL_BATCH_MAX_MS` (default `900_000`). NFR-1 and NFR-3 become generous absolute ceilings, not p95 measurements. | REC-1, REC-2 | NFR-1, NFR-3, NFR-6 measurement text |
| **D-12** | **AC-41's estimate is the running mean of the completed cases' `cost_usd`** in that batch. It binds only once ≥1 case is priced; `null` throughout → the ceiling never binds and AC-110's wall clock is the only limit (OQ-6's assumption, unchanged). | R-6, REC-6, OQ-6 | AC-41 gains "estimated as the mean of the batch's completed, priced cases" |
| **D-13** | **AC-85 is an explicit allow-list** — `system_prompt`, `model`, `provider`, `strategy`, `output_schema`, skill set. **AC-86 is dropped** as redundant; `ci_fail_on`, `repo_intel`, `name` and `description` bump the version and enqueue nothing. | R-12, REC-8 | AC-85 → allow-list; AC-86 → deleted |
| **D-14** | **The studio composes AC-74's banner** from `alert_metric` + `alert_delta` via `eval.json`. The server's `alert` string stays, asserted only in `server-unit`. UX-3 comes free. | R-16, REC-4, D-31, UX-3 | AC-74 → the API returns metric + delta; the studio renders the sentence |
| **D-15** | **Precedence: AC-38 wins over AC-51.** An all-failed batch reports all three metrics `null`, not `precision = 1`. | R-10 | AC-51 gains "…unless AC-38 applies" |
| **D-16** | **The nav-row edit to `client/src/vendor/ui/nav.ts` is sanctioned**, on SPEC-01's precedent — the file's own comment (`nav.ts:22-27`) names the Eval Dashboard row as deliberately withheld until its route lands. Called out in step 24 and in *Constraints* so a reviewer does not read it as a do-not-touch violation. | R-13 | — |
| **D-17** | **AC-26 and AC-2 are assertions, not builds.** `eval_runs.case_id` is already `onDelete:'cascade'` (`server/src/db/schema/eval.ts:23-26`) and `eval_runs` already has no `workspace_id`. Step 16's integration test asserts them; no code implements them. | R-14 | — |
| **D-18** | **The e2e flow is `e2e/specs/12-eval.flow.json`** — slot 11 is taken by `11-project-context.flow.json`. The six mockups are already at `specs/assets/SPEC-04/`; the *Design review* header's "untracked at the repository root / the author performs the move" instruction is done. | R-15 | *Verification* final row; *Design review* header |
| **D-19** | **`EvalExpectation`'s two options are a local literal array in the case editor**, never an imported schema — a runtime import from `@devdigest/shared` breaks the webpack build only, with a green typecheck and a green suite (`client/insights.md` 2026-08-11). Pattern: `SkillsListView/constants.ts#TYPE_OPTIONS`. | client insight | — |
| **D-20** | **`FindingCard`'s action row renders only inside `{expanded && …}`** (`FindingCard.tsx:105-140`). AC-5 and AC-6's client tests expand the card first, or they pass for the wrong reason. | R-18 | — |

> ### D-5 in full — why REC-5 / UX-1 cannot be taken literally
>
> I recommended scoring `must_find` matching with `groundCitations`, the author accepted it, and closer reading says it does not do what UX-1 claims. `groundCitations(items, diff)` builds a **line index from a diff** and asks "does this item touch a changed line in that file" (`reviewer-core/src/grounding.ts:94-120`). Matching an *actual* finding against an *expected* finding is a two-list range-overlap test with no diff in it. The predicate UX-1 points at is `rangeIntersects`, which is **deliberately off the barrel** — `reviewer-core/src/index.ts` says so in as many words, because `groundCitations` is meant to be the whole seam. Exporting it is a `reviewer-core` change, which SPEC-04's *Non-goals* forbids ("`groundCitations` is reused as-is, not modified").
>
> **What is done instead.** AC-44's matcher is `matchesRange()` in `modules/eval/scoring.ts` — pure, one screen long, `file` equality plus `start <= other.end_line && other.start_line <= end`. Its doc comment cites `grounding.ts:68` (called at `:119`) as the predicate it deliberately mirrors, so the two cannot drift silently. `groundCitations` is still used for the one thing it is right for, and REC-10's mutation check (step 9) is the compensating control: break `matchesRange`, confirm the AC-44 table goes red, revert.
>
> **What is unaffected.** AC-52's citation accuracy needs no matcher at all — `reviewPullRequest` already returns `review.findings` (kept) and `dropped[]` (`reviewer-core/src/review/run.ts:110-118, 236-246`), which is the numerator and denominator directly.

---

## Requirements traced

| Plan step | Satisfies | Verified by |
|---|---|---|
| 1 | AC-19, AC-21, AC-25, AC-104 (shape), AC-109 (shape); NFR-15 | `server/test/contracts.test.ts` (extended) |
| 2 | mirror half of every contract AC | `./scripts/check-contracts.sh`; `cd client && pnpm typecheck` |
| 3 | NFR-2, NFR-6 (the knobs AC-41/AC-110 read) | `cd server && pnpm typecheck` |
| 4 | AC-32, AC-33, AC-36, AC-58, AC-90, AC-111 (substrate); AC-2, AC-26 (assert, D-17) | `cd server && pnpm typecheck` |
| 5, 6 | mechanism for step 4 | one new `0017_*.sql`; `pnpm db:migrate` exits 0 |
| 7 | AC-106, AC-107, AC-108, AC-109 (the ceilings); the two job kinds | `cd server && pnpm lint:arch && pnpm typecheck` |
| 8 | AC-44, AC-45, AC-46, AC-47, AC-48, AC-49, AC-50, AC-51, AC-52, AC-53, AC-54, AC-55, AC-56, AC-57, AC-74; NFR-13 | `server/test/eval-scoring.test.ts` (new) |
| 9 | mutation check of step 8 (REC-10) | quoted failure output in the report |
| 10 | AC-1, AC-2, AC-4, AC-26, AC-37, AC-38, AC-108; NFR-3 | `cd server && pnpm lint:arch && pnpm typecheck` |
| 11 | AC-10, AC-13, AC-14, AC-15, AC-17 | `server/test/eval-case-builder.test.ts` (new) |
| 12 | AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34, AC-36, AC-41, AC-58, AC-110, AC-111, AC-113, AC-115; NFR-1, NFR-12, NFR-16 | `server/test/eval-runner.test.ts` (new) |
| 13 | AC-3, AC-7, AC-8, AC-9, AC-11, AC-12, AC-16, AC-18, AC-20, AC-22, AC-23, AC-24, AC-35, AC-39, AC-40, AC-42, AC-43, AC-72, AC-114 | `server/test/eval-service.test.ts` (new) |
| 14 | every route; AC-19, AC-20, AC-106, AC-109; NFR-5, NFR-7 | `server/test/eval-routes.test.ts` (new) |
| 15 | AC-3, AC-17, AC-19, AC-20, AC-23, AC-24, AC-39, AC-56, AC-74, AC-88, AC-92, AC-106, AC-109, AC-113; NFR-5, NFR-7, NFR-12, NFR-13, NFR-16 | `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` |
| 16 | AC-1, AC-2, AC-4, AC-7-AC-16, AC-18, AC-21, AC-22, AC-25, AC-26, AC-27, AC-32, AC-33, AC-34, AC-35, AC-36, AC-37, AC-38, AC-40, AC-41, AC-42, AC-43, AC-55, AC-58, AC-107, AC-108, AC-110, AC-111, AC-114; NFR-1, NFR-2, NFR-3, NFR-4, NFR-6 | `server/test/eval.it.test.ts` (new) |
| 17 `[P2]` | AC-80, AC-81, AC-82, AC-83, AC-84, AC-103, AC-104; `auto_eval` write path | `cd server && pnpm typecheck && pnpm lint:arch` |
| 18 `[P2]` | AC-85, AC-87, AC-88, AC-89, AC-90, AC-91, AC-92, AC-105; NFR-17 | `server/test/eval-trigger.test.ts` (new) |
| 19 `[P2]` | AC-103, AC-104, AC-105 (route half); `auto_eval` on the agent bodies | `cd server && pnpm typecheck` |
| 20 `[P2]` | AC-80-AC-92, AC-103-AC-105; NFR-17 | `server/test/agents-eval.it.test.ts` (new) |
| **21 — BARRIER — the server gate** | verification for AC-1-AC-58, AC-80-AC-92, AC-103-AC-111, AC-114; NFR-1-NFR-7, NFR-12, NFR-13, NFR-15, NFR-16, NFR-17 | every command in *Verification*, server half |
| 22 | the data layer for AC-59-AC-79, AC-93-AC-102 | `cd client && pnpm typecheck` |
| 23 | AC-61, AC-64, AC-65, AC-70, AC-72, AC-74, AC-77, AC-78, AC-79 (copy); AC-68 (label already shipped) | `cd client && pnpm typecheck` |
| 24 | AC-68; UX-8 | `client/src/components/app-shell/**` tests (extended) |
| 25 | AC-75; NFR-8, NFR-9 | `.../MetricTrend/MetricTrend.test.tsx` (new) |
| 26 | AC-59, AC-60, AC-61, AC-62, AC-63, AC-64, AC-65, AC-66, AC-67, AC-112; NFR-8, NFR-9, NFR-10, NFR-11 | `.../EvalsTab/EvalsTab.test.tsx` (new); `AgentEditor.test.tsx` (extended) |
| 27 | AC-69, AC-70, AC-71, AC-72, AC-108 (render); NFR-8, NFR-9, NFR-11 | `.../EvalDashboardView.test.tsx` (new) |
| 28 | AC-73, AC-74, AC-75; NFR-8, NFR-9 | `.../EvalAgentView.test.tsx` (new) |
| 29 | AC-76, AC-77, AC-78, AC-79, AC-112 | `.../EvalCaseEditor.test.tsx` (new) |
| 30 | AC-5, AC-6; NFR-11 | `FindingCard.test.tsx` (extended) |
| 31 `[P2]` | AC-93, AC-94, AC-95, AC-96, AC-97, AC-98, AC-99, AC-100, AC-101, AC-102 | `.../CompareBatches.test.tsx` (new) |
| 32 | the smoke path behind AC-59, AC-68, AC-69 | `./scripts/e2e.sh` |
| 33 | docs | none — prose |
| 34 | the full gate | *Verification*, every command |

**Requirements with no delivering step:** none. All 115 ACs and 17 NFRs are assigned above, with three exceptions stated rather than implied:

- **AC-86 is dropped** by D-13 and delivers nothing.
- **NFR-14** is `manual, once` by the spec's own *Verification* table — it needs a real provider and a real model. Step 34 records it as **not run**, not as passed.
- **AC-115** and **AC-26** and **AC-2** are **already true of shipped code**. Steps 12 and 16 *assert* them; they build nothing. `assemblePrompt` already fences the diff (`reviewer-core/src/prompt.ts:16-45`), `eval_runs.case_id` is already `ON DELETE CASCADE`, and `eval_runs` already carries no `workspace_id`.

---

## Goal & scope

After this build, a reviewer who has accepted or dismissed a finding can turn it into a permanent eval case in one click, with the single-file diff fragment and the head SHA frozen onto the row. An agent author opens the editor's new **Evals** tab, presses Run, watches a polled running state, and reads recall, precision and citation accuracy computed entirely in code from the frozen case set — plus a per-case expected/actual count and an expectation chip. A new `/eval` route ranks every agent in the workspace by its latest batch and lists the workspace's 50 newest batches newest-first, behind a costed confirmation for "Run all agents". `/eval/agents/:agentId` adds metric tiles, an ordinal-axis trend, a deterministic regression banner, a routed case editor that validates expected output against `EvalExpectedFinding[]` and surfaces the failing Zod path, and — phase 2 — a two-batch compare with a line-level system-prompt diff and a confirmed restore. Linking, unlinking, toggling or replacing an agent's skills bumps its version and snapshots it; an agent with `auto_eval` on re-runs its case set automatically when a prompt-, model- or skill-affecting change lands, at most one job pending per agent.

**Not included:** everything under SPEC-04's *Non-goals*, unchanged — no skill-owned eval cases, no Files input tab, no Stats or CI editor tabs, no GLOBAL sidebar group, no Learn or Reply-to-author finding action, no MCP tool, no backfill of existing findings into cases, no time-range filter, and **no `reviewer-core` change of any kind**. Also not included: SSE progress (OQ-7, resolved as polling), a persisted "Run on save" toggle (OQ-2, client state only), a retention policy for frozen customer diffs (OQ-5, unbounded as specified), and a GIN index on `input_meta`. This plan widens SPEC-04's scope in exactly **two** places, both recorded above: `POST /eval-cases/:id/runs` (D-9) and the `container.evalTrigger` facade (step 18), neither of which any AC names.

---

## Spec amendments required before `plan-verifier` runs

`plan-verifier` checks the build against this plan **and** the spec; where they disagree it has to guess. The coordinator should land these edits in `specs/SPEC-04-agent-evals.md` (still `Status: draft`, so it is editable) before verification:

1. **AC-27 + the sequence diagram** → 202 + `JobRunner` + poll (D-1). **OQ-3** → resolved, option (iii). **OQ-7** → resolved, no SSE.
2. **`EvalBatchRecord.status`** → `z.enum(['running','complete','partial','failed'])` (D-1), and the *Schema impact* note that status is derived from pre-inserted rows (D-2).
3. **AC-54** → split by expectation (D-3). **AC-47 + AC-49** → one noise rule (D-4).
4. **AC-52** → gains the batch-level micro-average sentence (D-6). **AC-51** → "…unless AC-38 applies" (D-15).
5. **AC-75 + D-28** → the ordinal axis is a new inline-SVG component; labels are in the accessibility tree (D-7). **UX-1** → `rejected`, with D-5's reason.
6. **AC-41** → the estimate is the running mean of the batch's completed priced cases (D-12). **NFR-1 / NFR-3 / NFR-6** → absolute ceilings and a configurable wall clock (D-11).
7. **AC-85** → allow-list; **AC-86** → deleted (D-13). **AC-74** → the API returns metric + delta, the studio renders the sentence (D-14).
8. ***Contract impact*** → `Agent.auto_eval` is `.default(false)` (D-10); the new shapes live in `contracts/eval-agent.ts`.
9. ***Verification*** final row → `e2e/specs/12-eval.flow.json`; ***Design review*** header → the assets are already at `specs/assets/SPEC-04/` (D-18).
10. **A criterion for `POST /eval-cases/:id/runs`**, or a *Non-goals* line saying it ships unspecified (D-9).

---

## Impact map

| Package / layer | Files | Kind of change | Risk |
|---|---|---|---|
| shared contracts (canonical) | `server/src/vendor/shared/contracts/eval-agent.ts` (**new**), `contracts/knowledge.ts`, `contracts/eval-ci.ts`, `index.ts` | 6 new schemas in a new file; 5 extended shapes in two shipped files; 1 barrel line | **Touches `vendor/shared` → mirror sync + `check-contracts.sh` mandatory.** Mirror **verified in sync** at planning time (`diff -rq` clean), so the `--fix` diff must carry **only** these four files. If it carries more, someone drifted in between — say so, do not revert (root `insights.md` 2026-08-11) |
| client contract mirror | `client/src/vendor/shared/{index.ts,contracts/eval-agent.ts,contracts/knowledge.ts,contracts/eval-ci.ts}` | written by the script | low |
| client Agent fixtures | `AgentCard.test.tsx:21`, `AgentEditor.test.tsx:36`, `SkillsTab.test.tsx:29`, `ContextTab.test.tsx:35` | +1 field each (`auto_eval: false`) | low — **typecheck-caught**, not runtime. R-8's inventory, checked by hand |
| server config | `server/src/platform/config.ts`, `server/.env.example` | 2 entries | low |
| server schema | `server/src/db/schema/eval.ts`, `server/src/db/schema/agents.ts` | +2 cols on `eval_cases`, +5 on `eval_runs`, +1 on `agents`, +3 indexes | **Needs a migration.** Pure additions → `db:generate` must not prompt (`server/insights.md` 2026-08-11) |
| server migrations | `server/src/db/migrations/0017_*.sql` + `meta/0017_snapshot.json` | drizzle-kit output | never hand-edited. 17 snapshots / 17 journal entries verified in agreement; baseline `0016_snapshot.json` |
| server module (**new**) | `server/src/modules/eval/{constants,types,scoring,case-builder,runner,repository,service,routes}.ts`; `src/modules/index.ts` (+1 import, +1 entry) | new vertical slice | medium. The registry entry is what makes the routes exist and is the one defect only `tsc` catches (`server/insights.md` 2026-08-17) |
| server agents module `[P2]` | `modules/agents/{repository,service,routes,helpers}.ts` | skill-link version bumps, restore, `auto_eval`, the trigger call | **medium-high — the most-used write path in the server.** `agents-versions.it.test.ts`, `skills.it.test.ts` and `skills-prompt.it.test.ts` all exercise it |
| server platform | `server/src/platform/container.ts` | +1 lazy getter (`evalTrigger`) + `ContainerOverrides` entry | low; container.ts is the sanctioned composition root |
| client hooks | `client/src/lib/hooks/eval.ts` (**new**), `hooks/keys.ts`, `hooks/index.ts` | new domain hook file + 4 key factories | low |
| **client design system** | `client/src/vendor/ui/nav.ts` | +1 nav row, +1 shortcut | **`src/vendor/**` is do-not-touch by `client/AGENTS.md`.** Sanctioned by D-16 on SPEC-01's precedent; the file's own comment (`:22-27`) names this row |
| client studio | `client/src/app/eval/**` (**new** route tree), `.../AgentEditor/constants.ts`, `.../AgentEditor/AgentEditor.tsx`, `.../AgentEditor/_components/EvalsTab/**` (**new**), `.../FindingCard/FindingCard.tsx`, `client/messages/en/{eval,agents,prReview}.json` | new routes, new tab, one new action | medium. `AgentEditor.test.tsx` needs a test that **mounts the new tab** — the SPEC-01 trap (`client/insights.md` 2026-08-27) is that it passes because it renders `tab="config"` |
| `e2e` | `e2e/specs/12-eval.flow.json` (**new**) | one flow | low |
| `mcp`, `reviewer-core` | — | **none** | spec *Non-goals*. `grep -rnw` over `mcp/src` and `reviewer-core/src` finds no `Eval*` reference |

**Does the wire format change?** Only additively, with one exception. Fourteen **new** endpoints; one **new** contract file; five **extended** contracts, every new field on a shipped shape `.nullish()` or `.default()` per root `insights.md` 2026-08-03. No endpoint removed, renamed or re-verbed. **The one narrowing:** `EvalCase.expected_output` and `EvalCaseInput.expected_output` go from `z.unknown()` to `z.array(EvalExpectedFinding)`. `grep -rnw 'EvalCase|EvalCaseInput|EvalRunRecord|EvalDashboard' server/src client/src mcp/src reviewer-core/src server/test e2e` returns **zero consumers outside `vendor/shared` itself** — including `server/test/contracts.test.ts`, which imports `EvalRun` and nothing else (`contracts.test.ts:12`). This narrowing therefore breaks nothing, and NFR-15 holds.

**The consumer inventory, including the invisible one.** `server/test/contracts.test.ts` is the second, undocumented consumer of every `vendor/shared` shape that no "who reads this contract" audit finds (root `insights.md` 2026-08-28). Checked by name: it constructs `EvalRun` at `:159-167`, which this plan **does not touch** — `EvalRun` and `EvalPerTrace` keep their non-nullable metrics exactly as the spec's *Contract impact* argues. It does **not** construct `Agent`. `server/src/db/seed.ts` is the other construction site and carries no `eval_cases` or `eval_runs` row. Both are clean.

**Does it need a migration?** Yes — step 5, generated, never hand-written.

---

## Execution — single-agent

One `implementer` executes steps 1 → 34 in order, in one context, and runs the verification itself. Steps 21 and 34 are gates, not code.

**The barrier after step 21 is real, not decorative.** `EvalBatchRecord` — reshaped by D-1's `running` status and D-2's derived aggregate — is read again by the client hook (22), the trend (25), the Evals tab (26), both dashboard views (27, 28) and every client assertion. SPEC-03's post-mortem is exactly this: discovering the payload is wrong after the studio cut costs the whole studio cut. **Do not begin step 22 until step 21's gate is green and the served `GET /agents/:id/eval-runs` payload has been read with `app.inject()` and eyeballed.**

**Why multi-agent was assessed and declined.** The split exists — G1 (steps 1-2, one serialized writer: canonical + rsync mirror + four client fixtures is one atomic edit), G2 (3-21, server), G3 (22-31, studio), G4 (32-33, e2e + docs). It was declined for three reasons. G3 is not parallel with G2: its assertions are written against G2's live payload, and D-1/D-2 change that payload. Inside G3 the disjoint-files caveat bites — the Evals tab, both dashboard views and the case editor all read the same `lib/hooks/eval.ts` and the same `keys.ts`, and two parallel client writers collide in both. Only G4 is genuinely parallel with the tail of G3, which is not worth the handoff. The split above stays recoverable if the build is ever resumed by more than one agent.

---

## Steps

### CUT 1A — contracts, config, schema, the eval module (phase 1, server)

### Step 1 — Contracts: the new `eval-agent.ts`, and the five extensions · package: shared (canonical)

- **Files:** create `server/src/vendor/shared/contracts/eval-agent.ts`; modify `contracts/knowledge.ts`, `contracts/eval-ci.ts`, `vendor/shared/index.ts`, `server/test/contracts.test.ts`
- **Satisfies:** AC-19, AC-21, AC-25, AC-104 (shape), AC-109 (shape); NFR-15
- **Skills:** `zod`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck && pnpm exec vitest run contracts`
- **Done when:** `EvalExpectation`, `EvalExpectedFinding`, `EvalBatchRecord`, `EvalBatchStatus`, `EvalDashboardAgentRow`, `EvalWorkspaceDashboard`, `EvalBatchEstimate`, `EvalBatchAccepted` all resolve as `@devdigest/shared` exports; `EvalExpectedFinding.parse({file:'a.ts',start_line:12}).end_line === 12`; `EvalCaseInput.parse({…no expectation…}).expectation === 'must_find'`; `Agent.parse({…no auto_eval…}).auto_eval === false`; `contracts.test.ts` green
- **Notes:**
  - **Placement, decided:** `EvalExpectation` and `EvalExpectedFinding` go in **`knowledge.ts`**, immediately above `EvalCase`, because they are that shape's own vocabulary and `EvalCase` lives there. This adds one import edge `knowledge.ts → findings.js` for `Severity` / `FindingCategory`; verified acyclic — `findings.ts:1` imports zod and nothing else. All the **new API-facing** shapes go in the **new `contracts/eval-agent.ts`**, which is what the barrel convention asks for ("feature agents EXTEND with new files"); `eval-ci.ts` imports `EvalBatchRecord` from it for the `EvalDashboard.batches` extension. Resulting DAG: `findings ← knowledge ← eval-agent ← eval-ci`.
  - `EvalExpectedFinding` carries the object-level `.transform` filling `end_line` from `start_line` (AC-21), so `z.input` ≠ `z.infer`. Export the caller-facing type as `EvalExpectedFindingBody = z.input<typeof EvalExpectedFinding>` — the pattern `ComposeReviewInputBody` already sets (`eval-ci.ts:105-106`). Cap the array at 20 with `.max(20)` **at every use site** (AC-109 / NFR-7).
  - **Every new field on a shipped shape is `.nullish()` or `.default()`, whatever it means** (root `insights.md` 2026-08-03). `EvalRunRecord` gains `agent_id`, `batch_id`, `agent_version`, `expectation`, `expected_count`, `actual_count`, `error` — **each `.nullish()`**. `Agent.auto_eval` is `.default(false)` (D-10). `AgentVersionConfig.restored_from` is `.nullish()` — it is parsed on **every** version read (`agents/helpers.ts:36-39`), so a snapshot written with it must be accepted or `toAgentVersionDto` throws.
  - `EvalBatchStatus = z.enum(['running','complete','partial','failed'])` (D-1). `EvalBatchRecord.recall/precision/citation_accuracy/cost_usd` are `.nullable()`, **not** `.optional()` — `null` is a fact the studio must receive and render as a placeholder (root `insights.md` 2026-08-02: `null` and `0` are different facts).
  - `EvalBatchAccepted = { status: z.literal('accepted'), batch_id: z.string().nullable(), cases: z.number().int(), degraded: z.boolean().nullish(), reason: z.string().nullish() }` — mirrors `IntentDeriveAccepted`'s shape at `modules/reviews/routes.ts:28` (returned at `:163-169`).
  - **Do not touch `EvalRun` or `EvalPerTrace`.** They keep their non-nullable metrics; `contracts.test.ts:159-167` is their only construction site anywhere and a new required field there fails at **runtime**, not at compile time.
  - Add one `contracts.test.ts` case per new shape, and assert the AC-21 transform and the AC-25 default rather than restating the literal — a fixture that only round-trips proves nothing about either.

### Step 2 — Mirror the contracts and repair the four Agent fixtures · package: client

- **Files:** `client/src/vendor/shared/**` (written by the script); modify `AgentCard.test.tsx`, `AgentEditor.test.tsx`, `SkillsTab.test.tsx`, `ContextTab.test.tsx`
- **Satisfies:** the mirror half of every contract criterion; NFR-15
- **Skills:** —
- **Depends on:** Step 1
- **Verify:** `./scripts/check-contracts.sh --fix && ./scripts/check-contracts.sh && cd client && pnpm typecheck && pnpm test`
- **Done when:** `check-contracts: OK`, `cd client && pnpm typecheck` clean, and `git status --porcelain client/src/vendor/shared` lists **only** `index.ts`, `contracts/eval-agent.ts`, `contracts/knowledge.ts`, `contracts/eval-ci.ts`
- **Notes:**
  - The mirror was **verified clean** at planning time (`diff -rq server/src/vendor/shared client/src/vendor/shared` → identical). If `--fix` produces more than those four files, the tree drifted between planning and building: **report it, do not revert** — those files are the mirror catching up (root `insights.md` 2026-08-11).
  - Sync direction is always server → client; never hand-edit the client copy.
  - The four fixtures are typed `const AGENT: Agent = {…}`; `.default()` still yields a **required** field in `z.infer`, so all four need `auto_eval: false`. They already carry `repo_intel` and `ci_fail_on` for the same reason.
  - `client/src/lib/feature-models.ts` is **not** touched — this plan adds no `FeatureModelId`, so the unguarded second mirror (root `insights.md` 2026-08-17) is not in play. Say so; a reviewer will look.

### Step 3 — Config: the two batch ceilings · package: server

- **Files:** `server/src/platform/config.ts`, `server/.env.example`
- **Satisfies:** the knobs AC-41 and AC-110 read; NFR-2, NFR-6
- **Skills:** `zod`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck`
- **Done when:** `loadConfig({}).evalBatchMaxUsd === 0.5` and `.evalBatchMaxMs === 900_000`, and both are overridable from the environment
- **Notes:** `EVAL_BATCH_MAX_USD: z.coerce.number().positive().default(0.5)`, `EVAL_BATCH_MAX_MS: z.coerce.number().int().positive().default(900_000)`, following `LLM_MAX_OUTPUT_TOKENS` (`config.ts:40`) exactly, comment included. **`EVAL_BATCH_MAX_MS` exists so NFR-6 is testable in seconds instead of fifteen minutes** (D-11) — write that reason on the entry, or the next reader will inline the literal.

### Step 4 — Schema: the seven columns and three indexes · package: server

- **Files:** `server/src/db/schema/eval.ts`, `server/src/db/schema/agents.ts`
- **Satisfies:** AC-32, AC-33, AC-36, AC-58, AC-90, AC-111 (substrate); AC-2 and AC-26 asserted, not built (D-17)
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** —
- **Verify:** `cd server && pnpm typecheck`
- **Done when:** the schema declares `eval_cases.expectation`, `eval_cases.created_at`, `eval_runs.{agent_id,agent_version,batch_id,trigger,error}`, `agents.auto_eval` and the three indexes, and `db/rows.ts` exports `EvalCaseRow` / `EvalRunRow`
- **Notes:**
  - Exactly as the spec's *Schema impact* table. `expectation` is `text('expectation', { enum: ['must_find','must_not_flag'] }).notNull().default('must_find')` — Drizzle's `enum` is **TypeScript-only inference and emits no CHECK constraint**; the two values are enforced by Zod at the route, same as `agents.provider` (`schema/agents.ts:15`). A `pgEnum` would need a migration to extend, which is why this repo avoids one (`schema/reviews.ts:72-73` says so).
  - `eval_runs.agent_id` is `uuid NULL REFERENCES agents(id) ON DELETE SET NULL` — **denormalised for the dashboard read, and NOT the tenancy path (AC-2)**. Write that on the column. Tenancy goes `case_id → eval_cases.workspace_id`, asserted at the repository, exactly as `pr_intent`/`pr_brief` scope through `pr_id`.
  - `batch_id` and `agent_version` take **no FK** — there is no batch table (the aggregate is computed on read, D-2), and `agent_versions`' PK is composite with rows that may be absent (D-9 in the spec).
  - Indexes: `eval_cases (owner_kind, owner_id)`, `eval_runs (agent_id, ran_at DESC)`, `eval_runs (batch_id)`. Postgres does not auto-index FK columns. **No GIN on `input_meta`** — AC-16's containment lookup scans at most 50 JSONB blobs per AC-107, which is cheaper than an index nothing else reads.
  - `agents.auto_eval` is `boolean NOT NULL DEFAULT false` — a non-volatile default, so Postgres 16 records it as metadata with no table rewrite.
  - **Do not add `workspace_id` to `eval_runs`.** A second tenancy path that could disagree with the first is exactly what AC-2 exists to forbid.

### Step 5 — Generate the migration · package: server

- **Files:** `server/src/db/migrations/0017_*.sql` + `meta/0017_snapshot.json` (drizzle-kit output)
- **Satisfies:** mechanism for Step 4
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 4
- **Verify:** `ls server/src/db/migrations/meta/*_snapshot.json | wc -l` and `grep -o '"tag": "[^"]*"' server/src/db/migrations/meta/_journal.json | wc -l` **agree** before generating; then `cd server && pnpm db:generate`
- **Done when:** exactly one new `.sql` + one new snapshot exist, the SQL contains only `ALTER TABLE … ADD COLUMN` and `CREATE INDEX`, and no `RENAME` appears anywhere in it
- **Notes:**
  - **Run the two-list check first.** drizzle-kit picks its baseline from the highest-numbered snapshot *file* and never consults the journal, so an orphan snapshot silently diffs against a state nobody applied (`server/insights.md` 2026-08-11). Verified in agreement at planning time — 17 and 17, baseline `0016_snapshot.json`. If they have diverged since, stop and resolve the orphan before generating.
  - This generate is **pure additions**, so it must not open the interactive rename picker — that fires only when one table both gains and loses a column in the same generate (`server/insights.md` 2026-08-11). If it prompts, something in step 4 dropped a column; kill it, fix the schema, regenerate. The prompt is a raw-keypress TUI and is unanswerable from a non-interactive shell.
  - **Read the generated SQL before migrating.** A silent `RENAME` where you wanted an add is data loss.
  - Never hand-edit the file afterwards.

### Step 6 — Apply the migration · package: server

- **Files:** none (DB state)
- **Satisfies:** mechanism for Step 4
- **Skills:** —
- **Depends on:** Step 5
- **Verify:** `cd server && pnpm db:migrate`
- **Done when:** it exits 0 and `docker exec devdigest-postgres psql -U devdigest -d devdigest -c '\d eval_runs'` shows the five new columns
- **Notes:** migrations do **not** run on boot. If `db:migrate` reports success and `psql` disagrees, you are talking to two different Postgres instances — check `docker context ls` before suspecting the migration (`server/insights.md` 2026-08-27).

### Step 7 — `modules/eval/`: the public surface · package: server

- **Files:** create `server/src/modules/eval/constants.ts`, `server/src/modules/eval/types.ts`
- **Satisfies:** AC-106, AC-107, AC-108, AC-109 (the ceilings); the two job kinds
- **Skills:** `onion-architecture` (**read first — it decides placement**)
- **Depends on:** —
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** `EVAL_BATCH_JOB_KIND`, `AGENT_VERSION_EVAL_JOB_KIND`, `MAX_CASES_PER_AGENT = 50`, `MAX_INPUT_DIFF_BYTES = 262_144`, `MAX_EXPECTED_FINDINGS = 20`, `MAX_BATCHES_RETURNED = 50`, `PRECISION_ALERT_DELTA = 0.02` and the `EvalTrigger` interface are exported
- **Notes:**
  - **`constants.ts` and `types.ts` are a module's entire public surface** — `no-cross-module-internals` allows `^src/modules/[^/]+/(constants|types)\.ts$` and nothing else (`.dependency-cruiser.cjs:116-133`). Everything the `agents` module and the container need from `eval` must live in these two files, and nothing else in the module may be imported from outside it.
  - `AGENT_VERSION_EVAL_JOB_KIND = 'agent-version-eval'` published here is the **phase-2 cross-module trigger**, the same pattern `repos/service.ts` uses for `INDEX_JOB_KIND`.
  - `types.ts` declares `EvalTrigger` — the facade step 18 puts on the container. Interface only; no implementation, no import of anything below it.

### Step 8 — The scorer · package: server

- **Files:** create `server/src/modules/eval/scoring.ts`, `server/test/eval-scoring.test.ts`
- **Satisfies:** AC-44, AC-45, AC-46, AC-47, AC-48, AC-49, AC-50, AC-51, AC-52, AC-53, AC-54, AC-55, AC-56, AC-57, AC-74; NFR-13
- **Skills:** `typescript-expert`
- **Depends on:** Step 1, Step 7
- **Verify:** `cd server && pnpm exec vitest run eval-scoring`
- **Done when:** the table-driven suite is green, including NFR-13's two exact perturbations — three unmatched extras added to ten matched findings lower precision by exactly `0.2308` (3/13) and removing one of five expectations lowers recall by exactly `0.2`
- **Notes:**
  - **Pure. No `this`, no I/O, no container, no LLM.** AC-56's verification is that the injected LLM port records zero calls during scoring — a pure module makes that structurally true.
  - `matchesRange(actual, expected)` — same `file`, and `actual.start_line <= expected.end_line && expected.start_line <= actual.end_line`. **D-5 applies: this is a local predicate, not `groundCitations`.** Cite `reviewer-core/src/grounding.ts:68` (called at `:119`) in the doc comment as the predicate it deliberately mirrors, and say why it is not imported (`rangeIntersects` is off the barrel on purpose; exporting it is a `reviewer-core` change SPEC-04's *Non-goals* forbids).
  - **AC-57: apply the range test to every actual finding regardless of `kind`.** A model that labels a fabricated finding `secret_leak` must not thereby exempt itself. This is the scorer's half of the trap root `insights.md` 2026-08-28 records; assert it with a `kind:'secret_leak'` finding at a non-intersecting range scored as noise.
  - Metric rules, in the order they resolve: **recall** = matched expected ÷ all expected across the batch's `must_find` cases, `null` when the denominator is 0 (AC-45, AC-46). **Noise** = every actual finding on a `must_not_flag` case (D-4, subsuming AC-47 and AC-49) + every actual finding on a `must_find` case matching no expectation (AC-48). **precision** = 1 − noise ÷ all actual findings; `1` when the batch produced none (AC-51). **citation_accuracy** = per case, kept ÷ (kept + dropped), `null` at zero candidates (AC-52, AC-53); per batch, the **micro-average** Σkept ÷ Σ(kept+dropped) over cases that produced a candidate, `null` when none did (D-6). **`pass`** splits by expectation (D-3). **AC-38 outranks AC-51** — an all-failed batch reports all three as `null` (D-15).
  - `alertFor(previous, current)` returns `{ metric, delta }` when precision dropped by ≥ `PRECISION_ALERT_DELTA`, else `null`. Assert `0.02` fires and `0.01` does not (AC-74). The **English sentence is the studio's** (D-14); the server's `alert` string is a convenience the `server-unit` test asserts and nothing else reads.
  - Compute the expected values in the test **independently of the implementation** — a literal copied out of the code cannot fail for the reason NFR-13 cares about (`server/insights.md` 2026-08-29).

### Step 9 — Mutation-check the scorer · package: server

- **Files:** none (a temporary edit, reverted)
- **Satisfies:** REC-10 — the control that makes step 8 trustworthy
- **Skills:** —
- **Depends on:** Step 8
- **Verify:** break `matchesRange` (`return false`), run `pnpm exec vitest run eval-scoring`, **quote the failure message in the report**; revert; re-run green; `grep -c 'return false' server/src/modules/eval/scoring.ts` to prove the revert
- **Done when:** the AC-44 table and NFR-13's two rows both go red with the mechanism broken, and green with it restored
- **Notes:** budget one mutation check per **mechanism-pinning** test, not per suite (root `insights.md` 2026-08-29). If a test stays green with the matcher broken, the fixture reaches the right answer down the wrong path and must be rebuilt so the mechanism is the only thing that can produce it. Repeat for `alertFor`'s threshold.

### Step 10 — The repository · package: server

- **Files:** create `server/src/modules/eval/repository.ts`
- **Satisfies:** AC-1, AC-2, AC-4, AC-26, AC-37, AC-38, AC-108; NFR-3
- **Skills:** `drizzle-orm-patterns`, `postgresql-table-design`
- **Depends on:** Step 4, Step 6, Step 7
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck`
- **Done when:** every method takes `workspaceId` **first**, no method returns a row it has not scoped, and `batchesForAgent` / `batchesForWorkspace` return `EvalBatchRecord[]` with the derived status
- **Notes:**
  - **Drizzle lives only here** (`no-drizzle-outside-persistence`). No HTTP type crosses into this file, and it imports no other module's repository.
  - **Tenancy is `case_id → eval_cases.workspace_id`, always joined, never assumed from `agent_id`** (AC-2). A run whose `agent_id` names a foreign agent must still be readable in its own workspace — that is AC-2's integration observation, and it is a property of this join.
  - **D-2's derivation lives here**, in one method, with the rule in a comment: `cases_total` = rows in batch; `cases_ran` = `pass IS NOT NULL`; `failed` = `error IS NOT NULL`; status = `running` if the service reports the batch active, else `failed` if all rows errored, else `complete` if all rows are scored-or-errored, else `partial`. The active-batch set is passed **in** as an argument — the repository stays stateless.
  - `batchesForWorkspace` caps at `MAX_BATCHES_RETURNED` newest-first (AC-108, AC-71) and drives NFR-3, so it must be **one query with the aggregate in SQL**, not N+1 over batches. `eval_runs (agent_id, ran_at DESC)` and `eval_runs (batch_id)` are the indexes it needs.
  - AC-16's idempotency lookup is a containment scan over `input_meta.source_finding_ids`, scoped to the one agent's cases. No GIN index; the 50-case ceiling is what makes that cheap.
  - **AC-26 needs no code** — `eval_runs.case_id` is already `ON DELETE CASCADE`. Comment the delete method to say so, so nobody adds a redundant manual delete (D-17).
  - If a "last updated" timestamp is ever set on a conflict path here, stamp it with `sql\`now()\``, never `new Date()` — the two-clocks trap (`server/insights.md` 2026-08-17).

### Step 11 — The case builder · package: server

- **Files:** create `server/src/modules/eval/case-builder.ts`, `server/test/eval-case-builder.test.ts`
- **Satisfies:** AC-10, AC-13, AC-14, AC-15, AC-17
- **Skills:** `typescript-expert`
- **Depends on:** Step 1, Step 7
- **Verify:** `cd server && pnpm exec vitest run eval-case-builder`
- **Done when:** given a finding row, a pull row and the PR's `pr_files`, it returns the case fields; a finding whose file is absent from the diff returns a typed refusal; and two findings on one file produce `name` and `name-2`
- **Notes:**
  - **Pure.** It takes rows in and returns values out; the service does the I/O. This is what makes AC-10/AC-15/AC-17 unit-testable without Docker.
  - The diff fragment: rebuild the synthetic unified diff from the PR's persisted `pr_files` patches, then `parseUnifiedDiff` (`server/src/adapters/git/diff-parser.ts:14`), then `sliceDiff` (`@devdigest/reviewer-core`, on the barrel) for the finding's file. **`loadDiff` and `diffFromPrFiles` are NOT reusable** — `modules/reviews/diff-loader.ts` is another module's internal, forbidden by `no-cross-module-internals`, and `loadDiff` needs a `PullRow` plus a `repos` row an eval case has not got. The five lines are rebuilt here; say so in the file, as the spec says for `buildSkillBlocks`.
  - AC-15's suffix is the **lowest unused** numeric suffix among that agent's cases, not a counter.
  - AC-17 is a refusal, not an exception thrown from a pure function — return a discriminated result and let the service raise the 422.

### Step 12 — The batch runner · package: server

- **Files:** create `server/src/modules/eval/runner.ts`, `server/test/eval-runner.test.ts`
- **Satisfies:** AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34, AC-36, AC-41, AC-58, AC-110, AC-111, AC-113, AC-115; NFR-1, NFR-12, NFR-16
- **Skills:** `onion-architecture`
- **Depends on:** Step 8, Step 10, Step 11
- **Verify:** `cd server && pnpm lint:arch && pnpm exec vitest run eval-runner`
- **Done when:** a two-case batch against `MockLLMProvider` writes two `eval_runs` rows sharing one `batch_id`, emits exactly two `info` log lines, writes **zero** `agent_runs` rows, and records **zero** calls on the injected git and GitHub ports
- **Notes:**
  - **Third-party SDKs never appear here.** The LLM arrives as a resolved `LLMProvider` from `container.llm(provider)`; the engine arrives as `reviewPullRequest` from `@devdigest/reviewer-core`. `no-vendor-sdks-outside-adapters` is the check.
  - **Prompt slots (AC-28, AC-29):** pass `{ systemPrompt, model, diff, llm, strategy, skills, task }` and **nothing else**. Omitting `specs`, `repoMap`, `callers`, `memory`, `intent` is what makes AC-29 true — `assemblePrompt` drops an absent section. Do not pass an empty string; pass nothing.
  - **AC-30:** one skill block per link where `agent_skills.enabled` **and** `skills.enabled` are both true, **in link order**, built with `skillPromptBlock(toSkillDto(row))` from `modules/_shared/skills.ts:18,58` — those are pure and shared precisely so this module can use them. `buildSkillBlocks` (`modules/reviews/run-executor.ts`) is **not** moved and **not** imported: it does I/O and logging, and `_shared/` is pure by convention.
  - **AC-31:** the reviewed diff is `parseUnifiedDiff(case.inputDiff)`. Nothing on this path may touch `container.git` or `container.github` — that is AC-31's verification, and the test asserts zero calls on both ports.
  - **AC-34:** never call `ReviewRunExecutor` and never write `agent_runs`. Assert the count is unchanged across a batch.
  - **D-2:** insert all N rows first (metrics null, `batch_id`/`agent_id`/`agent_version`/`trigger` set), then update each in place. Cases never reached under AC-41 or AC-110 keep their all-null row, which is what makes the batch read `partial`.
  - **AC-41 (D-12):** before each case, if `mean(completed priced cost_usd) + running total > evalBatchMaxUsd`, stop **before** the call. `null` costs never bind (OQ-6). **AC-110:** check the elapsed clock against `evalBatchMaxMs` at the same checkpoint. Both leave the batch `partial`.
  - **AC-36 / AC-111:** a provider failure or a post-retry schema failure writes that row's `error` and the batch continues. `DEFAULT_REVIEW_MAX_RETRIES = 2` is the engine's, unchanged.
  - **AC-58:** persist `cost_usd` as reported or estimated, and `null` when neither — **never `0`**. `null` and `0` are different facts (root `insights.md` 2026-08-02); `z-ai/glm-4.7-flash` is genuinely priced at 0 (`adapters/llm/pricing.ts:30`), which is why the distinction is observable.
  - **AC-113 / NFR-12 / NFR-16:** exactly one `info` line per case, carrying **the batch id, the case id and the three metric values, and nothing else**. Pin it with a case whose diff contains a sentinel string and assert the captured Pino output does not contain it. Do not log the diff, the expected output, a finding body or a provider message.
  - **AC-115** is already true — `assemblePrompt` fences the diff and `wrapUntrusted` escapes an embedded `</untrusted>` (`reviewer-core/src/prompt.ts:16-45`). This step **asserts** it on the assembled message; it changes nothing in `reviewer-core`.
  - **The stub must enforce what it stands in for.** If the test asserts a token or cost budget, make `StubLlm` behave like a provider that enforces it — a stub that ignores the parameter makes that parameter unfalsifiable (`server/insights.md` 2026-08-29).

### Step 13 — The service · package: server

- **Files:** create `server/src/modules/eval/service.ts`, `server/test/eval-service.test.ts`
- **Satisfies:** AC-3, AC-7, AC-8, AC-9, AC-11, AC-12, AC-16, AC-18, AC-20, AC-22, AC-23, AC-24, AC-35, AC-39, AC-40, AC-42, AC-43, AC-72, AC-114
- **Skills:** `onion-architecture`
- **Depends on:** Step 10, Step 11, Step 12
- **Verify:** `cd server && pnpm lint:arch && pnpm exec vitest run eval-service`
- **Done when:** it owns the in-memory active-batch registry, registers the `eval-batch` handler, and every refusal in the list above raises the right `AppError` subclass
- **Notes:**
  - **Cross-module reads go through the container only:** `container.reviewRepo.findingContext` (`modules/reviews/repository.ts:113-118`) for AC-7/8/9/11/12/18, `container.reviewRepo.getPrFiles` (`:38-39`) for AC-10, `container.agentsRepo.getById` / `.linkedSkills` (`repository.ts:205`) for the agent config. All three are on the container and therefore legal; nothing else in `modules/reviews/` or `modules/agents/` may be imported.
  - **AC-9: `accepted_at` wins** when both timestamps are set.
  - **AC-114 — mass assignment.** Never spread a parsed body into an insert. `workspace_id`, `owner_kind` and `owner_id` are taken from the **resolved context and the path**, never from the body; a body carrying them must not move the row's tenant or owner. This is the criterion with the highest blast radius in the spec — write the field list out longhand.
  - **AC-3:** `owner_kind: 'skill'` is a `validation_error` (422) — nothing in this feature runs a skill's cases, and accepting a case the system will never execute is worse than refusing it.
  - **The 202 path, in order (D-1):** resolve the agent (404 if unknown or foreign, AC-4) → refuse if 0 cases (422, AC-35) → refuse if that agent already has an active batch (422, AC-40) → `await container.llm(agent.provider)`, which throws `ConfigError` → 500 `config_error` **before any model call** (AC-39) → allocate `batch_id` → mark active → `container.jobs.enqueue(EVAL_BATCH_JOB_KIND, …)` → return `EvalBatchAccepted`. Clear the active mark in the handler's `finally`.
  - **AC-42 / AC-43 — the workspace-wide run:** one batch per **enabled** agent that has ≥1 case. An agent whose `container.llm` throws is **skipped** with `{ degraded: true, reason: 'config_error' }` in its entry rather than failing the whole request — no AC covers this; it is a plan decision, and it belongs in a comment.
  - **AC-72's estimate:** `cases` and `agents` from the same query, `est_cost_usd` from the mean per-case cost across the workspace's priced `eval_runs`; **`null` when no priced batch exists, never `0`**.
  - Errors are `AppError` subclasses; the single handler in `app.ts` builds the `{error:{code,message,details}}` envelope. Do not build it here. `instanceof z.ZodError` is unreliable across package boundaries — let the shared handler match by shape (`app.ts:138`).

### Step 14 — Routes and the registry entry · package: server

- **Files:** create `server/src/modules/eval/routes.ts`; modify `server/src/modules/index.ts`; create `server/test/eval-routes.test.ts`
- **Satisfies:** every endpoint; AC-19, AC-20, AC-106, AC-109; NFR-5, NFR-7
- **Skills:** `fastify-best-practices`, `zod`
- **Depends on:** Step 13
- **Verify:** `cd server && pnpm typecheck && pnpm lint:arch && pnpm exec vitest run eval-routes routes-smoke`
- **Done when:** all thirteen routes are served, each declares a Zod `response:` schema, and a body-less POST to each of the four action routes returns 202 rather than 422
- **Notes:**
  - **The registry entry is not boilerplate** — it is what makes the endpoints exist, and a duplicated or missing key is the one defect only `tsc` catches (`server/insights.md` 2026-08-17). Run `pnpm typecheck` specifically after editing `modules/index.ts`.
  - The surface:

    | Method + path | Response | Criteria |
    |---|---|---|
    | `POST /findings/:id/eval-case` | `EvalCase` (201; **200** when idempotent) | AC-5-AC-18 |
    | `GET /agents/:id/eval-cases` | `EvalCase[]` | AC-63, AC-64 |
    | `POST /agents/:id/eval-cases` | `EvalCase` (201) | AC-19-AC-25, AC-107 |
    | `GET /eval-cases/:id` | `EvalCase` | AC-4 |
    | `PUT /eval-cases/:id` | `EvalCase` | AC-19-AC-24 |
    | `DELETE /eval-cases/:id` | `{ok:true}` | AC-26 |
    | `POST /agents/:id/eval-runs` | `EvalBatchAccepted` (202) | AC-27, AC-33, AC-35, AC-39, AC-40 |
    | `POST /eval-cases/:id/runs` | `EvalBatchAccepted` (202) | D-9 |
    | `POST /eval/runs` | `EvalBatchAccepted[]` (202) | AC-42, AC-43 |
    | `GET /agents/:id/eval-runs` | `EvalBatchRecord[]` | AC-61, AC-62, AC-66 |
    | `GET /eval/estimate` | `EvalBatchEstimate` | AC-72 |
    | `GET /eval` | `EvalWorkspaceDashboard` | AC-69, AC-70, AC-71, AC-108 |
    | `GET /eval/agents/:agentId` | `EvalDashboard` | AC-73, AC-74 |

  - **The four action POSTs take no body, so they must declare no `body:` schema at all** — a declared Zod body schema rejects a body-less POST with 422 (`server/insights.md` 2026-08-29). Settle it with a real `app.inject()` **before** building anything on top: the entry's own table shows the failure mode is silent enough to ship a criterion green and unproven.
  - **Use `:id`, not `:agentId`, on anything under `/agents/`** — the agents module already registers `/agents/:id/*`, and matching the param name keeps find-my-way out of it. `:agentId` appears only under `/eval/agents/:agentId`, a different prefix.
  - A declared `response:` schema **strips unknown keys**, so check the service's return shape against the contract before adding one to a route that already exists (`server/insights.md` 2026-08-18). A top-level `.nullable()` response serialises `null` fine (2026-08-28) — no envelope needed.
  - **NFR-5 (256 KB) and NFR-7 (20 entries) are route-level refusals**, so they are `server-unit` and need no Docker. Assert the 257 KB body and the 21-entry array both 422 **with the failing Zod path in `error.details`** (AC-20).
  - Routes are transport only. No business logic, no DB access, no `container.db`.

### Step 15 — Phase-1 server unit gate · package: server

- **Files:** none
- **Satisfies:** verification for the `server-unit` rows of AC-3, AC-17, AC-19, AC-20, AC-23, AC-24, AC-39, AC-56, AC-74, AC-106, AC-109, AC-113; NFR-5, NFR-7, NFR-12, NFR-13, NFR-16
- **Skills:** —
- **Depends on:** Step 14
- **Verify:** `cd server && pnpm typecheck && pnpm lint:arch && pnpm exec vitest run --exclude '**/*.it.test.ts'`
- **Done when:** all three are green and `lint:arch` reports `no dependency violations found`
- **Notes:** `lint:arch` is the **only** enforced architecture rule in this repository and it scans `server/src` only (root `insights.md` 2026-08-17). Once it is green, quote the result rather than re-deriving the rules it proved.

### Step 16 — Phase-1 server integration suite · package: server

- **Files:** create `server/test/eval.it.test.ts`
- **Satisfies:** the `server-integration` rows of AC-1, AC-2, AC-4, AC-7-AC-16, AC-18, AC-21, AC-22, AC-25, AC-26, AC-27, AC-32-AC-38, AC-40-AC-43, AC-55, AC-58, AC-107, AC-108, AC-110, AC-111, AC-114; NFR-1, NFR-2, NFR-3, NFR-4, NFR-6
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 15
- **Verify:** `cd server && DOCKER_HOST=… TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock pnpm exec vitest run eval.it`
- **Done when:** every row above has an assertion and the file is green
- **Notes:**
  - **Environment-dependent, not optional-to-write.** `*.it.test.ts` needs a reachable Docker socket, and the two entries in `server/insights.md` (2026-08-27, 2026-08-29) disagree about which socket works on this machine — try Colima first, fall back to Rancher, and record which one worked rather than editing either entry.
  - **Override every provider the code will resolve, not just the agent's** (`server/insights.md` 2026-08-17). An eval batch resolves the *agent's* provider; a suite that overrides only `openai` while an agent is configured for `openrouter` makes a **real, billable** call. The tell is an assertion failing against a value that exists in a prompt file rather than in the fixture.
  - **AC-110 and NFR-6 are testable only because of `EVAL_BATCH_MAX_MS`** (D-11): build the app with it set to ~2 s and a stub provider that delays past it, then assert `status === 'partial'`. Never write a test that waits fifteen minutes.
  - **NFR-1 and NFR-3 are generous absolute ceilings** (D-11/REC-2), not p95 measurements — a timing assertion in a testcontainers suite is a flake generator.
  - **AC-2's observation is the interesting one:** a run whose `agent_id` names a **foreign** agent must still be readable in its own workspace. That is what proves the tenancy path is the `case_id` join and not `agent_id`.
  - **AC-26 and AC-2 are asserted, not built** (D-17). Say so in the test's comment so a reader does not go looking for the code.

### CUT 1B — phase 2, server

### Step 17 `[P2]` — Agents: skill-link version bumps, restore, `auto_eval` · package: server

- **Files:** modify `server/src/modules/agents/repository.ts`, `server/src/modules/agents/service.ts`, `server/src/modules/agents/helpers.ts`
- **Satisfies:** AC-80, AC-81, AC-82, AC-83, AC-84, AC-103, AC-104
- **Skills:** `drizzle-orm-patterns`, `onion-architecture`
- **Depends on:** Step 6, Step 7
- **Verify:** `cd server && pnpm typecheck && pnpm lint:arch && pnpm exec vitest run skills-helpers`
- **Done when:** each of `linkSkill`, `unlinkSkill`, `setSkillEnabled`, `setSkills` bumps `agents.version` and writes an `agent_versions` snapshot whose `config_json.skills` reflects the new link set; `restoreVersion` writes a new version whose config equals the restored one plus `restored_from`
- **Notes:**
  - **This is the highest-risk file in the plan** — `AgentsRepository.update` is the server's most-exercised write path (`agents-versions.it.test.ts`, `skills.it.test.ts`, `skills-prompt.it.test.ts`). Add a `bumpVersionForSkillChange` method rather than threading a flag through `update`; keep the existing `update` semantics byte-identical.
  - `snapshotVersion` is `onConflictDoNothing` (`repository.ts:179`) — a bumped version is new, so it inserts. Do **not** change that clause; D-9 in the spec depends on a snapshot legitimately being absent.
  - **AC-103 / AC-104:** the restored config is written as a **new** version (never a rewrite of history), with `restored_from` set. `AgentVersionConfig` gained the field in step 1, which matters because `toAgentVersionDto` parses it on **every** version read (`helpers.ts:36-39`) and would throw on an unrecognised key.
  - `toAgentDto` gains `auto_eval: row.autoEval`. `isConfigChange` is **not** extended — `auto_eval` is an operational switch, not review config, and putting it in the bump rule would make toggling auto-eval enqueue an auto-eval.
  - Keep the mappers in `helpers.ts` pure.

### Step 18 `[P2]` — The `EvalTrigger` facade and the `agent-version-eval` handler · package: server

- **Files:** create `server/src/modules/eval/trigger.ts`; modify `server/src/modules/eval/{types,service}.ts`, `server/src/platform/container.ts`, `server/src/modules/agents/service.ts`; create `server/test/eval-trigger.test.ts`
- **Satisfies:** AC-85, AC-87, AC-88, AC-89, AC-90, AC-91, AC-92, AC-105; NFR-17
- **Skills:** `onion-architecture`
- **Depends on:** Step 13, Step 17
- **Verify:** `cd server && pnpm lint:arch && pnpm typecheck && pnpm exec vitest run eval-trigger`
- **Done when:** five rapid bumps of one agent queue at most one `agent-version-eval` job; a stale payload returns without a provider call; a duplicate payload starts no second batch; a restore enqueues nothing; and with no handler registered the version bump still completes and returns the agent
- **Notes:**
  - **Why a facade, and why it is not in the spec.** The spec's hop 13 has `AgentsRepository.update` call `container.jobs.enqueue` directly, but AC-87's debounce is an **in-memory pending marker owned by the eval module** (the spec says so, because `JobRunner.enqueue` schedules on a p-queue immediately and exposes no cancel — cancelling a queued row would not unschedule the task). A marker the eval module owns cannot be consulted from inside `agents`. So `container.evalTrigger` — interface in `modules/eval/types.ts` (a legal cross-module import), implementation in `modules/eval/trigger.ts`, lazy getter on the container, overridable through `ContainerOverrides`. `container.repoIntel` is the shipped precedent for exactly this shape, **including that it degrades instead of throwing**.
  - `onAgentVersionBumped(workspaceId, agentId, version, changed)` does, in order: the **AC-85 allow-list** check (`system_prompt`, `model`, `provider`, `strategy`, `output_schema`, skill set — D-13; `ci_fail_on`, `repo_intel`, `name`, `description` enqueue nothing) → `auto_eval` check → the in-memory pending check (AC-87, NFR-17) → `enqueue`, **wrapped in try/catch**. `jobs.enqueue` throws when no handler is registered (`platform/jobs.ts:50-51`); AC-91 requires the bump to complete and return the agent anyway, so swallow it and log once.
  - **AC-105:** the restore path does **not** call the trigger. A restore bumps the version, and billing a batch for a rollback is exactly what D-21 in the spec exists to prevent.
  - The handler: **AC-88** re-reads the agent's current `version` and skips when the payload is stale — this is the durable half of the debounce; **AC-89** skips when a batch already exists for that agent id and version with `trigger:'version-change'`; **AC-90** stamps `trigger:'version-change'` on every row. Then it calls the **same runner** as a manual batch.
  - **AC-92 / OQ-3 (D-1):** the 120 s `JobRunner` timeout will fire on any batch of more than a handful of cases. `withTimeout` rejects the race but **does not abort the underlying promise** (`platform/resilience.ts:13-24`), and `TimeoutError` carries no `status`/`code`, so `defaultIsRetryable` returns false — the `jobs` row goes `failed`, the batch runs on and persists normally, and nothing retries it. That is **accepted**. AC-92's log line pairing the batch id with the failed job id is the only thing that makes the two reconcilable by hand; write it, and assert it.

### Step 19 `[P2]` — Agents routes: restore and `auto_eval` · package: server

- **Files:** modify `server/src/modules/agents/routes.ts`
- **Satisfies:** AC-103, AC-104, AC-105 (route half); `auto_eval` on the create/update bodies
- **Skills:** `fastify-best-practices`, `zod`
- **Depends on:** Step 17, Step 18
- **Verify:** `cd server && pnpm typecheck && pnpm exec vitest run routes-smoke`
- **Done when:** `POST /agents/:id/versions/:version/restore` returns the updated `Agent`, and `auto_eval` round-trips through `POST /agents` and `PUT /agents/:id`
- **Notes:** the restore route takes **no body**, so it declares **no `body:` schema** (`server/insights.md` 2026-08-29). Reuse the existing `VersionParams` (`routes.ts:14-17`) — it already coerces the version to a positive integer. `auto_eval: z.boolean().optional()` on both bodies; a missing value must not clear an existing one.

### Step 20 `[P2]` — Phase-2 server integration suite · package: server

- **Files:** create `server/test/agents-eval.it.test.ts`
- **Satisfies:** the `server-integration` rows of AC-80-AC-92, AC-103, AC-104, AC-105; NFR-17
- **Skills:** `drizzle-orm-patterns`
- **Depends on:** Step 19
- **Verify:** `cd server && pnpm exec vitest run agents-eval.it`
- **Done when:** every row above has an assertion and the file is green
- **Notes:**
  - **AC-91's observation is the `PUT /agents/:id` response with no handler registered** — build that app without registering the eval handler, and assert the agent comes back 200. It is the one criterion that proves the degradation path.
  - **NFR-17** — five rapid bumps, then count the queued `jobs` rows for that agent. Mutation-check it (clear the pending marker and confirm the count goes to five), or it pins nothing.
  - `waitForPrRuns`-style polling on job status is not enough here: assert on the **`eval_runs` rows**, which are the record of what happened, not on the `jobs` row, which D-1 accepts may disagree.

### Step 21 — **BARRIER · the server gate**

- **Files:** none
- **Satisfies:** verification for every server-side criterion
- **Skills:** —
- **Depends on:** Step 20
- **Verify:**
  ```sh
  cd server && pnpm typecheck && pnpm lint:arch && pnpm test
  ./scripts/check-contracts.sh
  cd client && pnpm typecheck && pnpm test        # must still be green from step 2
  ```
- **Done when:** all four are green **and** the served `GET /agents/:id/eval-runs` payload has been read through `app.inject()` and reviewed against `EvalBatchRecord`
- **Notes:** **do not start step 22 until this is green.** Six studio surfaces are written against this payload; discovering it is wrong afterwards costs the whole studio cut.

### CUT 2 — the studio (phase 1)

### Step 22 — Client hooks and cache keys · package: client

- **Files:** create `client/src/lib/hooks/eval.ts`; modify `client/src/lib/hooks/keys.ts`, `client/src/lib/hooks/index.ts`
- **Satisfies:** the data layer for AC-59-AC-79 and AC-93-AC-102
- **Skills:** `react-best-practices`
- **Depends on:** Step 21
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** every screen's data comes from a typed hook in this file, and no component in the plan calls `fetch` or writes an inline `queryKey`
- **Notes:**
  - **`lib/api.ts` is the only place that talks HTTP.** Never `fetch` in a component.
  - **Cache keys come from `keys.ts`.** Add `evalKeys = { workspace, agent(id), cases(agentId), batches(agentId), estimate, case(caseId) }`. **Read the tuples, not the header comment** — the header teaches a `reviewKeys.all` that does not exist, and the prefixes deliberately do **not** nest, so a mutation must invalidate the broad and the specific key **explicitly** (`client/insights.md` 2026-08-17). Copy `useUpdateAgent`'s pairing (`hooks/agents.ts:66-69`), not the comment.
  - **Polling (AC-66, D-1):** `useEvalBatches(agentId)` sets `refetchInterval` while any batch reads `running`, and drops it to `false` otherwise. The default query config is `staleTime: 30_000, refetchOnWindowFocus: false` (`lib/providers.tsx:28-29`), so nothing else will refresh the screen.
  - **Types come from `@devdigest/shared`, as `import type` only.** A runtime import from that package breaks the webpack build while `typecheck` and `vitest` both pass (`client/insights.md` 2026-08-11). Audit with `grep -rn 'from "@devdigest/shared"' src | grep -v 'import type'`.
  - Confirm each hook's path is actually served before wiring it into a screen — `node .claude/skills/api-breaking-changes/check.mjs` lists studio call sites with nothing behind them, and two shipped hooks already call endpoints that have never existed (`client/insights.md` 2026-08-11).

### Step 23 — i18n · package: client

- **Files:** modify `client/messages/en/eval.json`, `client/messages/en/prReview.json`
- **Satisfies:** the copy behind AC-61, AC-64, AC-65, AC-70, AC-72, AC-74, AC-77, AC-78, AC-79
- **Skills:** —
- **Depends on:** —
- **Verify:** `cd client && pnpm typecheck`
- **Done when:** every key the new components call resolves, checked by diffing the called keys against the flattened catalogue
- **Notes:**
  - **Most of the catalogue already ships.** `eval.json` carries `dashboard.*`, `caseEditor.*`, `evalsTab.*` and `page.*` in full; `shell.json` already has `nav.eval: "Eval Dashboard"` (which is what AC-68 requires byte-identical); `agents.json` already has `editor.tabs.evals: "Evals"` (AC-59). **Add only what is missing** — the alert sentence (D-14, composed from `alert_metric` + `alert_delta`), the expectation labels, the `must_not_flag` chip, the batch-status labels, the compare/restore strings, and `prReview.json` → `finding.turnIntoEvalCase` + its disabled hint.
  - **The catalogues are load-bearing test data**, not cosmetics: the RTL suites import the real JSON and assert rendered English, and next-intl renders the key itself rather than throwing, so a missing key fails a test rather than the build (`client/insights.md` 2026-08-11). After adding a component, diff its called keys against the catalogue: `grep -rhoE 't\("([a-zA-Z0-9_.]+)"' <dir>` plus a pass for template literals.
  - `finding.learn` and `finding.replyToAuthor` stay **unused** (OQ-4's assumption). Do not wire them.

### Step 24 — The sidebar row and the shortcut · package: client

- **Files:** modify `client/src/vendor/ui/nav.ts`
- **Satisfies:** AC-68; UX-8
- **Skills:** —
- **Depends on:** Step 23
- **Verify:** `cd client && pnpm typecheck && pnpm test`
- **Done when:** one row appears under `SKILLS LAB` whose `label` is byte-identical to `shell.json`'s `nav.eval` ("Eval Dashboard"), with `gKey: "e"`, and `SHORTCUTS` gains `g e`
- **Notes:**
  - **This edits `client/src/vendor/**`, which `client/AGENTS.md` lists as do-not-touch. It is sanctioned (D-16)** on SPEC-01's precedent, and the file's own comment (`nav.ts:22-27`) names the Eval Dashboard row as deliberately withheld "until their routes land". Update that comment in the same edit so it stops naming a row that now exists. **Call this out in the PR description**, or a reviewer will flag it.
  - **Exactly one row.** The GLOBAL group (Memory, Multi-Agent Review, Agent Performance, CI Runs) and the Onboarding Tour row stay withheld — `NavItem` renders a bare `<Link>` with no existence guard, so a row for an unbuilt page is a 404 the sidebar invites you to click.
  - `label` must stay byte-identical to `shell.nav.eval`: the sidebar renders this literal while the command palette renders the translation, and the two surfaces would otherwise disagree. That equality **is** AC-68.
  - `e` is free — `p x s a c ,` are taken.

### Step 25 — `MetricTrend`, the inline-SVG chart · package: client

- **Files:** create `client/src/app/eval/_components/MetricTrend/{MetricTrend.tsx,styles.ts,index.ts,MetricTrend.test.tsx}`
- **Satisfies:** AC-75; NFR-8, NFR-9
- **Skills:** `dataviz`, `react-best-practices`, `react-testing-library`
- **Depends on:** Step 22
- **Verify:** `cd client && pnpm exec vitest run MetricTrend`
- **Done when:** three series render as SVG paths, the x-axis exposes **ordinal** labels as text in the accessibility tree, every series is distinguishable without colour, and each colour measures ≥ 4.5:1 against its background
- **Notes:**
  - **D-7: this exists because `LineChart` cannot serve AC-75.** `client/src/vendor/ui/charts/LineChart.tsx:44` renders `<XAxis dataKey="i" hide />` — there are no axis labels at all — and Recharts' `ResponsiveContainer` measures 0×0 under jsdom, so nothing renders to assert on. `LineChart` is neither used nor edited here. Model this on `Sparkline` (`charts/Sparkline.tsx`), which is plain inline SVG and does render in jsdom.
  - **NFR-8's contrast test needs the `css: false` bridge**: compute the ratio from a copy of the token table in the test **and** bind it to the component by asserting the token it actually paints (`expect(el.style.stroke).toBe("var(--accent)")`), which jsdom preserves verbatim. `DocRow.test.tsx:42-129` is the worked example. Accept and state the two costs: the token table is a copy, and the surfaces are a static read of the call sites.
  - **NFR-9:** the metric each line represents must be readable without colour — a text label or a glyph per series in the accessibility tree.
  - X is **batch ordinal**, never a date. A time axis is not representable here and OQ-1's "30 days" control is omitted in phase 1.

### Step 26 — The Evals tab · package: client

- **Files:** modify `.../AgentEditor/constants.ts`, `.../AgentEditor/AgentEditor.tsx`, `.../AgentEditor/AgentEditor.test.tsx`; create `.../AgentEditor/_components/EvalsTab/{EvalsTab.tsx,styles.ts,index.ts,EvalsTab.test.tsx}` and its `_components/`
- **Satisfies:** AC-59, AC-60, AC-61, AC-62, AC-63, AC-64, AC-65, AC-66, AC-67, AC-112; NFR-8, NFR-9, NFR-10, NFR-11
- **Skills:** `react-best-practices`, `next-best-practices`, `react-testing-library`, `frontend-ui-architecture`
- **Depends on:** Step 22, Step 23, Step 25
- **Verify:** `cd client && pnpm exec vitest run EvalsTab AgentEditor`
- **Done when:** `?tab=evals` renders the body, deltas appear at ≥2 batches and are absent at 1, every case row shows its expectation and its expected/actual counts or `never run`, the empty state offers to create a case, and the run control enters a running state while a batch is in flight
- **Notes:**
  - **`TABS` is the only edit an added tab needs** — `TAB_KEYS` is derived from it, so the `?tab=` whitelist follows automatically (`constants.ts:26-31`). The label `editor.tabs.evals` already exists in `agents.json`.
  - **`AgentEditor.test.tsx` needs a test that MOUNTS the new tab.** SPEC-01's sibling trap: the existing test passes because it renders `tab="config"`, so a new tab's queries never run (`client/insights.md` 2026-08-27). Add the mounting test, and update that file's `fetch` stub for the new queries — a stub returning a truthy **non-array** satisfies `?.` and then throws on `.map`, unmounting the tree and failing every assertion in the file with an error that points nowhere near the cause. Guard list shape with `Array.isArray(v) ? v : []`, never `??`.
  - **AC-66 + NFR-10:** the running state is driven by `EvalBatchRecord.status === 'running'` from the polled hook (D-1), and the batch's start and completion are announced through a live region (WCAG 2.2 SC 4.1.3).
  - **Polling tests:** put `vi.useFakeTimers()` in `beforeEach`/`afterEach` inside their **own `describe`**, never in a `try/finally` — a timed-out test never reaches `finally`, leaving fake timers installed process-wide and reddening four unrelated tests. Use `fireEvent`, not `userEvent`, inside a fake-timer block. Mutation-check the polling assertion in **both** directions (`client/insights.md` 2026-08-29).
  - **AC-67 / UX-2:** render the expectation as a chip on each row. A `must_not_flag` case carrying a forbidden `CRITICAL · security` finding is otherwise indistinguishable from a `must_find` case, and "expected 1, got 1" then reads as a pass for the opposite assertion.
  - **AC-112:** render `input_diff` and `expected_output` as **text content**. No `dangerouslySetInnerHTML` on this path.
  - **NFR-11:** query controls by role with the expected accessible name. **Do not add `aria-expanded` to a repeated row** — it silently widens every `getByRole("button", {expanded})` query in the suite (`client/insights.md` 2026-08-29).
  - `frontend-ui-architecture` applies to **folder structure and decomposition only** — ignore its RSC-boundary, Server-Actions and Data-Access-Layer sections. This studio is a client-rendered SPA on an App Router shell, deliberately; `client/AGENTS.md` wins.

### Step 27 — `/eval`, the workspace dashboard · package: client

- **Files:** create `client/src/app/eval/page.tsx` and `client/src/app/eval/_components/EvalDashboardView/**` (view, rows, styles, constants, test)
- **Satisfies:** AC-69, AC-70, AC-71, AC-72, AC-108 (render); NFR-8, NFR-9, NFR-11
- **Skills:** `next-best-practices`, `react-best-practices`, `react-testing-library`, `frontend-ui-architecture`
- **Depends on:** Step 22, Step 23, Step 24
- **Verify:** `cd client && pnpm exec vitest run EvalDashboardView && pnpm typecheck`
- **Done when:** one row per agent with its four latest values (or a case count and no metrics when it has never run), the batch table renders newest-first from an out-of-order fixture, the empty state points at the agent editor, and "Run all agents" shows an estimate and requires a confirmation before any request is issued
- **Notes:**
  - `page.tsx` stays a **thin entry** that renders one client view, following `skills/page.tsx`. Everything else colocates under `_components/`.
  - Every screen needs a real **loading** state and a real **`ApiError`** state — first paint is a skeleton by design.
  - **AC-72:** read `GET /eval/estimate` and render `est_cost_usd` through `client/src/lib/format-cost.ts`, passing the placeholder the call site means — `null` here means "no priced batch to extrapolate from", not `$0.00`. **Assert that no request is issued before the confirmation is accepted**; that is the criterion, not the dialog's presence.
  - **AC-70's empty state** covers both "no agents at all" and "agents but no case".
  - **D-5 in the spec:** an agent with cases and no batch renders its case count and **no** metrics — the row-level equivalent of `never run`.

### Step 28 — `/eval/agents/[agentId]` · package: client

- **Files:** create `client/src/app/eval/agents/[agentId]/page.tsx` and `_components/EvalAgentView/**`
- **Satisfies:** AC-73, AC-74, AC-75; NFR-8, NFR-9
- **Skills:** `next-best-practices`, `react-best-practices`, `react-testing-library`, `dataviz`
- **Depends on:** Step 25, Step 27
- **Verify:** `cd client && pnpm exec vitest run EvalAgentView`
- **Done when:** tiles, the `MetricTrend` and the recent-batches table all render for one agent, and the regression banner renders from `alert_metric` + `alert_delta`
- **Notes:**
  - **D-14:** the banner sentence is composed **in the studio** from the structured fields and `eval.json`, never taken from the server's `alert` string. It states the metric, the delta and the version and **claims no cause** — "a new false positive slipped in" is an inference code cannot make (D-31, UX-3).
  - **UX-4 and UX-5 are `proposed` and were not promoted** — do not build the changed-config-field list or the direction-coloured cost delta. **UX-6 was not promoted either**: the header keeps the breadcrumb and the back link as drawn; dropping the agent dropdown is not in scope.
  - Breadcrumbs use the already-shipped `page.crumbSkillsLab` / `page.crumbEvalDashboard` keys.

### Step 29 — The routed case editor · package: client

- **Files:** create `client/src/app/eval/agents/[agentId]/cases/new/page.tsx`, `.../cases/[caseId]/page.tsx`, and `_components/EvalCaseEditor/**`
- **Satisfies:** AC-76, AC-77, AC-78, AC-79, AC-112
- **Skills:** `react-best-practices`, `next-best-practices`, `react-testing-library`, `frontend-ui-architecture`
- **Depends on:** Step 22, Step 23
- **Verify:** `cd client && pnpm exec vitest run EvalCaseEditor`
- **Done when:** the `new` route renders an empty editor, the two-option expectation control is queryable by role with both options, malformed text shows the `invalidJson` badge, and a 422 renders the Zod path from `error.details`
- **Notes:**
  - **A routed page, not a modal** (D-36 in the spec): the shipped catalogue already carries `page.crumbNewCase` and `page.crumbEvalCase`, which only a routed page needs.
  - **D-19 — the expectation control's options are a local literal array** annotated with the contract type (`const EXPECTATION_OPTIONS: EvalExpectation[] = ["must_find","must_not_flag"]`), **never** an imported Zod schema: a runtime import from `@devdigest/shared` breaks the browser build while typecheck and vitest both stay green. `SkillsListView/constants.ts#TYPE_OPTIONS` is the pattern.
  - **Two distinct validity states (D-10 in the spec):** `invalidJson` is syntax (AC-78, client-side); a schema-invalid expectation is caught at save and surfaced from `error.details` (AC-79, server-side). Do not collapse them.
  - Tabs are `diff` and `prMeta` only — **the Files tab is a Non-goal** and `eval.json`'s `caseEditor.tabs` deliberately carries no key for it.
  - **OQ-2:** "Run on save" is client-side state, persisted nowhere.
  - **AC-112:** the diff pane renders as text content; assert `textContent` equals the raw diff and that no HTML sink exists on the path.
  - For a **new route**, a green typecheck and a green suite do not mean it loads. Fetch it once against the dev server and grep the body for `Can't resolve` (`client/insights.md` 2026-08-11).

### Step 30 — "Turn into eval case" on the finding card · package: client

- **Files:** modify `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.tsx` and its test; the owning view for the mutation callback
- **Satisfies:** AC-5, AC-6; NFR-11
- **Skills:** `react-best-practices`, `react-testing-library`
- **Depends on:** Step 22, Step 23
- **Verify:** `cd client && pnpm exec vitest run FindingCard`
- **Done when:** the action is **absent** for `secret_leak`, `phantom`, `hook` and `lethal_trifecta`; **present but disabled** with the hint "Accept or dismiss this finding first" when neither timestamp is set; and enabled otherwise
- **Notes:**
  - **D-20: the action row renders only inside `{expanded && …}`** (`FindingCard.tsx:105-140`). Expand the card in the test first, or every "the action is absent" assertion passes for the wrong reason in every code state.
  - **Omission and disablement are different states and both are criteria.** AC-5 omits by `kind`; AC-6 disables with a hint. Do not collapse them into one.
  - **Assert through the accessibility tree**, never through `title` — `aria-label` beats `title` in the accessible-name computation, so a test asserting `toHaveAttribute("title", …)` cannot fail on a broken accessible name (`client/insights.md` 2026-08-28). Use `toHaveAccessibleName`.
  - The card ships **three** actions after this. `learn` and `replyToAuthor` stay unbuilt (OQ-4) and the card diverges from `img.png` by two buttons, deliberately.

### CUT 3 — the studio (phase 2)

### Step 31 `[P2]` — Compare two batches, the prompt diff, and restore · package: client

- **Files:** create `.../EvalAgentView/_components/CompareBatches/**`; modify `EvalAgentView`
- **Satisfies:** AC-93, AC-94, AC-95, AC-96, AC-97, AC-98, AC-99, AC-100, AC-101, AC-102
- **Skills:** `react-best-practices`, `react-testing-library`
- **Depends on:** Step 28, Step 19
- **Verify:** `cd client && pnpm exec vitest run CompareBatches`
- **Done when:** Compare is enabled at exactly two selections and disabled at one and at three; each metric shows before, after and delta; a two-version pair renders a line diff marked added/removed/unchanged; a same-version pair renders an empty diff; a missing snapshot renders the notice; and the restore control names the **older** version and requires a confirmation before issuing the request
- **Notes:**
  - **AC-101 / D-20 in the spec:** the button reads **Restore** and names the **older** version. "Promote v7" when v7 is already current is a no-op under rollback semantics.
  - **AC-99:** `snapshotVersion` is `onConflictDoNothing`, so a version may legitimately have no `agent_versions` row. Metrics still render; only the diff is replaced by the notice.
  - **AC-98:** truncate each side at 8 000 characters with a notice. A 40 000-character prompt must not be rendered whole.
  - **AC-97:** added / removed / unchanged must each be distinguishable **in the accessibility tree**, not by colour alone.
  - **AC-102:** assert that **no request is issued** before the confirmation is accepted.
  - Two authors restoring concurrently is out of scope — single-user studio; the second restore wins and is recorded by AC-104.

### CUT 4 — e2e and docs

### Step 32 — The browser flow · package: e2e

- **Files:** create `e2e/specs/12-eval.flow.json`
- **Satisfies:** the smoke path behind AC-59, AC-68, AC-69 (it covers no criterion on its own)
- **Skills:** —
- **Depends on:** Step 31
- **Verify:** `./scripts/e2e.sh`
- **Done when:** the flow drives sidebar → `/eval` → an agent → the Evals tab and survives a reload, on seeded data, with no model call
- **Notes:**
  - **`12-`, not `11-`** (D-18) — `11-project-context.flow.json` holds that slot.
  - Deterministic and read-only: it opens and clicks; it triggers no batch and spends no provider money. Follow `11-project-context.flow.json`'s structure, including the `description` field that records any fallback taken and why.
  - The hermetic runner builds and serves its own copy on 3100/3101/5433, so it is safe alongside a dev stack. **Never run `cd client && pnpm build` against a live `pnpm dev`** — it overwrites `.next/` and bricks the dev server until `rm -rf .next` (`client/insights.md` 2026-08-03).

### Step 33 — Docs

- **Files:** modify `client/README.md` (UI route map), `server/README.md` (API map), `specs/plans/README.md` (index row)
- **Satisfies:** —
- **Skills:** `mermaid-diagram` (only if a diagram is touched)
- **Depends on:** Step 32
- **Verify:** every relative link passes `test -e`; every `path:line` opens to what it claims
- **Notes:** count lines with `grep -c ''`, not `wc -l` — `wc -l` counts newlines, so a file without a trailing newline reports one fewer than it has and a citation to its last line fails a bounds check (root `insights.md` 2026-08-17). Whether SPEC-04 moves to `implemented` is the **author's** call, not this step's.

### Step 34 — Final gate

- **Files:** none
- **Satisfies:** the whole *Verification* section
- **Depends on:** Step 33
- **Verify:** every command in *Verification* below
- **Done when:** all are green and the report states, explicitly, what was **not** run and why

---

## Verification

In order, with what each proves:

```sh
cd server && pnpm typecheck            # the registry entry, the DTO mappers, every contract extension
cd server && pnpm lint:arch            # the Onion rule: adapters, module boundaries, the container seam
cd server && pnpm test                 # scorer, case builder, runner, service, routes + both integration suites
cd client && pnpm typecheck            # the mirror, the four Agent fixtures, every hook and view
cd client && pnpm test                 # every client criterion (AC-5, AC-6, AC-59-AC-79, AC-93-AC-102, NFR-8-NFR-11)
./scripts/check-contracts.sh           # the two vendor/shared trees agree (exit 0 — NFR-15's second half)
./scripts/e2e.sh                       # the browser smoke path (step 32)
```

Narrower runs during the build:

```sh
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'    # unit only, no Docker
cd server && pnpm exec vitest run .it.test                       # integration only — NEEDS DOCKER
cd client && pnpm exec vitest run EvalsTab EvalDashboardView EvalAgentView EvalCaseEditor MetricTrend FindingCard CompareBatches
```

**Environment-dependent, not optional.** `*.it.test.ts` needs a reachable Docker socket, and this machine has two runtimes installed whose entries in `server/insights.md` (2026-08-27, 2026-08-29) disagree about which one works. Try Colima's socket first, fall back to Rancher's, and **record which worked** rather than editing either entry:

```sh
DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" \
TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
  pnpm exec vitest run .it.test --reporter=dot
```

**Deliberately NOT run, and why:**

- **NFR-14** — requirement 7's live sensitivity experiment. It needs a real provider and a real model; no hermetic harness can demonstrate model sensitivity, and no recorded-response fixture exists in this repository. It is `manual, once` by the spec's own *Verification* table. **Report it as not run, never as passed.**
- **`api-breaking-changes`, `api-response-changes`, `response-schema`, `security`, `pr-self-review`** — these are the review agents' and the pre-PR gate's, not `implementer`'s. See *Out of scope*.
- **A fifteen-minute batch.** AC-110 is proven against a lowered `EVAL_BATCH_MAX_MS` (D-11), not against the production default.

---

## Constraints & invariants

The rules a reviewer should check this build against:

- **Five standalone packages, not a workspace.** Cross-package code is shared as TypeScript source through tsconfig aliases. No `pnpm add` of one local package into another; no build or publish step for shared code. `server`/`client` use pnpm; `e2e` uses npm.
- **`@devdigest/shared` is canonical at `server/src/vendor/shared/`**; the client copy is hand-synced. Any contract change is **two** files, synced with `./scripts/check-contracts.sh --fix` and typechecked in **both** packages.
- **Migrations are generated, never hand-edited**, and do not run on boot. Schema change = `db:generate` then `db:migrate`, two separate steps.
- **Every domain table carries `workspace_id`; all queries scope by it.** `eval_runs` is the deliberate exception, scoping through `case_id → eval_cases.workspace_id` (AC-2), exactly as `pr_intent`/`pr_brief` scope through `pr_id`.
- **The Onion rule is lint-enforced.** `routes.ts → service.ts → repository.ts`, one direction. Drizzle only in the repository; no Fastify below routes; third-party I/O SDKs only in `adapters/`; resolve dependencies from the container, never construct an adapter inline.
- **A module's public surface is `constants.ts` and `types.ts`.** Cross-module work goes through the container or a published job kind. `modules/reviews/**` and `modules/agents/**` internals are off limits; `container.reviewRepo`, `container.agentsRepo` and the new `container.evalTrigger` are the seams.
- **Modules register statically** in `src/modules/index.ts` — one folder, one import, one registry entry, and only `tsc` catches a mistake in it.
- **One Zod schema serves validation and serialization, declared on the route.** A body-less POST declares **no** `body:` schema.
- **Anything slow goes through `JobRunner`** — which is what D-1 settles.
- **Errors are `AppError` subclasses**; the single handler in `app.ts` builds the envelope.
- **The studio is a client-rendered SPA on an App Router shell.** No `'use server'`, no Server Actions, no DAL, no server-side data fetching. Every screen has a real loading and `ApiError` state. `lib/api.ts` is the only place that talks HTTP; cache keys come from `keys.ts`; types come from `@devdigest/shared` as **`import type` only**; user-facing strings go through next-intl; UI primitives come from `src/vendor/ui`.
- **Do-not-touch:** `server/clones/**` (never read — it holds a stale full copy of this repo), `server/src/db/migrations/**` (generated), `client/src/vendor/**` — **with the single sanctioned exception of `nav.ts` in step 24 (D-16)**, locked skills under `.claude/skills/**`, and anything generated.
- **Test-suite membership is by filename.** `*.it.test.ts` is DB-backed and needs Docker; everything else must be hermetic.
- **No new dependency is added by this plan**, so no `allowBuilds:` entry is needed in any `pnpm-workspace.yaml`.

---

## Open questions

- **OQ-1 — a time-range filter on the dashboard.** Deferred by the spec. *Assumption:* the control is omitted in phase 1 and the API answers with the 50 most recent batches (AC-71, AC-108). The ordinal x-axis (D-7) cannot represent a time window anyway.
- **OQ-2 — is "Run on save" persisted?** *Assumption:* client-side state only, remembered nowhere. No column, no contract field.
- **OQ-5 — how long does a frozen diff fragment from a private repository live in `eval_cases`?** *Assumption:* unbounded, as specified, with the boundary drawn at logging (AC-113, NFR-16) and tenancy (AC-1, AC-4) instead. A retention window or a consent step at creation would each be a new feature. **This is the one open question with a compliance edge**, and it is the author's to close.
- **OQ-6 — the dollar ceiling cannot bind on an unpriced model**, because `cost_usd` is then `null` rather than a number. *Assumption:* the ceiling is advisory there and AC-41 never fires; `EVAL_BATCH_MAX_MS` (D-11) is the only limit that still binds.
- **Cost fidelity, tagged for `researcher` if it ever matters:** OpenRouter reports a real number, OpenAI and Anthropic are estimates from the static table, and an unpriced model yields `null`. Nothing in this plan reads a price from a document; prices come from `adapters/llm/pricing.ts` or live from the OpenRouter catalogue.
- **Determinism, stated so nobody reads more into a comparison than it holds:** the scorer is deterministic; the **model is not**. Two batches of one version over the same frozen diffs may differ. Freezing the inputs removes diff drift, which is all goal 3 claims — it does not remove sampling variance, and a single-batch-per-version comparison is therefore noisy. Nothing in this plan asserts run-to-run agreement.
- **What an eval score measures:** an eval prompt is deliberately **not** byte-identical to the prompt the same agent sends on a real pull request — it omits repo-intel context, project-context documents and derived intent (AC-29). It measures the system prompt, the model and the skills, holding the repository's contribution constant at nothing. That is what makes it comparable across versions; it is not a prediction of live review quality.

---

## Out of scope / follow-ups

- **Architecture review** (`architecture-reviewer`) after step 21 and again after step 31 — the module boundary and the `container.evalTrigger` facade are the two things worth an independent read.
- **`plan-verifier`** against this file, handed the path, not a paste. Ask `implementer` for **every deviation from a literal reading of this plan** as a required report section, and read the deviations before any reviewer's findings — a disclosed deviation is a diff-read; finding one is a search (root `insights.md` 2026-08-27).
- **`api-breaking-changes`, `api-response-changes`, `response-schema`** — fourteen new endpoints and five extended contracts are exactly their subject. They belong to the review agents; **`implementer` does not run them**, and nobody should assume they did.
- **`security`** — the untrusted-input surface here is unusually dense: an eval case is purpose-built to hold attacker-shaped content and replay it into a model prompt forever. Worth a dedicated pass on the prompt path and on AC-114's mass-assignment refusals.
- **`pr-self-review`** before `gh pr create`.
- **Whether SPEC-04 moves to `implemented`** — the author's call, and it should follow the spec amendments listed above, not precede them.
- **`/engineering-insights`** afterwards. This build is very likely to produce entries: the D-5 discovery (a barrel export that does not do what a UX proposal claims), the D-2 derived-status pattern, and the `EVAL_BATCH_MAX_MS`-so-the-test-can-run technique are all durable.
- **Not built, by decision:** UX-4, UX-5, UX-6 and UX-7 stay `proposed` — only the author promotes one. UX-1 is `rejected` (D-5). UX-2, UX-3 and UX-8 are folded into steps 26, 28 and 24 respectively.

---

## Amendments

### 2026-09-03 — step 5 *Done when* widened to admit the FK constraint
The generated `server/src/db/migrations/0017_mute_fabian_cortez.sql` contains, besides the `ADD COLUMN` and `CREATE INDEX` statements the step names, one `ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_id_agents_id_fk" … ON DELETE set null`. It is drizzle-kit's emission of step 4's own `.references(() => agents.id, { onDelete: 'set null' })` (`server/src/db/schema/eval.ts`), not a rename or a drop; no `RENAME` appears in the file. The *Done when* now reads "only `ADD COLUMN`, `CREATE INDEX` and the `ADD CONSTRAINT … FOREIGN KEY` that step 4's schema declares". Approved by the author.

### 2026-09-03 — D-2 / step 12: the batch's rows are seeded on the request, not by the runner
D-2 said "the runner inserts one `eval_runs` row per case". The spec's own sequence diagram (SPEC-04 *Sequence — one batch*, hops 11–12a) places the insert before `enqueue`, and the build follows the diagram: `EvalService.acceptAgentBatch` (`server/src/modules/eval/service.ts`) seeds the rows before the job is enqueued, and `runBatch` reads them via `repo.runsForBatch` (`server/src/modules/eval/runner.ts:119-126`). Seeding inside the job made `GET /agents/:id/eval-runs` answer `[]` while the queue was busy, so AC-66's `running` state flickered on late; `eval.it.test.ts`'s AC-40 test failed on that ordering. Step 12's *Done when* ("writes two `eval_runs` rows sharing one `batch_id`") is satisfied by the pair service + runner. Approved by the author.

### 2026-09-03 — step 18 footprint: `container.evalService`, `Container.log`, `JobRunner.timeoutMs`
Step 18 named `container.evalTrigger` as the only new composition-root seam. The build also adds `container.evalService` (`server/src/platform/container.ts`) so the routes plugin and the trigger share one in-memory active-batch registry — two instances would let AC-40 admit a concurrent batch and hide `running` from the poll; `Container.log: Logger`, assigned in `server/src/app.ts`, so AC-113's per-case line goes through Pino from a service resolved off the container; and `JobRunner.timeoutMs` made `public readonly` (`server/src/platform/jobs.ts`) so AC-92's pairing timer arms at the runner's own deadline instead of a duplicated `120_000`. `architecture-reviewer` (round 1) read all three as legitimate, narrowly-scoped additions with no boundary crossing. Approved by the author.

### 2026-09-03 — D-1: `EvalBatchAccepted` gains `agent_id: z.string().nullish()`
`server/src/vendor/shared/contracts/eval-agent.ts:71` adds an optional `agent_id` to the 202 body so a workspace-wide run (AC-42/AC-43, `POST /eval/runs`) can report which agent each accepted-or-degraded entry belongs to. Additive and `.nullish()`, mirrored to the client; not among the implementer's disclosed deviations, surfaced by `plan-verifier` round 1. Approved by the author.
