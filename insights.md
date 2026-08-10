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

## 2026-08-08 — a product skill must NOT be wrapped in `<untrusted>`, and that is the point

**Rubric:** What Doesn't Work
**Symptom:** the obvious hardening for the skills feature — send an imported
skill's body through `wrapUntrusted()` like the diff and the PR description —
produces a skill that is attached, visible in the run trace's prompt-assembly
section, counted in the token total, and has **zero** effect on the review. It
looks completely wired. Nothing errors.
**Cause:** `INJECTION_GUARD` (`reviewer-core/src/prompt.ts:16`) is appended to
every agent's system message and states that everything inside
`<untrusted>…</untrusted>` is DATA, never instructions, in any language. A skill
*is* instructions — that is its entire purpose — so the guard and the wrapper
cancel it out. The two mechanisms are not composable: one exists to neuter
instructions, the other to deliver them.
**Fix:** skill bodies go into `## Skills / rules` as instructions,
**undelimited**. Containment is replaced by provenance + consent:
`skillPromptBlock()` (`server/src/modules/_shared/skills.ts`) heads each block
with the skill's name, type, version and — for `source` in
`{imported_url, community}` — a literal `source: imported` marker, and the
import flow parses in the browser, previews the full body, and writes nothing
until the user accepts (`client/src/lib/skill-import.ts`). Two tests pin this so
the "hardening" cannot be reintroduced silently:
`server/test/skills-helpers.test.ts` ("does NOT wrap the body in `<untrusted>`")
and `server/test/skills-prompt.it.test.ts`. Rationale for readers:
`docs/agent-prompts/README.md` and `docs/skills/README.md`. The general lesson:
before reusing an injection defence on a new input, check whether that input is
supposed to *be* an instruction — if it is, the defence is a silent feature kill,
not a hardening.

## 2026-08-08 — never infer contract drift from *which side* of the mirror changed

**Rubric:** What Doesn't Work
**Symptom:** a freshly written check reported five critical findings on branch
`Lab2` — "edits the client mirror without the canonical copy" for
`client/src/vendor/shared/adapters.ts` and four `contracts/*.ts`. Meanwhile
`./scripts/check-contracts.sh` exited 0 and `diff -r` on the two trees was
empty. Both were telling the truth.
**Cause:** the check inferred drift from the *diff shape* — client paths
changed, matching server paths did not, therefore someone hand-edited the
mirror. That inference is unsound. The branch had legitimately run
`check-contracts.sh --fix` to sync a mirror that was **already stale on
`main`**, so the canonical side needed no change and only the client side
appears in `git diff origin/main`. A correct sync and a hand-edit produce an
identical diff shape; only the end state distinguishes them.
**Fix:** for the mirror, only the end state is checkable, and
`./scripts/check-contracts.sh` (one `diff -r`) is the authority on it — call
it, do not reimplement it. Generalises: before writing a check for a repo
invariant, look for a script that already enforces it. Reimplementing gives
you a second, worse oracle that can disagree with the first. This one cost
5 false criticals on its first real branch, and a gate that cries wolf on run
one never gets a run two.

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
