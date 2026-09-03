# Spec: Agent Evals

Spec ID: SPEC-04
Status: approved
Supersedes: —

Design: six mockups under `specs/assets/SPEC-04/` —
`01-dashboard-all-agents.png` (was `img_1.png`), `02-dashboard-agent.png`
(`img_2.png`), `03-compare-runs.png` (`img_3.png`), `04-editor-evals-tab.png`
(`img_4.png`), `05-case-editor.png` (`img_5.png`), `06-finding-card-actions.png`
(`img.png`). The *Design review* table cites them by both names.

Related: [SPEC-01 · Project Context](SPEC-01-project-context.md) — this spec
deliberately excludes project-context documents from the eval prompt (AC-29).

---

## Problem & user

An agent author opens Security Reviewer, rewrites two lines of its system prompt
to stop it flagging unused imports, saves, and has no way to find out whether the
edit helped. The studio versions the config faithfully — `agent_versions` has
held an immutable snapshot of every change since A2
(`server/src/modules/agents/repository.ts:161-179`) — and then tells the author
nothing about any of those versions. The only feedback available is to open a
pull request, run a review, and read the findings by eye; the only comparison
available is memory. So a prompt edit that quietly halves the number of real
bugs the agent catches ships with exactly the confidence of one that fixes a
typo, and the regression is discovered weeks later, on a PR that mattered.

The evidence needed to answer the question is already being collected and
already being thrown away. Every reviewer who presses Accept or Dismiss on a
finding writes a human judgement into `findings.accepted_at` /
`findings.dismissed_at` (`server/src/db/schema/reviews.ts:53-54`) — *this finding
was real*, *this finding was noise* — attached to a specific file, a specific
line range and a specific diff. Nothing reads those columns back. The result is a
repository that accumulates a ground-truth set of labelled reviewer decisions and
cannot use a single one of them to tell an author whether v7 of their agent is
better than v6.

The cost lands twice: on the author, who edits prompts blind and therefore edits
them rarely, and on every reviewer downstream of a regression nobody measured.

## Goals / Non-goals

**Goals**

1. A reviewer's Accept or Dismiss decision becomes a permanent, replayable test
   case in one click, with the diff fragment frozen so it stays meaningful after
   the branch is deleted. → AC-5 … AC-18
2. An author can run an agent over its whole case set and read three numbers —
   recall, precision, citation accuracy — computed **in code, with no model in
   the scoring loop**, so the same outputs always produce the same score.
   → AC-27 … AC-58
3. An author can see those numbers move between two versions of the agent and
   attribute the movement to the config change that caused it. → AC-93 … AC-105
4. A deliberately worse prompt produces visibly worse numbers, which is what
   makes the harness worth trusting at all. → AC-48, AC-50, NFR-13, NFR-14

**Non-goals**

- **Skill-owned eval cases.** `eval_cases.owner_kind` admits `'skill'`
  (`server/src/db/schema/eval.ts:12`) and nothing in this feature runs a skill's
  cases; accepting a case the system will never execute is worse than refusing it
  (AC-3).
- **The Files input tab** drawn in `img_5`. `input_files` stays unwritten, and
  `eval.json`'s `caseEditor.tabs` catalogue carries only `diff` and `prMeta`
  (`client/messages/en/eval.json:43-46`) — the mockup is ahead of the strings.
- **The Stats and CI editor tabs**, and the sidebar's whole GLOBAL group (Memory,
  Multi-Agent Review, Agent Performance, CI Runs) drawn in every full-screen
  mockup. `client/src/vendor/ui/nav.ts:21-30` withholds a row until its route
  exists, and this spec adds exactly one route.
- **Learn and Reply-to-author on the finding card.** `img.png` draws five
  actions; the card ships two (`FindingCard.tsx:119-140`) and this spec adds the
  third. The `prReview.json` strings for the other two already exist
  (`client/messages/en/prReview.json:8-11`) and stay unused (OQ-4).
- **An MCP tool** fronting any of this — `mcp/` fronts the REST API, and nothing
  here is worth a tool until the routes settle.
- **Backfilling existing findings into cases.** Every case is created by an
  explicit click; a migration that invented cases from history would produce a
  gold set nobody agreed to.
- **A time-range filter on the dashboard.** `img_2` draws a "30 days" control
  with no parameter behind it in any contract; the API answers with the most
  recent batches instead (OQ-1).
- **`reviewer-core` changes.** *Purity check:* the engine is called exactly as
  the PR path calls it (`reviewer-core/src/review/run.ts:144`), and the eval
  module needs I/O — a database, a provider, a job — so none of this belongs in
  that package. `groundCitations` (`reviewer-core/src/grounding.ts:94`) is reused
  as-is, not modified.

## User stories

- As a reviewer dismissing a false positive on a PR, I want to turn it into an
  eval case in one click, so that the next version of the agent is measured
  against the mistake I just corrected.
- As an agent author editing a system prompt, I want to run the agent over its
  frozen case set and see recall, precision and citation accuracy, so that I
  learn whether my edit helped before it reaches a real review.
- As an agent author who has just made things worse, I want to compare v6 with v7
  side by side and see which prompt line changed, so that I can undo the specific
  edit rather than the whole session.
- As an agent author who regressed a metric, I want to restore the older
  version's config in one confirmed action, so that recovery does not mean
  retyping a prompt out of a diff.
- As an author of several agents, I want one page ranking every agent by its
  latest numbers, so that I notice the one that quietly got worse.
- As the person who pays the provider bill, I want a batch to stop at a stated
  dollar ceiling and to be told what a "run all agents" click will cost before I
  make it, so that a regression harness cannot become an unbounded expense.

## Acceptance criteria (EARS)

**Phase 1 is AC-1 … AC-79** and covers homework requirements 1–7. **Phase 2 is
AC-80 … AC-105** (skill-link version bumps, auto-eval, compare, restore).
AC-106 … AC-115 are the ceilings and boundaries both phases share, and **AC-116
is phase 1** (the single-case run, added by plan D-9). The two phases share one
migration and one set of contracts; nothing in phase 1 depends on phase 2.

**AC-86 is deleted** (plan D-13) and its number is spent: the text is retained as
a tombstone so every cross-reference in this file, in the plan and in any review
comment still resolves. Nothing else is renumbered.

### Invariants and tenancy (phase 1)

- **AC-1** — The system shall scope every eval query by `workspace_id`.
- **AC-2** — The API shall resolve an eval run's workspace through
  `case_id → eval_cases.workspace_id`. *(The denormalised `eval_runs.agent_id` is
  therefore not a tenancy path — see* Schema impact*.)*
- **AC-3** — IF a create-case request names `owner_kind` `'skill'`, THEN the API
  shall reject it with `validation_error` (422).
- **AC-4** — IF a request names an eval case or an agent belonging to another
  workspace, THEN the API shall respond `not_found` (404).

### Turn a finding into an eval case (phase 1, requirement 2)

- **AC-5** — WHERE a finding's `kind` is one of `secret_leak`, `phantom`, `hook`
  or `lethal_trifecta`, the studio shall omit the "Turn into eval case" action
  from that finding's action row.
- **AC-6** — IF a finding has neither `accepted_at` nor `dismissed_at`, THEN the
  studio shall render the "Turn into eval case" action disabled with the
  accessible hint "Accept or dismiss this finding first".
- **AC-7** — WHEN the studio requests an eval case for a finding whose
  `accepted_at` is set, the API shall persist the case with `expectation`
  `must_find`.
- **AC-8** — WHEN the studio requests an eval case for a finding whose
  `dismissed_at` is set and whose `accepted_at` is null, the API shall persist the
  case with `expectation` `must_not_flag`.
- **AC-9** — IF a finding carries both `accepted_at` and `dismissed_at`, THEN the
  API shall persist the case with `expectation` `must_find`.
- **AC-10** — WHEN creating a case from a finding, the API shall persist as
  `input_diff` the single-file fragment of that pull request's diff for that
  finding's file.
- **AC-11** — WHEN creating a case from a finding, the API shall persist
  `input_meta.head_sha` from that finding's pull request.
- **AC-12** — WHEN creating a case from a finding, the API shall persist that
  finding's id in `input_meta.source_finding_ids`.
- **AC-13** — WHEN creating a case from a finding, the API shall persist an
  `expected_output` array holding one entry whose `file`, `start_line` and
  `end_line` equal that finding's.
- **AC-14** — WHEN creating a case from a finding, the API shall derive the case
  name from that finding's title.
- **AC-15** — IF the derived name already exists among that agent's cases, THEN
  the API shall append the lowest unused numeric suffix.
- **AC-16** — IF a case already records that finding's id in
  `input_meta.source_finding_ids`, THEN the API shall return the existing case
  with status 200.
- **AC-17** — IF the finding's file is absent from its pull request's diff, THEN
  the API shall reject the request with `validation_error` (422).
- **AC-18** — IF the finding's review carries no `agent_id`, THEN the API shall
  reject the request with `validation_error` (422).

### Eval case authoring (phase 1, requirements 1 and 5)

- **AC-19** — WHEN a case is saved, the API shall parse `expected_output` against
  `EvalExpectedFinding[]`.
- **AC-20** — IF `expected_output` fails that parse, THEN the API shall respond
  `validation_error` (422) carrying the failing Zod path in `error.details`.
- **AC-21** — WHEN a saved expected finding omits `end_line`, the API shall
  persist `end_line` equal to that entry's `start_line`.
- **AC-22** — WHERE `expectation` is `must_not_flag`, the API shall accept an
  empty `expected_output` array.
- **AC-23** — IF `expectation` is `must_find` and `expected_output` is empty,
  THEN the API shall respond `validation_error` (422).
- **AC-24** — IF a case's `input_diff` parses to zero files, THEN the API shall
  respond `validation_error` (422).
- **AC-25** — WHEN a create-case request omits `expectation`, the API shall
  persist `must_find`.
- **AC-26** — WHEN a case is deleted, the API shall delete that case's eval runs.

### Running a batch (phase 1, requirement 3)

*The batch is asynchronous (plan D-1).* `POST /agents/:id/eval-runs` validates
synchronously — the agent resolves (AC-4), it has at least one case (AC-35), it
has no batch already running (AC-40), and its provider key resolves (AC-39) —
and only then enqueues an `eval-batch` job and answers 202. The per-case
`eval_runs` rows land as the batch progresses, and the studio reads progress by
polling `GET /agents/:id/eval-runs`, which serves `EvalBatchRecord[]` with the
derived status of *Schema impact* (AC-66 is the running state that poll drives).
There is no SSE and no open connection (OQ-7). `JobRunner`'s 120 s timeout will
fire on a batch of more than a handful of cases; that is accepted for manual and
auto-eval batches alike — the `jobs` row goes `failed`, the batch runs on and
persists its rows, and AC-92's log line is what reconciles the two (OQ-3,
resolved as option (iii)).

- **AC-27** — WHEN `POST /agents/:id/eval-runs` passes its synchronous
  validation, the API shall respond 202 with `EvalBatchAccepted
  { status: 'accepted', batch_id, cases }`, having enqueued one `eval-batch` job
  that executes every one of that agent's eval cases under that single
  `batch_id`.
- **AC-28** — WHEN executing a case, the API shall assemble the prompt from the
  agent's `system_prompt`, model, strategy, resolved skill blocks, the case's
  frozen `input_diff` and the case's frozen `input_meta.task`.
- **AC-29** — WHEN executing a case, the API shall omit the project-context,
  repo-map, callers, memory and intent prompt sections.
- **AC-30** — WHEN executing a case, the API shall include one skill block for
  each link whose `agent_skills.enabled` and `skills.enabled` are both true, in
  link order.
- **AC-31** — WHEN executing a case, the API shall obtain the reviewed diff by
  parsing that case's persisted `input_diff`.
- **AC-32** — WHEN a batch is executed, the API shall record the agent's current
  `version` on every `eval_runs` row of that batch.
- **AC-33** — WHEN a batch is started by `POST /agents/:id/eval-runs`, the API
  shall record `trigger` `manual` on every `eval_runs` row of that batch.
- **AC-34** — WHEN a batch completes, the API shall write no `agent_runs` row.
- **AC-35** — IF the agent has zero eval cases, THEN the API shall respond
  `validation_error` (422).
- **AC-36** — IF a case's model call fails, THEN the API shall persist that
  case's `eval_runs` row with the provider's message in `error`.
- **AC-37** — IF at least one case failed and at least one succeeded, THEN the
  API shall report that batch's `cases_ran` as the count of cases that produced a
  score.
- **AC-38** — IF every case in a batch failed, THEN the API shall report that
  batch's three metrics as null.
- **AC-39** — IF the agent's provider key is not configured, THEN the API shall
  respond `config_error` (500) before any model call.
- **AC-40** — IF a batch is requested for an agent that already has a running
  batch, THEN the API shall respond `validation_error` (422).
- **AC-41** — IF adding the next case's estimated cost — the running mean of the
  `cost_usd` of that batch's completed, priced cases — would take the batch's
  running total past the configured `EVAL_BATCH_MAX_USD` ceiling, THEN the API
  shall stop that batch before that case, leaving the unreached cases unscored so
  the batch derives as `partial`. *(Plan D-12: the estimate binds only once at
  least one case in the batch has a priced `cost_usd`. If every completed case
  reports null — an unpriced model — the ceiling never binds and AC-110's wall
  clock is the only limit that does, which is OQ-6's assumption unchanged.)*
- **AC-42** — WHERE an agent is disabled, the API shall exclude it from a
  workspace-wide run.
- **AC-43** — WHEN a workspace-wide run is requested, the API shall execute one
  batch per enabled agent that has at least one case.

### Scoring (phase 1, requirement 4)

- **AC-44** — The API shall treat an actual finding as matching an expected
  finding when their `file` values are equal and their `[start_line, end_line]`
  ranges intersect.
- **AC-45** — WHEN scoring a batch, the API shall compute `recall` as the share of
  expected findings across that batch's `must_find` cases that were matched.
- **AC-46** — IF a batch's `must_find` cases hold no expected findings, THEN the
  API shall record that batch's `recall` as null.
- **AC-47** — WHEN scoring a batch, the API shall count as noise every actual
  finding produced on a `must_not_flag` case.
- **AC-48** — WHEN scoring a batch, the API shall count as noise every actual
  finding on a `must_find` case that matches no expected finding of that case.
- **AC-49** — WHEN scoring a batch, the API shall count as noise every actual
  finding produced on a `must_not_flag` case whose `expected_output` is empty.
  *(The special case of AC-47 under plan D-4, kept so the cross-references and
  its* Verification *row stay valid. There is one noise rule for a
  `must_not_flag` case — AC-47 — and this is it read on an empty
  `expected_output`; nothing scores a third way.)*
- **AC-50** — WHEN scoring a batch, the API shall compute `precision` as one minus
  the share of noise among all actual findings that batch produced.
- **AC-51** — IF a batch produced no actual finding, THEN the API shall record
  that batch's `precision` as 1, unless AC-38 applies. *(Precedence, plan D-15:
  an all-failed batch produced no finding because nothing ran, so AC-38 wins and
  all three metrics are null rather than `precision = 1`.)*
- **AC-52** — WHEN scoring a case, the API shall compute `citation_accuracy` as
  the share of the engine's candidate findings for that case that survived the
  grounding gate. WHEN scoring a batch, the API shall compute the batch's
  `citation_accuracy` as the micro-average Σ kept ÷ Σ (kept + dropped) over the
  cases that produced a candidate, and as null when no case produced one.
- **AC-53** — IF the engine produced no candidate finding for a case, THEN the API
  shall record that case's `citation_accuracy` as null.
- **AC-54** — WHERE a case's `expectation` is `must_find`, the API shall record
  that case's run as passed when every expected finding of that case was matched
  and the case produced no unmatched extra finding. WHERE a case's `expectation`
  is `must_not_flag`, the API shall record that case's run as passed when the
  case produced no actual finding at all.
- **AC-55** — WHEN reporting a batch, the API shall report `traces_total` as the
  number of cases executed and `traces_passed` as the number that passed.
- **AC-56** — The API shall compute every eval metric without a model call.
- **AC-57** — WHEN scoring, the API shall apply the range-intersection test of
  AC-44 to every actual finding regardless of the `kind` that finding carries.
- **AC-58** — WHEN a case run completes, the API shall persist its `cost_usd` as
  the value the provider reported or estimated, and as null when neither was
  available.

### Evals tab (phase 1, requirement 5)

- **AC-59** — The studio shall render an `Evals` tab in the agent editor's tab
  list.
- **AC-60** — WHEN the agent editor is opened with `?tab=evals`, the studio shall
  render the Evals tab body.
- **AC-61** — WHILE an agent has at least two batches, the studio shall render
  each metric tile's delta against the previous batch.
- **AC-62** — IF an agent has fewer than two batches, THEN the studio shall omit
  the metric deltas.
- **AC-63** — WHEN a case has at least one run, the studio shall render that
  case's expected and actual finding counts.
- **AC-64** — WHERE a case has no run, the studio shall render the label
  `never run` on that case's row.
- **AC-65** — IF an agent has zero eval cases, THEN the studio shall render an
  empty state offering to create one.
- **AC-66** — WHILE a batch is running for the open agent, the studio shall render
  the run control in its running state.
- **AC-67** — The studio shall render each case row's `expectation`.

### Eval Dashboard and the case editor (phase 1, requirement 6)

- **AC-68** — The studio shall render one sidebar row under `SKILLS LAB` whose
  label is byte-identical to the `shell.nav.eval` message.
- **AC-69** — WHEN `/eval` is opened, the studio shall render one row per agent
  carrying that agent's latest recall, precision, citation accuracy and pass
  count.
- **AC-70** — IF the workspace holds no eval case at all, THEN the studio shall
  render an empty state on `/eval` pointing at the agent editor.
- **AC-71** — WHEN `/eval` is opened, the studio shall render the workspace's most
  recent batches newest first.
- **AC-72** — WHEN the author activates "Run all agents", the studio shall render
  an estimated total cost and require a confirmation before issuing the request.
- **AC-73** — WHEN `/eval/agents/:agentId` is opened, the studio shall render that
  agent's metric tiles, metric trend and recent batches.
- **AC-74** — WHEN a batch's precision is at least 0.02 below the previous
  batch's, the API shall return `alert_metric` naming the metric and
  `alert_delta` carrying the drop. *(Plan D-14: the studio composes the banner
  sentence from those two fields through next-intl (`eval.json`), so the English
  lives in the catalogue and not in the server. The server's convenience `alert`
  string stays on the shape, is asserted in `server-unit`, and is read by
  nothing. This is also what delivers UX-3: with only a metric and a number
  crossing the wire, the banner has nowhere to put a causal clause the code
  cannot justify.)*
- **AC-75** — WHEN rendering the metric trend, the studio shall place batches on
  the x-axis by ordinal position, exposed as text in the accessibility tree.
- **AC-76** — WHEN `/eval/agents/:agentId/cases/new` is opened, the studio shall
  render an empty case editor.
- **AC-77** — The studio shall render a two-option control for `expectation` above
  the expected-output editor.
- **AC-78** — WHILE the expected-output editor holds text that is not valid JSON,
  the studio shall render the `invalidJson` badge.
- **AC-79** — IF a save is rejected for a schema-invalid expected output, THEN the
  studio shall render the Zod path returned in `error.details`.

### Phase 2 — version bumps and auto-eval

- **AC-80** — WHEN a skill is linked to an agent, the API shall bump that agent's
  `version`.
- **AC-81** — WHEN a skill is unlinked from an agent, the API shall bump that
  agent's `version`.
- **AC-82** — WHEN an agent's skill link is enabled or disabled, the API shall
  bump that agent's `version`.
- **AC-83** — WHEN an agent's whole skill link set is replaced, the API shall bump
  that agent's `version`.
- **AC-84** — WHEN an agent's `version` is bumped, the API shall snapshot the
  resulting config into `agent_versions`.
- **AC-85** — WHERE an agent's `auto_eval` is true, WHEN a version bump changed
  any member of the allow-list — `system_prompt`, `model`, `provider`,
  `strategy`, `output_schema`, the skill set — the API shall enqueue an
  `agent-version-eval` job for that agent. *(Plan D-13: the list is exhaustive
  and is the whole rule. A bump that touched only `ci_fail_on`, `repo_intel`,
  `name` or `description` is outside it — the version still bumps and is still
  snapshotted (AC-84), and nothing is enqueued.)*
- **AC-86** — Deleted — superseded by D-13 in the plan.
- **AC-87** — IF an `agent-version-eval` job for the same agent is already
  pending, THEN the API shall enqueue no further job for that agent.
- **AC-88** — IF an `agent-version-eval` handler starts and the agent's current
  `version` is greater than the version in its payload, THEN the API shall skip
  the batch.
- **AC-89** — IF an `agent-version-eval` handler starts and a batch already exists
  for that agent id and agent version with `trigger` `version-change`, THEN the
  API shall skip the batch.
- **AC-90** — WHEN a batch is started by an `agent-version-eval` job, the API
  shall record `trigger` `version-change` on every `eval_runs` row of that batch.
- **AC-91** — IF no handler is registered for `agent-version-eval`, THEN the API
  shall complete the version bump and return the updated agent.
- **AC-92** — IF an `agent-version-eval` job exceeds the job runner's timeout,
  THEN the API shall log that batch's id alongside the failed job id.

### Phase 2 — compare and restore

- **AC-93** — WHILE exactly two batches are selected on `/eval/agents/:agentId`,
  the studio shall enable the Compare control.
- **AC-94** — IF fewer or more than two batches are selected, THEN the studio
  shall render the Compare control disabled.
- **AC-95** — WHEN two batches are compared, the studio shall render each metric's
  before value, after value and delta.
- **AC-96** — WHEN two batches of different agent versions are compared, the
  studio shall render a line diff of those two versions' `system_prompt`.
- **AC-97** — WHEN rendering that diff, the studio shall mark each line as added,
  removed or unchanged.
- **AC-98** — IF either compared version's system prompt exceeds 8 000 characters,
  THEN the studio shall render the first 8 000 characters of each side and a
  truncation notice.
- **AC-99** — IF either compared version has no `agent_versions` snapshot, THEN
  the studio shall render a "snapshot unavailable" notice in place of the diff.
- **AC-100** — WHEN two batches of the same agent version are compared, the studio
  shall render an empty prompt diff.
- **AC-101** — The studio shall label the restore control with the older of the two
  compared versions.
- **AC-102** — WHEN the author activates the restore control, the studio shall
  require a confirmation before issuing the request.
- **AC-103** — WHEN a restore is confirmed, the API shall write a new agent version
  whose config equals the restored version's config.
- **AC-104** — WHEN a restore is confirmed, the API shall record the restored
  version number in the new version's `config_json.restored_from`.
- **AC-105** — WHEN a restore is confirmed, the API shall enqueue no
  `agent-version-eval` job for that bump.

### Ceilings — behaviour past the numbers in *Non-functional requirements*

- **AC-106** — IF a case's `input_diff` exceeds 256 KB, THEN the API shall respond
  `validation_error` (422).
- **AC-107** — IF an agent already has 50 eval cases, THEN the API shall reject a
  further create with `validation_error` (422).
- **AC-108** — IF a workspace holds more than 50 batches, THEN the API shall return
  the 50 most recent on `/eval`.
- **AC-109** — IF an expected-output array holds more than 20 entries, THEN the API
  shall respond `validation_error` (422).
- **AC-110** — IF a batch's wall clock exceeds the configured `EVAL_BATCH_MAX_MS`
  (15 minutes by default), THEN the API shall stop that batch, leaving the
  unreached cases unscored so the batch derives as `partial`.

### Untrusted inputs

- **AC-111** — IF a case's model output fails `Review` schema validation after the
  configured retries, THEN the API shall record that case run as failed with the
  parse error in `error`.
- **AC-112** — WHEN rendering a case's `input_diff` or `expected_output`, the
  studio shall render it as text content.
- **AC-113** — WHEN logging an eval run, the API shall log the case id, the batch
  id and the metric values only.
- **AC-114** — WHEN persisting a case, the API shall take each column from a named
  field of the parsed request body.
- **AC-115** — WHEN assembling an eval prompt, the reviewer engine shall wrap the
  case's `input_diff` in `<untrusted>` fences.

### Running one case (phase 1)

- **AC-116** — WHEN `POST /eval-cases/:id/runs` passes its synchronous
  validation, the API shall respond 202 with `EvalBatchAccepted
  { status: 'accepted', batch_id, cases: 1 }`, having enqueued one `eval-batch`
  job that executes only that case under that `batch_id`. *(A one-case batch over
  the same runner, on the same validation and the same scoring — it is AC-27 with
  a case set of one, not a second execution path. It exists because the shipped
  string catalogue already draws the control: `caseEditor.runCase`
  (`client/messages/en/eval.json:36`) and `evalsTab.run` (`:71`) have had nothing
  behind them, and plan D-9 builds it.)*

## Edge cases

Every line resolves into an AC or an explicit out-of-scope reason.

**Zero / one / many**

- Workspace has no agents at all → **AC-70**
- Workspace has agents but no eval case → **AC-70**
- Agent has cases but no batch yet → **AC-64**, **AC-62**
- Agent has exactly one batch, so no delta and a one-point trend → **AC-62**
- Agent has 50 cases and the author adds a 51st → **AC-107**
- Workspace holds 200 batches → **AC-108**
- Expected output holds 40 entries → **AC-109**
- Batch of only `must_not_flag` cases, so recall has no denominator → **AC-46**
- Batch that produced no finding at all, so precision has no denominator → **AC-51**
- Case for which the engine produced no candidate finding → **AC-53**

**Empty, whitespace-only and malformed input**

- `expected_output` is `[]` on a `must_not_flag` case → **AC-22**
- `expected_output` is `[]` on a `must_find` case → **AC-23**
- `expected_output` is valid JSON of the wrong shape → **AC-20**
- An expected entry omits `end_line` → **AC-21**
- `input_diff` is whitespace only, or prose that parses to zero files → **AC-24**
- `input_diff` is a 4 MB pasted diff → **AC-106**
- `expectation` omitted on create → **AC-25**
- `owner_kind` is `'skill'` → **AC-3**

**Duplicate submission and concurrent actors**

- Same finding turned into a case twice → **AC-16**
- Two findings on one file produce the same derived name → **AC-15**
- Two batches requested for one agent at once → **AC-40**
- A version bump lands while a batch for the previous version is running → **AC-88**
- A timed-out auto-eval job runs on to completion in the background → **AC-92**
- The same auto-eval payload is delivered twice → **AC-89**
- Two authors restore two different versions concurrently → out of scope
  (single-user studio; the second restore wins and is recorded by **AC-104**)

**Partial failure of a dependency, and timeouts**

- One case's provider call 502s mid-batch → **AC-36**, **AC-37**
- Every case's provider call fails → **AC-38**
- The agent's provider key was removed since the last batch → **AC-39**
- Model output fails schema validation after retries → **AC-111**
- The per-batch cost ceiling is reached at case 12 of 20 → **AC-41**
- A batch is still running after 15 minutes → **AC-110**
- The `agent-version-eval` kind has no registered handler → **AC-91**
- The API restarts with an `agent-version-eval` or `eval-batch` job still queued →
  out of scope (nothing re-drives a `jobs` row after a restart,
  `platform/jobs.ts:49-101`; the next version bump or the next Run enqueues
  afresh. OQ-3 asked whether that is enough and is resolved: it is. An
  interrupted batch leaves its pre-inserted rows unscored and therefore reads
  `partial`, which is true — see *Schema impact*)

**Stale and missing data**

- A case's source pull request was deleted → out of scope (the case is frozen by
  **AC-10** and **AC-11** and carries no foreign key to `pull_requests`; the
  provenance in `input_meta` becomes a dangling reference by design)
- The compared version has no `agent_versions` snapshot → **AC-99**
- The two compared batches share a version → **AC-100**
- A finding's review predates agent attribution and carries no `agent_id` → **AC-18**
- A finding points at a file absent from its own PR's diff → **AC-17**

**Permission denied and tenancy**

- A case id or agent id from another workspace → **AC-4**
- An `eval_runs` row whose `agent_id` names a foreign agent → **AC-2**

**A field the model returns that no longer fits the schema**

- The model returns a finding whose `kind` is `secret_leak`, which exempts it from
  line anchoring inside the engine → **AC-57**
- The model returns duplicate finding ids across map-reduce chunks → out of scope
  (`reviewer-core/src/review/reduce.ts:43-55` assigns no ids of its own; matching
  is by file and range per **AC-44**, never by id)

**Unicode, RTL and overflow**

- A case name or finding title containing RTL text, emoji, or a literal
  `</untrusted>` → **AC-115** on the prompt path (`wrapUntrusted` escapes the
  closing delimiter, `reviewer-core/src/prompt.ts:43`) and **AC-112** on the
  studio path
- A 40 000-character system prompt in the compare diff → **AC-98**
- An eval case whose frozen diff contains a live-looking secret literal (the
  `stripe-key-leak` case in `img_5`) → **AC-113**; retention is OQ-5

## Design review

All six images are **in place at `specs/assets/SPEC-04/`** — the move is done
(plan D-18), and the *Destination* column now records where each one landed
rather than asking for anything. The `img_N` names the rows below still use are
the originals, kept so the citations in this table stay readable against the
mockups as drawn. *(They are on disk and not yet `git add`ed; committing the
folder is the one step left, and it is the author's, not this spec's.)*

| # | Screen / image | Destination | Gap | Proposed resolution | Becomes |
|---|---|---|---|---|---|
| D-1 | `img_1.png` Eval Dashboard | `assets/SPEC-04/01-dashboard-all-agents.png` | No empty state for a workspace with no agents, or agents with no cases | One empty state pointing at the agent editor's Evals tab | AC-70 |
| D-2 | `img_1.png`, `img_2.png` | 01 / `02-dashboard-agent.png` | No in-flight state; a 20-case batch takes tens of seconds | Run control enters a running state; the page polls | AC-66, NFR-10 |
| D-3 | `img_1.png`, `img_2.png`, `img_4.png` | 01 / 02 / 04 | No partial-batch state; every metric on every screen assumes a complete batch | Metrics over the cases that ran, with `cases_ran`/`cases_total` reported | AC-37, AC-38 |
| D-4 | `img_2.png` tiles, `img_4.png` tiles | 02 / `04-editor-evals-tab.png` | A delta and a sparkline are drawn for what may be a single batch | Deltas omitted below two batches | AC-62 |
| D-5 | `img_1.png` agent rows | 01 | No equivalent of `img_4`'s `never run` for an agent with cases and no batch | Row renders the case count and no metrics | AC-69, AC-64 |
| D-6 | `img_4.png` agent list | 04 | "Custom Mentor" is toggled off yet carries metrics; unclear whether "Run all agents" includes it | Disabled agents excluded from a workspace-wide run | AC-42 |
| D-7 | `img_5.png` diff pane | `05-case-editor.png` | A hand-edited diff parsing to zero files would silently score citation accuracy 0 forever | Reject at save | AC-24 |
| D-8 | `img_3.png` prompt diff | `03-compare-runs.png` | Only an *added* line is drawn; removals and long prompts have no rendering | Unified add/remove/context with a truncation ceiling | AC-97, AC-98 |
| D-9 | `img_3.png` | 03 | Assumes both versions have an `agent_versions` row; `snapshotVersion` is `onConflictDoNothing` (`modules/agents/repository.ts:179`) | Metrics render; the diff is replaced by a notice | AC-99 |
| D-10 | `img_5.png` badge | 05 | "valid JSON" covers syntax only; a schema-invalid expectation goes undetected | Parse against `EvalExpectedFinding[]` at save; surface the Zod path | AC-19, AC-20, AC-79 |
| D-11 | `img_1.png`, `img_2.png` tables | 01 / 02 | No overflow behaviour for many batches or many cases | Batches capped at the 50 newest; case creation capped | AC-108, AC-107 |
| D-12 | `img.png` action row | `06-finding-card-actions.png` | **The button is drawn enabled on a finding with neither Accept nor Dismiss active** — the state the author's own rule says must be disabled | The rule wins; the action renders disabled with a hint | AC-6 |
| D-13 | `img.png` findings | 06 | **The highlighted example is a hardcoded-Stripe-key finding and the one below it is a lethal trifecta — both excluded by the `kind` rule**, so two of the three findings drawn would show no action. Mitigating: no hooks module exists (`HookKind` is a contract with no producer), so `findings.kind` is `'finding'` in practice unless the model authored the string | Exclusion by `kind`; the action is omitted, not disabled | AC-5 |
| D-14 | `img.png` → `img_4.png` | 06 | Two findings from one file produce two cases with the same derived name | Numeric suffix | AC-15 |
| D-15 | `img.png` | 06 | Turning the same finding into a case twice | Idempotent by source finding id | AC-16 |
| D-16 | `img.png` | 06 | A finding carrying both timestamps | `accepted_at` wins | AC-9 |
| D-17 | `img_4.png` case rows | 04 | A `must_not_flag` case carrying a forbidden `CRITICAL · security` finding is indistinguishable from a `must_find` case, and "expected 1 finding, got 1" reads as a pass for the opposite assertion | Render the expectation on the row | AC-67, UX-2 |
| D-18 | `img_5.png` expected output | 05 | `start_line: 12` with no `end_line`, against a range-intersection rule | `end_line` defaults to `start_line` | AC-21 |
| D-19 | `img_4.png` | 04 | **`3 / 5 passing` and `TRACES PASSED 17/20` on one screen**, and `img_2`'s "20-trace gold set" for the same agent `img_4` shows five cases for. Mock data | One trace = one case run | AC-55 |
| D-20 | `img_3.png` primary button | 03 | **"Promote v7" when v7 is already current** — a no-op under rollback semantics | The button names the older version and reads Restore | AC-101 |
| D-21 | `img_3.png` | 03 | A restore bumps the version, which would enqueue an auto-eval and bill a batch | Auto-eval suppressed for a restore | AC-105 |
| D-22 | `img_3.png` cost tile | 03 | `▲ 0.02` is drawn green for a cost *increase* | Colour by direction, not by sign | UX-5 `proposed` |
| D-23 | `img_3.png` | 03 | Only `system_prompt` is diffed; a model swap is the most metric-moving change an author can make and renders as an empty diff | List the changed config fields above the diff | UX-4 `proposed` |
| D-24 | `img_2.png` control | 02 | "30 days" has no parameter in any contract | Control omitted in phase 1 | OQ-1 |
| D-25 | `img_5.png` toggle | 05 | "Run on save" has no column and no contract field | Client-side state only | OQ-2 |
| D-26 | `img_5.png` input tabs | 05 | A **Files** tab with no i18n key (`eval.json:43-46` carries `diff` and `prMeta` only) | Non-goal | Non-goal |
| D-27 | `img_5.png` diff pane | 05 | A permanently stored `sk_live_…` literal, and a real customer diff fragment copied into a permanent row that is re-sent to a provider on every batch | Fenced in the prompt; never logged | AC-115, AC-113, OQ-5 |
| D-28 | `img_2.png` trend | 02 | `LineChart` aligns series **by array index** (`client/src/vendor/ui/charts/LineChart.tsx:31`), so a time axis and a 30-day window are not representable | X-axis is batch ordinal, drawn by a **NEW** inline-SVG `_components/MetricTrend/` modelled on `Sparkline` (`client/src/vendor/ui/charts/Sparkline.tsx`), with the ordinals in the accessibility tree. The vendor `LineChart` is neither used nor edited — `client/src/vendor/**` is do-not-touch (plan D-7) | AC-75 |
| D-29 | `img_1.png`, `img_2.png` tables | 01 / 02 | **`EvalRunRecord` is the wrong shape for these rows** — they are batches (`v7 · 17/20 pass · $0.23`); it is one case execution | **NEW** `EvalBatchRecord` alongside an extended `EvalRunRecord` | *Module interactions* |
| D-30 | `img_1.png` | 01 | **`EvalDashboard` cannot express this screen** — it is single-owner (`contracts/eval-ci.ts:68-88`); the screen needs a list of per-agent summaries | **NEW** `EvalWorkspaceDashboard` | *Module interactions* |
| D-31 | `img_2.png` banner | 02 | "a new false positive slipped in" is an inference code cannot make, and scoring is code-only | Deterministic template with a stated threshold | AC-74, UX-3 |
| D-32 | `img_4.png` tabs | 04 | Six tabs drawn; four are labels with no body | One `TABS` entry added | AC-59 |
| D-33 | `img_1.png`, `img_2.png` sidebar | 01 / 02 | Rows drawn for Onboarding Tour and a whole GLOBAL group whose routes do not exist; `nav.ts:21-30` withholds a row until its route lands | Exactly one row added | AC-68 |
| D-34 | `img_2.png` header | 02 | An agent dropdown *and* an "All agents" back link *and* a breadcrumb — three ways to change agent | Breadcrumb plus back link; dropdown dropped | UX-6 `proposed` |
| D-35 | `img_2.png` Compare | 02 | No behaviour for three or more checked, or for two batches of one version | Enabled at exactly two; a same-version pair diffs to empty | AC-93, AC-94, AC-100 |
| D-36 | `img_5.png` modal vs `eval.json:76-83` | 05 | The mockup draws a modal; the shipped catalogue already carries `page.crumbNewCase` and `page.crumbEvalCase`, which only a routed page needs | Routed page | AC-76 |
| D-37 | `img_4.png` metric tiles | 04 | `▲4pt` with no stated baseline | The previous batch | AC-61 |
| D-38 | `img_1.png` "Run all agents" | 01 | No cost signal before a click that runs every case of every agent | Estimate plus confirmation | AC-72 |

## Module interactions

### Callers and callees

| Hop | Caller → callee | Transport | Payload |
|---|---|---|---|
| 1 | studio → **NEW** `POST /findings/:id/eval-case` | HTTP | finding id in the path, no body |
| 2 | **NEW** `modules/eval/routes.ts` → **NEW** `EvalService` | in-process | `workspaceId`, finding id |
| 3 | `EvalService` → `container.reviewRepo.findingContext` — existing (`modules/reviews/repository.ts:113-118`) | in-process | finding id → `{ finding, review, pull }` |
| 4 | `EvalService` → `parseUnifiedDiff` — existing (`adapters/git/diff-parser.ts:14`) → `sliceDiff` — existing (`reviewer-core/src/review/reduce.ts:58`) | in-process, pure | the PR's persisted `pr_files` patches → one file's fragment |
| 5 | `EvalService` → **NEW** `EvalRepository` | DB query | insert an `eval_cases` row, `workspaceId` first |
| 6 | studio → **NEW** `POST /agents/:id/eval-runs` | HTTP | agent id in the path, no body |
| 7 | `EvalService` → `container.agentsRepo.getById` / `.linkedSkills` — existing (`platform/container.ts:106-108`) | in-process | agent config, ordered skill links |
| 8 | `EvalService` → `skillPromptBlock(toSkillDto(row))` — existing (`modules/_shared/skills.ts:18,58`) | in-process, pure | active links → prompt blocks |
| 9 | `EvalService` → `container.llm(provider)` — existing (`platform/container.ts:208-216`) | in-process → provider HTTP | a resolved `LLMProvider` |
| 10 | `EvalService` → `reviewPullRequest` — existing (`reviewer-core/src/review/run.ts:144`) | in-process → provider HTTP | `{ systemPrompt, model, diff, llm, strategy, skills?, task }` |
| 11 | `EvalService` → **NEW** `matchesRange` in `modules/eval/scoring.ts` | in-process, pure | actual findings × expected findings → matched / unmatched (AC-44). **Not** `groundCitations`: that gate runs *inside* the engine at hop 10 and returns kept + `dropped[]`, which is all AC-52 needs — see UX-1 `rejected` |
| 12 | `EvalRepository` → `eval_runs` | DB query | one row per case, one shared `batch_id`, inserted at batch start and updated in place (*Schema impact*) |
| 12a | `EvalService` → `container.jobs.enqueue` — existing (`platform/jobs.ts:49`) | in-process | `('eval-batch', { workspaceId, agentId, batchId, trigger })` — the 202 path of AC-27 and AC-116 |
| 12b | `container.jobs` → the `eval-batch` handler `EvalService` registered (`platform/jobs.ts:45`) | in-process | the batch loop of hops 7-12, off the request |
| 12c | studio → **NEW** `GET /agents/:id/eval-runs` | HTTP, polled | agent id in the path → `EvalBatchRecord[]`, status derived |
| 13 | `AgentsRepository.update` — existing (`modules/agents/repository.ts:125`) → `container.jobs.enqueue` — existing (`platform/jobs.ts:49`) | in-process | `('agent-version-eval', { workspaceId, agentId, version })` — phase 2 |
| 14 | `EvalService.registerJobHandler` → `container.jobs.register` — existing (`platform/jobs.ts:45`) | in-process | the same body as hop 6, with `trigger: 'version-change'` — phase 2 |
| 15 | studio → **NEW** `POST /agents/:id/versions/:version/restore` | HTTP | agent id + version — phase 2 |

### The endpoints `modules/eval/` serves

Every one is **NEW**. The hop table above walks the two interesting paths; this
is the whole surface, so nothing has to be inferred from it.

| Method + path | Response | Criteria |
|---|---|---|
| `POST /findings/:id/eval-case` | `EvalCase` — 201, and **200** when idempotent | AC-5 … AC-18 |
| `GET /agents/:id/eval-cases` | `EvalCase[]` | AC-63, AC-64 |
| `POST /agents/:id/eval-cases` | `EvalCase` (201) | AC-19 … AC-25, AC-107 |
| `GET /eval-cases/:id` | `EvalCase` | AC-4 |
| `PUT /eval-cases/:id` | `EvalCase` | AC-19 … AC-24 |
| `DELETE /eval-cases/:id` | `{ ok: true }` | AC-26 |
| `POST /agents/:id/eval-runs` | `EvalBatchAccepted` (202) | AC-27, AC-33, AC-35, AC-39, AC-40 |
| `POST /eval-cases/:id/runs` | `EvalBatchAccepted` (202) | AC-116 |
| `POST /eval/runs` | `EvalBatchAccepted[]` (202) | AC-42, AC-43, AC-72 |
| `GET /agents/:id/eval-runs` | `EvalBatchRecord[]` | AC-61, AC-62, AC-66 — the poll behind AC-27 |
| `GET /eval/estimate` | `EvalBatchEstimate` | AC-72 |
| `GET /eval` | `EvalWorkspaceDashboard` | AC-69, AC-70, AC-71, AC-108 |
| `GET /eval/agents/:agentId` | `EvalDashboard` | AC-73, AC-74 |
| `POST /agents/:id/versions/:version/restore` | `Agent` — phase 2 | AC-102 … AC-105 |

Two naming constraints, both from the router rather than from taste: anything
under `/agents/` uses **`:id`**, because the agents module already registers
`/agents/:id/*` and a second param name on the same prefix is a find-my-way
conflict; `:agentId` appears only under the different `/eval/agents/:agentId`
prefix.

**Onion placement.** `modules/eval/` is a new vertical slice with the standard
three layers (`routes.ts` → `service.ts` → `repository.ts`) and it reaches nothing
private in another module. `container.agentsRepo` and `container.reviewRepo` are
the published cross-module seams — `server/.dependency-cruiser.cjs:116-133` names
both in the `no-cross-module-internals` comment. The skill mappers live in
`modules/_shared/skills.ts` precisely because they are pure. Phase 2's
cross-module trigger is a **job kind published in `modules/eval/constants.ts`**,
the pattern `repos/service.ts` already uses for `INDEX_JOB_KIND`. `cd server &&
pnpm lint:arch` is the check.

Two things R-1 established, which this spec follows rather than works around:
`ReviewRunExecutor` and `ReviewRepository` are **not** imported by the eval
module, and `buildSkillBlocks` (`modules/reviews/run-executor.ts:519-542`) is
**not** moved — it does I/O and logging, while `_shared/` is pure by convention
(`modules/_shared/skills.ts:10-15`), so the three pure lines are rebuilt in the
eval service instead. `loadDiff` (`modules/reviews/diff-loader.ts:12`) is
likewise **not** reused: it needs a `PullRow` and a `repos` row, which an eval run
does not have.

### Sequence — one batch

202 on the request, work on the `JobRunner`, progress by poll (AC-27, AC-66).

```mermaid
sequenceDiagram
    participant S as studio
    participant R as eval routes
    participant V as EvalService
    participant J as container.jobs (JobRunner)
    participant A as container.agentsRepo
    participant E as reviewer engine
    participant P as LLM provider
    participant D as EvalRepository

    S->>R: POST /agents/:id/eval-runs
    R->>V: accept(workspaceId, agentId)
    V->>A: getById + linkedSkills
    A-->>V: config + active skill blocks
    V->>D: cases for agent
    D-->>V: frozen cases
    Note over V: validate: agent, >=1 case,<br/>no active batch, provider key
    V->>D: insert one eval_runs row per case (metrics null, shared batch_id)
    V->>J: enqueue('eval-batch', { batch_id, agentId, trigger })
    V-->>R: EvalBatchAccepted { accepted, batch_id, cases }
    R-->>S: 202
    J->>V: eval-batch handler
    loop per case, serially
        V->>E: reviewPullRequest(prompt, parsed diff, llm)
        E->>P: completeStructured(Review)
        alt provider or parse fails
            P-->>E: error
            E-->>V: throws
            V->>D: update that case's row with error
        else
            P-->>E: candidate findings
            E-->>V: kept + dropped + cost
            V->>V: match, score, pass or fail
            V->>D: update that case's row with metrics
        end
    end
    Note over J,V: the 120 s job timeout may fire here;<br/>the jobs row goes failed, the batch runs on (AC-92)
    loop poll, concurrently with the batch, until status is not running
        S->>R: GET /agents/:id/eval-runs
        R->>V: batches(workspaceId, agentId)
        V->>D: read the batch aggregate
        D-->>V: EvalBatchRecord[] — status derived
        V-->>R: EvalBatchRecord[]
        R-->>S: 200
    end
```

### Contract impact

Canonical at `server/src/vendor/shared/contracts/`, hand-mirrored to
`client/src/vendor/shared/contracts/`; sync with
`./scripts/check-contracts.sh --fix` and typecheck both packages. **A contract
change here is always two files.** The barrel convention is to *extend*, never to
edit an existing export (`server/src/vendor/shared/index.ts:16-17`).

**Left unchanged, deliberately.** `EvalRun` and `EvalPerTrace`
(`contracts/knowledge.ts:50-68`) keep their non-nullable `recall` / `precision` /
`citation_accuracy`. R-3 established that `server/test/contracts.test.ts:159-167`
is the **only** construction site of either shape anywhere in the repository — and
that a new required field there fails at runtime, not at compile time (root
`insights.md` 2026-08-28, which is the same trap SPEC-02 fell into). Because
AC-38, AC-46, AC-51 and AC-53 all need a null metric, the nullable numbers live on
the **persisted** shapes instead, and `EvalRun` is left alone rather than loosened.

| Contract | Change | Why |
|---|---|---|
| `EvalExpectation` | **NEW** `z.enum(['must_find','must_not_flag'])` | the new column's two values |
| `EvalExpectedFinding` | **NEW** `{ file: z.string().min(1), start_line: z.number().int(), end_line: z.number().int().optional(), severity: Severity.optional(), category: FindingCategory.optional(), title: z.string().optional() }` with an object-level `.transform` filling `end_line` from `start_line` | AC-19, AC-21. Deliberately **not** `Finding`: `img_5`'s JSON carries no `id`, `rationale` or `confidence`, and requiring them would make every hand-written case invalid. The transform makes `z.input` differ from `z.infer`, so the caller-facing type is exported as `EvalExpectedFindingBody = z.input<…>` — the pattern `ComposeReviewInputBody` already sets (`contracts/eval-ci.ts:105-106`) |
| `EvalCase` | extend with `expectation: EvalExpectation` and retype `expected_output` to `z.array(EvalExpectedFinding)` | replaces the `z.unknown()` at `knowledge.ts:81` for the agent-owned case |
| `EvalCaseInput` | extend with `expectation: EvalExpectation.default('must_find')`; retype `expected_output` to `z.array(EvalExpectedFinding)` | AC-25 — `.default()` keeps the field optional on the wire and present in the parsed value |
| `EvalRunRecord` | extend with `agent_id`, `batch_id`, `agent_version`, `expectation`, `expected_count`, `actual_count`, `error` — **each one `.nullish()`** | root `insights.md` 2026-08-03: a new field on a multi-duty shape is `.nullish()` whatever it means. `pass`, the three metrics and `cost_usd` are already nullable (`eval-ci.ts:39-44`) |
| `EvalBatchStatus` | **NEW** `z.enum(['running','complete','partial','failed'])` | plan D-1 — a polled batch is observable while it is still in flight, so `running` is a fourth value, not an absence |
| `EvalBatchRecord` | **NEW** `{ batch_id, agent_id, agent_name, agent_version, ran_at, trigger, status: EvalBatchStatus, recall/precision/citation_accuracy: z.number().nullable(), traces_passed, traces_total, cases_ran, cases_total, cost_usd: z.number().nullable() }` | D-29 — the row shape both dashboard tables actually draw. The three metrics and `cost_usd` are `.nullable()`, never `.optional()`: `null` is a fact the studio renders as a placeholder, and it is not `0` |
| `EvalBatchAccepted` | **NEW** `{ status: z.literal('accepted'), batch_id: z.string().nullable(), cases: z.number().int(), degraded: z.boolean().nullish(), reason: z.string().nullish() }` | AC-27, AC-116, AC-43 — the 202 body of every run route, mirroring `IntentDeriveAccepted` (declared `modules/reviews/routes.ts:28`, returned at `:163-169`) |
| `EvalDashboard` | extend with `alert_metric`, `alert_delta` and `batches: z.array(EvalBatchRecord)`; keep `recent_runs` | AC-73, AC-74. The existing single-owner shape fits `img_2` once it can carry batches |
| `EvalWorkspaceDashboard` | **NEW** `{ agents: z.array(EvalDashboardAgentRow), recent_batches: z.array(EvalBatchRecord) }`, with `EvalDashboardAgentRow` = `{ agent_id, agent_name, model, enabled, cases_total, latest: EvalBatchRecord.nullable(), sparkline: z.array(z.number()) }` | D-30 — `img_1` needs a list, and `EvalDashboard` is one owner |
| `EvalBatchEstimate` | **NEW** `{ agents: z.number().int(), cases: z.number().int(), est_cost_usd: z.number().nullable() }` | AC-72; `null` when no priced batch exists to extrapolate from, never `0` |
| `AgentVersionConfig` | extend with `restored_from: z.number().int().nullish()` | AC-104. It is parsed on **every** version read (`modules/agents/helpers.ts:39`), so a snapshot written with the field must be accepted by the schema or `toAgentVersionDto` throws |
| `Agent` | extend with `auto_eval: z.boolean().default(false)` | AC-85's opt-in, surfaced in the editor. `.default()` rather than a bare boolean, matching `repo_intel` two lines above it (plan D-10): the field stays optional on the wire and present in the parsed value, so no shipped caller has to send it — but it is **required in `z.infer`**, so every `const AGENT: Agent = {…}` fixture in the studio needs the field |

**Where each shape lives (plan D-10, step 1).** `EvalExpectation` and
`EvalExpectedFinding` go in **`contracts/knowledge.ts`, immediately above
`EvalCase`** — they are that shape's own vocabulary and `EvalCase` lives there;
this adds one edge `knowledge.ts → findings.ts` for `Severity` /
`FindingCategory`, which is acyclic. The **new API-facing** shapes —
`EvalBatchRecord`, `EvalBatchStatus`, `EvalDashboardAgentRow`,
`EvalWorkspaceDashboard`, `EvalBatchEstimate`, `EvalBatchAccepted` — go in a
**new `contracts/eval-agent.ts`**, which is what the barrel convention asks for
(extend with new files, never edit an existing export); `eval-ci.ts` imports
`EvalBatchRecord` from it for the `EvalDashboard.batches` extension. Resulting
DAG: `findings ← knowledge ← eval-agent ← eval-ci`.

Every route declares its Zod `response:` schema. One trap to respect:
`POST /agents/:id/eval-runs`, `POST /eval-cases/:id/runs` and the restore route
take no body, so they must declare **no `body:` schema at all** — a declared body
schema rejects a body-less POST (`server/insights.md` 2026-08-29).

### Schema impact

One migration, generated with `cd server && pnpm db:generate` and **never**
hand-edited. Before generating, re-check that the snapshot list and the journal
still agree —

```sh
ls server/src/db/migrations/meta/*_snapshot.json
grep -o '"tag": "[^"]*"' server/src/db/migrations/meta/_journal.json
```

— because drizzle-kit picks its baseline from the highest-numbered snapshot *file*
and never consults the journal, so an orphan snapshot silently diffs against a
state nobody ever applied (`server/insights.md` 2026-08-11). At the time of
writing they agree: 17 snapshots, 17 journal entries, baseline
`0016_snapshot.json`.

All three tables already exist. Nothing is dropped or renamed, so the generate is
pure additions and takes no interactive rename prompt — that prompt fires only
when one table both gains and loses a column in the same generate
(`server/insights.md` 2026-08-11; R-5).

| Table | Column | Type | Note |
|---|---|---|---|
| `eval_cases` | `expectation` | `text NOT NULL DEFAULT 'must_find'` | Postgres 16 records a non-volatile default as metadata, so no table rewrite (R-5). Drizzle's `text('expectation', { enum: [...] })` is **TypeScript-only inference and emits no CHECK constraint** (R-5) — the same shape as `agents.provider` (`schema/agents.ts:15`) and `agent_runs.status`; the two values are enforced by Zod at the route. A `pgEnum` would need a migration to extend, which is exactly why this repo avoids one (`schema/reviews.ts:72-73` says so) |
| `eval_cases` | `created_at` | `timestamptz NOT NULL DEFAULT now()` | the table has no ordering key today, so the case list has nothing stable to sort by |
| `eval_runs` | `agent_id` | `uuid NULL REFERENCES agents(id) ON DELETE SET NULL` | denormalised for the dashboard read; **not** the tenancy path (AC-2) |
| `eval_runs` | `agent_version` | `integer NULL` | AC-32. No FK to `agent_versions` — its PK is composite and its rows may be absent (D-9) |
| `eval_runs` | `batch_id` | `uuid NULL` | one batch = one `POST`. No FK, because there is no batch table: the aggregate is computed on read |
| `eval_runs` | `trigger` | `text NULL` | `manual` \| `version-change`; same text-enum reasoning as above |
| `eval_runs` | `error` | `text NULL` | AC-36, AC-111 |
| `agents` | `auto_eval` | `boolean NOT NULL DEFAULT false` | AC-85; metadata-only add (R-5) |

**A batch is materialised up front; its status is derived, not stored** (plan
D-2). At batch start the runner inserts **one `eval_runs` row per case** — all
metrics null, with `batch_id`, `agent_id`, `agent_version` and `trigger` already
set — and updates each row in place as its case completes. Nothing else records
that a batch exists: **there is no batch table and no status column**, and the
table above is unchanged by this note. Read time derives the whole aggregate:

- `cases_total` — the rows carrying that `batch_id`;
- `cases_ran` — the rows whose `pass IS NOT NULL` (AC-37, verbatim);
- `status` — `running` when the batch id is in the eval service's in-memory
  active set; else `failed` when every row carries `error`; else `complete` when
  every row is scored-or-errored; else `partial`.

So AC-41's and AC-110's "the batch is `partial`" is a **derivation, not a
write**: a stopped batch leaves its unreached cases as all-null rows, and the
rule above reads them as `partial` without anyone setting a flag. The same rule
is why an API restart mid-batch leaves the batch reading `partial` — which is
true — even though nothing re-drives the `jobs` row.

**Indexes.** Postgres does not auto-index foreign-key columns, and three access
paths here are new:

- `eval_cases (owner_kind, owner_id)` — every case list and every per-agent count.
- `eval_runs (agent_id, ran_at DESC)` — the dashboard's per-agent latest batch and
  its trend.
- `eval_runs (batch_id)` — the batch aggregate, and the read behind AC-37.

**No GIN index on `input_meta`.** AC-16's idempotency lookup is a containment
query over `source_finding_ids`, which a GIN index would serve — but the search
space is one agent's cases, capped at 50 by AC-107, so scanning at most 50 JSONB
blobs is cheaper than maintaining an index nothing else reads. If AC-107's ceiling
rises, this is the decision to revisit.

**No `workspace_id` on `eval_runs`.** The table has none today
(`schema/eval.ts:22-35`) and this spec does not add one: scoping goes through
`case_id → eval_cases.workspace_id`, asserted at the repository, exactly as
`pr_intent`, `pr_brief` and `pr_file_summaries` scope through `pr_id`
(`schema/reviews.ts:101-103`). Adding `agent_id` creates a second path that could
disagree with the first, which is why AC-2 says which one is authoritative.

### Failure modes

Every hop that can misbehave, and the criterion that says what happens.

| Hop | Failure | Criterion |
|---|---|---|
| 9 | provider key absent — `container.llm` throws `ConfigError` (`platform/container.ts:221`, 500) | **AC-39** |
| 10 | provider 5xx or timeout on one case | **AC-36**, **AC-37** |
| 10 | provider fails on every case | **AC-38** |
| 10 | model output fails `Review` validation after `DEFAULT_REVIEW_MAX_RETRIES` (`run.ts:32`) | **AC-111** |
| 10 | the running cost passes the batch ceiling | **AC-41** |
| 10 | the batch passes the wall-clock ceiling | **AC-110** |
| 4 | the finding's file is not in the PR's persisted diff | **AC-17** |
| 3 | the finding's review has no `agent_id` | **AC-18** |
| 3 | the finding belongs to another workspace | **AC-4** |
| 12 | a second batch for the same agent is already running | **AC-40** |
| 13 | `jobs.enqueue` throws — no handler registered for the kind (`jobs.ts:50-51`) | **AC-91** |
| 14 | the job exceeds `timeoutMs` (120 s). `withTimeout` rejects the race but **does not abort the underlying promise** (`platform/resilience.ts:13-24`), and `TimeoutError` carries no `status` and no `code`, so `defaultIsRetryable` returns false (`resilience.ts:35-44`) — the `jobs` row is marked `failed`, the batch runs on and persists normally, and nothing retries it. A 20-case batch will exceed 120 s. **Accepted for manual batches too** now that AC-27's run route is itself a job (OQ-3, resolved as option iii) | **AC-92** |
| 14 | a stale payload arrives after a newer version bump | **AC-88** |
| 14 | the same payload is delivered twice | **AC-89** |
| 15 | the restored version has no snapshot | **AC-99** |

Two runner properties this spec is built *around* rather than against (R-2):
`JobRunner.enqueue` schedules on a p-queue immediately and exposes **no cancel**,
and the `jobs` table is a mirror that nothing re-drives after a restart. So
AC-87's debounce is an **in-memory pending marker owned by the eval module**, not
a row update — cancelling a queued row would not unschedule the task — and
AC-88's version re-read is the second, durable half of the same guard. The
persisted `eval_runs` rows, not the `jobs` row, are the record of what happened;
AC-92 exists so the two can be reconciled by hand when they disagree.

## Model & prompt

The scoring is code (AC-56). The batch calls a model once per case, through the
agent's own configuration.

**Prompt slots and their order.** Exactly the slots `assemblePrompt` builds for a
real review, minus the five this spec omits. The slot order, and the
`INJECTION_GUARD` and `OUTPUT_LANGUAGE_RULE` appended to *every* prompt, are
defined once in [`docs/agent-prompts/`](../docs/agent-prompts/README.md) and in
`reviewer-core/src/prompt.ts:16-30`. This spec neither restates them nor adds a
slot of its own.

| Slot | In an eval run? |
|---|---|
| `systemPrompt` (trusted) | yes — the agent's, verbatim |
| `skills` (resolved blocks) | yes — AC-30 |
| `task` | yes — frozen in `input_meta.task`, because `taskLine` needs a `PullRow` an eval run has not got (`modules/reviews/helpers.ts:82-90`) |
| `diff` (untrusted) | yes — the case's frozen `input_diff` |
| `prDescription` (untrusted) | only when the case froze one into `input_meta` |
| `specs` (project context) | **no** — AC-29 |
| `repoMap`, `callers` | **no** — AC-29; both need a `repoId` and an index |
| `memory` | **no** — AC-29 |
| `intent` | **no** — AC-29 |

**Stated out loud, because it decides what a score means:** an eval prompt is
*not* byte-identical to the prompt the same agent would send on a real pull
request. It omits repo-intel context, project-context documents and derived
intent. An eval score therefore measures *the system prompt, the model and the
skills*, holding everything the repository would have contributed constant at
nothing. That makes it comparable across versions — which is the property goal 3
needs — and it does not make it a prediction of live review quality.

**Model and tier.** Whichever the agent is configured with; this spec hardcodes no
model id and no price. The eval baseline the repository already ships for exactly
this purpose is `z-ai/glm-4.7-flash`, priced at 0 in
`server/src/adapters/llm/pricing.ts` and commented there as the free baseline for
evals (R-4). Prices are read from that table, or live from the OpenRouter
catalogue (`server/src/platform/model-catalog.ts:38-43`) — never from this
document. Cost fidelity differs by provider and NFR-2 depends on it: OpenRouter
reports a real number, OpenAI and Anthropic are estimates from the static table,
and an unpriced model yields `null` (R-4). `null` and `0` stay distinct
everywhere (AC-58; root `insights.md` 2026-08-02).

**Determinism.** The scorer is deterministic: the same actual and expected
findings always produce the same metrics (AC-56). The *model* is not. Two batches
of one version over the same frozen diffs may differ. Freezing the inputs removes
diff drift from the comparison, which is all goal 3 claims; it does not remove
sampling variance, and a single-batch-per-version comparison is therefore noisy.
Nothing in this spec asserts run-to-run agreement.

**Structured output.** `Review` (`contracts/findings.ts:66-78`), parsed by the
engine with `DEFAULT_REVIEW_MAX_RETRIES = 2` (`reviewer-core/src/review/run.ts:32`).
Model output is untrusted: AC-111 covers a failed parse, AC-57 covers a
model-authored `kind`.

**Token budget.** Per call, the agent's provider cap — `LLM_MAX_OUTPUT_TOKENS`,
default 8192 (`server/src/platform/config.ts:40`). Omitting a cap makes OpenRouter
402 a low-credit account before the call even runs (root `insights.md`
2026-08-22), so the batch inherits that default rather than setting its own. Per
batch, the dollar ceiling of NFR-2, with AC-41 as the behaviour at it.

**Eval.** This *is* the eval feature — it fills `eval_cases` and `eval_runs`, the
two tables `AGENTS.md` lists as existing ahead of their module. How a regression
in the harness itself would be noticed: NFR-13 pins the scorer's arithmetic and
NFR-14 is requirement 7's live sensitivity experiment.

## UX improvements

All `proposed` unless marked otherwise. Only the author promotes one.

- **UX-1** `rejected` — *Proposed:* score `must_find` matching with the existing
  `groundCitations` (`reviewer-core/src/grounding.ts:94`) rather than a new
  matcher, on the claim that its predicate already *is* "same file, ranges
  intersect". *Rejected (plan D-5), because it is not that predicate.*
  `groundCitations(items, diff)` builds a line index **from a diff** and asks
  whether an item touches a changed line in that file (`grounding.ts:94-120`);
  matching an *actual* finding against an *expected* finding is a two-list
  range-overlap test with no diff in it at all. The predicate UX-1 actually
  points at is `rangeIntersects` (`grounding.ts:68`, called at `:119`), which is
  **deliberately off the `reviewer-core` barrel** —
  `reviewer-core/src/index.ts:32-34` says so in as many words, because
  `groundCitations` is meant to be the whole seam — so exporting it is a
  `reviewer-core` change, and the *Non-goals* forbid one ("`groundCitations` is
  reused as-is, not modified"). *What is built instead:* AC-44's matcher is a
  local, pure `matchesRange()` in `modules/eval/scoring.ts`, whose doc comment
  cites `grounding.ts:68` as the predicate it deliberately mirrors so the two cannot
  drift silently, guarded by a mutation check (break the matcher, confirm the
  AC-44 table goes red, revert). AC-52 is unaffected either way: it needs no
  matcher, because `reviewPullRequest` already returns kept `review.findings` and
  `dropped[]` (`reviewer-core/src/review/run.ts:110-118, 236-246`), which are the
  numerator and denominator directly.
- **UX-2** `proposed` — Render the expectation as a chip on each case row
  (`img_4`). Cost: one chip, one i18n key. Benefit: a `must_not_flag` case stops
  being indistinguishable from a `must_find` one (D-17). *(AC-67 stands
  independently — the row must show the expectation somehow; UX-2 is the specific
  chip treatment.)*
- **UX-3** `proposed` — Drop the causal clause from the alert banner. Cost:
  negative, it removes work. Benefit: the banner stops claiming an inference the
  code cannot make (D-31).
- **UX-4** `proposed` — List the changed `config_json` fields above the prompt diff
  in the compare modal. Cost: a small list. Benefit: a model swap stops rendering
  as an empty diff (D-23).
- **UX-5** `proposed` — Colour the cost delta by direction rather than by sign.
  Cost: one conditional. Benefit: a cost increase stops being green (D-22).
- **UX-6** `proposed` — Drop the agent dropdown from the agent-detail header,
  keeping the breadcrumb and the back link. Cost: negative. Benefit: one fewer of
  three redundant navigation affordances (D-34).
- **UX-7** `proposed` — Show "from PR #482 @ `2ba3303`" on a case created from a
  finding, out of the provenance AC-11 and AC-12 already persist. Cost: one line
  per row. Benefit: in six weeks nobody will know where `stripe-key-leak` came
  from.
- **UX-8** `proposed` — Give the nav row `gKey: "e"` (unused — `p x s a c ,` are
  taken) and add `g e` to `SHORTCUTS` (`client/src/vendor/ui/nav.ts:69-80`). Cost:
  two lines. Benefit: consistency, since every other nav row has one.

## Non-functional requirements

Two of these are floors rather than ceilings (NFR-8, NFR-9, NFR-10, NFR-11,
NFR-12, NFR-15, NFR-16) and have no "past the number" behaviour to specify;
that is stated per row so the omission is deliberate rather than missed.

- **NFR-1** — The API shall add at most 250 ms of its own work per case —
  matching, scoring and persistence, excluding the model call — for **every** case
  in a batch. *Measured:* `server-integration`, timed over a 20-case batch against
  the stub provider in `server/src/adapters/mocks.ts`. This is a **generous
  absolute ceiling, not a p95** (plan D-11): the work it bounds is a pure scorer
  plus one row update, so the real figure is orders of magnitude under it, and an
  absolute assertion against a generous number is the one form that does not
  flake inside a testcontainers suite. *Ceiling behaviour:* AC-110.
- **NFR-2** — A batch shall cost at most the configured per-batch ceiling,
  defaulting to **USD 0.50** from a new `EVAL_BATCH_MAX_USD` entry in
  `server/src/platform/config.ts`. *Measured:* `server-integration` — the sum of
  the batch's `eval_runs.cost_usd`, with a stub provider reporting a known cost
  per call. *Ceiling behaviour:* AC-41. Note the fidelity limit from R-4: the sum
  is exact on OpenRouter, an estimate on OpenAI and Anthropic, and `null` for an
  unpriced model, in which case the ceiling cannot bind — OQ-6.
- **NFR-3** — `GET /eval` shall respond in under 400 ms for a workspace with
  10 agents, 50 cases per agent and 50 batches. *Measured:* `server-integration`,
  timed against a seeded workspace of that size — again a **generous absolute
  ceiling, not a p95** (plan D-11). What the number is really pinning is the
  shape of the query: the dashboard read is **one statement with the aggregate in
  SQL**, never N+1 over batches, and 400 ms is the figure an N+1 would blow
  through while a single indexed aggregate does not notice it. *Ceiling
  behaviour:* AC-108.
- **NFR-4** — An agent shall hold at most 50 eval cases. *Measured:*
  `server-integration` — the 51st create is refused. *Ceiling behaviour:* AC-107.
- **NFR-5** — A case's `input_diff` shall be at most 256 KB. *Measured:*
  `server-unit` — a 257 KB body is refused at the route. *Ceiling behaviour:*
  AC-106.
- **NFR-6** — A batch shall run for at most the configured wall clock, defaulting
  to **900 000 ms (15 minutes)** from a new `EVAL_BATCH_MAX_MS` entry in
  `server/src/platform/config.ts`, beside `EVAL_BATCH_MAX_USD` (NFR-2).
  *Measured:* `server-integration` — the app is built with `EVAL_BATCH_MAX_MS`
  **lowered to a couple of seconds** and a stub provider that delays past it, and
  the batch is then observed to read `partial`. The knob exists for exactly that
  reason (plan D-11): a test that waits fifteen minutes to prove a ceiling is a
  test nobody runs, and a hard-coded literal is a ceiling nobody can test.
  *Ceiling behaviour:* AC-110.
- **NFR-7** — A case shall hold at most 20 expected findings. *Measured:*
  `server-unit` — a 21-entry array is refused. *Ceiling behaviour:* AC-109.
- **NFR-8** — Every metric value, delta and pass/fail label shall render at a
  contrast ratio of at least **4.5:1** against its background (WCAG 2.2 SC 1.4.3
  Contrast (Minimum), normal-size text). *Measured:* `client` — computed contrast
  read off the inline `style.color`, since the suite runs with `css: false`
  (client `insights.md` 2026-08-27). *A floor, not a ceiling.*
- **NFR-9** — Pass/fail state and metric direction shall each be conveyed by a
  glyph or text label as well as by colour (WCAG 2.2 SC 1.4.1 Use of Color).
  *Measured:* `client` — the accessibility tree carries the state without
  reference to colour. *A floor, not a ceiling.*
- **NFR-10** — The start and the completion of a batch shall be announced through
  a live region (WCAG 2.2 SC 4.1.3 Status Messages). *Measured:* `client` — the
  live region's content after the run control is activated. *A floor, not a
  ceiling.*
- **NFR-11** — The disabled "Turn into eval case" action, the expectation control
  and each compare checkbox shall expose an accessible name and state (WCAG 2.2 SC
  4.1.2 Name, Role, Value). *Measured:* `client` — queried by role with the
  expected accessible name; note that adding `aria-expanded` to a repeated
  component poisons every `expanded` query in the suite (client `insights.md`
  2026-08-29), so no such attribute is added here. *A floor, not a ceiling.*
- **NFR-12** — Each case run shall emit exactly one structured log line at `info`
  carrying the batch id, the case id and the three metric values. *Measured:*
  `server-unit` — the captured Pino output for a two-case batch holds two lines.
  *A floor, not a ceiling.*
- **NFR-13** — Adding three actual findings that match no expectation to a fixed
  set of 10 matched findings shall lower the computed precision by exactly
  0.2308 (3/13), and removing one matched expectation from a five-expectation
  `must_find` set shall lower recall by exactly 0.2. *Measured:* `server-unit`,
  table-driven over the pure scorer with the expected values computed
  independently of the implementation. *A floor, not a ceiling.* This is the half
  of goal 4 that a test can hold.
- **NFR-14** — Requirement 7's live experiment: appending an over-flagging
  instruction to a real agent's system prompt shall lower precision on a fixed
  six-case set. *Measured:* `manual, once` — it needs a real provider and a real
  model, and no hermetic harness can demonstrate model sensitivity. To automate
  it, the repository would need a recorded-response provider fixture, which does
  not exist. *A direction, not a threshold.*
- **NFR-15** — This spec shall add no required field to any contract that already
  ships. *Measured:* `server-unit` — `server/test/contracts.test.ts` passes
  unchanged, and `./scripts/check-contracts.sh` exits 0. R-3 established that this
  test file is the only consumer of any `Eval*` shape and the only thing that would
  catch the break. *A floor, not a ceiling.*
- **NFR-16** — No log line, and no response outside the case's own detail
  endpoint, shall carry a case's `input_diff`, its `expected_output` or a model
  finding's body. *Measured:* `server-unit` — captured log output for a batch over
  a case whose diff contains a known sentinel string does not contain it. *A
  floor, not a ceiling.*
- **NFR-17** — At most one `agent-version-eval` job shall be pending per agent at
  any moment. *Measured:* `server-integration` — five rapid version bumps produce
  at most one queued `jobs` row for that agent. *Ceiling behaviour:* AC-87.

## Inputs and provenance

| Input | Source | Trusted? | Freshness | Missing / malformed |
|---|---|---|---|---|
| Frozen `input_diff` | `pr_files.patch` via `parseUnifiedDiff` + `sliceDiff` at creation (`adapters/git/diff-parser.ts:14`, `reviewer-core/src/review/reduce.ts:58`), or typed by the author | **no** | frozen at creation; never refreshed | reject at save (AC-24, AC-106) |
| Finding decision | `findings.accepted_at` / `dismissed_at` (`schema/reviews.ts:53-54`) | yes — a human wrote it | read at creation | the action is disabled (AC-6) |
| Finding location | `findings.file` / `start_line` / `end_line` (`schema/reviews.ts:42-44`) | yes — already survived the grounding gate | read at creation | reject if the file is absent from the diff (AC-17) |
| Owning agent | `reviews.agent_id` (`schema/reviews.ts:26`, nullable) | yes | read at creation | reject (AC-18) |
| `head_sha` | `pull_requests.head_sha` (`schema/pulls.ts:20`, `NOT NULL`) | yes | frozen at creation | cannot be missing; a deleted PR leaves it dangling by design |
| `expected_output` | typed by the author, or derived from the finding | **no** — hand-authored JSON | frozen until edited | 422 with the Zod path (AC-19, AC-20) |
| `expectation` | derived from the decision, or chosen in the editor | yes | per save | defaults to `must_find` (AC-25) |
| Agent config | `agents` row at batch time (`platform/container.ts:106`) | yes | read once per batch | 404 for an unknown or foreign agent (AC-4) |
| Skill bodies | `agent_skills` ⋈ `skills` via `container.agentsRepo.linkedSkills` | **no** — a skill may be imported from a foreign source (`modules/_shared/skills.ts:33,59`) | read once per batch | a lookup failure yields no blocks; the batch runs unskilled |
| Model output | the configured LLM provider | **no** | per call | reject and record (AC-111) |
| `cost_usd` | provider (OpenRouter) or the static table (OpenAI, Anthropic) — `adapters/llm/pricing.ts:10-53` | yes | per call | persist `null`, never `0` (AC-58) |
| `workspace_id` | session, via `getContext` (`modules/_shared/context.ts`) | yes | request-scoped | the existing auth path answers |

## Untrusted inputs

Never empty in this repository, and unusually dense here: an eval case is
*purpose-built* to hold attacker-shaped content — a diff that leaks a secret, a
payload that tries to steer a reviewer — and to replay it into a model prompt on
every batch, forever.

**1 · The frozen `input_diff` crossing into a model prompt.** Boundary: author or
PR author → provider. It is PR-derived text or hand-pasted text, and it is
replayed on every batch for the life of the case. Enforcement is the shared
defence the engine already applies: `assemblePrompt` wraps the diff section in
`<untrusted source="…">` fences and prepends `INJECTION_GUARD`, whose text
explicitly refuses claims that the content is a "test fixture", "example" or
"not for production" *in any language* (`reviewer-core/src/prompt.ts:16-30`),
and `wrapUntrusted` escapes an embedded `</untrusted>` so a case cannot close
the fence it is inside (`prompt.ts:41-45`). → **AC-115**

**2 · The frozen `input_diff` crossing into the database and the studio.**
Boundary: request body → row → browser. A 4 MB paste is a denial-of-service on
every subsequent read, and a diff that parses to zero files is a case that can
never pass. → **AC-24**, **AC-106**; rendered as text content, never as HTML, so
no `dangerouslySetInnerHTML` sink exists on this path → **AC-112**

**3 · Hand-authored `expected_output`.** Boundary: request body → row → scorer.
It is JSON typed by a human into a textarea, and the scorer indexes into it. A
schema-invalid entry would otherwise become a permanently-failing case with no
explanation. Validated at the boundary, once, with the failing path returned →
**AC-19**, **AC-20**, **AC-109**; surfaced in the studio → **AC-79**

**4 · Model output — the findings.** Boundary: provider → scorer → row →
browser. Parsed against `Review` before the engine returns
(`reviewer-core/src/review/run.ts:202-209`), so a non-conforming response never
reaches the scorer → **AC-111**. The specific hazard here is the `kind` field: a
model-authored free string reaching `FULL_FILE_KINDS` silently disables line
anchoring (root `insights.md` 2026-08-28), which on this path would let a model
inflate its own citation accuracy by labelling every finding `secret_leak`. The
scorer therefore applies the range test to every finding regardless of `kind` →
**AC-57**

**5 · Secrets inside a case, on purpose.** `img_5`'s case is literally named
`stripe-key-leak` and its frozen diff holds an `sk_live_…` literal. Redaction is
the wrong answer — the secret *is* the test — so the boundary is drawn around
where it may travel: it is workspace-scoped like every other row (**AC-1**,
**AC-4**), it is sent only to the agent's configured provider, and it never
reaches a log line → **AC-113**, **NFR-16**

**6 · Mass assignment on case creation.** Boundary: request body → row. The
create and update handlers must not spread a parsed body into the insert: a body
carrying `workspace_id`, `owner_kind` or `owner_id` would otherwise write a case
into another tenant or onto another owner. Each column is taken from a named
field → **AC-114**, with **AC-3** and **AC-4** as the specific refusals.

**7 · Expensive endpoints reachable by any authenticated caller.** `POST
/agents/:id/eval-runs` spends provider money per call. The global limit is 120
requests per minute (`server/src/app.ts:104-105`, disabled under `NODE_ENV=test`),
which is not a spend limit; the spend limits are the per-batch dollar ceiling and
the single-running-batch rule → **AC-41**, **AC-40**, **AC-110**

## Verification

One row per acceptance criterion and per numbered non-functional requirement.
Suites are named as [`TESTING.md`](../TESTING.md) names them in its suite map
(`TESTING.md:27-33`).

| Requirement | Suite / method | Observation point |
|---|---|---|
| AC-1 | `server-integration` | a second workspace's request returns no eval row |
| AC-2 | `server-integration` | a run whose `agent_id` names a foreign agent is still readable in its own workspace |
| AC-3 | `server-unit` | the 422 body's `error.code` for `owner_kind: 'skill'` |
| AC-4 | `server-integration` | 404 for a case id created in another workspace |
| AC-5 | `client` | the action is absent from the accessibility tree for each excluded `kind` |
| AC-6 | `client` | the action's `disabled` state and accessible name |
| AC-7 | `server-integration` | the persisted `expectation` for an accepted finding |
| AC-8 | `server-integration` | the persisted `expectation` for a dismissed finding |
| AC-9 | `server-integration` | the persisted `expectation` when both timestamps are set |
| AC-10 | `server-integration` | the persisted `input_diff` contains only the finding's file |
| AC-11 | `server-integration` | `input_meta.head_sha` equals the PR's |
| AC-12 | `server-integration` | `input_meta.source_finding_ids` holds the finding id |
| AC-13 | `server-integration` | the persisted `expected_output[0]` file and range |
| AC-14 | `server-integration` | the persisted `name` for a known finding title |
| AC-15 | `server-integration` | the second case's `name` carries the suffix |
| AC-16 | `server-integration` | the second request's status and the case count |
| AC-17 | `server-unit` | the 422 body for a finding whose file is absent from the diff |
| AC-18 | `server-integration` | the 422 body for a review with a null `agent_id` |
| AC-19 | `server-unit` | the parsed value for a well-formed array |
| AC-20 | `server-unit` | `error.details` carries the Zod path |
| AC-21 | `server-integration` | the persisted `end_line` when the entry omitted it |
| AC-22 | `server-integration` | the persisted row for `must_not_flag` with `[]` |
| AC-23 | `server-unit` | the 422 body for `must_find` with `[]` |
| AC-24 | `server-unit` | the 422 body for a prose `input_diff` |
| AC-25 | `server-integration` | the persisted `expectation` when the field was omitted |
| AC-26 | `server-integration` | the run count for the deleted case is zero |
| AC-27 | `server-integration` | the 202 body's `status`, `batch_id` and `cases`, and every case's run sharing that `batch_id` once the job has drained |
| AC-28 | `server-unit` | the stub provider's captured request messages |
| AC-29 | `server-unit` | the captured messages contain no context, repo-map, callers, memory or intent section |
| AC-30 | `server-unit` | the captured messages hold one block per active link, in link order |
| AC-31 | `server-unit` | the git and GitHub ports record zero calls during a batch |
| AC-32 | `server-integration` | the persisted `agent_version` equals the agent's `version` |
| AC-33 | `server-integration` | the persisted `trigger` is `manual` |
| AC-34 | `server-integration` | the `agent_runs` count is unchanged across a batch |
| AC-35 | `server-integration` | the 422 body, alongside an unchanged `eval_runs` row count |
| AC-36 | `server-integration` | the failing case's row carries `error` and the batch has a row per case |
| AC-37 | `server-integration` | the batch's reported `cases_ran` against `cases_total` |
| AC-38 | `server-integration` | the batch's three metrics are null when every call failed |
| AC-39 | `server-unit` | the 500 body's `error.code` is `config_error` |
| AC-40 | `server-integration` | the second concurrent request's 422 body |
| AC-41 | `server-integration` | the batch derives as `partial` and the scored-case count is short of `cases_total` |
| AC-42 | `server-integration` | the disabled agent has no batch after a workspace-wide run |
| AC-43 | `server-integration` | one batch per enabled agent with cases |
| AC-44 | `server-unit` | the matcher's boolean for touching, overlapping and disjoint ranges |
| AC-45 | `server-unit` | the computed `recall` for a hand-built case set |
| AC-46 | `server-unit` | the computed `recall` is null for an all-`must_not_flag` batch |
| AC-47 | `server-unit` | the noise count for any actual finding produced on a `must_not_flag` case |
| AC-48 | `server-unit` | the noise count for an unmatched extra on a `must_find` case |
| AC-49 | `server-unit` | the noise count for any finding on an empty `must_not_flag` case — the same rule as AC-47, asserted on the empty `expected_output` |
| AC-50 | `server-unit` | the computed `precision` for a hand-built batch |
| AC-51 | `server-unit` | the computed `precision` is 1 for a zero-finding batch, and null rather than 1 for an all-failed one (AC-38 precedence) |
| AC-52 | `server-unit` | the per-case `citation_accuracy` against the engine's kept and dropped counts, and the batch's micro-average over a set with differing per-case candidate counts |
| AC-53 | `server-unit` | the computed `citation_accuracy` is null for a zero-candidate case |
| AC-54 | `server-unit` | the `pass` boolean for a `must_find` case with and without an unmatched extra, and for a `must_not_flag` case with and without an actual finding |
| AC-55 | `server-integration` | the batch's `traces_passed` and `traces_total` |
| AC-56 | `server-unit` | the injected LLM port records zero calls during scoring |
| AC-57 | `server-unit` | a finding with `kind: 'secret_leak'` and a non-intersecting range is scored as noise |
| AC-58 | `server-integration` | the persisted `cost_usd` is null for an unpriced model and 0 for a free one |
| AC-59 | `client` | the tab is in the accessibility tree |
| AC-60 | `client` | the Evals body renders for `?tab=evals` |
| AC-61 | `client` | the rendered delta text for a two-batch fixture |
| AC-62 | `client` | no delta node for a one-batch fixture |
| AC-63 | `client` | the row's expected and actual counts |
| AC-64 | `client` | the `never run` label on a run-less case row |
| AC-65 | `client` | the empty-state CTA is in the accessibility tree |
| AC-66 | `client` | the run control's running state while a batch is in flight |
| AC-67 | `client` | each row's expectation is in the accessibility tree |
| AC-68 | `client` | the sidebar row's text equals the `shell.nav.eval` message |
| AC-69 | `client` | one row per agent, each with four values |
| AC-70 | `client` | the empty-state CTA on `/eval` |
| AC-71 | `client` | the rendered batch order for an out-of-order fixture |
| AC-72 | `client` | the confirmation dialog's estimate text, and no request before confirming |
| AC-73 | `client` | tiles, trend and table all render for one agent |
| AC-74 | `server-unit` | the returned `alert_metric` and `alert_delta` for a 0.02 precision drop, and null for 0.01 |
| AC-75 | `client` | the trend's ordinal x-axis labels, read from the accessibility tree of the new `MetricTrend` |
| AC-76 | `client` | the empty editor renders at the `new` route |
| AC-77 | `client` | the expectation control is queryable by role with both options |
| AC-78 | `client` | the `invalidJson` badge for malformed text |
| AC-79 | `client` | the rendered Zod path after a 422 |
| AC-80 | `server-integration` | the agent's `version` after a link |
| AC-81 | `server-integration` | the agent's `version` after an unlink |
| AC-82 | `server-integration` | the agent's `version` after a link toggle |
| AC-83 | `server-integration` | the agent's `version` after `setSkills` |
| AC-84 | `server-integration` | the new `agent_versions` row's `config_json.skills` |
| AC-85 | `server-integration` | one queued `jobs` row of kind `agent-version-eval` after a bump touching an allow-listed field, and none after a bump touching only `ci_fail_on`, `repo_intel`, `name` or `description` |
| AC-86 | — | Deleted by plan D-13. Its observation — no `jobs` row after a description-only edit — moved onto AC-85's row, so nothing went unobserved with it |
| AC-87 | `server-integration` | one queued row after five rapid bumps |
| AC-88 | `server-unit` | the handler returns without a provider call for a stale payload |
| AC-89 | `server-integration` | no second batch for the same agent id and version |
| AC-90 | `server-integration` | the persisted `trigger` is `version-change` |
| AC-91 | `server-integration` | the `PUT /agents/:id` response with no handler registered |
| AC-92 | `server-unit` | the captured log line pairs the batch id with the failed job id |
| AC-93 | `client` | the Compare control is enabled with two checked |
| AC-94 | `client` | the Compare control is disabled with one and with three checked |
| AC-95 | `client` | the four delta tiles' before, after and delta text |
| AC-96 | `client` | the diff pane renders for a two-version fixture |
| AC-97 | `client` | added, removed and unchanged lines are each distinguishable in the accessibility tree |
| AC-98 | `client` | the truncation notice for a 9 000-character prompt |
| AC-99 | `client` | the "snapshot unavailable" notice when a version is missing |
| AC-100 | `client` | the diff pane is empty for a same-version pair |
| AC-101 | `client` | the restore control's label names the older version |
| AC-102 | `client` | no request is issued before the confirmation is accepted |
| AC-103 | `server-integration` | the new version's `config_json` equals the restored version's |
| AC-104 | `server-integration` | the new version's `config_json.restored_from` |
| AC-105 | `server-integration` | no `jobs` row after a restore |
| AC-106 | `server-unit` | the 422 body for a 257 KB `input_diff` |
| AC-107 | `server-integration` | the 51st create is refused |
| AC-108 | `server-integration` | the response holds 50 batches for a 60-batch workspace |
| AC-109 | `server-unit` | the 422 body for a 21-entry array |
| AC-110 | `server-integration` | the batch derives as `partial` after the wall-clock ceiling, with `EVAL_BATCH_MAX_MS` lowered for the test |
| AC-111 | `server-integration` | the case run's `error` after a schema-invalid model response |
| AC-112 | `client` | the rendered node's `textContent` equals the raw diff, with no HTML sink |
| AC-113 | `server-unit` | the captured log line's fields |
| AC-114 | `server-integration` | a body carrying `workspace_id` and `owner_id` does not change the persisted row's owner |
| AC-115 | `reviewer-core` | the assembled user message wraps the diff in `<untrusted>` fences |
| AC-116 | `server-integration` | the 202 body's `cases` is 1, and exactly one `eval_runs` row carries the returned `batch_id` |
| NFR-1 | `server-integration`, timed | the slowest per-case overhead over a 20-case stub batch, against the absolute 250 ms ceiling |
| NFR-2 | `server-integration` | the summed `cost_usd` of a batch against the configured ceiling |
| NFR-3 | `server-integration`, timed | one warm `GET /eval` over a 10-agent, 50-batch seed, against the absolute 400 ms ceiling |
| NFR-4 | `server-integration` | the case count at which creation is refused |
| NFR-5 | `server-unit` | the byte size at which the route refuses |
| NFR-6 | `server-integration`, timed | the batch's recorded wall clock against a lowered `EVAL_BATCH_MAX_MS`, and the `partial` status that follows |
| NFR-7 | `server-unit` | the entry count at which the route refuses |
| NFR-8 | `client` | computed contrast ≥ 4.5:1 read from the inline `style.color` (WCAG 2.2 SC 1.4.3) |
| NFR-9 | `client` | the pass/fail state is in the accessibility tree without reference to colour (SC 1.4.1) |
| NFR-10 | `client` | the live region's content after the run control is activated (SC 4.1.3) |
| NFR-11 | `client` | each control is queryable by role with its expected accessible name (SC 4.1.2) |
| NFR-12 | `server-unit` | the captured Pino line count for a two-case batch |
| NFR-13 | `server-unit` | the scorer's output for the two table-driven perturbations |
| NFR-14 | manual, once | precision before and after the degraded prompt on a real provider — no recorded-response fixture exists to automate it |
| NFR-15 | `server-unit` | `server/test/contracts.test.ts` passes unchanged; `./scripts/check-contracts.sh` exits 0 |
| NFR-16 | `server-unit` | the captured log output does not contain the case's sentinel string |
| NFR-17 | `server-integration` | the queued `jobs` row count for one agent after five bumps |
| — | `e2e web` | nav row → `/eval` → an agent → the Evals tab, surviving a reload, as `e2e/specs/12-eval.flow.json` — slot 11 is taken by `11-project-context.flow.json`. Covers no criterion on its own; it is the smoke path that AC-68, AC-69 and AC-59 are individually asserted for in `client` |

## Open questions

- **OQ-1** — Should the "30 days" filter in `img_2` be real? A range parameter
  means a `since` argument on the dashboard route and a windowed aggregate; the
  index axis of `LineChart` (`charts/LineChart.tsx:31`) cannot represent a time
  window anyway. *Assumption in this spec:* the control is omitted in phase 1 and
  the API answers with the most recent batches (AC-71, AC-108). *Decides:* author.
- **OQ-2** — Is `img_5`'s "Run on save" toggle persisted per case or per session?
  Persisting it means another column. *Assumption in this spec:* client-side state
  only, remembered nowhere. *Decides:* author.
- **OQ-3** — **Resolved (option iii), plan D-1.** `JobRunner`'s 120 s timeout
  will fire on any batch of more than a handful of cases, marking the job
  `failed` while the batch runs on and persists (see *Failure modes*, hop 14).
  Of the three options — raise `timeoutMs` for this kind (the runner takes
  options per instance, not per kind, `platform/jobs.ts:36-43`, so it is a
  container-level change affecting every job), cap the number of cases an
  auto-eval batch runs, or accept the orphaned job row — the author took the
  third, **for manual and auto-eval batches alike**. The `eval_runs` rows are the
  record of what happened, the `jobs` row is not, and AC-92's log line pairing
  the batch id with the failed job id is what reconciles them by hand. No longer
  blocks `approved`.
- **OQ-4** — `img.png` draws five actions on the finding card; this spec ships
  three. The `learn` and `replyToAuthor` strings already exist
  (`client/messages/en/prReview.json:8-11`) and `FindingActionKind` already admits
  both (`contracts/findings.ts:82`). *Assumption in this spec:* they stay unbuilt,
  and the shipped card diverges from the mockup by two buttons. *Decides:* author.
- **OQ-5** — How long does a frozen diff fragment from a customer's private
  repository live in `eval_cases`? Today: forever, and it is re-sent to the
  provider on every batch. Options: unbounded (as specified), a retention window
  after which the case is archived, or an explicit consent step at creation.
  *Assumption in this spec:* unbounded, with the boundary drawn at logging and
  tenancy instead (AC-113, NFR-16). *Decides:* author.
- **OQ-6** — NFR-2's dollar ceiling cannot bind when the configured model is
  unpriced, because `cost_usd` is then `null` rather than a number (R-4;
  `adapters/llm/pricing.ts:49-53`). Options: refuse to start a batch on an
  unpriced model, fall back to a token-count ceiling, or let the ceiling be
  advisory there. *Assumption in this spec:* the ceiling is advisory for an
  unpriced model and AC-41 never fires; the wall-clock ceiling of AC-110 is the
  only limit that still binds. *Decides:* author.
- **OQ-7** — **Resolved: no SSE, plan D-1.** The bus and logger are in-memory and
  keyed by an arbitrary string, so streaming would have worked without an
  `agent_runs` row (R-1) — but it is a second delivery mechanism for a screen
  that can poll. The studio polls `GET /agents/:id/eval-runs` and reads the
  derived batch status (AC-27, AC-66). No longer blocks `approved`.
