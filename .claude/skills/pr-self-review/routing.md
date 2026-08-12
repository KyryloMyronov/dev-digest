# Routing policy

How a changed file gets matched to the skills that should review it.

**The table itself lives in [`routing.mjs`](routing.mjs) (`RULES`).** It is not
copied here on purpose — two copies of a routing table means one stale copy.
Print the current table with:

```sh
node .claude/skills/pr-self-review/routing.mjs
```

## Rules

A rule is `{ id, match, skills, exclude?, docs?, checks?, universal?, why }`.

- **Every matching rule contributes.** Order is irrelevant; the result is the
  union. A React page under `client/src/app/` legitimately collects three
  skills, and one file may also pull in `zod` and `security`.
- **`match` and `exclude` are globs** — `**`, `*`, `?`. No brace expansion, so
  patterns stay greppable. Write two entries instead of `{a,b}`.
- **`universal: true`** marks the catch-alls (`typescript-expert`, `security`).
  They apply almost everywhere and so tell you nothing about a file. Coverage
  counts a file as *uncovered* when only universal rules matched it.
- **`docs`** routes to prose when no skill exists (`e2e/AGENTS.md`,
  `TESTING.md`). A rule with neither skills nor docs — like `prose` — exists to
  say *deliberately nothing applies here*, so markdown stops registering as a
  gap.
- **`checks`** names a deterministic script the changeset makes mandatory. The
  contracts rule pulls in `./scripts/check-contracts.sh`.

## The coverage report is the to-do list

Every run prints which skills got which files, and which files matched only
the universal rules. That second list is how the table grows: when a pattern
recurs there, add a rule.

This is not theoretical. The first run against a real branch put 38 files in
that list, which is how `server/src/modules/**` (module internals beyond
`routes.ts`/`service.ts`), `server/src/platform/**` (the composition root),
`client/src/lib/**` and `server/test/**` all got rules. Adding them took the
list from 38 files to 8.

A skill showing **0 files** matters just as much: it did not run. If you
expected it to, the rule is wrong.

## Adding a rule

1. Add the entry to `RULES` in `routing.mjs`, with a `why` that says what the
   skill actually checks for that path — not just the path's name.
2. Re-run the report and confirm the file count moved the way you expected.
3. If the rule names a skill that is not installed, the coverage report warns.
   Routing to a skill nobody has is a silent no-op otherwise.

## What routing does *not* decide

Severity. A skill finding is graded by [`severity.md`](severity.md) (stage 2),
not by which rule matched. Routing only answers *who reviews this file*.
