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

## 2026-08-12 — the skills' source scanner is now one file, and `<` in `PAIRS` was provably safe

**Rubric:** What Works
**Supersedes:** 2026-08-12 — angle-bracket slicing is safe only when anchored at a verified generic
**Symptom:** the two entries below describe the scanner as living in two places —
`.claude/skills/api-breaking-changes/surface.mjs` (no `<` in `PAIRS`) and
`.claude/skills/response-schema/lib.mjs` (with `<`). Both pointers are now stale:
`lib.mjs` is 19 lines of severity helpers and `surface.mjs` has no scanner at all.
An agent following either would go looking for a pairing table that is not there,
and could "restore" a second copy.
**Cause:** the copies were consolidated into
`.claude/skills/source-scan/scan.mjs`, the single owner of git-ref I/O
(`WORKTREE`/`listFiles`/`readAt`) and the scanner (`sliceBalanced`,
`stripComments`, `splitTopLevel`, `readExpression`, `lineAt`, `stringLiteral`).
`api-breaking-changes`, `api-response-changes` and `response-schema` all import
it; no skill reaches into another skill's internals any more.

The unification was safe for a reason worth keeping, because it looks dangerous
and is not: **`sliceBalanced` moves depth only on `c === open` or `c === close`,
where `open` is the character at the index you pass.** So adding `'<': '>'` to
`PAIRS` changes behaviour *only* for slices anchored directly at a `<`. Inside a
`(`, `{` or `[` slice, `<` was already an ordinary character in both copies and
`a < 5 && b > 3` could never unbalance anything. The `<`-aware table is therefore
a strict superset, which is why adopting it produced **byte-identical output**
from all six surface and check entry points across the three skills.
**Fix:** the call-site rule from the superseded entry still holds and now lives at
the top of `scan.mjs` and under "The angle-bracket rule" in
`.claude/skills/source-scan/SKILL.md` — anchor at a `<` only where a lookahead
has proved it opens a generic; for a fully wrapped generic use
`^Promise\s*<([\s\S]*)>$` instead of slicing. When changing the scanner, verify
with fixed invariants, not by reading a report — a scanner bug in a differential
tool shows up as a *missing* finding, not a crash:

```sh
node .claude/skills/api-breaking-changes/surface.mjs | grep -c '"method"'      # 101
node .claude/skills/response-schema/responses.mjs    | grep -c '"typeText"'    # 47
node .claude/skills/api-response-changes/response-surface.mjs --summary | wc -l # 53
```

Do not add a `legacy`/`strict` flag to `sliceBalanced` to restore an old
behaviour — two behaviours behind one name is how the copies drifted. Two callers
needing different semantics need two named functions. `pr-self-review/lib.mjs`
still keeps its own `git`/`matchesAny` (it is a changeset collector with no
scanner); that overlap is known and out of scope, not an oversight.

## 2026-08-12 — angle-bracket slicing is safe only when anchored at a verified generic

**Rubric:** What Works
**Supersedes:** 2026-08-12 — `sliceBalanced` in the skills' source scanner does not pair angle brackets
**Symptom:** none yet — latent. That entry's "adding `<`/`>` to `PAIRS` is not
the fix" reads as absolute, and `.claude/skills/response-schema/lib.mjs` does
exactly that. A reader reconciling the two could remove working code, or copy
the `PAIRS` change into a general-purpose scanner and hit the original bug.
**Cause:** the hazard is the *call site*, not the pairing table. `<` is
ambiguous only where it might be a comparison, JSX, or an arrow — that is,
where you scan arbitrary source. `extractCallerBindings` in
`.claude/skills/response-schema/responses.mjs` never scans arbitrary source: it
matches `/\bapi\s*\.\s*(get|post|…)\s*(?=<)/` and slices from the `<` that the
lookahead already proved opens a generic. Inside a type there is no comparison
operator and no JSX, so the only residual hazard is `=>`, which that
`sliceBalanced` steps over explicitly.
**Fix:** keep the original entry's rule as the default — do not reach for
`sliceBalanced` to pull a generic out of a service signature; `parseTypeExpr`'s
greedy match to the final `>` is right there. The one sanctioned exception is a
slice anchored at a position a lookahead has already proved is a generic open,
with `=>` skipped. Verified against nested generics (`Map<string, Set<number>>`),
an arrow inside a type literal (`Array<{ cb: (x: number) => boolean }>`), and a
bare `a < 5 && b > 3` (never matched); all 47 bindings extract correctly. If you
change that regex so it no longer proves the `<`, the exception is void — check
with `node .claude/skills/response-schema/responses.mjs | grep -c '"typeText"'`,
which must stay at 47.

## 2026-08-12 — `sliceBalanced` in the skills' source scanner does not pair angle brackets

**Rubric:** What Doesn't Work
**Symptom:** parsing `Promise<Agent[]>` out of a service signature yielded the
name `null` instead of `Agent`, with no error. Every endpoint in a new
`api-response-changes` surface resolved to an empty contract column while
`via: 'service-return'` still claimed success — a silent wrong answer, not a
crash.
**Cause:** `sliceBalanced` in `.claude/skills/api-breaking-changes/surface.mjs`
pairs brackets from `PAIRS = { '(':')', '{':'}', '[':']' }` only. Given `<` it
increments depth on the open character, never finds a close character (`PAIRS['<']`
is `undefined`), falls through to its truncation fallback, and returns *everything
after* the `<` — `Agent[]>`, trailing `>` included. The caller then tests
`/^(.*)\[\]$/`, which does not match because of that `>`, so the array unwrap and
the name extraction both fail quietly.
**Fix:** never use `sliceBalanced` on a TypeScript generic. For a fully-wrapped
generic, match greedily to the final `>` instead —
`new RegExp('^' + wrapper + '\\s*<([\\s\\S]*)>$')` — which is what
`parseTypeExpr` in `.claude/skills/api-response-changes/response-surface.mjs`
does. When a *nesting-aware* angle scan is genuinely needed (reading a return
annotation up to `=>`), count `<([{` / `>)]}` by hand and treat `=>` as the
terminator, as `readHandlerReturnType` in that file does. Adding `<`/`>` to
`PAIRS` is not the fix: `<` is ambiguous in TS/JS source (comparison, JSX, arrow
`=>`), and every existing caller scans `()`/`{}`/`[]` where the pairing is
unambiguous.

## 2026-08-11 — an OpenRouter `:free` model can drop `structured_outputs` while keeping `response_format`

**Rubric:** Tool & Library Notes
**Symptom:** the conventions scan failed with `429 Provider returned error` after
the workspace model was set to `google/gemma-4-31b-it:free`. The model id is
valid, the key works, and the paid `google/gemma-4-31b-it` is fine — so the 429
reads as a transient rate limit worth retrying. It is not the real problem.
**Cause:** two distinct facts wearing one error. (1) `429 Provider returned error`
is the *upstream* provider behind OpenRouter's free pool; OpenRouter's own quota
message reads `Rate limit exceeded: free-models-per-day`, so the wording tells you
which one you hit. (2) Behind it, `google/gemma-4-31b-it:free` advertises
`response_format` but **not** `structured_outputs` in its `supported_parameters`,
while the paid variant of the same model advertises both. Everything in this repo
that calls `completeStructured` sends
`response_format: {type:'json_schema', strict: true}`
(`reviewer-core/src/llm/openrouter.ts`), so that endpoint could never have
satisfied the scan — clearing the 429 would only have moved the failure.
**Fix:** check the capability before blaming the rate limit —

```sh
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    if 'gemma-4' in m['id']:
        print(m['id'], 'structured_outputs' in (m.get('supported_parameters') or []))"
```

`ModelCatalog.supportsStructuredOutputs` (`server/src/platform/model-catalog.ts`,
formerly `PriceBook` — it caches `/models` for prices *and* capabilities) now
answers this, and the conventions scan preflights on it and fails with
`reason: 'model_unsupported'` before spending a call. It returns **`boolean | null`**
and `null` means "the catalogue does not know" — callers must treat that as
*proceed*, never as a denial, or an unreachable `/models` blocks every scan. Free
models that DO work here: `google/gemma-4-26b-a4b-it:free`. When picking any new
free model for a structured-output feature, verify the flag first; `:free` is not
the same endpoint as its paid twin.

## 2026-08-11 — `check-contracts.sh --fix` also lands drift you did not create

**Rubric:** Codebase Patterns
**Symptom:** a one-file contract change (`contracts/knowledge.ts`) synced with
`./scripts/check-contracts.sh --fix` produced **five** modified files under
`client/src/vendor/shared/` — `adapters.ts`, `contracts/eval-ci.ts`,
`contracts/productionize.ts` and `contracts/trace.ts` had nothing to do with the
change.
**Cause:** the two trees were **already** out of sync before the change, and the
guard is one-directional by design (`rsync -a --delete`, server always wins). So
`--fix` does not sync your edit — it makes the whole mirror match canonical, which
includes every earlier unmirrored change. `git diff` on `main` had never been run
against `diff -r server/src/vendor/shared client/src/vendor/shared`, so nobody
knew. Both `tsc` runs pass either way, which is exactly the failure mode the guard
exists to surface.
**Fix:** run `diff -rq server/src/vendor/shared client/src/vendor/shared`
**before** touching a contract, so you know which files were already drifted and
can say so. Do not revert the extra files — they are the mirror catching up, and
reverting re-breaks it. Call them out separately in the PR description, and
re-typecheck the client afterwards: a client that stops compiling after a sync is
the real bug the guard found, not a sync problem.

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
