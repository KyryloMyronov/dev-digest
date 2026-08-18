# Rules

One entry per `[rule]` tag emitted by `check.mjs`. Each says what actually
breaks, why it carries that severity, and the way to ship the change anyway.

Severity is measured on the **reader** — whoever consumes the payload. That is
why `required → optional` is critical here and `major` in
`api-breaking-changes`: there it costs a caller a code change, here it silently
turns a rendered field into `undefined`.

| | Meaning |
|---|---|
| **critical** | a live reader gets `undefined`, `null`, or a different type at runtime, and nothing fails to compile on the way there |
| **major** | a reader must change to stay correct |
| **minor** | only a *producer* pays — fixtures, seeds, adapters, mappers |
| **info** | wire-compatible; a label, a `switch`, or a stale null-check to tidy |

The recurring reason so much of this is `critical` rather than `major`: the
studio's types come from `client/src/vendor/shared/`, a **hand-synced copy** of
the server's contracts. Until that mirror is synced, both packages typecheck
against their own copy and a removed field renders blank instead of failing to
build. There is no compiler between the server's response and the studio's
reader.

---

## Whole-shape

### `response-shape-partialed` — critical

A response contract gained `.partial()`, so every field on it is now optional at
once. Reported as one finding listing the fields, because the per-field noise
underneath adds nothing.

This is the rule the skill exists for. `api-breaking-changes` records
`X.partial()` as `kind: 'derived'` and compares it as text, so it can say only
"something changed"; eleven characters of diff loosen the entire payload.

**Usual cause:** `.partial()` was meant for a *request* body — an update
endpoint where every field is optional — and landed on the contract being
served. Derive a separate schema instead of loosening the one readers depend on;
`platform.ts` already has the correct shape of that intent:

```ts
export const Settings = SettingsKnown.passthrough();
export const SettingsUpdate = Settings.partial();   // the update body, not the response
```

**Ship it deliberately:** if the response genuinely has no guaranteed fields,
say so in the PR and update every reader — but prefer splitting the contract, so
the endpoints that *do* guarantee fields keep their guarantee.

### `response-contract-swapped` — critical

An endpoint's response resolved to a different contract than it did at the base
ref — `Promise<AgentSkillLink[]>` → `Promise<AgentSkillDetail[]>`.

The dangerous property is that the route file is untouched. `git diff` on
`routes.ts` is empty, the endpoint's path and verb are identical, every route
test still passes, and the payload is a different type. Only the service's return
type moved.

**Ship it anyway:** update the studio's types and the readers in the same change.
If the two contracts overlap (a "detail" that extends a "link"), check whether
the new one is a superset — a superset is additive for readers and only the
`served by:` endpoints' types need refreshing.

### `response-array-changed` — critical

The response gained or lost array nesting: `Agent` → `Agent[]`, or the reverse.

A reader that maps over this gets a non-iterable (`.map is not a function`), or
one that reads properties off it gets an array and renders `undefined`. Across
the wire nothing catches it at compile time.

**Ship it anyway:** it is a new response shape, so treat it as a new endpoint —
either update every reader in this change, or add a separate path and deprecate
the old one for a release.

---

## Fields

### `response-field-removed` — critical

The field is gone from the payload. Readers get `undefined`; because of the
mirror, both packages still compile and the studio renders blanks.

**Ship it anyway:** remove the readers in the same change. If the field is
expensive to compute and *that* is the motivation, prefer keeping the key and
making it `.nullish()` on the endpoints that cannot compute it — see the `PrMeta`
entry in the root `insights.md`, which is exactly this trade-off resolved that
way.

### `response-field-now-optional` — critical

`.optional()` was added to a field that a reader has always been able to count
on. The key can now be absent.

Critical rather than major because nothing announces it: the field is not new,
the diff is one method call, and the failure is a blank in the UI rather than an
error anywhere.

**Ship it anyway:** give it a `.default()` instead when a sane default exists —
the key is then always present on the wire and this rule does not fire at all.

### `response-field-now-nullish` — critical

One edit weakened both presence *and* value: `z.string()` → `z.string().nullish()`.
Reported as a single finding because `.nullish()` is one decision, not two.

A reader must now handle the key missing **and** the value being `null`.
Optional chaining alone covers only half of that: `x.field?.length` is fine, but
`x.field ?? fallback` still hands a `null` through to anything that treats it as
present.

### `response-field-now-nullable` — major

The key is still present, but its value can be `null`. Readers doing arithmetic,
formatting, or `.length` on it break.

Major rather than critical only because the key's presence is unchanged, so
destructuring and existence checks still behave.

**Ship it anyway — and resolve the default at the UI, never in the contract.**
The `cost_usd` entry in the root `insights.md` is the worked example: `null` (no
run yet, or an unpriced model) and `0` (a run that genuinely cost nothing) are
different facts, and coalescing them in the contract destroys the distinction for
every future consumer. The display default belongs in the component that renders
the dash.

### `response-field-type-changed` — critical

The field's type changed — `z.string` → `z.number`, or one named schema swapped
for another. Serialized values change shape while both packages can still
compile.

The comparison is coarse: it sees `z.string`, not `.uuid()`. A tightened
refinement is a real change this rule stays silent about, and deserves the same
treatment anyway.

### `response-field-now-required` — minor

`.optional()` was dropped from an existing field. Readers are strictly better
off; this only binds **producers** — every adapter, seed, fixture, mapper, and
handler that builds this payload must now supply a value.

Minor because it usually lands with its producers in the same change. If a
producer genuinely cannot compute the field, it must stay `.nullish()` whatever
it means semantically — the `PrMeta` entry in the root `insights.md` is that
exact case: the list endpoint cannot compute what the detail endpoint can.

### `response-field-added-required` — minor

A new field with no `.optional()`. Additive for readers, breaking for whoever
constructs the shape.

### `response-field-not-nullable` — info

A field stopped being nullable. Strictly safer for readers; listed so the
now-dead null branches and `?? '—'` fallbacks in the studio can be cleaned up.

---

## Enums

### `response-enum-value-removed` — major

A value dropped from a `z.enum` that appears in a response. Rows already
persisted with the dropped value fail to parse on read, which is a 500 rather
than a blank.

**Ship it anyway:** migrate the data in the same change, or keep the value and
mark it deprecated in a comment. Note this is the response half of the same
change `api-breaking-changes` reports as `contract-enum-value-removed` for
requests — one edit, two blast radii.

### `response-enum-value-added` — minor

Forward-compatible on the wire, so nothing fails. Exhaustive `switch`es, badge
colour maps, and label lookups in the studio still need the new case or they fall
through to a default — which is usually a grey badge with a raw enum string in
it.

---

## Contracts and the mirror

### `response-contract-removed` — critical

An exported schema that an endpoint served no longer exists. Anything importing
it stops compiling; anything parsing that payload stops working.

Remember `CLAUDE.md`: **this is a course starter, and schema and contracts exist
ahead of the features that use them.** A contract with no module behind it is not
dead — do not "clean up" the barrel. This rule only fires for contracts an
endpoint actually served, which is why it is critical rather than a note.

### `response-mirror-drift` — major

A file holding response contracts changed under `server/src/vendor/shared/` and
`client/src/vendor/shared/` did not follow.

Deliberately overlapping with `contract-mirror-drift` in `api-breaking-changes`,
and scoped tighter: only files holding contracts an endpoint actually returns.
The rationale is response-specific — this is the failure that leaves the studio
*typed against an older wire format* while both packages typecheck, so every
other rule in this file becomes invisible until it is fixed.

**Fix:** `./scripts/check-contracts.sh --fix`, then `cd client && pnpm typecheck`.
Two things to expect, both in the root `insights.md`: the sync is
one-directional (server wins), and it will also land *pre-existing* drift from
earlier changes. Do not revert those extra files — call them out separately in
the PR. A client that stops compiling after the sync is the real bug the guard
found.

Only files this change actually touched are checked, so pre-existing drift alone
never fires this rule.

---

## Coverage

### `response-status-removed` — major

A route declared a `response:` schema for a status code and no longer does. The
serializer for that status is gone, so whatever the handler returns is sent
unvalidated — the wire format for that status is now whatever the code happens
to produce.

### `response-unresolvable` — info

The endpoint's response shape could be resolved at the base ref and cannot be
now, in a file this change touched. Not a break: the **check has gone blind** on
that endpoint.

Listed because silence from an unresolved endpoint looks identical to silence
from a safe one. The usual cause is a handler that stopped returning an annotated
service method — it now calls a repository directly, or the method lost its
return-type annotation.

**Fix:** annotate the service method's return type, or declare `response:` on the
route. `server/CLAUDE.md` asks for the latter anyway: *"One Zod schema serves
request validation AND response serialization. Declare it on the route."*
