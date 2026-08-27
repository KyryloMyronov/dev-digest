---
description: Run the full Spec-Driven-Development pipeline — spec, plan, build, review, a per-finding fix loop, gap tests, close-out. Takes an idea, a spec, extra requirements and design images.
argument-hint: [idea | spec path | SPEC-NN | slug] [--notes "requirements"] [--design a.png,b.png] [--plan path] [--from spec|research|plan|build|review|fix|tests|close] [--exec single|multi] [--tests none|gaps|full] [--max-iter N] [--docs] [--audit] [--no-verify]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent, SendMessage, AskUserQuestion, Skill, TodoWrite
disable-model-invocation: true
---

# /run-plan — the whole chain, one command

Arguments: `$ARGUMENTS`

You are the **main session** driving one feature from an idea to reviewed,
verified, covered code. Read [`.claude/agents/README.md`](../agents/README.md)
once if you have not in this session — every agent contract below is stated
there and is **not** restated here.

Nine stages. Each one ends with an artifact on disk or a decision from the
author; nothing important lives only in scrollback.

| | Stage | Runs | Produces |
|---|---|---|---|
| S0 | Intake | you | resolved inputs, entry stage, state file |
| S1 | Spec | `spec-creator` ×2 + `researcher` ×n | `SPEC-NN-*.md` + index row |
| S2 | Plan | `implementation-planner` ×2 | `specs/plans/*.plan.md`, approved |
| S3 | Build | `implementer` | code + Implementation Report |
| S4 | Review | `architecture-reviewer` ‖ `plan-verifier` + skill checks | the ledger |
| S5 | Fix loop | `implementer` ×≤N, reviewers continued | every row closed or escalated |
| S6 | Tests | `test-writer` | tests for the gaps S4 found |
| S7 | Re-verify | `plan-verifier` (fresh) | the conformance verdict of record |
| S8 | Close-out | you | statuses, follow-ups, the final report |

## Relationship to `/impl`

[`/impl`](impl.md) is the narrow path: a plan already exists on disk, build it,
review it, fix it, stop. `/run-plan --from build` covers the same ground and adds S6–S7.
Keep them consistent: **if you change the fix loop here, change it there.**

## Your write scope

Nothing else, ever:

- `specs/plans/**` — the plan file, its append-only `## Amendments` log, and the
  index row in `specs/plans/README.md`.
- the `Status:` line of the spec this run is building, plus its row in
  `specs/README.md`. **Only** that line and that row — the spec's body is
  `spec-creator`'s, and promoting a status is the author's decision that you
  merely record (S1.6).
- `specs/assets/SPEC-NN/**` — copying in the `--design` images (S1.4).
  `spec-creator` cannot copy a binary; you can.
- the run directory in the scratchpad — the state file and the ledger.

Code is `implementer`'s. Tests are `test-writer`'s. Docs are `doc-writer`'s. The
findings ledger **never** lands in the plan file (`specs/plans/README.md`:
review findings are a scoped fix task, not a plan amendment, unless they change
what the plan asked for).

## S0 — Intake

1. **Create the run directory** — `<scratchpad>/run-plan-<slug>/` — and write
   `state.md`: the arguments verbatim, the entry stage, and, as you go, the spec
   path, the plan path, the S3 baseline ref, the stage last completed, and the
   iteration count. Every `--from` resume reads this file first. A run whose
   directory already exists is a resume: say so and reconcile before touching
   anything.

2. **Classify the first positional argument** and pick the entry stage:

   | It is | Entry | Notes |
   |---|---|---|
   | a path to `specs/**/SPEC-NN-*.md`, a bare `SPEC-NN`, or a slug matching one | **S2** | glob every spec folder: `specs/`, `server/specs/`, `client/specs/`, `reviewer-core/specs/`, `mcp/specs/` |
   | prose describing a feature or a bug | **S1** | this is the idea; `--notes` and `--design` join it |
   | absent, but `--plan` given | **S3** | the `/impl` case |
   | absent and nothing else given | — | stop and ask what to build |

   A slug matching **more than one** spec, or an ambiguous match, stops here and
   asks. Building the wrong spec is worse than one round trip.

3. **Gate the spec you were handed.** Read it whole.
   - `Status: approved` → straight to S2.
   - `Status: draft` with a non-empty *Open questions* → **S1 in amend mode**: the
     open questions are `spec-creator`'s pass-1 questions already written down;
     put them to the author, then run pass 2. Do not plan against an unresolved
     fork.
   - `Status: implemented` / `superseded` / `rejected` → stop. Name what you
     found and ask whether this is a supersede (a new `SPEC-NN`) or the wrong
     path.

4. **`--notes` and `--design` are requirements only in S1.** Past S1 they are
   context. Anything in them the spec does not already cover is one of:
   - a clarification of what the spec says → pass it through, and say so in the
     final report;
   - **new requirement or a design showing an uncovered state** → stop. Either
     the author sends it back through S1 (amend or supersede) or it is dropped.
     Never let a note quietly widen a build past its spec. This is the same rule
     as `/impl` S0.4 and it is the one most likely to be waved through.

5. Resolve the flags. `--exec` overrides the plan's `## Execution` (say so).
   `--tests` defaults to **`gaps`**. `--max-iter` defaults to **3**.
   `--audit` widens S4 from the diff to the tree. `--no-verify` drops
   `plan-verifier` — which also disables `--tests=gaps`, since the gap list comes
   from its matrix; say that out loud rather than silently degrading to `none`.

6. `TodoWrite` one item per stage you will actually run.

---

## S1 — Spec

Skip entirely when S0 routed to S2 or later.

**1.1 — Pass 1, questions only.** `Agent({subagent_type: 'spec-creator'})` with
the idea, `--notes`, the design paths, and the explicit line: *pass 1 —
interview; write nothing.* It returns placement, the `SPEC-NN` it intends to
allocate, design-review findings, questions `Q-1…Q-n`, proposals, and research
commissions `R-1…R-n`.

**1.2 — Commissions, in parallel.** One `researcher` per `R-n`, **all in a single
message** so they actually run concurrently. Each `R-n` is already written in
`researcher`'s input shape; pass it through unedited. A commission that comes
back with an empty *Not established* section is suspicious, not excellent — read
it before you forward it.

Never send an `R-n` to the author and never send a `Q-n` to a `researcher`. The
first asks the author to do research; the second produces a confident report
about a decision nobody has made.

**1.3 — Questions, one round.** Put `Q-1…Q-n` to the author with
`AskUserQuestion` — options and consequences come straight from pass 1. Add the
proposals as their own question (accept / reject each), and add one last
question: *promote the spec to `approved` once written, or show it to you first?*
(default: **show me first**). Do not answer anything on the author's behalf.

**1.4 — Give the designs a home.** Now that `SPEC-NN` is allocated, before pass 2:

```sh
mkdir -p specs/assets/SPEC-NN && cp <each --design file> specs/assets/SPEC-NN/
```

Pass the **new** paths to pass 2 and tell the author you moved them. An
untracked `img*.png` at the repo root makes every citation in the spec
unresolvable within a week — this is the step that prevents it, and no agent can
do it.

**1.5 — Pass 2, write the file.** `SendMessage` to the same `spec-creator`
instance: *pass 2 — write*, carrying the answers, the accepted proposals, the
`researcher` reports, and the asset paths. It writes `SPEC-NN-slug.md` and the
row in `specs/README.md`.

**1.6 — Approve.** Check its report: the index row quoted verbatim, the six
closure counts at zero, every `R-n` either answered or surviving as an `OQ-n`.
Then:
- *Open questions* empty or every entry explicitly deferred → ask the author to
  promote (or use the pre-authorisation from 1.3), and **you** edit the one
  `Status:` line and the index row.
- Anything still blocking → stop. Report what is open. A plan built on an
  unresolved fork is a plan that will be amended mid-build.

Record the spec path in `state.md`.

---

## S2 — Plan

**2.1 — Phase 1.** `Agent({subagent_type: 'implementation-planner'})` with the
spec's **path** (not a paste) and any passed-through `--notes`. It returns a
Requirements Review, findings with severities, recommendations, questions, and
the single- vs multi-agent choice, ending in `STATUS: AWAITING ANSWERS`.

**A `blocking` requirements finding sends the work back to S1.** That is the
whole point of the review — do not plan past it on an assumption.

**2.2 — Research, if it asked.** Open questions tagged for `researcher` get the
same parallel treatment as S1.2, in one message.

**2.3 — Answers.** One `AskUserQuestion` round: the planner's questions, the
recommendations to accept or decline, and the execution mode (`--exec` decides it
if given — say so). A recommendation the author did not accept **must not** appear
in the steps; check that when the plan comes back.

**2.4 — Phase 2.** `SendMessage` with the answers. It returns the Implementation
Plan as text, opening with the metadata header and closing with a `Save to:` line.

**2.5 — Approve and persist.** Show the plan to the author and get an explicit
approval. Then **you** write it to the path on the `Save to:` line, with
`Status: approved`, and add the index row in `specs/plans/README.md`. If that
line says the file already exists, amend via `## Amendments` — never overwrite.

This write is the only reason the folder can claim a human approved everything in
it. Record the plan path in `state.md`.

---

## S3 — Build

**3.1 — Baseline.** Before the first edit, so red can be classified later instead
of argued about:

```sh
git rev-parse --short HEAD && git status --porcelain
diff -rq server/src/vendor/shared client/src/vendor/shared
```

Both go in `state.md`. That ref — **not `main`** — is the diff scope for S4: it is
exactly what this build changed. The second command matters because
`check-contracts.sh --fix` lands *earlier* unmirrored drift along with the change
(root `insights.md:156-176`); measuring it once here means `implementer` does not
have to enumerate it, and nobody mistakes old drift for this build's.

**3.2 — Implement.** `Agent({subagent_type: 'implementer'})` with the plan's
**path**, the passed-through context, the pre-existing drift list, and the
verbatim boundary: *build this plan, do not expand it; anything the plan did not
ask for is a follow-up line in the report.*

- **single-agent** (the plan's default): one `implementer`, every step in order.
- **multi-agent**: one per parallel group in the plan's `## Execution`, launched
  **in one message**. Before you launch, check the groups touch **disjoint
  files**. Two groups on the same file — or both on `vendor/shared/` — are
  serialized, not parallelized. The planner was asked to flag this; enforce it
  even if it did not.

Add one instruction the prompt does not carry: **pass `--reporter=dot --silent`
to every `vitest run`**, and run the full suite once at the end rather than per
step. Default reporter output for 564 tests is most of what a build spends on
verification, and a failure still prints in full under `dot`.

Keep the Implementation Report verbatim in the run directory. It is a **claim**.
S4 is what turns claims into evidence.

---

## S4 — Review round

Both reviewers in **one message**, both read-only, both on Sonnet — quoting a
`file:line` and running a suite does not need Opus, and this round repeats.

| Reviewer | Input | Skipped when |
|---|---|---|
| `architecture-reviewer` | the diff since the S3 ref (the tree, with `--audit`) | never |
| `plan-verifier` | the plan's **path** + the Implementation Report | `--no-verify` |

**4.1 — Check the matrix mechanically before you read it.** Every `Verified` row
must cite either a `path:line` or quoted command output. A `Verified` on a bare
sentence is the known failure mode of the smaller model
(`.claude/agents/README.md`, `plan-verifier` §Model) — grep the report, and send
those rows back to the same instance rather than accepting them.

**4.2 — Skill checks, main thread, only what the diff earns:**

| The diff touches | Run |
|---|---|
| `server/src/vendor/shared/**` or `client/src/vendor/shared/**` | `api-response-changes`, `response-schema`, and `./scripts/check-contracts.sh` if no reviewer quoted it |
| `server/src/modules/**/routes.ts`, `server/src/modules/index.ts` | `api-breaking-changes` |
| auth, input handling, uploads, secrets, or anything reading a PR diff / clone / model output | `security` |
| none of the above | nothing — say so; do not run them for completeness |

---

## S5 — Fix loop

**This is the stage the command exists for.** A review nobody acts on cost the
tokens and bought a list. The loop is **per finding**, not per iteration: a row
carries its own state and its own attempt count, so nothing quietly survives a
round.

**5.1 — The ledger.** `<run dir>/findings.md`, written and updated by you, never
in the plan file. One row per finding, deduplicated across sources by
`file:line` + claim — one boundary crossed in three places is one row with three
locations; the same defect found by both reviewers is one row with two sources.

| id | Source | `file:line` | Claim | Severity / verdict | Conf. | Disposition | Att. | State |
|---|---|---|---|---|---|---|---|---|

- **Severity / verdict** comes through unchanged: `blocking` / `nit` /
  `pre-existing` from the architecture review; `Verified` / `Partial` /
  `Not implemented` / `Contradicted` / `Unknown` per plan item; the skill checks'
  own severities.
- **Disposition** — `fix now` · `defer → follow-up` · `reject (+ reason)` ·
  `needs plan amendment`.
- **State** — `open` → `assigned` → `claimed` → `closed`, or
  `not-attempted` / `regressed` / `stuck` / `deferred` / `rejected`.
- **Att.** — how many `implementer` attempts this row has had. Not the iteration
  number.

**5.2 — Triage, one round, author decides.** Present the ledger with a proposed
disposition per row and settle it in one `AskUserQuestion`. Defaults you propose:

`blocking` → fix now · `Not implemented` / `Contradicted` → fix now ·
`Partial` → fix now if it is an AC, follow-up if it is a nicety ·
`Unknown` → run the suite that would settle it, then re-triage (an `Unknown` that
survives becomes S6's input, not a fix) · `nit` → follow-up ·
`pre-existing` → reject, out of this build's scope.

**5.3 — Fix.** One `implementer` per iteration — not one per row — handed **only
the `fix now` rows**, never the plan again. Verbatim boundary: *fix exactly these
findings; do not refactor around them; if a fix would change what the plan asked
for, stop and report it instead of doing it.* Promoted nits ride along in the same
iteration; nothing else does. Mark those rows `assigned`, then `claimed` when the
report comes back.

**5.4 — Cheap check before you pay for a re-review.** For every `claimed` row:

```sh
git diff --stat <S3 ref>..HEAD -- <the row's file>
```

A row whose file the iteration never touched is `not-attempted`, not disputed —
send it straight back with that fact, and do not spend a reviewer on it. This
costs nothing and catches the most common failure in the loop.

**5.5 — Re-review, per row.**

- **Iterations 1 … N-1:** `SendMessage` to the **same** reviewer instances with
  the fix diff and the row ids. They hold their own findings, so they answer per
  row — `resolved` / `unresolved` / `regressed` — cheaply and precisely. Update
  the state column from their answer, never from the Implementation Report.
- **Final iteration:** spawn a **fresh** `architecture-reviewer` **and** a fresh
  `plan-verifier` on the whole build's diff (S3 ref → HEAD). Continued instances
  are anchored on their own first reading; the fresh pair is the one allowed to
  say "still wrong" about something nobody looked at. Both, not just the
  reviewer — the false-success research in `plan-verifier`'s own prompt applies to
  a continued verifier as much as to an implementer.

**5.6 — Regressions are not deferred.** Any row that comes back `regressed`, and
any lane that was green at S3.1 and is red now, is `fix now` regardless of
severity, and it does not consume an iteration's judgement — it is a defect this
loop introduced.

**5.7 — Amendments.** A `needs plan amendment` row never goes to `implementer`.
**You** append to the plan's `## Amendments` — the date, the step it voids or
changes, the evidence at `path:line`, and `Approved by the author` — then
continue. Never rewrite a step above the log; the log is the diff.

**5.8 — Exits.**

- **Clean** — no `open`/`assigned`/`claimed` row left with disposition `fix now`,
  `blocking = 0`, no `Not implemented` or `Contradicted`. Deferred rows and
  follow-ups do not block the exit; they go to the report.
- **Repeat guard** — a row at `Att. = 2` still not `closed` becomes `stuck` and
  **stops the loop immediately**. A third attempt on the same row is how a
  session burns an hour.
- **Limit** — at `--max-iter` with `fix now` rows alive, stop and ask
  (`AskUserQuestion`): *one more iteration* · *accept as known debt with a named
  follow-up* · *amend the plan* · *abandon the build*. Never loop past the limit
  on your own judgement.

Write the ledger to disk after every iteration. `--from fix` resumes from it.

---

## S6 — Tests

`--tests none` skips this. Say so in the report; never let it read as "covered".

**`gaps` (default)** — `test-writer`'s task is **not** "cover the feature". It is
the explicit list of what nobody can currently observe, assembled by you:

1. every `plan-verifier` row still `Unknown` or `Partial` after S5;
2. every row in the spec's *Verification* table with no artifact behind it;
3. any `blocking` finding that was fixed with no test pinning the fix.

Hand it that list, each item with the AC id and the suite the spec named. This is
what keeps the stage cheap and traceable — and it closes a loop that is otherwise
open, where the verifier says "no test observes this" and nobody acts on it.

**`full`** — the feature as a whole. Expensive; ask for it deliberately.

Then:

- Its `Blocked / needs a production change` rows enter the **ledger** as new
  findings and go through 5.2. A missing next-intl key, an untestable seam, a
  missing route — those are product gaps, and `test-writer` is correct to refuse
  them.
- A `regression` in its four-way classification is a hard stop, not a follow-up.
- A new `*.it.test.ts` it could not execute makes the stage `Partial`. Docker
  being absent is an environment result; record which coverage is therefore
  unproven.

---

## S7 — Re-verify

Skipped with `--no-verify`, and skipped when S6 wrote nothing and S5 exited clean
on its fresh pass — say which.

Otherwise `SendMessage` to the S5.5 fresh `plan-verifier` with the new tests and
the closed rows, and take **its** verdict as the verdict of record. S6 changed the
evidence base; a matrix from before the tests existed is stale, and the plan's
status in S8 turns on this verdict.

---

## S8 — Close-out

1. `/pr-self-review` on the full change set — it routes the diff to the skills per
   file and runs this repo's invariants. The last cheap net before a PR.
2. **Plan status.** `Status: delivered` **only** on `Verified success`.
   `Partial success` leaves it `approved` — that is `specs/plans/README.md`'s
   rule, not yours to soften. Update the index row either way.
3. **Spec status.** `implemented` is the **author's** call. Ask, and say which ACs
   are observable today and which are not. Never promote it yourself.
4. `--docs` → `doc-writer` with the plan and the Implementation Report.
5. `/engineering-insights` if the run hit anything non-obvious. Writing nothing is
   the normal outcome, not a failure.
6. Leave the run directory in place — the ledger is the record of what was
   rejected and why, and that is the question asked three weeks later.
7. **Report** (this is your final message):

```markdown
## SDD run: <feature>
Spec: <path> · <status> | Plan: <path> · <status> | Diff: <S3 ref>..HEAD

**Spec** — SPEC-NN, questions asked/answered, commissions run, open questions left.
**Plan** — steps, execution mode, amendments appended and why.
**Delivered** — steps completed, by plan step id.
**Verification** — real quoted output per suite, with skip counts. A suite not run is "not run", never "passed".
**Review** — findings by source: found / fixed / deferred / rejected / stuck. Iterations used (N of M).
**Tests** — mode used, gaps closed, gaps left open with the AC id.
**Not done** — every uncovered AC from the spec's Verification table, named.
**Follow-ups** — one line each, owner named.
```

---

## Token discipline — why this shape

Every one of these is a deliberate trade. If you deviate, say so in the report.

- Both reviewers on Sonnet; `implementer` and the two authoring agents stay Opus
  — the spec and the build are what everything downstream inherits.
- Research commissions and multi-agent build groups launch **in one message**.
  Sequential fan-out costs wall-clock for nothing.
- Review scoped to **this build's diff**, never the tree, unless `--audit`.
- Skill checks routed by touched path, not run as a set.
- Re-review is a `SendMessage` continuation for all but the last iteration.
- One fresh reviewer pair, once, at the end — the anti-rubber-stamp pass.
- One `implementer` per fix iteration, never per row.
- `--tests=gaps` by default: `test-writer` is Opus and its cost scales with the
  surface it is asked to cover, so it is pointed at a list, not at a feature.
- `--reporter=dot --silent` on every suite run, and the full suite once per stage
  rather than once per step.
- `5.4` spends a `git diff --stat` to avoid spending a reviewer.
