# Run cost — dollar cost of a review, surfaced on three screens

**Status:** shipped
**Lesson:** —

Spec lives in `server/specs/` because the schema and the canonical contracts are
the load-bearing part; the three UI surfaces are described in **Screens** below
and are implemented in `client/`.

## Problem

A review run burns tokens against a priced model, but nothing in the studio says
what it cost. You can see DURATION, TOKENS and FINDINGS on a run and a SCORE on
a PR — and then have no idea whether the last review cost a tenth of a cent or
forty cents. Anyone tuning agent config (model choice, chunking mode, context
budget) is doing it blind on the one axis that shows up on an invoice.

The plumbing to answer this already exists and is unused: `reviewer-core`'s run
outcome carries `costUsd`, the LLM adapters compute `estimateCost`, and
`PriceBook` caches live OpenRouter prices. Commit `d45ab0d` removed the last
mile — the `agent_runs.cost_usd` column and the COST stat — so today the number
is computed and thrown away.

## Scope

- Restore `agent_runs.cost_usd`, populated at run completion from the engine
  outcome (`outcome.costUsd`), which prefers the provider's **actual** reported
  cost over the static estimate where the provider returns one (OpenRouter).
- Restore `cost_usd` on the `RunStats` and `RunSummary` contracts.
- Add `cost_usd` to `PrMeta` — the **latest run's** cost for that PR.
- Surface it on three screens (below).
- A single shared `formatCost` helper with adaptive precision, used by all three.

## Out of scope

- **Backfilling historical runs.** Rows written before this change keep
  `cost_usd = null` and render as `—`. We deliberately do not recompute cost
  from stored tokens: prices drift, and a number that silently changes when the
  price table is edited is worse than an honest blank.
- Aggregate spend anywhere else — no repo-level total, no dashboard tile, no
  budget cap or alert. `observability.ts` and `productionize.ts` already declare
  `total_cost_usd` / `avg_cost_usd` contracts for that; they stay unused.
- Sorting or filtering the PR list by cost.
- Cost of non-review LLM traffic (embeddings, brief generation, intent
  extraction). Only the review run is attributed.
- Changing the pricing tables themselves. `pricing.ts` slugs and prices are
  approximate and flagged as such in that file's comment; that stays true.

## Screens

### 1. PR list — `/repos/:repoId/pulls`

A new **COST** column between SCORE and STATUS.

Semantics: **the latest run for that PR**, not a sum across runs. This matches
the SCORE column beside it, which already shows only the latest review — two
adjacent columns describing different time windows would be a trap. "Latest" =
the most recent `agent_runs` row for the PR with `status = 'done'`; running,
failed and cancelled runs are skipped so the column doesn't flicker to `—` mid-run.

Right-aligned, `mono`, same muted treatment as UPDATED.

### 2. Run timeline — PR detail, `RunHistory`

The run row already right-aligns the run's local time in a vertical stack
(`RunHistory.tsx:198-200`). Cost goes directly under the time in that same
stack — time is the identifier, cost is the annotation, and the ordering carries
that on its own. Not a step more muted: the theme exposes exactly three text
tokens (`--text-primary`, `--text-secondary`, `--text-muted`) and the timestamp
already sits on the faintest. Inventing a fourth token or reaching for `opacity`
to buy one notch of hierarchy is not worth it.

Shown for settled runs only (`status === 'done'`), consistent with how the
findings/blockers line is gated. A running or failed run shows nothing there.

### 3. Run trace drawer — `TraceBody` stats row

Restore the COST stat between TOKENS and FINDINGS:

```
DURATION      TOKENS        COST         FINDINGS
8.2s          12k→1.5k      $0.0431      2
```

This is a straight revert of the `TraceBody` / `helpers.ts` / `runs.json` part
of `d45ab0d`, except that `formatCost` gains adaptive precision.

## Formatting

One helper, one behaviour everywhere. Three distinct states, and they must stay
distinguishable — `z-ai/glm-4.7-flash` is priced at literally zero, so "free"
and "unknown" cannot collapse into the same glyph:

| Input | Renders | Meaning |
|---|---|---|
| `null` | caller's placeholder | see the `—` / `n/a` rule below |
| `0` | `$0.00` | genuinely free model |
| `0.0000042` | `<$0.0001` | below the precision we render |
| `0.0042` | `$0.0042` | 4 dp below one cent |
| `0.42` | `$0.42` | 2 dp at or above one cent |

The floor is `<$0.0001`, not `<$0.01`: we print four decimals happily one row
up, so claiming only "less than a cent" for smaller values would throw away
precision the format already supports.

The `—` vs `n/a` split is a **call-site** decision — `formatCost` takes the
placeholder as an argument, because both cases arrive as `null` and only the
caller knows which it is:

- **PR list → always `—`.** `PrMeta.cost_usd` is null both when no run has
  settled and when the latest run's model wasn't priced, and the list carries no
  second signal to tell them apart. Adding a field to the contract purely to
  distinguish them isn't worth it at list altitude.
- **Timeline and trace drawer → `n/a`.** Both call sites only render once a
  settled run exists (`RunHistory` gates on `settled`; the drawer is scoped to
  one run's trace), so a null there unambiguously means "model not in the price
  table".

The old helper did `usd.toFixed(2)` unconditionally, which rendered every
sub-cent run as `$0.00`. Since a chunked review on a cheap OpenRouter model
lands in exactly that range, that formatting made the feature useless — this is
the one behavioural change versus what was removed.

## Contract changes

`@devdigest/shared` — canonical at `server/src/vendor/shared/`, **mirrored by
hand** into `client/src/vendor/shared/`. Both sides or neither.

- `contracts/trace.ts` → `RunStats`: `+ cost_usd: z.number().nullable()`
- `contracts/trace.ts` → `RunSummary`: `+ cost_usd: z.number().nullable()`
- `contracts/platform.ts` → `PrMeta`: `+ cost_usd: z.number().nullish()`
  (`nullish`, matching the adjacent `score` — the field is absent on the detail
  endpoint and on the GitHub adapter's `listPullRequests` projection)

No new routes and no changed request shapes. `GET /repos/:id/pulls` and
`GET /pulls/:id/runs` gain a field each.

## Schema changes

`agent_runs.cost_usd double precision` — restored. Nullable, no default: null
means "not known", which is exactly the state of every existing row.

Generated via `pnpm db:generate` as `0010_overrated_songbird.sql` — one
`ALTER TABLE "agent_runs" ADD COLUMN "cost_usd" double precision;`.

**The seed is deliberately left alone.** `db:seed` inserts a review but no
`agent_runs` row at all — the comment at `seed.ts:135` is explicit that this
models "the PR shows results before the first run". Adding a seeded run to make
the demo column non-empty would put a fabricated run in the PR timeline whose
trace icon opens an empty drawer, which reads as a broken feature rather than a
populated one. The seed has a single PR, so the cost is one `—` that fills in
the moment the user does the thing the app is asking them to do anyway.

## Server work

**`run-executor.ts`** — `outcome.costUsd` is already destructured off the engine
result and dropped on the floor. Thread it into `completeAgentRun({ costUsd })`
and into the `RunTrace.stats` document. The three failure paths
(`run-executor.ts:80`, `:300`, and the no-diff early return at `:421`) pass
`costUsd: null`, matching how they already zero tokens.

**`repository/run.repo.ts`** — `completeAgentRun` signature takes `costUsd`;
`listRunsForPull` projects `cost_usd: run.costUsd`.

**`repository.ts`** — the facade's inline param type mirrors the same field.

**`modules/pulls/routes.ts`** — the list handler already does a
latest-per-PR read for SCORE (`routes.ts:114-130`): one `inArray` query over
`reviews`, ordered `desc(createdAt)`, first-seen-per-PR wins. Add the same shape
over `agent_runs` — filtered to `status = 'done'`, ordered by `ranAt desc`,
selecting `prId` and `costUsd`. One extra query on a small list; do not join it
into the reviews query, because "latest review" and "latest done run" are not
guaranteed to be the same row.

## Client work

**No new React components.** Three call sites render cost three different ways —
a table cell, a stacked annotation, a `<Stat>` tile — so the thing worth sharing
is the *formatting*, not a component. A `<CostCell>` wrapping one `<span>` in
three different styles would be indirection with nothing behind it.

New:

- `src/lib/format-cost.ts` — `formatCost(usd, fallback)`. It lives in `lib/`,
  not next to the drawer, because the client's colocation rule promotes on the
  second consuming route and this has three call sites across two. It sits
  beside `src/lib/model-label.ts`, already the home for pricing-adjacent
  formatting.
- `src/lib/format-cost.test.ts` — the value table above.

Edited:

- `RunTraceDrawer/_components/TraceBody/TraceBody.tsx` — a fourth `<Stat>`
  between TOKENS and FINDINGS. Layout absorbs it: `s.statsRow` is
  `flex; gap:10` and `s.stat` is `flex:1`, so four tiles just split the width.
- `pulls/_components/PRRow/PRRow.tsx` — a cell between the score ring and the
  status badge.
- `[number]/_components/RunHistory/RunHistory.tsx` — a second line in the
  existing right-hand stack, under the timestamp, gated on the `settled` flag
  that's already computed there.
- `pulls/styles.ts` — `s.costCell` (a clone of `updatedCell`), plus the
  `headCell` change below.
- `pulls/constants.ts` — `"cost"` in `COLUMN_KEYS` after `"score"`; `GRID` goes
  from `"1fr 132px 92px 60px 118px 78px"` to
  `"1fr 132px 92px 60px 72px 118px 78px"`.
- `messages/en/runs.json` — `trace.stat.cost: "COST"` (`stats.na: "n/a"` already
  exists and is reused).
- `messages/en/prReview.json` — `list.columns.cost: "Cost"`,
  `timeline.costUnknown: "n/a"`.

`s.headCell` needs rewriting rather than patching: it currently right-aligns via
`i === COLUMN_KEYS.length - 1`, and COST is right-aligned but not last. Replace
the index comparison with an explicit set — `RIGHT_ALIGNED = new Set(["cost",
"updated"])` in `constants.ts`, `s.headCell(RIGHT_ALIGNED.has(key))` at the call
site.

## Acceptance criteria

- [ ] A completed review run stores a non-null `cost_usd` when its model is in
      the price table. — `*.it.test.ts`
- [ ] A run on a model absent from the price table stores `null` and the trace
      drawer renders `n/a`, not `$0.00`. — unit (server) + unit (client)
- [ ] Failed, cancelled, and no-diff runs store `cost_usd = null` and are not
      picked as a PR's "latest" for the list column. — `*.it.test.ts`
- [ ] `GET /repos/:id/pulls` returns `cost_usd` equal to the newest **done**
      run's cost, ignoring a newer failed run. — `*.it.test.ts`
- [ ] `formatCost` table above holds exactly, including `0 → $0.00`,
      `0.0000042 → <$0.0001`, `0.0042 → $0.0042`, `0.42 → $0.42`. — unit
- [ ] The PR list renders a COST column header and a right-aligned value per
      row; a never-reviewed PR shows `—`. — unit (RTL)
- [ ] The timeline shows cost only on settled runs. — unit (RTL)
- [ ] `RunStats` / `RunSummary` / `PrMeta` are byte-identical between
      `server/src/vendor/shared/` and `client/src/vendor/shared/`. —
      `server/test/contracts.test.ts`
- [ ] Existing fixtures updated: `contracts.test.ts:160`,
      `RunTraceDrawer.test.tsx:10`, `RunHistory.test.tsx:27`.

## Open questions

None blocking. Two judgement calls made and recorded here rather than asked
again later:

- **Latest run, not sum.** Chosen for consistency with the SCORE column. If the
  question later becomes "what has this PR cost us in total", that is a
  different column (`total_cost_usd`, already declared in the observability
  contracts) and not a reinterpretation of this one.
- **Partial cost on failed runs is not captured.** A run that dies after three
  chunks really did spend money, and we record zero. Fixing it means the
  executor tracking cost incrementally rather than reading it off the final
  outcome — worth doing, but it is a change to the engine's accounting, not to
  this feature.