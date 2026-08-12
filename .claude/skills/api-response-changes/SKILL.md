---
name: api-response-changes
description: "Check what a change does to API *response* payloads before it ships — a field removed from a response, a field flipped to optional/nullable/required, a response type swapped or newly wrapped in an array, an enum value added or dropped, a `.partial()` that quietly loosens every field at once, or a response contract changed on the server without the client mirror following. Use before opening or merging a PR that touches server/src/vendor/shared/**, a module's service.ts return types, or a route's `response:` schema, and whenever asked whether a change breaks API responses or the studio code reading them."
version: 0.1.0
---

# API response changes

Answers one question: **can everything already reading this API's responses
still read them?** Not whether the request still validates, not whether the
route still exists — what comes *back*, and whether a consumer written against
yesterday's payload still works.

```sh
node .claude/skills/api-response-changes/check.mjs                # origin/main → working tree
node .claude/skills/api-response-changes/check.mjs --json         # machine readable
node .claude/skills/api-response-changes/check.mjs --fail-on=major
node .claude/skills/api-response-changes/check.mjs --base main --head HEAD
```

Exit **0** = clean, **1** = findings at or above `--fail-on` (default
`critical`), **2** = the tool could not run. Head defaults to the **working
tree**, so it works on uncommitted changes.

To check a PR you do not have checked out:

```sh
git fetch origin main && git fetch origin pull/<N>/head:pr-<N>
node .claude/skills/api-response-changes/check.mjs --base origin/main --head pr-<N>
```

## Why this is not `api-breaking-changes`

The sibling skill owns the **caller's side**: endpoint removed, verb changed,
module unregistered, request field now required. It also compares the `shared`
contracts as a flat set. Two things it structurally cannot do, both of which are
where a response break actually hides:

**1. It cannot say which endpoint returns a contract.** In this repo almost no
route declares a `response:` schema — `server/CLAUDE.md` asks for one, and
reality is that responses are typed by the service return type instead. So the
response shape is only reachable by following a three-link chain:

```
app.get('/agents', async () => service.list(workspaceId))    routes.ts
  → async list(ws: string): Promise<Agent[]>                 service.ts
    → export const Agent = z.object({ … })                   vendor/shared
```

This skill walks that chain. The payoff is that `AgentsService.skillLinks`
changing from `Promise<AgentSkillLink[]>` to `Promise<AgentSkillDetail[]>` is
reported as **`GET /agents/:id/skills` now returns a different contract** — with
`git diff` on `routes.ts` completely empty.

**2. It cannot see inside a derived schema.** `X.pick()/omit()/partial()/merge()`
resolve to `kind: 'derived'` there and are compared as text. `.partial()` is
eleven characters that make *every* field on a response optional, so this skill
resolves the chain instead: `Base.omit({secret:true}).extend({…}).partial()`
becomes a real field list with real `required`/`nullable` flags.

Run both. They overlap on purpose in exactly one place — the client mirror —
because a stale mirror is the one failure that leaves both packages compiling
while the studio believes an older wire format.

## Severity means the reader

Severity here is about whoever consumes the payload, which is why it does not
match the sibling skill rule-for-rule. Required→optional is `major` there (a
caller must change) and **critical** here (a rendered field silently becomes
`undefined`).

| | Meaning |
|---|---|
| **critical** | a live reader gets `undefined`, `null`, or a different type at runtime — and nothing fails to compile on the way there |
| **major** | a reader must change to stay correct |
| **minor** | only a *producer* pays: fixtures, seeds, adapters, mappers |
| **info** | wire-compatible; a label, a `switch`, or a stale null-check to tidy |

Every rule, what it costs a reader, and how to ship it anyway:
[`rules.md`](rules.md).

A finding is **not** an instruction to revert. Loosening a response on purpose
is normal — the `evidence_path` fields on `ConventionCandidate` are `.nullish()`
because the grounding gate can strip a citation. The check exists so that it is
a decision with the readers updated, rather than an accident.

## Reading the report

Findings carry two enrichments the sibling report has no equivalent of:

- **`served by:`** — the endpoints that actually return this contract. A weakened
  field on a contract nothing serves is not the same risk as one behind
  `GET /agents`.
- **`read at:`** — studio call sites that read the field, for `critical` findings.
  A file only qualifies when the contract name appears in it, so this is a
  **lead, not a completeness claim**: a component receiving the object through an
  untyped prop is missed. Never close a finding because this list is empty.

## Workflow

1. Run `check.mjs`. Exit 0 means no response change can break a reader — say so
   and stop. Additive changes (new endpoints, new optional fields) are silent by
   design.
2. For each **critical**, open the `→ file:line` and decide: accident, or
   intended? An accident gets fixed. An intended weakening gets every reader in
   `read at:` updated in this same change, plus a line in the PR description.
3. On `response-shape-partialed`, check whether `.partial()` was meant for a
   *request* body and landed on the response contract by mistake — that is the
   common cause. `SettingsUpdate = Settings.partial()` is the correct shape of
   that intent: derive a separate schema, do not loosen the one being served.
4. On `response-field-now-nullable`, resolve the display default at the UI, never
   in the contract. See the `cost_usd` entry in the root `insights.md`: `null`
   and `0` are different facts, and coalescing in the contract destroys the
   distinction permanently.
5. On `response-mirror-drift`, run `./scripts/check-contracts.sh --fix`, then
   `cd client && pnpm typecheck`. Expect it to also land pre-existing drift from
   earlier changes — that is the guard catching up, not your bug. Call it out
   separately in the PR rather than reverting it.
6. On `response-unresolvable`, the check has gone *blind* on an endpoint it could
   previously verify. Annotate the service method's return type to restore
   coverage; silence from an unresolved endpoint is not a clean bill of health.
7. Re-run until only findings you can justify remain, and put the justification
   in the PR description.

## Improving coverage

Coverage is "endpoints whose response shape resolves", printed in the report
header. A response is resolved from the first of these that works:

| `via` | Read from |
|---|---|
| `response-schema` | the route's own `schema: { response: { 200: X } }` |
| `handler-annotation` | the handler's return type — `async (req): Promise<PrDetail> =>` |
| `service-return` | the service method the handler returns, via its `Promise<…>` annotation |
| `inline-literal` | an object literal built in the handler (`{ ok: true }`) |
| `unresolved` | none of the above — **not checked at all** |

Three things raise coverage, all of which the repo already asks for:

- **Declare `response:` on the route.** `server/CLAUDE.md`: *"One Zod schema
  serves request validation AND response serialization. Declare it on the
  route."* A declared response schema is the strongest signal this tool can
  read, and it makes the wire format enforced rather than inferred.
- **Annotate the handler's return type.** Cheapest of the three, and it beats
  every downstream guess: several `pulls` handlers query the DB inline and build
  the payload with spreads, so without the annotation they would resolve to a
  misleading *partial* object literal instead of `PrDetail`.
- **Annotate service method return types.** A method with no annotation is
  skipped rather than guessed — an inferred return type needs the compiler, and a
  wrong response shape is worse than none.

```sh
node .claude/skills/api-response-changes/response-surface.mjs WORKTREE --summary
```

That prints one line per endpoint with its `via`, which is the list to work
through.

## Files

| File | Does |
|---|---|
| `shapes.mjs` | the deep Zod resolver: chains, `.partial()`/`.pick()`/`.omit()`/`.merge()`, nested field diffing with dotted paths |
| `response-surface.mjs` | extracts the response surface at any git ref. Run it alone (`node response-surface.mjs [ref] [--summary]`) |
| `check.mjs` | diffs two surfaces, classifies, reports |
| `rules.md` | one entry per rule: what breaks, why that severity, how to migrate |

The low-level source scanner and git-ref I/O (comment stripping,
balanced-bracket slicing, `readAt`) come from `../source-scan/scan.mjs`, shared
with `api-breaking-changes` and `response-schema` — one scanner with one set of
bugs beats three. Read that skill's **angle-bracket rule** before touching any
balanced slice here.
The Zod resolution is deliberately *not* shared, because it has to model what
that one records as opaque.

## Extending it

- **New rule** → the `RULES` table in `check.mjs` *and* a row in `rules.md`. The
  `why` string is printed with every finding, so a severity is never a bare
  assertion.
- **New shape difference** → `diffShape` in `shapes.mjs`, then a `RULES` entry
  keyed by its `kind`. A diff kind with no rule is silently dropped, which is the
  right failure mode while you are still deciding the severity.
- **A new way responses are produced** (a second registry, a route helper, a
  mapper layer) → `readHandlerResponse` in `response-surface.mjs`. Verify with
  `--summary` before and after: the `unresolved` count should drop by exactly
  what you taught it.

## Parsing limits

Same constraint as the sibling: read files straight out of a git ref
(`git show ref:path`) with no checkout, no install, no tsconfig, and survive a
branch that does not typecheck yet. That rules out the TypeScript compiler and
costs the following.

- **9 of 53 endpoints currently resolve to `unresolved`** — routes that query the
  DB inline with no annotation anywhere, or call a service method that has none.
  They are not checked at all; the header count is the honest measure of
  coverage, and `--summary` names them.
- **An inferred return type is never guessed.** `async list(ws)` with no
  annotation is skipped, not inferred.
- **`z.infer` aliases are followed by name only.** `type X = z.infer<typeof Y>`
  is indexed, and an inline object type (`Promise<{ status: 'refreshing' }>`) is
  read field-by-field, but a type built with TypeScript generics
  (`Promise<Record<string, X>>`, a mapped type, a conditional type) resolves to
  nothing.
- **A field whose type is a named contract compares as `object`.** Swapping
  `field: Agent` for `field: Repo` is not itself reported; the nested field diff
  underneath it is what catches the change, so a swap between two structurally
  identical contracts is silent.
- **`.transform()` / `.pipe()` output is unknowable** without the compiler, so
  the shape is marked `transformed` and its fields are not compared. A transform
  that drops a field is a real break this tool stays silent about.
- **Union responses are not diffed member-by-member.** `z.union` and
  `z.discriminatedUnion` resolve, but a field change inside one arm is invisible.
- **Handler analysis takes the first resolvable `return`.** Handlers here return
  one shape on the success path and `throw` on failures, which makes that
  correct; a handler with two genuinely different success payloads reports only
  the first.
- **Reader lists are anchored on the contract name** appearing in the file, so
  they under-report (see *Reading the report*).

When a finding looks wrong, check it against these limits before trusting it —
and if the parser is genuinely wrong, that is a `shapes.mjs` or
`response-surface.mjs` bug worth fixing rather than a finding to wave through.
