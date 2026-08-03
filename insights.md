# root — insights

Cross-cutting only: `scripts/`, `docs/`, `.github/`, root configs, and fixes
that span two packages. Anything belonging to one package goes in that
package's own `insights.md`.

Append-only log of things that cost real time. Newest first. One entry per
gotcha; if it becomes a rule everyone must follow, promote it to `CLAUDE.md` and
leave the entry here as the explanation.

Format: `## YYYY-MM-DD — one-line title` then symptom → cause → fix.

Entries also carry `**Rubric:**` — one of: What Works · What Doesn't Work ·
Codebase Patterns · Tool & Library Notes · Recurring Errors & Fixes ·
Session Notes · Open Questions. Find one with
`grep -n '^\*\*Rubric:\*\* Open Questions' insights.md`. Written by the
`engineering-insights` skill; see `.claude/skills/engineering-insights/`.

---

## 2026-08-02 — the configured skills get skipped when repo patterns are easy to copy

**Rubric:** Session Notes
**Symptom:** a full-stack feature (contract → migration → repo → route → three
screens → tests) shipped without a single `Skill` invocation, even though this
repo configures skills that map directly onto every one of those steps. Nothing
broke; the work just didn't get the benefit.
**Cause:** each package's existing code answers "how do we do this here?" well
enough that copying the neighbouring pattern always feels sufficient, and no
step ever announces itself as the moment to reach for a skill.
**Fix:** the mapping worth remembering, since `CLAUDE.md` lists these per
package but not per task:

| Doing | Skill |
|---|---|
| touching `db/schema/**` or generating a migration | `drizzle-orm-patterns`, `postgresql-table-design` |
| editing `vendor/shared/contracts/**` | `zod` |
| a route/plugin under `src/modules/**` | `fastify-best-practices` |
| any `*.test.tsx` | `react-testing-library` |
| any component or hook | `react-best-practices`, `next-best-practices` |
| a chart | `dataviz` |

Copying the adjacent pattern reproduces whatever the adjacent pattern already
got wrong. The skill is the second opinion the repo can't give you.

## 2026-08-03 — a new field on `PrMeta` must be `.nullish()`, whatever it means

**Rubric:** Codebase Patterns
**Symptom:** adding a plainly-required field to `PrMeta`
(`vendor/shared/contracts/platform.ts`) breaks two call sites that have nothing
to do with the feature — the GitHub adapter stops typechecking, and the
`/pulls/:id` detail handler starts demanding a value it cannot compute.
**Cause:** `PrMeta` is triple-duty. It is (1) the list-row payload of
`GET /repos/:id/pulls`, (2) the return type of
`GitHubClient.listPullRequests()` (`vendor/shared/adapters.ts`), which maps
GitHub's PR-list JSON and knows nothing about our reviews, and (3) the base that
`PrDetail` extends, served by a handler that never runs the list's aggregate
queries. Anything computed from *our* tables therefore cannot be required.
`score` and `cost_usd` were already nullish for this reason, not only because
their values are semantically optional — and `findings` (the per-severity
counters, added 2026-08-03) joins them.
**Fix:** declare list-only fields `.nullish()` and comment them
`(list endpoint only)`, as the neighbours do. Then mirror the file into
`client/src/vendor/shared/contracts/platform.ts` — `cp` it, the two are meant to
stay byte-identical, and `diff -q` them before you finish. A `null` that means
"we never computed this here" is not the same fact as the domain's own null, so
resolve the display default at the UI (the findings cell renders a missing
breakdown as `0/0/0`; the score cell renders it as `—`), never in the contract.

## 2026-08-02 — LLM cost: `null` and `0` are different facts, keep them apart

**Rubric:** Codebase Patterns
**Symptom:** the obvious ways to render a run's dollar cost — `cost ?? 0`, or
`usd.toFixed(2)` — silently destroy information, and it isn't visible in
testing unless you happen to pick the right model.
**Cause:** two independent traps meet here. (1) `estimateCost`
(`server/src/adapters/llm/pricing.ts`) returns `null` for a model that isn't in
the table, but `z-ai/glm-4.7-flash` is listed at a real price of **0** — so
"free" and "unknown" are distinct states that both look falsy. (2) a chunked
review on a cheap OpenRouter model costs a fraction of a cent, so two decimal
places renders nearly every genuine run as `$0.00`. An earlier version of this
feature shipped with `toFixed(2)` and was useless for exactly that reason.
**Fix:** keep the column nullable end-to-end (`agent_runs.cost_usd` is
`double precision` NULL; `RunStats`/`RunSummary`/`PrMeta` carry
`cost_usd: number | null`) and never coalesce to 0. Format through
`client/src/lib/format-cost.ts`, which takes the placeholder as an argument
because only the call site knows whether `null` means "nothing ran yet" (`—`)
or "model not priced" (`n/a`). Precision follows magnitude: 2 dp at or above a
cent, 4 dp below, `<$0.0001` under that, and `$0.00` reserved for a true zero.
Same rule applies to the other `cost_usd` columns already declared for
eval/CI/observability.

## 2026-08-02 — bash `${1:?msg}` truncates at a `}` inside the message

**Rubric:** Tool & Library Notes
**Symptom:** a shell script whose only oddity was
`mode=${1:?usage: guard.sh {snapshot|verify} <file>}` printed
`line 13: file: No such file or directory` twice per run while otherwise
working — so the errors read as cosmetic and unrelated.
**Cause:** parameter expansion ends at the first unescaped `}`, which here is the
one inside `{snapshot|verify}`, not the one closing the expansion. The leftover
` <file>}` is then parsed as a redirect from a file literally named `file`.
**Fix:** keep `}` out of `${var:?…}` messages — use a `usage()` function plus an
explicit `[ $# -eq 2 ] || usage`. The same trap applies to `${var:-…}` and
`${var:+…}`.
