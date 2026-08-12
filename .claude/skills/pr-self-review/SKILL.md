---
name: pr-self-review
description: "Self-review every open change before opening a pull request. Collects the full changeset (committed + staged + unstaged + untracked), routes each file to the skills that apply to it, runs this repo's own invariants, and reports a verdict. Use before `gh pr create`, before pushing a branch, or whenever asked to review local changes prior to a PR. Stage 1 is deterministic only; skill-driven review of the diff is stage 2."
version: 0.1.0
---

# PR Self Review

A gate that runs against **local, unmerged work** — not against an existing PR.
For reviewing a PR that already exists, use `/code-review`.

Full design, staging and rationale: [`docs/pr-self-review-plan.md`](../../../docs/pr-self-review-plan.md).

## What exists today (stage 1)

Deterministic half only. One command:

```sh
node .claude/skills/pr-self-review/report.mjs          # human summary
node .claude/skills/pr-self-review/report.mjs --json   # machine readable
```

It writes `.pr-self-review/report.md` and `.pr-self-review/changeset.json`
(gitignored) and **blocks nothing yet**. Blocking arrives in stage 3, once the
severity model has been calibrated against real branches.

| Phase | File | Does |
|---|---|---|
| 1 collect | `collect.mjs` | full changeset vs the base branch |
| 2 route | `routing.mjs` | file → skills, plus the coverage report |
| 3b invariants | `invariants.mjs` | this repo's own rules — see [`repo-invariants.md`](repo-invariants.md) |
| report | `report.mjs` | verdict, findings, coverage |

## Running it

1. Run `report.mjs`. Read `.pr-self-review/report.md`.
2. Fix every `critical`. They are the block conditions in stage 3.
3. Run the package commands the report suggests (`typecheck`, `test`,
   `lint:arch`) for the packages the changeset touches — stage 1 lists them,
   stage 2 runs them.
4. If a file shows up under **Files with no domain skill** and the pattern will
   recur, add a rule to `routing.mjs`. That section is the routing table's
   to-do list.

## Reading the coverage report

The point of the coverage section is that routing is **visible**. A skill with
0 files did not run. A file with no domain skill got only `typescript-expert`
and `security`. Both are facts worth knowing before you trust a green verdict.

## Not yet built

Stage 2 adds diff-scoped review driven by the routed skills, incremental
caching by content hash, and `// pr-self-review-ignore:` waivers.
Stage 3 adds `gate.sh` and the PreToolUse hook that blocks `gh pr create`.
Stages 4–5 add the `pre-push` hook and a CI required check.

Until stage 3 lands, a green verdict here is **advice, not a gate**.

## Extending it

- **New routing rule** → `routing.mjs` (`RULES`), then `node routing.mjs` to
  print the table. `routing.md` explains the policy; it deliberately does not
  copy the table.
- **New invariant** → a check in `invariants.mjs`, registered in `CHECKS`, and
  a row in `repo-invariants.md` explaining *why it breaks this repo*. A check
  that cannot explain its blast radius does not belong here.
- **Before adding an invariant, look for a script that already does it.** The
  contract-mirror check delegates to `./scripts/check-contracts.sh` because an
  earlier hand-rolled version produced five false positives on its first real
  branch.
