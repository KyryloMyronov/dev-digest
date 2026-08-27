---
description: Build an approved Implementation Plan end to end — implementer, one review round, a bounded fix loop, close-out. Spec and plan must already exist.
argument-hint: [plan path or slug] [--notes "extra requirements"] [--design a.png,b.png] [--from build|review|fix|close] [--max-iter N] [--exec single|multi] [--docs] [--no-verify] [--audit]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent, SendMessage, AskUserQuestion, Skill, TodoWrite
disable-model-invocation: true
---

# /impl — build an approved plan

Arguments: `$ARGUMENTS`

You are the **main session** driving one build of an **already approved**
Implementation Plan under [`specs/plans/`](../../specs/plans/README.md). Read
[`.claude/agents/README.md`](../agents/README.md) once if you have not in this
session — the agent contracts below are stated there and are not restated here.

**Narrower than [`/run-plan`](run-plan.md) on purpose.** `/run-plan` runs the whole chain from
an idea or a spec and adds a gap-tests stage; this command starts at an approved
plan file and stops after close-out. `/run-plan --from build` covers the same ground.
The review round and the fix loop are the same protocol in both files — **change
one, change the other.**

## Not in this command — deliberately

| Stage | Who runs it | Why it is out |
|---|---|---|
| Writing the spec | the author, manually: the `spec-creator` agent | it interviews across two passes; it is its own session |
| Producing the plan | the author, manually: `implementation-planner` (two-phase) + the main session saving the file | approval is a human step and must not be buried inside a build |
| Writing tests as a task of their own | **nobody — `test-writer` is switched off here** | token budget. Coverage gaps are *reported* as follow-ups, never silently dropped. Tests a plan step explicitly orders are still written by `implementer`, as part of that step |
| `doc-writer` | opt-in, `--docs` | same reason |

So: **no spec is written, no plan is written, no plan is approved here.** If the
plan file does not exist or is not `Status: approved`, this command stops.

## Your write scope

`specs/plans/**` only — the status line of the plan you are building, its
append-only `## Amendments` log, and the index row in `specs/plans/README.md`.
Plus the session scratchpad for the findings ledger. Nothing else: code is
`implementer`'s, docs are `doc-writer`'s, and the review findings ledger must
**not** land in the plan file (`specs/plans/README.md`: review findings are a
scoped fix task, not a plan amendment, unless they change what the plan asked
for).

## S0 — Intake

1. **Resolve the plan.**
   - a path in `$ARGUMENTS` → use it;
   - a bare slug → match `specs/plans/*<slug>*.plan.md`;
   - nothing → `grep -l 'Status: approved' specs/plans/*.plan.md`. **Exactly one
     match** is used and declared as inferred in your first line. Zero, several,
     or an uncertain match → stop and ask which plan. Building the wrong plan is
     worse than asking.
2. **Read it whole**, `## Amendments` included — an amendment overrides the step
   it names. Then read the spec it names in its header (the AC ids and the
   *Verification* table become the follow-up list at S5). Never build from
   scrollback.
3. **Gate:** `Status:` must be `approved`. Anything else (`delivered`,
   `abandoned`, missing) → stop, say what you found, and point at
   `implementation-planner` for a plan or at the author for the status.
4. **`--notes` and `--design` are context, not new requirements.** Anything in
   them that the plan does not already ask for is one of:
   - a clarification of an existing step → pass it through to `implementer`, and
     say so in the final report;
   - a change to what the plan asked for → **stop.** Either the author approves
     an amendment (you append it to `## Amendments`, dated, one line of why) or
     the work goes back to `implementation-planner`. Never let a note quietly
     widen the build.
5. Resolve the flags: `--exec` overrides the plan's `## Execution` section (say
   so if it does); `--from` skips straight to a stage; `--max-iter` defaults to
   **3**; `--no-verify` drops `plan-verifier`; `--audit` widens the architecture
   review from the diff to the tree.
6. `TodoWrite` one item per stage below, so a long run stays legible.

## S1 — Baseline

Record, before the first edit, so red can be classified later instead of argued
about:

```sh
git rev-parse --short HEAD && git status --porcelain
```

Note the ref in the ledger. That ref — not `main` — is the diff scope for the
review round: it is exactly what this build changed.

## S2 — Build

`Agent({subagent_type: 'implementer'})` with **the plan's path**, the resolved
`--notes`/`--design` context, and the explicit boundary: *build this plan, do not
expand it; anything the plan did not ask for is a follow-up line in the report.*

- **single-agent** (the plan's default): one `implementer`, all steps in order.
- **multi-agent**: one `implementer` per parallel group named in the plan's
  `## Execution`, launched in **one message** so they actually run concurrently.
  Before you launch: check the groups touch **disjoint files**. Two groups on the
  same file — or both on `vendor/shared/` — are serialized, not parallelized.
  This is the rule the planner was asked to flag; enforce it even if it did not.

Keep its **Implementation Report** verbatim in the ledger. It is a *claim*, not
evidence — that distinction is what S3 exists for.

## S3 — Review round (one message, in parallel)

| Reviewer | Input | Skipped when |
|---|---|---|
| `architecture-reviewer` | the diff since the S1 ref (or the tree, with `--audit`) | never |
| `plan-verifier` | the plan's **path** + the Implementation Report | `--no-verify` |

Both are read-only and both run on **Sonnet** — quoting a `file:line` and
running a suite does not need Opus, and this round runs once per iteration.

Then, in the main thread, run **only** the skill checks the diff actually earns:

| The diff touches | Run |
|---|---|
| `server/src/vendor/shared/**` or `client/src/vendor/shared/**` | `api-response-changes`, `response-schema`, and `./scripts/check-contracts.sh` if the reviewer did not already quote it |
| `server/src/modules/**/routes.ts`, `server/src/modules/index.ts` | `api-breaking-changes` |
| auth, input handling, uploads, secrets, or anything reading a PR diff / clone / model output | `security` |
| nothing of the above | none — say so, do not run them for completeness |

## S4 — Fix loop (bounded, ≤ `--max-iter`, default 3)

This is the stage the command exists for. A review that nobody acts on is worse
than no review: it costs the tokens and buys a list.

**4.1 Ledger.** Merge everything into one numbered table in the scratchpad — not
in the plan file:

| # | Source | `file:line` | Severity / verdict | Confidence | Disposition |
|---|---|---|---|---|---|

Severities come through unchanged: `blocking` / `nit` / `pre-existing` from the
architecture review; `Verified` / `Partial` / `Not implemented` / `Contradicted`
/ `Unknown` per plan item. Disposition is one of **`fix now`** ·
**`defer → follow-up`** · **`reject (+ reason)`** · **`needs plan amendment`**.

**4.2 Triage — gate, ask the author.** Present the ledger with your proposed
disposition per row and get a decision in one `AskUserQuestion` round.
Defaults you propose, unless the author says otherwise:
`blocking` → fix now · `Not implemented` / `Contradicted` → fix now ·
`Unknown` → run the suite that would settle it, then re-triage ·
`Partial` → fix now if it is an AC, follow-up if it is a nicety ·
`nit` → follow-up · `pre-existing` → reject, out of this build's scope.

**4.3 Fix.** One `implementer` per iteration, handed **the `fix now` rows only**
— not the plan again. Verbatim boundary in the prompt: *fix exactly these
findings; do not refactor around them; if a fix would change what the plan asked
for, stop and report it instead of doing it.* Nits the author promoted ride along
in the same iteration; nothing else does.

**4.4 Amendment path.** A `needs plan amendment` row does not go to
`implementer`. **You** append to the plan's `## Amendments` — date, the step it
voids or changes, the evidence at `path:line`, and `Approved by the author` —
then continue. Never rewrite a step above the log; the log is the diff.

**4.5 Re-review.** Do not re-run the full round.

- **Iterations 1–2:** `SendMessage` to the *same* reviewer instances with the fix
  diff. They hold their own findings, so they answer per row —
  `resolved` / `unresolved` / `regressed` — cheaply and precisely.
- **Final iteration:** spawn a **fresh** `architecture-reviewer` on the whole
  build's diff (S1 ref → HEAD). The continued instance is anchored on its own
  earlier reading; the fresh one is the pass that is allowed to say "still wrong"
  about something the first one never looked at.

**4.6 Exit conditions.**

- **Clean:** `blocking = 0` and no `Not implemented` / `Contradicted` left.
  Deferred nits and follow-ups do not block the exit — they go to the report.
- **Repeat guard:** a finding that survives **two** fix attempts stops the loop
  immediately. A third attempt on the same row is how a session burns an hour;
  it goes to the author instead.
- **Limit reached:** at `--max-iter` with blocking findings alive, stop and ask
  (`AskUserQuestion`): *one more iteration* · *accept as known debt with a named
  follow-up* · *amend the plan* · *abandon the build*. Never loop past the limit
  on your own judgement.

## S5 — Close-out

1. `/pr-self-review` on the full change set — it routes the diff to the skills
   per file and runs this repo's invariants. This is the last cheap net.
2. **Plan status.** `Status: delivered` **only** if `plan-verifier` returned
   `Verified success`. `Partial success` leaves it `approved` — that rule is
   `specs/plans/README.md`'s, not yours to soften. Update the index row in
   `specs/plans/README.md` either way.
3. **Spec status.** `implemented` is the **author's** call — ask, and say which
   ACs are actually observable today. Never promote it yourself.
4. `--docs` → `doc-writer` with the plan and the Implementation Report.
5. `/engineering-insights` if the session hit anything non-obvious. Writing
   nothing is the normal outcome.
6. **Report** (this is your final message):

```markdown
## Build: <plan file>
Plan: <path> · Status now: approved | delivered · Diff: <S1 ref>..HEAD

**Delivered** — steps completed, with the plan step ids.
**Verification** — real command output, quoted, per suite. A suite not run is "not run", never "passed".
**Review** — findings found / fixed / deferred / rejected, iterations used (N of M).
**Amendments** — what was appended to the plan, and why.
**Not done** — including, always, "tests written by test-writer: none — this command excludes it", plus every uncovered AC from the spec's Verification table.
**Follow-ups** — one line each, owner named.
```

## Token discipline — why this shape

Every one of these is a deliberate trade, not an oversight; if you deviate, say
so in the report.

- `test-writer` off; `doc-writer` opt-in.
- Both reviewers on Sonnet; `implementer` stays Opus — the build is what
  everything downstream inherits.
- Review scoped to **this build's diff**, never the tree, unless `--audit`.
- Skill checks routed by touched paths, not run as a set.
- Re-review is a `SendMessage` continuation, not a fresh full review, for the
  first two iterations.
- One fresh reviewer, once, at the end — the anti-rubber-stamp pass.
