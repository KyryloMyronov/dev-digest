# `specs/plans/` — Implementation Plans

The persisted output of the
[`implementation-planner`](../../.claude/agents/implementation-planner.md) agent.

A specification says *what* gets built and why. A plan says *how*, *in what
order*, *by whom*, and *how it is proven*. Both are contracts, and both outlive
the chat they were written in — which is the whole reason this folder exists.

## Why the plan is a file

`implementation-planner` returns the plan as text, `implementer` usually runs in
a **fresh session**, and `plan-verifier` refuses to work without the plan
(conformance without a contract is not conformance). Left in chat scrollback the
plan has to be copy-pasted across every one of those boundaries, and whatever
gets pasted is unverifiable afterwards.

As a file it gives four things the chat cannot:

- a stable handoff to a new session — `implementer` is told a path, not a wall of text;
- the contract `plan-verifier` checks against, byte-identical to the one that was approved;
- traceability `SPEC-NN AC-n → plan step → code`, readable months later;
- a diff when the plan is amended mid-build, instead of a silently different plan.

## Who writes here

| | |
|---|---|
| **Writes** | the **main session**, after the author approves the plan |
| **Never writes** | every subagent. `implementation-planner` has no write tool at all; `implementer`, `test-writer` and `doc-writer` are out of scope here; `spec-creator` may write `SPEC-NN` files in `specs/` and in each package's `specs/`, but **never** `specs/plans/**` — a `PreToolUse` hook refuses it by path |
| **Reads** | `implementer` (its contract), `plan-verifier` (its checklist), `architecture-reviewer` and `doc-writer` (context) |

The split is deliberate: the agent that plans cannot persist its own plan, so
the file only ever exists because a human approved it.

## Naming

| Case | File |
|---|---|
| Plan derived from a spec | `SPEC-NN-<same-slug-as-the-spec>.plan.md` |
| Plan from an unambiguous request, no spec | `TASK-<kebab-slug>.plan.md` |

The spec-derived name carries the spec's own number and slug, so the pair is
obvious from `ls`. There is no separate plan numbering to keep in sync, and this
folder does **not** take part in `SPEC-NN` allocation — that glob only scans
`specs/` itself.

## Metadata header

Every plan file opens with the title and this block, in this order:

```markdown
# Implementation Plan: <the task>

Spec: SPEC-07-blast-radius.md
Status: approved
Execution: single-agent
Approved: 2026-08-26
```

- **Spec** — the file in `specs/`, or `— (no spec: <the request, one line>)`.
- **Status** — see the lifecycle below.
- **Execution** — `single-agent` or `multi-agent`, matching the plan's own
  `## Execution` section and the mode the author actually chose.
- **Approved** — the date the author approved it, `YYYY-MM-DD`.

The section list below the header belongs to
[`implementation-planner`](../../.claude/agents/implementation-planner.md) — its
phase-2 skeleton is the authority, and it is not restated here so the two cannot
drift.

## Status lifecycle

| Status | Means |
|---|---|
| `approved` | The author approved it; `implementer` may start. A plan is never saved in any other state — an unapproved plan stays in chat. |
| `delivered` | `plan-verifier` returned `Verified success` against it. |
| `abandoned` | The build was dropped or the plan was replaced wholesale. Say why in one line under the header; keep the file. |

`Partial success` from `plan-verifier` is **not** `delivered`. The plan stays
`approved` until the gaps close or the author abandons it.

## Amending a plan mid-build

A plan that reality invalidated is amended in place, never silently diverged
from. Append to the bottom of the same file:

```markdown
## Amendments

### 2026-08-27 — step 4 dropped
`repo_snapshots` already carries the column (`server/src/db/schema/repos.ts:44`),
so the migration step is void. Approved by the author.
```

One file, appended in place, because `plan-verifier` verifies against one
contract — a chain of superseding files would make it read several and guess
which one holds. Never rewrite a step above the amendment log: the log is what
makes the change visible in a diff.

Review findings are a different thing and do **not** belong here. An
`architecture-reviewer` or `plan-verifier` finding becomes a scoped fix task for
`implementer`; it amends the plan only when it changes what the plan asked for.

## Index

| Plan | Spec | Status | Execution |
|---|---|---|---|
| [SPEC-01-project-context.plan.md](SPEC-01-project-context.plan.md) | [SPEC-01](../SPEC-01-project-context.md) | `delivered` | `single-agent` |
| [SPEC-02-pr-brief.plan.md](SPEC-02-pr-brief.plan.md) | [SPEC-02](../SPEC-02-pr-brief.md) | `approved` | `single-agent` |
| [SPEC-03-reviewer-ordered-diff.plan.md](SPEC-03-reviewer-ordered-diff.plan.md) | [SPEC-03](../SPEC-03-reviewer-ordered-diff.md) | `delivered` | `single-agent` |
