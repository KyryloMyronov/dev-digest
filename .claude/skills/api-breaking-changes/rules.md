# Rules

One entry per `[rule]` tag emitted by `check.mjs`. Each says what actually
breaks, why it carries that severity, and the way to ship the change anyway.

Severity means one thing here:

| | Meaning |
|---|---|
| **critical** | an existing caller gets a 404, or reads a field that is now `undefined` |
| **major** | an existing caller must change to keep working — a 422, or a value that can now be absent |
| **minor** | nothing fails, but something silently means less than it did |
| **info** | wire-compatible; someone still has to update code or a label |

---

## Endpoints

### `endpoint-removed` — critical

The method+path is gone from a registered route file. Every caller gets a 404,
and in the studio that surfaces as an `ApiError` toast, not a compile error —
`api.get<T>('/path')` is a string, so nothing type-checks the path.

**Ship it anyway:** delete the callers in the same change. If the endpoint has
callers outside this repo (CI runner, a script, someone's curl), keep the old
route registered as a thin delegate for one release and remove it in a follow-up.

### `endpoint-renamed` — critical

A removed endpoint paired with an added one of the same verb and a similar path.
Same blast radius as a removal; the pairing exists only so the finding can name
the replacement.

**Ship it anyway:** register both paths for one release —

```ts
const handler = async (req) => { /* … */ };
app.get('/agents/:id/models', { schema: { params: IdParams } }, handler);
app.get('/agents/:id/model-list', { schema: { params: IdParams } }, handler); // old name, remove in <release>
```

— or update every caller in this PR and say so in the description.

The pairing is a heuristic (path similarity ≥ 0.62). If it guesses wrong you get
a `endpoint-removed` plus a new endpoint instead; the break is still reported.

### `endpoint-method-changed` — critical

Same path, different verb. Fastify does not fall back across verbs, so the old
verb 404s exactly like a removal. Common accident: turning a `POST` action into
a `PUT` while "tidying up" REST semantics.

### `module-unregistered` — critical

A key disappeared from `modules` in `server/src/modules/index.ts`. This is the
quiet one: the route file is untouched, `git diff` on it is empty, every test
that imports the plugin directly still passes — and every one of its endpoints
is offline. The finding lists them.

**Ship it anyway:** if the module is genuinely retired, delete its folder too, so
the next reader does not find live-looking routes nothing serves.

### `endpoint-unreachable` — critical

The route is still declared but its module is not registered. Same effect as
above, reported per endpoint when only part of the surface moved.

### `path-param-renamed` — info

`/agents/:id` → `/agents/:agentId`. The wire format is identical — the parameter
name is internal. Reported because the params schema, the handler destructuring,
docs, and any generated client all name it.

---

## Requests

Request schemas are what the route declares in `schema: { body, params,
querystring, headers }`. Zod validation failures surface as **422**.

### `request-field-added-required` — major

A new field with no `.optional()` / `.nullish()` / `.default()`. Every existing
caller's request now 422s.

**Ship it anyway:** add it as `.optional()` first, backfill the callers, then
tighten in a follow-up. Or give it a `.default()` when a sane default exists —
that is not a break at all and is not reported.

### `request-field-now-required` — major

`.optional()` was dropped from an existing field. Same 422, but easier to miss
in review because the field name is not new.

### `request-field-type-changed` — major

The field's leading Zod type changed (`z.string` → `z.number`, or a named schema
swapped for another). Values callers already send may stop validating. Note the
comparison is coarse — it sees `z.string`, not `.uuid()` — so a tightened
refinement is a real break this rule does **not** catch. Tightening `z.string()`
to `z.string().uuid()` deserves the same treatment as this rule even though it
stays silent.

### `request-enum-value-removed` — major

A value dropped from a `z.enum`. A caller still sending it gets a 422. Watch for
values already persisted in the DB — those fail on read too, which is the
`contract-enum-value-removed` half of the same change.

### `request-validation-added` — major

The route had no schema for that slot and now has one with required fields.
Requests that used to sail through unvalidated can now 422. Adding validation is
usually right; it is still a behaviour change for whoever was sending sloppy
input.

### `request-field-removed` — minor

Zod strips unknown keys by default, so the request still succeeds. Nothing
fails — the server just silently ignores a value the caller believes it is
sending. That is worse than an error for whoever has to debug it, hence
reported, but it is not a break.

---

## Responses and contracts

Routes here rarely declare a `response:` schema, so the response wire format is
the exported Zod schemas under `server/src/vendor/shared/`. Those are the
contracts both sides are built from.

### `contract-removed` — critical

An exported schema disappeared from `shared`. Anything importing it stops
compiling; anything parsing that payload stops working.

Remember `CLAUDE.md`: **this is a course starter, schema and contracts exist
ahead of the features that use them.** A contract with no module behind it is
not dead — do not "clean up" the barrel.

### `contract-renamed` — critical

A removed export and a new one with an identical field list. The mirror and
every import must move with it.

### `contract-field-removed` — critical

The field is gone from the wire. Consumers read `undefined` at runtime — and
because the client's types come from the hand-synced mirror, `tsc` on the client
only catches it *after* the mirror is synced. Until then both packages compile
and the studio renders blanks.

### `contract-field-weakened` — major

Required → optional, or non-null → nullable. Every consumer written against the
old shape assumes presence. See the `cost_usd` insight in the root
`insights.md`: `null` and `0` are different facts, and coalescing at the
consumer destroys the distinction — resolve the display default at the UI, never
in the contract.

### `contract-field-now-required` — major

Optional → required. Breaks *producers*, not readers: adapters, seeds, fixtures,
and any handler that builds this shape must now supply a value. The
`PrMeta` insight in the root `insights.md` is the worked example — a field that
one endpoint cannot compute must be `.nullish()`, whatever it means semantically.

### `contract-field-type-changed` — major

Serialized values change shape even when both packages still compile.

### `contract-enum-value-removed` — major

Rows already persisted with the dropped value fail to parse on read. Migrate the
data in the same change, or keep the value and mark it deprecated.

### `contract-enum-value-added` — info

Forward-compatible on the wire. Exhaustive `switch`es, badge colour maps, and
label lookups in the studio still need the new case.

### `contract-field-added-required` — minor

Additive for readers, breaking for constructors of the shape (fixtures, seeds,
adapters). Minor because it usually lands with its producers in the same change.

### `response-field-weakened` — critical

A field removed, made optional, or made nullable in a route's declared
`response:` schema. Rare in this repo; treated as critical because a response
break is invisible to the type system on data crossing the wire.

### `contract-mirror-drift` — major

`server/src/vendor/shared/**` changed in this diff and
`client/src/vendor/shared/**` did not follow. Both packages still typecheck —
that is precisely the failure the mirror guard exists to surface.

**Fix:** `./scripts/check-contracts.sh --fix`, then `cd client && pnpm
typecheck`. Two things to expect, both documented in the root `insights.md`:
the sync is one-directional (server wins), and it will also land *pre-existing*
drift from earlier changes. Do not revert those extra files — call them out
separately in the PR. A client that stops compiling after the sync is the real
bug the guard found.

Only files this change actually touched are checked, so pre-existing drift alone
never fires this rule.

---

## Consumers

### `consumer-without-endpoint` — critical / info

A studio `api.get/post/put/patch/del` call site with no route serving it.

- **critical** when an endpoint served it at the base ref — the call is orphaned
  by *this* change.
- **info** when nothing served it at the base ref either. The studio ships hooks
  ahead of the API on purpose here (`useContextFiles` is commented "safe to call
  once API exposes it"), so these are listed for contrast, not as breaks.

SSE / `EventSource` URLs built by string concatenation are extracted but never
reported — the paths are too loose to judge.
