---
name: api-breaking-changes
description: "Check a change for breaking API changes before it ships — an endpoint removed, renamed, or re-verbed, a module dropped from the registry, a request field that became required, a shared contract field removed or weakened, or a studio call left with nothing serving it. Use before opening or merging a PR that touches server/src/modules/**/routes.ts, server/src/modules/index.ts, or server/src/vendor/shared/**, and whenever asked whether a change breaks the API or its consumers."
version: 0.1.0
---

# API breaking changes

Answers one question: **does this change break someone already calling the
API?** Nothing else — it does not review style, correctness, or coverage. For
those, `/code-review`; for a full pre-PR gate, `pr-self-review`.

```sh
node .claude/skills/api-breaking-changes/check.mjs                # origin/main → working tree
node .claude/skills/api-breaking-changes/check.mjs --json         # machine readable
node .claude/skills/api-breaking-changes/check.mjs --fail-on=major
node .claude/skills/api-breaking-changes/check.mjs --base main --head HEAD
```

Exit **0** = clean, **1** = findings at or above `--fail-on` (default
`critical`), **2** = the tool could not run. Head defaults to the **working
tree**, so it works on uncommitted work.

To check a PR you do not have checked out:

```sh
git fetch origin main && git fetch origin pull/<N>/head:pr-<N>
node .claude/skills/api-breaking-changes/check.mjs --base origin/main --head pr-<N>
```

## Why three surfaces and not just the routes

A DevDigest caller can break in three places, and only one of them is the route
file:

| Surface | Where | The break it hides |
|---|---|---|
| endpoints | `server/src/modules/*/routes.ts`, `app.ts` | path or verb changed, route deleted |
| the registry | `server/src/modules/index.ts` | a module dropped from the registry takes **all** its endpoints offline without editing a single route |
| contracts | `server/src/vendor/shared/**` | routes here declare almost no `response:` schema — responses are typed by the service return type, so the **response** wire format lives in the contracts |

Consumers (`client/src/**` `api.get/post/...` call sites) are extracted too, so
a removed endpoint is reported together with the studio code still calling it.

## Reading the report

Findings are grouped by severity and each carries a `[rule]` tag. Every rule,
what it costs a caller, and how to ship it safely: [`rules.md`](rules.md).

- **critical** — an existing caller gets a 404 or reads `undefined`. Fix, or
  ship the old and new shape side by side.
- **major** — a caller must change to keep working (a 422, or a field that can
  now be absent). Legitimate in a PR that updates every caller *in the same PR*.
- **minor / info** — worth knowing, not a block. Pre-existing unserved studio
  calls land here on purpose: this repo ships hooks ahead of the API, so
  reporting them as breaks would train people to skip the report.

A finding is **not** an instruction to revert. Removing an endpoint on purpose
is normal; the check exists so that it is a decision rather than an accident.
State it in the PR description, list the callers you updated, and move on.

## Workflow

1. Run `check.mjs`. If it exits 0, say so and stop — additive changes are not
   reported and that is the intended silence.
2. For each **critical**, open the `→ file:line` and decide: accident, or
   intended? An accident gets fixed. An intended removal gets its consumers
   updated in this same change, and a line in the PR description.
3. For each **major**, confirm every caller listed is updated. `consumers:` in
   the JSON output is the list to work through.
4. On `contract-mirror-drift`, run `./scripts/check-contracts.sh --fix`, then
   `cd client && pnpm typecheck`. Expect it to also land pre-existing drift from
   earlier changes — that is the guard catching up, not your bug. Call it out
   separately in the PR rather than reverting it.
5. Re-run until only findings you can justify remain, and put the justification
   in the PR description.

## Files

| File | Does |
|---|---|
| `surface.mjs` | extracts the API surface at any git ref — endpoints, registry, contracts, consumers. Run it alone (`node surface.mjs [ref]`) to dump the surface as JSON. |
| `check.mjs` | diffs two surfaces, classifies, reports |
| `rules.md` | one entry per rule: what breaks, why that severity, how to migrate |

## Extending it

- **New rule** → the classification block in `check.mjs` *and* a row in
  `rules.md`. A severity nobody can justify is a severity people learn to
  ignore, so the rationale is not optional.
- **A new place endpoints are declared** (a second registry, a route prefix, a
  new plugin style) → `FILE_SETS` and `extractRoutes` in `surface.mjs`. Verify
  with `node surface.mjs | grep -c '"method"'` before and after; the count
  should go up by exactly what you added.
- **Before adding a check that shells out**, look for a script that already does
  it — `./scripts/check-contracts.sh` is the mirror guard, and the mirror rule
  here deliberately reimplements only the comparison, not the fix.

## Parsing limits

`surface.mjs` scans source text with a bracket-aware regex rather than the
TypeScript compiler, because it has to read files straight out of a git ref
(`git show ref:path`) with no checkout, no install, and no tsconfig — and has to
work on a branch that does not typecheck yet. What that costs:

- A route path built at runtime is only seen as its literal text.
  `` app.post(`/findings/:id/${action}`) `` (reviews/routes.ts) becomes the
  single canonical route `POST /findings/*/*`, not one per action. Consumer
  matching is loose in the same direction Fastify is, so calls to
  `/findings/x/accept` still resolve.
- `X.pick()/omit()/partial()/merge()` resolve to `kind: 'derived'` — a field
  change *inside* one of those is invisible. `z.object`, `X.extend({...})`,
  `z.array`, and `z.enum` are modelled properly.
- A schema imported from a file outside `FILE_SETS.schemas` resolves to
  `kind: 'ref'` and is compared by name only.
- `.nullable()` alone is not a shape change — the key must still be present, so
  required→nullable is reported as a value change, not a missing field.
- Renames are a **guess** (path similarity ≥ 0.62 with the same verb). A wrong
  pairing changes the wording of a critical finding, never whether one fires.

When a finding looks wrong, check it against these limits before trusting it —
and if the parser is genuinely wrong, that is a `surface.mjs` bug worth fixing
rather than a finding to wave through.
