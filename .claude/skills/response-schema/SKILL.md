---
name: response-schema
description: "Check what a PR does to the payloads the API sends back — a response field removed, flipped to optional or nullable, retyped, an enum value dropped, a `.partial()` that loosens every field at once, an endpoint's response type swapped, or a server contract changed without the client mirror following. Use before opening or merging a PR that touches server/src/vendor/shared/**, a route's `response:` schema, or a client `api.get<T>()` generic, and whenever asked whether a change breaks API responses or the studio code reading them."
version: 0.1.0
---

# Response schema

Answers one question: **can everything already reading this API's responses
still read them?** Not whether the route still exists, not whether the request
still validates — only what comes *back*.

```sh
node .claude/skills/response-schema/check.mjs                 # origin/main → working tree
node .claude/skills/response-schema/check.mjs --json          # machine readable
node .claude/skills/response-schema/check.mjs --fail-on=major
node .claude/skills/response-schema/check.mjs --only-served   # skip types nothing returns yet
node .claude/skills/response-schema/check.mjs --base main --head HEAD
```

Exit **0** = clean, **1** = findings at or above `--fail-on` (default
`critical`), **2** = the check could not run. Head defaults to the **working
tree**, so it runs on uncommitted work.

To check a PR you do not have checked out:

```sh
git fetch origin main && git fetch origin pull/<N>/head:pr-<N>
node .claude/skills/response-schema/check.mjs --base origin/main --head pr-<N>
```

## Scope, and the two neighbouring skills

Three skills in this repo overlap here. Pick by the question you are asking.

**`api-breaking-changes`** — "does this PR break the API?" The whole
caller-visible surface: endpoints, the module registry, request schemas,
orphaned studio calls. Its contract rules are flat and stop at
`kind: 'derived'`, so a field change inside a `.partial()` is invisible to it.

**`api-response-changes`** — the same payload question as this skill, resolved
from the **server** side: route `response:` → handler annotation → service
`Promise<…>` → inline literal, across all 53 endpoints. It will catch a service
return type that drifts with no contract change. Prefer it when you want to know
what the server actually sends.

**This skill** resolves the payload from the **consumer** side: the studio's
`api.get<Agent[]>('/agents')` generic is treated as the response declaration
(47 bindings), with a route `response:` schema outranking it where one exists.
Prefer it when you want to know whether the payload still matches what client
code is compiled against — which also catches the case where the generic itself
was always wrong.

Neither of the last two subsumes the other; they disagree about where the truth
lives, on purpose. Run both before a PR that touches `vendor/shared/` and expect
duplicate findings where they agree.

What this skill models that `api-breaking-changes` does not:

| | `api-breaking-changes` | `response-schema` |
|---|---|---|
| `.partial()` / `.pick()` / `.omit()` / `.merge()` / `.required()` | `kind: 'derived'`, contents invisible | resolved into real field lists |
| nested fields | top level only | full paths — `findings[].evidence[].component` |
| what an endpoint returns | not modelled | `api.get<T>()` generic → resolved shape |
| unions, tuples, records, discriminated unions | not modelled | modelled |
| a change reported N times via N embedding contracts | n/a | collapsed to one, with `also reaches:` |

`.partial()` is the worked example. `SettingsUpdate = Settings.partial()` turns
every field optional in one call — precisely the mandatory→optional change worth
catching, and precisely what an opaque wrapper cannot see.

## Where a response shape actually comes from here

**No route in this repo declares a `response:` schema.** Verify it yourself:

```sh
grep -rn "response:" server/src/modules/*/routes.ts   # no output
```

Handlers return their service's value and Fastify serializes it, so nothing on
the server states the wire format. Two things do, and the check reads both:

| Source | Where | Why it counts |
|---|---|---|
| contracts | `server/src/vendor/shared/**` | the written-down wire shapes |
| bindings | `client/src/**` `api.get<Agent[]>('/agents')` | the generic *is* this repo's response declaration — it is the type every consumer is written against |

A route-declared `response:` schema outranks the client generic when one exists.
Only `2xx` statuses are read; an error envelope is not the response contract.

Because bindings come from the studio, the report can say which endpoints carry
a changed contract — `served by: GET /pulls/*/reviews` — and that is what
separates a real break from a schema nobody returns yet.

## Reading the report

Findings are grouped by severity, each tagged with a `[rule]`. Every rule, what
it costs a reader, and how to ship it safely: [`rules.md`](rules.md).

- **critical** — a consumer reads `undefined` where a value used to be.
- **major** — a consumer must change to keep working: a field that can now be
  absent or null, a retyped value, a dropped enum member.
- **minor / info** — worth knowing, not a block. New always-present fields land
  here: additive for readers, breaking only for whatever *constructs* the shape.

Two lines modify severity, and both matter more than they look:

- `nothing returns this type yet — severity lowered one step`. This repo ships
  contracts ahead of the features that use them (`CLAUDE.md`), so ~120 of its
  146 contracts are unserved. Reporting those as critical would train people to
  skip the report. `--only-served` hides them entirely.
- `same change also reaches: …`. Contracts nest, so one edited field surfaces
  once per embedding contract. The finding is reported against the
  widest-reaching served contract and the rest are listed on that line.

A finding is **not** an instruction to revert. Loosening a field on purpose is
normal; the check exists so it is a decision rather than an accident. State it in
the PR description, list the consumers you updated, and move on.

## Workflow

1. Run `check.mjs`. Exit 0 means no response shape changed — additive optional
   fields are silent on purpose, and that silence is the intended answer.
2. For each **critical**, open the `→ file:line`. A removed field is either an
   accident or a migration; a migration updates the studio code reading it in
   this same PR.
3. For each **major**, work the `served by:` list. Every endpoint there returns
   the changed shape, and every studio call site against it needs checking. In
   JSON output the `endpoints` array is the same list.
4. On `response-mirror-drift`, run `./scripts/check-contracts.sh --fix`, then
   `cd client && pnpm typecheck`. Expect it to land *pre-existing* drift from
   earlier changes too — that is the guard catching up, not your bug. Call it out
   separately in the PR rather than reverting it.
5. On `response-field-now-nullable`, check what the consumer does with `null`.
   The root `insights.md` `cost_usd` entry is the worked example: `null` and `0`
   are different facts, and coalescing them at the consumer destroys the
   distinction. Resolve the display default at the UI, never in the contract.
6. Re-run until only findings you can justify remain, and put the justification
   in the PR description.

## Files

| File | Does |
|---|---|
| `responses.mjs` | extracts the response surface at any git ref — contracts, bindings, mirror. Run it alone (`node responses.mjs [ref]`) to dump it as JSON. |
| `check.mjs` | diffs two surfaces, collapses duplicates, classifies, reports |
| `lib.mjs` | git I/O, globbing, and the bracket-aware source scanner |
| `rules.md` | one entry per rule: what breaks, why that severity, how to migrate |

`lib.mjs` deliberately does not import `../pr-self-review/lib.mjs`: this skill
has to keep working when only `.claude/` is checked out, and its scanner
diverges anyway (balanced `<…>` slicing, TypeScript type literals).

## Extending it

- **New rule** → the `diffShape` classification in `check.mjs` *and* a row in
  `rules.md`. Give it a `sig:` so duplicate reports across embedding contracts
  collapse. A severity nobody can justify is one people learn to ignore, so the
  rationale is not optional.
- **A new Zod combinator** → `fromZod` (builders like `z.union`) or the call loop
  in `resolveZod` (derivations like `.partial`). Verify with
  `node responses.mjs | grep -c '"kind": "opaque"'` before and after; the count
  should go down.
- **A new way the client calls the API** → `extractCallerBindings`. Check with
  `node responses.mjs | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["bindings"]))'`;
  it is 47 today.
- **Before adding a check that shells out**, look for a script that already does
  it. `./scripts/check-contracts.sh` is the mirror guard; the mirror rule here
  reimplements only the comparison, not the fix.

## Parsing limits

The scanner reads source text with a bracket-aware parser rather than the
TypeScript compiler, because it has to read files straight out of a git ref
(`git show ref:path`) with no checkout, no install, and no tsconfig — and has to
work on a branch that does not typecheck yet. What that costs:

- **A service return type is not a response type.** Only shapes reachable from a
  contract or a client generic are modelled. A handler that returns an object
  literal typed nowhere is invisible to this check.
- **Bindings are only as honest as the studio generic.** `api.get<Agent>()` is
  believed. If the generic lies about what the server sends, so does the report;
  nothing verifies the generic against the handler.
- `.transform()` / `.pipe()` change the output type, so the shape becomes
  `opaque` — a field diff there would describe the input, not the payload. A
  change inside one is reported as `response-shape-opaque` (info), never silently.
- Resolution stops at depth 14 and cycles resolve to `kind: 'cycle'`. Deeper
  nesting than that is reported as unchanged. Raising the cap costs nothing
  measurable (measured: no difference between 6 and 14) — raise it if a real
  contract needs it.
- A schema built at runtime, imported from outside the scanned file sets, or
  named by a computed key resolves to `kind: 'ref'` and is compared by name only.
- Path parameters collapse: `/repos/${id}/pulls` and `/repos/:id/pulls` are one
  binding key, `GET /repos/*/pulls`. Two endpoints differing only in a parameter
  name are one binding.
- Enum comparison is positional-insensitive but literal: `z.enum` values are read
  as written, so a value built from a constant is not seen.

When a finding looks wrong, check it against these limits before trusting it —
and if the scanner is genuinely wrong, that is a `responses.mjs` bug worth fixing
rather than a finding to wave through.
